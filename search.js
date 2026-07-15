// src/plugins/many-ai/search.js

const SEARX_INSTANCES = [
  "https://search.sapti.me",
  "https://search.rhscz.eu",
  "https://search.bus-hit.me",
  "https://search.xcloud.live",
  "https://search.projectsegfault.com",
];

const FETCH_TIMEOUT_MS = 8000;

// Every provider below goes through this instead of raw fetch(). Without a
// timeout here, a hung request to any one provider could stall the whole
// tool-call loop indefinitely — many-ai turns off the framework's own
// 2-minute guard specifically to allow slower multi-step tool use, so it's
// on this file to make sure "slower" never means "forever".
async function fetchWithTimeout(url, options = {}, ms = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function doSearch(query, { TAVILY_API_KEY, SERPER_API_KEY, log } = {}) {
  // 1. Tavily
  if (TAVILY_API_KEY) {
    try {
      const res = await fetchWithTimeout("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: TAVILY_API_KEY,
          query,
          search_depth: "basic",
          max_results: 3,
        }),
      });
      if (!res.ok) {
        log?.warn?.(`[many-ai] Tavily search failed with status ${res.status}, falling back`);
      } else {
        const data = await res.json();
        if (data.results?.length > 0) {
          return data.results.map(r => `${r.title}: ${r.content}`).join(" | ");
        }
      }
    } catch (err) {
      log?.warn?.(`[many-ai] Tavily search errored, falling back: ${err.message}`);
    }
  }

  // 2. Serper
  if (SERPER_API_KEY) {
    try {
      const res = await fetchWithTimeout("https://google.serper.dev/search", {
        method: "POST",
        headers: {
          "X-API-KEY": SERPER_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ q: query, hl: "pt-br" }),
      });
      if (!res.ok) {
        log?.warn?.(`[many-ai] Serper search failed with status ${res.status}, falling back`);
      } else {
        const data = await res.json();
        if (data.organic?.length > 0) {
          return data.organic.slice(0, 3).map(r => `${r.title}: ${r.snippet}`).join(" | ");
        }
      }
    } catch (err) {
      log?.warn?.(`[many-ai] Serper search errored, falling back: ${err.message}`);
    }
  }

  // 3. SearXNG (tries instances in parallel with a timeout)
  const searxResult = await searxSearch(query);
  if (searxResult) return searxResult;

  // 4. DuckDuckGo HTML scrape
  const ddgResult = await ddgSearch(query);
  if (ddgResult) return ddgResult;

  // 5. Wikipedia pt fallback
  return wikiSearch(query);
}

async function searxSearch(query) {
  for (const instance of SEARX_INSTANCES) {
    try {
      const url = `${instance}/search?q=${encodeURIComponent(query)}&format=json&safesearch=0&language=pt-BR`;
      const res = await fetchWithTimeout(url, { headers: { Accept: "application/json" } });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.results?.length > 0) {
        return data.results.slice(0, 3).map(r => `${r.title}: ${r.content || r.title}`).join(" | ");
      }
    } catch (_) {
      continue;
    }
  }
  return null;
}

async function ddgSearch(query) {
  try {
    const res = await fetchWithTimeout(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" } }
    );
    const html = await res.text();
    const results = [];
    const blocks = html.split('class="result"');

    for (let i = 1; i < blocks.length && results.length < 3; i++) {
      const block = blocks[i];
      const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)/);
      const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
      const title = titleMatch?.[1]?.trim() ?? "";
      const snippet = snippetMatch?.[1]
        ?.replace(/<[^>]+>/g, "")
        ?.replace(/\s+/g, " ")
        ?.trim() ?? "";
      if (title || snippet) results.push(`${title}: ${snippet}`.replace(/: $/, ""));
    }

    return results.length > 0 ? results.join(" | ") : null;
  } catch (_) {
    return null;
  }
}

async function wikiSearch(query) {
  try {
    const res = await fetchWithTimeout(
      `https://pt.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`
    );
    const data = await res.json();
    return data.extract || "No result.";
  } catch (_) {
    return "Couldn't find any information.";
  }
}
