// src/plugins/many-ai/groqClient.js
// Thin wrapper around the Groq chat completions endpoint. Extracted out of
// index.js so both the main agent (index.js) and the gateway (gateway.js)
// can call Groq without importing from each other.

const MAX_HISTORY_SEND = 10;

export function toApiMessages(history, systemPrompt) {
  const messages = history.slice(-MAX_HISTORY_SEND).map(entry => {
    if (entry.kind !== "chat") return { role: entry.role, content: entry.content };
    const tag = entry.current
      ? "[CURRENT MESSAGE — this is the one you should answer]"
      : "[OLD MESSAGE — background context only, don't reply to it unless it's quoted or truly needed]";
    return { role: entry.role, content: `${tag}\n${entry.content}` };
  });
  return [{ role: "system", content: systemPrompt }, ...messages];
}

// Some Groq models (e.g. gpt-oss) support native function-calling and will
// sometimes attempt it even though we only ask for plain-text "COMMAND(arg)"
// output and never declare a `tools` array. Groq then rejects the whole
// request with 400 tool_use_failed. Rather than surfacing that as an error,
// pull the attempted call out of failed_generation and hand it back in the
// same plain-text shape parseReply() already understands, so the tool still
// runs normally.
function recoverNativeToolCall(errBody) {
  let parsed;
  try { parsed = JSON.parse(errBody); } catch { return null; }
  if (parsed?.error?.code !== "tool_use_failed") return null;

  let gen;
  try { gen = JSON.parse(parsed.error.failed_generation); } catch { return null; }
  const name = gen?.name;
  if (!name) return null;

  const argValue = Object.values(gen.arguments || {})[0] ?? "";
  return `${name}(${argValue})`;
}

export async function callGroq(history, systemPrompt, apiKey, MODEL, maxTokens) {
  let res;
  try {
    res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model:      MODEL,
        messages:   toApiMessages(history, systemPrompt),
        max_tokens: maxTokens,
      }),
    });
  } catch (netErr) {
    const e = new Error(`network error: ${netErr.message}`);
    e.isTransient = true;
    throw e;
  }

  if (!res.ok) {
    const body = await res.text();

    if (res.status === 429) {
      let retryIn = null;
      try {
        const { error } = JSON.parse(body);
        retryIn = error?.message?.match(/try again in (\S+)\./i)?.[1] ?? null;
      } catch { /* fall through to generic error below */ }
      const e = new Error("rate_limit");
      e.isRateLimit = true;
      e.retryIn = retryIn;
      throw e;
    }
    if (res.status === 401 || res.status === 403) {
      const e = new Error(`key rejected (${res.status})`);
      e.isInvalidKey = true;
      throw e;
    }
    if (res.status === 400) {
      const recovered = recoverNativeToolCall(body);
      if (recovered) return recovered;
    }
    if (res.status >= 500) {
      const e = new Error(`Groq API error ${res.status}`);
      e.isTransient = true;
      throw e;
    }
    throw new Error(`Groq API error ${res.status}: ${body}`);
  }
  const data = await res.json();
  const choice = data.choices[0];
  const content = (choice.message.content || "").trim();
  return content;
}
