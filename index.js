import { doSearch }                          from "./search.js";
import { memRead, memWrite, initMemory }     from "./memory.js";
import { buildSystemPrompt }                 from "./prompt.js";

const histories    = new Map();
const aiMessageIds = new Set();

const MAX_HISTORY      = 20;
const MAX_HISTORY_SEND = 10;
const MAX_TOKENS       = 150;
const MODEL            = "llama-3.3-70b-versatile";

function getHistory(chatId) {
  if (!histories.has(chatId)) histories.set(chatId, []);
  return histories.get(chatId);
}

function trimHistory(history) {
  if (history.length > MAX_HISTORY)
    history.splice(0, history.length - MAX_HISTORY);
}

async function callGroq(history, systemPrompt, apiKey) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method:  "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model:      MODEL,
      messages:   [{ role: "system", content: systemPrompt }, ...history.slice(-MAX_HISTORY_SEND)],
      max_tokens: MAX_TOKENS,
    }),
  });

  if (!res.ok) throw new Error(`Groq API error ${res.status}: ${await res.text()}`);
  return (await res.json()).choices[0].message.content.trim();
}

function parseReply(reply) {
  const search   = reply.match(/^SEARCH\((.+)\)$/);
  if (search)   return { type: "command", command: "SEARCH",    arg: search[1] };

  const memRead  = reply.match(/^MEM_READ\((.+)\)$/);
  if (memRead)  return { type: "command", command: "MEM_READ",  arg: memRead[1] };

  const memWrite = reply.match(/^MEM_WRITE\((.+)\)$/);
  if (memWrite) return { type: "command", command: "MEM_WRITE", arg: memWrite[1] };

  const msg = reply.match(/^MSG:"([\s\S]+)"$/);
  if (msg) {
    const value = msg[1].trim();
    return value ? { type: "msg", value } : { type: "silent" };
  }

  if (reply && !reply.startsWith("OUT:")) return { type: "msg", value: reply };
  return { type: "silent" };
}

async function resolveReply(history, systemPrompt, ctx, t, maxIterations = 5) {
  const groqKey   = ctx.config.get("GROQ_API_KEY");
  const tavilyKey = ctx.config.get("TAVILY_API_KEY");
  const serperKey = ctx.config.get("SERPER_API_KEY");

  for (let i = 0; i < maxIterations; i++) {
    const raw    = await callGroq(history, systemPrompt, groqKey);
    history.push({ role: "assistant", content: raw });
    trimHistory(history);

    const parsed = parseReply(raw);
    if (parsed.type === "msg")    return parsed.value;
    if (parsed.type === "silent") return null;

    if (parsed.type === "command") {
      let result;

      if (parsed.command === "SEARCH") {
        result = await doSearch(parsed.arg, { TAVILY_API_KEY: tavilyKey, SERPER_API_KEY: serperKey });

      } else if (parsed.command === "MEM_READ") {
        try {
          result = await memRead(parsed.arg);
        } catch (err) {
          ctx.log.error(err.message);
          result = t("errors.memoryReadError");
        }

      } else if (parsed.command === "MEM_WRITE") {
        try {
          await memWrite(parsed.arg);
          history.push({ role: "user", content: `[${t("memory.saved")}]` });
        } catch (err) {
          ctx.log.error(err.message);
          history.push({ role: "user", content: `[${t("errors.memoryWriteError", { error: err.message })}]` });
        }
        continue;
      }

      history.push({ role: "user", content: `[Resultado da busca]: ${result}` });
    }
  }

  ctx.log.warn(t("logs.maxIterationsReached"));
  return null;
}

async function shouldRespond(msg, ctx, t, triggers) {
  if (msg.is("ai") || triggers.some(tr => msg.body.trim().toLowerCase().includes(tr.toLowerCase()))) return true;

  if (msg.hasReply) {
    try {
      const quoted = await msg.getReply();
      if (aiMessageIds.has(quoted.id)) return true;
    } catch {
      ctx.log.info(t("logs.shouldRespond.quotedError"));
    }
  }

  return false;
}

export default async function (ctx) {
  const { msg, chat, config, i18n, log } = ctx;
  const { t }      = i18n.createT(import.meta.url);
  const lang       = config.get("LANGUAGE", "pt");
  const triggers   = config.get("MANYAI_TRIGGERS", []);

  initMemory(ctx);

  const chatId  = chat.id;
  const history = getHistory(chatId);
  const now     = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);

  const mediaTypes = ["img", "sticker", "audio", "video", "document", "voice", "gif"];
  if (mediaTypes.includes((msg.type || "").toLowerCase())) {
    if (await shouldRespond(msg, ctx, t, triggers))
      await msg.reply.text(t("logs.noMediaResponse"));
    return;
  }

  const body = msg.body || "";
  if (body.trim().startsWith(config.get("CMD_PREFIX"))) {
    history.push({ role: "system", content: `command|${msg.senderName}|${now}|${body}` });
  } else {
    const chatType = chat.isGroup ? "group" : "private";
    history.push({ role: "user", content: `${chatType}|member|${msg.senderName}|${now}|${body}` });
  }
  trimHistory(history);

  if (!(await shouldRespond(msg, ctx, t, triggers))) return;

  const systemPrompt = buildSystemPrompt(lang);

  try {
    const reply = await resolveReply(history, systemPrompt, ctx, t);
    if (reply) {
      const sent = await msg.reply.text(reply);
      if (sent?.id) aiMessageIds.add(sent.id);
    }
  } catch (err) {
    log.error(`[many-ai] erro: ${err.message}`);
    await msg.reply.text(t("errors.generic"));
  }
}
