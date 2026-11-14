// 通话中继入口：一个 HTTP 服务，/v1/call 升级成 WebSocket。
// 生产环境放在 HTTPS/WSS 反代后面（Caddy / Nginx / Cloudflare Tunnel 都行）。
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { config } from './config.mjs';
import { log } from './log.mjs';
import { ticketValid } from './ticket.mjs';
import { CallSession, liveCalls, isEcho, isNod, loadPersona, MAX_REPLY_CHARS, IDLE_HANGUP_MS } from './session.mjs';
import { warmUp } from './brain.mjs';

/** 用户打给 AI 时，最多让手机「正在呼叫」多久等预热（客户端一般 10 秒左右没回音就当断了） */
const RING_MAX_MS = 8000;

const HEARTBEAT_MS = 15_000;
const DEAD_MS = 45_000;

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
  if (url.pathname !== '/v1/call') { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
  if (!ticketValid(url.searchParams.get('ticket') || '', config.callSecret)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
  }
  const resumeId = url.searchParams.get('resume') || '';
  const existing = resumeId ? liveCalls.get(resumeId) : null;
  if (resumeId && (!existing || existing.closed)) { socket.write('HTTP/1.1 410 Gone\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, async (ws) => {
    if (existing) {
      existing.rebind(ws);
      bindSocket(existing, ws);
      existing.send({ type: 'resumed', session: existing.id, state: existing.state, epoch: existing.epoch });
      return;
    }
    const call = new CallSession(ws, {
      client: url.searchParams.get('client') || 'web',
      direction: url.searchParams.get('direction') || 'out',
      lang: url.searchParams.get('lang') || config.lang,
      opener: url.searchParams.get('opener') || '',
      codec: url.searchParams.get('codec') || 'pcm',
    });
    log.info('call.open', { id: call.id, client: call.client, direction: call.direction, codec: call.codec ? 'opus' : 'pcm' });
    bindSocket(call, ws);
    // 预热（坑 #25）：用户打过来时，手机上「正在呼叫」那几秒拿来把人格读进缓存，热好了再发 ready（客户端这时才算接通）。
    // AI 打给用户不用等：接起来先念开场白，那几秒够热了
    const warming = warmUp(loadPersona());
    if (call.direction !== 'in') {
      call.ringing = true;
      call.ensureTts();
      await Promise.race([warming, new Promise((r) => setTimeout(r, RING_MAX_MS))]);
      call.ringing = false;
      if (call.closed || ws.readyState !== 1) return;
    }
    call.send({ type: 'ready', session: call.id, limits: { max_reply_chars: MAX_REPLY_CHARS, idle_hangup_ms: IDLE_HANGUP_MS } });
    call.armIdle();
    // 接通 5 秒一帧音频都没有：说出来（我们见过手机那头麦克风根本没在采，用户干等 30 秒被挂）
    setTimeout(() => { if (!call.gotAudio && ws.readyState === 1) call.notice('接通了，但一点声音都没收到——麦克风好像没在采'); }, 5000);
    // AI 拨用户：一接就先听见它。否则趁用户第一句还没说完，先把合成腿连上
    if (call.direction === 'in' && call.opener) call.sayOpener().catch((e) => call.notice(`开场白没念出来：${e?.message || e}`));
    else call.ensureTts();
  });
});

/** 一条 socket 上的收发与心跳。重连接回来的 socket 也走这里 */
function bindSocket(call, ws) {
  ws.on('message', (data, isBinary) => {
    call.lastSeen = Date.now();
    if (isBinary) {
      if (call.codec) { const pcm = call.codec.decodeMessage(data); if (pcm) call.feedAudio(pcm); } else call.feedAudio(data);
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { call.notice('那条消息不是 JSON'); return; }
    switch (msg.type) {
      case 'ping': call.send({ type: 'pong', t: msg.t ?? null }); break;
      case 'interrupt': {
        // 客户端自己判的打断（比如本地 VAD）。带来它听到的字：是 AI 自己的回声就不理
        const heard = String(msg.heard || '');
        if (heard && !call.hwAec && isEcho(heard, call.spoken)) break;
        if (heard && isNod(heard)) break;   // 「嗯」「对」是在听，不打断（坑 #26）
        if (!call.yieldTurn('client')) call.interrupt('client');
        call.armIdle();
        break;
      }
      case 'text': call.gotAudio = true; call.heard(String(msg.content || '')); break;   // 联调：当成转写出来的一句，一个字的转写额度都不花（也别报「没收到声音」）          // 联调：当成转写出来的一句，一个字的转写额度都不花
      case 'mute': call.muted = Boolean(msg.value ?? true); call.send({ type: 'muted', value: call.muted }); break;   // 联调：只出字幕
      case 'bye': call.close('client'); break;
      default: call.notice(`不认识 "${msg.type}" 这种消息`);
    }
  });
  const beat = setInterval(() => {
    if (call.ws !== ws) { clearInterval(beat); return; }
    if (Date.now() - call.lastSeen > DEAD_MS) { call.close('timeout'); return; }
    try { ws.ping(); } catch { /* 下一拍收尾 */ }
  }, HEARTBEAT_MS);
  ws.on('pong', () => { call.lastSeen = Date.now(); });
  ws.on('close', (code) => {
    clearInterval(beat);
    if (call.ws !== ws || call.closed) return;
    // 对端断了：给它 20 秒回来（?resume=<id>）——网断、切 Wi-Fi、进电梯都是这个形状（坑 #19）
    log.info('call.socket_lost', { id: call.id, code });
    setTimeout(() => { if (call.ws === ws && !call.closed) call.close('peer'); }, 20_000);
  });
  ws.on('error', (err) => log.info('call.error', { id: call.id, err: err?.message || String(err) }));
}

// 重启时给每通电话一句 bye reason=restart，客户端至少知道是重启不是坏了
const bye = () => {
  for (const c of wss.clients) { try { c.send(JSON.stringify({ type: 'bye', reason: 'restart' })); c.close(1001, 'restart'); } catch { /* 忽略 */ } }
  setTimeout(() => process.exit(0), 300);
};
process.once('SIGTERM', bye);
process.once('SIGINT', bye);

server.listen(config.port, config.host, () => log.info('relay.up', { host: config.host, port: config.port, model: config.model }));
