// 合成腿：ElevenLabs，整通电话共用一条 WebSocket，每一轮话是一个 context。
//
// 两条通道，CALL_TTS_MODE 切，默认 dialogue：
//   dialogue  eleven_v3_conversational · /v1/text-to-dialogue/multi-stream-input
//   stream    eleven_flash_v2_5 等     · /v1/text-to-speech/{voice}/multi-stream-input
//
// 为什么默认 dialogue：我们盲听过几轮，v3 的中文最像人；而 v3 只走对话那条 WebSocket。
// 实测 v3_conversational 首帧 371ms，跟 flash 只差 40ms。
//
// 为什么用 multi-context：普通 stream-input 没有中途取消，打断只能拆了 WebSocket 重建、每次多 200ms；
// multi-context 有 close_context，只关这一句，连接留着。打断是电话里最要紧的手感，值这层复杂度。
//
// 我们实测出来的几条规矩：
//   · 不 flush 就一个字不出。所以按段落（换行）flush；句内不切，句间停顿它自己排。
//   · 每个 context 必须先注册 voices，不注册会被踢（missing_voices）。
//   · 服务端结束过的 context id 不能再用（再注册会被 1008 踢线）——每次重开换个尾号：t3 → t3.0 → t3.1 …
//   · 20 秒没消息它会断。用户说话那十几秒这边没东西发，得定时喂 keep_alive。

import WebSocket from 'ws';
import { log } from './log.mjs';
import { config } from './config.mjs';

const MODE = (process.env.CALL_TTS_MODE || 'dialogue').toLowerCase();
const KEEPALIVE_MS = 12_000;

/** stream 通道：攒够这么多字或遇句末标点 flush 一次 */
const FLUSH_AT = 24;
const SENTENCE_END = /[。！？!?…\n]/;
/**
 * dialogue 通道的切法：按段落（换行）切，段内几句一起交给 v3，停顿它自己排；
 * 每句切一刀的话段与段是硬拼的，没气口。一段太长（超过 PARA_MAX 字且到了句末）也切，别让首帧等太久。
 * 段与段之间补一口气：GAP_MS 的静音直接混进音频流。
 */
const PARA_MAX = 70;
const GAP_MS = Number(process.env.CALL_SENTENCE_GAP_MS || 320);
const GAP_PCM = Buffer.alloc(Math.round(16000 * 2 * GAP_MS / 1000));

const humanize = (msg) =>
  /quota|limit|credit/i.test(msg) ? '合成额度用完了，这通电话说不出声音了' : `合成出错：${msg.slice(0, 140)}`;

/**
 * 开一条合成腿。
 *
 * onAudio(buf, ctxId)       一帧 PCM16 16k，直接往客户端下发
 * onDone(ctxId, { last })   一段念完了；last = 这一轮最后一段也念完了（客户端靠它判「说完」，别靠音频空隙猜——坑 #1）
 * onOpen(ctxId, realId)     这一轮开了哪个真实 context（录音按它认句子）
 * onNotice(message)         出错要说清楚
 * onClose(code)             连接被上游关了（坑 #5：丢掉这条腿，下一句重连）
 *
 * 返回 { speak(ctxId, text), end(ctxId), cancel(ctxId), close(), chars, mode }
 */
export async function openTtsLeg(handlers) {
  if (!config.elevenKey) throw new Error('没配 ELEVENLABS_API_KEY');
  if (!config.voiceId) throw new Error('没配 ELEVENLABS_VOICE_ID');
  return MODE === 'stream' ? openStreamLeg(handlers) : openDialogueLeg(handlers);
}

/* ───────────────────────── dialogue：v3 ───────────────────────── */

async function openDialogueLeg({ onAudio, onDone, onNotice, onOpen, onClose }) {
  const voice = config.voiceId;
  const qs = new URLSearchParams({ model_id: process.env.CALL_TTS_DIALOGUE_MODEL || 'eleven_v3_conversational', output_format: 'pcm_16000' });
  const ws = new WebSocket(`wss://api.elevenlabs.io/v1/text-to-dialogue/multi-stream-input?${qs}`, { headers: { 'xi-api-key': config.elevenKey } });

  const opened = new Set();     // 已注册过 voices 的真实 context id
  const buf = new Map();        // ctxId → 攒着还没送的字
  const alias = new Map();      // 轮次 id → 真实 context id
  const dead = new Set();
  const ended = new Set();      // end() 已调、等最后一段 is_final 的轮次
  let gen = 0;
  let chars = 0;
  // 常驻一个 context 给 keep_alive 点名（keep_alive 必须点一个已注册的 context，第一轮之前也得有）
  const KEEP = 'k';
  let beat = null;

  await new Promise((resolve, reject) => {
    const bail = setTimeout(() => reject(new Error('合成腿 10 秒没握上手')), 10000);
    ws.on('open', () => {
      clearTimeout(bail);
      ws.send(JSON.stringify({ context_id: KEEP, voices: [voice] }));
      opened.add(KEEP);
      log.info('tts.open', { mode: 'dialogue', model: qs.get('model_id') });
      resolve();
    });
    ws.on('error', (err) => { clearTimeout(bail); reject(err); });
    ws.on('close', (code, reason) => {
      clearTimeout(bail);
      clearInterval(beat);
      log.info('tts.close', { code, reason: String(reason || '').slice(0, 120) });
      onClose?.(code);
    });
  });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    const ctxId = m.contextId || m.context_id || null;
    if (m.audio) onAudio(Buffer.from(m.audio, 'base64'), ctxId);
    else if (m.error || (m.message && !m.audio)) {
      const msg = String(m.message || m.error);
      log.info('tts.error', { msg: msg.slice(0, 160) });
      onNotice?.(humanize(msg));
    }
    // 一段念完：补一口气再接下一段（静音直接当音频帧下发，客户端排进同一条时间轴）
    if (m.is_final_audio_for_turn && ctxId && ctxId !== KEEP && GAP_PCM.length) onAudio(GAP_PCM, ctxId);
    if (m.is_final || m.isFinal) {
      // 服务端会自己结束一个 context（比如一段没产生语音的输入 flush 之后）。结束过的 id 标死，下次换尾号
      if (ctxId && ctxId !== KEEP) { opened.delete(ctxId); dead.add(ctxId); }
      const logical = String(ctxId || '').replace(/\.\d+$/, '');
      const last = ctxId !== KEEP && ended.has(logical) && ![...opened].some((r) => r.startsWith(logical + '.'));
      if (last) ended.delete(logical);
      onDone?.(ctxId, { last });
    }
  });

  const send = (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
  beat = setInterval(() => send({ context_id: KEEP, keep_alive: true }), KEEPALIVE_MS);

  /** 拿这一轮的真实 context id；没有或已死就开一个新的（换尾号） */
  const ensure = (ctxId) => {
    let real = alias.get(ctxId);
    if (real && opened.has(real) && !dead.has(real)) return real;
    real = `${ctxId}.${gen++}`;
    alias.set(ctxId, real);
    opened.add(real);
    send({ context_id: real, voices: [voice] });
    onOpen?.(ctxId, real);
    return real;
  };
  const current = (ctxId) => { const r = alias.get(ctxId); return r && opened.has(r) && !dead.has(r) ? r : null; };
  const flushText = (ctxId, text) => {
    const real = ensure(ctxId);
    chars += text.length;
    send({ context_id: real, inputs: [{ text, voice_id: voice, new_turn: false }] });
    send({ context_id: real, flush: true });
    return real;
  };

  return {
    mode: 'dialogue',
    get chars() { return chars; },

    speak(ctxId, delta) {
      const pending = (buf.get(ctxId) || '') + delta;
      const paraEnd = delta.includes('\n');
      const longEnough = pending.length >= PARA_MAX && SENTENCE_END.test(delta);
      if ((paraEnd || longEnough) && pending.trim()) {
        buf.set(ctxId, '');
        flushText(ctxId, pending);
      } else {
        buf.set(ctxId, pending);
      }
    },

    end(ctxId) {
      ended.add(ctxId);
      const tail = buf.get(ctxId) || '';
      buf.delete(ctxId);
      let real = current(ctxId);
      if (tail.trim()) real = flushText(ctxId, tail);
      if (real) { send({ context_id: real, close_context: true }); opened.delete(real); dead.add(real); }
      alias.delete(ctxId);
      // 没有还开着的 context 了 → 不会再有 is_final 来报「最后一段」，这里直接报
      if (!real && ![...opened].some((r) => r.startsWith(ctxId + '.'))) { ended.delete(ctxId); onDone?.(`${ctxId}.end`, { last: true }); }
    },

    /** 打断：这一轮所有还开着的段一起关（坑 #2：只关当前那段，前面几段还会补念好几秒），连接留着 */
    cancel(ctxId) {
      buf.delete(ctxId);
      const real = current(ctxId);
      alias.delete(ctxId);
      const all = [...opened].filter((r) => r === real || r.startsWith(ctxId + '.'));
      for (const r of all) { send({ context_id: r, close_context: true }); opened.delete(r); dead.add(r); }
      if (all.length) log.info('tts.cancel', { ctxId, closed: all.length });
    },

    close() {
      clearInterval(beat);
      try { send({ close_socket: true }); ws.close(1000, 'call ended'); } catch { /* 已经断了 */ }
    },
  };
}

/* ───────────────────────── stream：flash / turbo ───────────────────────── */

async function openStreamLeg({ onAudio, onDone, onNotice }) {
  const qs = new URLSearchParams({ model_id: config.ttsModel, output_format: 'pcm_16000', auto_mode: 'true', language_code: config.lang });
  const ws = new WebSocket(`wss://api.elevenlabs.io/v1/text-to-speech/${config.voiceId}/multi-stream-input?${qs}`, { headers: { 'xi-api-key': config.elevenKey } });
  const opened = new Set();
  const buf = new Map();
  let chars = 0;

  await new Promise((resolve, reject) => {
    const bail = setTimeout(() => reject(new Error('合成腿 10 秒没握上手')), 10000);
    ws.on('open', () => { clearTimeout(bail); log.info('tts.open', { mode: 'stream', model: qs.get('model_id') }); resolve(); });
    ws.on('error', (err) => { clearTimeout(bail); reject(err); });
    ws.on('close', (code, reason) => {
      clearTimeout(bail);
      log.info('tts.close', { code, reason: String(reason || '').slice(0, 120) });
      if (code === 1008) onNotice?.('合成认证被拒了，这通电话发不出声音');
    });
  });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    const ctxId = m.contextId || m.context_id || null;
    if (m.audio) onAudio(Buffer.from(m.audio, 'base64'), ctxId);
    else if (m.error) {
      const msg = String(m.message || m.error);
      log.info('tts.error', { msg: msg.slice(0, 160) });
      onNotice?.(humanize(msg));
    }
    if (m.isFinal) onDone?.(ctxId, { last: true });
  });

  const send = (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
  const ensure = (ctxId) => {
    if (opened.has(ctxId)) return;
    opened.add(ctxId);
    send({ text: ' ', context_id: ctxId, voice_settings: { stability: 0.4, similarity_boost: 0.8 } });
  };

  return {
    mode: 'stream',
    get chars() { return chars; },
    speak(ctxId, delta) {
      ensure(ctxId);
      const pending = (buf.get(ctxId) || '') + delta;
      if (pending.length >= FLUSH_AT || SENTENCE_END.test(delta)) {
        buf.set(ctxId, '');
        chars += pending.length;
        send({ text: pending, context_id: ctxId, flush: true });
      } else {
        buf.set(ctxId, pending);
      }
    },
    end(ctxId) {
      const tail = buf.get(ctxId) || '';
      buf.delete(ctxId);
      if (tail) { chars += tail.length; send({ text: tail, context_id: ctxId, flush: true }); }
      send({ context_id: ctxId, close_context: true });
      opened.delete(ctxId);
    },
    cancel(ctxId) {
      buf.delete(ctxId);
      if (!opened.has(ctxId)) return;
      send({ context_id: ctxId, close_context: true });
      opened.delete(ctxId);
      log.info('tts.cancel', { ctxId });
    },
    close() {
      try { send({ close_socket: true }); ws.close(1000, 'call ended'); } catch { /* 已经断了 */ }
    },
  };
}
