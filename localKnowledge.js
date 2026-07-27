// src/plugins/many-ai/localKnowledge.js
// INDEX_SEARCH tool — searches a curated folder of .txt files set up by the
// bot admin (AI_INDEX_DIR), similar in spirit to a skills folder: each file
// is one topic, matched by simple keyword overlap against filename+content.
// No embeddings/vector DB — these are small, hand-curated files, so a plain
// scored match keeps this dependency-free and cheap (single round trip,
// full content returned directly instead of a snippet + second fetch).

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRY_LENGTH = 4000;
const MIN_TOKEN_LENGTH = 3;

let cache = null; // { dir, loadedAt, entries: [{ name, content }] }

async function loadEntries(dir) {
  if (cache && cache.dir === dir && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.entries;
  }

  let files;
  try {
    files = await readdir(dir);
  } catch (err) {
    console.error(`[many-ai:index] readdir(${dir}) failed: ${err.message}`); // ERROR
    cache = { dir, loadedAt: Date.now(), entries: [] };
    return [];
  }

  const entries = [];
  for (const file of files) {
    if (!file.toLowerCase().endsWith(".txt")) continue;
    try {
      const content = (await readFile(path.join(dir, file), "utf8")).trim();
      if (content) entries.push({ name: path.basename(file, ".txt"), content });
    } catch (err) {
      console.error(`[many-ai:index] readFile(${file}) failed: ${err.message}`); // ERROR
      continue;
    }
  }

  cache = { dir, loadedAt: Date.now(), entries };
  return entries;
}

function tokenize(text) {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(w => w.length >= MIN_TOKEN_LENGTH);
}

function scoreEntry(entry, queryTokens) {
  const counts = new Map();
  for (const w of tokenize(`${entry.name} ${entry.content}`)) counts.set(w, (counts.get(w) || 0) + 1);

  let score = 0;
  for (const q of queryTokens) score += counts.get(q) || 0;
  return score;
}

export async function searchLocalIndex(query, dir) {
  const q = (query || "").trim();
  if (!q) throw new Error("empty-query");
  if (!dir) return "No local knowledge index configured.";

  const entries = await loadEntries(dir);
  if (!entries.length) return "No local knowledge index configured.";

  const queryTokens = tokenize(q);
  if (!queryTokens.length) return "No matching entry found in the local knowledge index.";

  let best = null;
  let bestScore = 0;
  for (const entry of entries) {
    const score = scoreEntry(entry, queryTokens);
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }

  if (!best) {
    console.log(`[many-ai:index] "${q}" matched nothing (0 score against ${entries.length} entries)`); // DIAGNOSTIC
    return "No matching entry found in the local knowledge index.";
  }

  const content = best.content.length > MAX_ENTRY_LENGTH
    ? best.content.slice(0, MAX_ENTRY_LENGTH) + "…"
    : best.content;
  return `[${best.name}] ${content}`;
}
