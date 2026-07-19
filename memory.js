// src/plugins/many-ai/memory.js
// Many's persistent memory, scoped per chat (each group/DM only reads and
// writes its own memories), stored via ctx.storage — survives plugin
// reinstalls and is correctly removed by `manyplug remove`.

import { DatabaseSync } from "node:sqlite";

let db     = null;
let logRef = null;
let t      = (key) => key; // fallback before initMemory runs

function logError(msg) {
  if (logRef) logRef.error(msg);
}

/**
 * Initializes the memory database. Should be called once, from `setup(ctx)`.
 * Idempotent — repeated calls won't reopen the database.
 */
export function initMemory(ctx) {
  if (db) return;

  logRef = ctx.log;
  t      = ctx.i18n.createT(import.meta.url).t;

  const dbPath = ctx.storage.resolve("memory.db");

  try {
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_chat ON memory (chat_id)`);
  } catch (err) {
    logError(t("memory.dbOpenError", { error: err.message }));
  }
}

export function memWrite(chatId, content) {
  if (!db) return Promise.reject(new Error("memory not initialized"));
  const value = (content || "").trim();
  if (!value) return Promise.reject(new Error("empty content"));

  try {
    db.prepare("INSERT INTO memory (chat_id, content) VALUES (?, ?)").run(chatId, value);
    return Promise.resolve(t("memory.saved"));
  } catch (err) {
    logError(t("memory.insertError", { error: err.message }));
    return Promise.reject(err);
  }
}

// Escapes LIKE's own wildcard characters in user-supplied search text, so a
// query like "50% off" is matched literally instead of "%" acting as a
// wildcard the user didn't intend.
function escapeLike(str) {
  return str.replace(/[\\%_]/g, "\\$&");
}

export function memRead(chatId, query) {
  if (!db) return Promise.reject(new Error("memory not initialized"));

  const q     = (query || "").trim();
  const isAll = !q || q === "*" || q.toLowerCase() === "all";

  const sql = isAll
    ? "SELECT content FROM memory WHERE chat_id = ? ORDER BY created_at DESC LIMIT 20"
    : "SELECT content FROM memory WHERE chat_id = ? AND content LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 10";
  const params = isAll ? [chatId] : [chatId, `%${escapeLike(q)}%`];

  try {
    const rows = db.prepare(sql).all(...params);
    if (!rows.length) return Promise.resolve(t("memory.noResults"));
    return Promise.resolve(rows.map(r => `[${r.content}]`).join(" | "));
  } catch (err) {
    logError(t("memory.selectError", { error: err.message }));
    return Promise.reject(err);
  }
}
