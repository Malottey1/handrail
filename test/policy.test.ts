import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { classifyTool } from "../src/policy/classify.js";
import { evaluate } from "../src/policy/engine.js";
import { loadPolicyFile, parsePolicy } from "../src/policy/load.js";
import { formatHundredths, toHundredths } from "../src/policy/money.js";
import type { CallFacts, HistoryEntry, Policy } from "../src/policy/types.js";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const HOUR = 3600 * 1000;
const usd = (value: string) => ({ hundredths: toHundredths(value)!, currency: "USD" });

function facts(tool: string, overrides: Partial<CallFacts> = {}): CallFacts {
  return { tool, args: {}, amount: null, amountSource: "none", payee: null, ...overrides };
}

function policy(rules: unknown[], defaults: Partial<Policy["defaults"]> = {}): Policy {
  return parsePolicy({
    version: 1,
    defaults: { read: "allow", write: "allow", money: "allow", unknown: "require_approval", ...defaults },
    rules,
  });
}

function run(f: CallFacts, p: Policy, history: HistoryEntry[] = [], approved = false) {
  return evaluate({ facts: f, policy: p, history, now: NOW, approved });
}

const ceiling = (max: string, decision: string, id = `ceiling-${max}-${decision}`) => ({
  id,
  type: "amount_ceiling",
  tools: ["create_refund"],
  max,
  currency: "USD",
  decision,
});

describe("money", () => {
  it("parses amounts exactly", () => {
    assert.equal(toHundredths("100"), 10000);
    assert.equal(toHundredths("100.5"), 10050);
    assert.equal(toHundredths("0.07"), 7);
    assert.equal(toHundredths(" 12.34 "), 1234);
  });

  it("rejects anything that isn't a plain non-negative amount", () => {
    for (const bad of ["", "-5", "1.234", "1e3", "abc", "1,000.00", ".5", "12."]) {
      assert.equal(toHundredths(bad), null, bad);
    }
  });

  it("formats hundredths", () => {
    assert.equal(formatHundredths(10050), "100.50");
    assert.equal(formatHundredths(7), "0.07");
  });
});

describe("classifyTool", () => {
  it("classifies every tool PayPal's sandbox MCP server exposes", () => {
    const names: string[] = JSON.parse(readFileSync("test/fixtures/paypal-tool-names.json", "utf8"));
    assert.equal(names.length, 46);
    assert.deepEqual(names.filter((n) => classifyTool(n) === "unknown"), []);
  });

  it("treats the money-out tools as money", () => {
    for (const t of ["create_refund", "accept_dispute_claim", "cancel_sent_invoice", "cancel_subscription", "pay_order", "send_invoice"]) {
      assert.equal(classifyTool(t), "money", t);
    }
  });

  it("treats tools it has never seen as unknown", () => {
    assert.equal(classifyTool("transfer_all_funds"), "unknown");
  });
});

describe("defaults", () => {
  it("applies the class default when no rule matches", () => {
    const p = policy([], { money: "require_approval" });
    assert.equal(run(facts("list_invoices"), p).decision, "allow");
    assert.equal(run(facts("create_refund"), p).decision, "require_approval");
  });

  it("holds unknown tools by default", () => {
    const result = run(facts("transfer_all_funds"), policy([]));
    assert.equal(result.decision, "require_approval");
    assert.equal(result.toolClass, "unknown");
  });
});

describe("tool rules", () => {
  it("applies the rule's decision to every call of the tool", () => {
    const p = policy([{ id: "d", type: "tool", tools: ["accept_dispute_claim"], decision: "require_approval" }]);
    const result = run(facts("accept_dispute_claim"), p);
    assert.equal(result.decision, "require_approval");
    assert.deepEqual(result.hits.map((h) => h.ruleId), ["d"]);
  });

  it("does not affect other tools", () => {
    const p = policy([{ id: "d", type: "tool", tools: ["accept_dispute_claim"], decision: "block" }]);
    assert.equal(run(facts("create_refund", { amount: usd("1") }), p).decision, "allow");
  });
});

describe("amount ceilings", () => {
  const p = policy([ceiling("100.00", "require_approval")]);

  it("allows amounts at or under the ceiling", () => {
    assert.equal(run(facts("create_refund", { amount: usd("100.00") }), p).decision, "allow");
    assert.equal(run(facts("create_refund", { amount: usd("99.99") }), p).decision, "allow");
  });

  it("fires one cent over the ceiling", () => {
    const result = run(facts("create_refund", { amount: usd("100.01") }), p);
    assert.equal(result.decision, "require_approval");
    assert.match(result.reason, /100\.01 USD is over the 100\.00 USD ceiling/);
  });

  it("fails closed when the amount is unknown", () => {
    const result = run(facts("create_refund"), p);
    assert.equal(result.decision, "require_approval");
    assert.match(result.reason, /unknown/);
  });

  it("holds an unknown amount for approval even when the rule would block", () => {
    const blocking = policy([ceiling("1000.00", "block")]);
    assert.equal(run(facts("create_refund"), blocking).decision, "require_approval");
  });

  it("fails closed on a currency mismatch", () => {
    const result = run(facts("create_refund", { amount: { hundredths: 100, currency: "EUR" } }), p);
    assert.equal(result.decision, "require_approval");
    assert.match(result.reason, /EUR/);
  });
});

describe("combining rules", () => {
  const p = policy([ceiling("100.00", "require_approval"), ceiling("1000.00", "block")]);

  it("lets the most severe decision win", () => {
    assert.equal(run(facts("create_refund", { amount: usd("50") }), p).decision, "allow");
    assert.equal(run(facts("create_refund", { amount: usd("250") }), p).decision, "require_approval");
    const blocked = run(facts("create_refund", { amount: usd("5000") }), p);
    assert.equal(blocked.decision, "block");
    assert.equal(blocked.hits.length, 2);
    assert.match(blocked.reason, /1000\.00 USD ceiling/);
  });

  it("is order independent", () => {
    const reversed = policy([ceiling("1000.00", "block"), ceiling("100.00", "require_approval")]);
    assert.equal(run(facts("create_refund", { amount: usd("5000") }), reversed).decision, "block");
  });
});

describe("rate limits", () => {
  const p = policy([{ id: "rate", type: "rate_limit", tools: ["create_refund"], max: 3, windowSeconds: 3600, decision: "block" }]);
  const refundAt = (msAgo: number): HistoryEntry => ({ tool: "create_refund", at: NOW - msAgo, amount: usd("1") });

  it("allows calls under the limit", () => {
    assert.equal(run(facts("create_refund", { amount: usd("1") }), p, [refundAt(1000), refundAt(2000)]).decision, "allow");
  });

  it("fires once the limit is reached", () => {
    const history = [refundAt(1000), refundAt(2000), refundAt(3000)];
    const result = run(facts("create_refund", { amount: usd("1") }), p, history);
    assert.equal(result.decision, "block");
    assert.match(result.reason, /3 create_refund calls in the last hour \(limit 3\)/);
  });

  it("ignores calls outside the window and other tools", () => {
    const history = [refundAt(HOUR + 1), refundAt(2 * HOUR), refundAt(1000), { tool: "pay_order", at: NOW - 1000, amount: null }];
    assert.equal(run(facts("create_refund", { amount: usd("1") }), p, history).decision, "allow");
  });
});

describe("spend limits", () => {
  const p = policy([
    { id: "spend", type: "spend_limit", tools: ["create_refund"], max: "500.00", currency: "USD", windowSeconds: 86400, decision: "require_approval" },
  ]);
  const refund = (value: string, msAgo = 1000): HistoryEntry => ({ tool: "create_refund", at: NOW - msAgo, amount: usd(value) });

  it("allows spend up to the limit", () => {
    assert.equal(run(facts("create_refund", { amount: usd("100") }), p, [refund("200"), refund("200")]).decision, "allow");
  });

  it("fires when this call would push spend over the limit", () => {
    const result = run(facts("create_refund", { amount: usd("100.01") }), p, [refund("200"), refund("200")]);
    assert.equal(result.decision, "require_approval");
    assert.match(result.reason, /500\.01 USD \(limit 500\.00\)/);
  });

  it("only counts spend inside the window and in the rule's currency", () => {
    const history = [refund("450", 25 * HOUR), { tool: "create_refund", at: NOW - 1000, amount: { hundredths: 45000, currency: "EUR" } }];
    assert.equal(run(facts("create_refund", { amount: usd("100") }), p, history).decision, "allow");
  });

  it("fails closed when the amount is unknown", () => {
    assert.equal(run(facts("create_refund"), p).decision, "require_approval");
  });
});

describe("payee allowlist", () => {
  const p = policy([
    { id: "payees", type: "payee_allowlist", tools: ["send_invoice"], allow: ["@acme.com", "bob@example.com"], decision: "block" },
  ]);

  it("allows listed domains and addresses, case-insensitively", () => {
    assert.equal(run(facts("send_invoice", { payee: "Alice@ACME.com" }), p).decision, "allow");
    assert.equal(run(facts("send_invoice", { payee: "bob@example.com" }), p).decision, "allow");
  });

  it("fires for anyone else", () => {
    assert.equal(run(facts("send_invoice", { payee: "eve@evil.com" }), p).decision, "block");
    assert.equal(run(facts("send_invoice", { payee: "alice@notacme.com.evil.io" }), p).decision, "block");
  });

  it("fails closed when the payee is unknown", () => {
    assert.equal(run(facts("send_invoice"), p).decision, "require_approval");
  });
});

describe("approval", () => {
  const p = policy([ceiling("100.00", "require_approval"), ceiling("1000.00", "block")], { unknown: "require_approval" });

  it("satisfies require_approval", () => {
    const result = run(facts("create_refund", { amount: usd("250") }), p, [], true);
    assert.equal(result.decision, "allow");
    assert.match(result.reason, /^Approved by a human/);
  });

  it("satisfies a require_approval default", () => {
    assert.equal(run(facts("transfer_all_funds"), p, [], true).decision, "allow");
  });

  it("never overrides a block", () => {
    assert.equal(run(facts("create_refund", { amount: usd("5000") }), p, [], true).decision, "block");
  });
});

describe("determinism", () => {
  it("returns identical results for identical input", () => {
    const p = loadPolicyFile("policy.json");
    const f = facts("create_refund", { amount: usd("250") });
    const history = [{ tool: "create_refund", at: NOW - 1000, amount: usd("300") }];
    assert.deepEqual(run(f, p, history), run(f, p, history));
  });
});

describe("policy validation", () => {
  it("accepts the shipped policy.json", () => {
    assert.doesNotThrow(() => loadPolicyFile("policy.json"));
  });

  it("rejects rules that name unknown tools", () => {
    assert.throws(() => policy([{ id: "typo", type: "tool", tools: ["create_refnd"], decision: "block" }]), /unknown tool "create_refnd"/);
  });

  it("rejects duplicate rule ids", () => {
    assert.throws(() => policy([ceiling("1", "block", "x"), ceiling("2", "block", "x")]), /duplicate rule id "x"/);
  });

  it("rejects malformed amounts and decisions", () => {
    assert.throws(() => policy([ceiling("1.234", "block")]), /amount must look like/);
    assert.throws(() => policy([ceiling("10", "maybe")]), /Invalid policy/);
  });
});
