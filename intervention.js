// src/plugins/many-ai/intervention.js
// Cheap heuristics used to decide whether a message is even worth spending
// an AI call on for passive intervention (the bot deciding on its own to
// jump into a group conversation). These only filter out obvious noise —
// the actual "should I say something" judgment always comes from the model,
// which defaults to SILENT unless one of the three cases applies:
// unanswered group question, a clear help request, or a worth-fixing error.

const MIN_LENGTH = 12; // shorter than this is almost always "kk", "vlw", a reaction, etc.

const HELP_HINTS_PT = ["alguém", "alguem", "sabe", "ajuda", "como faço", "como faco", "dúvida", "duvida", "erro", "problema"];
const HELP_HINTS_EN = ["anyone", "does anyone", "help", "how do i", "how to", "error", "issue", "problem"];

export function isTooShortToConsider(body) {
  return (body || "").trim().length < MIN_LENGTH;
}

export function looksLikeUnansweredQuestion(body) {
  const text = (body || "").trim();
  return text.endsWith("?") && text.length >= MIN_LENGTH;
}

/** Pre-filter before spending an AI call on the "general" (help/correction) case. */
export function looksLikeHelpRequest(body, language = "pt") {
  const text = (body || "").toLowerCase();
  if (text.includes("?")) return true;
  const hints = language === "pt" ? HELP_HINTS_PT : HELP_HINTS_EN;
  return hints.some(h => text.includes(h));
}
