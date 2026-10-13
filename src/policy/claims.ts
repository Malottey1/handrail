// What the agent said about a call, in its own words: notes, reasons,
// descriptions. Shown to approvers as "Agent says (unverified)" and given to
// the AI as untrusted data, never mixed with what PayPal verified.

/** Argument names that carry the agent's free text rather than ids or amounts. */
const CLAIM_FIELDS = ["reason", "note", "note_to_payer", "notes", "memo", "description", "message", "comment", "justification", "explanation"];

export interface AgentClaim {
  field: string;
  text: string;
}

export function agentClaims(args: Record<string, unknown>): AgentClaim[] {
  return CLAIM_FIELDS.flatMap((field) => {
    const v = args[field];
    return typeof v === "string" && v.trim() ? [{ field, text: v.trim().slice(0, 2000) }] : [];
  });
}
