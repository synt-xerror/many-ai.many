// src/plugins/many-ai/history.js
// Long-term, per-chat searchable archive of real chat messages — separate
// from the short in-memory conversational context in index.js (that one
// feeds the model directly; this one is a local index the model searches
// via a tool call, so a query never requires sending the full history to
// the API). Foundation for search, "what did I miss", pending decisions,
// experts, docs generation, etc.

import { createRequire } from "module";
const require  = createRequire(import.meta.url);
const sqlite3  = require("sqlite3").verbose();

let db           = null;
let logRef       = null;
let ftsAvailable = false;

const RETENTION_DAYS    = 90;
const PRUNE_PROBABILITY = 1 / 50; // opportunistic cleanup on insert, no cron needed
const MAX_RESULTS       = 8;

function logError(msg) { if (logRef) logRef.error(msg); }
function logWarn(msg)  { if (logRef) logRef.warn(msg); }

/** Idempotent — safe to call multiple times, only opens the db once. */
export function initHistory(ctx) {
  if (db) return;
  logRef = ctx.log;

  const dbPath = ctx.storage.resolve("history.db");
  db = new sqlite3.Database(dbPath, (err) => {
    if (err) logError(`[many-ai] history db open error: ${err.message}`);
  });

  db.serialize(() => {
    db.run("PRAGMA journal_mode = WAL;");

    db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `, (err) => { if (err) logError(`[many-ai] history table error: ${err.message}`); });

    db.run(`CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (chat_id, created_at)`);

    // FTS5 lets SEARCH_HISTORY find things by meaning-adjacent word matches
    // fast, entirely locally. If this build of sqlite3 lacks FTS5, we fall
    // back to a plain LIKE scan instead of failing.
    db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        body, sender_name, chat_id UNINDEXED, created_at UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      )
    `, (err) => {
      if (err) {
        ftsAvailable = false;
        logWarn(`[many-ai] FTS5 unavailable, falling back to LIKE search for history: ${err.message}`);
      } else {
        ftsAvailable = true;
      }
    });
  });
}

/** Indexes one real chat message. Fire-and-forget — never blocks the reply path. */
export function indexMessage(chatId, senderName, body) {
  if (!db || !body?.trim()) return;
  const text      = body.trim();
  const createdAt = Date.now();

  db.run(
    "INSERT INTO messages (chat_id, sender_name, body, created_at) VALUES (?, ?, ?, ?)",
    [chatId, senderName, text, createdAt],
    function (err) {
      if (err) return logError(`[many-ai] history insert error: ${err.message}`);
      if (ftsAvailable) {
        db.run(
          "INSERT INTO messages_fts (rowid, body, sender_name, chat_id, created_at) VALUES (?, ?, ?, ?, ?)",
          [this.lastID, text, senderName, chatId, createdAt],
          (err2) => { if (err2) logError(`[many-ai] fts insert error: ${err2.message}`); }
        );
      }
    }
  );

  if (Math.random() < PRUNE_PROBABILITY) pruneOld();
}

function pruneOld() {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  db.run("DELETE FROM messages WHERE created_at < ?", [cutoff]);
  if (ftsAvailable) db.run("DELETE FROM messages_fts WHERE created_at < ?", [cutoff]);
}

function formatRow(r) {
  const date = new Date(r.created_at).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  return `${r.sender_name} (${date}): ${r.body}`;
}

function escapeLike(str) {
  return str.replace(/[\\%_]/g, "\\$&");
}

function likeSearch(chatId, q) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT sender_name, body, created_at FROM messages
       WHERE chat_id = ? AND body LIKE ? ESCAPE '\\'
       ORDER BY created_at DESC LIMIT ?`,
      [chatId, `%${escapeLike(q)}%`, MAX_RESULTS],
      (err, rows) => {
        if (err) { logError(`[many-ai] history LIKE search error: ${err.message}`); return reject(err); }
        resolve(rows.length ? rows.map(formatRow).join(" | ") : "no results found");
      }
    );
  });
}

/** Full-text search of a chat's archived messages. Returns a compact string, never the raw table. */
export function searchHistory(chatId, query) {
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error("history not initialized"));
    const q = (query || "").trim();
    if (!q) return resolve("empty query");
    if (!ftsAvailable) return likeSearch(chatId, q).then(resolve, reject);

    const ftsQuery = q.split(/\s+/).filter(Boolean).map(w => `${w.replace(/["*]/g, "")}*`).join(" ");
    db.all(
      `SELECT sender_name, body, created_at FROM messages_fts
       WHERE chat_id = ? AND messages_fts MATCH ?
       ORDER BY created_at DESC LIMIT ?`,
      [chatId, ftsQuery, MAX_RESULTS],
      (err, rows) => {
        if (err) {
          logError(`[many-ai] FTS search error, falling back to LIKE: ${err.message}`);
          return likeSearch(chatId, q).then(resolve, reject);
        }
        resolve(rows.length ? rows.map(formatRow).join(" | ") : "no results found");
      }
    );
  });
}
