// src/plugins/many-ai/gateway.js
// Single decision point for "should the AI even look at this message".
//
// Two stages, cheapest first:
//   1. preFilter()  — pure JS, no API call. Rules out the vast majority of
//      messages for free (wrong prefix, too short, no name/question/help
//      hint, nothing pending). Returns null when there's nothing worth
//      spending even the cheap model on.
//   2. runGateway()  — one call to a small/cheap Groq model, only for the
//      reasons preFilter flagged as ambiguous. Returns a single verdict.
//
// The expensive agent model (index.js's resolveReply) is only ever invoked
// after this returns ANSWER or MAYBE — it never has to decide for itself
// whether to speak.

import { callGroq } from "./groqClient.js";
import { getKeyPool, withKeyFailover } from "./apiKeys.js";
import { isTooShortToConsider, looksLikeUnansweredQuestion, looksLikeHelpRequest } from "./intervention.js";

export const VERDICT = Object.freeze({
  ANSWER: "ANSWER", // agent must produce a real reply, no SILENT allowed downstream
  MAYBE:  "MAYBE",  // candidate (e.g. unanswered group question) — caller runs the timed wait/confirm flow
  SILENT: "SILENT", // do nothing, agent never sees this message
});

const GATE_MAX_TOKENS = 5; // just enough for one of the three verdict words

// Reasons that are unambiguous on their own — no model call needed at all,
// preFilter's caller should treat these as an immediate ANSWER.
const DETERMINISTIC_REASONS = new Set(["command", "quote"]);

export function isDeterministic(reason) {
  return DETERMINISTIC_REASONS.has(reason);
}

// Reasons that count as "someone is directly addressing the AI" — command,
// quote, continuation, mention. The other reasons (question/help/dm-message)
// are ambient/passive and stay on the existing maybeIntervenePassively /
// maybeInterveneInDM path for now.
export const DIRECT_TRIGGER_REASONS = new Set(["command", "quote", "continuation", "mention"]);

/**
 * Pure heuristics, no network calls. Returns { reason, dm } or null.
 * `reason` is one of: "command" | "quote" | "continuation" | "mention" |
 * "question" | "help" | "dm-message".
 */
export function preFilter({
  msg,
  quotedRaw,
  aiMessageIds,
  wordRE,
  triggers = [],
  commandName,
  hasPendingContinuation = false,
  isGroup = false,
  lang = "pt",
}) {
  if (commandName && msg.is(commandName)) return { reason: "command", dm: !isGroup };

  const quotedId = quotedRaw?.key?.id;
  if (quotedId && aiMessageIds?.has(quotedId)) return { reason: "quote", dm: !isGroup };

  // Replying to someone else's message (not the AI's) is a strong signal
  // the person is talking to THAT sender, not the AI — even if a
  // continuation window happens to be open, don't treat it as continuing
  // with the AI.
  const repliesToSomeoneElse = !!quotedId && !aiMessageIds?.has(quotedId);

  if (hasPendingContinuation && !repliesToSomeoneElse) return { reason: "continuation", dm: !isGroup };

  // A message formatted as a command (e.g. "!outroplugin") belongs to
  // whichever plugin owns that command — never eligible here unless it was
  // this plugin's own command, a quote, or a continuation, all already
  // checked above.
  if (msg.hasPrefix) return null;

  const body = (msg.body || "").trim();
  const mentioned = (wordRE?.test(body)) || triggers.some(tr => body.toLowerCase().includes(tr.toLowerCase()));
  if (mentioned) return { reason: "mention", dm: !isGroup };

  if (isTooShortToConsider(body)) return null;

  if (isGroup) {
    if (looksLikeUnansweredQuestion(body)) return { reason: "question", dm: false };
    if (looksLikeHelpRequest(body, lang)) return { reason: "help", dm: false };
    return null;
  }

  // Private chat, not a trigger, not trivially short — worth asking the
  // gateway whether the person is actually stuck and needs the AI to jump
  // in on its own (still filtered by runGateway, this alone isn't ANSWER).
  return { reason: "dm-message", dm: true };
}

/**
 * Builds the single-word-verdict instruction for the cheap model, tailored
 * to why preFilter flagged this message.
 */
function buildGatewayPrompt(reason, lang, aiName) {
  const name = (aiName || "").trim();
  const pt = lang === "pt";

  const base = pt
    ? `Responda com exatamente uma palavra: ${VERDICT.ANSWER}, ${VERDICT.MAYBE} ou ${VERDICT.SILENT}. Não escreva mais nada.`
    : `Reply with exactly one word: ${VERDICT.ANSWER}, ${VERDICT.MAYBE}, or ${VERDICT.SILENT}. Write nothing else.`;

  switch (reason) {
    case "continuation":
      return pt
        ? `A pessoa acabou de falar com a IA (chamada "${name}") há pouco, numa janela de continuidade. Avalie a mensagem marcada [CURRENT MESSAGE]: ela genuinamente continua essa conversa com a IA, ou é outra coisa (mudou de assunto, está falando com outra pessoa, é só um comentário solto)? Se a mensagem atual for apenas uma mídia sem legenda (aparece como algo do tipo "(image message, no caption)", "(sticker message, no caption)", "(video message, no caption)" ou "(document message, no caption)"), sem nenhum texto real, isso raramente é uma continuação genuína — prefira ${VERDICT.SILENT} nesse caso, a menos que a mensagem anterior da IA deixe claro que uma mídia era esperada como resposta (ex: você pediu uma foto, um print, um documento). ${VERDICT.ANSWER} se continua a conversa com a IA. ${VERDICT.SILENT} caso contrário. ${base}`
        : `The person just talked to the AI (named "${name}") moments ago, inside a continuation window. Evaluate the message tagged [CURRENT MESSAGE]: does it genuinely continue that conversation with the AI, or is it something else (topic change, talking to someone else, an unrelated remark)? If the current message is just a media placeholder with no caption (shows up as something like "(image message, no caption)", "(sticker message, no caption)", "(video message, no caption)", or "(document message, no caption)"), with no real text, that's rarely a genuine continuation — prefer ${VERDICT.SILENT} unless the AI's previous message made clear that a media reply was expected (e.g. you asked for a photo, a screenshot, a document). ${VERDICT.ANSWER} if it continues the conversation with the AI. ${VERDICT.SILENT} otherwise. ${base}`;

    case "mention": {
      const nameNote = name
        ? (pt
            ? ` O nome "${name}" aparecendo no texto NÃO significa que estão chamando a IA — as pessoas falam SOBRE "${name}" sem se dirigir a ela (ex: "o ${name} respondeu isso errado ontem", "vocês viram o site do ${name}?"). Conte como chamada quando o nome aparece sozinho ou é seguido de um pedido/pergunta esperando resposta agora.`
            : ` The name "${name}" showing up in the text does NOT mean the AI is being called — people talk ABOUT "${name}" without addressing it (e.g. "${name} got that wrong yesterday", "did you see ${name}'s site?"). Count it as a call when the name appears alone or is immediately followed by a request/question expecting an answer now.`)
        : "";
      return pt
        ? `Avalie SOMENTE a mensagem [CURRENT MESSAGE]. É uma chamada direta à IA, ou só uma menção a ela numa conversa entre outras pessoas?${nameNote} ${VERDICT.ANSWER} se for chamada direta. ${VERDICT.SILENT} se for só menção. ${base}`
        : `Evaluate ONLY the message tagged [CURRENT MESSAGE]. Is it a direct call to the AI, or just a mention of it in conversation between other people?${nameNote} ${VERDICT.ANSWER} if it's a direct call. ${VERDICT.SILENT} if it's just a mention. ${base}`;
    }

    case "question":
      return pt
        ? `A mensagem [CURRENT MESSAGE] parece uma pergunta feita ao grupo, sem ninguém ter chamado a IA. Vale a pena a IA considerar responder isso (se ninguém mais responder)? ${VERDICT.MAYBE} se for uma pergunta legítima que vale considerar. ${VERDICT.SILENT} se não for realmente uma pergunta que precise de resposta (retórica, já respondida, brincadeira). ${base}`
        : `The message tagged [CURRENT MESSAGE] looks like a question asked to the group, with nobody calling the AI. Is it worth the AI considering an answer (if nobody else replies)? ${VERDICT.MAYBE} if it's a legitimate question worth considering. ${VERDICT.SILENT} if it isn't really a question needing an answer (rhetorical, already answered, a joke). ${base}`;

    case "help":
      return pt
        ? `A mensagem [CURRENT MESSAGE] parece um pedido de ajuda no grupo, sem ninguém ter chamado a IA por nome. A IA deve responder espontaneamente? ${VERDICT.ANSWER} se for um pedido de ajuda genuíno que vale a pena responder. ${VERDICT.SILENT} caso contrário. ${base}`
        : `The message tagged [CURRENT MESSAGE] looks like a help request in the group, with nobody calling the AI by name. Should the AI jump in on its own? ${VERDICT.ANSWER} if it's a genuine help request worth answering. ${VERDICT.SILENT} otherwise. ${base}`;

    case "dm-message":
    default:
      return pt
        ? `Decida se a IA deve responder espontaneamente nesta conversa privada. ${VERDICT.ANSWER} se a pessoa está genuinamente travada e precisa de ajuda (pediu algo específico, bateu num erro, está claramente perdida). ${VERDICT.SILENT} para qualquer outro caso (comentário simples, erro de digitação, algo que outro plugin já resolveria). ${base}`
        : `Decide whether the AI should respond on its own in this private chat. ${VERDICT.ANSWER} if the person is genuinely stuck and needs help (asked for something specific, hit an error, is clearly lost). ${VERDICT.SILENT} for anything else (a simple comment, a typo, something another plugin would already handle). ${base}`;
  }
}

/**
 * Calls the cheap gateway model and returns a VERDICT. Never throws — any
 * failure here just means SILENT, same as the old checkGate behavior.
 */
export async function runGateway({ reason, history, ctx, aiName, lang = "pt", gateModel }) {
  if (isDeterministic(reason)) return VERDICT.ANSWER;

  const keys = getKeyPool(ctx);
  if (!keys.length) return VERDICT.SILENT;

  const prompt = buildGatewayPrompt(reason, lang, aiName);
  try {
    const raw = await withKeyFailover(keys, (key) => callGroq(history, prompt, key, gateModel, GATE_MAX_TOKENS), ctx.log);
    const verdict = raw.trim().toUpperCase();
    if (verdict.startsWith(VERDICT.ANSWER)) return VERDICT.ANSWER;
    if (verdict.startsWith(VERDICT.MAYBE))  return VERDICT.MAYBE;
    return VERDICT.SILENT;
  } catch (err) {
    ctx.log?.error?.(`[many-ai:gateway] error: ${err.message}`);
    return VERDICT.SILENT;
  }
}
