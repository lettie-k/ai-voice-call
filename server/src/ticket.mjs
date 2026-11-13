// 短票据：手机不拿长期密钥。你的后端用 CALL_SECRET 签 `exp.hmac`（几分钟有效），手机连中继时带 ?ticket=。
// 签法：hmac = HMAC-SHA256(CALL_SECRET, "call:" + exp).hex 前 32 位；exp 是毫秒时间戳。
import crypto from 'node:crypto';

export function signTicket(secret, ttlMs = 5 * 60_000) {
  const exp = Date.now() + ttlMs;
  return `${exp}.${crypto.createHmac('sha256', secret).update(`call:${exp}`).digest('hex').slice(0, 32)}`;
}

export function ticketValid(ticket, secret) {
  if (!ticket || !secret) return false;
  const dot = ticket.indexOf('.');
  if (dot <= 0) return false;
  const exp = Number(ticket.slice(0, dot));
  const got = ticket.slice(dot + 1);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const want = crypto.createHmac('sha256', secret).update(`call:${exp}`).digest('hex').slice(0, 32);
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
