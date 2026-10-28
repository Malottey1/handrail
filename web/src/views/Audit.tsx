import type { CellClickedEvent, ColDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import {
  Bell,
  CircleCheck,
  CircleUser,
  Files,
  KeyRound,
  Mail,
  ScrollText,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { api, type AuditEntry, type Session, type VerifyResult } from "../api";
import { CopyButton, JsonBlock, Mono, PageHeader, Pill, ToolIcon, usePoll } from "../components";
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
  "user.created": "Account created",
  "user.updated": "Account changed",
  "invite.created": "Invite sent",
  "invite.revoked": "Invite revoked",
  "agent_key.created": "Agent key created",
  "agent_key.revoked": "Agent key revoked",
  "alert.sent": "Alert sent",
  "settings.changed": "Settings changed",
};

function summarize(e: AuditEntry): string {
  const d = e.data as Record<string, any>;
  switch (e.kind) {
    case "call.decided":
      return `${d.tool}: ${d.decision}. ${d.reason ?? ""}${d.agent ? ` (agent: ${d.agent.name})` : ""}`;
    case "call.duplicate":
      return `${d.tool}: repeat of an earlier call, not sent again`;
    case "call.finished":
      return `outcome ${d.outcome}`;
    case "approval.created":
      return `${d.tool}: ${d.evaluation?.reason ?? ""}`;
    case "approval.decided":
      return `${d.decision === "approved" ? "Approved" : "Rejected"} by ${d.decidedBy}${d.note ? `: “${d.note}”` : ""}`;
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
    case "user.created":
      return `${d.user?.name} (${d.user?.email}) as ${d.role}, via ${d.via}`;
    case "user.updated": {
      const c = d.changes ?? {};
      const what = [
        c.role ? `role ${c.role}` : "",
        c.disabled === true ? "disabled" : c.disabled === false && c.role === undefined ? "enabled" : "",
        c.password ? "password changed" : "",
        c.name && !c.role && !c.password ? `profile updated` : "",
      ].filter(Boolean);
      return `${d.user?.name}: ${what.join(", ") || "updated"} by ${d.by?.name}`;
    }
    case "invite.created":
      return `${d.email} invited as ${d.role} by ${d.by?.name}`;
    case "invite.revoked":
    case "agent_key.revoked":
      return `by ${d.by?.name}`;
    case "agent_key.created":
      return `“${d.name}” (${d.prefix}…) by ${d.by?.name}`;
    case "alert.sent":
      return `Alert about ${d.about}: ${d.status}`;
    case "settings.changed":
      return `${d.setting} ${d.change}${d.by?.name ? ` by ${d.by.name}` : ""}`;
    case "chain.started":
      return `${d.toolCallsBefore} earlier calls predate the log`;
    default:
      return "";
  }
}


const KIND_ICONS: Array<[RegExp, LucideIcon]> = [
  [/^chain\./, Files],
  [/^approval\.explained/, Sparkles],
  [/^approval\./, ShieldCheck],
  [/^webhook\./, Webhook],
  [/^policy\./, ScrollText],
  [/^user\./, CircleUser],
  [/^invite\./, Mail],
  [/^agent_key\./, KeyRound],
  [/^alert\./, Bell],
  [/^settings\./, Settings],
];

function KindIcon({ entry }: { entry: AuditEntry }) {
  if (entry.kind.startsWith("call.")) return <ToolIcon tool={String((entry.data as { tool?: string }).tool ?? "")} size={15} />;
  const Icon = KIND_ICONS.find(([re]) => re.test(entry.kind))?.[1] ?? Files;
  return (
    <span className="tool-icon" aria-hidden="true">
      <Icon size={15} />
    </span>
  );
}

/** Who acted, when the entry records it; otherwise Handrail itself. */
function actorOf(e: AuditEntry): string {
  const d = e.data as Record<string, any>;
  if (e.kind === "approval.decided") return d.decidedBy ?? "Unknown";
  if (typeof d.by === "string") return d.by;
  if (d.by?.name) return d.by.name;
  if (d.agent?.name) return d.agent.name;
  if (e.kind === "user.created") return d.user?.name ?? "System";
  return "Handrail";
}

/** The result an entry records, as [label, tone], when it has one. */
function resultOf(e: AuditEntry): [string, string] | null {
  const d = e.data as Record<string, any>;
  switch (e.kind) {
    case "call.decided":
      return d.decision === "allow" ? ["Allowed", "good"] : d.decision === "block" ? ["Blocked", "bad"] : ["Held", "warn"];
    case "call.duplicate":
      return ["Duplicate", "info"];
    case "call.finished":
    case "approval.completed": {
      const o = String(d.outcome ?? d.status ?? "");
      return [o.charAt(0).toUpperCase() + o.slice(1), /succeeded|executed/.test(o) ? "good" : /failed|unknown/.test(o) ? "bad" : o === "held" ? "warn" : "muted"];
    }
    case "approval.created":
      return ["Held", "warn"];
    case "approval.decided":
      return d.decision === "approved" ? ["Approved", "good"] : ["Rejected", "bad"];
    case "approval.expired":
      return ["Expired", "muted"];
    case "webhook.received":
      return d.status === "matched"
        ? ["Matched", "good"]
        : d.status === "mismatch"
          ? ["Mismatch", "flag"]
          : d.status === "outside_handrail"
            ? ["Unattributed", "flag"]
            : [String(d.status ?? "Received"), "muted"];
    case "approval.explained":
      return d.explanationStatus === "ready" ? ["Ready", "ai"] : ["Failed", "bad"];
    default:
      return null;
  }
}

const RELATED = [
  { value: "", label: "All" },
  { value: "call", label: "Agent calls" },
  { value: "approval", label: "Approvals" },
  { value: "webhook", label: "Webhooks" },
  { value: "policy", label: "Policy" },
  { value: "user", label: "People" },
  { value: "invite", label: "Invites" },
  { value: "agent_key", label: "Agent keys" },
  { value: "alert", label: "Alerts" },
  { value: "settings", label: "Settings" },
  { value: "chain", label: "The log itself" },
];
const relatedOf = (e: AuditEntry) => e.ref.split(":")[0] ?? "";

const PAGE = 1000;

export function AuditView({
  session,
  verify,
  onVerify,
  title,
  subtitle,
}: {
  session: Session;
  verify: VerifyResult | null;
  onVerify: () => void;
  title: string;
  subtitle: string;
}) {
  const [range, setRange] = useState<RangeId>("all");
  const since = sinceFor(range);
  const sinceQuery = since ? `&since=${encodeURIComponent(since)}` : "";
  const entries = usePoll(() => api<AuditEntry[]>(session, `/audit?limit=${PAGE}${sinceQuery}`), 4000, range);
  const first = usePoll(() => api<{ seq: number; at: string } | null>(session, "/audit/first"), 60000);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("");
  const [result, setResult] = useState("");
  const [actor, setActor] = useState("");
  const [related, setRelated] = useState("");
  const reset = () => {
    setSearch("");
    setKind("");
    setResult("");
    setActor("");
    setRelated("");
    setRange("all");
  };

  const rows = entries.data ?? [];
  const q = search.trim().toLowerCase();
  const shown = useMemo(
    () =>
      rows.filter(
        (e) =>
          (!kind || e.kind === kind) &&
          (!result || (resultOf(e)?.[0] ?? "") === result) &&
          (!actor || actorOf(e) === actor) &&
          (!related || relatedOf(e) === related) &&
          (!q || [String(e.seq), e.kind, KIND_LABELS[e.kind], e.ref, e.hash, actorOf(e), summarize(e)].some((v) => v?.toLowerCase().includes(q))),
      ),
    [rows, kind, result, actor, related, q],
  );

  const broken = useMemo(() => new Set(verify?.problems.map((p) => p.seq).filter((s) => s !== null)), [verify]);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const selected = rows.find((e) => e.seq === selectedSeq) ?? null;
  const close = useCallback(() => setSelectedSeq(null), []);

  const theme = useGridTheme();
  const { api: grid, onGridReady } = useGridApi<AuditEntry>();
  const columns = useMemo<ColDef<AuditEntry>[]>(
    () => [
      {
        headerName: "#",
        field: "seq",
        width: 96,
        sort: "desc",
        cellRenderer: (p: { value: number }) => (
          <span className={`cell-seq ${broken.has(p.value) ? "is-broken" : ""}`}>
            <span className="cell-seq-dot" aria-hidden="true" />
            <span className="num">{p.value.toLocaleString()}</span>
          </span>
        ),
      },
      { headerName: "Time", field: "at", width: 120, cellRenderer: (p: { value: string }) => <TimeCell iso={p.value} /> },
      {
        headerName: "Event type",
        field: "kind",
        width: 210,
        valueFormatter: (p) => KIND_LABELS[p.value] ?? p.value,
        cellRenderer: (p: { value: string; data?: AuditEntry }) =>
          p.data && (
            <span className="cell-tool">
              <KindIcon entry={p.data} />
              <span className="cell-event">{p.value}</span>
            </span>
          ),
      },
      {
        headerName: "Description",
        colId: "summary",
        flex: 2,
        minWidth: 240,
        cellClass: "cell-wrap",
        valueGetter: (p) => (p.data ? summarize(p.data) || KIND_LABELS[p.data.kind] || "" : ""),
        tooltipValueGetter: (p) => p.value,
      },
      { headerName: "Actor", colId: "actor", width: 150, valueGetter: (p) => (p.data ? actorOf(p.data) : "") },
      {
        headerName: "Result",
        colId: "result",
        width: 130,
        valueGetter: (p) => (p.data ? resultOf(p.data)?.[0] ?? "" : ""),
        cellRenderer: (p: { data?: AuditEntry }) => {
          const r = p.data && resultOf(p.data);
          return r ? <Pill tone={r[1]}>{r[0]}</Pill> : <span className="muted">—</span>;
        },
      },
      { headerName: "About", field: "ref", hide: true },
      { headerName: "Hash", field: "hash", hide: true },
    ],
    [broken],
  );

  const kinds = optionsFrom("All types", rows.map((e) => e.kind));
  const results = optionsFrom("All results", rows.map((e) => resultOf(e)?.[0]));
  const actors = optionsFrom("All actors", rows.map(actorOf));
  const filtered = !!(search || kind || result || actor || related || range !== "all");
  const latest = rows[0];

  function verifyNow() {
    onVerify();
    setCheckedAt(Date.now());
  }

  return (
    <div className={`explore ${selected ? "has-panel" : ""}`}>
      <div className="explore-main">
        <PageHeader
          title={title}
          subtitle={subtitle}
          actions={
            <>
              <ExportButton api={grid} fileName="handrail-audit" params={{ columnKeys: ["seq", "at", "kind", "summary", "actor", "result", "ref", "hash"] }} />
              <button type="button" className="btn btn-secondary btn-lg" onClick={verifyNow}>
                <ShieldCheck size={18} aria-hidden="true" />
                Verify integrity
              </button>
              <LiveChip seconds={4} error={!!entries.error} />
            </>
          }
        />

        {verify && (
          <section className={`integrity-card ${verify.ok ? "is-ok" : "is-bad"}`} aria-live="polite">
            <span className="integrity-card-icon" aria-hidden="true">
              {verify.ok ? <CircleCheck size={26} /> : <ShieldAlert size={26} />}
            </span>
            <div className="integrity-card-main">
              <h2>{verify.ok ? "Audit log intact" : "Tampering detected"}</h2>
              <p>
                {verify.ok ? (
                  <>
                    {verify.entries.toLocaleString()} entries verified. Latest hash:{" "}
                    <span className="mono-text" title={verify.head}>
                      {verify.head.slice(0, 12)}…{verify.head.slice(-4)}
                    </span>
                    {checkedAt && <> · checked {new Date(checkedAt).toLocaleTimeString()}</>}
                  </>
                ) : (
                  <>
                    {verify.problems.length} problem{verify.problems.length === 1 ? "" : "s"} found. Every hash after a changed entry breaks,
                    and the working tables must agree with the log.
                  </>
                )}
              </p>
              {!verify.ok && (
                <ul className="integrity-problems">
                  {verify.problems.slice(0, 8).map((p, i) => (
                    <li key={i}>
                      <TriangleAlert size={14} aria-hidden="true" />
                      {p.seq ? `#${p.seq} ` : ""}
                      {p.ref && <Mono>{p.ref}</Mono>} {p.problem}
                    </li>
                  ))}
                  {verify.problems.length > 8 && <li>…and {verify.problems.length - 8} more</li>}
                </ul>
              )}
            </div>
            <dl className="integrity-card-dates">
              <div>
                <dt>First entry</dt>
                <dd>{first.data ? formatDateTime(first.data.at) : "–"}</dd>
              </div>
              <div>
                <dt>Latest entry</dt>
                <dd>{latest ? formatDateTime(latest.at) : "–"}</dd>
              </div>
            </dl>
          </section>
        )}

        <FilterCard onReset={reset} active={filtered}>
          <div className="filter-row">
            <SearchField value={search} onChange={setSearch} placeholder="Search by event, ID, hash or person…" />
            <DateRange value={range} onChange={setRange} initial="all" />
          </div>
          <div className="filter-row">
            <FilterSelect label="Event type" value={kind} options={kinds} onChange={setKind} />
            <FilterSelect label="Result" value={result} options={results} onChange={setResult} />
            <FilterSelect label="Actor" value={actor} options={actors} onChange={setActor} />
            <FilterSelect label="Related to" value={related} options={RELATED} onChange={setRelated} />
          </div>
        </FilterCard>
        {entries.error && <p className="error">{entries.error.message}</p>}
        <section className="grid-card">
          <AgGridReact<AuditEntry>
            theme={theme}
            rowData={shown}
            columnDefs={columns}
            defaultColDef={{ sortable: true, resizable: true }}
            getRowId={(p) => String(p.data.seq)}
            onGridReady={onGridReady}
            onCellClicked={(e: CellClickedEvent<AuditEntry>) => e.data && !e.column.getColId().startsWith("ag-Grid-") && setSelectedSeq(e.data.seq)}
            rowSelection={{ mode: "multiRow", checkboxes: true, headerCheckbox: true, enableClickSelection: false }}
            rowClass="clickable"
            rowClassRules={{ "row-broken": (p) => !!p.data && broken.has(p.data.seq), "row-open": (p) => p.data?.seq === selectedSeq }}
            pagination
            paginationPageSize={25}
            paginationPageSizeSelector={false}
            suppressPaginationPanel
            domLayout="autoHeight"
            loading={!entries.data && !entries.error}
            overlayNoRowsTemplate={rows.length ? "Nothing matches these filters." : "No audit entries in this range."}
            tooltipShowDelay={300}
            animateRows={false}
          />
          <GridFooter api={grid} note={rows.length === PAGE ? `Showing the newest ${PAGE} entries; narrow the date range for older ones` : null} />
        </section>
      </div>
      {selected && <EntryPanel key={selected.seq} entry={selected} intact={!!verify?.ok || !broken.has(selected.seq)} onClose={close} />}
    </div>
  );
}

const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

function EntryPanel({ entry: e, intact, onClose }: { entry: AuditEntry; intact: boolean; onClose: () => void }) {
  const [tab, setTab] = useState("details");
  const r = resultOf(e);
  return (
    <SidePanel
      icon={<KindIcon entry={e} />}
      title={<span className="panel-event">{e.kind}</span>}
      badge={r && <Pill tone={r[1]}>{r[0]}</Pill>}
      subtitle={
        <>
          Entry #{e.seq.toLocaleString()} · {formatTime(e.at)}
        </>
      }
      tabs={[
        { id: "details", label: "Details" },
        { id: "hashes", label: "Hashes" },
        { id: "raw", label: "Raw data" },
      ]}
      tab={tab}
      onTab={setTab}
      onClose={onClose}
    >
      {tab === "details" && (
        <>
          <h3 className="panel-h">Event summary</h3>
          <p className="panel-lede">{summarize(e) || KIND_LABELS[e.kind] || e.kind}</p>
          <Facts
            rows={[
              ["Event type", <Mono key="k">{e.kind}</Mono>],
              ["What it is", KIND_LABELS[e.kind]],
              ["Time", new Date(e.at).toLocaleString()],
              ["Actor", actorOf(e)],
              ["Result", r && <Pill key="r" tone={r[1]}>{r[0]}</Pill>],
              ["About", <span key="a" className="mono-text">{e.ref}</span>],
            ]}
          />
          <div className={`reason-box ${intact ? "reason-good" : "reason-bad"}`}>
            <p className="reason-title">{intact ? "Entry verified" : "This entry fails verification"}</p>
            <p>{intact ? "Part of an unbroken hash chain, and the working tables agree with it." : "Its hash, or the record it describes, has changed since it was written."}</p>
          </div>
        </>
      )}
      {tab === "hashes" && (
        <>
          <p className="panel-note">
            Each entry's hash covers the previous hash and this entry's number, time, type, subject and data, so changing any earlier entry
            changes every hash after it.
          </p>
          <HashRow label="Previous hash" value={e.prev_hash} />
          <HashRow label="This entry's hash" value={e.hash} />
          <Facts
            rows={[
              ["Algorithm", "SHA-256"],
              ["Covers", <span key="c" className="mono-text">prev_hash, seq, at, kind, ref, data</span>],
            ]}
          />
        </>
      )}
      {tab === "raw" && (
        <>
          <div className="panel-row">
            <p className="panel-note">The data recorded in the entry, exactly as hashed.</p>
            <CopyButton text={JSON.stringify(e.data, null, 2)} label="Copy JSON" className="btn btn-secondary btn-sm" />
          </div>
          <JsonBlock value={e.data} />
        </>
      )}
    </SidePanel>
  );
}

function HashRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="hash-row">
      <span className="hash-label">{label}</span>
      <code className="hash-value" title={value}>
        {value}
      </code>
      <CopyButton text={value} label="Copy" className="icon-btn icon-btn-plain copy-icon" />
    </div>
  );
}
