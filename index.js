// src/plugins/many-ai/index.js
// ManyBot AI plugin — responde, pesquisa e gerencia memória

import { doSearch }          from "./search.js";
import { memRead, memWrite, initMemory } from "./memory.js";
import { buildSystemPrompt } from "./prompt.js";

const histories = new Map();
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
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
}

async function callGroq(history, systemPrompt, apiKey) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model:    MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        ...history.slice(-MAX_HISTORY_SEND),
      ],
      max_tokens: MAX_TOKENS,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices[0].message.content.trim();
}

function parseReply(reply) {
  const searchMatch = reply.match(/^SEARCH\((.+)\)$/);
  if (searchMatch) return { type: "command", command: "SEARCH", arg: searchMatch[1] };

  const memReadMatch = reply.match(/^MEM_READ\((.+)\)$/);
  if (memReadMatch) return { type: "command", command: "MEM_READ", arg: memReadMatch[1] };

  const memWriteMatch = reply.match(/^MEM_WRITE\((.+)\)$/);
  if (memWriteMatch) return { type: "command", command: "MEM_WRITE", arg: memWriteMatch[1] };

  const msgMatch = reply.match(/^MSG:"([\s\S]+)"$/);
  if (msgMatch) {
    const value = msgMatch[1].trim();
    if (!value) return { type: "silent" };
    return { type: "msg", value };
  }

  if (reply && !reply.startsWith("OUT:")) return { type: "msg", value: reply };

  return { type: "silent" };
}

async function resolveReply(history, systemPrompt, ctx, t, maxIterations = 5) {
  const groqKey    = ctx.config.get("GROQ_API_KEY");
  const tavilyKey  = ctx.config.get("TAVILY_API_KEY");
  const serperKey  = ctx.config.get("SERPER_API_KEY");

  for (let i = 0; i < maxIterations; i++) {
    const raw = await callGroq(history, systemPrompt, groqKey);
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

async function shouldRespond(msg, ctx, t, prefix) {
  if (msg.is(prefix + "ai")) {
    ctx.log.info(t("logs.shouldRespond.mention"));
    return true;
  }

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
  const { msg } = ctx;
  const { t }   = ctx.i18n.createT(import.meta.url);
  const prefix  = ctx.config.get("CMD_PREFIX");
  const lang    = ctx.config.get("LANGUAGE", "pt");

  initMemory(ctx);

  const chatId  = ctx.chat.id;
  const history = getHistory(chatId);
  const now     = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);

  const mediaTypes = ["img", "sticker", "audio", "video", "document", "voice", "gif"];
  const msgType    = (msg.type || "").toLowerCase();
  if (mediaTypes.includes(msgType)) {
    if (await shouldRespond(msg, ctx, t, prefix)) {
      await msg.reply(t("logs.noMediaResponse"));
    }
    return;
  }

  const body = msg.body || "";

  if (body.trim().startsWith(prefix)) {
    const formatted = `command|${msg.senderName}|${now}|${body}`;
    history.push({ role: "system", content: formatted });
  } else {
    const chatType  = ctx.chat.isGroup ? "group" : "private";
    const formatted = `${chatType}|member|${msg.senderName}|${now}|${body}`;
    history.push({ role: "user", content: formatted });
  }
  trimHistory(history);

  if (!(await shouldRespond(msg, ctx, t, prefix))) return;

  const systemPrompt = buildSystemPrompt(lang);

  try {
    const reply = await resolveReply(history, systemPrompt, ctx, t);
    if (reply) {
      const sent = await msg.reply(reply);
      if (sent?.id) aiMessageIds.add(sent.id);
    }
  } catch (err) {
    ctx.log.error(`[many-ai] erro: ${err.message}`);
    await msg.reply(t("errors.generic"));
  }
}
