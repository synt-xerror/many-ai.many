import { doSearch }                      from "./search.js";
import { memRead, memWrite, initMemory } from "./memory.js";
import { buildSystemPrompt }             from "./prompt.js";
import { safeCalc, getGroupInfo }        from "./tools.js";
import { getKeyPool, withKeyFailover }   from "./apiKeys.js";
import { initHistory, indexMessage, searchHistory } from "./history.js";
import { isTooShortToConsider, looksLikeUnansweredQuestion, looksLikeHelpRequest } from "./intervention.js";
import { transcribeCurrentMessage, transcribeQuotedMessage } from "./voice.js";
import { setupAiDisclaimer, maybeSendAiDisclaimer } from "./ai-disclaimer.js";
import { listStickers, buildStickerBuffer } from "./stickers.js";

const histories       = new Map();
const aiMessageIds    = new Set();
const lastActivityAt  = new Map(); // chatId -> timestamp of the most recent message, used to detect "did anyone reply while we were waiting"
const chatLocks       = new Map(); // chatId -> promise chain, serializes AI resolution per chat (trigger + passive can otherwise race on the same history array)
const pendingContinuation = new Map(); // chatId -> { senderName, expiresAt } — lets the next message from the SAME sender keep talking to the bot without repeating the trigger, as long as nobody else spoke first
const MAX_TRACKED_AI_MESSAGES = 500; // avoids unbounded growth on long-uptime bots
const MAX_TRACKED_CHATS       = 500; // caps the number of distinct chats kept in memory
const CONTINUATION_WINDOW_MS  = 3 * 60_000; // how long a "same sender keeps talking to the bot" window stays open

/**
 * Runs fn() only after any AI resolution already in flight for this chat has
 * finished — a direct trigger and a passive check landing at the same time
 * would otherwise both mutate the shared history array concurrently.
 */
function withChatLock(chatId, fn) {
  const prev = chatLocks.get(chatId) || Promise.resolve();
  const next = prev.then(fn, fn);
  chatLocks.set(chatId, next.then(() => {}, () => {})); // chain continues regardless of fn's outcome
  return next;
}

/**
 * ctx.settings isn't fully documented — if its real shape ever differs from
 * what we assume here, this must fail back to the default instead of
 * throwing, or every single message in the chat would stop being processed.
 */
async function getSetting(ctx, key, defaultValue) {
  try {
    const value = await ctx.settings?.get(key, defaultValue);
    const resolved = value === undefined || value === null ? defaultValue : value;
    debugLog(ctx, `getSetting(${key}) = ${JSON.stringify(resolved)}`);
    return resolved;
  } catch (err) {
    ctx.log.error(`[many-ai] settings.get(${key}) failed, using default: ${err.message}`);
    return defaultValue;
  }
}

async function setSetting(ctx, key, value) {
  try {
    await ctx.settings?.set(key, value);
    debugLog(ctx, `setSetting(${key}) = ${JSON.stringify(value)} OK`);
    return true;
  } catch (err) {
    ctx.log.error(`[many-ai] settings.set(${key}) failed: ${err.message}`);
    return false;
  }
}

/**
 * Resolves the two sticker-related buildSystemPrompt inputs: whether the
 * feature is on for this chat (ctx.settings, default on) and, only if so,
 * the current manifest (ctx.storage) so the model always sees an up to date
 * list without needing a restart when someone adds a new sticker.
 */
async function getStickerPromptExtras(ctx) {
  const stickersEnabled = await getSetting(ctx, "stickersEnabled", true);
  const stickers = stickersEnabled ? await listStickers(ctx) : [];
  if (stickersEnabled) {
    console.log(`[many-ai:debug] stickers dir="${ctx.storage.resolve("stickers")}" found=${stickers.length}`);
  }
  return { stickersEnabled, stickers };
}

/** Verbose step-by-step tracing for testing — always on, remove calls manually when done. */
function debugLog(ctx, ...args) {
  ctx.log.info("[many-ai:debug]", ...args);
}

function preview(text, len = 100) {
  const s = String(text ?? "");
  return s.length > len ? s.slice(0, len) + "…" : s;
}

function trackAiMessage(id) {
  if (!id) return;
  aiMessageIds.add(id);
  if (aiMessageIds.size > MAX_TRACKED_AI_MESSAGES) {
    aiMessageIds.delete(aiMessageIds.values().next().value); // drop the oldest
  }
}

const MAX_HISTORY      = 20;
const MAX_HISTORY_SEND = 10;
const DEFAULT_MAX_TOKENS = 300;
const MAX_QUOTED_LEN     = 200;

const KNOWN_COMMANDS = ["SEARCH", "SEARCH_HISTORY", "MEM_READ", "MEM_WRITE", "CALC", "GROUP_INFO", "STICKER"];

function buildWordTriggerRE(words) {
  if (!words?.length) return null;
  return new RegExp(`\\b(${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
}

function getHistory(chatId) {
  if (!histories.has(chatId)) {
    if (histories.size >= MAX_TRACKED_CHATS) {
      histories.delete(histories.keys().next().value); // drop the oldest tracked chat
    }
    histories.set(chatId, []);
  }
  return histories.get(chatId);
}

/**
 * Trims down to MAX_HISTORY entries, but never removes the entry currently
 * flagged as "current" — that would let the model silently lose track of
 * the message it's actually answering mid-resolution. Always removes the
 * oldest *non-current* entry first.
 */
function trimHistory(history) {
  while (history.length > MAX_HISTORY) {
    const idx = history.findIndex(h => !(h.kind === "chat" && h.current));
    if (idx === -1) break; // everything left is the current message — nothing safe to drop
    history.splice(idx, 1);
  }
}

/**
 * Adds a history entry and, if it's a real chat message, unmarks any
 * previous entry as "current" — only the newest one carries that flag.
 * This is what guarantees the model always knows which message it needs
 * to answer, even after several tool-call iterations.
 */
export function pushEntry(history, entry) {
  if (entry.kind === "chat" && entry.current) {
    for (const h of history) if (h.kind === "chat") h.current = false;
  }
  history.push(entry);
  trimHistory(history);
}

function timeLabel() {
  return new Date().toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
}

function formatChatEntry({ isGroup, chatName, senderName, body, quoted }) {
  const location  = isGroup ? `Group "${chatName}"` : "Private";
  const quotedTag = quoted ? ` [replying to ${quoted.senderLabel}: "${quoted.text}"]` : "";
  return `[${location}] ${senderName} (${timeLabel()}):${quotedTag} ${body}`;
}

function formatCommandEntry({ senderName, body }) {
  return `[Command] ${senderName} (${timeLabel()}): ${body}`;
}

// Pulls plain text out of a raw WhatsApp message proto — same shape ctx.msg
// uses internally, but plugins only get the raw object back from
// msg.getReply(), not a helper to read it.
function quotedMsgBody(raw) {
  const m = raw?.message;
  if (!m) return "";
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    ""
  );
}

/**
 * Builds the "[replying to X: "..."]" info shown to the model when the
 * current message is a reply/quote. This is what was previously missing —
 * the AI never actually saw what a reply was replying to, only its own new
 * text, which is why it looked like it "didn't understand" replies.
 */
async function buildQuotedInfo(quotedRaw, msg, ctx, isGroup) {
  let text = quotedMsgBody(quotedRaw).trim();
  let isTranscript = false;
  let transcriptFailed = false;

  // No text on the quoted message but it's a voice note — transcribe it on
  // demand. This is an explicit ask ("what did she say in that audio?"),
  // so it always runs regardless of the background transcribeAudio setting.
  if (!text && quotedRaw.message?.audioMessage) {
    const keys = getKeyPool(ctx);
    if (keys.length) {
      const model = ctx.config.get("AI_TRANSCRIBE_MODEL", "whisper-large-v3-turbo");
      text = (await transcribeQuotedMessage(quotedRaw, ctx, keys, model)).trim();
      isTranscript = true;
    }
    transcriptFailed = !text; // no keys configured, or transcription attempt came back empty
  }
  if (!text && !transcriptFailed) return null; // genuinely nothing to show (other media, no audio)

  const quotedId = quotedRaw.key?.id;
  let senderLabel;

  if (quotedId && aiMessageIds.has(quotedId)) {
    senderLabel = "you (the AI)";
  } else if (isGroup && quotedRaw.key?.participant) {
    try {
      const contact = await ctx.contacts.get(quotedRaw.key.participant);
      senderLabel = contact?.pushname || contact?.name || quotedRaw.key.participant.split("@")[0];
    } catch {
      senderLabel = quotedRaw.key.participant.split("@")[0];
    }
  } else {
    // DM (or a group quote missing the participant field): the only other
    // party in a 1:1 chat is the current sender themself.
    senderLabel = msg.senderName;
  }

  return {
    senderLabel,
    text: transcriptFailed
      ? "[voice note — couldn't transcribe it, tell the user instead of ignoring the request]"
      : (isTranscript ? "(voice note, transcribed) " : "") + (text.length > MAX_QUOTED_LEN ? text.slice(0, MAX_QUOTED_LEN) + "…" : text),
  };
}

/**
 * Builds the message list sent to the API, applying the current/old tags on
 * top of the already-stored content (we never bake the tag into the history
 * itself, so it's always correct at send time regardless of how many tool
 * iterations happened since).
 */
export function toApiMessages(history, systemPrompt) {
  const messages = history.slice(-MAX_HISTORY_SEND).map(entry => {
    if (entry.kind !== "chat") return { role: entry.role, content: entry.content };
    const tag = entry.current
      ? "[CURRENT MESSAGE — this is the one you should answer]"
      : "[OLD MESSAGE — background context only, don't reply to it unless it's quoted or truly needed]";
    return { role: entry.role, content: `${tag}\n${entry.content}` };
  });
  return [{ role: "system", content: systemPrompt }, ...messages];
}

// Some Groq models (e.g. gpt-oss) support native function-calling and will
// sometimes attempt it even though we only ask for plain-text "COMMAND(arg)"
// output and never declare a `tools` array. Groq then rejects the whole
// request with 400 tool_use_failed. Rather than surfacing that as an error,
// pull the attempted call out of failed_generation and hand it back in the
// same plain-text shape parseReply() already understands, so the tool still
// runs normally.
function recoverNativeToolCall(errBody) {
  let parsed;
  try { parsed = JSON.parse(errBody); } catch { return null; }
  if (parsed?.error?.code !== "tool_use_failed") return null;

  let gen;
  try { gen = JSON.parse(parsed.error.failed_generation); } catch { return null; }
  const name = gen?.name;
  if (!name) return null;

  const argValue = Object.values(gen.arguments || {})[0] ?? "";
  return `${name}(${argValue})`;
}

async function callGroq(history, systemPrompt, apiKey, MODEL, maxTokens) {
  let res;
  try {
    res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model:      MODEL,
        messages:   toApiMessages(history, systemPrompt),
        max_tokens: maxTokens,
      }),
    });
  } catch (netErr) {
    const e = new Error(`network error: ${netErr.message}`);
    e.isTransient = true;
    throw e;
  }

  if (!res.ok) {
    const body = await res.text();

    if (res.status === 429) {
      let retryIn = null;
      try {
        const { error } = JSON.parse(body);
        retryIn = error?.message?.match(/try again in (\S+)\./i)?.[1] ?? null;
      } catch { /* fall through to generic error below */ }
      const e = new Error("rate_limit");
      e.isRateLimit = true;
      e.retryIn = retryIn;
      throw e;
    }
    if (res.status === 401 || res.status === 403) {
      const e = new Error(`key rejected (${res.status})`);
      e.isInvalidKey = true;
      throw e;
    }
    if (res.status === 400) {
      const recovered = recoverNativeToolCall(body);
      if (recovered) return recovered;
    }
    if (res.status >= 500) {
      const e = new Error(`Groq API error ${res.status}`);
      e.isTransient = true;
      throw e;
    }
    throw new Error(`Groq API error ${res.status}: ${body}`);
  }
  const data = await res.json();
  const choice = data.choices[0];
  const content = (choice.message.content || "").trim();
  if (!content) {
    console.log(`[many-ai:debug] empty model content, finish_reason="${choice.finish_reason}" native_tool_calls=${JSON.stringify(choice.message.tool_calls || null)}`);
  }
  return content;
}


/**
 * Parses the model's reply. Much simpler format than earlier versions:
 * - "SILENT" → no reply at all.
 * - "COMMAND(args)" → call the matching tool.
 * - anything else → the final reply text, sent as-is.
 * Command matching is case-insensitive since small models occasionally
 * drift on casing (e.g. "search(...)" instead of "SEARCH(...)").
 */
export function parseReply(reply) {
  const text = (reply || "").trim();
  if (!text) return { type: "silent" };
  if (/^SILENT$/i.test(text)) return { type: "silent" };

  // Whole message is exactly one call — arg may itself span multiple lines.
  const fullCall = text.match(/^([A-Za-z_]+)\(([\s\S]*)\)$/);
  if (fullCall && KNOWN_COMMANDS.includes(fullCall[1].toUpperCase())) {
    return { type: "command", command: fullCall[1].toUpperCase(), arg: fullCall[2].trim() };
  }

  // A call on its own first line, followed by more text — e.g. the model
  // sends a sticker and adds a short reply right after it. Split it instead
  // of leaking the raw "STICKER(...)" syntax to the user as plain text.
  const newlineIdx = text.indexOf("\n");
  if (newlineIdx !== -1) {
    const firstLine = text.slice(0, newlineIdx).trim();
    const lineCall = firstLine.match(/^([A-Za-z_]+)\((.*)\)$/);
    if (lineCall && KNOWN_COMMANDS.includes(lineCall[1].toUpperCase())) {
      const trailing = text.slice(newlineIdx + 1).trim();
      return { type: "command", command: lineCall[1].toUpperCase(), arg: lineCall[2].trim(), trailing: trailing || null };
    }
  }

  // Last resort: never let a raw TOOL(...) call leak into the chat as text,
  // even if the model embedded it somewhere other than its own first line
  // (that's a prompt-compliance slip, not something the user should see).
  const stripped = text
    .split("\n")
    .filter(line => {
      const m = line.trim().match(/^([A-Za-z_]+)\((.*)\)$/);
      return !(m && KNOWN_COMMANDS.includes(m[1].toUpperCase()));
    })
    .join("\n")
    .trim();

  return { type: "msg", value: stripped || text };
}

async function runTool(command, arg, ctx, chatId, t, opts) {
  switch (command) {
    case "SEARCH":
      return doSearch(arg, { TAVILY_API_KEY: opts.tavilyKey, SERPER_API_KEY: opts.serperKey, log: ctx.log });

    case "SEARCH_HISTORY":
      return searchHistory(chatId, arg);

    case "MEM_READ":
      return memRead(chatId, arg);

    case "MEM_WRITE":
      await memWrite(chatId, arg);
      return t("memory.saved");

    case "CALC":
      return String(safeCalc(arg));

    case "GROUP_INFO": {
      // Raw data, not a pre-written sentence — the model reads this and
      // composes its own reply, same as it would with a SEARCH result.
      const info = await getGroupInfo(ctx);
      return JSON.stringify(info);
    }

    case "STICKER": {
      try {
        const buffer = await buildStickerBuffer(ctx, arg, { pack: opts.stickerPack, author: opts.stickerAuthor });
        await ctx.send.sticker(buffer).rawPromise;
        return t("tools.stickerSent");
      } catch (err) {
        if (err.message === "sticker-not-found") return t("tools.stickerNotFound", { name: arg });
        throw err;
      }
    }

    default:
      // Shouldn't happen (parseReply only lets KNOWN_COMMANDS through), but
      // keeps this from silently returning undefined if the two ever drift.
      return t("errors.toolError", { tool: command });
  }
}

async function resolveReply(history, systemPrompt, ctx, t, MODEL, chatId, maxIterations = 5) {
  const keys = getKeyPool(ctx);
  if (!keys.length) return t("errors.missingApiKey");

  const opts = {
    tavilyKey: ctx.config.get("TAVILY_API_KEY"),
    serperKey: ctx.config.get("SERPER_API_KEY"),
    stickerPack: ctx.config.get("STICKER_PACK_NAME", "Many AI"),
    stickerAuthor: ctx.config.get("STICKER_AUTHOR_NAME", "ManyBot"),
  };
  const maxTokens = Number(ctx.config.get("MANYAI_MAX_TOKENS", DEFAULT_MAX_TOKENS)) || DEFAULT_MAX_TOKENS;

  for (let i = 0; i < maxIterations; i++) {
    let raw;
    try {
      raw = await withKeyFailover(keys, (key) => callGroq(history, systemPrompt, key, MODEL, maxTokens), ctx.log);
    } catch (err) {
      if (err.isRateLimit || err.isInvalidKey || err.isTransient || err.isMissingKey) return t("errors.allKeysRateLimit");
      throw err;
    }
    debugLog(ctx, `model raw output (iter ${i}): "${preview(raw)}"`);

    pushEntry(history, { role: "assistant", kind: "tool", content: raw });

    const parsed = parseReply(raw);
    if (parsed.type === "msg")    { debugLog(ctx, "-> final text reply"); return parsed.value; }
    if (parsed.type === "silent") { debugLog(ctx, "-> SILENT"); return null; }

    debugLog(ctx, `-> tool call: ${parsed.command}(${preview(parsed.arg, 60)})`);
    let result;
    try {
      result = await runTool(parsed.command, parsed.arg, ctx, chatId, t, opts);
      debugLog(ctx, `-> tool result: "${preview(result, 150)}"`);
    } catch (err) {
      ctx.log.error(`[many-ai] error in ${parsed.command}: ${err.message}`);
      result = t("errors.toolError", { tool: parsed.command });
    }

    pushEntry(history, { role: "user", kind: "tool", content: `[${t("tools.resultLabel")}: ${parsed.command}] ${result}` });

    // A sticker call is a side effect (already sent) rather than something
    // the model needs the result of before continuing — if it also wrote a
    // reply right after the call on the same turn, that's the final answer,
    // no need to spend another API call asking for it again.
    if (parsed.command === "STICKER" && parsed.trailing) {
      debugLog(ctx, "-> sticker + trailing text, using trailing as final reply");
      return parsed.trailing;
    }
  }

  ctx.log.warn(t("logs.maxIterationsReached"));
  return null;
}

// Returns the trigger kind ("command" | "word" | "literal" | "quote" |
// "continuation") or null. "command" is an explicit, deliberate address
// (e.g. "!ai ..."); the other kinds are ambient (name mentioned, quoted, or
// a same-sender follow-up right after the bot replied) and stay eligible
// for SILENT — only "command" disables it in the prompt.
function getTriggerKind(msg, quotedRaw, triggers, wordRE, commandName, chatId) {
  if (commandName && msg.is(commandName)) return "command";
  if (wordRE?.test(msg.body)) return "word";
  if (triggers.some(tr => msg.body.trim().toLowerCase().includes(tr.toLowerCase()))) return "literal";

  const quotedId = quotedRaw?.key?.id;
  if (quotedId && aiMessageIds.has(quotedId)) return "quote"; // quoting the AI's own message

  const pending = pendingContinuation.get(chatId);
  if (pending && pending.senderName === msg.senderName && Date.now() < pending.expiresAt) return "continuation";

  return null;
}

function shouldRespond(msg, quotedRaw, triggers, wordRE, commandName, chatId) {
  return !!getTriggerKind(msg, quotedRaw, triggers, wordRE, commandName, chatId);
}

/** Opens (or refreshes) the continuation window right after the bot actually sends a reply. */
function markContinuation(chatId, senderName) {
  pendingContinuation.set(chatId, { senderName, expiresAt: Date.now() + CONTINUATION_WINDOW_MS });
}

/**
 * Deterministic, no-AI-call settings command — this must work even if the
 * AI is disabled for the chat (it's the only way to turn it back on), and
 * runs before anything else in the handler. In groups, only admins can
 * change settings (anyone can check status); in DMs, the one user can.
 */
async function handleSettingsCommand(ctx, args, t) {
  const sub = (args[0] || "status").toLowerCase();
  debugLog(ctx, `handleSettingsCommand: sub="${sub}" args=${JSON.stringify(args)}`);

  if (ctx.chat.isGroup && sub !== "status") {
    const isAdmin = await ctx.chat.isSenderAdmin();
    debugLog(ctx, `handleSettingsCommand: isSenderAdmin=${isAdmin}`);
    if (!isAdmin) {
      await ctx.msg.reply.text(t("settings.adminOnly"));
      return;
    }
  }

  if (sub === "off") {
    const ok = await setSetting(ctx, "enabled", false);
    await ctx.msg.reply.text(ok ? t("settings.disabled") : t("settings.saveError"));
    return;
  }
  if (sub === "on") {
    const ok = await setSetting(ctx, "enabled", true);
    await ctx.msg.reply.text(ok ? t("settings.enabled") : t("settings.saveError"));
    return;
  }
  if (sub === "intervention" || sub === "intervencao" || sub === "intervenção") {
    const state = (args[1] || "").toLowerCase();
    if (state === "on") {
      const ok = await setSetting(ctx, "passiveIntervention", true);
      await ctx.msg.reply.text(ok ? t("settings.interventionOn") : t("settings.saveError"));
    } else if (state === "off") {
      const ok = await setSetting(ctx, "passiveIntervention", false);
      await ctx.msg.reply.text(ok ? t("settings.interventionOff") : t("settings.saveError"));
    } else {
      await ctx.msg.reply.text(t("settings.interventionUsage"));
    }
    return;
  }
  if (sub === "transcribe" || sub === "transcricao" || sub === "transcrição") {
    const state = (args[1] || "").toLowerCase();
    if (state === "on") {
      const ok = await setSetting(ctx, "transcribeAudio", true);
      await ctx.msg.reply.text(ok ? t("settings.transcribeOn") : t("settings.saveError"));
    } else if (state === "off") {
      const ok = await setSetting(ctx, "transcribeAudio", false);
      await ctx.msg.reply.text(ok ? t("settings.transcribeOff") : t("settings.saveError"));
    } else {
      await ctx.msg.reply.text(t("settings.transcribeUsage"));
    }
    return;
  }

  if (sub === "sticker" || sub === "stickers" || sub === "figurinha" || sub === "figurinhas") {
    const state = (args[1] || "").toLowerCase();
    if (state === "on") {
      const ok = await setSetting(ctx, "stickersEnabled", true);
      await ctx.msg.reply.text(ok ? t("settings.stickerOn") : t("settings.saveError"));
    } else if (state === "off") {
      const ok = await setSetting(ctx, "stickersEnabled", false);
      await ctx.msg.reply.text(ok ? t("settings.stickerOff") : t("settings.saveError"));
    } else {
      await ctx.msg.reply.text(t("settings.stickerUsage"));
    }
    return;
  }

  const enabled      = await getSetting(ctx, "enabled", true);
  const intervention = await getSetting(ctx, "passiveIntervention", true);
  const transcribe   = await getSetting(ctx, "transcribeAudio", true);
  const stickerOn    = await getSetting(ctx, "stickersEnabled", true);
  await ctx.msg.reply.text(t("settings.status", {
    enabled:      enabled      ? t("settings.yes") : t("settings.no"),
    intervention: intervention ? t("settings.yes") : t("settings.no"),
    transcribe:   transcribe   ? t("settings.yes") : t("settings.no"),
    sticker:      stickerOn    ? t("settings.yes") : t("settings.no"),
  }));
}

/**
 * Runs the actual "should I say something" AI check — same resolveReply
 * loop used for direct triggers (same tools, same SILENT contract), just
 * with an extra system-prompt note making it clear nobody called the bot
 * and it should default to staying quiet. Uses a separate (usually
 * cheaper/faster) model, since this can run on many more messages than a
 * direct trigger ever would.
 */
async function runPassiveCheck(ctx, chatId, history, t, senderName, { dm = false } = {}) {
  // Re-check here, not just at the call site — a pending setTimeout could
  // fire after the setting was flipped off in the meantime.
  const passiveOn = await getSetting(ctx, "passiveIntervention", true);
  if (!passiveOn) { debugLog(ctx, "runPassiveCheck: intervention turned off mid-flight, aborting"); return; }

  const { config } = ctx;
  const lang         = config.get("LANGUAGE", "pt");
  const passiveModel = config.get("AI_PASSIVE_MODEL", "llama-3.1-8b-instant");
  debugLog(ctx, `runPassiveCheck: calling model ${passiveModel} (dm=${dm})`);

  const { stickersEnabled, stickers } = await getStickerPromptExtras(ctx);
  const basePrompt = buildSystemPrompt({
    name: config.get("AI_NAME", ""),
    personality: config.get("AI_PERSONALITY", ""),
    purpose: config.get("AI_PURPOSE", ""),
    extraInstructions: config.get("AI_EXTRA_INSTRUCTIONS", ""),
    language: lang,
    model: passiveModel,
    settingsCommand: config.get("MANYAI_SETTINGS_COMMAND", "ai-settings"),
    cmdPrefix: config.get("CMD_PREFIX", "!"),
    emojis: config.get("AI_EMOJIS", false),
    replyLength: config.get("AI_REPLY_LENGTH", "short"),
    stickersEnabled,
    stickers,
  });

  const passiveNote = dm
    ? (lang === "pt"
        ? "\n[CONVERSA PRIVADA]\nÉ óbvio que esta mensagem é pra você — é 1:1, não precisa do seu nome. Mesmo assim, só responda se perceber que a pessoa está genuinamente travada e não vai conseguir prosseguir sem sua ajuda (pediu algo específico, bateu num erro, está claramente perdida). Coisas simples — erro de digitação, comentário curto, algo que um corretor automático ou comando de ajuda de outro plugin já resolveria — normalmente NÃO precisam de você. Na dúvida, fique em silêncio — responda exatamente SILENT."
        : "\n[PRIVATE CHAT]\nIt's obvious this message is meant for you — it's 1:1, no name needed. Still, only respond if you can tell the person is genuinely stuck and won't be able to proceed without your help (asked for something specific, hit an error, is clearly lost). Simple things — a typo, a short comment, anything a spellchecker or another plugin's help command would already cover — usually don't need you. When in doubt, stay silent — reply exactly SILENT.")
    : (lang === "pt"
        ? "\n[MODO PASSIVO]\nEsta mensagem NÃO foi endereçada a você — ninguém te chamou. Só responda se: (a) for uma pergunta clara feita ao grupo que ficou sem resposta, (b) alguém estiver claramente pedindo ajuda mesmo sem te citar, ou (c) houver um erro técnico/factual que valha a pena corrigir. Na dúvida, fique em silêncio — responda exatamente SILENT na grande maioria dos casos."
        : "\n[PASSIVE MODE]\nThis message was NOT addressed to you — nobody called you. Only respond if: (a) it's a clear question to the group left unanswered, (b) someone is clearly asking for help even without mentioning you, or (c) there's a technical/factual error worth correcting. When in doubt, stay silent — reply exactly SILENT in the vast majority of cases.");

  try {
    // Resolves against a COPY of the shared history: a passive check makes
    // several "SILENT" no-op checks for every one that actually says
    // something, and none of that back-and-forth (nor any tool calls along
    // the way) should pollute the real conversation history that future
    // prompts are built from. Only an actual contribution gets recorded back.
    const scratch = history.slice();
    const reply = await withChatLock(chatId, () => resolveReply(scratch, basePrompt + passiveNote, ctx, t, passiveModel, chatId, 3));
    if (!reply) { debugLog(ctx, "runPassiveCheck: result = SILENT"); return; }

    debugLog(ctx, `runPassiveCheck: result = REPLY "${preview(reply)}"`);
    pushEntry(history, { role: "assistant", kind: "tool", content: reply });
    const handle  = ctx.send.text(reply); // unprompted — nothing to quote
    const rawSent = await handle.rawPromise;
    trackAiMessage(rawSent?.key?.id);
    if (senderName) markContinuation(chatId, senderName);
  } catch (err) {
    ctx.log.error(`[many-ai] passive intervention error: ${err.message}`);
    // stay silent on error — never surface an error for something nobody asked for
  }
}

/**
 * DM counterpart to maybeIntervenePassively: since a 1:1 chat is already
 * "addressed" to the bot in spirit, this skips the group's unanswered-
 * question wait timer and just asks the model directly — the passiveNote
 * (dm: true) is what keeps it from replying to every little thing.
 */
async function maybeInterveneInDM(ctx, chatId, history, body, t, senderName) {
  const passiveOn = await getSetting(ctx, "passiveIntervention", true);
  if (!passiveOn || isTooShortToConsider(body)) {
    debugLog(ctx, `maybeInterveneInDM: skipped (passiveOn=${passiveOn}, tooShort=${isTooShortToConsider(body)})`);
    return;
  }
  debugLog(ctx, "maybeInterveneInDM: checking now");
  await runPassiveCheck(ctx, chatId, history, t, senderName, { dm: true });
}

/**
 * Decides whether a non-triggering group message is worth a passive-mode
 * AI check at all. Cheap heuristics only — they exist purely to avoid
 * spending an API call on every single message in an active group.
 */
async function maybeIntervenePassively(ctx, chatId, history, body, t, senderName) {
  const passiveOn = await getSetting(ctx, "passiveIntervention", true);
  if (!passiveOn || isTooShortToConsider(body)) {
    debugLog(ctx, `maybeIntervenePassively: skipped (passiveOn=${passiveOn}, tooShort=${isTooShortToConsider(body)})`);
    return;
  }

  const lang = ctx.config.get("LANGUAGE", "pt");

  if (looksLikeUnansweredQuestion(body)) {
    const waitMinutes = Number(ctx.config.get("AI_INTERVENTION_WAIT_MINUTES", 1)) || 1;
    const snapshot = lastActivityAt.get(chatId);
    debugLog(ctx, `maybeIntervenePassively: looks like an unanswered question, waiting ${waitMinutes}min`);
    setTimeout(() => {
      // Someone else spoke in this chat since — the question may already
      // be answered, or the moment has passed. Stay out of it.
      if (lastActivityAt.get(chatId) !== snapshot) { debugLog(ctx, "maybeIntervenePassively: chat had activity since, aborting delayed check"); return; }
      debugLog(ctx, "maybeIntervenePassively: running delayed check now");
      runPassiveCheck(ctx, chatId, history, t, senderName).catch(err => ctx.log.error(`[many-ai] delayed passive check error: ${err.message}`));
    }, waitMinutes * 60_000);
    return;
  }

  if (looksLikeHelpRequest(body, lang)) {
    debugLog(ctx, "maybeIntervenePassively: looks like a help request, checking now");
    await runPassiveCheck(ctx, chatId, history, t, senderName);
  } else {
    debugLog(ctx, "maybeIntervenePassively: no heuristic matched, staying quiet");
  }
}

export async function setup(ctx) {
  setupAiDisclaimer(ctx);

  const { t } = ctx.i18n.createT(import.meta.url);

  const keys = getKeyPool(ctx);
  if (!keys.length) {
    ctx.log.warn(t("logs.missingApiKeyWarning"));
  } else {
    ctx.log.success(t("logs.ready", { model: ctx.config.get("GROQ_MODEL", "llama-3.3-70b-versatile"), count: keys.length }));
  }
}

export const guardOptions = {
  timeout: false, // search + several chained AI calls can take longer than 2min
};

export default async function (ctx) {
  const { msg, chat, config } = ctx;
  const { t } = ctx.i18n.createT(import.meta.url);
  const chatId = chat.id;

  lastActivityAt.set(chatId, Date.now());
  const pendingCont = pendingContinuation.get(chatId);
  if (pendingCont && pendingCont.senderName !== msg.senderName) pendingContinuation.delete(chatId);
  debugLog(ctx, `msg from "${msg.senderName}" in ${chat.isGroup ? `group "${chat.name}"` : "DM"} | type=${msg.type} | body="${preview(msg.body, 80)}"`);

  const settingsCommand = config.get("MANYAI_SETTINGS_COMMAND", "ai-settings");
  if (settingsCommand && msg.is(settingsCommand)) {
    debugLog(ctx, `settings command: ${msg.args.join(" ") || "status"}`);
    await handleSettingsCommand(ctx, msg.args, t);
    return;
  }

  // Kill switch checked before anything else AI-related — indexing included.
  // Not everyone wants a chat listened to at all; "!ai-settings off" (above)
  // is the only thing that still works once this is set.
  const enabled = await getSetting(ctx, "enabled", true);
  if (!enabled) { debugLog(ctx, "AI disabled for this chat, skipping"); return; }

  const lang         = config.get("LANGUAGE", "pt");
  const aiName       = config.get("AI_NAME", "");
  const triggers     = config.get("MANYAI_TRIGGERS", []);
  const commandName  = config.get("MANYAI_COMMAND", "ai");
  const MODEL        = config.get("GROQ_MODEL", "llama-3.3-70b-versatile");

  // Word trigger defaults to the configured AI name (if any) — never a
  // hardcoded word. Explicitly set MANYAI_WORD_TRIGGERS to override.
  let wordTriggers = config.get("MANYAI_WORD_TRIGGERS", null);
  if (wordTriggers === null) wordTriggers = aiName ? [aiName] : [];
  const wordRE = buildWordTriggerRE(wordTriggers);

  const history = getHistory(chatId);

  // Resolve the quoted message (if any) once — used both to detect the
  // "quoting the AI's own message" trigger and to show the AI what the
  // current message is actually replying to.
  let quotedRaw = null;
  if (msg.hasReply) {
    try {
      quotedRaw = await msg.getReply();
      debugLog(ctx, `quoted message resolved: id=${quotedRaw?.key?.id || "?"} hasAudio=${!!quotedRaw?.message?.audioMessage}`);
    } catch (err) {
      ctx.log.info(t("logs.shouldRespond.quotedError", { error: err.message }));
    }
  }

  // getMsgType() returns: chat, image, video, audio, sticker, document, poll, unknown.
  const msgType = (msg.type || "").toLowerCase();
  const NON_TEXT_MEDIA = ["image", "video", "sticker", "document"];

  let body = msg.body || "";

  if (msgType === "audio") {
    const transcribeOn = await getSetting(ctx, "transcribeAudio", true);
    debugLog(ctx, `audio message, background transcribe=${transcribeOn}`);
    let transcript = "";
    if (transcribeOn) {
      const keys = getKeyPool(ctx);
      if (keys.length) {
        const transcribeModel = config.get("AI_TRANSCRIBE_MODEL", "whisper-large-v3-turbo");
        transcript = await transcribeCurrentMessage(msg, ctx, keys, transcribeModel);
        debugLog(ctx, `transcription result: ${transcript ? `"${preview(transcript)}"` : "(empty/failed)"}`);
      }
    }
    if (transcript) {
      body = `(voice note, transcribed) ${transcript}`;
      // falls through to the normal text pipeline below with the transcript as the body
    } else {
      if (shouldRespond(msg, quotedRaw, triggers, wordRE, commandName, chatId)) {
        await msg.reply.text(transcribeOn ? t("logs.transcriptionFailed") : t("logs.transcriptionDisabled"));
      }
      return;
    }
  } else if (NON_TEXT_MEDIA.includes(msgType)) {
    // No hardcoded "I can't see media" reply anymore — often it's just a
    // reaction/sticker the sender already knows won't be "seen". Label it
    // and fall through to the normal pipeline so the model judges, from
    // context, whether this genuinely needs a reply or should stay SILENT.
    body = `(${msgType} message, no caption)`;
  }

  const triggerKind = getTriggerKind(msg, quotedRaw, triggers, wordRE, commandName, chatId);
  const isTrigger = !!triggerKind;
  debugLog(ctx, `isTrigger=${isTrigger} triggerKind=${triggerKind}`);

  // A message is only treated as "another plugin's command" (background
  // context, ignored by the AI) if it ISN'T itself Many's own trigger —
  // otherwise "!ai question" would get stored as a command and the user's
  // actual question would end up tagged as something to ignore. These are
  // stored as role "user" (something that happened in the chat), not
  // "system" — a mid-conversation system-role message could be read by the
  // model as an instruction with special authority, which it isn't.
  const isOtherPluginCommand = body.trim().startsWith(config.get("CMD_PREFIX", "!")) && !isTrigger;

  if (isOtherPluginCommand) {
    debugLog(ctx, "stored as other-plugin command (background context, not archived to SEARCH_HISTORY)");
    pushEntry(history, { role: "user", kind: "command", current: false, content: formatCommandEntry({ senderName: msg.senderName, body }) });
  } else if (body.trim() || isTrigger) {
    // The `isTrigger` fallback covers the rare case of a genuine trigger
    // with no text of its own (e.g. quoting the AI's last message via a
    // poll) — otherwise an empty body (poll/unrecognized message types
    // that slip past the media checks above) isn't worth archiving at all.
    const quotedInfo = quotedRaw ? await buildQuotedInfo(quotedRaw, msg, ctx, chat.isGroup) : null;
    debugLog(ctx, `stored as chat message + indexed${quotedInfo ? ` (with quoted context: "${preview(quotedInfo.text, 60)}")` : ""}`);
    pushEntry(history, {
      role: "user",
      kind: "chat",
      current: true,
      content: formatChatEntry({ isGroup: chat.isGroup, chatName: chat.name, senderName: msg.senderName, body, quoted: quotedInfo }),
    });
    indexMessage(chatId, msg.senderName, body); // long-term archive, regardless of whether this triggers a reply
  }

  if (!isTrigger) {
    if (chat.isGroup && !isOtherPluginCommand) {
      debugLog(ctx, "not a trigger, considering passive intervention");
      maybeIntervenePassively(ctx, chatId, history, body, t, msg.senderName)
        .catch(err => ctx.log.error(`[many-ai] passive intervention error: ${err.message}`));
    } else if (!chat.isGroup && !isOtherPluginCommand) {
      debugLog(ctx, "not a trigger, considering DM passive engagement");
      maybeInterveneInDM(ctx, chatId, history, body, t, msg.senderName)
        .catch(err => ctx.log.error(`[many-ai] DM passive engagement error: ${err.message}`));
    } else {
      debugLog(ctx, "not a trigger, no passive intervention (other-plugin command)");
    }
    return;
  }

  const { stickersEnabled, stickers } = await getStickerPromptExtras(ctx);
  const systemPrompt = buildSystemPrompt({
    name: aiName,
    personality: config.get("AI_PERSONALITY", ""),
    purpose: config.get("AI_PURPOSE", ""),
    extraInstructions: config.get("AI_EXTRA_INSTRUCTIONS", ""),
    language: lang,
    model: MODEL,
    allowSilent: triggerKind !== "command",
    settingsCommand,
    cmdPrefix: config.get("CMD_PREFIX", "!"),
    emojis: config.get("AI_EMOJIS", false),
    replyLength: config.get("AI_REPLY_LENGTH", "short"),
    stickersEnabled,
    stickers,
  });

  try {
    const reply = await withChatLock(chatId, () => resolveReply(history, systemPrompt, ctx, t, MODEL, chatId));
    if (reply) {
      debugLog(ctx, `sending reply: "${preview(reply)}"`);
      const handle = msg.reply.text(reply);
      await maybeSendAiDisclaimer(ctx);
      const rawSent = await handle.rawPromise; // raw proto — the only place .key.id actually lives
      trackAiMessage(rawSent?.key?.id);
      // Only a "real" trigger (command/word/literal/quote) opens a fresh
      // continuation window — a continuation-triggered reply must NOT
      // extend it further, or the bot would keep answering the same
      // sender forever without ever being addressed again.
      if (triggerKind !== "continuation") markContinuation(chatId, msg.senderName);
    } else {
      debugLog(ctx, "trigger resolved to SILENT, not sending anything");
    }
  } catch (err) {
    ctx.log.error(`[many-ai] error: ${err.message}`);
    if (err.isRateLimit) {
      await msg.reply.text(err.retryIn ? t("errors.rateLimitWithRetry", { retryIn: err.retryIn }) : t("errors.rateLimit"));
    } else {
      await msg.reply.text(t("errors.generic"));
    }
  }
}
