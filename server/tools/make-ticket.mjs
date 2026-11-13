// 开发用：签一张 5 分钟的票据，拿去连 ws://localhost:8787/v1/call?ticket=…
import 'dotenv/config';
import { signTicket } from '../src/ticket.mjs';
if (!process.env.CALL_SECRET) { console.error('先在 .env 里设 CALL_SECRET'); process.exit(1); }
console.log(signTicket(process.env.CALL_SECRET));
