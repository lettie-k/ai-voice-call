/**
 * 麦克风采集 worklet：放在你的静态目录里，AICall.start 的 workletURL 指向它。
 *
 * 干两件事：把 AudioContext 给的 Float32 重采样到 16k、转成 PCM16 裸帧发回主线程。
 * 中继那边直接把二进制帧转给转写服务（audio_format=pcm_16000）。
 *
 * 为什么要重采样：iOS 不理 AudioContext({sampleRate:16000}) 这个约束，
 * 给的是硬件采样率（44.1k/48k）。之前直接定死 16k，在 iOS 上等于按错的速率解读——
 * 现在主线程把真实的 inputRate 传进来，这里线性插值到 16k。
 *
 * 为什么用 AudioWorklet 不用 ScriptProcessor：后者跑在主线程，
 * 页面一卡音频就断；而且早就废弃了。
 *
 * 每帧 20ms = 320 样本 = 640 字节。攒够一帧发一次，不是每个 render quantum
 * （128 样本）发一次——那样一秒 375 条消息，白白压主线程。
 */
const FRAME_SAMPLES = 320;

class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.inRate = o.inputRate || sampleRate;      // sampleRate 是 worklet 全局：context 的真实采样率
    this.outRate = o.outputRate || 16000;
    this.ratio = this.inRate / this.outRate;      // 每个输出样本要走多少输入样本
    this.pos = 0;                                  // 在输入流里的小数位置
    this.prev = 0;                                 // 上一个 quantum 的最后一个样本，跨块插值用
    this.buf = new Int16Array(FRAME_SAMPLES);
    this.n = 0;
    this.on = true;
    // 音量闸（我们实测：外放时它自己的声音漏回麦克风，把它自己掐断）：AI 在说话（playing）的那段时间，
    // 把每帧的响度当基线慢慢跟（跟的其实就是漏回来的回声有多响），只放行明显比基线响的帧——
    // 用户对着手机说话肯定比喇叭漏回麦克风的响。不够响的帧发静音，别断帧（VAD 要看见静音才判停）
    this.playing = false;
    this.floor = 0;          // 回声响度基线（RMS，慢 EMA）
    this.frames = 0;
    this.port.onmessage = (e) => {
      if (!e.data) return;
      if (typeof e.data.on === "boolean") this.on = e.data.on;
      if (typeof e.data.playing === "boolean") {
        if (e.data.playing && !this.playing) { this.floor = 0; this.frames = 0; }   // 每次 AI 开口重新量
        this.playing = e.data.playing;
      }
    };
  }

  pushSample(s) {
    // Float32 [-1,1] → Int16。乘 0x7fff 之前先钳一下，不然爆音会绕回成噪声
    s = Math.max(-1, Math.min(1, s));
    this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    if (this.n === FRAME_SAMPLES) {
      if (this.playing) {
        let acc = 0;
        for (let i = 0; i < FRAME_SAMPLES; i++) { const v = this.buf[i] / 0x8000; acc += v * v; }
        const rms = Math.sqrt(acc / FRAME_SAMPLES);
        this.frames++;
        // 前 8 帧（160ms）快速建基线，之后慢跟（alpha 0.03）：用户一开口 rms 会跳上去，慢跟不会被带高
        const a = this.frames <= 8 ? 0.35 : 0.03;
        this.floor = this.floor ? this.floor + a * (rms - this.floor) : rms;
        const gate = Math.max(0.012, this.floor * 2.4);
        if (rms < gate) this.buf.fill(0);   // 不够响：当静音送
      }
      const out = this.buf.buffer;
      this.port.postMessage(out, [out]);   // 传所有权，避免每帧拷贝
      this.buf = new Int16Array(FRAME_SAMPLES);
      this.n = 0;
    }
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || !this.on) return true;

    if (this.ratio === 1) {
      for (let i = 0; i < ch.length; i++) this.pushSample(ch[i]);
      return true;
    }
    // 线性插值重采样。pos 是相对本块起点的位置，可能带着上一块的余数；
    // pos<0 那一段要用上一块的末样本 prev 来插
    let pos = this.pos;
    while (pos < ch.length) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = i < 0 ? this.prev : ch[i];
      const b = i + 1 < ch.length ? ch[i + 1] : ch[ch.length - 1];
      this.pushSample(a + (b - a) * frac);
      pos += this.ratio;
    }
    this.pos = pos - ch.length;
    this.prev = ch[ch.length - 1];
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
