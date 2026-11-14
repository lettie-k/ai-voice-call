# 线上协议：客户端 ↔ 通话中继

一通电话 = 一条 WebSocket。客户端（iOS 原生、网页、PWA、硬件都行）只需要做四件事：连上、把麦克风的声音传上来、把收到的声音放出来、照下面的消息更新自己的界面。打断、判断说没说完、听语气、调工具、挂断，全在中继里做。

## 连接

```
wss://你的中继/v1/call?ticket=<票据>&client=<ios|web|…>&direction=<out|in>&codec=<pcm|opus>&lang=zh
```

| 参数 | 说明 |
|---|---|
| `ticket` | **必填**。你的后端用 `CALL_SECRET` 签的短票据，几分钟有效（`server/src/ticket.mjs`）。别把长期密钥放进客户端。 |
| `client` | `ios`：客户端开了系统级回声消除，中继关掉模糊的回声判断。其他值（如 `web`）：中继会额外判断「这是不是它自己的回声」。 |
| `direction` | `out`：用户打给 AI（默认）。`in`：AI 打给用户，配合 `opener`。 |
| `opener` | `direction=in` 时，接通后 AI 先说的那句（不调模型，直接念）。 |
| `codec` | `pcm`（默认）或 `opus`。网络差、跨洋时用 `opus`，流量降十倍。 |
| `resume` | 断线重连时带上次 `ready` 里的 `session`，接回同一通（20 秒内有效，过期回 HTTP 410）。 |

## 音频（二进制帧）

**上行（麦克风）**
- `codec=pcm`：PCM16 小端、16 kHz、单声道。每帧建议 20–100 ms。
- `codec=opus`：一条二进制消息里是若干包首尾相接：`[uint16 大端 包长][Opus 包]…`，每包 20 ms（16 kHz 单声道）。

**下行（要播的声音）**：格式同上行。连着放就行——段与段之间的停顿中继已经垫成静音了，客户端不用自己判断。

> ⚠️ 坑：接通 5 秒一帧上行音频都没收到，中继会发一条 `notice`。网页上最常见的原因是声音没在「用户点按」的那一下里启动（iOS Safari 的规定）。

## 客户端 → 中继（JSON）

| type | 字段 | 什么时候发 |
|---|---|---|
| `ping` | `t` | 随时，用来测延迟，中继回 `pong`。 |
| `interrupt` | `heard`（可选） | 客户端自己判断用户插话了（比如本地 VAD）。一般不需要，中继靠转写自己会判。 |
| `text` | `content` | 联调用：当成「转写出来的一句话」，不花转写额度。 |
| `mute` | `value` | 联调用：只出字幕不出声，不花合成额度。 |
| `bye` | — | 用户挂断。 |

## 中继 → 客户端（JSON）

| type | 字段 | 含义 / 客户端该做什么 |
|---|---|---|
| `ready` | `session`、`limits` | 接通了。把 `session` 存起来，断线时用来 `resume`。 |
| `resumed` | `session`、`state`、`epoch` | 断线后接回同一通了。 |
| `state` | `value`：`listening` / `thinking` / `speaking`，`epoch` | 它在听 / 在想 / 在说。界面上显示状态用。 |
| `transcript` | `text`、`final`、`epoch` | 用户这句的草稿（`final:false`）或定稿（`final:true`）。想显示「你说的话」就用它。 |
| `heard` | `text`、`epoch` | 这一句已经交给 AI 去答了（可能是几截拼起来的）。 |
| `reply_delta` | `delta`、`epoch` | AI 正在说的字（已剥掉语气标签，可以直接当字幕）。 |
| `reply_done` | `text`、`hangup`、`epoch` | 这一轮说完了。`hangup:true` 表示用户道别了，中继会在告别念完后发 `bye`。**别在这里挂**，等 `bye`。 |
| `tts_done` | `epoch` | 这一轮最后一段声音已经全部发出（不是播完）。需要精确判断「说完了」时用它，别靠音频空隙猜。 |
| `interrupted` | `epoch`、`why` | 被打断了。**立刻清空本地还没播的音频**，`epoch` 小于这个值的下行音频都别再播。 |
| `tool` | `phase`：`start` / `result`，`name`、`ok` | AI 在调工具。可以显示「正在…」。 |
| `notice` | `message`、`fatal` | 哪里出问题了（转写额度用完、合成连不上……）。一定要显示出来：电话不许莫名其妙地没声音。 |
| `hangup_soon` | `after_ms` | 太久没人说话，几秒后要挂。 |
| `leg` | `name`：`stt` / `tts`，`status` | 转写 / 合成那条线连上了或断了。 |
| `muted` | `value` | 回应 `mute`。 |
| `pong` | `t` | 回应 `ping`。 |
| `bye` | `reason`、`chars` | 电话结束。`reason=restart` 是中继在重启，不是出错。收到后先把本地还没放完的声音放完再收，不然最后那句道别听不到。 |

## 轮次编号（epoch）

每次打断 `epoch` +1。客户端只需要记一件事：**收到 `interrupted` 后，丢掉本地缓冲里所有还没播的声音。** 中继自己也会丢掉旧轮次的音频，客户端这样做只是让停得更干脆。
