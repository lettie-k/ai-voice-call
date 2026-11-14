/**
 * 网页 / PWA 的通话功能（没有界面）。把麦克风的声音推给中继、把回来的声音放出来、把事件交给你。
 * VAD、分句、打断判定、听语气全在中继做；你的页面只管画按钮和字幕。协议见 docs/PROTOCOL.md。
 *
 * 用法：
 *   import { AICall } from './ai-call.js';
 *   const call = new AICall({ onState, onTranscript, onReplyDelta, onReplyDone, onNotice, onTool, onEnded });
 *   button.onclick = () => call.start({ relayURL, ticket, workletURL: '/pcm-worklet.js' });   // ⚠️ 必须在点按事件里同步调用
 *   call.hangup();
 *
 * 网页上我们踩过的坑：
 *  · iOS Safari 只认「用户点按的同步栈」里启动的声音——start() 里第一件事就建 AudioContext 并 resume，
 *    在任何 await 之前。我们有一晚打了 7 通电话，一帧声音都没传上去，就是栽在这儿（桌面 Chrome 测不出来）。
 *  · iOS 不理 AudioContext({sampleRate:16000})，给的是硬件采样率；重采样在 worklet 里做。
 *  · 网页只有软回声消除，外放时 AI 自己的声音会漏回麦克风：worklet 里有音量闸，这里还有回声判断。
 *  · 进后台 / 锁屏后声音会被暂停，PWA 做不了「像真来电一样响」——要那个得用 iOS 原生（clients/ios）。
 */

const SAMPLE_RATE = 16000;
/** 播放排程留的余量：太小会有咔哒声，太大整体延迟就上去了 */
const PLAY_LEAD_S = 0.08;

const norm = (t) => String(t || '').replace(/[\s\p{P}]/gu, '');
/** 附和：「嗯」「对」「好」「OK」——用户在听，不是要插话，不掐（中继 isNod 同一份） */
const NOD = /^(?:嗯哼|对呀|对啊|是呀|是啊|好呀|好的|对的|是的|没错|okay|ok|yeah|yes|[对是好行嗯恩啊哦噢喔呃额唔哈嘿])+$/i;
/** AI 自己的声音漏回来被转写了：转写是它最近念的内容的子串，或二元组重合 ≥ 60% */
function isEcho(heard, spoken) {
  const h = norm(heard), sp = norm(spoken);
  if (h.length < 2 || !sp) return false;
  if (sp.includes(h)) return true;
  if (h.length < 4) return false;
  let hit = 0; const n = h.length - 1;
  for (let i = 0; i < n; i++) if (sp.includes(h.slice(i, i + 2))) hit++;
  return hit / n >= 0.6;
}

export class AICall {
  /**
   * @param {object} ev
   * @param {(s:'connecting'|'listening'|'thinking'|'speaking'|'ended')=>void} [ev.onState]
   * @param {(text:string, final:boolean)=>void} [ev.onTranscript]   用户说的话（final=false 是草稿）
   * @param {(delta:string, epoch:number)=>void} [ev.onReplyDelta]    AI 说的字，逐段来
   * @param {(text:string, epoch:number)=>void} [ev.onReplyDone]
   * @param {(message:string)=>void} [ev.onNotice]                   出问题了，一定要显示给用户
   * @param {(phase:string, name:string|null, ok?:boolean)=>void} [ev.onTool]
   * @param {(type:string, msg:object)=>void} [ev.onEvent]           所有事件原样转出来
   * @param {(reason:string, chars:number)=>void} [ev.onEnded]
   */
  constructor(ev = {}) {
    this.ev = ev;
    this.ws = null; this.ac = null; this.stream = null; this.node = null;
    this.playAt = 0;
    this.sources = new Set();
    this.state = 'idle';
    this.framesSent = 0;
    this.spoken = '';
    this.bargeSeen = null;
    this.playingFlag = false;
  }

  setState(s) { if (this.state !== s) { this.state = s; this.ev.onState?.(s); } }

  /**
   * @param {object} o
   * @param {string} o.relayURL    wss://你的中继/v1/call
   * @param {string} o.ticket      你的后端签的短票据
   * @param {string} [o.workletURL='/pcm-worklet.js']
   * @param {'out'|'in'} [o.direction='out']   in = AI 打给用户（配 opener）
   * @param {string} [o.opener]
   * @param {string} [o.lang='zh']
   */
  async start({ relayURL, ticket, workletURL = '/pcm-worklet.js', direction = 'out', opener = '', lang = 'zh' }) {
    this.setState('connecting');
    // ⓪ 任何 await 之前：建 AudioContext 并 resume（iOS 只认点按的同步栈）
    this.ac = new AudioContext();
    const resumed = this.ac.resume();

    // ① 先要麦克风再连：权限被拒就不用连了。三个开关都开——网页只有软回声消除，外放时全靠它
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });

    // ② 采集：worklet 从真实采样率重采样到 16k
    await resumed;
    const ac = this.ac;
    if (ac.state !== 'running') await ac.resume();   // 有的 iOS 版本第一次 resume 会静默失败
    await ac.audioWorklet.addModule(workletURL);
    const src = ac.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ac, 'pcm-capture', { processorOptions: { inputRate: ac.sampleRate, outputRate: SAMPLE_RATE } });
    src.connect(this.node);
    // ⚠️ 别把采集节点接到 destination：等于把自己的声音外放出去，直接自激

    // ③ 连中继
    const q = new URLSearchParams({ ticket, client: 'web', direction, lang });
    if (opener) q.set('opener', opener);
    const sock = new WebSocket(`${relayURL}?${q}`);
    sock.binaryType = 'arraybuffer';
    this.ws = sock;
    this.node.port.onmessage = (e) => { if (sock.readyState === WebSocket.OPEN) { sock.send(e.data); this.framesSent++; } };

    await new Promise((resolve, reject) => {
      const bail = setTimeout(() => reject(new Error('15 秒没连上中继')), 15000);
      sock.onopen = () => { clearTimeout(bail); resolve(); };
      sock.onerror = () => { clearTimeout(bail); reject(new Error('连接出错')); };
      sock.onclose = (ev) => { clearTimeout(bail); reject(new Error(`被关了 code=${ev.code}`)); };
    });
    sock.onmessage = (e) => this.onMessage(e);
    sock.onclose = () => { if (this.state !== 'ended' && !this.byeAt) { this.setState('ended'); this.teardown(); } };
  }

  onMessage(e) {
    if (e.data instanceof ArrayBuffer) { this.play(e.data); return; }
    const m = JSON.parse(e.data);
    this.ev.onEvent?.(m.type, m);
    switch (m.type) {
      case 'ready':
        this.setState('listening');
        // 4 秒还没发出一帧：大概率是 AudioContext 没起来或麦克风被静音——说出来，别让用户干等
        this.micWatch = setTimeout(() => {
          if (this.framesSent === 0) this.ev.onNotice?.(`没采到你的声音（音频状态 ${this.ac?.state ?? '?'}）——挂断重打，或看看麦克风有没有被静音`);
        }, 4000);
        break;
      case 'state':
        if (['listening', 'thinking', 'speaking'].includes(m.value)) this.setState(m.value);
        break;
      case 'transcript': {
        const text = String(m.text || '');
        if (!m.final && isEcho(text, this.spoken)) break;
        // 用户开口了、AI 的声音还在本地排队播：本地立刻掐，别等中继。
        // 草稿要 ≥4 字、且 1.5 秒内连续长过一次才算插嘴——漏音转出来的多是一两个碎字
        if (!m.final && this.sources.size > 0) {
          const prev = this.bargeSeen; const now = Date.now();
          const sustained = prev && now - prev.at < 1500 && text.length > prev.text.length;
          this.bargeSeen = { text, at: now };
          if (text.length >= 4 && sustained && !NOD.test(norm(text))) {
            this.stopAudio(); this.bargeSeen = null;
            try { this.ws?.send(JSON.stringify({ type: 'interrupt', heard: text })); } catch { /* 忽略 */ }
          }
        }
        this.ev.onTranscript?.(text, Boolean(m.final));
        break;
      }
      case 'reply_delta':
        this.spoken = (this.spoken + String(m.delta || '')).slice(-400);
        this.ev.onReplyDelta?.(m.delta, m.epoch);
        break;
      case 'reply_done': this.ev.onReplyDone?.(m.text, m.epoch); break;
      case 'interrupted': this.stopAudio(); break;   // 排好的音频全掐掉——只停新帧不够，排程是提前排好的
      case 'tool': this.ev.onTool?.(m.phase, m.name, m.ok); break;
      case 'notice': this.ev.onNotice?.(m.message); break;
      case 'hangup_soon': this.ev.onNotice?.('太久没说话，这通电话要挂了'); break;
      case 'leg': if (m.name === 'stt' && m.status === 'down') this.ev.onNotice?.('转写没起来，它听不见你'); break;
      case 'bye': {
        this.byeAt = Date.now();
        // 先把排好的道别放完再收（坑 #27），最多 15 秒
        const left = this.ac ? Math.max(0, this.playAt - this.ac.currentTime) : 0;
        setTimeout(() => {
          this.ev.onEnded?.(m.reason, m.chars ?? 0);
          this.setState('ended');
          this.teardown();
        }, Math.min(15, left + 0.3) * 1000);
        break;
      }
    }
  }

  /** PCM16 → 排进时间轴（不用 <audio>：段与段之间会有可听见的缝） */
  play(buf) {
    const ac = this.ac;
    if (!ac) return;
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    const pcm = new Int16Array(buf);
    if (!pcm.length) return;
    const audio = ac.createBuffer(1, pcm.length, SAMPLE_RATE);
    const ch = audio.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
    const node = ac.createBufferSource();
    node.buffer = audio;
    node.connect(ac.destination);
    const now = ac.currentTime;
    if (this.playAt < now + 0.01) this.playAt = now + PLAY_LEAD_S;
    node.start(this.playAt);
    this.playAt += audio.duration;
    this.sources.add(node);
    node.onended = () => { this.sources.delete(node); this.syncPlaying(); };
    this.syncPlaying();
  }

  /** 告诉采集器 AI 在不在播——在播就开音量闸 */
  syncPlaying() {
    const playing = this.sources.size > 0;
    if (playing === this.playingFlag) return;
    this.playingFlag = playing;
    try { this.node?.port.postMessage({ playing }); } catch { /* 忽略 */ }
  }

  stopAudio() {
    this.sources.forEach((s) => { try { s.stop(); } catch { /* 已经结束 */ } });
    this.sources.clear();
    this.playAt = 0;
    this.syncPlaying();
  }

  hangup() {
    try { this.ws?.send(JSON.stringify({ type: 'bye' })); } catch { /* 断了就算了 */ }
    this.setState('ended');
    this.teardown();
  }

  /** 只出字幕不出声 */
  mute(on = true) {
    try { this.ws?.send(JSON.stringify({ type: 'mute', value: on })); } catch { /* 忽略 */ }
    if (on) this.stopAudio();
  }

  teardown() {
    if (this.micWatch) { clearTimeout(this.micWatch); this.micWatch = null; }
    this.stopAudio();
    try { this.node?.port.postMessage({ on: false }); } catch { /* 忽略 */ }
    try { this.node?.disconnect(); } catch { /* 忽略 */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    try { this.ac?.close(); } catch { /* 忽略 */ }
    try { this.ws?.close(); } catch { /* 忽略 */ }
    this.ws = null; this.ac = null; this.stream = null; this.node = null;
  }
}
