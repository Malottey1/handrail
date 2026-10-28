import type { CellClickedEvent, ColDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { ArrowRight, Ban, CircleCheck, CircleHelp, ChevronRight, Link2Off, RefreshCw, type LucideIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { api, type AuditEntry, type MatchStatus, type Money, type Session, type WebhookRow } from "../api";
import { CopyButton, JsonBlock, Mono, PageHeader, Pill, StatusPill, ToolIcon, usePoll } from "../components";
import {
  DateRange,
  ExportButton,
  Facts,
  FilterCard,
  FilterSelect,
  GridFooter,
  LiveChip,
  optionsFrom,
  SearchField,
  SidePanel,
  sinceFor,
  TimeCell,
  useGridApi,
  type RangeId,
} from "../explore";
import { formatMoney, formatTime, toolLabel } from "../format";
import { useGridTheme } from "../grid";

type WebhookDetail = Omit<WebhookRow, never> & { raw: unknown; amount: Money | null };

const STATUS_TILES: Array<{ status: MatchStatus; label: string; tone: string; icon: LucideIcon; note: string }> = [
  { status: "matched", label: "Matched", tone: "good", icon: CircleCheck, note: "Agree with the agent call" },
  { status: "mismatch", label: "Mismatched", tone: "flag", icon: Link2Off, note: "PayPal disagrees with Handrail" },
  { status: "outside_handrail", label: "Unattributed", tone: "bad", icon: Ban, note: "Money moved outside Handrail" },
  { status: "unrelated", label: "Unrelated", tone: "neutral", icon: CircleHelp, note: "No agent call to match" },
];

const STATUSES = [
  { value: "", label: "All statuses" },
  { value: "matched", label: "Matched" },
  { value: "mismatch", label: "Mismatch" },
  { value: "outside_handrail", label: "Unattributed" },
  { value: "unrelated", label: "Unrelated" },
  { value: "ignored", label: "Ignored" },
];

const RESOURCE_TYPES: Array<[RegExp, string]> = [
  [/^PAYMENT\.CAPTURE|^PAYMENT\.SALE|^PAYMENT\.AUTHORIZATION/, "Payment"],
  [/^CHECKOUT\.ORDER/, "Order"],
  [/^CUSTOMER\.DISPUTE/, "Dispute"],
  [/^INVOICING/, "Invoice"],
  [/^BILLING\.SUBSCRIPTION|^BILLING\.PLAN/, "Subscription"],
];
const resourceType = (eventType: string) => RESOURCE_TYPES.find(([re]) => re.test(eventType))?.[1] ?? "Other";

const statusLabel = (s: string) => STATUSES.find((x) => x.value === s)?.label ?? s;

export function WebhooksView({ session, title, subtitle }: { session: Session; title: string; subtitle: string }) {
  const [range, setRange] = useState<RangeId>("7d");
  const since = sinceFor(range);
  const sinceQuery = since ? `since=${encodeURIComponent(since)}` : "";
  const events = usePoll(() => api<WebhookRow[]>(session, `/webhooks?limit=500&${sinceQuery}`), 4000, range);
  const counts = usePoll(() => api<Record<MatchStatus, number>>(session, `/webhooks/counts?${sinceQuery}`), 4000, range);

  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [resource, setResource] = useState("");
  const [signature, setSignature] = useState("");
  const reset = () => {
    setSearch("");
    setType("");
    setStatus("");
    setResource("");
    setSignature("");
    setRange("7d");
  };

  const rows = events.data ?? [];
  const q = search.trim().toLowerCase();
  const shown = useMemo(
    () =>
      rows.filter(
        (e) =>
          (!type || e.event_type === type) &&
          (!status || e.status === status) &&
          (!resource || resourceType(e.event_type) === resource) &&
          (!signature || (signature === "verified") === !!e.verified) &&
          (!q ||
            [e.event_id, e.event_type, e.resource_id, e.summary, e.tool, e.call_id && `#${e.call_id}`, statusLabel(e.status), ...e.reasons].some(
              (v) => v && String(v).toLowerCase().includes(q),
            )),
      ),
    [rows, type, status, resource, signature, q],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const close = useCallback(() => setSelectedId(null), []);

  const theme = useGridTheme();
  const { api: grid, onGridReady } = useGridApi<WebhookRow>();
  const columns = useMemo<ColDef<WebhookRow>[]>(
    () => [
      { headerName: "Time", field: "received_at", width: 120, sort: "desc", cellRenderer: (p: { value: string }) => <TimeCell iso={p.value} /> },
      {
        headerName: "Event type",
        field: "event_type",
        flex: 1.4,
        minWidth: 230,
        cellRenderer: (p: { value: string; data?: WebhookRow }) => (
          <span className="cell-tool">
            <ToolIcon tool={p.data?.tool ?? "webhook"} size={15} />
            <span className="cell-event">{p.value}</span>
          </span>
        ),
        tooltipValueGetter: (p) => p.value,
      },
      { headerName: "Resource type", colId: "resource_type", width: 130, valueGetter: (p) => (p.data ? resourceType(p.data.event_type) : "") },
      { headerName: "Resource ID", field: "resource_id", width: 190, cellClass: "mono-cell", valueFormatter: (p) => p.value ?? "—" },
      {
        headerName: "Status",
        field: "status",
        width: 150,
        valueFormatter: (p) => statusLabel(p.value),
        cellRenderer: (p: { value: string }) => (p.value === "outside_handrail" ? <Pill tone="flag">Unattributed</Pill> : <StatusPill status={p.value} />),
      },
      {
        headerName: "Matched to",
        colId: "call",
        width: 170,
        valueGetter: (p) => (p.data?.call_id ? `Call #${p.data.call_id} · ${toolLabel(p.data.tool ?? "")}` : "—"),
      },
      {
        headerName: "Signature",
        field: "verified",
        width: 120,
        valueFormatter: (p) => (p.value ? "Verified" : "Unverified"),
        cellRenderer: (p: { value: number }) => (p.value ? <Pill tone="good">Verified</Pill> : <Pill tone="bad">Unverified</Pill>),
      },
      { headerName: "Details", colId: "reasons", hide: true, valueGetter: (p) => p.data?.reasons.join("; ") || p.data?.summary || "" },
      {
        headerName: "",
        colId: "open",
        width: 52,
        sortable: false,
        resizable: false,
        cellRenderer: () => <ChevronRight size={18} className="cell-chevron" aria-hidden="true" />,
      },
    ],
    [],
  );

  const types = optionsFrom("All types", rows.map((e) => e.event_type));
  const resources = optionsFrom("All resources", rows.map((e) => resourceType(e.event_type)));
  const filtered = !!(search || type || status || resource || signature || range !== "7d");
  const rangeLabel = range === "all" ? "All time" : range === "24h" ? "Last 24 hours" : range === "7d" ? "Last 7 days" : "Last 30 days";

  return (
    <div className={`explore ${selectedId ? "has-panel" : ""}`}>
      <div className="explore-main">
        <PageHeader
          title={title}
          subtitle={subtitle}
          actions={
            <>
              <ExportButton api={grid} fileName="handrail-webhooks" params={{ columnKeys: ["received_at", "event_type", "resource_type", "resource_id", "status", "call", "verified", "reasons"] }} />
              <button
                type="button"
                className="btn btn-secondary btn-lg"
                onClick={() => {
                  events.refresh();
                  counts.refresh();
                }}
              >
                <RefreshCw size={18} aria-hidden="true" />
                Refresh
              </button>
              <LiveChip seconds={4} error={!!events.error} />
            </>
          }
        />

        <div className="metrics metrics-4">
          {STATUS_TILES.map((t) => {
            const Icon = t.icon;
            const n = counts.data?.[t.status];
            const active = status === t.status;
            return (
              <button
                key={t.status}
                type="button"
                className={`metric metric-${t.tone} metric-button ${active ? "is-active" : ""}`}
                onClick={() => setStatus(active ? "" : t.status)}
                aria-pressed={active}
              >
                <span className="metric-icon" aria-hidden="true">
                  <Icon size={20} />
                </span>
                <span className="metric-body">
                  <span className="metric-value num">{n ?? "–"}</span>
                  <span className="metric-label">{t.label}</span>
                  <span className="trend trend-neutral" title={t.note}>
                    {rangeLabel}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        <FilterCard onReset={reset} active={filtered}>
          <div className="filter-row">
            <SearchField value={search} onChange={setSearch} placeholder="Search events, resource IDs, or details…" />
            <DateRange value={range} onChange={setRange} initial="7d" />
          </div>
          <div className="filter-row">
            <FilterSelect label="Event type" value={type} options={types} onChange={setType} />
            <FilterSelect label="Status" value={status} options={STATUSES} onChange={setStatus} />
            <FilterSelect label="Resource type" value={resource} options={resources} onChange={setResource} />
            <FilterSelect
              label="Signature"
              value={signature}
              options={[
                { value: "", label: "All" },
                { value: "verified", label: "Verified" },
                { value: "unverified", label: "Unverified" },
              ]}
              onChange={setSignature}
            />
          </div>
        </FilterCard>
        {events.error && <p className="error">{events.error.message}</p>}
        <section className="grid-card">
          <AgGridReact<WebhookRow>
            theme={theme}
            rowData={shown}
            columnDefs={columns}
            defaultColDef={{ sortable: true, resizable: true }}
            getRowId={(p) => p.data.event_id}
            onGridReady={onGridReady}
            onCellClicked={(e: CellClickedEvent<WebhookRow>) => e.data && !e.column.getColId().startsWith("ag-Grid-") && setSelectedId(e.data.event_id)}
            rowSelection={{ mode: "multiRow", checkboxes: true, headerCheckbox: true, enableClickSelection: false }}
            rowClass="clickable"
            rowClassRules={{ "row-open": (p) => p.data?.event_id === selectedId }}
            pagination
            paginationPageSize={25}
            paginationPageSizeSelector={false}
            suppressPaginationPanel
            domLayout="autoHeight"
            loading={!events.data && !events.error}
            overlayNoRowsTemplate={
              rows.length ? "Nothing matches these filters." : "No webhooks in this range. Register /webhooks/paypal in the PayPal developer dashboard."
            }
            tooltipShowDelay={300}
            animateRows={false}
          />
          <GridFooter api={grid} note={rows.length === 500 ? "Showing the newest 500 events; narrow the date range for older ones" : null} />
        </section>
      </div>
      {selectedId && <WebhookPanel key={selectedId} id={selectedId} session={session} onClose={close} />}
    </div>
  );
}

const STATUS_BOX: Record<MatchStatus, [string, string]> = {
  matched: ["good", "Matched to agent call"],
  mismatch: ["flag", "Doesn't match what Handrail sent"],
  outside_handrail: ["flag", "Not sent through Handrail"],
  unrelated: ["neutral", "Not related to an agent call"],
  ignored: ["neutral", "Ignored"],
};

function WebhookPanel({ id, session, onClose }: { id: string; session: Session; onClose: () => void }) {
  const [tab, setTab] = useState("overview");
  const detail = usePoll(() => api<WebhookDetail>(session, `/webhooks/${encodeURIComponent(id)}`), 10000, id);
  const audit = usePoll(() => api<AuditEntry[]>(session, `/audit?ref=${encodeURIComponent(`webhook:${id}`)}`), 10000, id);
  const e = detail.data;
  const [tone, heading] = e ? STATUS_BOX[e.status] : ["neutral", ""];

  return (
    <SidePanel
      icon={<ToolIcon tool={e?.tool ?? "webhook"} size={20} />}
      title={<span className="panel-event">{e?.event_type ?? "Webhook"}</span>}
      badge={e && (e.status === "outside_handrail" ? <Pill tone="flag">Unattributed</Pill> : <StatusPill status={e.status} />)}
      subtitle={
        e && (
          <>
            Received {formatTime(e.received_at)} · <span className="mono-text">{e.event_id}</span>
          </>
        )
      }
      tabs={[
        { id: "overview", label: "Overview" },
        { id: "payload", label: "Payload" },
        { id: "matching", label: "Matching", count: e?.reasons.length },
        { id: "audit", label: "Audit", count: audit.data?.length },
      ]}
      tab={tab}
      onTab={setTab}
      onClose={onClose}
    >
      {detail.error && <p className="error">{detail.error.message}</p>}
      {!e && !detail.error && <p className="panel-note">Loading…</p>}
      {e && tab === "overview" && (
        <>
          <div className="panel-amount">
            <div>
              <p className="detail-label">Amount</p>
              {e.amount ? (
                <p className="detail-amount">
                  <span className="num">{formatMoney(e.amount)}</span>
                  <small>{e.amount.currency}</small>
                </p>
              ) : (
                <p className="detail-amount-none">Not in PayPal's event</p>
              )}
            </div>
          </div>
          <div className={`reason-box reason-${tone}`}>
            <p className="reason-title">{heading}</p>
            <p>{e.reasons[0] ?? e.summary ?? ""}</p>
          </div>
          <Facts
            rows={[
              ["Agent call", e.call_id ? `Call #${e.call_id} · ${toolLabel(e.tool ?? "")}` : null],
              ["Resource type", resourceType(e.event_type)],
              ["Resource ID", e.resource_id && <span className="mono-text">{e.resource_id}</span>],
              ["Signature", e.verified ? "Verified with PayPal" : "Not verified"],
              ["PayPal summary", e.summary],
              ["Received", new Date(e.received_at).toLocaleString()],
            ]}
          />
          {e.call_id && (
            <a className="view-all" href="#activity">
              Open Activity <ArrowRight size={15} aria-hidden="true" />
            </a>
          )}
        </>
      )}
      {e && tab === "payload" && (
        <>
          <div className="panel-row">
            <p className="panel-note">PayPal's event body as received. Anything that looks like a credential is removed.</p>
            <CopyButton text={JSON.stringify(e.raw, null, 2)} label="Copy JSON" className="btn btn-secondary btn-sm" />
          </div>
          <JsonBlock value={e.raw} />
        </>
      )}
      {e && tab === "matching" && (
        <>
          <p className="panel-note">How Handrail matched this event to the call it forwarded.</p>
          {e.reasons.length === 0 ? (
            <p className="panel-note">{e.call_id ? `Matched call #${e.call_id} with nothing to flag.` : "No agent call to compare it with."}</p>
          ) : (
            <ul className="rule-list">
              {e.reasons.map((r, i) => (
                <li key={i}>
                  <StatusPill status={e.status} />
                  <p>{r}</p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {tab === "audit" && (
        <ol className="chain">
          {(audit.data ?? []).length === 0 && <p className="panel-note">No audit entries for this event.</p>}
          {[...(audit.data ?? [])].reverse().map((a) => (
            <li key={a.seq}>
              <span className="chain-seq">#{a.seq}</span>
              <span className="chain-kind">{a.kind}</span>
              <span className="muted">{formatTime(a.at)}</span>
              <Mono title={a.hash}>{a.hash.slice(0, 12)}…</Mono>
            </li>
          ))}
        </ol>
      )}
    </SidePanel>
  );
}
