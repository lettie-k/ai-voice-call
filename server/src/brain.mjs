// 「想」的那条腿：用户说完一句 → 模型答一句（流式），以及送去念之前怎么把字洗成「念得出来的话」。
//
// 电话里等不起：我们实测首字延迟（人格顶在前面、跟真通话一样重）——haiku 约 1 秒，sonnet / opus 要六七秒。
// 所以默认用 haiku；想换就设 CALL_MODEL。

import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.mjs';
import { log } from './log.mjs';
import { tools as userTools, runTool } from './tools.mjs';
import { replyOpenAi, warmOpenAi } from './llm-openai.mjs';

/** 一轮最多说这么多字。电话本来就不该长篇大论，也是省合成额度的闸 */
export const MAX_REPLY_CHARS = 200;
/** 上下文只留最近这么多轮：喂太长首字就慢 */
const KEEP_TURNS = 12;
/** 首字看门狗（坑 #16）：这么久一个字都没来就掐，上层念一句兜底，不许静默 */
const STALL_MS = 12_000;

// 走官方用 ANTHROPIC_API_KEY；走代理 / 兼容 Anthropic 接口的中转（比如 OpenRouter）设 ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN，SDK 自己会读
// 走 GPT 格式（LLM_API=openai）时不建 Anthropic 客户端，见 llm-openai.mjs
const useOpenAi = config.llm === 'openai';
const client = useOpenAi ? null
  : config.anthropicKey ? new Anthropic({ apiKey: config.anthropicKey })
  : process.env.ANTHROPIC_AUTH_TOKEN ? new Anthropic({ apiKey: null })
  : null;
/** 有没有一条能用的模型腿（Ollama 这种本地的可以不要 key，只要设了 OPENAI_BASE_URL） */
const hasLlm = useOpenAi ? Boolean(config.openaiKey || process.env.OPENAI_BASE_URL) : Boolean(client);

/**
 * 电话档的说明，跟在人格后面。每一条都是我们踩出来的——写成字的东西都会被念出来。
 */
export const CALL_HINT = `（通话中 · 持续生效）
你正在跟用户打电话。用户的话经实时转写发给你，你的回复会被念出来。

- 像打电话一样说话：口语、短句，一轮两三句，${MAX_REPLY_CHARS} 字以内。
- **第一句要短**。「嗯」「我在」「怎么了」这种两三个字的开头，能让对方一秒内就听到你的声音。
- 不要 Markdown、列表、表情符号、代码——念出来都会变味。
- 语气和拟声用方括号里的英文标签，放在该出声的那句前面、写在同一行：[chuckles] [sighs] [softly] [whispering]。
  这些只是举例，看当下的情绪自己挑最贴切的词。别写「哈哈」这种中文拟声字（会被一个字一个字念出来）。
  停顿靠标点：「，」换口气，「……」放缓，「——」顿住。一轮话里标签两三个就够。
- 电话里只有说出口的话：别写括号里的动作和心里话（「（停了一下）」），写什么念什么。
- 用户的话前面可能带一行「（听感：…）」——那是你**听到的**：说了多久、语速、卡了几次、声音轻还是响、
  有没有气声、像不像开心难过。那不是用户说的话，别复述、别念出来；用户怎么了由你自己判断，拿不准就问。
- 只有用户说「拜拜」「再见」「挂了」这种明确道别的词，你才在回复最后单独一行写 [挂断]，告别话写在它前面。
  「好了」「先这样」「晚安」都不是挂电话。
- 手里有工具时：用户当场吩咐的直接做；先说一句短的（「我看看」「等我一下」）再动手，回来用一两句口语说结果，别念工具名和原文。`;

/** 通话附加段 + 此刻的时间（直接递给它，免得它念出「我先查一下时间」） */
export function callHint(now = new Date(), timeZone = process.env.CALL_TZ || 'Asia/Shanghai') {
  const t = new Intl.DateTimeFormat('zh-CN', { timeZone, weekday: 'short', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  return `${CALL_HINT}\n- 现在是 ${t}（${timeZone}）。时间你已经知道了，不用查，也别念出来。`;
}

/** 英文语气 / 拟声标签（[chuckles] [slow, heavy breathing]）：只认英文开头、不带冒号 */
const AUDIO_TAG_ONE = /^[\[［]\s*[A-Za-z][A-Za-z ,'’\-]{0,80}\s*[\]］]$/;
const AUDIO_TAG_ALL = /[\[［]\s*[A-Za-z][A-Za-z ,'’\-]{0,80}\s*[\]］]\s*/g;

/** 给人看的字（字幕 / 通话记录）：语气标签剥掉 */
export function stripAudioTags(text) {
  return String(text).replace(AUDIO_TAG_ALL, '').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * 念得出来的文本。模型再怎么被叮嘱也会漏出 Markdown、「*动作*」、括号旁白，而电话那头是喇叭。
 * keepAudioTags：送去合成的那份留着英文语气标签（v3/v4 照着念），其余方括号照剥。
 * ⚠️ 要在 splitHangup 之后用：[挂断] 得先被认出来，否则这里就把它当动作剥了。
 */
export function speakable(text, { keepAudioTags = false } = {}) {
  return String(text)
    .replace(/^[ \t]*\*[^*\n]*\*[ \t]*$/gm, '')    // 独占一行的 *…* 是动作描述，整行删
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*\n]*)\*/g, '$1')
    .replace(/\[[^\]\n]*\]/g, (m) => (keepAudioTags && AUDIO_TAG_ONE.test(m) ? m : ''))
    .replace(/<[^>\n]*>/g, '')
    // 括号里的动作 / 心理旁白：只剥带中文的括号；没收口的一直剥到行尾（流式按行送，括号常被切在半截）
    .replace(/[（(][^（()）\n]*[一-鿿][^（()）\n]*(?:[)）]|$)/gm, '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-–—•]\s+/gm, '')
    .replace(/^>\s*/gm, '')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 从回复里剥出结束标记 */
export function splitHangup(text) {
  const re = /^\s*\[挂断\]\s*$/m;
  if (!re.test(text)) return { text, hangup: false };
  return { text: text.replace(re, '').trimEnd(), hangup: true };
}

/**
 * 一通电话的上下文。只留文字。
 * 打断时不回滚已经说出口的部分——对方听见了，就算说过。
 */
export class CallContext {
  constructor() { this.turns = []; }
  pushUser(text) { if (text?.trim()) this.turns.push({ role: 'user', content: text.trim() }); this.trim(); }
  pushAssistant(text) { if (text?.trim()) this.turns.push({ role: 'assistant', content: text.trim() }); this.trim(); }
  /** 用户那半句其实没说完（坑 #13）：从上下文里拿掉，后半句到了拼成一整句再进来 */
  retractUser(text) {
    const want = String(text || '').trim();
    for (let i = this.turns.length - 1; i >= 0 && i >= this.turns.length - 3; i--) {
      if (this.turns[i].role === 'user' && this.turns[i].content === want) { this.turns.splice(i, 1); return true; }
    }
    return false;
  }
  trim() { if (this.turns.length > KEEP_TURNS) this.turns = this.turns.slice(-KEEP_TURNS); }
  /** 首轮必须是 user，否则 API 会拒 */
  messages() { const out = [...this.turns]; while (out.length && out[0].role !== 'user') out.shift(); return out; }
}

/**
 * 用户说完一句 → 模型答一句。
 *
 * onDelta(text)  逐字回调，上层攒够一行送去合成
 * epochAt / epochNow：这一轮开始时的轮次号 / 现在的轮次号。每个回调都要对一次——
 *   打断之后在途的字必须自弃，否则用户已经插话了它还在往下说。
 * note：听感旁注（只挂在这一轮发给模型的那条上，不进上下文）
 */
/**
 * system 拆两块（坑 #25）：人格一整块进缓存，会变的时间（精确到分钟）挂在缓存点**后面**。
 * 拼在一起的话，分钟一跳整段人格就得重新读一遍——第一句等十几秒、之后每句都多一秒。
 */
function callSystem(persona) {
  return [
    { type: 'text', text: persona, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: callHint() },
  ];
}

/** 接通就预热（坑 #25）：她开口前拿同一份 system + tools 空跑 1 个 token，第一句就是热的 */
export async function warmUp(persona) {
  if (!hasLlm || process.env.CALL_MOCK === '1') return;
  const t0 = Date.now();
  if (useOpenAi) {
    try {
      const u = await warmOpenAi(`${persona}\n\n${callHint()}`, userTools);
      log.info('warm.done', { ms: Date.now() - t0, cached: u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens ?? null });
    } catch (e) { log.info('warm.failed', { err: String(e?.message || e).slice(0, 120) }); }
    return;
  }
  try {
    const r = await client.messages.create({
      model: config.model, max_tokens: 1, system: callSystem(persona),
      messages: [{ role: 'user', content: '.' }],
      ...(userTools.length ? { tools: userTools } : {}),
    });
    log.info('warm.done', { ms: Date.now() - t0, cacheWrite: r.usage?.cache_creation_input_tokens ?? null, cacheRead: r.usage?.cache_read_input_tokens ?? null });
  } catch (e) { log.info('warm.failed', { err: String(e?.message || e).slice(0, 120) }); }
}

export async function replyOnce({ ctx, persona, userText, note = '', epochAt, epochNow, onDelta, onNotice, onTool, retracted = null }) {
  if (retracted?.()) return { text: '', hangup: false, aborted: true, failed: false };
  ctx.pushUser(userText);
  const messages = ctx.messages();
  if (note && messages.length) {
    const last = messages[messages.length - 1];
    messages[messages.length - 1] = { ...last, content: `（听感：${note}）\n${last.content}` };
  }

  // 桩回复：CALL_MOCK=1 时不调模型，照样能验状态机、打断、挂断（我们没钱/没 key 的那几天就靠它）
  if (process.env.CALL_MOCK === '1' || !hasLlm) {
    if (!hasLlm && process.env.CALL_MOCK !== '1') onNotice?.('no_key', useOpenAi ? '没配 OPENAI_API_KEY，先用桩回复' : '没配 ANTHROPIC_API_KEY，先用桩回复');
    const body = /挂|拜拜|再见/.test(userText) ? '嗯，那你先忙，拜拜。\n[挂断]' : '嗯，我在。你慢慢说，我听着。';
    let out = '';
    for (const ch of body) {
      if (epochNow() !== epochAt) break;
      out += ch; onDelta(ch);
      await new Promise((r) => setTimeout(r, 18));
    }
    const { text: clean, hangup } = splitHangup(out);
    if (clean && !retracted?.()) ctx.pushAssistant(clean);
    return { text: clean, hangup, aborted: epochNow() !== epochAt, failed: false };
  }

  const ac = new AbortController();
  let text = '';
  let cut = false;
  let stalled = false;
  let dog = setTimeout(() => { if (!text) { stalled = true; ac.abort(); } }, STALL_MS);
  const emit = (delta) => {
    if (epochNow() !== epochAt) { ac.abort(); return; }
    if (cut) return;
    if (!text && dog) { clearTimeout(dog); dog = null; }
    text += delta;
    if (text.length >= MAX_REPLY_CHARS) { cut = true; ac.abort(); log.info('reply.capped', { chars: text.length }); }
    onDelta(delta);
  };

  const system = callSystem(persona);
  const convo = [...messages];
  try {
    if (useOpenAi) {
      // GPT 格式那条腿：时间直接拼在人格后面（这类接口多是自动前缀缓存，没有缓存点可分；时间放在最后，前面那段照样命中）
      await replyOpenAi({
        system: `${persona}\n\n${callHint()}`, messages: convo, tools: userTools, runTool, onText: emit, onTool,
        signal: ac.signal, stillMine: () => epochNow() === epochAt,
        onToolStart: () => { if (dog) { clearTimeout(dog); dog = null; } },
      });
    } else {
      // 工具循环：模型要调工具就执行、把结果塞回去再问，直到它不再调工具
      for (let round = 0; round < 6; round++) {
        const st = client.messages.stream({
          model: config.model, max_tokens: config.maxTokens, system, messages: convo,
          ...(userTools.length ? { tools: userTools } : {}),
        }, { signal: ac.signal });
        st.on('text', emit);
        const final = await st.finalMessage();
        if (final.stop_reason !== 'tool_use') break;
        // 调工具那段时间别让看门狗咬（一个工具可能要几十秒）
        if (dog) { clearTimeout(dog); dog = null; }
        convo.push({ role: 'assistant', content: final.content });
        const results = [];
        for (const b of final.content.filter((c) => c.type === 'tool_use')) {
          onTool?.('start', { id: b.id, name: b.name, input: b.input });
          let out; let ok = true;
          try { out = await runTool(b.name, b.input); } catch (e) { ok = false; out = `出错：${e?.message || e}`; }
          onTool?.('result', { id: b.id, name: b.name, ok });
          results.push({ type: 'tool_result', tool_use_id: b.id, content: String(out).slice(0, 4000), is_error: !ok });
        }
        convo.push({ role: 'user', content: results });
        if (epochNow() !== epochAt) break;
      }
    }
  } catch (err) {
    if (dog) { clearTimeout(dog); dog = null; }
    if (stalled) {
      log.info('reply.stalled', { after_ms: STALL_MS });
      onNotice?.('reply_stalled', `模型 ${STALL_MS / 1000} 秒没开口`);
      return { text: '', hangup: false, aborted: false, failed: true };
    }
    const aborted = ac.signal.aborted || /abort/i.test(err?.message || '');
    if (!aborted) {
      log.info('reply.error', { err: err?.message || String(err) });
      onNotice?.('reply_failed', /credit|billing|quota|limit/i.test(err?.message || '') ? '模型额度见底了，这句答不出来' : `这句没答上来：${String(err?.message || err).slice(0, 160)}`);
      return { text: '', hangup: false, aborted: false, failed: true };
    }
  }
  if (dog) { clearTimeout(dog); dog = null; }
  const { text: raw, hangup } = splitHangup(text);
  const clean = speakable(raw);
  if (clean && !retracted?.()) ctx.pushAssistant(clean);
  return { text: clean, hangup, aborted: epochNow() !== epochAt, failed: false };
}
