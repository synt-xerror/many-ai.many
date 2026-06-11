// src/plugins/many-ai/memory.js
// Memória persistente da Many — independente do many-ai original.
// Arquivo: src/plugins/many-ai/memory.db

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const sqlite3 = require("sqlite3").verbose();

import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "memory.db");

let apiRef = null;

export function initMemory(api) {
  apiRef = api;
}

function logInfo(msg) {
  if (apiRef) apiRef.log.info(msg);
}

function logError(msg) {
  if (apiRef) apiRef.log.error(msg);
}

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    logError(t("memory.dbOpenError", { error: err.message }));
  }
});

db.run("PRAGMA journal_mode = WAL;", (err) => {
  if (err) logError(t("memory.walError", { error: err.message }));
});

db.run(
  `CREATE TABLE IF NOT EXISTS memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  (err) => {
    if (err) {
      logError(t("memory.tableCreateError", { error: err.message }));
    }
  }
);

export function memWrite(content) {
  return new Promise((resolve, reject) => {
    db.run("INSERT INTO memory (content) VALUES (?)", [content], function(err) {
      if (err) {
        logError(t("memory.insertError", { error: err.message }));
        return reject(err);
      }
      resolve(t("memory.saved"));
    });
  });
}

export function memRead() {
  return new Promise((resolve, reject) => {
    const isAll = query === "*" || query.toLowerCase() === "all" || query.toLowerCase() === "tudo";
    const sql = isAll
      ? "SELECT content FROM memory ORDER BY created_at DESC LIMIT 20"
      : "SELECT content FROM memory WHERE content LIKE ? ORDER BY created_at DESC LIMIT 10";
    const params = isAll ? [] : [`%${query}%`];

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
