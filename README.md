# ai-voice-call

> 🚧 还在整理，没有正式发布。

彤彤和她的 AI（我，小克）一起做的：**跟你的 AI 打电话**。

这里**只有功能，没有页面**——每个人的前端都不一样，界面你自己做。把仓库交给你的 AI，让它照 [docs/INTEGRATE.md](docs/INTEGRATE.md) 装进你自己的项目。

## 它能做什么

- **像打电话一样说话**：实时转文字 → AI 想 → 合成声音，第一句一两秒内开口（每一轮会记下慢在哪一步）。
- **随时打断**：它说着话你插一句，一秒内停下，被打断的那句不会补念。一点噪音、一声「嗯」不算，它会接着说。
- **不抢话**：你说到一半停顿（「我想……」「然后——」），它会等你说完、把两截拼成一句再回。
- **听得出语气**（三层，只递事实不下结论，交给 AI 自己判断）：
  1. 说了多久、语速、轻重、卡顿、隔了多久才开口——和这通电话里你「平时」比；
  2. 情绪和声音事件：像开心 / 难过、有笑声 / 哭声（本地 SenseVoice，可选）；
  3. 嗓子：气声重不重、在不在喘、抖不抖、哑不哑、音调和尾音（照 ocean-listen 的尺子，纯 JS）。
- **能帮你做事**：接你自己的工具（开空调、查天气……）；调工具时会先说「我看看」，久了会垫一句「还在弄，你别挂啊」；你在它干活时插的话会攒着，不会把工具掐断。
- **不会莫名其妙没声音**：转写卡住自动换线、额度用完照实说、模型 12 秒不开口会说「我卡了一下」。
- **断线接回**：网断、进电梯，20 秒内回来还是同一通电话。
- **只认道别才挂**：说「拜拜」「再见」才挂，「好了」「先这样」不挂；太久没人说话会提醒后再挂。
- **AI 主动打给你**（iOS 原生）：手机像真来电一样响，锁屏也能接，接起来它先开口。
- **声纹（可选）**：认出是不是机主在说话。

## 结构

```
你的前端（你自己做界面）
  ├─ iOS 原生：clients/ios（CallKit 来电/去电 + 收发声音，无界面）
  └─ 网页 / PWA：clients/web（无界面 JS 模块）
        │  WebSocket，协议见 docs/PROTOCOL.md
        ▼
通话中继 server/（Node.js，放在你自己的服务器上）
  ├─ 转文字：ElevenLabs Scribe v2 Realtime
  ├─ 想：Claude（Anthropic API）
  ├─ 合成声音：ElevenLabs（v3 对话通道 / flash）
  └─ 听语气、打断、不抢话、断线接回、挂断
        ▲
你的后端：签通话票据；要「AI 打给你」再发 VoIP 推送
```

## 文档

- [docs/INTEGRATE.md](docs/INTEGRATE.md)：怎么装（写给帮你装的 AI 看）
- [docs/PROTOCOL.md](docs/PROTOCOL.md)：客户端 ↔ 中继的协议
- [docs/PROBLEMS.md](docs/PROBLEMS.md)：我们踩过的 26 个坑，每个都写了现象、原因、修法

## 借鉴和用到的

| 项目 | 用在哪 | 许可 |
|---|---|---|
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | 本地跑语音模型 | Apache-2.0 |
| [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) | 每句话的情绪、笑声哭声标签 | 见原仓库 |
| [3D-Speaker CAM++](https://github.com/modelscope/3D-Speaker) | 声纹（可选） | Apache-2.0 |
| [ocean-listen](https://github.com/ennisaaaaaaaa-stack/ocean-listen)（由 [whale-listen](https://github.com/migratorywhale/whale-listen) 分叉而来） | 听语气第三层：照它 `voice.py` 的几把尺（有声比例、HNR、jitter、shimmer、音高、尾音），用纯 JS 量气声、喘、抖、哑 | MIT |
| [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript) | 模型 | MIT |
| [ws](https://github.com/websockets/ws) | WebSocket | MIT |
| [opusscript](https://github.com/abalabahaha/opusscript) | 中继端 Opus 编解码 | MIT |
| ElevenLabs（付费服务，非开源） | 实时转文字、合成声音 | — |
| Apple CallKit / PushKit / AudioConverter | 来电界面、VoIP 推送、iOS 端 Opus | — |

## 许可

MIT
