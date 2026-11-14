// 「GPT 格式」的模型腿：OpenAI 的 /chat/completions 流式接口。
// GPT、DeepSeek、通义千问、Kimi、GLM、OpenRouter、本地的 Ollama / vLLM……大部分模型都认这个格式，
// 所以设 LLM_API=openai + OPENAI_BASE_URL + OPENAI_API_KEY + CALL_MODEL 就能换。
// 不加依赖：fetch + 自己拆 SSE（data: 行）。工具循环和 Anthropic 那条腿一样：要调工具就执行、把结果塞回去再问。

import { config } from './config.mjs';

const toOpenAiTools = (tools) => tools.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } },
}));

// GPT-5 / o 系列只认 max_completion_tokens，别家（DeepSeek、千问、Ollama……）大多只认 max_tokens
const maxField = () => process.env.OPENAI_MAX_TOKENS_FIELD || (/^(openai\/)?(gpt-5|o\d)/.test(config.model) ? 'max_completion_tokens' : 'max_tokens');

async function post(body, signal) {
  const res = await fetch(`${config.openaiBase.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(config.openaiKey ? { authorization: `Bearer ${config.openaiKey}` } : {}) },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 240)}`);
  return res;
}

/** 一次流式请求：字逐段交给 onText，返回 { text, toolCalls, finish } */
async function streamOnce({ messages, tools, maxTokens, signal, onText }) {
  const res = await post({
    model: config.model, stream: true, messages, [maxField()]: maxTokens,
    ...(tools.length ? { tools: toOpenAiTools(tools) } : {}),
  }, signal);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let finish = null;
  const calls = [];   // 按 index 拼：id、name 只在第一段来，arguments 一段一段来
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;   // 空行、「: OPENROUTER PROCESSING」这种注释行
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let j; try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error).slice(0, 200));
      const ch = j.choices?.[0];
      if (!ch) continue;
      const d = ch.delta || {};
      // reasoning_content（DeepSeek R1 这类的思考过程）不念，只要正文
      if (d.content) { text += d.content; onText(d.content); }
      for (const tc of d.tool_calls || []) {
        const i = tc.index ?? calls.length;
        calls[i] ||= { id: '', name: '', args: '' };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].name += tc.function.name;
        if (tc.function?.arguments) calls[i].args += tc.function.arguments;
      }
      if (ch.finish_reason) finish = ch.finish_reason;
    }
  }
  return { text, toolCalls: calls.filter(Boolean), finish };
}

/**
 * 跟 brain.mjs 里 Anthropic 那条一样的一轮：带工具循环，最多 6 回合。
 * messages 是 [{ role: 'user'|'assistant', content: string }]，system 是拼好的整段字。
 */
export async function replyOpenAi({ system, messages, tools, runTool, onText, onTool, signal, stillMine, onToolStart }) {
  const convo = [{ role: 'system', content: system }, ...messages];
  for (let round = 0; round < 6; round++) {
    const r = await streamOnce({ messages: convo, tools, maxTokens: config.maxTokens, signal, onText });
    if (!r.toolCalls.length) break;
    onToolStart?.();
    convo.push({
      role: 'assistant',
      content: r.text || null,
      tool_calls: r.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })),
    });
    for (const c of r.toolCalls) {
      let input = {};
      try { input = c.args ? JSON.parse(c.args) : {}; } catch { /* 模型给的参数不是 JSON：当空的 */ }
      onTool?.('start', { id: c.id, name: c.name, input });
      let out; let ok = true;
      try { out = await runTool(c.name, input); } catch (e) { ok = false; out = `出错：${e?.message || e}`; }
      onTool?.('result', { id: c.id, name: c.name, ok });
      convo.push({ role: 'tool', tool_call_id: c.id, content: String(out).slice(0, 4000) });
    }
    if (!stillMine()) break;
  }
}

/** 预热（坑 #25）：同一份 system 空跑 1 个 token。DeepSeek / OpenAI 这些是自动前缀缓存，跑一次第一句就热了 */
export async function warmOpenAi(system, tools) {
  const res = await post({
    model: config.model, stream: false, [maxField()]: 1,
    messages: [{ role: 'system', content: system }, { role: 'user', content: '.' }],
    ...(tools.length ? { tools: toOpenAiTools(tools) } : {}),
  });
  const j = await res.json();
  return j.usage || null;
}
