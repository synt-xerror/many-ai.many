import { doSearch }                      from "./search.js";
import { memRead, memWrite, initMemory } from "./memory.js";
import { buildSystemPrompt }             from "./prompt.js";
import { safeCalc, getGroupInfo }        from "./tools.js";
import { getKeyPool, withKeyFailover }   from "./apiKeys.js";
import { callGroq, toApiMessages }       from "./groqClient.js";
import { initHistory, indexMessage, searchHistory } from "./history.js";
import { isTooShortToConsider, looksLikeUnansweredQuestion, looksLikeHelpRequest } from "./intervention.js";
import { transcribeCurrentMessage, transcribeQuotedMessage } from "./voice.js";
import { listStickers, buildStickerBuffer } from "./stickers.js";

const histories       = new Map();
const aiMessageIds    = new Set();
const lastActivityAt  = new Map(); // chatId -> timestamp of the most recent message, used to detect "did anyone reply while we were waiting"
const chatLocks       = new Map(); // chatId -> promise chain, serializes AI resolution per chat (trigger + passive can otherwise race on the same history array)
const pendingContinuation = new Map(); // chatId -> { senderName, expiresAt } — lets the next message from the SAME sender keep talking to the bot without repeating the trigger, as long as nobody else spoke first
const recentlySentByBot   = new Map(); // chatId -> Array<{ body, expiresAt }> — the platform can hand the bot's own outgoing message back as a normal incoming event, one per line since a multi-line reply is now sent as separate messages; used to recognize that and stop it from re-triggering itself (word/literal/continuation all matched on it in testing, causing a self-reply loop)
const MAX_TRACKED_AI_MESSAGES = 500; // avoids unbounded growth on long-uptime bots
const MAX_TRACKED_CHATS       = 500; // caps the number of distinct chats kept in memory
const CONTINUATION_WINDOW_MS  = 3 * 60_000; // how long a "same sender keeps talking to the bot" window stays open
const SELF_ECHO_WINDOW_MS     = 20_000; // how long we watch for the bot's own message to bounce back as an incoming event

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
    return resolved;
  } catch (err) {
    ctx.log.error(`[many-ai] settings.get(${key}) failed, using default: ${err.message}`);
    return defaultValue;
  }
}

async function setSetting(ctx, key, value) {
  try {
    await ctx.settings?.set(key, value);
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
  return { stickersEnabled, stickers };
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
const DEFAULT_MAX_TOKENS = 300;
const MAX_QUOTED_LEN     = 200;

const KNOWN_COMMANDS = ["SEARCH", "SEARCH_HISTORY", "MEM_READ", "MEM_WRITE", "CALC", "GROUP_INFO", "SEND_STICKER"];

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
async function buildQuotedInfo(quotedRaw, msg, ctx, isGroup, allowTranscribe) {
  let text = quotedMsgBody(quotedRaw).trim();
  let isTranscript = false;
  let transcriptFailed = false;

  // No text on the quoted message but it's a voice note — transcribe it on
  // demand, ONLY when the current message is itself addressed to the bot
  // (allowTranscribe). Otherwise this quote is just background chat between
  // other people and isn't worth spending a Whisper call on.
  if (!text && quotedRaw.message?.audioMessage) {
    if (allowTranscribe) {
      const keys = getKeyPool(ctx);
      if (keys.length) {
        const model = ctx.config.get("AI_TRANSCRIBE_MODEL", "whisper-large-v3-turbo");
        text = (await transcribeQuotedMessage(quotedRaw, ctx, keys, model)).trim();
        isTranscript = true;
      }
      transcriptFailed = !text; // no keys configured, or transcription attempt came back empty
    } else {
      text = "(voice note, no caption)"; // labeled, not transcribed — no API spend
    }
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
/**
 * Parses the model's reply. Much simpler format than earlier versions:
 * - "SILENT" → no reply at all.
 * - "COMMAND(args)" → call the matching tool.
 * - anything else → the final reply text, sent as-is.
 * Command matching is case-insensitive since small models occasionally
 * drift on casing (e.g. "search(...)" instead of "SEARCH(...)").
 */
export function parseReply(reply) {
  let text = (reply || "").trim();
  if (!text) return { type: "silent" };
  if (/^SILENT$/i.test(text)) return { type: "silent" };

  // Small models sometimes abbreviate SEND_STICKER as SEND — this is the
  // root cause of literal "SEND" leaking to users. Normalize before
  // matching so it resolves to the real command instead of falling
  // through to plain text.
  text = text.replace(/^SEND(?=\s|$)/i, "SEND_STICKER");
  if (/^SEND_STICKER$/i.test(text)) return { type: "silent" }; // bare "SEND", no target — nothing sane to do with it

  // The model occasionally reverts to the old "CMD(arg)" syntax despite the
  // prompt only teaching "CMD arg" now — normalize any full-line paren call
  // whose command name is real before matching, so a lapse in the model's
  // output doesn't leak the raw "SEND_STICKER(many-blueberry)" text to the
  // user. Only rewrites lines that are actually a known command; ordinary
  // text containing "word(word)" is left untouched.
  text = text.replace(/^([A-Za-z_]+)\(([\s\S]*?)\)[ \t]*$/gm, (whole, cmd, arg) =>
    KNOWN_COMMANDS.includes(cmd.toUpperCase()) ? `${cmd} ${arg}` : whole
  );

  // Simple syntax: COMMAND arg, space-separated, no parentheses — a model
  // that forgets a closing ")" used to leak the raw call as plain text to
  // the user (parseReply had nothing to match), which is exactly what
  // happened with "SEND_STICKER(many-blueberry" in testing. There's no
  // closing delimiter left to forget.
  // The command must be on the message's own first line; anything after
  // that line is a normal reply sent right after the tool call resolves
  // (e.g. sticker + short message). Args are taken from the rest of that
  // first line only — in practice every tool here (search query, sticker
  // name, calc expression, a memory fact) is a one-liner, so this doesn't
  // lose anything real, and it removes the ambiguity the old three-way
  // paren-matching logic had to resolve.
  const newlineIdx = text.indexOf("\n");
  const firstLine  = (newlineIdx === -1 ? text : text.slice(0, newlineIdx)).trim();
  const call = firstLine.match(/^([A-Za-z_]+)(?:[ \t]+(.*))?$/);

  if (call && KNOWN_COMMANDS.includes(call[1].toUpperCase())) {
    const trailing = newlineIdx === -1 ? null : text.slice(newlineIdx + 1).trim();
    return {
      type: "command",
      command: call[1].toUpperCase(),
      arg: (call[2] || "").trim(),
      trailing: trailing || null,
    };
  }

  // Reverse order: reply text first, SEND_STICKER call on its own last line
  // — e.g. "Oi!\nSEND_STICKER many-blueberry", the natural order a person
  // would send a message then react with a sticker. Only meaningful for
  // SEND_STICKER: it's the one tool whose result the model never needs
  // back (a side effect, not information to reason about), so the text
  // doesn't have to wait for it. A distinct type from "command" — the
  // caller sends the text FIRST, then fires the sticker, deliberately the
  // opposite send order from the "command"+trailing case above.
  const lines = text.split("\n");
  if (lines.length > 1) {
    const lastLine = lines[lines.length - 1].trim();
    const stickerCall = lastLine.match(/^SEND_STICKER(?:[ \t]+(.*))?$/i);
    const leading = lines.slice(0, -1).join("\n").trim();
    if (stickerCall && leading) {
      return { type: "textThenSticker", value: leading, stickerArg: (stickerCall[1] || "").trim() };
    }
  }

  // Last resort: never let a raw COMMAND call leak into the chat as text,
  // even if the model embedded it somewhere other than its own first line
  // (that's a prompt-compliance slip, not something the user should see).
  const stripped = text
    .split("\n")
    .filter(line => {
      const m = line.trim().match(/^([A-Za-z_]+)(?:[ \t]+.*)?$/);
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

    case "SEND_STICKER": {
      try {
        const buffer = await buildStickerBuffer(ctx, arg, { pack: opts.stickerPack, author: opts.stickerAuthor });
        const rawSent = await ctx.send.sticker(buffer).rawPromise;
        trackAiMessage(rawSent?.key?.id); // otherwise quoting the sticker itself never matches aiMessageIds
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

// TEMP DEBUG (remove after testing): mirrors prompt.js's FORCE_ANSWER — used
// only to flag the suspicious case of the model going SILENT on a trigger
// kind that was never supposed to offer that option.
const DEBUG_FORCE_ANSWER = new Set(["command", "quote"]);

// TEMP DEBUG: full chatId is a long JID, noisy in logs — just enough of it to
// tell chats apart while testing.
function shortChat(chatId) {
  return (chatId || "").split("@")[0].slice(-6);
}

function getToolOpts(ctx) {
  return {
    tavilyKey: ctx.config.get("TAVILY_API_KEY"),
    serperKey: ctx.config.get("SERPER_API_KEY"),
    stickerPack: ctx.config.get("STICKER_PACK_NAME", "Many AI"),
    stickerAuthor: ctx.config.get("STICKER_AUTHOR_NAME", "ManyBot"),
  };
}

/**
 * Runs the SEND_STICKER tool after the text reply has already gone out —
 * the "text first, sticker after" order (see parseReply's "textThenSticker"
 * case). Mirrors the tool-result bookkeeping resolveReply does for every
 * other tool call, so the history stays consistent regardless of which
 * order the model chose. Never throws — a failed sticker send here
 * shouldn't take down a reply the user already received.
 */
async function sendStickerAfterText(ctx, chatId, t, history, stickerArg) {
  try {
    const result = await runTool("SEND_STICKER", stickerArg, ctx, chatId, t, getToolOpts(ctx));
    pushEntry(history, { role: "user", kind: "tool", content: `[${t("tools.resultLabel")}: SEND_STICKER] ${result}` });
  } catch (err) {
    ctx.log.error(`[many-ai] error in SEND_STICKER (after text): ${err.message}`);
  }
}

async function resolveReply(history, systemPrompt, ctx, t, MODEL, chatId, maxIterations = 5, triggerKind = null) {
  const keys = getKeyPool(ctx);
  if (!keys.length) throw Object.assign(new Error("no_api_keys"), { isMissingKey: true });

  const opts = getToolOpts(ctx);
  const maxTokens = Number(ctx.config.get("MANYAI_MAX_TOKENS", DEFAULT_MAX_TOKENS)) || DEFAULT_MAX_TOKENS;
  const chatTag = `chat=…${shortChat(chatId)} trigger=${triggerKind ?? "none"}`;

  for (let i = 0; i < maxIterations; i++) {
    let raw;
    try {
      raw = await withKeyFailover(keys, (key) => callGroq(history, systemPrompt, key, MODEL, maxTokens), ctx.log);
    } catch (err) {
      //ctx.log.warn(`[many-ai:debug] ${chatTag} iter=${i + 1}/${maxIterations} groq call failed: ${err.message}`);
      throw err;
    }

    const parsed = parseReply(raw);

    if (!raw) {
      // Groq returned a genuinely empty completion (not the model choosing
      // SILENT) — don't record it in history, or it contaminates every
      // future call in this chat with a blank assistant turn and the model
      // starts repeating the pattern instead of recovering.
      //ctx.log.warn(`[many-ai:debug] ${chatTag} iter=${i + 1}/${maxIterations} empty completion from Groq, retrying without recording it`);
      continue;
    }

    pushEntry(history, { role: "assistant", kind: "tool", content: raw });

    if (parsed.type === "msg") return parsed.value;
    if (parsed.type === "silent") {
      if (DEBUG_FORCE_ANSWER.has(triggerKind)) {
        // This should never happen — the prompt doesn't offer SILENT as an
        // option for this trigger kind. If you see this line, the model
        // ignored the instruction; worth logging the raw reply too.
        //ctx.log.warn(`[many-ai:debug] ${chatTag} ⚠ SILENT despite forced-answer trigger, raw="${raw}"`);
      } else {
        //ctx.log.info(`[many-ai:debug] ${chatTag} iter=${i + 1}/${maxIterations} → SILENT`);
      }
      return null;
    }
    if (parsed.type === "textThenSticker") {
      // Deliberately NOT sending the sticker here — the tool would fire
      // immediately, before the caller ever gets a chance to send the text,
      // reversing the order the model was asked for. The caller sends
      // `text` first, then runs SEND_STICKER itself with `stickerArg`.
      //ctx.log.info(`[many-ai:debug] ${chatTag} iter=${i + 1}/${maxIterations} → text + SEND_STICKER(${parsed.stickerArg}) after`);
      return { text: parsed.value, stickerArg: parsed.stickerArg };
    }

    //ctx.log.info(`[many-ai:debug] ${chatTag} iter=${i + 1}/${maxIterations} → ${parsed.command}(${parsed.arg})`);

    let result;
    try {
      result = await runTool(parsed.command, parsed.arg, ctx, chatId, t, opts);
    } catch (err) {
      ctx.log.error(`[many-ai] error in ${parsed.command}: ${err.message}`);
      result = t("errors.toolError", { tool: parsed.command });
    }

    pushEntry(history, { role: "user", kind: "tool", content: `[${t("tools.resultLabel")}: ${parsed.command}] ${result}` });

    // A sticker call is a side effect (already sent) rather than something
    // the model needs the result of before continuing — if it also wrote a
    // reply right after the call on the same turn, that's the final answer,
    // no need to spend another API call asking for it again.
    if (parsed.command === "SEND_STICKER" && parsed.trailing) {
      return parsed.trailing;
    }
  }

  //ctx.log.warn(`[many-ai:debug] ${chatTag} gave up after ${maxIterations} iterations, no final answer`);
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

  // Quote and continuation are unambiguous — replying to the bot's own
  // message, or being mid-conversation with it, is a much stronger signal
  // than the name simply appearing in the text. Checked before word/literal
  // so a reply that also happens to mention the name (e.g. "Many vc é muito
  // legal" sent as a reply to the bot) is correctly classified as "quote"
  // (forces a real answer) instead of "word" (still allows SILENT).
  const quotedId = quotedRaw?.key?.id;
  if (quotedId && aiMessageIds.has(quotedId)) return "quote"; // quoting the AI's own message

  // A message formatted as a command (e.g. "!figurinha") is addressed to
  // whichever plugin actually owns that command — it must never trigger the
  // AI via continuation/word/literal just because it happens to contain the
  // AI's name or arrive during a continuation window. Only this plugin's
  // own command (checked above) or a quote can still reach the AI once "!"
  // is involved.
  if (msg.hasPrefix) return null;

  const pending = pendingContinuation.get(chatId);
  if (pending && pending.senderName === msg.senderName && Date.now() < pending.expiresAt) return "continuation";

  if (wordRE?.test(msg.body)) return "word";
  if (triggers.some(tr => msg.body.trim().toLowerCase().includes(tr.toLowerCase()))) return "literal";

  return null;
}

/** Opens (or refreshes) the continuation window right after the bot actually sends a reply. */
function markContinuation(chatId, senderName) {
  pendingContinuation.set(chatId, { senderName, expiresAt: Date.now() + CONTINUATION_WINDOW_MS });
}

/** Records what the bot just sent (one entry per line, since a multi-line reply now goes out as
 * separate messages), so a later incoming echo of any of those lines can be recognized and ignored
 * as a trigger source. */
function markSelfEcho(chatId, bodies) {
  const list = recentlySentByBot.get(chatId) || [];
  const expiresAt = Date.now() + SELF_ECHO_WINDOW_MS;
  for (const body of Array.isArray(bodies) ? bodies : [bodies]) {
    if (body) list.push({ body, expiresAt });
  }
  recentlySentByBot.set(chatId, list);
}

/** Checks whether `body` matches something the bot itself just sent to this chat; if so, consumes
 * that entry (so a later unrelated repeat of the same text isn't wrongly treated as an echo too). */
function consumeSelfEcho(chatId, body) {
  const list = recentlySentByBot.get(chatId);
  if (!list || !list.length) return false;
  const now = Date.now();
  const idx = list.findIndex(e => e.body === body && now < e.expiresAt);
  if (idx === -1) {
    const fresh = list.filter(e => now < e.expiresAt); // opportunistic cleanup of expired entries
    if (fresh.length !== list.length) recentlySentByBot.set(chatId, fresh);
    return false;
  }
  list.splice(idx, 1);
  return true;
}

/** Splits a reply into non-empty lines — each one is sent as its own WhatsApp message. */
function splitReplyLines(reply) {
  return (reply || "").split("\n").map(l => l.trim()).filter(Boolean);
}

const MULTI_LINE_DELAY_MS = 500; // gap between bubbles so they read as separate messages, not a burst

/** Sends a (possibly multi-line) reply as one message per line — quotes the original message on
 * the first line only; the rest are plain follow-ups in the same chat. Returns the raw sent protos. */
async function sendReplyLines(ctx, msg, reply) {
  const lines = splitReplyLines(reply);
  const rawSents = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, MULTI_LINE_DELAY_MS));
    const handle = i === 0 ? msg.reply.text(lines[i]) : ctx.send.text(lines[i]);
    rawSents.push(await handle.rawPromise);
  }
  return { lines, rawSents };
}

/** Same, but for unprompted sends (passive intervention) — no original message to quote. */
async function sendBroadcastLines(ctx, reply) {
  const lines = splitReplyLines(reply);
  const rawSents = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, MULTI_LINE_DELAY_MS));
    const handle = ctx.send.text(lines[i]);
    rawSents.push(await handle.rawPromise);
  }
  return { lines, rawSents };
}

/**
 * Deterministic, no-AI-call settings command — this must work even if the
 * AI is disabled for the chat (it's the only way to turn it back on), and
 * runs before anything else in the handler. In groups, only admins can
 * change settings (anyone can check status); in DMs, the one user can.
 */
async function handleSettingsCommand(ctx, args, t) {
  const sub = (args[0] || "status").toLowerCase();

  if (ctx.chat.isGroup && sub !== "status") {
    const isAdmin = await ctx.chat.isSenderAdmin();
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
  const intervention = await getSetting(ctx, "passiveIntervention", false);
  const transcribe   = await getSetting(ctx, "transcribeAudio", false);
  const stickerOn    = await getSetting(ctx, "stickersEnabled", true);
  await ctx.msg.reply.text(t("settings.status", {
    enabled:      enabled      ? t("settings.yes") : t("settings.no"),
    intervention: intervention ? t("settings.yes") : t("settings.no"),
    transcribe:   transcribe   ? t("settings.yes") : t("settings.no"),
    sticker:      stickerOn    ? t("settings.yes") : t("settings.no"),
  }));
}

const GATE_MAX_TOKENS = 5; // just enough for "SPEAK" or "SILENT", nothing else

/**
 * Minimal, tool-free instructions for the cheap gate model — same
 * SPEAK-worthy criteria as the passive note below, but stripped down to a
 * single-word verdict so this call stays as close to free as possible.
 */
function buildGatePrompt(lang, dm, aiName) {
  const name = (aiName || "").trim();

  if (dm) {
    return lang === "pt"
      ? "Decida se o assistente de IA deve responder nesta conversa privada. É um chat 1:1 — presuma que a mensagem é para você. Responda SPEAK na grande maioria dos casos, inclusive cumprimentos e comentários curtos. Responda SILENT só se a mensagem claramente não for para você (ex: é um comando de outro plugin, ou não faz sentido nenhum como algo dirigido a você). Responda com exatamente uma palavra: SPEAK ou SILENT."
      : "Decide whether the AI assistant should respond in this private chat. It's a 1:1 chat — assume the message is meant for you. Reply SPEAK in the vast majority of cases, including greetings and short comments. Reply SILENT only if the message clearly isn't meant for you (e.g. it's another plugin's command, or makes no sense as something addressed to you). Reply with exactly one word: SPEAK or SILENT.";
  }

  const nameNote = name
    ? (lang === "pt"
        ? ` A IA se chama "${name}". O nome aparecendo na conversa NÃO significa que estão chamando ela — as pessoas frequentemente falam SOBRE "${name}" sem estar se dirigindo a ela (ex: "o ${name} respondeu isso errado ontem", "vocês viram o que o ${name} disse?"). Conte como chamado quando: o nome aparece sozinho ou seguido de uma pergunta/pedido esperando resposta agora (ex: "${name}?", "${name}, me ajuda"), mesmo sem "?" explícito.`
        : ` The AI is named "${name}". The name showing up in the conversation does NOT mean someone is calling it — people often talk ABOUT "${name}" without addressing it (e.g. "${name} got that wrong yesterday", "did you see what ${name} said?"). Count it as being called when: the name appears alone or right before a question/request expecting an answer now (e.g. "${name}?", "${name}, help me out"), even without an explicit "?".`)
    : "";

  return lang === "pt"
    ? `Avalie SOMENTE a mensagem marcada como [CURRENT MESSAGE] abaixo — as demais são só contexto para entender do que se trata. Decida se a IA deve intervir espontaneamente nessa mensagem (ninguém necessariamente a chamou).${nameNote} Responda SPEAK se: foi claramente chamada esperando resposta agora, é uma pergunta do grupo sem resposta, um pedido de ajuda, ou um erro técnico/factual que valha corrigir. Responda SILENT nos demais casos. Responda com exatamente uma palavra: SPEAK ou SILENT.`
    : `Evaluate ONLY the message tagged [CURRENT MESSAGE] below — everything else is just context to understand what's going on. Decide whether the AI should jump into that message on its own (nobody necessarily called it).${nameNote} Reply SPEAK if: it was clearly called expecting an answer now, it's an unanswered group question, a help request, or a technical/factual error worth correcting. Reply SILENT otherwise. Reply with exactly one word: SPEAK or SILENT.`;
}

/**
 * Cheap first-stage gate: a small, tool-free model call that only decides
 * whether the passive check is even worth spending the main model on.
 * Never throws — any failure here just means "stay silent", same as the
 * old behavior when the passive call itself errored out.
 */
async function checkGate(ctx, history, lang, dm, gateModel, aiName) {
  const keys = getKeyPool(ctx);
  if (!keys.length) return false;

  const prompt = buildGatePrompt(lang, dm, aiName);
  try {
    const raw = await withKeyFailover(keys, (key) => callGroq(history, prompt, key, gateModel, GATE_MAX_TOKENS), ctx.log);
    return /^SPEAK/i.test(raw.trim());
  } catch (err) {
    ctx.log.error(`[many-ai] gate check error: ${err.message}`);
    return false;
  }
}

/**
 * Runs the actual "should I say something" check. Two stages: a cheap gate
 * model decides SPEAK/SILENT with no tools involved, and only on SPEAK does
 * the main model (same one used for direct triggers) run the full
 * resolveReply loop to generate the real reply. Keeps quality consistent
 * with direct triggers while only paying the main model's cost on the rare
 * messages that actually warrant a reply.
 */
async function runPassiveCheck(ctx, chatId, history, t, senderName, { dm = false } = {}) {
  // Re-check here, not just at the call site — a pending setTimeout could
  // fire after the setting was flipped off in the meantime.
  const passiveOn = await getSetting(ctx, "passiveIntervention", false);
  if (!passiveOn) return;

  const { config } = ctx;
  const lang      = config.get("LANGUAGE", "pt");
  const gateModel = config.get("AI_PASSIVE_MODEL", "llama-3.1-8b-instant");
  const MODEL     = config.get("GROQ_MODEL", "llama-3.3-70b-versatile");
  const aiName    = config.get("AI_NAME", "");

  const scratch = history.slice();
  const shouldSpeak = await checkGate(ctx, scratch, lang, dm, gateModel, aiName);
  if (!shouldSpeak) return;

  const { stickersEnabled, stickers } = await getStickerPromptExtras(ctx);
  const basePrompt = buildSystemPrompt({
    name: config.get("AI_NAME", ""),
    personality: config.get("AI_PERSONALITY", ""),
    purpose: config.get("AI_PURPOSE", ""),
    extraInstructions: config.get("AI_EXTRA_INSTRUCTIONS", ""),
    language: lang,
    model: MODEL,
    settingsCommand: config.get("MANYAI_SETTINGS_COMMAND", "ai-settings"),
    cmdPrefix: config.get("CMD_PREFIX", "!"),
    emojis: config.get("AI_EMOJIS", false),
    replyLength: config.get("AI_REPLY_LENGTH", "short"),
    otherCommands: config.get("AI_OTHER_COMMANDS", []),
    stickersEnabled,
    stickers,
  });

  const passiveNote = dm
    ? (lang === "pt"
        ? "\n[CONVERSA PRIVADA]\nÉ óbvio que esta mensagem é pra você — é 1:1, não precisa do seu nome. Responda normalmente, como numa conversa direta com a pessoa, incluindo cumprimentos e comentários simples. Só fique em silêncio se a mensagem claramente não for pra você (ex: comando de outro plugin) — responda exatamente SILENT nesse caso."
        : "\n[PRIVATE CHAT]\nIt's obvious this message is meant for you — it's 1:1, no name needed. Respond normally, like a direct conversation with the person, including greetings and short comments. Only stay silent if the message clearly isn't meant for you (e.g. another plugin's command) — reply exactly SILENT in that case.")
    : (lang === "pt"
        ? "\n[MODO PASSIVO]\nEsta mensagem NÃO foi endereçada a você — ninguém te chamou. Só responda se: (a) for uma pergunta clara feita ao grupo que ficou sem resposta, (b) alguém estiver claramente pedindo ajuda mesmo sem te citar, ou (c) houver um erro técnico/factual que valha a pena corrigir. Na dúvida, fique em silêncio — responda exatamente SILENT na grande maioria dos casos."
        : "\n[PASSIVE MODE]\nThis message was NOT addressed to you — nobody called you. Only respond if: (a) it's a clear question to the group left unanswered, (b) someone is clearly asking for help even without mentioning you, or (c) there's a technical/factual error worth correcting. When in doubt, stay silent — reply exactly SILENT in the vast majority of cases.");

  try {
    // Resolves against a COPY of the shared history: a passive check makes
    // several "SILENT" no-op checks for every one that actually says
    // something, and none of that back-and-forth (nor any tool calls along
    // the way) should pollute the real conversation history that future
    // prompts are built from. Only an actual contribution gets recorded back.
    const reply = await withChatLock(chatId, () => resolveReply(scratch, basePrompt + passiveNote, ctx, t, MODEL, chatId, 3, "passive"));
    if (!reply) return;

    // resolveReply returns a plain string normally, or { text, stickerArg }
    // when the model wrote "text first, sticker after" — send the text,
    // THEN fire the sticker, preserving that order.
    const replyText = typeof reply === "object" ? reply.text : reply;

    pushEntry(history, { role: "assistant", kind: "tool", content: replyText });
    const { lines, rawSents } = await sendBroadcastLines(ctx, replyText); // unprompted — nothing to quote
    rawSents.forEach(rawSent => trackAiMessage(rawSent?.key?.id));
    markSelfEcho(chatId, lines);
    if (typeof reply === "object") await sendStickerAfterText(ctx, chatId, t, history, reply.stickerArg);
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
  const passiveOn = await getSetting(ctx, "passiveIntervention", false);
  // A DM is already 1:1 with the bot — unlike the group's noise filter,
  // don't drop short messages here; "oi"/"olá" deserve a real check.
  if (!passiveOn || !body.trim()) {
    return;
  }
  await runPassiveCheck(ctx, chatId, history, t, senderName, { dm: true });
}

/**
 * Decides whether a non-triggering group message is worth a passive-mode
 * AI check at all. Cheap heuristics only — they exist purely to avoid
 * spending an API call on every single message in an active group.
 */
async function maybeIntervenePassively(ctx, chatId, history, body, t, senderName) {
  const passiveOn = await getSetting(ctx, "passiveIntervention", false);
  if (!passiveOn || isTooShortToConsider(body)) {
    return;
  }

  const lang = ctx.config.get("LANGUAGE", "pt");

  if (looksLikeUnansweredQuestion(body)) {
    const waitMinutes = Number(ctx.config.get("AI_INTERVENTION_WAIT_MINUTES", 1)) || 1;
    const snapshot = lastActivityAt.get(chatId);
    setTimeout(() => {
      // Someone else spoke in this chat since — the question may already
      // be answered, or the moment has passed. Stay out of it.
      if (lastActivityAt.get(chatId) !== snapshot) return;
      runPassiveCheck(ctx, chatId, history, t, senderName).catch(err => ctx.log.error(`[many-ai] delayed passive check error: ${err.message}`));
    }, waitMinutes * 60_000);
    return;
  }

  if (looksLikeHelpRequest(body, lang)) {
    await runPassiveCheck(ctx, chatId, history, t, senderName);
  }
}

export async function setup(ctx) {
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
  // The bot's own sent messages come back as normal incoming events with a
  // different senderName than whoever it's talking to (a group JID/number
  // instead of the real name) — without the fromMe guard, the sticker +
  // "Cheguei!" the AI just sent were themselves wiping the continuation
  // window before the human's next message ever arrived.
  if (pendingCont && pendingCont.senderName !== msg.senderName && !msg.fromMe) pendingContinuation.delete(chatId);

  const settingsCommand = config.get("MANYAI_SETTINGS_COMMAND", "ai-settings");
  if (settingsCommand && msg.is(settingsCommand)) {
    await handleSettingsCommand(ctx, msg.args, t);
    return;
  }

  // Kill switch checked before anything else AI-related — indexing included.
  // Not everyone wants a chat listened to at all; "!ai-settings off" (above)
  // is the only thing that still works once this is set.
  const enabled = await getSetting(ctx, "enabled", true);
  if (!enabled) return;

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
    } catch (err) {
      ctx.log.info(t("logs.shouldRespond.quotedError", { error: err.message }));
    }
  }

  // getMsgType() returns: chat, image, video, audio, sticker, document, poll, unknown.
  const msgType = (msg.type || "").toLowerCase();
  const NON_TEXT_MEDIA = ["image", "video", "sticker", "document"];

  let body = msg.body || "";
  let isMediaNoCaption = false;

  if (msgType === "audio") {
    const transcribeOn = await getSetting(ctx, "transcribeAudio", false);
    let transcript = "";
    if (transcribeOn) {
      const keys = getKeyPool(ctx);
      if (keys.length) {
        const transcribeModel = config.get("AI_TRANSCRIBE_MODEL", "whisper-large-v3-turbo");
        transcript = await transcribeCurrentMessage(msg, ctx, keys, transcribeModel);
      }
    }
    if (transcript) {
      body = `(voice note, transcribed) ${transcript}`;
      // falls through to the normal text pipeline below with the transcript as the body
    } else {
      // Same rule as other media: an audio we can't transcribe only gets a
      // reply if someone explicitly asked ("!ai"), never on ambient triggers.
      if (getTriggerKind(msg, quotedRaw, triggers, wordRE, commandName, chatId) === "command") {
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
    isMediaNoCaption = true;
  }

  // Self-echo guard: the platform can hand the bot's own outgoing message
  // back through this same handler as a normal incoming event. Confirmed in
  // testing — that echo matched word/continuation triggers and made the bot
  // reply to itself in a loop. Recognize it by matching against what we just
  // sent to this chat; if it matches, it still goes into history as context
  // (so future replies know what was said) but can never itself be a trigger.
  const isSelfEcho = consumeSelfEcho(chatId, body);

  let triggerKind = isSelfEcho ? null : getTriggerKind(msg, quotedRaw, triggers, wordRE, commandName, chatId);
  // Media with no caption (image/video/sticker/document) is never something
  // to force an answer to — the model can't see it anyway. Only an explicit
  // command ("!ai" attached to it) counts as actually being asked; ambient
  // triggers (word/literal/continuation/quote) must not fire on it.
  if (isMediaNoCaption && triggerKind !== "command") triggerKind = null;
  const isTrigger = !!triggerKind;
  // TEMP DEBUG (remove after testing): confirms which trigger kind (if any)
  // fired for a given message — key for checking continuation actually hits.
  //ctx.log.info(`[many-ai:debug] chat=…${shortChat(chatId)} trigger=${triggerKind ?? "none"} echo=${isSelfEcho} fromMe=${msg.fromMe} from=${msg.senderName}: "${body || `(${msgType})`}"`);

  // A message is only treated as "another plugin's command" (background
  // context, ignored by the AI) if it ISN'T itself Many's own trigger —
  // otherwise "!ai question" would get stored as a command and the user's
  // actual question would end up tagged as something to ignore. These are
  // stored as role "user" (something that happened in the chat), not
  // "system" — a mid-conversation system-role message could be read by the
  // model as an instruction with special authority, which it isn't.
  const isOtherPluginCommand = msg.hasPrefix && !isTrigger;

  if (isOtherPluginCommand) {
    pushEntry(history, { role: "user", kind: "command", current: false, content: formatCommandEntry({ senderName: msg.senderName, body }) });
  } else if (body.trim() || isTrigger) {
    // The `isTrigger` fallback covers the rare case of a genuine trigger
    // with no text of its own (e.g. quoting the AI's last message via a
    // poll) — otherwise an empty body (poll/unrecognized message types
    // that slip past the media checks above) isn't worth archiving at all.
    const quotedInfo = quotedRaw ? await buildQuotedInfo(quotedRaw, msg, ctx, chat.isGroup, isTrigger) : null;
    pushEntry(history, {
      role: "user",
      kind: "chat",
      current: true,
      content: formatChatEntry({ isGroup: chat.isGroup, chatName: chat.name, senderName: msg.senderName, body, quoted: quotedInfo }),
    });
    indexMessage(chatId, msg.senderName, body); // long-term archive, regardless of whether this triggers a reply
  }

  if (!isTrigger) {
    if (isSelfEcho) {
      // Own message bounced back: already recorded as context above, never worth any kind of check.
    } else if (isMediaNoCaption) {
      // Media without caption: keep as context only, never worth a passive check.
    } else if (chat.isGroup && !isOtherPluginCommand) {
      maybeIntervenePassively(ctx, chatId, history, body, t, msg.senderName)
        .catch(err => ctx.log.error(`[many-ai] passive intervention error: ${err.message}`));
    } else if (!chat.isGroup && !isOtherPluginCommand) {
      maybeInterveneInDM(ctx, chatId, history, body, t, msg.senderName)
        .catch(err => ctx.log.error(`[many-ai] DM passive engagement error: ${err.message}`));
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
    triggerKind,
    settingsCommand,
    cmdPrefix: config.get("CMD_PREFIX", "!"),
    emojis: config.get("AI_EMOJIS", false),
    replyLength: config.get("AI_REPLY_LENGTH", "short"),
    otherCommands: config.get("AI_OTHER_COMMANDS", []),
    stickersEnabled,
    stickers,
  });

  try {
    const reply = await withChatLock(chatId, () => resolveReply(history, systemPrompt, ctx, t, MODEL, chatId, 5, triggerKind));
    if (reply) {
      // resolveReply returns a plain string normally, or { text, stickerArg }
      // when the model wrote "text first, sticker after" — send the text,
      // THEN fire the sticker, preserving that order.
      const replyText = typeof reply === "object" ? reply.text : reply;
      const { lines, rawSents } = await sendReplyLines(ctx, msg, replyText);
      rawSents.forEach(rawSent => trackAiMessage(rawSent?.key?.id)); // raw proto — the only place .key.id actually lives
      markSelfEcho(chatId, lines);
      if (typeof reply === "object") await sendStickerAfterText(ctx, chatId, t, history, reply.stickerArg);
      // Only a "real" trigger (command/word/literal/quote) opens a fresh
      // continuation window — a continuation-triggered reply must NOT
      // extend it further, or the bot would keep answering the same
      // sender forever without ever being addressed again.
      if (triggerKind !== "continuation") markContinuation(chatId, msg.senderName);
    }
  } catch (err) {
    ctx.log.error(`[many-ai] error: ${err.message}`);
    // Only surface API failures to the user when they explicitly addressed
    // the bot (command/quote) — an ambient trigger (word/literal/
    // continuation) failing silently beats spamming an alarming error into
    // a conversation nobody actually asked the AI to join.
    const EXPLICIT_TRIGGERS = new Set(["command", "quote"]);
    if (!EXPLICIT_TRIGGERS.has(triggerKind)) return;

    if (err.isMissingKey) {
      await msg.reply.text(t("errors.missingApiKey"));
    } else if (err.isRateLimit) {
      await msg.reply.text(err.retryIn ? t("errors.rateLimitWithRetry", { retryIn: err.retryIn }) : t("errors.rateLimit"));
    } else if (err.isInvalidKey || err.isTransient) {
      await msg.reply.text(t("errors.allKeysRateLimit"));
    } else {
      await msg.reply.text(t("errors.generic"));
    }
  }
}
