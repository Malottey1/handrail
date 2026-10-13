import type { AuthState, Session } from "../api";
import { Logo, Pill, ThemeToggle } from "../components";
import { link } from "../router";
import { useDemoSignIn } from "./AuthPages";

/** The public front page at /. */
export function HomePage({ auth, session, onSignedIn }: { auth: AuthState; session: Session | null; onSignedIn: (s: Session) => void }) {
  const demo = useDemoSignIn(onSignedIn);

  const actions = session ? (
    <a className="btn btn-primary btn-lg" {...link("/app")}>
      Open the dashboard
    </a>
  ) : (
    <>
      {auth.demoAccess && (
        <button className="btn btn-primary btn-lg" onClick={demo.start} disabled={demo.busy}>
          {demo.busy ? "Opening the demo…" : "Try the demo"}
        </button>
      )}
      <a className={`btn btn-lg ${auth.demoAccess ? "btn-secondary" : "btn-primary"}`} {...link(auth.setupRequired ? "/signup" : "/login")}>
        {auth.setupRequired ? "Set up Handrail" : "Sign in"}
      </a>
    </>
  );

  return (
    <div className="home">
      <header className="home-nav">
        <a className="brand" {...link("/")}>
          <Logo />
          <span className="brand-name">Handrail</span>
        </a>
        <nav className="home-links">
          <a href="#problem">The problem</a>
          <a href="#how">How it works</a>
        </nav>
        <div className="home-nav-actions">
          <ThemeToggle />
          {session ? (
            <a className="btn btn-secondary" {...link("/app")}>
              Dashboard
            </a>
          ) : (
            <a className="btn btn-secondary" {...link("/login")}>
              Sign in
            </a>
          )}
        </div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <p className="kicker">A drop-in safety layer for PayPal's Agent Toolkit</p>
          <h1>Let your agent work with PayPal, without handing it the keys to the till.</h1>
          <p className="hero-lede">
            Handrail sits between your AI agent and PayPal. Point an existing Agent Toolkit agent at it and change no code: every refund,
            dispute concession and cancellation is checked against your limits, sent to a person when it needs one, executed once, and
            written to an audit trail you can verify.
          </p>
          <div className="hero-actions">{actions}</div>
          {demo.error && <p className="error">{demo.error}</p>}
          {auth.demoAccess && !session && (
            <p className="fine">The demo signs you in as an approver on PayPal's sandbox. No real money moves.</p>
          )}
        </div>
        <HeroCard />
      </section>

      <section className="home-section" id="problem">
        <h2>The problem</h2>
        <p className="section-lede">
          Connect an agent to PayPal's toolkit and it can move money on its own. The toolkit lets you switch whole tools on or off, and
          that's the only control there is.
        </p>
        <ul className="problem-list">
          <li>
            <strong>Refunds go straight out.</strong> A confused or manipulated agent can refund any amount, as often as it likes.
          </li>
          <li>
            <strong>Disputes get conceded.</strong> One <code>accept_dispute_claim</code> call gives the money back to the buyer, and no
            one is asked first.
          </li>
          <li>
            <strong>Cancellations are instant.</strong> Invoices, subscriptions and recurring billing can be cancelled in a single call.
          </li>
          <li>
            <strong>No approvals or limits.</strong> There's no per-call ceiling, no daily cap, and no way to have a person sign off on a
            large refund.
          </li>
          <li>
            <strong>Retries can pay out twice.</strong> PayPal's idempotency id is set once per client, not per call, so a retried refund
            can run again.
          </li>
          <li>
            <strong>No record.</strong> Nothing shows what the agent asked for, who allowed it, or whether PayPal's events match.
          </li>
        </ul>
      </section>

      <section className="home-section" id="how">
        <h2>How it works</h2>
        <ol className="steps">
          <li>
            <span className="step-num">1</span>
            <h3>Point your agent at Handrail</h3>
            <p>
              Handrail offers the same 46 PayPal tools, plus one optional tool for checking held calls. Your agent keeps working as it
              is; it just connects to Handrail with its own key instead of to PayPal.
            </p>
          </li>
          <li>
            <span className="step-num">2</span>
            <h3>Every money-moving call meets your rules</h3>
            <p>
              Small refunds go through. Large ones wait for a person. Some never happen. Rules are plain, tested code. You can write
              them in everyday English and Handrail shows you exactly what will change before you confirm.
            </p>
          </li>
          <li>
            <span className="step-num">3</span>
            <h3>People decide, PayPal executes once, everything is recorded</h3>
            <p>
              Approvers see the facts and a short AI brief, then approve or reject. Approved calls reach PayPal exactly once, even when
              the agent retries. Each decision is written to a hash-chained log, and PayPal's webhooks are matched back to the call
              that caused them.
            </p>
          </li>
        </ol>
      </section>

      <section className="home-cta">
        <h2>See it on the sandbox</h2>
        <p>Approve a held refund, watch a retry storm come to nothing, and check the audit log for yourself.</p>
        <div className="hero-actions">{actions}</div>
      </section>

      <footer className="home-foot">
        <span>Handrail · Built for PayPal's “Build What's Next with PayPal and AI” hackathon</span>
        <span>Sandbox only. AI explains; your rules decide.</span>
      </footer>
    </div>
  );
}

/** An illustration of a held refund, as an approver sees it. Decorative only. */
function HeroCard() {
  return (
    <div className="hero-card" aria-hidden="true">
      <div className="hero-card-head">
        <div>
          <p className="card-kicker">Refund</p>
          <p className="amount">250.00 USD</p>
        </div>
        <Pill tone="warn">Needs approval</Pill>
      </div>
      <div className="why">
        <p className="why-label">Why it was held</p>
        <p>Refunds over 100.00 USD need a person to approve them.</p>
      </div>
      <div className="hero-card-ai">
        <span className="ai-label">✦ AI brief</span>
        <p>The agent wants to refund 250.00 USD on one capture. Check that the customer asked for it before approving.</p>
      </div>
      <div className="decide-buttons">
        <span className="btn btn-secondary">Reject</span>
        <span className="btn btn-primary">Approve</span>
      </div>
    </div>
  );
}
