// src/plugins/many-ai/stickers.js
// Lets Many send stickers on its own initiative. Images live in the plugin's
// data dir under stickers/, described by a stickers.json manifest sitting
// next to them — that manifest is what the model actually reads (as a short
// name + description list in the prompt) to decide which one fits, if any.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { Sticker, StickerTypes } from "wa-sticker-formatter";

const MANIFEST_FILE = "stickers.json";

async function loadManifest(dir) {
  const manifestPath = path.join(dir, MANIFEST_FILE);
  try {
    const raw = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(e => e && typeof e.file === "string" && typeof e.description === "string");
  } catch {
    // Missing/invalid manifest just means no stickers available — never a
    // reason to break the rest of the plugin.
    return [];
  }
}

function findEntry(list, id) {
  const needle = (id || "").trim().toLowerCase();
  return list.find(e =>
    e.file.toLowerCase() === needle ||
    path.parse(e.file).name.toLowerCase() === needle
  );
}

/**
 * Returns the sticker list (short id + description) for the current chat's
 * prompt. Short id is the filename without extension — what STICKER(id)
 * expects as its argument.
 */
export async function listStickers(ctx) {
  const dir = ctx.storage.resolve("stickers");
  const manifest = await loadManifest(dir);
  return manifest.map(e => ({ id: path.parse(e.file).name, description: e.description }));
}

/**
 * Builds a ready-to-send .webp sticker buffer for the given id, with
 * pack/author metadata baked in via wa-sticker-formatter. Throws
 * "sticker-not-found" if id doesn't match any manifest entry.
 */
export async function buildStickerBuffer(ctx, id, { pack, author }) {
  const dir = ctx.storage.resolve("stickers");
  const list = await loadManifest(dir);
  const entry = findEntry(list, id);
  if (!entry) throw new Error("sticker-not-found");

  const source = await readFile(path.join(dir, entry.file));
  const sticker = new Sticker(source, {
    pack,
    author,
    type: StickerTypes.FULL,
    quality: 70,
  });
  return sticker.toBuffer();
}
