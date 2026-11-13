// 声纹子进程（可选）：收 PCM16 16k，回「像不像机主」。
// 模型 3D-Speaker CAM++ 中文（sherpa-onnx 发布页那个 28MB 的）；机主的声纹档用 tools/enroll-voice.mjs
// 从几十句录音算平均（我们用了过去电话里的 34 句）。没有声纹档就自动关掉，不影响通话。
// 整句 5 秒左右算一次 ~200ms，所以单独一个进程，别跟情绪那个排队。
const fs = require('fs');
const sherpa = require('sherpa-onnx-node');
const dir = process.env.SPEAKER_MODEL_DIR || './models/speaker';
let ex; let prof;
try {
  ex = new sherpa.SpeakerEmbeddingExtractor({ model: `${dir}/campplus_zh.onnx`, numThreads: 1, debug: 0 });
  prof = JSON.parse(fs.readFileSync(`${dir}/owner.json`, 'utf8'));
} catch (e) {
  process.send({ fatal: String(e && e.message || e) });
  setTimeout(() => process.exit(3), 100);
  return;
}
process.send({ ready: true, n: prof.n });
process.on('message', (m) => {
  const t0 = Date.now();
  try {
    const buf = Buffer.from(m.pcm, 'base64');
    const i16 = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1);
    const samples = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) samples[i] = i16[i] / 32768;
    const st = ex.createStream();
    st.acceptWaveform({ sampleRate: 16000, samples });
    st.inputFinished();
    if (!ex.isReady(st)) { process.send({ id: m.id, error: 'too_short' }); return; }
    const v = ex.compute(st);
    let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n);
    let sim = 0; for (let i = 0; i < v.length; i++) sim += (v[i] / n) * prof.vector[i];
    process.send({ id: m.id, sim: +sim.toFixed(3), secs: +(samples.length / 16000).toFixed(1), ms: Date.now() - t0 });
  } catch (e) {
    process.send({ id: m.id, error: String(e && e.message || e) });
  }
});
