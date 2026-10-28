import type { CellClickedEvent, ColDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { ArrowRight, Clock, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Approval, type AuditEntry, type CallRow, type RuleHit, type Session, type UnattributedEvent, type VerifiedFacts } from "../api";
import { DecisionPill, JsonBlock, Mono, PageHeader, Pill, StatusPill, ToolIcon, useNow, usePoll } from "../components";
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
import { callAmount, callDecision, countdown, formatMoney, formatTime, parseJson, paypalSummary, toolLabel } from "../format";
import { useGridTheme } from "../grid";
import { AgentSays, AiBrief, Verified } from "./Approvals";

/**
 * One row in the Activity grid: an agent call through Handrail, or a
 * money-out action PayPal reported that didn't go through Handrail.
 */
type ActivityRow =
  | { kind: "call"; key: string; time: string; tool: string; call: CallRow }
  | { kind: "unattributed"; key: string; time: string; tool: string; event: UnattributedEvent };

const PAGE = 500;
const DECISIONS = [
  { value: "", label: "All" },
  { value: "allow", label: "Allowed" },
  { value: "approved", label: "Approved by human" },
  { value: "require_approval", label: "Needs approval" },
  { value: "block", label: "Blocked" },
  { value: "duplicate", label: "Duplicate" },
  { value: "none", label: "No Handrail decision" },
];
const OUTCOME_LABELS: Record<string, string> = {
  succeeded: "Succeeded",
  failed: "Failed",
  unknown: "Unknown",
  held: "Held",
  blocked: "Blocked",
  duplicate: "Not re-sent",
  rejected: "Rejected",
  expired: "Expired",
  unattributed: "Unattributed",
  in_flight: "In flight",
};

const rowAmount = (row: ActivityRow) => (row.kind === "call" ? callAmount(row.call) : row.event.amount);
const rowDecision = (row: ActivityRow) => (row.kind === "call" ? callDecision(row.call) : "none");
const rowOutcome = (row: ActivityRow) => (row.kind === "call" ? row.call.outcome ?? "in_flight" : "unattributed");
const rowAgent = (row: ActivityRow) => (row.kind === "call" ? row.call.agent_name ?? "Not recorded" : "Not through Handrail");

function matches(row: ActivityRow, q: string): boolean {
  if (!q) return true;
  const amount = rowAmount(row);
  const hay =
    row.kind === "call"
      ? [row.call.id, row.call.tool, toolLabel(row.call.tool), row.call.request_id, row.call.capture_id, row.call.order_id, row.call.payer, row.call.agent_name, row.call.reason, row.call.approval_id]
      : [row.event.eventId, row.event.eventType, row.event.resourceId, row.tool, toolLabel(row.tool), ...row.event.reasons];
  if (amount) hay.push(formatMoney(amount), (amount.hundredths / 100).toFixed(2));
  return hay.some((v) => v !== null && v !== undefined && String(v).toLowerCase().includes(q));
}

export function ActivityView({ session, title, subtitle }: { session: Session; title: string; subtitle: string }) {
  const [range, setRange] = useState<RangeId>("7d");
  const since = sinceFor(range);
  const sinceQuery = since ? `&since=${encodeURIComponent(since)}` : "";
  const calls = usePoll(() => api<CallRow[]>(session, `/calls?limit=${PAGE}${sinceQuery}`), 3000, range);
  const unattributed = usePoll(() => api<UnattributedEvent[]>(session, "/unattributed"), 10000);

  // Older calls in the range, fetched page by page with `before`.
  const [older, setOlder] = useState<CallRow[]>([]);
  const [olderState, setOlderState] = useState<"idle" | "loading" | "done">("idle");
  useEffect(() => {
    setOlder([]);
    setOlderState("idle");
  }, [range]);
  const loaded = (calls.data?.length ?? 0) + older.length;
  const canLoadOlder = olderState !== "done" && (older.length > 0 || calls.data?.length === PAGE);
  async function loadOlder() {
    const all = [...(calls.data ?? []), ...older];
    const oldest = Math.min(...all.map((c) => c.id));
    setOlderState("loading");
    try {
      const page = await api<CallRow[]>(session, `/calls?limit=${PAGE}&before=${oldest}${sinceQuery}`);
      setOlder((o) => [...o, ...page]);
      setOlderState(page.length < PAGE ? "done" : "idle");
    } catch {
      setOlderState("idle");
    }
  }

  const [search, setSearch] = useState("");
  const [tool, setTool] = useState("");
  const [decision, setDecision] = useState("");
  const [outcome, setOutcome] = useState("");
  const [agent, setAgent] = useState("");
  const reset = () => {
    setSearch("");
    setTool("");
    setDecision("");
    setOutcome("");
    setAgent("");
    setRange("7d");
  };

  const rows = useMemo<ActivityRow[]>(() => {
    const seen = new Set<number>();
    const list: ActivityRow[] = [];
    for (const call of [...(calls.data ?? []), ...older]) {
      if (seen.has(call.id)) continue;
      seen.add(call.id);
      list.push({ kind: "call", key: `call:${call.id}`, time: call.created_at, tool: call.tool, call });
    }
    for (const event of unattributed.data ?? []) {
      if (since && event.receivedAt < since) continue;
      list.push({ kind: "unattributed", key: `event:${event.eventId}`, time: event.receivedAt, tool: event.tool ?? event.eventType, event });
    }
    return list;
  }, [calls.data, older, unattributed.data, since]);

  const q = search.trim().toLowerCase();
  const shown = useMemo(
    () =>
      rows.filter(
        (r) =>
          (!tool || r.tool === tool) &&
          (!decision || rowDecision(r) === decision) &&
          (!outcome || rowOutcome(r) === outcome) &&
          (!agent || rowAgent(r) === agent) &&
          matches(r, q),
      ),
    [rows, tool, decision, outcome, agent, q],
  );

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = rows.find((r) => r.key === selectedKey) ?? null;
  const close = useCallback(() => setSelectedKey(null), []);

  const theme = useGridTheme();
  const { api: grid, onGridReady } = useGridApi<ActivityRow>();
  const columns = useMemo<ColDef<ActivityRow>[]>(
    () => [
      { headerName: "Time", field: "time", width: 120, sort: "desc", cellRenderer: (p: { value: string }) => <TimeCell iso={p.value} /> },
      {
        headerName: "Action",
        field: "tool",
        flex: 1,
        minWidth: 170,
        valueFormatter: (p) => toolLabel(p.value ?? ""),
        cellRenderer: (p: { value: string; data?: ActivityRow }) => (
          <span className="cell-tool">
            <ToolIcon tool={p.value} size={15} tone={p.data && rowDecision(p.data) === "require_approval" ? "warn" : undefined} />
            {toolLabel(p.value)}
          </span>
        ),
      },
      {
        headerName: "Amount",
        colId: "amount",
        width: 120,
        type: "rightAligned",
        cellClass: "num",
        valueGetter: (p) => (p.data ? rowAmount(p.data)?.hundredths ?? null : null),
        valueFormatter: (p) => (p.data && rowAmount(p.data) ? formatMoney(rowAmount(p.data)) : "—"),
      },
      {
        headerName: "Decision",
        colId: "decision",
        width: 168,
        valueGetter: (p) => (p.data ? rowDecision(p.data) : ""),
        cellRenderer: (p: { value: string }) => (p.value === "none" ? <Pill tone="flag">No Handrail decision</Pill> : <DecisionPill decision={p.value} />),
      },
      {
        headerName: "Outcome",
        colId: "outcome",
        width: 150,
        valueGetter: (p) => (p.data ? rowOutcome(p.data) : ""),
        cellRenderer: (p: { value: string }) => (p.value === "unattributed" ? <Pill tone="flag">Unattributed</Pill> : <StatusPill status={p.value === "in_flight" ? null : p.value} />),
      },
      {
        headerName: "PayPal response",
        colId: "paypal",
        flex: 1.2,
        minWidth: 170,
        cellClass: "cell-muted",
        valueGetter: (p) =>
          p.data?.kind === "call"
            ? p.data.call.forwarded
              ? paypalSummary(parseJson(p.data.call.result_json)) || "—"
              : "Not sent"
            : p.data
              ? `${p.data.event.eventType}`
              : "",
        tooltipValueGetter: (p) => p.value,
      },
      { headerName: "Agent", colId: "agent", width: 160, valueGetter: (p) => (p.data ? rowAgent(p.data) : "") },
      {
        headerName: "Request ID",
        colId: "request_id",
        width: 200,
        cellClass: "mono-cell",
        valueGetter: (p) => (p.data?.kind === "call" ? p.data.call.request_id ?? "—" : p.data?.event.resourceId ?? "—"),
        tooltipValueGetter: (p) => p.value,
      },
      {
        headerName: "Reason",
        colId: "reason",
        hide: true,
        valueGetter: (p) => (p.data?.kind === "call" ? p.data.call.reason : p.data?.event.reasons[0] ?? ""),
      },
    ],
    [],
  );

  const tools = optionsFrom("All actions", rows.map((r) => r.tool), toolLabel);
  const outcomes = optionsFrom("All", rows.map(rowOutcome), (v) => OUTCOME_LABELS[v] ?? v);
  const agents = optionsFrom("All", rows.map(rowAgent));
  const error = calls.error ?? unattributed.error;
  const filtered = !!(search || tool || decision || outcome || agent || range !== "7d");

  return (
    <div className={`explore ${selected ? "has-panel" : ""}`}>
      <div className="explore-main">
        <PageHeader
          title={title}
          subtitle={subtitle}
          actions={
            <>
              <ExportButton api={grid} fileName="handrail-activity" params={{ columnKeys: ["time", "tool", "amount", "decision", "outcome", "paypal", "agent", "request_id", "reason"] }} />
              <LiveChip seconds={3} error={!!calls.error} />
            </>
          }
        />
        <FilterCard onReset={reset} active={filtered}>
          <div className="filter-row">
            <SearchField value={search} onChange={setSearch} placeholder="Search by request ID, payment ID, customer, agent…" />
            <DateRange value={range} onChange={setRange} initial="7d" />
          </div>
          <div className="filter-row">
            <FilterSelect label="Action" value={tool} options={tools} onChange={setTool} />
            <FilterSelect label="Decision" value={decision} options={DECISIONS} onChange={setDecision} />
            <FilterSelect label="Outcome" value={outcome} options={outcomes} onChange={setOutcome} />
            <FilterSelect label="Agent" value={agent} options={agents} onChange={setAgent} />
          </div>
        </FilterCard>
        {error && <p className="error">{error.message}</p>}
        <section className="grid-card">
          <AgGridReact<ActivityRow>
            theme={theme}
            rowData={shown}
            columnDefs={columns}
            defaultColDef={{ sortable: true, resizable: true }}
            getRowId={(p) => p.data.key}
            onGridReady={onGridReady}
            onCellClicked={(e: CellClickedEvent<ActivityRow>) => e.data && !e.column.getColId().startsWith("ag-Grid-") && setSelectedKey(e.data.key)}
            rowSelection={{ mode: "multiRow", checkboxes: true, headerCheckbox: true, enableClickSelection: false }}
            rowClass="clickable"
            rowClassRules={{ "row-unattributed": (p) => p.data?.kind === "unattributed", "row-open": (p) => p.data?.key === selectedKey }}
            pagination
            paginationPageSize={25}
            paginationPageSizeSelector={false}
            suppressPaginationPanel
            domLayout="autoHeight"
            loading={!calls.data && !calls.error}
            overlayNoRowsTemplate={rows.length ? "Nothing matches these filters." : "No agent calls in this range. Calls appear here as the agent makes them."}
            tooltipShowDelay={400}
            animateRows={false}
          />
          <GridFooter
            api={grid}
            note={
              canLoadOlder ? (
                <button type="button" className="link-btn" onClick={loadOlder} disabled={olderState === "loading"}>
                  <RefreshCw size={14} aria-hidden="true" />
                  {olderState === "loading" ? "Loading…" : `Showing the newest ${loaded} calls · load older`}
                </button>
              ) : null
            }
          />
        </section>
      </div>
      {selected?.kind === "call" && <CallPanel key={selected.key} call={selected.call} session={session} onClose={close} />}
      {selected?.kind === "unattributed" && <UnattributedPanel key={selected.key} event={selected.event} onClose={close} />}
    </div>
  );
}

function CallPanel({ call, session, onClose }: { call: CallRow; session: Session; onClose: () => void }) {
  const [tab, setTab] = useState("overview");
  const now = useNow(1000);
  const audit = usePoll(() => api<AuditEntry[]>(session, `/audit?ref=call:${call.id}`), 5000, String(call.id));
  const approval = usePoll(
    () => (call.approval_id ? api<Approval>(session, `/approvals/${call.approval_id}`) : Promise.resolve(null)),
    5000,
    String(call.id),
  );
  const a = approval.data;
  const hits = parseJson<RuleHit[]>(call.hits_json) ?? [];
  const result = parseJson(call.result_json);
  const amount = callAmount(call);
  const decision = callDecision(call);
  const pending = a?.status === "pending";
  const tone = decision === "block" ? "bad" : decision === "require_approval" ? "warn" : decision === "duplicate" ? "info" : "good";

  return (
    <SidePanel
      icon={<ToolIcon tool={call.tool} size={20} tone={pending ? "warn" : undefined} />}
      title={toolLabel(call.tool)}
      badge={<DecisionPill decision={decision} />}
      subtitle={
        <>
          Call #{call.id} · {formatTime(call.created_at)}
        </>
      }
      tabs={[
        { id: "overview", label: "Overview" },
        { id: "input", label: "Agent input" },
        { id: "rules", label: "Rules", count: hits.length },
        { id: "paypal", label: "PayPal" },
        { id: "audit", label: "Audit", count: audit.data?.length },
      ]}
      tab={tab}
      onTab={setTab}
      onClose={onClose}
    >
      {tab === "overview" && (
        <>
          <div className="panel-amount">
            <div>
              <p className="detail-label">Amount</p>
              {amount ? (
                <p className="detail-amount">
                  <span className="num">{formatMoney(amount)}</span>
                  <small>{amount.currency}</small>
                </p>
              ) : (
                <p className="detail-amount-none">No amount in this call</p>
              )}
            </div>
            {pending && a && (
              <div className={`detail-countdown ${new Date(a.expiresAt).getTime() <= now ? "expired" : ""}`}>
                <span>
                  <Clock size={18} aria-hidden="true" />
                  {countdown(a.expiresAt, now)}
                </span>
                <small>Expires at {new Date(a.expiresAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</small>
              </div>
            )}
          </div>

          <div className={`reason-box reason-${tone}`}>
            <p className="reason-title">
              {decision === "require_approval" ? "Held by rule" : decision === "block" ? "Blocked by rule" : decision === "duplicate" ? "Repeat of an earlier call" : "Allowed"}
            </p>
            <p>{call.reason}</p>
          </div>

          {a?.decidedBy && (
            <p className="detail-decider">
              {a.status === "rejected" ? "Rejected" : "Approved"} by <strong>{a.decidedBy}</strong>
              {a.note && <> · “{a.note}”</>}
            </p>
          )}

          <Facts
            rows={[
              ["Action", <Mono key="t">{call.tool}</Mono>],
              ["Capture ID", call.capture_id && <span className="mono-text">{call.capture_id}</span>],
              ["Order ID", call.order_id && <span className="mono-text">{call.order_id}</span>],
              ["Customer", call.payer],
              ["Agent", call.agent_name ?? "Not recorded (before agent keys)"],
              ["Time", new Date(call.created_at).toLocaleString()],
              ["Outcome", <StatusPill key="o" status={call.outcome} />],
              ["Sent to PayPal", call.forwarded ? "Yes" : "No"],
              ["Request ID", call.request_id && <span className="mono-text">{call.request_id}</span>],
              ["Took", call.duration_ms !== null ? `${call.duration_ms} ms` : null],
              ["Amount from", call.amount_source],
            ]}
          />

          <Verified verified={parseJson<VerifiedFacts>(call.verified_json)} />
          {a && <AgentSays approval={a} />}
          {a && <AiBrief approval={a} />}

          {pending && a && (
            <a className="btn btn-dark btn-lg panel-cta" href={`#approvals/${a.id}`}>
              Review in Approvals
              <ArrowRight size={18} aria-hidden="true" />
            </a>
          )}
        </>
      )}

      {tab === "input" && (
        <>
          <p className="panel-note">What the agent sent, after Handrail removed anything that looked like a secret.</p>
          <JsonBlock value={parseJson(call.args_json)} />
        </>
      )}

      {tab === "rules" &&
        (hits.length === 0 ? (
          <p className="panel-note">No rule fired; the policy's default applied. {call.reason}</p>
        ) : (
          <ul className="rule-list">
            {hits.map((h) => (
              <li key={h.ruleId}>
                <DecisionPill decision={h.decision} />
                <div>
                  <Mono>{h.ruleId}</Mono>
                  <p>{h.reason}</p>
                </div>
              </li>
            ))}
          </ul>
        ))}

      {tab === "paypal" &&
        (call.forwarded ? (
          <>
            <p className="panel-note">
              {paypalSummary(result) || "PayPal's answer"}
              {call.request_id && (
                <>
                  {" "}
                  · sent with PayPal-Request-Id <Mono>{call.request_id}</Mono>
                </>
              )}
            </p>
            {result != null ? <JsonBlock value={result} /> : <p className="panel-note">No answer yet.</p>}
          </>
        ) : (
          <>
            <p className="panel-note">Handrail didn't send this call to PayPal. This is what it told the agent instead:</p>
            {result != null && <JsonBlock value={result} />}
          </>
        ))}

      {tab === "audit" && (
        <>
          {audit.data?.length === 0 && <p className="panel-note">This call predates the audit log.</p>}
          <ol className="chain">
            {[...(audit.data ?? [])].reverse().map((e) => (
              <li key={e.seq}>
                <span className="chain-seq">#{e.seq}</span>
                <span className="chain-kind">{e.kind}</span>
                <span className="muted">{formatTime(e.at)}</span>
                <Mono title={e.hash}>{e.hash.slice(0, 12)}…</Mono>
              </li>
            ))}
          </ol>
          <a className="view-all" href="#audit">
            Open the audit log <ArrowRight size={15} aria-hidden="true" />
          </a>
        </>
      )}
    </SidePanel>
  );
}

/** A money-out action PayPal reported that no agent call through Handrail made. */
function UnattributedPanel({ event, onClose }: { event: UnattributedEvent; onClose: () => void }) {
  const alert = event.alert;
  return (
    <SidePanel
      icon={<ToolIcon tool={event.tool ?? "webhook"} size={20} />}
      title={toolLabel(event.tool ?? event.eventType)}
      badge={<Pill tone="flag">Unattributed</Pill>}
      subtitle={<>Reported {formatTime(event.receivedAt)}</>}
      tabs={[{ id: "overview", label: "Overview" }]}
      tab="overview"
      onTab={() => {}}
      onClose={onClose}
    >
      <div className="panel-amount">
        <div>
          <p className="detail-label">Amount</p>
          {event.amount ? (
            <p className="detail-amount">
              <span className="num">{formatMoney(event.amount)}</span>
              <small>{event.amount.currency}</small>
            </p>
          ) : (
            <p className="detail-amount-none">Not in PayPal's event</p>
          )}
        </div>
      </div>
      <div className="reason-box reason-flag">
        <p className="reason-title">Not sent through Handrail</p>
        <p>{event.reasons[0] ?? "PayPal reports this, but no agent call through Handrail made it."}</p>
      </div>
      <p className="panel-note">
        Something may be bypassing Handrail: an agent with its own PayPal credentials, a direct PayPal or Agent Toolkit connection, or a
        person acting in PayPal. Check the <a href="#setup">Setup checklist</a>.
      </p>
      <Facts
        rows={[
          ["PayPal event", <Mono key="e">{event.eventType}</Mono>],
          ["PayPal id", <span key="r" className="mono-text">{event.resourceId ?? "unknown"}</span>],
          ["Event id", <span key="i" className="mono-text">{event.eventId}</span>],
          ["Signature", event.verified ? "Signed by PayPal" : "Not verified"],
          [
            "Alert",
            !alert
              ? "Not alerted yet"
              : alert.status === "preview"
                ? "Demo: shown as a preview, not sent"
                : alert.status === "off"
                  ? "Alerts are off"
                  : alert.emailedTo.length || alert.slack
                    ? [alert.emailedTo.length && `emailed ${alert.emailedTo.join(", ")}`, alert.slack && `Slack ${alert.slack}`].filter(Boolean).join(" · ")
                    : alert.status,
          ],
        ]}
      />
      {alert?.preview && (
        <details className="more">
          <summary>Alert preview</summary>
          <pre className="alert-preview-pre">{alert.preview.text}</pre>
        </details>
      )}
    </SidePanel>
  );
}
