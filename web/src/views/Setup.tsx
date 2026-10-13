import { useState } from "react";
import { api, ApiError, can, type Session, type SetupChecklist, type SetupItem } from "../api";
import { Mono, usePoll } from "../components";
import { timeAgo } from "../format";

/**
 * Connecting an agent, and the checklist that makes Handrail the only way to
 * PayPal. Handrail checks what it can; the items about the agent's own
 * environment only a person can confirm (admins, recorded in the audit log).
 */
export function SetupView({ session }: { session: Session }) {
  const setup = usePoll(() => api<SetupChecklist>(session, "/setup"), 15000);
  const [error, setError] = useState<string | null>(null);
  const isAdmin = can(session, "admin");
  const now = Date.now();

  async function confirm(item: SetupItem, confirmed: boolean) {
    setError(null);
    try {
      await api(session, `/setup/${item.id}`, { method: "POST", body: { confirmed } });
      setup.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  if (setup.error) return <p className="error">{setup.error.message}</p>;
  if (!setup.data) return <p className="muted">Loading…</p>;
  const { items, mcpUrl, webhookUrl } = setup.data;
  const manual = items.filter((i) => i.kind === "confirm");
  const checked = items.filter((i) => i.kind === "auto");
  const done = items.filter((i) => i.ok).length;

  return (
    <div className="setup">
      <section className="card">
        <h2 className="section-title">
          Setup checklist <span className="count">{done} of {items.length}</span>
        </h2>
        <p className="section-help">
          Handrail only protects calls that go through it. An agent that also has PayPal credentials, or a direct PayPal connection,
          can skip every rule. Make sure Handrail is the only way your agent reaches PayPal.
        </p>
        {error && <p className="error">{error}</p>}

        <h3 className="setup-sub">Confirm about your agent</h3>
        <ul className="checklist">
          {manual.map((item) => (
            <li key={item.id} className={item.ok ? "ok" : "todo"}>
              <span className="check" aria-hidden="true">
                {item.ok ? "✓" : ""}
              </span>
              <div>
                <p className="check-label">{item.label}</p>
                <p className="check-detail">{item.detail}</p>
                {item.ok && item.confirmedBy && (
                  <p className="fine">
                    Confirmed by {item.confirmedBy}
                    {item.confirmedAt && ` ${timeAgo(item.confirmedAt, now)}`}
                  </p>
                )}
              </div>
              {isAdmin && (
                <button className={`btn ${item.ok ? "btn-ghost" : "btn-secondary"}`} onClick={() => void confirm(item, !item.ok)}>
                  {item.ok ? "Undo" : "Confirm"}
                </button>
              )}
            </li>
          ))}
        </ul>
        {!isAdmin && <p className="fine">Only an admin can confirm these. Confirmations are recorded in the audit log.</p>}

        <h3 className="setup-sub">Checked by Handrail</h3>
        <ul className="checklist">
          {checked.map((item) => (
            <li key={item.id} className={item.ok ? "ok" : "todo warn"}>
              <span className="check" aria-hidden="true">
                {item.ok ? "✓" : "!"}
              </span>
              <div>
                <p className="check-label">{item.label}</p>
                <p className="check-detail">{item.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2 className="section-title">Connect an agent</h2>
        <dl className="kv">
          <div>
            <dt>MCP endpoint</dt>
            <dd>
              <Mono>{mcpUrl}</Mono>
            </dd>
          </div>
          <div>
            <dt>Authentication</dt>
            <dd>
              <Mono>Authorization: Bearer &lt;agent key&gt;</Mono>
              {isAdmin ? (
                <>
                  {" "}
                  · create keys in <a href="#team">Team &amp; keys</a>
                </>
              ) : (
                " · an admin creates agent keys"
              )}
            </dd>
          </div>
          <div>
            <dt>PayPal webhook URL</dt>
            <dd>
              <Mono>{webhookUrl}</Mono>
            </dd>
          </div>
        </dl>
        <p className="fine">
          Point the agent's existing PayPal MCP configuration at Handrail instead: it sees the same tools, with no code changes. Give it
          an agent key, never PayPal credentials. Register the webhook URL in PayPal's developer dashboard so actions that skip Handrail
          are caught.
        </p>
      </section>
    </div>
  );
}
