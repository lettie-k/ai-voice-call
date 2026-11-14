# 接入说明（写给帮你装它的 AI 看）

> 把这个仓库交给你的 AI（Claude Code 之类），说一句「照 docs/INTEGRATE.md 把通话装进我的项目」。
> 这份说明是写给它的：每一步要做什么、放在哪、哪些地方别自作主张。界面完全由你自己的项目决定——这个仓库不带任何页面。

## 给 AI 的总原则

1. **不要做界面**。这里只有功能。按钮、通话页、字幕的样子，照用户项目现有的设计做，或者问用户。
2. **钥匙只放服务器**。`ELEVENLABS_API_KEY`、`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`、`CALL_SECRET` 只能出现在 `server/.env` 和用户自己的后端里，绝不进客户端代码、绝不提交进仓库。
3. **先在本地跑通再接前端**：用 `CALL_MOCK=1` + `text` 消息把状态机跑一遍（见第 1 步），再接麦克风。
4. 有问题先看 `docs/PROBLEMS.md`，那些坑多半已经写了。

## 第 1 步：起中继（server/）

```bash
cd server
cp .env.example .env      # 填 CALL_SECRET、ELEVENLABS_API_KEY、ELEVENLABS_VOICE_ID、ANTHROPIC_API_KEY
npm install
npm start                 # 默认 127.0.0.1:8787
```

- 人格：把 `persona.example.md` 换成用户自己的，`.env` 里 `PERSONA_FILE` 指过去。
- 模型：用户用的不是 Claude 时，问清楚是哪家、用的哪个型号，设 `LLM_API=openai` + `OPENAI_BASE_URL` + `OPENAI_API_KEY` + `CALL_MODEL`（各家地址见 `.env.example`）。README 的「换模型」表里有实测的首字延迟，超过两秒的要提醒用户电话里会觉得卡。
- 公网访问：放在 HTTPS 反代后面（Caddy、Nginx、Cloudflare Tunnel 都行），客户端连 `wss://域名/v1/call`。
- 不花钱先跑通：`.env` 里加 `CALL_MOCK=1`（模型用桩回复），客户端连上后发 `{"type":"mute"}` 和 `{"type":"text","content":"你好"}`，应该收到 `heard` → `reply_done`；发「拜拜」应该收到 `bye`。签测试票据：`npm run ticket`。

可选的「听语气」第二、三层：
- 第三层（气声、抖、哑、音高）是纯 JS，默认就开着。
- 第二层（情绪、笑、哭）要下载 SenseVoice 模型：`npm install sherpa-onnx-node`，到 sherpa-onnx 的发布页下 `sherpa-onnx-sense-voice-zh-en-ja-ko-yue` 解压，把 `model.int8.onnx`、`tokens.txt` 放进 `server/models/sensevoice/`。没有就自动跳过。
- 声纹（只认机主）：下 3D-Speaker CAM++ 中文模型 `campplus_zh.onnx` 放进 `server/models/speaker/`，再 `node tools/enroll-voice.mjs 录音1.wav 录音2.wav …` 生成 `owner.json`。目前只记日志、不拦人。

## 第 2 步：用户的后端签票据

客户端连中继要带一张几分钟有效的票据，**由用户自己的后端签**（客户端拿不到 `CALL_SECRET`）。在用户后端加一个需要登录的接口，比如 `POST /api/call/ticket`，返回 `{ ticket, relayURL }`：

```js
// Node 示例（其他语言照这个算法写）
import crypto from 'node:crypto';
function signTicket(secret, ttlMs = 5 * 60_000) {
  const exp = Date.now() + ttlMs;
  const sig = crypto.createHmac('sha256', secret).update(`call:${exp}`).digest('hex').slice(0, 32);
  return `${exp}.${sig}`;
}
```

## 第 3 步：接前端

### 网页 / PWA（clients/web）

1. 把 `clients/web/pcm-worklet.js` 放进用户项目的静态目录（能被浏览器直接访问到的地方）。
2. 把 `clients/web/ai-call.js` 放进用户项目的源码里（它是一个没有依赖的 ES module，TypeScript 项目可以直接引或改成 .ts）。
3. 在用户的「打电话」按钮的点击事件里**同步**调用 `call.start(...)`——先拿票据再 start 是错的（iOS Safari 要求声音在点按的同步栈里启动）。正确做法：页面加载时或按钮出现时先把票据取好放着，点按时直接 start；或者让 start 内部先建 AudioContext（ai-call.js 已经这么做了），票据在 start 之后再取也行，只要 `new AICall().start()` 本身是在点击回调里调用的。
4. 用事件画界面：`onState`（在听 / 在想 / 在说）、`onTranscript`（用户的话）、`onReplyDelta` / `onReplyDone`（AI 的话，可当字幕）、`onNotice`（**必须显示**）、`onEnded`。

PWA 的限制（要告诉用户）：不能像真来电一样响；锁屏或切走后通话多半会断；要「AI 主动打来」只能发一条网页推送，用户点开再接。

### iOS 原生（clients/ios）

1. 把 `AICallClient.swift`、`AICallOpus.swift`、`AICallKit.swift` 加进 app target。没有第三方依赖（Opus 用的是系统 AudioConverter）。
2. Capabilities：Background Modes 勾上 **Audio** 和 **Voice over IP**；Push Notifications 打开。`Info.plist` 加 `NSMicrophoneUsageDescription`。
3. 实现 `AICallBackend`：`fetchTicket()` 调第 2 步的接口；`reportMissed()` 可以空着。
4. 建一个 `AICallKit`（全 app 只要一个），设 `delegate`，用回调画用户自己的通话界面。
5. 用户打给 AI：按钮里调 `startOutgoing()`。接通后系统会显示自带的通话界面（灵动岛 / 锁屏）。
6. AI 打给用户（可选，要用户后端会发 VoIP 推送）：用 PushKit 注册 VoIP token 交给后端；收到推送后在 `pushRegistry(_:didReceiveIncomingPushWith:for:completion:)` 里**同步**调 `handleIncomingPush(payload, completion:)`——苹果规定收到 VoIP 推送必须立刻上报来电，不报会被系统收回推送权限。推送体：`{ callId, ticket, relayURL, opener, expiresAt }`，后端用 APNs（`apns-push-type: voip`，topic 是 `<bundle id>.voip`）发。

## 第 4 步：验收

- 打通一通：说一句话，一两秒内听到回答；`server/logs/` 里每一轮有一行 `call.timing`，能看出慢在哪一步。
- 打断：AI 说长话时插一句「等一下」，它应该在一秒内停下，且不再补念。
- 没说完：说「我想……」停一下再接着说，它不该抢着回前半句。
- 挂断：说「拜拜」，它道别后挂；说「好了」「先这样」不该挂。
- 断网：通话中关掉 Wi-Fi 几秒再打开，应该接回同一通（20 秒内）。
