/**
 * Read-only activity figures for the dashboard: hourly call counts and the
 * money agents moved, for a window and the window before it (for trends).
 * Computed from the call log; nothing here writes.
 */

export interface StatsRow {
  at_ms: number;
  tool: string;
  decision: string;
  outcome: string | null;
  forwarded: number;
  amount_hundredths: number | null;
  currency: string | null;
}

export interface Counts {
  calls: number;
  forwarded: number;
  held: number;
  expired: number;
  blocked: number;
  duplicates: number;
  failed: number;
}

/** The same counts as the summary's `last24h`. */
export const COUNTERS: Record<keyof Counts, (c: { decision: string; outcome: string | null }) => boolean> = {
  calls: () => true,
  forwarded: (c) => c.decision !== "duplicate" && c.outcome !== "held" && c.outcome !== "expired" && c.outcome !== "blocked",
  held: (c) => c.outcome === "held",
  expired: (c) => c.outcome === "expired",
  blocked: (c) => c.decision === "block" || c.outcome === "blocked",
  duplicates: (c) => c.decision === "duplicate",
  failed: (c) => c.outcome === "failed" || c.outcome === "unknown",
};

export interface Money {
  hundredths: number;
  currency: string;
}

/** Money agents moved: calls PayPal carried out (sent, and succeeded), per currency. */
export interface MoneyOut {
  total: Money[];
  refunds: { count: number; amounts: Money[] };
  captures: { count: number; amounts: Money[] };
  disputes: { count: number; amounts: Money[] };
}

export interface Bucket {
  start: string;
  calls: number;
  sent: number;
  held: number;
  blocked: number;
  duplicates: number;
}

export interface ActivityStats {
  hours: number;
  tool: string | null;
  since: string;
  buckets: Bucket[];
  current: Counts;
  previous: Counts;
  moneyOut: MoneyOut;
  previousMoneyOut: MoneyOut;
}

const HOUR_MS = 60 * 60 * 1000;

function count(rows: StatsRow[]): Counts {
  const out = {} as Counts;
  for (const key of Object.keys(COUNTERS) as Array<keyof Counts>) out[key] = rows.filter(COUNTERS[key]).length;
  return out;
}

function sum(rows: StatsRow[]): Money[] {
  const by = new Map<string, number>();
  for (const r of rows) {
    if (r.amount_hundredths === null || !r.currency) continue;
    by.set(r.currency, (by.get(r.currency) ?? 0) + r.amount_hundredths);
  }
  return [...by].map(([currency, hundredths]) => ({ currency, hundredths })).sort((a, b) => b.hundredths - a.hundredths);
}

function moneyOut(rows: StatsRow[]): MoneyOut {
  const done = rows.filter((r) => r.forwarded === 1 && r.outcome === "succeeded");
  const of = (tool: string) => {
    const matching = done.filter((r) => r.tool === tool);
    return { count: matching.length, amounts: sum(matching) };
  };
  return { total: sum(done), refunds: of("create_refund"), captures: of("pay_order"), disputes: of("accept_dispute_claim") };
}

/**
 * `rows` must cover [now - 2 * hours, now]. Buckets are whole clock hours, oldest
 * first, the last one being the current (partial) hour.
 */
export function activityStats(rows: StatsRow[], opts: { now: number; hours: number; tool?: string | null }): ActivityStats {
  const { now, hours } = opts;
  const tool = opts.tool ?? null;
  const filtered = tool ? rows.filter((r) => r.tool === tool) : rows;
  const since = now - hours * HOUR_MS;
  const current = filtered.filter((r) => r.at_ms > since && r.at_ms <= now);
  const previous = filtered.filter((r) => r.at_ms > since - hours * HOUR_MS && r.at_ms <= since);

  const lastStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  const buckets: Bucket[] = [];
  for (let i = hours - 1; i >= 0; i--) {
    const start = lastStart - i * HOUR_MS;
    const inBucket = current.filter((r) => r.at_ms >= start && r.at_ms < start + HOUR_MS);
    const c = count(inBucket);
    buckets.push({ start: new Date(start).toISOString(), calls: c.calls, sent: c.forwarded, held: c.held, blocked: c.blocked, duplicates: c.duplicates });
  }

  return {
    hours,
    tool,
    since: new Date(since).toISOString(),
    buckets,
    current: count(current),
    previous: count(previous),
    moneyOut: moneyOut(current),
    previousMoneyOut: moneyOut(previous),
  };
}
