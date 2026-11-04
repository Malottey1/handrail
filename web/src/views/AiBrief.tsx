import { Sparkles } from "lucide-react";
import type { Approval } from "../api";

/**
 * The AI-written brief. Shown below the facts, and labelled as advisory: the
 * rules decided to hold the call, and only a person decides.
 */
export function AiBrief({ approval: a }: { approval: Approval }) {
  const status = a.explanationStatus;
  if (!status) return null;
  if (status === "unavailable" || status === "failed") {
    return (
      <section className="ai-brief" aria-live="polite">
        <header className="ai-brief-head">
          <Sparkles size={20} aria-hidden="true" />
          <h3>AI brief unavailable</h3>
        </header>
        <p className="ai-brief-text">The rule above is why this was held. You can still approve or reject it.</p>
      </section>
    );
  }
  const e = a.explanation;
  return (
    <section className="ai-brief" aria-live="polite">
      <header className="ai-brief-head">
        <Sparkles size={20} aria-hidden="true" />
        <h3>AI brief</h3>
        <span className="ai-brief-note" title={a.explanationModel ?? undefined}>
          Advisory only. It can't approve anything.
        </span>
      </header>
      {status === "pending" && (
        <div className="ai-loading">
          <span className="shimmer" />
          <span className="shimmer short" />
        </div>
      )}
      {status === "ready" && e && (
        <>
          <p className="ai-brief-text">{e.summary}</p>
          <div className="ai-brief-cols">
            {e.concerns.length > 0 && (
              <div>
                <p className="ai-brief-sub ai-brief-sub-warn">Watch-outs</p>
                <ul>
                  {e.concerns.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            )}
            <div>
              <p className="ai-brief-sub">Things to check</p>
              <ul>
                {e.checkBeforeApproving.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
            {e.context.length > 0 && (
              <div>
                <p className="ai-brief-sub">Context</p>
                <ul>
                  {e.context.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
