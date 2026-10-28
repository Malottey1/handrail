import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activityStats, type StatsRow } from "../src/stats.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-28T09:41:00Z");

const row = (hoursAgo: number, over: Partial<StatsRow> = {}): StatsRow => ({
  at_ms: NOW - hoursAgo * HOUR,
  tool: "create_refund",
  decision: "allow",
  outcome: "succeeded",
  forwarded: 1,
  amount_hundredths: 500,
  currency: "USD",
  ...over,
});

describe("activityStats", () => {
  const rows = [
    row(0.1),
    row(0.2, { decision: "require_approval", outcome: "held", forwarded: 0, amount_hundredths: 12000 }),
    row(0.3, { decision: "duplicate", outcome: null, forwarded: 0 }),
    row(2, { tool: "pay_order", amount_hundredths: 12500 }),
    row(3, { decision: "block", outcome: "blocked", forwarded: 0, amount_hundredths: 90000 }),
    row(5, { tool: "accept_dispute_claim", amount_hundredths: 4000 }),
    row(6, { outcome: "failed" }),
    row(7, { currency: "EUR", amount_hundredths: 300 }),
    row(30), // the previous window
    row(30, { decision: "block", outcome: "blocked", forwarded: 0 }),
    row(50), // outside both windows
  ];
  const stats = activityStats(rows, { now: NOW, hours: 24 });

  it("counts the window the same way as the summary", () => {
    assert.deepEqual(stats.current, { calls: 8, forwarded: 5, held: 1, expired: 0, blocked: 1, duplicates: 1, failed: 1 });
    assert.deepEqual(stats.previous, { calls: 2, forwarded: 1, held: 0, expired: 0, blocked: 1, duplicates: 0, failed: 0 });
  });

  it("buckets by clock hour, oldest first, ending with the current hour", () => {
    assert.equal(stats.buckets.length, 24);
    assert.equal(stats.buckets.at(-1)!.start, "2026-10-28T09:00:00.000Z");
    assert.equal(stats.buckets[0]!.start, "2026-10-27T10:00:00.000Z");
    assert.equal(stats.buckets.reduce((n, b) => n + b.calls, 0), 8);
    assert.deepEqual(stats.buckets.at(-1), { start: "2026-10-28T09:00:00.000Z", calls: 3, sent: 1, held: 1, blocked: 0, duplicates: 1 });
  });

  it("sums money only for calls PayPal carried out, per currency", () => {
    assert.deepEqual(stats.moneyOut.total, [
      { currency: "USD", hundredths: 500 + 12500 + 4000 },
      { currency: "EUR", hundredths: 300 },
    ]);
    assert.deepEqual(stats.moneyOut.refunds, { count: 2, amounts: [{ currency: "USD", hundredths: 500 }, { currency: "EUR", hundredths: 300 }] });
    assert.deepEqual(stats.moneyOut.captures, { count: 1, amounts: [{ currency: "USD", hundredths: 12500 }] });
    assert.deepEqual(stats.moneyOut.disputes, { count: 1, amounts: [{ currency: "USD", hundredths: 4000 }] });
    assert.deepEqual(stats.previousMoneyOut.total, [{ currency: "USD", hundredths: 500 }]);
  });

  it("narrows to one tool", () => {
    const captures = activityStats(rows, { now: NOW, hours: 24, tool: "pay_order" });
    assert.equal(captures.current.calls, 1);
    assert.equal(captures.tool, "pay_order");
    assert.deepEqual(captures.moneyOut.refunds, { count: 0, amounts: [] });
  });
});
