import { EventEmitter } from "node:events";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { FINAL_STATUSES, type Approval, type ApprovalStore } from "./approvals.js";
import type { CallLog } from "./audit.js";
import { classifyOutcome, operationKey, type Operation, type OperationKey, type OperationStore } from "./idempotency.js";
import { log } from "./log.js";
import { DIRECT_TOOLS, NoResponseError, type PayPalDirect } from "./paypal/direct.js";
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
/** Longest a duplicate waits for the original call to finish. */
const MAX_IN_FLIGHT_WAIT_MS = 90_000;

export interface GateDeps {
  upstream: Client;
  rest: PayPalRest;
  direct: Pick<PayPalDirect, "call">;
  callLog: CallLog;
  approvals: ApprovalStore;
  operations: OperationStore;
  policy: () => Policy;
}

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
 * Sits between the agent and PayPal. Every tool call is matched to a logical
 * operation (so retries never run twice), resolved to facts, checked against
 * the policy, then forwarded, blocked, or held for a human.
 */
export class Gate {
  private readonly events = new EventEmitter();
  private readonly now: () => number;

  constructor(
    private readonly deps: GateDeps,
    private readonly options: GateOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.events.setMaxListeners(0);
    this.recoverInterrupted();
    setInterval(() => this.expireOverdue(), 30_000).unref();
  }

  async handle(tool: string, rawArgs: Record<string, unknown>): Promise<CallToolResult> {
    if (tool === GET_APPROVAL_TOOL.name) return this.getApprovalTool(rawArgs);

    const op = operationKey(tool, rawArgs);
    const args = op?.args ?? rawArgs;

    // Cheap check first, so a retry storm doesn't trigger a fact lookup per call.
    const early = op && this.duplicate(op, tool);
    if (early) return early;

    const facts = await resolveFacts(tool, args, this.deps.rest);

    // From here to forwarding there is no await: the duplicate check, policy
    // evaluation and the records it creates happen atomically, so concurrent
    // calls can neither both run nor both slip under a limit.
    const late = op && this.duplicate(op, tool);
    if (late) return late;

    const now = this.now();
    const previous = op ? this.deps.operations.get(op.key, now) : null;
    let evaluation = this.evaluate(facts, now);
    if (previous?.status === "unknown" && !DIRECT_TOOLS.has(tool)) {
      evaluation = holdForUnknownOutcome(evaluation, tool);
    }

    const approval =
      evaluation.decision === "require_approval"
        ? this.deps.approvals.create(facts, evaluation, now, this.options.approvalTtlMs)
        : null;
    const operation =
      op && evaluation.decision !== "block"
        ? this.deps.operations.begin(op, tool, approval ? "pending_approval" : "in_flight", approval?.id ?? null, now)
        : null;
    const callId = this.deps.callLog.begin(facts, evaluation, {
      forwarded: evaluation.decision === "allow",
      approvalId: approval?.id,
      operationKey: op?.key,
      requestId: operation && DIRECT_TOOLS.has(tool) ? operation.requestId : undefined,
      now,
    });

    log(`${tool} -> ${evaluation.decision}: ${evaluation.reason}${describeAmount(facts)}`);

    if (evaluation.decision === "allow") {
      return this.forward(callId, tool, args, operation);
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
      this.deps.callLog.finish(callId, result, "blocked", 0, this.now());
      return result;
    }

    const held = approval!;
    this.deps.callLog.finish(callId, { handrail: { status: "pending_approval", approval_id: held.id } }, "held", 0, this.now());
    return this.approvalResult(await this.waitForFinal(held.id, this.options.approvalWaitMs));
  }

  /** Approves a held call and forwards it to PayPal exactly once. */
  async approve(id: string, by: string, note: string | null): Promise<Approval> {
    this.expireOverdue();
    const now = this.now();
    if (!this.deps.approvals.decide(id, "executing", by, note, now)) {
      throw this.notPending(id);
    }

    const approval = this.deps.approvals.get(id)!;
    const operation = this.deps.operations.byApproval(id);

    // Re-check with approval granted: limits may have been used up while it waited,
    // and an approval never overrides a block.
    const evaluation = this.evaluate(approval.facts, now, true);
    if (evaluation.decision !== "allow") {
      const result = handrailResult({ status: "blocked", tool: approval.tool, reason: evaluation.reason, approval_id: id }, true);
      this.deps.approvals.complete(id, "blocked", result, this.now());
      if (operation) this.finishOperation(operation, "abandoned", result);
      log(`${approval.tool} approval ${id} by ${by} -> blocked at execution: ${evaluation.reason}`);
      return this.settle(id);
    }

    if (operation) this.deps.operations.setStatus(operation.key, "in_flight", now);
    const callId = this.deps.callLog.begin(approval.facts, evaluation, {
      forwarded: true,
      approvalId: id,
      operationKey: operation?.key,
      requestId: operation && DIRECT_TOOLS.has(approval.tool) ? operation.requestId : undefined,
      now,
    });
    log(`${approval.tool} approval ${id} approved by ${by}; forwarding`);
    const result = await this.forward(callId, approval.tool, approval.args, operation);
    this.deps.approvals.complete(id, classifyOutcome(result, false) === "succeeded" ? "executed" : "failed", result, this.now());
    return this.settle(id);
  }

  reject(id: string, by: string, note: string | null): Approval {
    this.expireOverdue();
    if (!this.deps.approvals.decide(id, "rejected", by, note, this.now())) {
      throw this.notPending(id);
    }
    const operation = this.deps.operations.byApproval(id);
    if (operation) this.finishOperation(operation, "rejected");
    log(`approval ${id} rejected by ${by}${note ? `: ${note}` : ""}`);
    return this.settle(id);
  }

  getApproval(id: string): Approval | null {
    this.expireOverdue();
    return this.deps.approvals.get(id);
  }

  listApprovals(status?: Approval["status"]): Approval[] {
    this.expireOverdue();
    return this.deps.approvals.list(status);
  }

  /**
   * If this call repeats a live operation, answers it without contacting PayPal
   * and returns the answer; otherwise returns null and the call proceeds.
   * Failed, unknown and abandoned operations proceed as a new attempt.
   */
  private duplicate(op: OperationKey, tool: string): Promise<CallToolResult> | null {
    this.expireOverdue(); // an expired approval frees its operation for a new attempt
    const now = this.now();
    const existing = this.deps.operations.get(op.key, now);
    if (!existing) return null;

    const record = () => {
      this.deps.callLog.recordDuplicate(tool, op.args, op.key, now);
      log(`${tool} -> duplicate of operation started ${new Date(existing.createdAt).toISOString()} (${existing.status}); not sent again`);
    };

    switch (existing.status) {
      case "succeeded":
        record();
        return Promise.resolve(duplicateResult(existing));
      case "in_flight":
        record();
        return this.waitForOperation(existing.key).then(duplicateResult);
      case "pending_approval":
      case "rejected":
        record();
        return this.waitForFinal(existing.approvalId!, existing.status === "pending_approval" ? this.options.approvalWaitMs : 0).then(
          (approval) => this.approvalResult(approval),
        );
      default:
        return null;
    }
  }

  private evaluate(facts: CallFacts, now: number, approved = false): Evaluation {
    const policy = this.deps.policy();
    const longestWindow = Math.max(86400, ...policy.rules.map((r) => ("windowSeconds" in r ? r.windowSeconds : 0)));
    const history = this.deps.callLog.history(now - longestWindow * 1000);
    return evaluate({ facts, policy, history, now, approved });
  }

  private async forward(callId: number, tool: string, args: Record<string, unknown>, operation: Operation | null): Promise<CallToolResult> {
    const direct = operation !== null && DIRECT_TOOLS.has(tool);
    const started = performance.now();
    let result: CallToolResult;
    let threw = false;
    try {
      result = direct
        ? await this.deps.direct.call(tool, args, operation.requestId)
        : ((await this.deps.upstream.callTool({ name: tool, arguments: args })) as CallToolResult);
    } catch (err) {
      threw = true;
      result = unknownOutcomeResult(tool, err as Error, direct);
    }
    const durationMs = performance.now() - started;
    const outcome = classifyOutcome(result, threw);

    this.deps.callLog.finish(callId, result, outcome, durationMs, this.now());
    if (operation) this.finishOperation(operation, outcome, result);
    log(`${tool} ${direct ? `sent directly (PayPal-Request-Id ${operation!.requestId})` : "forwarded"}: ${outcome} ${Math.round(durationMs)}ms`);
    return result;
  }

  private finishOperation(operation: Operation, status: Parameters<OperationStore["setStatus"]>[1], result?: CallToolResult): void {
    this.deps.operations.setStatus(operation.key, status, this.now(), result);
    this.events.emit(`op:${operation.key}`);
  }

  private waitForOperation(key: string): Promise<Operation> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.events.off(`op:${key}`, done);
        // Read without the window check: the original may have just crossed it.
        resolve(this.deps.operations.get(key, 0)!);
      };
      const timer = setTimeout(done, MAX_IN_FLIGHT_WAIT_MS);
      this.events.on(`op:${key}`, done);
    });
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
    return this.deps.approvals.get(id)!;
  }

  private notPending(id: string): DecisionError {
    const approval = this.deps.approvals.get(id);
    return approval
      ? new DecisionError(`Approval ${id} is ${approval.status}, not pending`, 409)
      : new DecisionError(`Approval ${id} not found`, 404);
  }

  private expireOverdue(): void {
    for (const id of this.deps.approvals.expireOverdue(this.now())) {
      const operation = this.deps.operations.byApproval(id);
      if (operation) this.finishOperation(operation, "abandoned");
      log(`approval ${id} expired`);
      this.events.emit(id);
    }
  }

  /**
   * After a crash or restart, anything that was mid-flight may or may not have
   * reached PayPal. Mark it unknown, so a retry is held for a human (or, for
   * direct tools, reuses its PayPal-Request-Id).
   */
  private recoverInterrupted(): void {
    const now = this.now();
    const interrupted = this.deps.operations.interruptInFlight(now);
    for (const approval of this.deps.approvals.list("executing")) {
      this.deps.approvals.complete(
        approval.id,
        "failed",
        unknownOutcomeResult(approval.tool, new Error("Handrail restarted while this call was being sent"), DIRECT_TOOLS.has(approval.tool)),
        now,
      );
    }
    if (interrupted > 0) log(`Marked ${interrupted} interrupted operation(s) as outcome unknown`);
  }
}

function holdForUnknownOutcome(evaluation: Evaluation, tool: string): Evaluation {
  if (evaluation.decision === "block") return evaluation;
  const reason = `An earlier identical ${tool} call got no answer from PayPal, so it may already have run`;
  return {
    ...evaluation,
    decision: "require_approval",
    hits: [...evaluation.hits, { ruleId: "handrail-unknown-outcome", decision: "require_approval", reason }],
    reason,
  };
}

function duplicateResult(op: Operation): CallToolResult {
  const note =
    `[Handrail] Duplicate of an identical ${op.tool} call made at ${new Date(op.createdAt).toISOString()}. ` +
    "It was not sent to PayPal again; this is the original call's result.";
  const original = op.result ?? handrailResult({ status: "in_progress", tool: op.tool }, false);
  return { ...original, content: [{ type: "text", text: note }, ...(original.content ?? [])] };
}

function unknownOutcomeResult(tool: string, err: Error, direct: boolean): CallToolResult {
  return handrailResult(
    {
      status: "outcome_unknown",
      tool,
      message: err instanceof NoResponseError ? err.message : `PayPal MCP call failed: ${err.message}`,
      next_step: direct
        ? "PayPal may or may not have run this. Retrying with identical arguments is safe: Handrail reuses the same PayPal-Request-Id, so PayPal will not run it twice."
        : "PayPal may or may not have run this. Check with a read tool before retrying; a retry will be held for human approval.",
    },
    true,
  );
}

function handrailResult(payload: Record<string, unknown>, isError: boolean): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ handrail: payload }, null, 2) }], isError };
}

function describeAmount(facts: CallFacts): string {
  return facts.amount ? ` [${formatMoney(facts.amount)} from ${facts.amountSource}]` : "";
}
