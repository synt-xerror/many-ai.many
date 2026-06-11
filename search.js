// src/plugins/many-ai/search.js

const SEARX_INSTANCES = [
  "https://search.sapti.me",
  "https://search.rhscz.eu",
  "https://search.bus-hit.me",
  "https://search.xcloud.live",
  "https://search.projectsegfault.com",
];

export async function doSearch(query, { TAVILY_API_KEY, SERPER_API_KEY } = {}) {
  // 1. Tavily
  if (TAVILY_API_KEY) {
    try {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: TAVILY_API_KEY,
          query,
          search_depth: "basic",
          max_results: 3,
        }),
      });
      const data = await res.json();
      if (data.results?.length > 0) {
        return data.results.map(r => `${r.title}: ${r.content}`).join(" | ");
      }
    } catch (_) {}
  }

  // 2. Serper
  if (SERPER_API_KEY) {
    try {
      const res = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: {
          "X-API-KEY": SERPER_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ q: query, hl: "pt-br" }),
      });
      const data = await res.json();
      if (data.organic?.length > 0) {
        return data.organic.slice(0, 3).map(r => `${r.title}: ${r.snippet}`).join(" | ");
      }
    } catch (_) {}
  }

  // 3. SearXNG (tenta instâncias em paralelo com timeout)
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
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      clearTimeout(timeout);

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
    const res = await fetch(
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
    const res = await fetch(
      `https://pt.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`
    );
    const data = await res.json();
    return data.extract || "Sem resultado.";
  } catch (_) {
    return "Não foi possível encontrar informações.";
  }
}