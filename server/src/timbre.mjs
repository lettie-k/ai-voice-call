// 听语气第三层：用户的嗓子是什么样（能不能听出在喘、在抖、嗓子哑了）。
//
// 第一层（call.mjs prosodyNote）只有快慢、轻响、卡顿；第二层 SenseVoice 认开心难过、笑哭——
// 都分不出「在喘」「声音在抖」「尾音往上飘」「嗓子哑了」。这一层照 ocean-listen 的 voice.py 那几把尺
// （https://github.com/ennisaaaaaaaa-stack/ocean-listen ，MIT：HNR、jitter、shimmer、有声比例、音高走向），
// 在这句话的 PCM 上直接量，纯 JS，不另起进程：只取最后 8 秒、降到 8k，一句十几毫秒。
//
// 跟别的两层一样只递事实、不下结论：「气声很重」「声音在抖」——用户怎么了由模型自己判断。
// 跟「平时」比的那几样（音高、气声）按这通电话里前几句定底，前两句只报绝对的。

const SR_IN = 16000;
const SR = 8000;
const FRAME = 320;          // 40ms
const HOP = 160;            // 20ms
const LAG_MIN = Math.floor(SR / 500);   // 500Hz
const LAG_MAX = Math.floor(SR / 70);    // 70Hz
const MAX_SECS = 8;

/** PCM16 16k Buffer → Float32 8k（取最后 MAX_SECS 秒，两点一平均） */
function prep(pcm) {
  const n = pcm.length >> 1;
  const start = Math.max(0, n - MAX_SECS * SR_IN);
  const m = (n - start) >> 1;
  const y = new Float32Array(m);
  for (let i = 0; i < m; i++) {
    const a = pcm.readInt16LE((start + 2 * i) << 1), b = pcm.readInt16LE((start + 2 * i + 1) << 1);
    y[i] = (a + b) / 65536;
  }
  return y;
}

/** 一帧：能量 + 归一化自相关的最高峰（周期性，0–1）和对应的周期 */
function frameStats(y, s) {
  let e = 0, mean = 0;
  for (let i = 0; i < FRAME; i++) mean += y[s + i];
  mean /= FRAME;
  const x = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) { x[i] = y[s + i] - mean; e += x[i] * x[i]; }
  const rms = Math.sqrt(e / FRAME);
  if (e <= 1e-9) return { rms, r: 0, lag: 0 };
  const rr = new Float32Array(LAG_MAX + 2);
  let best = 0, bestLag = 0;
  for (let lag = LAG_MIN - 1; lag <= LAG_MAX + 1; lag++) {
    let num = 0, e1 = 0, e2 = 0;
    for (let i = 0; i + lag < FRAME; i++) { num += x[i] * x[i + lag]; e1 += x[i] * x[i]; e2 += x[i + lag] * x[i + lag]; }
    rr[lag] = num / Math.sqrt(e1 * e2 + 1e-12);
    if (lag >= LAG_MIN && lag <= LAG_MAX && rr[lag] > best) { best = rr[lag]; bestLag = lag; }
  }
  // 8k 下一个采样的周期差就是两三个百分点，比真的抖还大——在峰两边做抛物线插值，拿到小数周期
  let lag = bestLag;
  if (bestLag) {
    const a = rr[bestLag - 1], b = rr[bestLag], c = rr[bestLag + 1];
    const d = a - 2 * b + c;
    if (d < 0) lag = bestLag + Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / d));
  }
  return { rms, r: best, lag };
}

// base 里的几样：f0 平时的音高、breath 平时的气声比例、jit 平时的周期抖动、n 量过几句
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; };

/**
 * 量一句话。返回数字（给日志、给定底）+ facts（给他看的短语）；太短或太轻回 null。
 * base：这通电话里用户的底 { f0, breath, n }，会被更新。
 */
export function measure(pcm, base) {
  if (!pcm?.length || pcm.length < SR_IN * 2 * 0.4) return null;
  const y = prep(pcm);
  const frames = [];
  for (let s = 0, k = 0; s + FRAME <= y.length; s += HOP, k++) frames.push({ ...frameStats(y, s), k });
  if (frames.length < 10) return null;
  const peak = Math.max(...frames.map((f) => f.rms));
  if (peak < 0.01) return null;
  const loud = frames.filter((f) => f.rms > peak * 0.12);       // 出了声的帧
  if (loud.length < 6) return null;
  const voiced = loud.filter((f) => f.r > 0.55 && f.lag);      // 有音高的（在发声，不是气）
  const voicedRatio = voiced.length / loud.length;
  // 出声却没音高的帧 = 气声 / 喘气；连着的算一口
  let gasps = 0, run = 0;
  for (const f of frames) {
    const airy = f.rms > peak * 0.12 && f.r < 0.45;
    if (airy) run++; else { if (run >= 3) gasps++; run = 0; }
  }
  if (run >= 3) gasps++;
  const secs = y.length / SR;

  let f0 = 0, hnr = 0, jitter = 0, shimmer = 0, slope = 0;
  if (voiced.length >= 5) {
    const f0s = voiced.map((f) => SR / f.lag);
    f0 = median(f0s);
    const rs = voiced.map((f) => Math.min(0.999, f.r));
    hnr = median(rs.map((r) => 10 * Math.log10(r / (1 - r))));
    // 紧挨着的两帧有声帧之间的周期 / 振幅相对变化，取中位数（帧级的 jitter / shimmer，比 Praat 的周期级粗，看趋势够用）。
    // 隔开的、跳了两成以上的（换字、八度误判）不算——那是说话本来的起伏，不是抖
    const jd = [], sd = [];
    for (let i = 1; i < voiced.length; i++) {
      const a = voiced[i - 1], b = voiced[i];
      if (b.k - a.k !== 1) continue;
      const dj = Math.abs(a.lag - b.lag) / ((a.lag + b.lag) / 2);
      if (dj > 0.2) continue;
      jd.push(dj);
      sd.push(Math.abs(a.rms - b.rms) / ((a.rms + b.rms) / 2));
    }
    jitter = median(jd); shimmer = median(sd);
    // 尾音：最后三分之一的音高对前面的中位数
    const tail = f0s.slice(Math.floor(f0s.length * 2 / 3));
    const head = f0s.slice(0, Math.floor(f0s.length * 2 / 3));
    if (tail.length >= 3 && head.length >= 3) slope = Math.log2(median(tail) / median(head)) * 12;   // 半音
  }

  const facts = [];
  const breathy = 1 - voicedRatio;
  if (breathy > 0.55 || gasps / secs > 0.8) facts.push(gasps >= 2 ? `气声很重，一口一口在喘（${gasps} 口）` : '气声很重');
  else if (base.n >= 2 && breathy > base.breath + 0.2) facts.push('比平时多了不少气声');
  if (voiced.length >= 5) {
    if (hnr < 4) facts.push('嗓子发哑、发沙');
    // 抖：合成测试里正常说话 jitter≈0.033 / shimmer≈0.25，颤音 0.052 / 0.30——两样都高才算；
    // 有了这通电话的底以后，周期抖到平时一倍半也算。门槛是拿合成声定的，建议真打几通看日志再调
    if ((jitter > 0.045 && shimmer > 0.28) || (base.n >= 2 && base.jit && jitter > base.jit * 1.5 && jitter > 0.03)) facts.push('声音在抖');
    if (base.n >= 2 && base.f0) {
      const st = Math.log2(f0 / base.f0) * 12;
      if (st > 2.5) facts.push('音调比平时高'); else if (st < -2.5) facts.push('音调比平时低');
    }
    if (slope > 2) facts.push('尾音往上飘'); else if (slope < -3) facts.push('尾音往下落');
  }

  // 定底：前几句权重大
  const a = base.n < 3 ? 0.5 : 0.2;
  if (f0) base.f0 = base.f0 ? base.f0 + a * (f0 - base.f0) : f0;
  if (jitter) base.jit = base.jit ? base.jit + a * (jitter - base.jit) : jitter;
  base.breath = base.n ? base.breath + a * (breathy - base.breath) : breathy;
  base.n += 1;

  return {
    facts,
    num: { f0: Math.round(f0), voiced: +voicedRatio.toFixed(2), gasps, hnr: +hnr.toFixed(1), jitter: +jitter.toFixed(3), shimmer: +shimmer.toFixed(3), slope: +slope.toFixed(1) },
  };
}
