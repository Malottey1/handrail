import type { ColDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useMemo, useState } from "react";
import { api, type Approval, type AuditEntry, type CallRow, type RuleHit, type Session, type UnattributedEvent, type VerifiedFacts } from "../api";
import { DecisionPill, Drawer, JsonBlock, Mono, Pill, StatusPill, usePoll } from "../components";
import { callAmount, callDecision, formatMoney, formatTime, parseJson, paypalSummary, toolLabel } from "../format";
import { useGridTheme } from "../grid";
import { Verified } from "./Approvals";

/**
 * One row in the Activity grid: an agent call through Handrail, or a
 * money-out action PayPal reported that didn't go through Handrail.
 */
type ActivityRow =
  | { kind: "call"; key: string; time: string; tool: string; call: CallRow }
  | { kind: "unattributed"; key: string; time: string; tool: string; event: UnattributedEvent };

export function ActivityView({ session }: { session: Session }) {
  const calls = usePoll(() => api<CallRow[]>(session, "/calls?limit=500"), 3000);
  const unattributed = usePoll(() => api<UnattributedEvent[]>(session, "/unattributed"), 10000);
  const [selected, setSelected] = useState<ActivityRow | null>(null);
  const theme = useGridTheme();

  const rows = useMemo<ActivityRow[]>(
    () => [
      ...(calls.data ?? []).map((call): ActivityRow => ({ kind: "call", key: `call:${call.id}`, time: call.created_at, tool: call.tool, call })),
      ...(unattributed.data ?? []).map(
        (event): ActivityRow => ({ kind: "unattributed", key: `event:${event.eventId}`, time: event.receivedAt, tool: event.tool ?? event.eventType, event }),
      ),
    ],
    [calls.data, unattributed.data],
  );

  const columns = useMemo<ColDef<ActivityRow>[]>(
    () => [
      { headerName: "#", colId: "id", width: 70, filter: false, valueGetter: (p) => (p.data?.kind === "call" ? p.data.call.id : null), valueFormatter: (p) => (p.value === null ? "–" : String(p.value)) },
      { headerName: "Time", field: "time", width: 120, sort: "desc", filter: false, valueFormatter: (p) => (p.value ? formatTime(p.value) : "") },
      { headerName: "Action", field: "tool", flex: 1, minWidth: 150, valueFormatter: (p) => toolLabel(p.value ?? "") },
      {
        headerName: "Amount",
        colId: "amount",
        width: 120,
        type: "rightAligned",
        filter: false,
        valueGetter: (p) => (p.data ? rowAmount(p.data)?.hundredths ?? null : null),
        valueFormatter: (p) => (p.data ? formatMoney(rowAmount(p.data)) : ""),
      },
      {
        headerName: "Decision",
        colId: "decision",
        width: 160,
        valueGetter: (p) => (p.data?.kind === "call" ? callDecision(p.data.call) : "none"),
        cellRenderer: (p: { value: string }) => (p.value === "none" ? <Pill tone="flag">No Handrail decision</Pill> : <DecisionPill decision={p.value} />),
      },
      {
        headerName: "Outcome",
        colId: "outcome",
        width: 200,
        valueGetter: (p) => (p.data?.kind === "call" ? p.data.call.outcome : "unattributed"),
        cellRenderer: (p: { value: string | null }) => <StatusPill status={p.value} />,
      },
      {
        headerName: "PayPal said",
        colId: "paypal",
        flex: 1.4,
        minWidth: 180,
        valueGetter: (p) =>
          p.data?.kind === "call" ? paypalSummary(parseJson(p.data.call.result_json)) : p.data ? `${p.data.event.eventType} ${p.data.event.resourceId ?? ""}` : "",
      },
      {
        headerName: "Reason",
        colId: "reason",
        flex: 2,
        minWidth: 220,
        valueGetter: (p) => (p.data?.kind === "call" ? p.data.call.reason : p.data?.event.reasons[0] ?? ""),
        tooltipValueGetter: (p) => p.value,
      },
      {
        headerName: "Agent",
        colId: "agent",
        width: 160,
        valueGetter: (p) => (p.data?.kind === "call" ? p.data.call.agent_name ?? "–" : "Not through Handrail"),
      },
      {
        headerName: "PayPal-Request-Id",
        colId: "request_id",
        width: 190,
        filter: false,
        hide: window.innerWidth < 1400,
        cellClass: "mono-cell",
        valueGetter: (p) => (p.data?.kind === "call" ? p.data.call.request_id : null),
      },
    ],
    [],
  );

  const error = calls.error ?? unattributed.error;
  return (
    <div className="grid-view">
      {error && <p className="error">{error.message}</p>}
      <div className="grid-wrap">
        <AgGridReact<ActivityRow>
          theme={theme}
          rowData={rows}
          columnDefs={columns}
          defaultColDef={{ sortable: true, filter: true, resizable: true }}
          getRowId={(p) => p.data.key}
          onRowClicked={(e) => e.data && setSelected(e.data)}
          rowClass="clickable"
          getRowClass={(p) => (p.data?.kind === "unattributed" ? "row-unattributed" : undefined)}
          loading={!calls.data && !calls.error}
          overlayNoRowsTemplate="No agent calls yet. Calls appear here as the agent makes them."
          tooltipShowDelay={400}
          animateRows={false}
        />
      </div>
      {selected?.kind === "call" && <CallDrawer call={selected.call} session={session} onClose={() => setSelected(null)} />}
      {selected?.kind === "unattributed" && <UnattributedDrawer event={selected.event} onClose={() => setSelected(null)} />}
    </div>
  );
}

const rowAmount = (row: ActivityRow) => (row.kind === "call" ? callAmount(row.call) : row.event.amount);

/** A money-out action PayPal reported that no agent call through Handrail made. */
function UnattributedDrawer({ event, onClose }: { event: UnattributedEvent; onClose: () => void }) {
  return (
    <Drawer
      title={
        <>
          {toolLabel(event.tool ?? event.eventType)}
          {event.amount && <span className="muted"> {formatMoney(event.amount)}</span>}
        </>
      }
      onClose={onClose}
    >
      <div className="detail-pills">
        <StatusPill status="unattributed" />
        {event.verified ? <Pill tone="info">Signed by PayPal</Pill> : <Pill tone="warn">Signature not verified</Pill>}
      </div>
      <p className="detail-reason">{event.reasons[0] ?? "PayPal reports this, but no agent call through Handrail made it."}</p>
      <p>
        Something may be bypassing Handrail: an agent with its own PayPal credentials, a direct PayPal or Agent Toolkit connection,
        or a person acting in PayPal. Check the <a href="#setup">Setup checklist</a>.
      </p>
      <dl className="kv">
        <div>
          <dt>reported</dt>
          <dd>{new Date(event.receivedAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt>PayPal event</dt>
          <dd>
            <Mono>{event.eventType}</Mono>
          </dd>
        </div>
        <div>
          <dt>PayPal id</dt>
          <dd>
            <Mono>{event.resourceId ?? "unknown"}</Mono>
          </dd>
        </div>
        <div>
          <dt>event id</dt>
          <dd>
            <Mono>{event.eventId}</Mono>
          </dd>
        </div>
        <div>
          <dt>alert</dt>
          <dd>
            {!event.alert
              ? "Not alerted yet"
              : event.alert.status === "preview"
                ? "Demo: shown as a preview, not sent"
                : event.alert.status === "off"
                  ? "Alerts are off"
                  : event.alert.emailedTo.length || event.alert.slack
                    ? [event.alert.emailedTo.length && `emailed ${event.alert.emailedTo.join(", ")}`, event.alert.slack && `Slack ${event.alert.slack}`].filter(Boolean).join(" · ")
                    : event.alert.status}
          </dd>
        </div>
      </dl>
      {event.alert?.preview && (
        <>
          <h3>Alert preview</h3>
          <pre className="alert-preview-pre">{event.alert.preview.text}</pre>
        </>
      )}
    </Drawer>
  );
}

function CallDrawer({ call, session, onClose }: { call: CallRow; session: Session; onClose: () => void }) {
  const audit = usePoll(() => api<AuditEntry[]>(session, `/audit?ref=call:${call.id}`), 5000, String(call.id));
  const approval = usePoll(
    () => (call.approval_id ? api<Approval>(session, `/approvals/${call.approval_id}`) : Promise.resolve(null)),
    5000,
    String(call.id),
  );
  const decided = approval.data?.decidedBy ? approval.data : null;
  const hits = parseJson<RuleHit[]>(call.hits_json) ?? [];
  const result = parseJson(call.result_json);

  return (
    <Drawer
      title={
        <>
          #{call.id} · {toolLabel(call.tool)}
          {callAmount(call) && <span className="muted"> {formatMoney(callAmount(call))}</span>}
        </>
      }
      onClose={onClose}
    >
      <div className="detail-pills">
        <DecisionPill decision={callDecision(call)} />
        <StatusPill status={call.outcome} />
        {call.forwarded ? <Pill tone="info">Sent to PayPal</Pill> : <Pill tone="muted">Not sent to PayPal</Pill>}
      </div>
      <p className="detail-reason">{call.reason}</p>
      <Verified verified={parseJson<VerifiedFacts>(call.verified_json)} />
      {decided && (
        <p className="detail-decider">
          {decided.status === "rejected" ? "Rejected" : "Approved"} by <strong>{decided.decidedBy}</strong>
          {decided.note && <> · “{decided.note}”</>}
        </p>
      )}

      <dl className="kv">
        <div>
          <dt>time</dt>
          <dd>{new Date(call.created_at).toLocaleString()}</dd>
        </div>
        <div>
          <dt>agent</dt>
          <dd>{call.agent_name ?? "Not recorded (before agent keys)"}</dd>
        </div>
        <div>
          <dt>tool</dt>
          <dd>
            <Mono>{call.tool}</Mono>
          </dd>
        </div>
        {call.request_id && (
          <div>
            <dt>PayPal-Request-Id</dt>
            <dd>
              <Mono>{call.request_id}</Mono>
            </dd>
          </div>
        )}
        {call.approval_id && (
          <div>
            <dt>approval</dt>
            <dd>
              <Mono>{call.approval_id}</Mono>
            </dd>
          </div>
        )}
        {call.duration_ms !== null && (
          <div>
            <dt>took</dt>
            <dd>{call.duration_ms} ms</dd>
          </div>
        )}
        <div>
          <dt>amount from</dt>
          <dd>{call.amount_source}</dd>
        </div>
      </dl>

      {hits.length > 0 && (
        <>
          <h3>Rules that fired</h3>
          <ul className="hits">
            {hits.map((h) => (
              <li key={h.ruleId}>
                <DecisionPill decision={h.decision} /> <Mono>{h.ruleId}</Mono> {h.reason}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Agent's arguments</h3>
      <JsonBlock value={parseJson(call.args_json)} />

      {result != null && (
        <>
          <h3>Result returned to the agent</h3>
          <JsonBlock value={result} />
        </>
      )}

      <h3>Audit log entries</h3>
      {audit.data?.length === 0 && <p className="muted">This call predates the audit log.</p>}
      <ol className="chain">
        {[...(audit.data ?? [])].reverse().map((e) => (
          <li key={e.seq}>
            <span className="chain-seq">#{e.seq}</span>
            <span className="chain-kind">{e.kind}</span>
            <span className="muted">{formatTime(e.at)}</span>
            <Mono title={e.hash}>{e.hash.slice(0, 16)}…</Mono>
          </li>
        ))}
      </ol>
    </Drawer>
  );
}
