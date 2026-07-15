// src/plugins/many-ai/tools.js
// Extra tools Many can call besides search and memory.
// Each function throws an Error on invalid arguments, or returns structured
// data for the caller to turn into a tool result (see index.js). None of
// these functions write a final user-facing sentence themselves — that's
// the model's job, using the data returned here.

const SAFE_MATH_RE = /^[0-9+\-*/%.,()\s^]+$/;
const MAX_EXPR_LENGTH = 200; // real calculator expressions are always short

/**
 * Safely evaluates a simple math expression (character whitelist before any
 * evaluation — no access to outer scope, and a length cap against
 * pathological input).
 */
export function safeCalc(expression) {
  const expr = (expression || "").trim();
  if (!expr) throw new Error("empty-expression");
  if (expr.length > MAX_EXPR_LENGTH) throw new Error("expression-too-long");
  if (!SAFE_MATH_RE.test(expr)) throw new Error("invalid-characters");

  const normalized = expr.replace(/,/g, ".").replace(/\^/g, "**");

  let result;
  try {
    // eslint-disable-next-line no-new-func
    result = new Function(`"use strict"; return (${normalized});`)();
  } catch {
    throw new Error("parse-error");
  }

  if (typeof result !== "number" || !Number.isFinite(result)) {
    throw new Error("non-finite-result");
  }
  return result;
}

const ADMIN_ROLE_MARKERS = new Set(["admin", "superadmin"]);

// The exact shape of ctx.chat.getParticipants() entries isn't nailed down in
// the docs, so this checks a few plausible field names rather than assuming
// one — if none match, admins just comes back empty instead of throwing.
function isParticipantAdmin(participant) {
  if (!participant) return false;
  if (typeof participant.admin === "string") return ADMIN_ROLE_MARKERS.has(participant.admin);
  if (typeof participant.isAdmin === "boolean") return participant.isAdmin;
  if (typeof participant.role === "string") return ADMIN_ROLE_MARKERS.has(participant.role.toLowerCase());
  return false;
}

/**
 * Group info the model can turn into a natural reply — name, participant
 * and admin counts, admin display names, and whether the bot itself is
 * admin here. Returns { isGroup: false } outside of groups.
 */
export async function getGroupInfo(ctx) {
  if (!ctx.chat.isGroup) return { isGroup: false };

  const participants = (await ctx.chat.getParticipants()) || [];
  const adminParticipants = participants.filter(isParticipantAdmin);

  const admins = [];
  for (const p of adminParticipants) {
    const id = p.id || p.jid || p.contactId;
    if (!id) continue;
    try {
      const contact = await ctx.contacts.get(id);
      admins.push(contact?.pushname || contact?.name || contact?.shortName || id.split("@")[0]);
    } catch {
      admins.push(id.split("@")[0]);
    }
  }

  const botIsAdmin = await ctx.chat.isBotAdmin();

  return {
    isGroup: true,
    name: ctx.chat.name,
    participantCount: participants.length,
    adminCount: adminParticipants.length,
    admins,
    botIsAdmin,
  };
}
