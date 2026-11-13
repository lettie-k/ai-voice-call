// SenseVoice 子进程：只干一件事——收 PCM16 16k，回情绪/事件/文字。
// 为什么单独一个进程：识别是同步的、一句 300~500ms，放主进程会把所有通话的音频转发卡住。
// 模型加载一次（1.6s），之后常驻。主进程那边见 src/call-sense.mjs。
const sherpa = require('sherpa-onnx-node');
const dir = process.env.SENSE_MODEL_DIR || './models/sensevoice';
const rec = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    senseVoice: { model: `${dir}/model.int8.onnx`, language: 'auto', useInverseTextNormalization: 1 },
    tokens: `${dir}/tokens.txt`, numThreads: 2, provider: 'cpu', debug: 0,
  },
});
process.send({ ready: true });
process.on('message', (m) => {
  const t0 = Date.now();
  try {
    const buf = Buffer.from(m.pcm, 'base64');
    const i16 = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1);
    const samples = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) samples[i] = i16[i] / 32768;
    const st = rec.createStream();
    st.acceptWaveform({ sampleRate: 16000, samples });
    rec.decode(st);
    const r = rec.getResult(st);
    const tag = (v) => String(v || '').replace(/^<\|(.*)\|>$/, '$1');
    process.send({ id: m.id, emotion: tag(r.emotion), event: tag(r.event), lang: tag(r.lang), text: String(r.text || '').slice(0, 80), ms: Date.now() - t0 });
  } catch (e) {
    process.send({ id: m.id, error: String(e && e.message || e), ms: Date.now() - t0 });
  }
});
