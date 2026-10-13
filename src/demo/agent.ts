import { randomUUID } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CallLog, CallRow } from "../audit.js";
import { formatHundredths, toHundredths } from "../policy/money.js";
import type { Policy } from "../policy/types.js";
import { redact } from "../redact.js";
import type { DemoSale } from "./sale.js";

export type StepStatus = "waiting" | "running" | "done" | "unexpected" | "failed";

export interface DemoStep {
  id: "sale" | "small" | "large" | "retry" | "split";
  title: string;
  /** What Handrail should do, given the policy. */
  expect: string;
  status: StepStatus;
  /** What actually happened. */
  outcome: string | null;
}

export interface DemoRun {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  status: "running" | "done" | "failed";
  error: string | null;
  plan: DemoPlan;
  captureId: string | null;
  steps: DemoStep[];
}

export interface DemoPlan {
  /** The refund approval limit the demo exercises, and the rule that sets it. */
  limit: string;
  ruleId: string;
  small: string;
  large: string;
  /** The sandbox sale the refunds come out of. */
  sale: string;
  /**
   * Split refunds: three equal refunds on a second sale, each under the
   * single-refund limit, the third pushing the per-capture total over a
   * cumulative_limit. Null when the policy has no such rule.
   */
  split: { each: string; limit: string; ruleId: string; sale: string } | null;
}

/**
 * Picks refund amounts from the policy in force: one under the lowest refund
 * approval limit (allowed), one over it but under any hard cap (held). Returns
 * an explanation instead when the policy has no such limit.
 */
export function planDemo(policy: Policy): DemoPlan | string {
  const ceilings = policy.rules.flatMap((r) =>
    r.type === "amount_ceiling" && r.tools.includes("create_refund") && r.currency === "USD" ? [{ rule: r, max: toHundredths(r.max)! }] : [],
  );
  const hold = ceilings.filter((c) => c.rule.decision === "require_approval").sort((a, b) => a.max - b.max)[0];
  if (!hold || hold.max < 2) return "The policy in force has no USD refund approval limit, so the demo has nothing to hold.";
  const cap = Math.min(...ceilings.filter((c) => c.rule.decision === "block").map((c) => c.max));
  const small = Math.min(500, Math.floor(hold.max / 2));
  const large = Math.min(hold.max + 2000, Math.floor((hold.max + cap) / 2));
  if (large <= hold.max) return `The refund limit (${formatHundredths(hold.max)} USD) sits right under a hard cap, so the demo can't hold a refund without it being blocked.`;

  // Three refunds of 40% of the per-capture total: two fit, the third doesn't. Each stays under the single-refund limit.
  const totals = policy.rules.flatMap((r) =>
    r.type === "cumulative_limit" && r.per === "capture" && r.tools.includes("create_refund") && r.currency === "USD" && r.decision === "require_approval"
      ? [{ rule: r, max: toHundredths(r.max)! }]
      : [],
  );
  const total = totals.sort((a, b) => a.max - b.max)[0];
  const each = total ? Math.floor((total.max * 0.4) / 100) * 100 || Math.ceil(total.max * 0.4) : 0;
  const split =
    total && each > 0 && each <= hold.max && each * 2 <= total.max && each * 3 > total.max
      ? { each: formatHundredths(each), limit: formatHundredths(total.max), ruleId: total.rule.id, sale: formatHundredths(each * 3 + 500) }
      : null;

  return {
    limit: formatHundredths(hold.max),
    ruleId: hold.rule.id,
    small: formatHundredths(small),
    large: formatHundredths(large),
    sale: formatHundredths(small + large),
    split,
  };
}

export function newDemoRun(plan: DemoPlan, now: number): DemoRun {
  const step = (id: DemoStep["id"], title: string, expect: string): DemoStep => ({ id, title, expect, status: "waiting", outcome: null });
  return {
    id: `run_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    startedAt: now,
    finishedAt: null,
    status: "running",
    error: null,
    plan,
    captureId: null,
    steps: [
      step("sale", `A customer pays ${plan.sale} USD`, "A real sandbox sale for the agent to refund. The shop makes it, not the agent."),
      step("small", `Agent refunds ${plan.small} USD`, `Allowed: under the ${plan.limit} USD limit, so it goes straight to PayPal.`),
      step("large", `Agent refunds ${plan.large} USD`, `Held: over the ${plan.limit} USD limit, so a person decides. The card gets an AI brief.`),
      step("retry", `Agent retries the ${plan.large} USD refund`, "Recognised as the same request: not sent again, and no second approval."),
      plan.split
        ? step(
            "split",
            `Agent splits a refund: three of ${plan.split.each} USD on one payment`,
            `Each is under the ${plan.limit} USD limit, but together they pass the ${plan.split.limit} USD per-payment total: the first two go through, the third is held.`,
          )
        : step("split", "Agent splits a refund into small ones", "Skipped: the policy has no per-payment refund total (cumulative_limit per capture)."),
    ],
  };
}

export interface DemoAgentDeps {
  /** An MCP client connected to Handrail's /mcp with the demo agent's key. */
  connect(): Promise<Client>;
  createSale(amount: string): Promise<DemoSale>;
  /** Called as soon as the sale exists, so its webhooks can be routed to this workspace. */
  onSale(sale: DemoSale): void;
  callLog: Pick<CallLog, "recent">;
  agentKeyId: string;
  now?: () => number;
}

/**
 * The scripted agent behind "Run demo agent". It talks to Handrail exactly as
 * an outside agent would (MCP over HTTP with an agent key), so every call goes
 * through the real gate, policy, approvals and idempotency checks, and on to
 * PayPal's sandbox. `run` is updated in place as each step finishes; each
 * outcome is read from the call log, not assumed.
 */
export async function runDemoAgent(run: DemoRun, deps: DemoAgentDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const step = (id: DemoStep["id"]) => run.steps.find((s) => s.id === id)!;
  let client: Client | null = null;

  // The rows this agent added to the call log since `afterId`.
  const lastId = () => deps.callLog.recent(1)[0]?.id ?? 0;
  const rowsAfter = (afterId: number): CallRow[] =>
    deps.callLog
      .recent(50)
      .filter((r) => r.id > afterId && r.agent_key_id === deps.agentKeyId)
      .reverse();

  async function agentCall(
    id: DemoStep["id"],
    value: string,
    opts: { captureId?: string; idempotencyKey?: string } = {},
  ): Promise<{ result: CallToolResult; rows: CallRow[] }> {
    const s = step(id);
    s.status = "running";
    const before = lastId();
    const result = (await client!.callTool({
      name: "create_refund",
      arguments: {
        capture_id: opts.captureId ?? run.captureId,
        amount: { currency_code: "USD", value },
        note_to_payer: "Sorry, your order arrived damaged.",
        ...(opts.idempotencyKey ? { idempotency_key: opts.idempotencyKey } : {}),
      },
    })) as CallToolResult;
    return { result, rows: rowsAfter(before) };
  }

  try {
    const sale = step("sale");
    sale.status = "running";
    const made = await deps.createSale(run.plan.sale);
    deps.onSale(made);
    run.captureId = made.captureId;
    sale.status = "done";
    sale.outcome = `Captured ${run.plan.sale} USD on PayPal's sandbox (capture ${made.captureId}).`;

    client = await deps.connect();
    let heldApprovalId: string | null = null;

    {
      const { result, rows } = await agentCall("small", run.plan.small);
      const row = rows[0];
      const s = step("small");
      const refund = paypalJson(result);
      if (row?.decision === "allow" && row.outcome === "succeeded") {
        s.status = "done";
        s.outcome = `Allowed and sent to PayPal: refund ${refund?.id ?? "?"} is ${refund?.status ?? "done"}.`;
      } else {
        s.status = "unexpected";
        s.outcome = describeRow(row, result);
      }
    }

    {
      const { result, rows } = await agentCall("large", run.plan.large);
      const row = rows[0];
      const s = step("large");
      if (row?.decision === "require_approval" && row.approval_id) {
        heldApprovalId = row.approval_id;
        s.status = "done";
        const held = handrailJson(result);
        s.outcome =
          held?.status === "pending_approval"
            ? `Held for approval (rule ${run.plan.ruleId}). The agent was told to wait; nothing reached PayPal.`
            : `Held for approval (rule ${run.plan.ruleId}), then decided while the agent waited.`;
      } else {
        s.status = "unexpected";
        s.outcome = describeRow(row, result);
      }
    }

    {
      const { result, rows } = await agentCall("retry", run.plan.large);
      const s = step("retry");
      // A person approving the held refund meanwhile adds its own row; that's the original, not the retry.
      const forwarded = rows.filter((r) => r.decision !== "duplicate" && (heldApprovalId === null || r.approval_id !== heldApprovalId));
      if (rows.length > 0 && forwarded.length === 0) {
        s.status = "done";
        s.outcome = "Duplicate: Handrail answered with the original request's status. Nothing was sent to PayPal and no second approval was created.";
      } else {
        s.status = "unexpected";
        s.outcome = describeRow(forwarded[0], result);
      }
    }

    // Split refunds: a second customer's payment, refunded in three pieces that each look small.
    const split = run.plan.split;
    const s = step("split");
    if (!split) {
      s.status = "done";
      s.outcome = "Skipped: add a cumulative_limit rule per capture to the policy to see split refunds caught.";
    } else {
      s.status = "running";
      const second = await deps.createSale(split.sale);
      deps.onSale(second);
      const results: string[] = [];
      let ok = true;
      for (let i = 1; i <= 3; i++) {
        // Distinct idempotency keys: these are three separate refunds, not retries.
        const { rows } = await agentCall("split", split.each, { captureId: second.captureId, idempotencyKey: `${run.id}-split-${i}` });
        const row = rows[0];
        const hits = row ? (JSON.parse(row.hits_json) as Array<{ ruleId: string }>) : [];
        if (i < 3) {
          const sent = row?.decision === "allow" && row.outcome === "succeeded";
          ok &&= sent;
          results.push(sent ? `${split.each} sent` : `${split.each}: ${describeRow(row, { content: [] })}`);
        } else {
          const heldByTotal = row?.decision === "require_approval" && hits.some((h) => h.ruleId === split.ruleId);
          ok &&= heldByTotal;
          results.push(heldByTotal ? `${split.each} held: ${row!.reason}` : `${split.each}: ${describeRow(row, { content: [] })}`);
        }
      }
      s.status = ok ? "done" : "unexpected";
      s.outcome = `On capture ${second.captureId}: ${results.join(" · ")}`;
    }

    run.status = "done";
  } catch (err) {
    // Shown in the dashboard, so redacted like any other error message.
    const message = redact((err as Error).message);
    const running = run.steps.find((s) => s.status === "running");
    if (running) {
      running.status = "failed";
      running.outcome = message;
    }
    run.status = "failed";
    run.error = message;
  } finally {
    run.finishedAt = now();
    await client?.close().catch(() => {});
  }
}

function textOf(result: CallToolResult): string[] {
  return (result.content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : []));
}

/** PayPal's JSON in a result (the last text block that parses). */
function paypalJson(result: CallToolResult): Record<string, any> | null {
  for (const t of textOf(result).reverse()) {
    try {
      const parsed = JSON.parse(t);
      if (parsed && typeof parsed === "object" && !("handrail" in parsed)) return parsed;
    } catch {
      // Handrail's plain-text notes.
    }
  }
  return null;
}

function handrailJson(result: CallToolResult): Record<string, any> | null {
  for (const t of textOf(result)) {
    try {
      const parsed = JSON.parse(t);
      if (parsed?.handrail) return parsed.handrail;
    } catch {
      // Not JSON.
    }
  }
  return null;
}

function describeRow(row: CallRow | undefined, result: CallToolResult): string {
  if (!row) return "Handrail didn't record this call.";
  const what =
    row.decision === "block"
      ? "Blocked"
      : row.decision === "require_approval"
        ? "Held for approval"
        : row.decision === "duplicate"
          ? "Treated as a duplicate"
          : "Allowed";
  const why = row.reason ? `: ${row.reason}` : "";
  const failed = result.isError && row.decision === "allow" ? ` PayPal answered with an error.` : "";
  return `${what}${why}.${failed}`;
}
