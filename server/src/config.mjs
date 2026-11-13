// 所有配置都从环境变量来（server/.env，见 .env.example）。密钥只放在服务端，不下发到手机。
import 'dotenv/config';

const num = (v, d) => (v == null || v === '' ? d : Number(v));

export const config = {
  port: num(process.env.PORT, 8787),
  host: process.env.HOST || '127.0.0.1',
  logDir: process.env.LOG_DIR || './logs',

  // 手机连上来时带的票：HMAC(CALL_SECRET, callId:exp)。你的后端签，这里验（见 src/ticket.mjs）
  callSecret: process.env.CALL_SECRET || '',

  // ElevenLabs：转写（Scribe v2 Realtime）+ 合成（multi-stream TTS）
  elevenKey: process.env.ELEVENLABS_API_KEY || '',
  voiceId: process.env.ELEVENLABS_VOICE_ID || '',
  ttsModel: process.env.ELEVENLABS_TTS_MODEL || 'eleven_flash_v2_5',
  lang: process.env.CALL_LANG || 'zh',

  // 模型：Anthropic API
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  model: process.env.CALL_MODEL || 'claude-haiku-4-5',
  maxTokens: num(process.env.CALL_MAX_TOKENS, 400),

  // 人格：一份 Markdown，整通电话当 system prompt（示例见 persona.example.md）
  personaFile: process.env.PERSONA_FILE || './persona.example.md',

  // 可选：本地听感模型（sherpa-onnx）。没下载就自动跳过这一层
  senseModelDir: process.env.SENSE_MODEL_DIR || './models/sensevoice',
  speakerModelDir: process.env.SPEAKER_MODEL_DIR || './models/speaker',

  // 通话录音（每轮一段 wav）存哪；留空不存
  recordDir: process.env.RECORD_DIR || '',
};
