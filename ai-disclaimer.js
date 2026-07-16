// src/plugins/many-ai/ai-disclaimer.js
// First-use / "it's been a while" disclaimer for the AI trigger path only.
// Uses its own table (ai_seen), separate from many-help's db, so "first
// time talking to the bot at all" and "first time using the AI" don't get
// mixed up. Tracked per GROUP in groups (any member triggering it counts —
// it doesn't repeat for every new person) and per SENDER in DMs.
//
// Hard rule: nothing in this file may ever throw out of setupAiDisclaimer()
// or maybeSendAiDisclaimer(). setup() in index.js has no try/catch around
// setupAiDisclaimer, and a throw from maybeSendAiDisclaimer would land in
// index.js's outer catch and show the user an error message even though
// the real AI reply already went out fine. Every failure here is logged
// and swallowed instead — same "best-effort, fail silent" contract as
// voice.js's quoted-audio transcription.

import { DatabaseSync } from "node:sqlite";

// ─── config ──────────────────────────────────────────────────────────────────

const INACTIVE_MS = 3 * 24 * 60 * 60 * 1000;

// Full command menu, spelled out — the point of showing this at all is
// that nobody should have to guess how to configure the AI, so half a
// sentence with one or two examples defeats the purpose.
function buildDisclaimer({ language, prefix, settingsCommand }) {
  const cmd = `${prefix}${settingsCommand}`;
  if (language === "pt") {
    return (
      "⚠️ Só um aviso: essa função usa IA e é experimental, então pode cometer erros ou " +
      "alucinações às vezes. Verifique informações importantes antes de confiar 100% na resposta 😉\n\n" +
      "*Comandos pra me configurar nesse chat:*\n" +
      `\`${cmd} status\` - mostra o que está ligado agora\n` +
      `\`${cmd} on\` / \`${cmd} off\` - me liga ou desliga totalmente aqui\n` +
      `\`${cmd} intervention on\` / \`off\` - faz eu entrar na conversa sozinha às vezes quando necessário\n` +
      `\`${cmd} transcribe on\` / \`off\` - faz eu entender seus áudios como se fossem textos\n` +
      `\`${cmd} sticker on\` / \`off\` - liga ou desliga o envio de figurinhas por mim`
    );
  }
  if (language === "es") {
    return (
      "⚠️ Un aviso: esta función usa IA y es experimental, así que puede cometer errores o " +
      "alucinaciones a veces. Verifica la información importante antes de confiar 100% en la respuesta 😉\n\n" +
      "*Comandos para configurarme en este chat:*\n" +
      `\`${cmd} status\` - muestra lo que está activado ahora\n` +
      `\`${cmd} on\` / \`${cmd} off\` - me activa o desactiva totalmente aquí\n` +
      `\`${cmd} intervention on\` / \`off\` - hace que intervenga sola en la conversación cuando sea necesario\n` +
      `\`${cmd} transcribe on\` / \`off\` - hace que entienda tus audios como si fueran texto\n` +
      `\`${cmd} sticker on\` / \`off\` - activa o desactiva que yo envíe stickers`
    );
  }
  return (
    "⚠️ Just a heads-up: this feature uses AI and is experimental, so it can make mistakes or " +
    "hallucinate sometimes. Double-check anything important before fully trusting the answer 😉\n\n" +
    "*Commands to configure me in this chat:*\n" +
    `\`${cmd} status\` - shows what's currently on\n` +
    `\`${cmd} on\` / \`${cmd} off\` - turn me fully on or off here\n` +
    `\`${cmd} intervention on\` / \`off\` - let me join the conversation on my own sometimes, without being called\n` +
    `\`${cmd} transcribe on\` / \`off\` - have me transcribe voice notes in the chat\n` +
    `\`${cmd} sticker on\` / \`off\` - turn my sticker sending on or off`
  );
}

// ─── db ──────────────────────────────────────────────────────────────────────

function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_seen (
      seen_key   TEXT    PRIMARY KEY,
      first_seen INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL DEFAULT 0
    )
  `);
  return db;
}

function purgeInactive(db) {
  db.prepare("DELETE FROM ai_seen WHERE last_seen > 0 AND last_seen < ?").run(Date.now() - INACTIVE_MS);
}

function touchKey(db, seenKey) {
  db.prepare("UPDATE ai_seen SET last_seen = ? WHERE seen_key = ?").run(Date.now(), seenKey);
}

// true = genuinely the first time ever, OR the row had already been purged
// for inactivity (in which case INSERT OR IGNORE recreates it and counts
// as "new" again, on purpose).
function isNewOrReturning(db, seenKey) {
  const { changes } = db
    .prepare("INSERT OR IGNORE INTO ai_seen (seen_key, first_seen, last_seen) VALUES (?, ?, ?)")
    .run(seenKey, Date.now(), Date.now());
  return changes === 1;
}

// ─── plugin ──────────────────────────────────────────────────────────────────

let db;
let logRef;

function logWarn(msg) { if (logRef) logRef.warn(msg); else console.warn(msg); }
function logError(msg) { if (logRef) logRef.error(msg); else console.error(msg); }

/**
 * Call once from setup(ctx). If node:sqlite isn't available on this Node
 * version, or the db can't be opened for any other reason, this logs a
 * warning and leaves db unset — maybeSendAiDisclaimer then just no-ops on
 * every call instead of breaking the rest of the plugin.
 */
export function setupAiDisclaimer(ctx) {
  logRef = ctx.log;
  try {
    const dbPath = ctx.storage.resolve("ai_users.db");
    db = openDb(dbPath);
  } catch (err) {
    db = null;
    logWarn(`[many-ai] ai-disclaimer unavailable (node:sqlite failed to open), skipping: ${err.message}`);
  }
}

/**
 * Call this ONLY after the AI has actually resolved to a real reply (never
 * on SILENT, never on a failed/empty trigger, never on a passive-mode
 * reply nobody asked for). Sends a short "this is experimental AI" notice
 * right after the real reply — in a GROUP this is tracked per group (any
 * member triggering it counts, so it doesn't repeat for every new person),
 * in a DM it's tracked per sender. Either way it fires again after 3 full
 * days without a trigger for that same key.
 *
 * Never throws — any failure (db op, or the reply itself failing to send)
 * is logged and swallowed so it can never mask a otherwise-successful AI
 * reply with an error message.
 */
export async function maybeSendAiDisclaimer(ctx) {
  const { msg, chat, config } = ctx;
  if (!db) return;

  const seenKey = chat?.isGroup ? (chat.id ? `group:${chat.id}` : null) : (msg?.sender ? `dm:${msg.sender}` : null);
  if (!seenKey) return;

  try {
    purgeInactive(db);

    const isNew = isNewOrReturning(db, seenKey);
    logRef?.info?.(`[many-ai:debug] disclaimer check key="${seenKey}" isNewOrReturning=${isNew}`);
    if (isNew) {
      const disclaimer = buildDisclaimer({
        language: config.get("LANGUAGE", "pt"),
        prefix: config.get("CMD_PREFIX", "!"),
        settingsCommand: config.get("MANYAI_SETTINGS_COMMAND", "ai-settings"),
      });
      await msg.reply.text(disclaimer);
    } else {
      touchKey(db, seenKey);
    }
  } catch (err) {
    logError(`[many-ai] ai-disclaimer error, skipping: ${err.message}`);
  }
}
