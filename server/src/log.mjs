// 日志：一行一条 JSON，写 stdout 和 logs/call-YYYY-MM-DD.log。
// 排查通话问题几乎全靠它——每一轮的分段耗时、转写卡住、打断、挂断原因都在这里。
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';

fs.mkdirSync(config.logDir, { recursive: true });

// 任何形似密钥的东西都不许进日志
const SECRET_RE = /(sk-ant-[a-z0-9-]{6}|sk_[a-z0-9]{6})[A-Za-z0-9_-]+/g;
const redact = (s) => String(s).replace(SECRET_RE, '$1***');

function write(level, event, data) {
  const line = redact(JSON.stringify({ ts: new Date().toISOString(), level, event, ...data }));
  process.stdout.write(line + '\n');
  fs.appendFile(path.join(config.logDir, `call-${new Date().toISOString().slice(0, 10)}.log`), line + '\n', () => {});
}

export const log = {
  info: (event, data = {}) => write('info', event, data),
  warn: (event, data = {}) => write('warn', event, data),
  error: (event, data = {}) => write('error', event, data),
};
