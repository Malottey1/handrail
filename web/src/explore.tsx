import type { CsvExportParams, GridApi, GridReadyEvent } from "ag-grid-community";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Download, Search, X } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

// Shared pieces of the Activity, Webhooks and Audit log pages: a filter card,
// a grid with its own footer (selection, page size, paging), CSV export and a
// detail panel beside the grid.

export const RANGES = [
  { id: "24h", label: "Last 24 hours", ms: 24 * 3_600_000 },
  { id: "7d", label: "Last 7 days", ms: 7 * 24 * 3_600_000 },
  { id: "30d", label: "Last 30 days", ms: 30 * 24 * 3_600_000 },
  { id: "all", label: "All time", ms: null },
] as const;

export type RangeId = (typeof RANGES)[number]["id"];

/** The `since` query value for a range, as ISO time; empty for all time. Rounded to the minute so polls share a key. */
export function sinceFor(range: RangeId, now = Date.now()): string {
  const ms = RANGES.find((r) => r.id === range)?.ms;
  if (!ms) return "";
  const minute = 60_000;
  return new Date(Math.floor((now - ms) / minute) * minute).toISOString();
}

export function SearchField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="filter-search">
      <Search size={18} aria-hidden="true" />
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
      {value && (
        <button type="button" className="filter-clear" onClick={() => onChange("")} aria-label="Clear search">
          <X size={15} />
        </button>
      )}
    </label>
  );
}

export type Option = { value: string; label: string };

/** A select with a small label above its value, like a form field. */
export function FilterSelect({
  label,
  value,
  options,
  onChange,
  icon,
  initial = "",
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (v: string) => void;
  icon?: ReactNode;
  /** The unfiltered value; anything else is highlighted. */
  initial?: string;
}) {
  return (
    <label className={`filter-select ${icon ? "has-icon" : ""} ${value !== initial ? "is-set" : ""}`}>
      {icon && <span className="filter-select-icon">{icon}</span>}
      <span className="filter-select-label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown size={16} className="filter-select-chevron" aria-hidden="true" />
    </label>
  );
}

export function DateRange({ value, onChange, initial }: { value: RangeId; onChange: (v: RangeId) => void; initial: RangeId }) {
  return (
    <FilterSelect
      label="Date range"
      value={value}
      initial={initial}
      icon={<CalendarDays size={18} />}
      options={RANGES.map((r) => ({ value: r.id, label: r.label }))}
      onChange={(v) => onChange(v as RangeId)}
    />
  );
}

/** "All …" plus the distinct values present, sorted by label. */
export function optionsFrom(all: string, values: Iterable<string | null | undefined>, label: (v: string) => string = (v) => v): Option[] {
  const distinct = [...new Set([...values].filter((v): v is string => !!v))].map((v) => ({ value: v, label: label(v) }));
  distinct.sort((a, b) => a.label.localeCompare(b.label));
  return [{ value: "", label: all }, ...distinct];
}

export function FilterCard({ children, onReset, active }: { children: ReactNode; onReset: () => void; active: boolean }) {
  return (
    <section className="filter-card" aria-label="Filters">
      {children}
      <button type="button" className="filter-reset" onClick={onReset} disabled={!active}>
        Reset
      </button>
    </section>
  );
}

/** Polling indicator: "Live · 3s", or "Reconnecting" after a failed refresh. */
export function LiveChip({ seconds, error }: { seconds: number; error?: boolean }) {
  return (
    <span className={`live-chip ${error ? "is-error" : ""}`} title={error ? "The last refresh failed; retrying" : `Refreshes every ${seconds} seconds`}>
      <span className="live-dot" aria-hidden="true" />
      {error ? "Reconnecting" : `Live · ${seconds}s`}
    </span>
  );
}

/** The grid's API once it's ready, for the footer and export. */
export function useGridApi<T>() {
  const [api, setApi] = useState<GridApi<T> | null>(null);
  const onGridReady = useCallback((e: GridReadyEvent<T>) => setApi(e.api), []);
  return { api, onGridReady };
}

/** Downloads the selected rows, or every row the filters show when none are selected, as CSV. */
export function ExportButton<T>({ api, fileName, params }: { api: GridApi<T> | null; fileName: string; params?: CsvExportParams }) {
  const selected = useSelectedCount(api);
  return (
    <button
      type="button"
      className="btn btn-secondary btn-lg"
      disabled={!api}
      onClick={() =>
        api?.exportDataAsCsv({
          fileName: `${fileName}-${new Date().toISOString().slice(0, 10)}.csv`,
          onlySelected: selected > 0,
          ...params,
        })
      }
    >
      <Download size={18} aria-hidden="true" />
      {selected > 0 ? `Export ${selected} selected` : "Export CSV"}
    </button>
  );
}

function useSelectedCount<T>(api: GridApi<T> | null): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!api) return;
    const update = () => setCount(api.getSelectedRows().length);
    update();
    api.addEventListener("selectionChanged", update);
    api.addEventListener("rowDataUpdated", update);
    return () => {
      if (api.isDestroyed()) return;
      api.removeEventListener("selectionChanged", update);
      api.removeEventListener("rowDataUpdated", update);
    };
  }, [api]);
  return count;
}

export const PAGE_SIZES = [10, 25, 50, 100];

/** Selection count, rows per page, "1–25 of 142" and previous/next, under the grid. */
export function GridFooter<T>({ api, note }: { api: GridApi<T> | null; note?: ReactNode }) {
  const selected = useSelectedCount(api);
  const [state, setState] = useState({ page: 0, pages: 0, rows: 0, size: 25 });
  useEffect(() => {
    if (!api) return;
    const update = () =>
      setState({
        page: api.paginationGetCurrentPage(),
        pages: api.paginationGetTotalPages(),
        rows: api.paginationGetRowCount(),
        size: api.paginationGetPageSize(),
      });
    update();
    api.addEventListener("paginationChanged", update);
    return () => {
      if (!api.isDestroyed()) api.removeEventListener("paginationChanged", update);
    };
  }, [api]);

  const from = state.rows === 0 ? 0 : state.page * state.size + 1;
  const to = Math.min(state.rows, (state.page + 1) * state.size);
  return (
    <footer className="grid-footer">
      <span className="grid-footer-selected">
        {selected > 0 ? `${selected} row${selected === 1 ? "" : "s"} selected` : note}
      </span>
      <label className="grid-footer-size">
        Rows per page
        <span className="select-pill">
          <select value={state.size} onChange={(e) => api?.setGridOption("paginationPageSize", Number(e.target.value))} disabled={!api}>
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <ChevronDown size={15} aria-hidden="true" />
        </span>
      </label>
      <span className="grid-footer-range num">{state.rows === 0 ? "0 of 0" : `${from}–${to} of ${state.rows}`}</span>
      <span className="grid-footer-pager">
        <button type="button" className="icon-btn" onClick={() => api?.paginationGoToPreviousPage()} disabled={state.page === 0} aria-label="Previous page">
          <ChevronLeft size={18} />
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => api?.paginationGoToNextPage()}
          disabled={state.page >= state.pages - 1}
          aria-label="Next page"
        >
          <ChevronRight size={18} />
        </button>
      </span>
    </footer>
  );
}

/** Time on one line and the date under it, for grid cells. */
export function TimeCell({ iso }: { iso: string | null | undefined }) {
  if (!iso) return null;
  const d = new Date(iso);
  return (
    <span className="cell-stack">
      <span>{d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
      <small>{d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}</small>
    </span>
  );
}

export type Tab = { id: string; label: string; count?: number };

/** The detail panel beside a grid: header, tabs and body. Escape closes it. */
export function SidePanel({
  icon,
  title,
  badge,
  subtitle,
  tabs,
  tab,
  onTab,
  onClose,
  children,
}: {
  icon?: ReactNode;
  title: ReactNode;
  badge?: ReactNode;
  subtitle?: ReactNode;
  tabs: Tab[];
  tab: string;
  onTab: (id: string) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="panel-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="side-panel" aria-label="Details">
        <header className="side-panel-head">
          {icon}
          <div className="side-panel-title">
            <h2>
              {title}
              {badge}
            </h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button type="button" className="icon-btn icon-btn-plain" onClick={onClose} aria-label="Close details">
            <X size={20} />
          </button>
        </header>
        {tabs.length > 1 && (
          <nav className="panel-tabs" role="tablist">
            {tabs.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`panel-tab ${tab === t.id ? "active" : ""}`} onClick={() => onTab(t.id)}>
                {t.label}
                {t.count !== undefined && <span className="panel-tab-count">{t.count}</span>}
              </button>
            ))}
          </nav>
        )}
        <div className="side-panel-body">{children}</div>
      </aside>
    </>
  );
}

/** Label/value rows in a detail panel. Rows whose value is null or empty are left out. */
export function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  const shown = rows.filter(([, v]) => v !== null && v !== undefined && v !== "" && v !== false);
  if (shown.length === 0) return null;
  return (
    <dl className="facts">
      {shown.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
