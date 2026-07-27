// src/plugins/many-ai/wikipedia.js
// WIKI_SEARCH / WIKI_FETCH tools — free, no API key, used before the paid
// SEARCH chain for encyclopedic/historical/general-knowledge questions.
// Both steps prefer the bot's configured LANGUAGE edition of Wikipedia and
// fall back to English if that edition has nothing.

import { fetchWithTimeout } from "./httpUtils.js";

const WIKI_LANGS = new Set(["pt", "en", "es"]);
const FALLBACK_LANG = "en";
const MAX_EXTRACT_LENGTH = 4000;

function wikiLang(lang) {
  return WIKI_LANGS.has(lang) ? lang : "pt";
}

export async function wikiSearchTitles(query, lang) {
  const q = (query || "").trim();
  if (!q) throw new Error("empty-query");

  const primary = wikiLang(lang);
  const results = await opensearch(q, primary);
  if (results.length) return formatTitles(results);

  if (primary !== FALLBACK_LANG) {
    const fallback = await opensearch(q, FALLBACK_LANG);
    if (fallback.length) return formatTitles(fallback);
  }

  console.log(`[many-ai:wiki] SEARCH "${q}" no results in any language`); // DIAGNOSTIC: total miss, worth knowing if this fires a lot
  return "No matching Wikipedia article found.";
}

async function opensearch(query, lang) {
  try {
    const url = `https://${lang}.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=5&format=json`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      console.error(`[many-ai:wiki] opensearch(${lang}) HTTP ${res.status}`); // ERROR
      return [];
    }
    const [, titles, descriptions] = await res.json();
    return titles.map((title, i) => ({ title, description: descriptions[i] || "", lang }));
  } catch (err) {
    console.error(`[many-ai:wiki] opensearch(${lang}) error: ${err.message}`); // ERROR
    return [];
  }
}

function formatTitles(entries) {
  return entries.map(e => `${e.title} (${e.lang}): ${e.description}`.replace(/: $/, "")).join(" | ");
}

export async function wikiFetchArticle(title, lang) {
  const t = (title || "").trim();
  if (!t) throw new Error("empty-title");

  const langs = [...new Set([wikiLang(lang), FALLBACK_LANG])];
  for (const candidate of langs) {
    const article = await fetchExtract(t, candidate);
    if (article) return article;
  }
  console.log(`[many-ai:wiki] FETCH "${t}" not found in any language`); // DIAGNOSTIC: total miss
  return "Couldn't fetch that Wikipedia article.";
}

async function fetchExtract(title, lang) {
  try {
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=${encodeURIComponent(title)}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      console.error(`[many-ai:wiki] fetchExtract(${lang}) HTTP ${res.status}`); // ERROR
      return null;
    }
    const data = await res.json();
    const page = Object.values(data?.query?.pages || {})[0];
    if (!page || page.missing !== undefined || !page.extract) return null;

    const extract = page.extract.trim();
    return extract.length > MAX_EXTRACT_LENGTH ? extract.slice(0, MAX_EXTRACT_LENGTH) + "…" : extract;
  } catch (err) {
    console.error(`[many-ai:wiki] fetchExtract(${lang}) error: ${err.message}`); // ERROR
    return null;
  }
}
