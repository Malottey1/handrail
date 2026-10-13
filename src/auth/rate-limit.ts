/**
 * Counts failures per key in a sliding window. In memory: limits reset when
 * Handrail restarts, which is acceptable for a single-instance deployment.
 */
export class FailureLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Milliseconds until `key` may try again, or 0 if it may try now. */
  retryAfter(key: string, now: number): number {
    const recent = this.recent(key, now);
    return recent.length >= this.max ? recent[0]! + this.windowMs - now : 0;
  }

  fail(key: string, now: number): void {
    const recent = this.recent(key, now);
    recent.push(now);
    this.failures.set(key, recent);
    if (this.failures.size > 10_000) this.sweep(now);
  }

  reset(key: string): void {
    this.failures.delete(key);
  }

  private recent(key: string, now: number): number[] {
    return (this.failures.get(key) ?? []).filter((t) => t > now - this.windowMs);
  }

  private sweep(now: number): void {
    for (const [key, times] of this.failures) {
      if (times.every((t) => t <= now - this.windowMs)) this.failures.delete(key);
    }
  }
}
