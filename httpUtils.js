// src/plugins/many-ai/httpUtils.js
// Shared HTTP helper. many-ai turns off the framework's own 2-minute guard
// to allow slower multi-step tool use, so every outbound request in this
// plugin goes through here instead of raw fetch() — no request is allowed
// to stall the tool-call loop indefinitely.

export const DEFAULT_FETCH_TIMEOUT_MS = 8000;

export async function fetchWithTimeout(url, options = {}, ms = DEFAULT_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
