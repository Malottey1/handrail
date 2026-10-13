import { useEffect, useRef, useState, type ReactNode } from "react";
import { setTheme, useTheme } from "./theme";

const DECISION_LABELS: Record<string, [string, string]> = {
  allow: ["Allowed", "good"],
  approved: ["Approved by human", "good"],
  require_approval: ["Needs approval", "warn"],
  block: ["Blocked", "bad"],
  duplicate: ["Duplicate", "info"],
};

const OUTCOME_LABELS: Record<string, [string, string]> = {
  succeeded: ["Succeeded", "good"],
  failed: ["Failed", "bad"],
  unknown: ["Unknown", "bad"],
  held: ["Held", "warn"],
  blocked: ["Blocked", "bad"],
  duplicate: ["Not re-sent", "info"],
  pending: ["Waiting", "warn"],
  executing: ["Sending", "info"],
  executed: ["Executed", "good"],
  rejected: ["Rejected", "bad"],
  expired: ["Expired", "muted"],
  matched: ["Matched", "good"],
  mismatch: ["Mismatch", "flag"],
  outside_handrail: ["Outside Handrail", "flag"],
  unrelated: ["Unrelated", "muted"],
  ignored: ["Ignored", "muted"],
};

export function Pill({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function DecisionPill({ decision }: { decision: string }) {
  const [label, tone] = DECISION_LABELS[decision] ?? [decision, "muted"];
  return <Pill tone={tone}>{label}</Pill>;
}

export function StatusPill({ status }: { status: string | null }) {
  if (!status) return <Pill tone="info">In flight</Pill>;
  const [label, tone] = OUTCOME_LABELS[status] ?? [status, "muted"];
  return <Pill tone={tone}>{label}</Pill>;
}

export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <code className="mono" title={title}>
      {children}
    </code>
  );
}

export function JsonBlock({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <p className="empty-body">{children}</p>}
    </div>
  );
}

export function Drawer({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <h2>{title}</h2>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

/** Re-renders every `ms`, for countdowns and "x ago" labels. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/**
 * Fetches now and every `intervalMs` while the tab is visible ("live" updates
 * without websockets). `refresh` fetches immediately, e.g. after an action.
 */
export function usePoll<T>(load: () => Promise<T>, intervalMs: number, key = "") {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const run = () =>
      loadRef.current().then(
        (d) => !cancelled && (setData(d), setError(null)),
        (e: Error) => !cancelled && setError(e),
      );
    void run();
    const t = setInterval(() => document.visibilityState === "visible" && void run(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [intervalMs, key, tick]);

  return { data, error, refresh: () => setTick((n) => n + 1) };
}

/**
 * The Handrail logo (web/public/handrail-logo.png). Until that file is added,
 * a simple mark in the brand green stands in.
 */
export function Logo({ size = 28, className = "logo" }: { size?: number; className?: string }) {
  const [missing, setMissing] = useState(false);
  if (missing) {
    return (
      <svg className={className} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
        <circle cx="16" cy="16" r="16" fill="var(--brand)" />
        <path d="M8 22h5v-4h5v-4h5" fill="none" stroke="var(--white)" strokeWidth="2.4" strokeLinejoin="round" />
        <path d="M8 16c3-6 9-9 15-8" fill="none" stroke="var(--white)" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    );
  }
  return <img className={className} src="/handrail-logo.png" width={size} height={size} alt="" onError={() => setMissing(true)} />;
}

/** Switches between the light (default) and dark themes. */
export function ThemeToggle() {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button className="btn btn-ghost theme-toggle" onClick={() => setTheme(next)} aria-label={`Switch to ${next} mode`} title={`Switch to ${next} mode`}>
      {theme === "dark" ? "☀" : "☾"}
    </button>
  );
}
