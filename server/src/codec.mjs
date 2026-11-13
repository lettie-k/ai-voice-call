// 通话音频编解码：手机 ↔ 中继之间走 Opus，流量降十倍（可选，?codec=opus 时启用）。
//
// 为什么要它：我们的手机在深圳、中继在洛杉矶，RTT 230~1400ms 还抖。上行 PCM16/16k 是 32KB/s，
// 线一抖 TCP 就堵，手机 2 秒内攒下 40 包发不出去。Opus 24kbps 只有 3KB/s。
//
// 线上格式（?codec=opus 时，两个方向一样）：
//   一条二进制消息 = 若干包首尾相接：[uint16 BE 包长][opus 包] [uint16 BE 包长][opus 包] …
//   每包 20ms（320 采样 @16k）。手机攒 100ms（5 包）发一次；中继下行也按 5 包一批。
// 解码器/编码器一通电话各一个（opusscript 有状态，不能跨通复用）。
import OpusScript from 'opusscript';

const RATE = 16000;
const FRAME = 320;            // 20ms
const FRAME_BYTES = FRAME * 2;

export class OpusLink {
  constructor() {
    this.dec = new OpusScript(RATE, 1, OpusScript.Application.VOIP);
    this.enc = new OpusScript(RATE, 1, OpusScript.Application.VOIP);
    try { this.enc.encoderCTL(4002, 24000); } catch { /* OPUS_SET_BITRATE，不支持就用默认 */ }
    this.carry = Buffer.alloc(0);   // 下行没凑够 20ms 的零头
  }

  /** 上行：一条消息 → PCM16 Buffer（几包拼起来）。坏包跳过 */
  decodeMessage(buf) {
    const out = [];
    let i = 0;
    while (i + 2 <= buf.length) {
      const len = buf.readUInt16BE(i); i += 2;
      if (len === 0 || i + len > buf.length) break;
      try { out.push(Buffer.from(this.dec.decode(buf.subarray(i, i + len)))); } catch { /* 丢这一包 */ }
      i += len;
    }
    return out.length ? Buffer.concat(out) : null;
  }

  /** 下行：PCM16 Buffer → 若干条消息（每条最多 5 包）。零头留到下一次 */
  encodePcm(pcm, { flush = false } = {}) {
    let data = this.carry.length ? Buffer.concat([this.carry, pcm]) : pcm;
    const msgs = [];
    let packets = [];
    let i = 0;
    while (i + FRAME_BYTES <= data.length) {
      let p;
      try { p = Buffer.from(this.enc.encode(data.subarray(i, i + FRAME_BYTES), FRAME)); } catch { i += FRAME_BYTES; continue; }
      i += FRAME_BYTES;
      const h = Buffer.alloc(2); h.writeUInt16BE(p.length, 0);
      packets.push(h, p);
      if (packets.length >= 10) { msgs.push(Buffer.concat(packets)); packets = []; }
    }
    this.carry = data.subarray(i);
    if (flush && this.carry.length) {
      // 最后不足 20ms 的补零凑一包，别把句尾吞了
      const pad = Buffer.alloc(FRAME_BYTES); this.carry.copy(pad);
      try { const p = Buffer.from(this.enc.encode(pad, FRAME)); const h = Buffer.alloc(2); h.writeUInt16BE(p.length, 0); packets.push(h, p); } catch { /* 算了 */ }
      this.carry = Buffer.alloc(0);
    }
    if (packets.length) msgs.push(Buffer.concat(packets));
    return msgs;
  }

  destroy() {
    try { this.dec.delete(); } catch { /* */ }
    try { this.enc.delete(); } catch { /* */ }
  }
}
