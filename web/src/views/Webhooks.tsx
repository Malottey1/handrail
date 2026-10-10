import type { ColDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useMemo } from "react";
import { api, type Session, type WebhookRow } from "../api";
import { Pill, StatusPill, usePoll } from "../components";
import { formatTime, toolLabel } from "../format";
import { useGridTheme } from "../grid";

export function WebhooksView({ session }: { session: Session }) {
  const events = usePoll(() => api<WebhookRow[]>(session, "/webhooks"), 4000);
  const theme = useGridTheme();

  const columns = useMemo<ColDef<WebhookRow>[]>(
    () => [
      { headerName: "Received", field: "received_at", width: 130, sort: "desc", filter: false, valueFormatter: (p) => (p.value ? formatTime(p.value) : "") },
      { headerName: "PayPal event", field: "event_type", flex: 1.2, minWidth: 220, cellClass: "mono-cell" },
      { headerName: "Status", field: "status", width: 160, cellRenderer: (p: { value: string }) => <StatusPill status={p.value} /> },
      {
        headerName: "Agent call",
        colId: "call",
        width: 190,
        valueGetter: (p) => (p.data?.call_id ? `#${p.data.call_id} ${toolLabel(p.data.tool ?? "")}` : "—"),
      },
      { headerName: "Resource", field: "resource_id", width: 190, cellClass: "mono-cell" },
      {
        headerName: "Signature",
        field: "verified",
        width: 120,
        cellRenderer: (p: { value: number }) => (p.value ? <Pill tone="good">Verified</Pill> : <Pill tone="bad">Unverified</Pill>),
      },
      {
        headerName: "Details",
        colId: "reasons",
        flex: 2,
        minWidth: 240,
        valueGetter: (p) => p.data?.reasons.join("; ") || p.data?.summary || "",
        tooltipValueGetter: (p) => p.value,
      },
    ],
    [],
  );

  return (
    <div className="grid-view">
      <p className="lede">
        PayPal's signed notifications, each matched to the agent call that caused it. <strong>Mismatch</strong> means PayPal's
        record disagrees with what Handrail sent; <strong>Outside Handrail</strong> means money moved without going through
        Handrail.
      </p>
      {events.error && <p className="error">{events.error.message}</p>}
      <div className="grid-wrap">
        <AgGridReact<WebhookRow>
          theme={theme}
          rowData={events.data ?? []}
          columnDefs={columns}
          defaultColDef={{ sortable: true, filter: true, resizable: true }}
          getRowId={(p) => p.data.event_id}
          loading={!events.data && !events.error}
          overlayNoRowsTemplate="No webhooks received yet. Register /webhooks/paypal in the PayPal developer dashboard."
          tooltipShowDelay={300}
          animateRows={false}
        />
      </div>
    </div>
  );
}
