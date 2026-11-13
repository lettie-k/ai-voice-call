// 生成机主的声纹档：node tools/enroll-voice.mjs a.wav b.wav …（16kHz 单声道 PCM16 wav，每句 3 秒以上，越多越稳，建议 20 句以上）
// 结果写到 $SPEAKER_MODEL_DIR/owner.json：{ n, vector }（各句向量归一化后取平均、再归一化）
import fs from 'node:fs';
import { createRequire } from 'node:module';
const sherpa = createRequire(import.meta.url)('sherpa-onnx-node');

const dir = process.env.SPEAKER_MODEL_DIR || './models/speaker';
const ex = new sherpa.SpeakerEmbeddingExtractor({ model: `${dir}/campplus_zh.onnx`, numThreads: 1, debug: 0 });
const files = process.argv.slice(2);
if (!files.length) { console.error('用法：node tools/enroll-voice.mjs a.wav b.wav …'); process.exit(1); }

let sum = null; let n = 0;
for (const f of files) {
  const w = sherpa.readWave(f);
  if (w.sampleRate !== 16000) { console.warn(`跳过 ${f}：不是 16kHz`); continue; }
  const st = ex.createStream();
  st.acceptWaveform({ sampleRate: 16000, samples: w.samples });
  st.inputFinished();
  if (!ex.isReady(st)) { console.warn(`跳过 ${f}：太短`); continue; }
  const v = ex.compute(st);
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  sum = sum || new Array(v.length).fill(0);
  v.forEach((x, i) => { sum[i] += x / norm; });
  n++;
}
if (!n) { console.error('一句都没算成'); process.exit(1); }
const norm = Math.sqrt(sum.reduce((a, x) => a + x * x, 0));
fs.writeFileSync(`${dir}/owner.json`, JSON.stringify({ n, vector: sum.map((x) => x / norm) }));
console.log(`写好了：${dir}/owner.json（${n} 句）`);
