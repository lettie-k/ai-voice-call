// 一通电话：手机一条 WebSocket 连进来，中继自己去串三条上游腿——转写 · 模型 · 合成。
//
// 线上协议（手机 ↔ 中继，详见 docs/PROTOCOL.md）：
//   上行  二进制帧 = 麦克风音频（PCM16 16k 单声道；?codec=opus 时是 Opus 包）
//         JSON：ping / interrupt / text（联调：当成转写出来的一句）/ mute / bye
//   下行  二进制帧 = 要播的声音
//         JSON：ready / state / transcript / heard / reply_delta / reply_done / interrupted / tool / notice / hangup_soon / bye
//
// 轮次编号（epoch）是打断的根：打断时 +1，所有在途的异步步骤（模型流、合成帧）据此自弃。
// 状态机：listening → thinking → 首个字起 speaking → 说完回 listening。

import crypto from 'node:crypto';
import fs from 'node:fs';
import { log } from './log.mjs';
import { config } from './config.mjs';
import { CallContext, replyOnce, speakable, stripAudioTags, MAX_REPLY_CHARS } from './brain.mjs';
import { openSttLeg, dropSpareToken, sttQuotaOut } from './stt.mjs';
import { OpusLink } from './codec.mjs';
import { openTtsLeg } from './tts.mjs';
import { analyze as senseAnalyze, voiceCheck } from './sense.mjs';
import { measure as timbreMeasure } from './timbre.mjs';

export { MAX_REPLY_CHARS };
/** 多久没人说话就挂 */
export const IDLE_HANGUP_MS = 30_000;
/** 「像没说完」时攥着等多久 */
const HOLD_MS = Number(process.env.CALL_HOLD_MS || 1800);
const MAX_HOLDS = 2;
/** 调工具时每隔这么久垫一句话（一个动作可能要一两分钟，沉默太久用户以为挂了） */
const FILLER_MS = 25_000;
const FILLERS = ['还在弄，你别挂啊。', '再等我一下下。', '快了，马上就好。', '还没完，等我。'];
/**
 * 坑 #13：转写判用户停了、模型开想了，用户在它出声之前又接着说（我们翻了 8 天的通话：52 轮里 13 轮这样，中位 1.1 秒）。
 * 这不算打断，是没说完：这一轮作废，前半句攥回来，等后半句定稿拼成一整句再答。
 * 它已经说了 CONT_SPOKEN_MS 以上用户才开口，那才是真插嘴。
 */
const CONT_SPOKEN_MS = Number(process.env.CALL_CONT_SPOKEN_MS || 1500);
const HOLD_WATCH_MS = 3000;
/** 打断门槛：它说话期间用户冒出这么多字才算插话（防回声和单字误触） */
const BARGE_IN_CHARS = 4;
/** 只认这些才挂：「好了」「先这样」「晚安」都不算（坑 #20） */
const FAREWELL = /(拜拜|拜+|再见|byebye|bye|挂了|挂断|挂电话)/i;

/** 全零帧（段间气口） */
function isSilence(buf) {
  for (let i = 0; i < buf.length; i += 64) if (buf[i] !== 0) return false;
  return true;
}

/**
 * 「像没说完」：结尾是语气词 / 连词 / 介词、破折号 / 省略号 / 逗号，或者结巴重复（来-来-来、那那那），
 * 就先攥着等用户接着说。宁可漏判也别误判——「我想你」「好了」这种正常收尾的一律不拦。
 */
const UNFINISHED_TAIL = /(呃+|嗯+|啊+|哦+|那个|然后|就是|但是|而且|所以|因为|如果|比如|还有|其实|这个|要是|虽然|不过|可是|或者|以及|跟|和|把|被|让|给|对于|关于|的话|有点|一个|一下|我想说|我觉得|我要|我想|就是说|[，,、—–\-…]+|\.{2,})$/;
const STUTTER = /(.)[\-\s]*\1[\-\s]*\1$|(..)[\-\s]*\2$/;
export function looksUnfinished(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (t.length <= 2 && /^(呃|嗯|啊|哦|那|然后|就是|我|你)/.test(t)) return true;
  if (/[。！？!?]$/.test(t)) return false;
  if (/[A-Za-z]-$/.test(t)) return true;
  return UNFINISHED_TAIL.test(t) || STUTTER.test(t);
}

/**
 * 回声判定（坑 #11）：它自己的声音从喇叭漏进麦克风被转写，当成用户插嘴。
 * 判据：转写去掉标点后，是它最近念的内容的子串，或二元组重合 ≥ 60%（转写会错几个字）。
 * 手机开了系统回声消除时不用模糊判（会把用户真的「等一下」也扔了），只认原样子串。
 */
const norm = (t) => String(t || '').replace(/[\s\p{P}]/gu, '');
export function isEcho(heard, spoken) {
  const h = norm(heard), sp = norm(spoken);
  if (h.length < 2 || !sp) return false;
  if (sp.includes(h)) return true;
  if (h.length < 4) return false;
  let hit = 0; const n = h.length - 1;
  for (let i = 0; i < n; i++) if (sp.includes(h.slice(i, i + 2))) hit++;
  return hit / n >= 0.6;
}

/** 整行扔掉、不念的：工具旁白（「我先查一下」）、分隔线、只剩标点的行、光秃秃一句报时 */
const NARRATION = /(我先|让我|我来|我去)?(调用|查|看|读)(一下|看|下)?.{0,8}(工具|时间)|^\s*调用|^-{3,}$|^[\s\p{P}]*$|^\s*(现在(是)?)?\s*\d{1,2}[:：]\d{2}\s*[。.！!]?\s*$/u;

let personaCache = null;
function loadPersona() {
  if (personaCache != null) return personaCache;
  try { personaCache = fs.readFileSync(config.personaFile, 'utf8'); } catch { personaCache = ''; }
  return personaCache;
}

/** 活着的电话，按 id 找——断线重连时凭 ?resume=<id> 接回同一通（坑 #19） */
export const liveCalls = new Map();

export class CallSession {
  constructor(ws, meta = {}) {
    this.ws = ws;
    this.id = crypto.randomUUID();
    this.client = meta.client || 'web';
    this.direction = meta.direction || 'out';   // out=用户拨 AI / in=AI 拨用户
    this.lang = meta.lang || config.lang;
    this.opener = meta.opener || '';            // AI 拨用户时，接通先说的那句
    // 原生 app 开了系统回声消除（voice processing），AI 的声音漏不回麦克风——模糊回声判定关掉
    this.hwAec = this.client === 'ios';
    this.codec = meta.codec === 'opus' ? new OpusLink() : null;
    this.epoch = 0;
    this.state = 'listening';
    this.chars = 0;                             // 这通电话花掉的合成字符
    this.lastSeen = Date.now();
    this.idleTimer = null;
    this.ctx = new CallContext();
    this.busy = false;                          // 有一轮在途（thinking/speaking）
    this.stt = null; this.sttOpening = null;
    this.pendingAudio = [];                     // 开转写腿那一秒多的音频先攒着（不攒就吃掉第一句的开头）
    this.gotAudio = false;
    this.spoken = '';                           // AI 最近念出去的字（尾部 400），回声判定用
    this.playUntil = 0;                         // 已下发的音频在客户端大约播到什么时候（坑 #3、#12）
    this.held = ''; this.holdTimer = null; this.holds = 0;
    this.turnLive = null;
    this.utt = null;                            // 当前这句的测量：{ startAt, sumSq, n, holds, pcm, bytes }
    this.base = { rms: 0, rate: 0, n: 0 };      // 这通电话里用户「平时」的响度和语速
    this.tts = null; this.ttsOpening = null;
    this.muted = false;
    liveCalls.set(this.id, this);
  }

  /** 客户端换了条 socket 接回来：旧的扔掉，状态全留着 */
  rebind(ws) {
    const old = this.ws;
    this.ws = ws;
    this.lastSeen = Date.now();
    try { old.terminate(); } catch { /* 早断了 */ }
    this.clearIdle();
    if (this.state === 'listening') this.armIdle();
    log.info('call.resumed', { id: this.id });
  }

  send(obj) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }

  /** 铁律：不许静默变哑——哑了也要说清哑在哪 */
  notice(message, fatal = false) {
    this.send({ type: 'notice', message, fatal });
    log.info('call.notice', { id: this.id, message, fatal });
  }

  setState(value) {
    if (this.state === value) return;
    this.state = value;
    this.send({ type: 'state', value, epoch: this.epoch });
  }

  /** 被打断的那轮合成还会陆续吐几帧回来，不认（坑 #2） */
  staleCtx(ctxId) {
    const m = /^t(\d+)/.exec(String(ctxId || ''));
    return Boolean(m) && Number(m[1]) < this.epoch;
  }

  /** 打断：轮次 +1，在途的一切自弃 */
  interrupt(why, force = false) {
    // 工具在途不打断（坑 #14）：用户这几截话攒着（heldDuringTool），工具回来、这轮说完再交
    if (this.toolBusy && !force) { log.info('call.interrupt.deferred', { id: this.id, why }); return; }
    const dying = this.epoch;
    this.epoch += 1;
    if (this.tts) this.tts.cancel(`t${dying}`);
    log.info('call.interrupt', { id: this.id, epoch: this.epoch, why });
    this.send({ type: 'interrupted', epoch: this.epoch, why });
    this.setState('listening');
  }

  /** 静默计时从声音播完之后才开始数（坑 #3） */
  armIdle() {
    this.clearIdle();
    const wait = IDLE_HANGUP_MS + Math.max(0, this.playUntil - Date.now());
    this.idleTimer = setTimeout(() => {
      if (this.playUntil - Date.now() > 0) { this.armIdle(); return; }
      this.send({ type: 'hangup_soon', after_ms: 3000 });
      setTimeout(() => this.close('idle'), 3000);
    }, wait);
  }
  clearIdle() { if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; } }

  /** 记一帧下发的音频：16k·16bit 单声道 = 32000 字节/秒 */
  noteAudio(bytes) { this.playUntil = Math.max(Date.now(), this.playUntil) + (bytes / 32000) * 1000; }

  armFiller(epochAt) {
    this.clearFiller();
    let i = 0;
    this.fillerTimer = setInterval(() => {
      if (this.closed || this.epoch !== epochAt || !this.toolBusy) { this.clearFiller(); return; }
      const line = FILLERS[i++ % FILLERS.length];
      this.send({ type: 'reply_delta', delta: line + '\n', epoch: epochAt });
      if (this.tts) this.tts.speak(`t${epochAt}`, line + '\n');
    }, FILLER_MS);
  }
  clearFiller() { if (this.fillerTimer) { clearInterval(this.fillerTimer); this.fillerTimer = null; } }

  /** 上行音频。转写腿懒开：第一帧到了才去连——接通了一句没说就一分钱不花 */
  feedAudio(pcm) {
    if (this.closed) return;
    this.gotAudio = true;
    const now = Date.now();
    // 转写卡住看门狗（坑 #7）：「现在还在响」（3 秒内有过线的帧）却 5 秒没有任何转写 → 换一条，并把这段音频补给新腿
    if (this.utt && this.stt && this.stt.alive && now - (this.lastLoudAt || 0) < 3000) {
      if (!this.sttLastText) this.sttLastText = now;
      if (now - this.sttLastText > 5000 && now - (this.sttWedgeAt || 0) > 10000) {
        this.sttWedgeAt = now;
        log.info('stt.wedged', { id: this.id, silentMs: now - this.sttLastText });
        try { this.stt.close(); } catch { /* onClosed 会重开 */ }
        this.stt = null;
        if (this.utt?.pcm?.length) this.pendingAudio = this.utt.pcm.slice(-250);
        if (!this.sttOpening) this.openStt();
      }
    }
    try { this.meter(pcm); } catch (e) { log.info('call.meter_error', { id: this.id, err: String(e?.message || e).slice(0, 80) }); }
    if (this.stt && this.stt.alive) { this.stt.push(pcm); return; }
    if (this.stt) this.stt = null;
    // 开腿要 1 秒多：这段音频必须攒住，上限约 6 秒
    if (this.pendingAudio.length < 300) this.pendingAudio.push(pcm);
    if (this.sttOpening || this.sttQuota) return;
    this.openStt();
  }

  /** 量这一帧：这句从「听到声音」那一刻算（能量过线），不是从第一段草稿算 */
  meter(pcm) {
    const n = pcm.length >> 1;
    let acc = 0;
    // 用 readInt16LE：ws 给的 Buffer 不保证 2 字节对齐，直接套 Int16Array 会抛错、整帧丢掉
    for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i << 1) / 32768; acc += v * v; }
    const rms = Math.sqrt(acc / Math.max(1, n));
    if (this.state !== 'listening') return;
    if (rms > 0.015) this.lastLoudAt = Date.now();
    // 起了 utt 却 6 秒没声也没转写：是一声响不是一句话，作废
    if (this.utt && !this.utt.holds && Date.now() - this.lastLoudAt > 6000 && Date.now() - (this.sttLastText || 0) > 6000) this.utt = null;
    if (!this.utt && rms > 0.015) { this.utt = { startAt: Date.now(), sumSq: 0, n: 0, holds: 0, pcm: [], bytes: 0 }; this.sttLastText = Date.now(); }
    if (this.utt) {
      this.utt.sumSq += acc; this.utt.n += n;
      if (this.utt.bytes < 30 * 32000) { this.utt.pcm.push(Buffer.from(pcm)); this.utt.bytes += pcm.length; }
    }
  }

  openStt() {
    this.sttOpening = openSttLeg({
      lang: this.lang,
      onPartial: (text) => {
        this.sttLastText = Date.now();
        if (!this.hwAec && isEcho(text, this.spoken)) return;
        if (this.state === 'listening') this.armIdle();
        if (!this.utt) this.utt = { startAt: Date.now(), sumSq: 0, n: 0, holds: 0, pcm: [], bytes: 0 };
        // 开口打断：它正说着，用户冒出够长的一句 → 当场停。它才刚开口的话那是用户没说完（yieldTurn）
        if (this.state === 'speaking' && text.length >= BARGE_IN_CHARS) {
          if (!this.yieldTurn('resumed')) this.interrupt('barge_in');
        } else if (this.state === 'thinking' && this.busy && norm(text).length >= 2) {
          this.yieldTurn('resumed');
        }
        if (this.held) this.armHold(HOLD_WATCH_MS);
        this.send({ type: 'transcript', text, final: false, epoch: this.epoch });
      },
      onCommitted: (text) => {
        this.sttLastText = Date.now();
        if (!this.hwAec && isEcho(text, this.spoken)) { log.info('call.echo_dropped', { id: this.id, text: text.slice(0, 40) }); return; }
        // 系统回声消除刚起来那几秒还没收敛：它正念着、转写又一字不差是它刚念的，那就是漏回来的（只认原样子串）
        if (this.hwAec && this.state === 'speaking' && norm(text).length >= 2 && norm(this.spoken).slice(-60).includes(norm(text))) return;
        if (!norm(text)) return;   // 只有一个「。」：接通那一下的底噪
        this.heard(text);
      },
      onNotice: (message) => this.notice(message),
      onClosed: (code) => {
        // 中途断了：立刻重开；断着的这段静默计时暂停（坑 #8）
        if (this.closed) return;
        this.stt = null;
        this.sttReopens = (this.sttReopens || 0) + 1;
        log.info('stt.dropped', { id: this.id, code, reopens: this.sttReopens });
        if (sttQuotaOut()) { this.sttQuota = true; this.send({ type: 'leg', name: 'stt', status: 'down' }); return; }
        if (this.sttReopens > 12) this.notice('转写一直断，这通电话我可能听不全');
        this.clearIdle();
        if (!this.sttOpening) this.openStt();
      },
    })
      .then((leg) => {
        if (this.closed) { leg.close(); return; }
        this.stt = leg;
        this.send({ type: 'leg', name: 'stt', status: 'ready' });
        if (this.state === 'listening' && !this.idleTimer) this.armIdle();
        for (const b of this.pendingAudio.splice(0)) leg.push(b);
      })
      .catch((err) => {
        const msg = err?.message || String(err);
        // 认证失败多半是预取的令牌过期了：丢掉备用、马上重连一次，攒着的音频留着
        if (/auth/i.test(msg) && !this.sttRetried) {
          this.sttRetried = true;
          dropSpareToken();
          this.sttOpening = null;
          setTimeout(() => { if (!this.stt && !this.sttOpening && !this.closed) this.openStt(); }, 50);
          return;
        }
        this.pendingAudio.length = 0;
        if (/quota/i.test(msg)) {
          if (!this.sttQuota) this.notice('转写额度用完了，这通电话我听不见你说话');
          this.sttQuota = true;
        } else {
          this.notice(`转写起不来：${msg}`);
        }
        this.send({ type: 'leg', name: 'stt', status: 'down' });
      })
      .finally(() => { this.sttOpening = null; });
  }

  /** 一帧要播的 PCM：下发、记播放进度、记分段计时 */
  pushAudio(buf, ctxId) {
    if (this.staleCtx(ctxId)) return;
    if (this.ws.readyState !== 1) return;
    if (this.codec) { for (const m of this.codec.encodePcm(buf)) this.ws.send(m, { binary: true }); }
    else this.ws.send(buf, { binary: true });
    this.noteAudio(buf.length);
    const tm = this.tmLive;
    if (tm && !tm.audioAt && String(ctxId || '').startsWith(`t${tm.epoch}`) && !isSilence(buf)) {
      tm.audioAt = Date.now(); this.tmLive = null;
      const d = (a, b) => (a && b ? b - a : null);
      // 每一轮慢在哪：用户不出声 → 转写判说完 → 开想 → 第一句能念的 → 第一口声音
      log.info('call.timing', {
        id: this.id, epoch: tm.epoch,
        endpointMs: d(tm.loudAt, tm.commitAt), senseMs: d(tm.commitAt, tm.turnT0),
        modelMs: d(tm.turnT0, tm.textAt), ttsMs: d(tm.textAt, tm.audioAt), totalMs: d(tm.loudAt || tm.commitAt, tm.audioAt),
      });
    }
  }

  /** 合成腿懒开：真要开口那一刻才连。连不上就降级成只有字幕，一通电话只试一次 */
  async ensureTts() {
    if (this.tts || this.muted) return this.tts;
    if (!this.ttsOpening) {
      let legRef = null;
      this.ttsOpening = openTtsLeg({
        onAudio: (buf, ctxId) => this.pushAudio(buf, ctxId),
        onDone: (ctxId, info) => {
          if (this.staleCtx(ctxId)) return;
          if (this.codec && this.ws.readyState === 1) { for (const m of this.codec.encodePcm(Buffer.alloc(0), { flush: true })) this.ws.send(m, { binary: true }); }
          const m = /^t(\d+)/.exec(String(ctxId || ''));
          if (info?.last && m) this.send({ type: 'tts_done', epoch: Number(m[1]) });
        },
        onNotice: (message) => this.notice(message),
        onClose: (code) => { if (this.tts === legRef) { this.tts = null; if (!this.closed) log.info('tts.dropped', { id: this.id, code }); } },
      })
        .then((leg) => { legRef = leg; this.tts = leg; this.send({ type: 'leg', name: 'tts', status: 'ready' }); return leg; })
        .catch((err) => {
          this.notice(`合成起不来：${err?.message || String(err)}——这通电话只有字幕`);
          this.send({ type: 'leg', name: 'tts', status: 'down' });
          this.muted = true;
          return null;
        })
        .finally(() => { this.ttsOpening = null; });
    }
    return this.ttsOpening;
  }

  /** 转写定稿了一段。像没说完就先攥着（最多两次），用户接着说就拼起来 */
  heard(text) {
    if (this.phantomUtt(text)) { if (this.held && !this.holdTimer) this.armHold(HOLD_MS); return; }
    if (this.busy) this.yieldTurn('continued');
    const merged = this.held ? `${this.held} ${text}`.trim() : text;
    this.clearHold(false);
    if (looksUnfinished(text) && this.holds < MAX_HOLDS) {
      this.held = merged;
      this.holds += 1;
      if (this.utt) this.utt.holds += 1;
      this.send({ type: 'transcript', text: merged, final: false, epoch: this.epoch });
      this.armHold(HOLD_MS);
      return;
    }
    this.held = ''; this.holds = 0;
    this.commitTurn(merged);
  }

  armHold(ms) {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => {
      const t = this.held; this.held = ''; this.holds = 0; this.holdTimer = null;
      if (t) this.commitTurn(t);
    }, ms);
  }
  clearHold(resetCount = true) {
    if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null; }
    if (resetCount) { this.held = ''; this.holds = 0; }
  }

  /** 在途那一轮能不能算「用户没说完」：一个字没出、或才出声不到 CONT_SPOKEN_MS。能就作废，把前半句还回来 */
  retractLive() {
    const t = this.turnLive;
    if (!t || t.retracted || t.epoch !== this.epoch || !this.busy || this.toolBusy) return '';
    const said = t.tm?.textAt ? Date.now() - t.tm.textAt : 0;
    if (said > CONT_SPOKEN_MS) return '';
    t.retracted = true;
    this.ctx.retractUser(t.userText);
    log.info('call.yield', { id: this.id, epoch: t.epoch, saidMs: said });
    return t.userText;
  }
  yieldTurn(why) {
    const prev = this.retractLive();
    if (!prev) return false;
    this.held = this.held ? `${prev} ${this.held}` : prev;
    this.interrupt(why);
    this.busy = false;
    this.armHold(HOLD_WATCH_MS);
    return true;
  }

  /**
   * 幻听闸（坑 #10）：麦克风很轻时转写会把底噪转成字。量够 0.35 秒且很轻的才算幻听。
   * 它说话时不量用户（utt 为空）——那是插嘴，不是幻听。
   */
  phantomUtt(text) {
    const u = this.utt;
    const rms = u && u.n ? Math.sqrt(u.sumSq / u.n) : 0;
    if (!(u && u.n >= 8 * 1600 && rms < 0.006)) return false;
    log.info('call.phantom_dropped', { id: this.id, text: text.slice(0, 30), rms: +rms.toFixed(4) });
    this.utt = null;
    return true;
  }

  /**
   * 「听感」旁注：说了多久、语速、卡顿、语气词、响度和这通电话里的平时比、隔了多久才开口，
   * 加上第二层（SenseVoice 情绪/事件）和第三层（timbre：气声、抖、哑、音高）。只递事实，不下结论。
   */
  async prosodyNote(text) {
    const u = this.utt; this.utt = null;
    if (!u) return '';
    const sensing = u.bytes ? senseAnalyze(Buffer.concat(u.pcm), 500) : Promise.resolve(null);
    const secs = Math.max(0.3, (Date.now() - u.startAt) / 1000);
    const chars = String(text).replace(/[\s\p{P}]/gu, '').length;
    const rate = chars / secs;
    const rms = u.n ? Math.sqrt(u.sumSq / u.n) : 0;
    const fillers = (String(text).match(/呃+|嗯+|额+|那个/g) || []).length;
    const gap = this.playUntil ? Math.max(0, (u.startAt - this.playUntil) / 1000) : null;

    const parts = [`说了 ${secs.toFixed(1)} 秒`];
    if (this.base.n >= 2) {
      const r = rate / (this.base.rate || rate);
      parts.push(r < 0.7 ? `语速比平时慢（${rate.toFixed(1)} 字/秒）` : r > 1.4 ? `语速比平时快（${rate.toFixed(1)} 字/秒）` : '语速和平时差不多');
      if (rms && this.base.rms) { const v = rms / this.base.rms; if (v < 0.6) parts.push('声音比平时轻'); else if (v > 1.6) parts.push('声音比平时响'); }
    } else {
      parts.push(`${rate.toFixed(1)} 字/秒`);
    }
    if (u.holds) parts.push(`中间卡了 ${u.holds} 次`);
    if (fillers) parts.push(`带了 ${fillers} 个「呃/嗯」`);
    if (STUTTER.test(String(text).trim())) parts.push('结尾有结巴');
    if (gap !== null && gap > 4) parts.push(`你说完后隔了 ${gap.toFixed(0)} 秒才开口`);
    this.timbreBase ||= { f0: 0, breath: 0, jit: 0, n: 0 };
    let tb = null;
    try { tb = u.bytes ? timbreMeasure(Buffer.concat(u.pcm), this.timbreBase) : null; } catch { /* 量不出就不写 */ }
    if (tb?.facts.length) parts.push(...tb.facts);

    const a = this.base.n < 3 ? 0.5 : 0.2;
    this.base.rate = this.base.rate ? this.base.rate + a * (rate - this.base.rate) : rate;
    if (rms) this.base.rms = this.base.rms ? this.base.rms + a * (rms - this.base.rms) : rms;
    this.base.n += 1;

    const sense = await sensing;
    if (sense?.event) parts.push(sense.event);
    if (sense?.emotion) parts.push(`机器听着像${sense.emotion}（不一定准）`);
    const note = parts.join('，');
    log.info('call.prosody', { id: this.id, note, timbre: tb?.num || null });
    return note;
  }

  commitTurn(text) {
    const u = this.utt;
    this.send({ type: 'transcript', text, final: true, epoch: this.epoch });
    this.tm = { loudAt: this.lastLoudAt || 0, commitAt: Date.now() };
    // 可选：声纹。先只记像不像机主，不拦（门槛按自己的数据定）
    if (u?.bytes) voiceCheck(Buffer.concat(u.pcm)).then((v) => { if (v) log.info('call.voice', { id: this.id, sim: v.sim, secs: v.secs }); });
    this.prosodyNote(text)
      .then((note) => this.takeTurn(text, note))
      .catch((e) => this.notice(`这轮崩了：${e?.message || String(e)}`));
  }

  /** AI 拨用户：接通后先把开场白念出来，不叫模型；记进上下文当它说过的第一句 */
  async sayOpener() {
    const text = String(this.opener || '').trim();
    if (!text) return;
    this.busy = true;
    this.clearIdle();
    const epochAt = this.epoch;
    await this.ensureTts();
    this.setState('speaking');
    for (const line of text.split('\n')) {
      const voiced = speakable(line, { keepAudioTags: true });
      const clean = stripAudioTags(voiced);
      if (!clean) continue;
      this.spoken = (this.spoken + clean).slice(-400);
      this.send({ type: 'reply_delta', delta: clean + '\n', epoch: epochAt });
      if (this.tts) this.tts.speak(`t${epochAt}`, voiced + '\n');
    }
    if (this.tts) { this.tts.end(`t${epochAt}`); this.chars = this.tts.chars; }
    this.ctx.pushUser('[对方接起了电话]');
    this.ctx.pushAssistant(text);
    if (this.epoch !== epochAt) return;
    this.busy = false;
    this.send({ type: 'reply_done', text, epoch: epochAt, hangup: false });
    this.setState('listening');
    this.armIdle();
  }

  /** 用户说完一句（转写定稿，或联调时直接喂文本）→ AI 答一句 */
  async takeTurn(userText, note = '') {
    if (!userText?.trim()) return;
    if (this.busy && this.toolBusy) {
      this.heldDuringTool = `${this.heldDuringTool || ''} ${userText}`.trim();
      return;
    }
    if (this.busy) {
      const prev = this.retractLive();
      if (prev) userText = `${prev} ${userText}`;
      this.interrupt(prev ? 'continued' : 'new_utterance');
    }
    this.busy = true;
    this.clearIdle();
    const epochAt = this.epoch;
    const turnT0 = Date.now();
    const tm = this.tm && Date.now() - this.tm.commitAt < 5000 ? this.tm : { commitAt: turnT0 };
    this.tm = null;
    tm.epoch = epochAt; tm.turnT0 = turnT0; this.tmLive = tm;
    const turn = { epoch: epochAt, userText, tm, retracted: false };
    this.turnLive = turn;
    log.info('call.turn.start', { id: this.id, epoch: epochAt });
    this.setState('thinking');
    this.send({ type: 'heard', text: userText, epoch: epochAt });

    const persona = loadPersona();
    await this.ensureTts();
    let started = false;
    let lineBuf = '';
    let pendTags = '';               // 只有语气标签、没有字的一行：贴到下一行前面（坑 #4）
    const emitLine = (line, withNl) => {
      const voiced0 = speakable(line, { keepAudioTags: true });
      const clean = stripAudioTags(voiced0);
      if (voiced0 && !clean) { pendTags = `${pendTags}${voiced0} `; return; }
      if (!voiced0 || (clean && NARRATION.test(clean))) return;
      const voiced = pendTags ? `${pendTags}${voiced0}` : voiced0;
      pendTags = '';
      const nl = withNl ? '\n' : '';
      if (!started) { started = true; this.setState('speaking'); tm.textAt = Date.now(); }
      this.spoken = (this.spoken + clean + nl).slice(-400);
      this.send({ type: 'reply_delta', delta: clean + nl, epoch: epochAt });
      if (this.tts) this.tts.speak(`t${epochAt}`, voiced + nl);
    };

    const r = await replyOnce({
      ctx: this.ctx, persona, userText, note, epochAt,
      epochNow: () => this.epoch,
      retracted: () => turn.retracted,
      // 逐字流按行过滤再送去念：独占一行的动作 / 分隔线 / 「我先查一下」整行扔掉
      onDelta: (delta) => {
        lineBuf += delta;
        let nl;
        while ((nl = lineBuf.indexOf('\n')) >= 0) { emitLine(lineBuf.slice(0, nl), true); lineBuf = lineBuf.slice(nl + 1); }
      },
      onNotice: (_code, message) => this.notice(message),
      onTool: (phase, t) => {
        if (phase === 'start') {
          // 调工具前已经说出口的半句当场送去念，别卡在行缓冲里等工具回来（坑 #15）
          if (lineBuf.trim()) { emitLine(lineBuf, true); lineBuf = ''; }
          this.toolBusy = true; this.clearIdle(); this.armFiller(epochAt);
        }
        this.send({ type: 'tool', phase, name: t.name || null, ok: t.ok, epoch: epochAt });
        log.info(`call.tool.${phase}`, { id: this.id, name: t.name || null, ok: t.ok });
      },
    });

    if (r.failed && this.epoch === epochAt) emitLine('我这边卡了一下，没听清。你再说一遍好吗。', false);
    this.toolBusy = false;
    this.clearFiller();
    const stillMine = this.epoch === epochAt;
    if (stillMine) this.busy = false;
    if (stillMine && this.heldDuringTool) {
      const held = this.heldDuringTool; this.heldDuringTool = '';
      setTimeout(() => this.takeTurn(held), 50);
    }
    if (!stillMine) return;
    if (lineBuf) { emitLine(lineBuf, false); lineBuf = ''; }
    if (this.tts) { this.tts.end(`t${epochAt}`); this.chars = this.tts.chars; }

    // 它写了 [挂断] 但用户没说道别词 → 当它没写（小模型会被「好了」「先这样」骗到）
    let hangup = r.hangup;
    if (hangup && !FAREWELL.test(userText)) { log.info('call.hangup_vetoed', { id: this.id }); hangup = false; }
    log.info('call.turn.done', { id: this.id, epoch: epochAt, ms: Date.now() - turnT0, chars: r.text.length, failed: !!r.failed, hangup });
    this.send({ type: 'reply_done', text: r.text, epoch: epochAt, hangup });
    // 挂断前等最后一句告别念完
    if (hangup) { setTimeout(() => this.close('user_said_bye'), Math.max(2500, this.playUntil - Date.now() + 500)); return; }
    this.setState('listening');
    this.armIdle();
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    liveCalls.delete(this.id);
    if (this.codec) { this.codec.destroy(); this.codec = null; }
    log.info('call.closing', { id: this.id, reason, chars: this.chars, epoch: this.epoch });
    this.clearIdle(); this.clearHold(); this.clearFiller();
    if (this.stt) { this.stt.close(); this.stt = null; }
    if (this.tts) { this.chars = this.tts.chars; this.tts.close(); this.tts = null; }
    this.send({ type: 'bye', reason, chars: this.chars });
    try { this.ws.close(1000, reason); } catch { /* 已经断了 */ }
  }
}
