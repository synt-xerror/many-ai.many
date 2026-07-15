// src/plugins/many-ai/apiKeys.js
// Multiple Groq API keys with automatic failover: when a key hits a rate
// limit, looks invalid, or Groq/network hiccups transiently, it's marked as
// cooling down and the next available key is tried — no config change or
// restart needed.

const cooldowns = new Map();  // key -> timestamp (ms) it becomes available again
const invalidKeys = new Set(); // keys that got a 401/403 at least once, for logging only
let rotationIndex = 0;

const DEFAULT_COOLDOWN_MS   = 30_000;
const INVALID_KEY_COOLDOWN_MS = 60 * 60_000; // 1h — retrying an invalid key sooner won't help
const TRANSIENT_COOLDOWN_MS = 5_000;         // 5xx / network errors — likely to clear up fast

/**
 * Reads GROQ_API_KEY (single, back-compat) and GROQ_API_KEYS (array or
 * comma-separated string) from config and returns a deduplicated list.
 */
export function getKeyPool(ctx) {
  const single = ctx.config.get("GROQ_API_KEY");
  const multi  = ctx.config.get("GROQ_API_KEYS");

  const keys = [];
  if (Array.isArray(multi)) keys.push(...multi);
  else if (typeof multi === "string" && multi.trim()) keys.push(...multi.split(",").map(k => k.trim()));
  if (single) keys.push(single);

  return [...new Set(keys.filter(Boolean))];
}

/** Short, safe-to-log identifier for a key — never logs the full secret. */
export function maskKey(key) {
  if (!key || key.length < 10) return "***";
  return `${key.slice(0, 7)}...${key.slice(-4)}`;
}

function isAvailable(key) {
  const until = cooldowns.get(key);
  return !until || Date.now() >= until;
}

function parseRetryMs(text) {
  if (!text) return null;
  const m = String(text).match(/([\d.]+)\s*(ms|s|m|h)?/i);
  if (!m) return null;
  const value = parseFloat(m[1]);
  const mult  = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(m[2] || "s").toLowerCase()] ?? 1000;
  return value * mult;
}

function cooldownMsFor(err) {
  if (err.isInvalidKey) return INVALID_KEY_COOLDOWN_MS;
  if (typeof err.retryMs === "number") return err.retryMs;
  return parseRetryMs(err.retryIn) ?? DEFAULT_COOLDOWN_MS;
}

/**
 * Calls fn(key) for each available key, in rotation order, moving to the
 * next one whenever fn throws a key-retryable error: rate limit (429),
 * rejected/invalid key (401/403), a transient server error (5xx), or a
 * network failure. A non-retryable error (anything else — bad request,
 * unexpected shape, etc.) is assumed to be the same for every key in the
 * pool, so it's thrown immediately instead of burning through all of them.
 * Remembers the last used key so the next call starts from where this one
 * left off (spreads load instead of always hammering key #1).
 * Throws the last retryable error if every key is exhausted.
 *
 * @param {string[]} keys
 * @param {(key: string) => Promise<any>} fn
 * @param {{ info(msg:string):void, warn(msg:string):void }} [log] — optional,
 *   for visibility into rotation/cooldowns while testing a large key pool.
 */
export async function withKeyFailover(keys, fn, log) {
  if (!keys.length) {
    throw Object.assign(new Error("no_api_keys"), { isMissingKey: true });
  }

  const start = rotationIndex % keys.length;
  const ordered = [...keys.slice(start), ...keys.slice(0, start)];
  const skipped = ordered.filter(k => !isAvailable(k));
  if (skipped.length) {
    log?.info?.(`[many-ai:debug] key pool: ${skipped.length}/${keys.length} key(s) cooling down, skipping`);
  }

  let lastErr = null;

  for (const key of ordered) {
    if (!isAvailable(key)) continue;
    try {
      const result = await fn(key);
      const usedIndex = keys.indexOf(key);
      rotationIndex = (usedIndex + 1) % keys.length;
      log?.info?.(`[many-ai:debug] key pool: used key ${maskKey(key)} (#${usedIndex + 1}/${keys.length})`);
      return result;
    } catch (err) {
      if (err.isRateLimit || err.isInvalidKey || err.isTransient) {
        const ms = cooldownMsFor(err);
        cooldowns.set(key, Date.now() + ms);
        if (err.isInvalidKey && !invalidKeys.has(key)) {
          invalidKeys.add(key);
          log?.warn?.(`[many-ai] key ${maskKey(key)} looks invalid/rejected (${err.message}) — check it, cooling down 1h`);
        } else {
          log?.info?.(`[many-ai:debug] key ${maskKey(key)} failed (${err.message}), cooling down ${Math.round(ms / 1000)}s, trying next`);
        }
        lastErr = err;
        continue;
      }
      throw err;
    }
  }

  throw lastErr ?? Object.assign(new Error("all_keys_cooling_down"), { isRateLimit: true });
}
