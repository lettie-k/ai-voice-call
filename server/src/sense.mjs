// 听语气第二层：SenseVoice 给每句话打情绪 / 声音事件标签（跑在本地，sherpa-onnx）。
//
// 实测一台 2 核云服务器：加载 1.6s，5 秒音频判 300ms，字段 emotion / event 各自独立。
// 识别跑在子进程（sense-worker.cjs），主进程只发 PCM、收标签；子进程挂了自动重拉。
// 用法：analyze(pcm) → { emotion, event } 或 null；调用方自己决定等它多久（call.mjs 里最多 500ms）。
//
// 只递事实不下结论：这里只把机器打的标签翻成中文，不加一个字的解读。
// NEUTRAL / Speech 是默认态，不值一提，翻成空——旁注里只出现「像难过」「有笑声」这种真信号。

import { fork } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { log } from './log.mjs';

// 模型没下载就整层跳过（别让子进程起了又挂、挂了又拉）
const MODEL_DIR = process.env.SENSE_MODEL_DIR || './models/sensevoice';
const ENABLED = process.env.CALL_SENSE !== '0' && fs.existsSync(`${MODEL_DIR}/model.int8.onnx`);
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sense-worker.cjs');

const EMOTION = { HAPPY: '开心', SAD: '难过', ANGRY: '生气', NEUTRAL: '', FEARFUL: '害怕', DISGUSTED: '厌烦', SURPRISED: '惊讶' };
const EVENT = { Speech: '', Laughter: '有笑声', Cry: '有哭声', Cough: '咳嗽了', Sneeze: '打了个喷嚏', BGM: '背景有音乐', Applause: '有鼓掌' };

let child = null;
let ready = false;
let seq = 0;
const pending = new Map();

function spawn() {
  if (!ENABLED) return;
  child = fork(WORKER, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  ready = false;
  child.on('message', (m) => {
    if (m.ready) { ready = true; log.info('sense.ready', {}); return; }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    p.resolve(m);
  });
  child.on('exit', (code) => {
    log.info('sense.exit', { code });
    ready = false;
    for (const p of pending.values()) { clearTimeout(p.timer); p.resolve(null); }
    pending.clear();
    setTimeout(spawn, 3000);   // 挂了三秒后重拉
  });
}
spawn();

/**
 * 给用户说的一段话（PCM16 16k）打标签。返回 { emotion, event, raw } 或 null。
 * 不抛错、不卡：子进程没起来 / 超过 waitMs 就回 null，调用方照常走。
 */
export function analyze(pcm, waitMs = 500) {
  if (!ENABLED || !child || !ready || !pcm?.length) return Promise.resolve(null);
  const id = ++seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve(null); }, waitMs);
    pending.set(id, { resolve, timer });
    try { child.send({ id, pcm: Buffer.from(pcm).toString('base64') }); }
    catch { clearTimeout(timer); pending.delete(id); resolve(null); }
  }).then((m) => {
    if (!m || m.error) { if (m?.error) log.info('sense.error', { err: m.error }); return null; }
    const emotion = EMOTION[m.emotion] ?? '';
    const event = EVENT[m.event] ?? '';
    log.info('sense.result', { emotion: m.emotion, event: m.event, ms: m.ms });
    return { emotion, event, raw: m };
  });
}

// 可选：声纹（只认机主的声音）。子进程，跟情绪那个分开跑——两核各一个，不互相排队
const VOICE_WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'voice-worker.cjs');
let vchild = null; let vready = false; const vpending = new Map();
function vspawn() {
  if (process.env.CALL_VOICE === '0' || !fs.existsSync(`${process.env.SPEAKER_MODEL_DIR || './models/speaker'}/owner.json`)) return;
  vchild = fork(VOICE_WORKER, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  vready = false;
  vchild.on('message', (m) => {
    if (m.ready) { vready = true; log.info('voice.ready', { n: m.n }); return; }
    if (m.fatal) { log.info('voice.off', { err: m.fatal }); return; }
    const p = vpending.get(m.id); if (!p) return;
    vpending.delete(m.id); clearTimeout(p.timer); p.resolve(m);
  });
  vchild.on('exit', (code) => {
    log.info('voice.exit', { code }); vready = false;
    for (const p of vpending.values()) { clearTimeout(p.timer); p.resolve(null); }
    vpending.clear();
    if (code !== 3) setTimeout(vspawn, 3000);   // 3 = 没有声纹档/模型，别反复拉
  });
}
vspawn();

/** 这段话像不像机主：{ sim, secs, ms } 或 null。sim 是跟机主声纹档的余弦相似度（我们实测：本人整句 ≥0.42，别人 ≤0.31） */
export function voiceCheck(pcm, waitMs = 1500) {
  if (!vchild || !vready || !pcm?.length) return Promise.resolve(null);
  const id = ++seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { vpending.delete(id); resolve(null); }, waitMs);
    vpending.set(id, { resolve, timer });
    try { vchild.send({ id, pcm: Buffer.from(pcm).toString('base64') }); }
    catch { clearTimeout(timer); vpending.delete(id); resolve(null); }
  }).then((m) => (m && !m.error ? { sim: m.sim, secs: m.secs, ms: m.ms } : null));
}
