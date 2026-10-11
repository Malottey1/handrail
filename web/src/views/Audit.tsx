import type { ColDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useMemo, useState } from "react";
import { api, type AuditEntry, type Session, type VerifyResult } from "../api";
import { Drawer, JsonBlock, Mono, usePoll } from "../components";
import { formatTime } from "../format";
import { useGridTheme } from "../grid";

const KIND_LABELS: Record<string, string> = {
  "chain.started": "Log started",
  "call.decided": "Call decided",
  "call.duplicate": "Duplicate stopped",
  "call.finished": "Call finished",
  "approval.created": "Held for approval",
  "approval.decided": "Human decided",
  "approval.completed": "Approved call finished",
  "approval.expired": "Approval expired",
  "approval.explained": "AI brief written",
  "webhook.received": "Webhook received",
  "policy.loaded": "Policy loaded",
  "policy.changed": "Policy changed",
};

function summarize(e: AuditEntry): string {
  const d = e.data as Record<string, any>;
  switch (e.kind) {
    case "call.decided":
      return `${d.tool}: ${d.decision}. ${d.reason ?? ""}`;
    case "call.duplicate":
      return `${d.tool}: repeat of an earlier call, not sent again`;
    case "call.finished":
      return `outcome ${d.outcome}`;
    case "approval.created":
      return `${d.tool}: ${d.evaluation?.reason ?? ""}`;
    case "approval.decided":
      return `${d.decision} by ${d.decidedBy}${d.note ? `: “${d.note}”` : ""}`;
    case "approval.completed":
      return `status ${d.status}`;
    case "webhook.received":
      return `${d.eventType} → ${d.status}${d.callId ? ` (call #${d.callId})` : ""}`;
    case "approval.explained":
      return d.explanationStatus === "ready" ? `brief by ${d.model}: ${d.explanation?.summary ?? ""}` : `brief failed (${d.model})`;
    case "policy.loaded":
      return `${d.policy?.rules?.length ?? "?"} rules from ${d.path}`;
    case "policy.changed": {
      const parts = [
        d.added?.length ? `added ${d.added.join(", ")}` : "",
        d.removed?.length ? `removed ${d.removed.join(", ")}` : "",
        d.changed?.length ? `changed ${d.changed.join(", ")}` : "",
      ].filter(Boolean);
      return `${parts.join("; ")} by ${d.by}${d.source ? `: “${d.source}”` : ""}`;
    }
    case "chain.started":
      return `${d.toolCallsBefore} earlier calls predate the log`;
    default:
      return "";
  }
}

export function AuditView({ session, verify }: { session: Session; verify: VerifyResult | null }) {
  const entries = usePoll(() => api<AuditEntry[]>(session, "/audit?limit=1000"), 4000);
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const theme = useGridTheme();
  const broken = useMemo(() => new Set(verify?.problems.map((p) => p.seq).filter((s) => s !== null)), [verify]);

  const columns = useMemo<ColDef<AuditEntry>[]>(
    () => [
      { headerName: "#", field: "seq", width: 76, sort: "desc", filter: false },
      { headerName: "Time", field: "at", width: 120, filter: false, valueFormatter: (p) => (p.value ? formatTime(p.value) : "") },
      { headerName: "Event", field: "kind", width: 190, valueFormatter: (p) => KIND_LABELS[p.value] ?? p.value },
      { headerName: "About", field: "ref", width: 270, cellClass: "mono-cell" },
      { headerName: "Summary", colId: "summary", flex: 2, minWidth: 260, valueGetter: (p) => (p.data ? summarize(p.data) : ""), tooltipValueGetter: (p) => p.value },
      { headerName: "Hash", field: "hash", width: 170, filter: false, cellClass: "mono-cell", valueFormatter: (p) => `${String(p.value).slice(0, 16)}…` },
    ],
    [],
  );

  return (
    <div className="grid-view">
      <p className="lede">
        Append-only and hash-chained: each entry's hash covers the one before it, so changing or deleting any entry breaks every
        hash after it. Handrail re-checks the whole chain, and that the tables above still agree with it, every few seconds.
      </p>
      {verify && !verify.ok && (
        <div className="alert">
          <strong>Tampering detected.</strong>
          <ul>
            {verify.problems.slice(0, 8).map((p, i) => (
              <li key={i}>
                {p.seq ? `#${p.seq} ` : ""}
                {p.ref && <Mono>{p.ref}</Mono>} {p.problem}
              </li>
            ))}
            {verify.problems.length > 8 && <li>…and {verify.problems.length - 8} more</li>}
          </ul>
        </div>
      )}
      {entries.error && <p className="error">{entries.error.message}</p>}
      <div className="grid-wrap">
        <AgGridReact<AuditEntry>
          theme={theme}
          rowData={entries.data ?? []}
          columnDefs={columns}
          defaultColDef={{ sortable: true, filter: true, resizable: true }}
          getRowId={(p) => String(p.data.seq)}
          rowClassRules={{ "row-broken": (p) => !!p.data && broken.has(p.data.seq) }}
          onRowClicked={(e) => e.data && setSelected(e.data)}
          rowClass="clickable"
          loading={!entries.data && !entries.error}
          overlayNoRowsTemplate="The audit log is empty."
          tooltipShowDelay={300}
          animateRows={false}
        />
      </div>
      {selected && (
        <Drawer title={`Entry #${selected.seq} · ${KIND_LABELS[selected.kind] ?? selected.kind}`} onClose={() => setSelected(null)}>
          <dl className="kv">
            <div>
              <dt>time</dt>
              <dd>{new Date(selected.at).toLocaleString()}</dd>
            </div>
            <div>
              <dt>about</dt>
              <dd>
                <Mono>{selected.ref}</Mono>
              </dd>
            </div>
            <div>
              <dt>previous hash</dt>
              <dd>
                <Mono>{selected.prev_hash}</Mono>
              </dd>
            </div>
            <div>
              <dt>hash</dt>
              <dd>
                <Mono>{selected.hash}</Mono>
              </dd>
            </div>
          </dl>
          <h3>Recorded data</h3>
          <JsonBlock value={selected.data} />
        </Drawer>
      )}
    </div>
  );
}
