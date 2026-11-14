// 转写腿：ElevenLabs Scribe v2 Realtime。
//
// 每次开腿先用服务端的 API key 换一张单次令牌（15 分钟过期、用一次作废），再拿令牌连 WebSocket。
// key 只在这台机器上，不下发到手机。
//
// 我们实测：令牌 POST 约 200ms，wss 握手约 185ms，第一条消息是 session_started。

import WebSocket from 'ws';
import { log } from './log.mjs';
import { config } from './config.mjs';

/** 用户停口之后等多久算「说完了」。600ms 稳妥；压到 400 更跟手，但换气容易被误判成说完 */
const VAD_SILENCE_SECS = 0.6;

async function fetchSttToken() {
  if (!config.elevenKey) throw new Error('没配 ELEVENLABS_API_KEY');
  const res = await fetch('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', {
    method: 'POST',
    headers: { 'xi-api-key': config.elevenKey },
    signal: AbortSignal.timeout(12000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`换转写令牌失败（${res.status}）：${body.slice(0, 180)}`);
  const data = JSON.parse(body);
  if (!data?.token) throw new Error('令牌接口回了 200 但没有 token');
  return data.token;
}

/**
 * 备用令牌（坑 #8）：Scribe 每二三十秒会自己关一次连接，重开要先换令牌。换令牌那一跳慢的时候
 * 我们见过 16 秒——那 16 秒用户说什么都没人听。所以开腿之后立刻预取一张放着，下次重开直接用。
 * 单次令牌有保质期：放了几分钟再用会 auth_error，所以 3 分钟没用就作废。
 */
let spare = null;
let spareAt = 0;
const SPARE_TTL_MS = 3 * 60_000;
function prefetchToken() {
  if (spare) return;
  spareAt = Date.now();
  spare = fetchSttToken().catch((e) => { log.info('stt.prefetch_failed', { err: String(e?.message || e).slice(0, 120) }); return null; });
}
/** 丢掉备用令牌（认证失败时用：那张多半过期了） */
export function dropSpareToken() { spare = null; spareAt = 0; }
async function takeToken() {
  const p = spare && Date.now() - spareAt < SPARE_TTL_MS ? spare : null;
  spare = null;
  return (p ? await p : null) || fetchSttToken();
}

// 坑 #9：额度用完回的是 message_type=quota_exceeded（不带 error 字样）。漏判的话腿开了 70ms 就被关，
// 一通电话重开六十多次。认出来之后十分钟内不再开腿，并照实告诉用户。
let quotaOutAt = 0;
export function sttQuotaOut() { return Date.now() - quotaOutAt < 10 * 60_000; }

/**
 * 开一条转写腿。
 *
 * onPartial(text)   边说边出的草稿——打断就靠它（AI 说话期间用户一开口就有草稿）
 * onCommitted(text) 一句说完了，交给模型
 * onNotice(message) 出错要说清楚（不许静默变哑）
 * onClosed(code)    通话中途被上游关了，调用方下一帧音频会重新开腿
 *
 * 返回 { push(pcm), close(), alive }。push 进来的是 PCM16 16kHz 裸帧，到这儿才转 base64——
 * 上游那条 WS 只吃 base64，但手机到中继这一跳走裸帧，省三分之一流量。
 */
export async function openSttLeg({ onPartial, onCommitted, onNotice, onClosed, lang = config.lang }) {
  if (sttQuotaOut()) throw new Error('quota: 转写额度用完了');
  const t0 = Date.now();
  const token = await takeToken();
  prefetchToken();
  const tokenMs = Date.now() - t0;

  const qs = new URLSearchParams({
    // v3 live 比 v2 准（我们拿真电话录音比过：「宝贝/我不要」→「爸比」），价钱一样
    model_id: process.env.STT_MODEL || 'scribe_v3_live',
    filter_background_audio: 'true',   // 背景里的电视、路人少被转成字
    audio_format: 'pcm_16000',
    language_code: lang,
    commit_strategy: 'vad',            // 服务端判停，不用自己写 VAD
    vad_silence_threshold_secs: String(VAD_SILENCE_SECS),
    token,
  });
  // 常被转错的词（称呼、名字）：转写会往这几个上靠。别放太多，放多了普通话也往上靠
  for (const k of (process.env.STT_KEYTERMS || '').split(',').map((x) => x.trim()).filter(Boolean)) qs.append('keyterms', k);

  const ws = new WebSocket(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${qs}`);
  let ready = false;
  const backlog = [];               // session_started 之前来的音频先攒着

  await new Promise((resolve, reject) => {
    const bail = setTimeout(() => reject(new Error('转写腿 10 秒没握上手')), 10000);
    ws.on('open', () => log.info('stt.open', { tokenMs, connectMs: Date.now() - t0 }));
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      switch (m.message_type) {
        case 'session_started':
          ready = true;
          clearTimeout(bail);
          for (const b of backlog.splice(0)) ws.send(b);
          resolve();
          break;
        case 'partial_transcript':
          if (m.text?.trim()) onPartial(m.text.trim());
          break;
        case 'committed_transcript':
        case 'committed_transcript_with_timestamps':
          if (m.text?.trim()) onCommitted(m.text.trim());
          break;
        default:
          if (/error|quota|exceeded/i.test(m.message_type || '') || m.error) {
            const msg = m.message || m.error || m.message_type;
            if (/quota|exceeded/i.test(`${m.message_type} ${msg}`)) quotaOutAt = Date.now();
            log.info('stt.error', { msg });
            onNotice?.(/quota|limit/i.test(String(msg)) ? '转写额度用完了，这通电话听不见你说话了' : `转写出错：${String(msg).slice(0, 140)}`);
            clearTimeout(bail);
            reject(new Error(String(msg)));
          }
      }
    });
    ws.on('error', (err) => { clearTimeout(bail); reject(err); });
    ws.on('close', (code) => {
      log.info('stt.close', { code });
      if (!ready) { clearTimeout(bail); reject(new Error(`转写腿没连上就断了 code=${code}`)); }
      // 坑 #7：说了两句之后它自己 code=1000 关了，之后用户说什么都听不见——告诉上面一声
      else onClosed?.(code);
    });
  });

  return {
    get alive() { return ws.readyState === WebSocket.OPEN; },
    push(pcm) {
      if (ws.readyState !== WebSocket.OPEN) return;
      const frame = JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: Buffer.from(pcm).toString('base64') });
      if (ready) ws.send(frame);
      else if (backlog.length < 200) backlog.push(frame);   // 攒上限约 4 秒
    },
    close() {
      try { ws.close(1000, 'call ended'); } catch { /* 已经断了 */ }
    },
  };
}
