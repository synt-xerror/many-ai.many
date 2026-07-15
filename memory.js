// src/plugins/many-ai/memory.js
// Many's persistent memory, scoped per chat (each group/DM only reads and
// writes its own memories), stored via ctx.storage — survives plugin
// reinstalls and is correctly removed by `manyplug remove`.

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const sqlite3 = require("sqlite3").verbose();

let db      = null;
let logRef  = null;
let t       = (key) => key; // fallback before initMemory runs

function logError(msg) {
  if (logRef) logRef.error(msg);
}

/**
 * Initializes the memory database. Should be called once, from `setup(ctx)`.
 * Idempotent — repeated calls won't reopen the database. The setup
 * statements run inside db.serialize() so table/index creation is
 * guaranteed to finish before any later memWrite/memRead query — without
 * that, a message arriving right after a fresh install could race the
 * CREATE TABLE and fail with "no such table".
 */
export function initMemory(ctx) {
  if (db) return;

  logRef = ctx.log;
  t      = ctx.i18n.createT(import.meta.url).t;

  const dbPath = ctx.storage.resolve("memory.db");
  db = new sqlite3.Database(dbPath, (err) => {
    if (err) logError(t("memory.dbOpenError", { error: err.message }));
  });

  db.serialize(() => {
    db.run("PRAGMA journal_mode = WAL;", (err) => {
      if (err) logError(t("memory.walError", { error: err.message }));
    });

    db.run(
      `CREATE TABLE IF NOT EXISTS memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      (err) => {
        if (err) logError(t("memory.tableCreateError", { error: err.message }));
      }
    );

    db.run(`CREATE INDEX IF NOT EXISTS idx_memory_chat ON memory (chat_id)`);
  });
}

export function memWrite(chatId, content) {
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error("memory not initialized"));
    const value = (content || "").trim();
    if (!value) return reject(new Error("empty content"));

    db.run("INSERT INTO memory (chat_id, content) VALUES (?, ?)", [chatId, value], function (err) {
      if (err) {
        logError(t("memory.insertError", { error: err.message }));
        return reject(err);
      }
      resolve(t("memory.saved"));
    });
  });
}

// Escapes LIKE's own wildcard characters in user-supplied search text, so a
// query like "50% off" is matched literally instead of "%" acting as a
// wildcard the user didn't intend.
function escapeLike(str) {
  return str.replace(/[\\%_]/g, "\\$&");
}

export function memRead(chatId, query) {
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error("memory not initialized"));

    const q     = (query || "").trim();
    const isAll = !q || q === "*" || q.toLowerCase() === "all";

    const sql = isAll
      ? "SELECT content FROM memory WHERE chat_id = ? ORDER BY created_at DESC LIMIT 20"
      : "SELECT content FROM memory WHERE chat_id = ? AND content LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 10";
    const params = isAll ? [chatId] : [chatId, `%${escapeLike(q)}%`];

    db.all(sql, params, (err, rows) => {
      if (err) {
        logError(t("memory.selectError", { error: err.message }));
        return reject(err);
      }
      if (!rows.length) return resolve(t("memory.noResults"));
      resolve(rows.map(r => `[${r.content}]`).join(" | "));
    });
  });
}
