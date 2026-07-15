// src/plugins/many-ai/voice.js
// Turns a WhatsApp voice note / audio message into text via Groq's Whisper
// endpoint (same API key pool + failover as the chat model). Free tier
// covers this comfortably for normal group volume — see README.

import { withKeyFailover } from "./apiKeys.js";

async function callTranscription(buffer, mimetype, apiKey, model) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimetype || "audio/ogg" }), "audio.ogg");
  form.append("model", model);
  form.append("response_format", "text");

  let res;
  try {
    res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method:  "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } catch (netErr) {
    const e = new Error(`network error: ${netErr.message}`);
    e.isTransient = true;
    throw e;
  }

  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 429) {
      const e = new Error("rate_limit");
      e.isRateLimit = true;
      throw e;
    }
    if (res.status === 401 || res.status === 403) {
      const e = new Error(`key rejected (${res.status})`);
      e.isInvalidKey = true;
      throw e;
    }
    if (res.status >= 500) {
      const e = new Error(`Groq transcription error ${res.status}`);
      e.isTransient = true;
      throw e;
    }
    throw new Error(`Groq transcription error ${res.status}: ${errText}`);
  }
  return (await res.text()).trim();
}

/**
 * Transcribes the CURRENT message's audio (the direct, fully-supported
 * path — msg.downloadMedia() is a documented part of the plugin API).
 * Returns "" on any failure; callers treat that as "couldn't transcribe",
 * never as something to surface as an error to people who didn't ask.
 */
export async function transcribeCurrentMessage(msg, ctx, keys, model) {
  try {
    const media = await msg.downloadMedia();
    if (!media?.data) return "";
    const buffer = Buffer.from(media.data, "base64");
    return await withKeyFailover(keys, (key) => callTranscription(buffer, media.mimetype, key, model), ctx.log);
  } catch (err) {
    ctx.log.error(`[many-ai] transcription error: ${err.message}`);
    return "";
  }
}

// Lazily (and only once) tries to load baileys' own downloadMediaMessage —
// the plugin API doesn't expose a way to download an arbitrary QUOTED
// message's media, only the current one. This is a best-effort fallback
// for "reply to a voice note and ask about it", not an officially
// guaranteed part of the plugin API — if it ever breaks (dependency not
// installed, or a Baileys version mismatch), quoted-audio transcription
// just silently stops working instead of crashing anything.
let downloadMediaMessageFn; // undefined = not tried yet, false = tried and failed, function = ready
async function getDownloadMediaMessage() {
  if (downloadMediaMessageFn !== undefined) return downloadMediaMessageFn;
  try {
    const mod = await import("baileys");
    downloadMediaMessageFn = mod.downloadMediaMessage ?? false;
  } catch {
    downloadMediaMessageFn = false;
  }
  return downloadMediaMessageFn;
}

/** Best-effort transcription of a QUOTED audio message. See note above. */
export async function transcribeQuotedMessage(quotedRaw, ctx, keys, model) {
  try {
    const downloadMediaMessage = await getDownloadMediaMessage();
    if (!downloadMediaMessage) return "";
    const buffer = await downloadMediaMessage(quotedRaw, "buffer", {});
    if (!buffer || !Buffer.isBuffer(buffer)) return "";
    const mimetype = quotedRaw.message?.audioMessage?.mimetype || "audio/ogg";
    return await withKeyFailover(keys, (key) => callTranscription(buffer, mimetype, key, model), ctx.log);
  } catch (err) {
    ctx.log.info(`[many-ai] couldn't transcribe quoted audio, staying silent about it: ${err.message}`);
    return "";
  }
}
