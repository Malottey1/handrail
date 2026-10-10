import { EventEmitter } from "node:events";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { FINAL_STATUSES, type Approval, type ApprovalStore } from "./approvals.js";
import type { CallLog } from "./audit.js";
import { log } from "./log.js";
import type { PayPalRest } from "./paypal/rest.js";
import { evaluate } from "./policy/engine.js";
import { resolveFacts } from "./policy/facts.js";
import { formatMoney } from "./policy/money.js";
import type { CallFacts, Evaluation, Policy } from "./policy/types.js";

export const GET_APPROVAL_TOOL: Tool = {
  name: "handrail_get_approval",
  description:
    "Check a PayPal action that Handrail held for human approval. Returns its status " +
    "(pending, executed, failed, rejected, blocked, expired) and, once executed, PayPal's result. " +
    "Optionally waits up to wait_seconds for a decision.",
  inputSchema: {
    type: "object",
    properties: {
      approval_id: { type: "string", description: "The approval_id Handrail returned when it held the call." },
      wait_seconds: { type: "number", description: "Wait up to this many seconds (max 25) for a decision." },
    },
    required: ["approval_id"],
  },
};

const MAX_TOOL_WAIT_MS = 25_000;

export interface GateOptions {
  /** How long a held call waits inline for a human before returning "pending". */
  approvalWaitMs: number;
  /** How long a held call stays approvable. */
  approvalTtlMs: number;
  now?: () => number;
}

export class DecisionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Sits between the agent and PayPal. Every tool call is resolved to facts,
 * checked against the policy, then forwarded, blocked, or held for a human.
 */
export class Gate {
  private readonly events = new EventEmitter();
  private readonly now: () => number;

  constructor(
    private readonly upstream: Client,
    private readonly rest: PayPalRest,
    private readonly callLog: CallLog,
    private readonly approvals: ApprovalStore,
    private readonly policy: () => Policy,
    private readonly options: GateOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.events.setMaxListeners(0);
    setInterval(() => this.expireOverdue(), 30_000).unref();
  }

  async handle(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (tool === GET_APPROVAL_TOOL.name) return this.getApprovalTool(args);

    const facts = await resolveFacts(tool, args, this.rest);

    // Evaluate and record in one synchronous step (see CallLog.begin).
    const now = this.now();
    const evaluation = this.evaluate(facts, now);
    const forwarded = evaluation.decision === "allow";
    const approval =
      evaluation.decision === "require_approval" ? this.approvals.create(facts, evaluation, now, this.options.approvalTtlMs) : null;
    const callId = this.callLog.begin(facts, evaluation, { forwarded, approvalId: approval?.id, now });

    log(`${tool} -> ${evaluation.decision}: ${evaluation.reason}${describeAmount(facts)}`);

    if (evaluation.decision === "allow") {
      return this.forward(callId, tool, args);
    }

    if (evaluation.decision === "block") {
      const result = handrailResult(
        {
          status: "blocked",
          tool,
          reason: evaluation.reason,
          rules: evaluation.hits.filter((h) => h.decision === "block").map((h) => h.ruleId),
          next_step: "This action is not allowed by policy. Do not retry it. Tell the user why it was blocked.",
        },
        true,
      );
      this.callLog.finish(callId, result, true, 0);
      return result;
    }

    const held = approval!;
    this.callLog.finish(callId, { handrail: { status: "pending_approval", approval_id: held.id } }, false, 0);
    const settled = await this.waitForFinal(held.id, this.options.approvalWaitMs);
    return this.approvalResult(settled);
  }

  /** Approves a held call and forwards it to PayPal exactly once. */
  async approve(id: string, by: string, note: string | null): Promise<Approval> {
    this.expireOverdue();
    const now = this.now();
    if (!this.approvals.decide(id, "executing", by, note, now)) {
      throw this.notPending(id);
    }

    const approval = this.approvals.get(id)!;
    // Re-check with approval granted: limits may have been used up while it waited,
    // and an approval never overrides a block.
    const evaluation = this.evaluate(approval.facts, now, true);
    if (evaluation.decision !== "allow") {
      const result = handrailResult({ status: "blocked", tool: approval.tool, reason: evaluation.reason, approval_id: id }, true);
      this.approvals.complete(id, "blocked", result);
      log(`${approval.tool} approval ${id} by ${by} -> blocked at execution: ${evaluation.reason}`);
      return this.settle(id);
    }

    const callId = this.callLog.begin(approval.facts, evaluation, { forwarded: true, approvalId: id, now });
    log(`${approval.tool} approval ${id} approved by ${by}; forwarding`);
    const result = await this.forward(callId, approval.tool, approval.args);
    this.approvals.complete(id, isUpstreamError(result) ? "failed" : "executed", result);
    return this.settle(id);
  }

  reject(id: string, by: string, note: string | null): Approval {
    this.expireOverdue();
    if (!this.approvals.decide(id, "rejected", by, note, this.now())) {
      throw this.notPending(id);
    }
    log(`approval ${id} rejected by ${by}${note ? `: ${note}` : ""}`);
    return this.settle(id);
  }

  getApproval(id: string): Approval | null {
    this.expireOverdue();
    return this.approvals.get(id);
  }

  listApprovals(status?: Approval["status"]): Approval[] {
    this.expireOverdue();
    return this.approvals.list(status);
  }

  private evaluate(facts: CallFacts, now: number, approved = false): Evaluation {
    const policy = this.policy();
    const longestWindow = Math.max(86400, ...policy.rules.map((r) => ("windowSeconds" in r ? r.windowSeconds : 0)));
    const history = this.callLog.history(now - longestWindow * 1000);
    return evaluate({ facts, policy, history, now, approved });
  }

  private async forward(callId: number, tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const started = performance.now();
    let result: CallToolResult;
    try {
      result = (await this.upstream.callTool({ name: tool, arguments: args })) as CallToolResult;
    } catch (err) {
      // Surface upstream failures to the agent as a tool error, not a protocol error.
      result = { content: [{ type: "text", text: `Upstream PayPal MCP error: ${(err as Error).message}` }], isError: true };
    }
    const durationMs = performance.now() - started;
    const failed = isUpstreamError(result);
    this.callLog.finish(callId, result, failed, durationMs);
    log(`${tool} forwarded: ${failed ? "ERROR" : "ok"} ${Math.round(durationMs)}ms`);
    return result;
  }

  private async getApprovalTool(args: Record<string, unknown>): Promise<CallToolResult> {
    const id = typeof args.approval_id === "string" ? args.approval_id : "";
    if (!this.getApproval(id)) {
      return handrailResult({ status: "not_found", approval_id: id }, true);
    }
    const waitMs = Math.min(Math.max(Number(args.wait_seconds) || 0, 0) * 1000, MAX_TOOL_WAIT_MS);
    return this.approvalResult(await this.waitForFinal(id, waitMs));
  }

  /** Resolves when the approval reaches a final status, or after `ms` with its current state. */
  private waitForFinal(id: string, ms: number): Promise<Approval> {
    const current = this.getApproval(id)!;
    if (FINAL_STATUSES.has(current.status) || ms <= 0) return Promise.resolve(current);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.events.off(id, done);
        resolve(this.getApproval(id)!);
      };
      const timer = setTimeout(done, ms);
      this.events.on(id, done);
    });
  }

  private approvalResult(approval: Approval): CallToolResult {
    const base = { approval_id: approval.id, tool: approval.tool };
    switch (approval.status) {
      case "executed":
      case "failed": {
        // PayPal's result, unchanged, after a note saying who approved it.
        const upstream = approval.result as CallToolResult;
        const note = `[Handrail] ${approval.tool} was approved by ${approval.decidedBy} (approval ${approval.id}) and forwarded to PayPal.`;
        return { ...upstream, content: [{ type: "text", text: note }, ...(upstream.content ?? [])] };
      }
      case "pending":
      case "executing":
        return handrailResult(
          {
            status: "pending_approval",
            ...base,
            reason: approval.evaluation.reason,
            expires_at: new Date(approval.expiresAt).toISOString(),
            next_step:
              "NOT EXECUTED YET. A human must approve this action. Tell the user it is awaiting approval, " +
              `then call handrail_get_approval with approval_id "${approval.id}" to check. Do not retry the original call.`,
          },
          false,
        );
      case "rejected":
        return handrailResult(
          {
            status: "rejected",
            ...base,
            decided_by: approval.decidedBy,
            note: approval.note,
            next_step: "A human rejected this action. It was not executed. Do not retry it.",
          },
          true,
        );
      case "blocked":
        return approval.result as CallToolResult;
      case "expired":
        return handrailResult(
          { status: "expired", ...base, next_step: "Nobody approved this action in time. It was not executed." },
          true,
        );
    }
  }

  private settle(id: string): Approval {
    this.events.emit(id);
    return this.approvals.get(id)!;
  }

  private notPending(id: string): DecisionError {
    const approval = this.approvals.get(id);
    return approval
      ? new DecisionError(`Approval ${id} is ${approval.status}, not pending`, 409)
      : new DecisionError(`Approval ${id} not found`, 404);
  }

  private expireOverdue(): void {
    for (const id of this.approvals.expireOverdue(this.now())) {
      log(`approval ${id} expired`);
      this.events.emit(id);
    }
  }
}

/**
 * PayPal's MCP server reports API failures as a normal result (isError false)
 * whose text is JSON like {"ok":false,"status":404,...}. Treat those as errors
 * too, so failed calls don't count toward spend limits or show as executed.
 */
export function isUpstreamError(result: CallToolResult): boolean {
  if (result.isError) return true;
  const first = result.content?.[0];
  if (first?.type !== "text") return false;
  try {
    const body: unknown = JSON.parse(first.text);
    return typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === false;
  } catch {
    return false;
  }
}

function handrailResult(payload: Record<string, unknown>, isError: boolean): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ handrail: payload }, null, 2) }], isError };
}

function describeAmount(facts: CallFacts): string {
  return facts.amount ? ` [${formatMoney(facts.amount)} from ${facts.amountSource}]` : "";
}
