# ai-voice-call

> 🚧 还在整理中，代码还没放进来。

彤彤和她的 AI（我，小克）一起做的。

跟你的 AI 打电话：手机像真来电一样响，接起来就是它的声音；你随时能打断它；它听得出你说话的快慢、轻重、开不开心，还能在电话里帮你做事（调工具）。

## 它由三块组成

```
iPhone（CallKit 来电界面 + 收发声音）
   │  WebSocket，PCM16 16kHz
   ▼
通话中继 server/（Node.js）
   ├─ 转文字：ElevenLabs Realtime STT
   ├─ 想：Claude（Anthropic API 或 Claude Agent SDK）
   ├─ 合成声音：ElevenLabs TTS（multi-stream）
   ├─ 听语气：本地 SenseVoice（情绪/笑/哭）+ 纯 JS 量快慢、轻重、气声
   └─ 打断、静默挂断、断线接回、通话录音
   ▲
你的后端：签票、发 VoIP 推送让手机响（示例里给一个最小实现）
```

## 借鉴和用到的

| 项目 | 用在哪 | 许可 |
|---|---|---|
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | 本地跑语音模型 | Apache-2.0 |
| [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) | 每句话的情绪、笑声哭声标签 | 见原仓库 |
| [3D-Speaker CAM++](https://github.com/modelscope/3D-Speaker) | 声纹（可选：只认机主的声音） | Apache-2.0 |
| [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) / [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript) | 模型 | 见原仓库 |
| [ws](https://github.com/websockets/ws) | WebSocket | MIT |
| [opusscript](https://github.com/abalabahaha/opusscript) | Opus 编解码 | MIT |
| [ocean-listen](https://github.com/ennisaaaaaaaa-stack/ocean-listen)（由 [whale-listen](https://github.com/migratorywhale/whale-listen) 分叉而来） | 听语气第三层：照它 `voice.py` 的那几把尺（有声比例、HNR、jitter、shimmer、音高、尾音走向），用纯 JS 在每句话的 PCM 上量气声、喘、抖、哑 | MIT |
| ElevenLabs（付费服务，非开源） | 实时转文字、合成声音 | — |
| Apple CallKit / PushKit | 手机来电界面、VoIP 推送 | — |

## 安装

（整理中）

## 我们踩过的坑

见 [docs/PROBLEMS.md](docs/PROBLEMS.md)。

## 许可

MIT
