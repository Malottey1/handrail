import type { ColDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useMemo, useState } from "react";
import { api, type AuditEntry, type CallRow, type RuleHit, type Session } from "../api";
import { DecisionPill, Drawer, JsonBlock, Mono, Pill, StatusPill, usePoll } from "../components";
import { callAmount, formatMoney, formatTime, parseJson, paypalSummary, toolLabel } from "../format";
import { useGridTheme } from "../grid";

export function ActivityView({ session }: { session: Session }) {
  const calls = usePoll(() => api<CallRow[]>(session, "/calls?limit=500"), 3000);
  const [selected, setSelected] = useState<CallRow | null>(null);
  const theme = useGridTheme();

  const columns = useMemo<ColDef<CallRow>[]>(
    () => [
      { headerName: "#", field: "id", width: 70, sort: "desc", filter: false },
      { headerName: "Time", field: "created_at", width: 120, filter: false, valueFormatter: (p) => (p.value ? formatTime(p.value) : "") },
      { headerName: "Action", field: "tool", flex: 1, minWidth: 150, valueFormatter: (p) => toolLabel(p.value ?? "") },
      {
        headerName: "Amount",
        colId: "amount",
        width: 120,
        type: "rightAligned",
        filter: false,
        valueGetter: (p) => (p.data ? callAmount(p.data)?.hundredths ?? null : null),
        valueFormatter: (p) => (p.data ? formatMoney(callAmount(p.data)) : ""),
      },
      { headerName: "Decision", field: "decision", width: 150, cellRenderer: (p: { value: string }) => <DecisionPill decision={p.value} /> },
      { headerName: "Outcome", field: "outcome", width: 135, cellRenderer: (p: { value: string | null }) => <StatusPill status={p.value} /> },
      {
        headerName: "PayPal said",
        colId: "paypal",
        flex: 1.4,
        minWidth: 180,
        valueGetter: (p) => (p.data ? paypalSummary(parseJson(p.data.result_json)) : ""),
      },
      { headerName: "Reason", field: "reason", flex: 2, minWidth: 220, tooltipField: "reason" },
      { headerName: "PayPal-Request-Id", field: "request_id", width: 190, filter: false, hide: window.innerWidth < 1400, cellClass: "mono-cell" },
    ],
    [],
  );

  return (
    <div className="grid-view">
      {calls.error && <p className="error">{calls.error.message}</p>}
      <div className="grid-wrap">
        <AgGridReact<CallRow>
          theme={theme}
          rowData={calls.data ?? []}
          columnDefs={columns}
          defaultColDef={{ sortable: true, filter: true, resizable: true }}
          getRowId={(p) => String(p.data.id)}
          onRowClicked={(e) => e.data && setSelected(e.data)}
          rowClass="clickable"
          loading={!calls.data && !calls.error}
          overlayNoRowsTemplate="No agent calls yet. Calls appear here as the agent makes them."
          tooltipShowDelay={400}
          animateRows={false}
        />
      </div>
      {selected && <CallDrawer call={selected} session={session} onClose={() => setSelected(null)} />}
    </div>
  );
}

function CallDrawer({ call, session, onClose }: { call: CallRow; session: Session; onClose: () => void }) {
  const audit = usePoll(() => api<AuditEntry[]>(session, `/audit?ref=call:${call.id}`), 5000, String(call.id));
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
        <DecisionPill decision={call.decision} />
        <StatusPill status={call.outcome} />
        {call.forwarded ? <Pill tone="info">Sent to PayPal</Pill> : <Pill tone="muted">Not sent to PayPal</Pill>}
      </div>
      <p className="detail-reason">{call.reason}</p>

      <dl className="kv">
        <div>
          <dt>time</dt>
          <dd>{new Date(call.created_at).toLocaleString()}</dd>
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
