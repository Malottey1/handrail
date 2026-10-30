import {
  ArrowRight,
  Ban,
  Bell,
  Bot,
  Check,
  CircleCheck,
  CirclePause,
  Clock,
  Hash,
  Plug,
  ReceiptText,
  Repeat2,
  Scale,
  ShieldAlert,
  ShieldCheck,
  Sigma,
  Sparkles,
  Undo2,
  UserCheck,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AuthState, Session } from "../api";
import { ColdStartNote, CopyButton, Logo, ThemeToggle } from "../components";
import { link } from "../router";
import { useDemoSignIn } from "./AuthPages";

type Props = { auth: AuthState; session: Session | null; onSignedIn: (s: Session) => void };

/** The public front page at /. */
export function HomePage({ auth, session, onSignedIn }: Props) {
  const demo = useDemoSignIn(onSignedIn);
  const signInPath = auth.setupRequired ? "/signup" : "/login";
  const signInLabel = auth.setupRequired ? "Set up Handrail" : "Log in";

  // The main call to action: the dashboard when signed in, else the demo (when on), else sign-in.
  const primary = session ? (
    <a className="btn-hero btn-hero-primary" {...link("/app")}>
      Open the dashboard <ArrowRight size={20} aria-hidden="true" />
    </a>
  ) : auth.demoAccess ? (
    <button className="btn-hero btn-hero-primary" onClick={demo.start} disabled={demo.busy}>
      {demo.busy ? "Opening the demo…" : "Try the demo"} <ArrowRight size={20} aria-hidden="true" />
    </button>
  ) : (
    <a className="btn-hero btn-hero-primary" {...link(signInPath)}>
      {signInLabel} <ArrowRight size={20} aria-hidden="true" />
    </a>
  );

  return (
    <div className="home">
      <SiteNav auth={auth} session={session} demo={demo} signInPath={signInPath} signInLabel={signInLabel} />

      <section className="home-hero">
        <div className="home-hero-bg home-hero-photo" aria-hidden="true" />
        <div className="home-hero-inner">
          <div className="home-hero-copy">
            <p className="eyebrow eyebrow-mint">Safe AI actions for PayPal</p>
            <h1>
              Let your agent move fast.
              <br />
              Keep PayPal actions under control.
            </h1>
            <p className="home-hero-lede">
              Handrail is a drop-in safety layer between your AI agent and PayPal's Agent Toolkit, with deterministic rules, human
              approval, idempotency and a tamper-evident audit log. Move faster with confidence.
            </p>
            <div className="home-hero-actions">
              {primary}
              <a className="btn-hero btn-hero-outline" href="#connect">
                Connect your agent
              </a>
            </div>
            {demo.error && (
              <p className="home-error" role="alert">
                {demo.error}
              </p>
            )}
            {auth.demoAccess && !session && <p className="home-hero-fine">The demo signs you in as an approver on PayPal's sandbox. No real money moves.</p>}
            {auth.freePlan && <ColdStartNote className="cold-start-hero" />}
          </div>
          <HeroCard />
        </div>
      </section>

      <section className="home-band" id="product">
        <div className="home-wrap home-split">
          <div className="home-split-copy">
            <p className="eyebrow">Deterministic control for every action</p>
            <h2>
              Allow, hold, or block.
              <br />
              Your rules, not guesses.
            </h2>
            <p className="home-lede">
              Every refund, dispute concession, cancellation and capture your agent attempts is checked against plain, tested rules
              before PayPal sees it. AI explains held calls; it never decides.
            </p>
            <a className="text-link" href="#how">
              See how it works <ArrowRight size={17} aria-hidden="true" />
            </a>
          </div>
          <ul className="outcome-cards">
            {OUTCOMES.map((o) => (
              <li key={o.title} className={`outcome-card outcome-${o.tone}`}>
                <div className="outcome-card-head">
                  <span className="outcome-icon" aria-hidden="true">
                    <o.icon size={24} strokeWidth={2} />
                  </span>
                  <h3>{o.title}</h3>
                </div>
                <p className="outcome-sub">{o.sub}</p>
                <ul className="outcome-points">
                  {o.points.map((p) => (
                    <li key={p}>
                      <span className="outcome-tick" aria-hidden="true">
                        <Check size={12} strokeWidth={3} />
                      </span>
                      {p}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="home-band home-band-tint" id="how">
        <div className="home-wrap home-split">
          <div className="home-split-copy">
            <p className="eyebrow">From agent to action</p>
            <h2>How Handrail works</h2>
            <p className="home-lede">
              Handrail sits between your AI agent and PayPal. It offers the same 46 tools, checks each money-moving call against your
              rules, waits for a person when one is needed, and records everything.
            </p>
            <a className="text-link" href="#connect">
              Connect your agent <ArrowRight size={17} aria-hidden="true" />
            </a>
          </div>
          <ol className="flow-steps">
            {FLOW.map((step, i) => (
              <li key={step.title} className="flow-step">
                <span className="flow-num">{i + 1}</span>
                <span className={`flow-icon ${step.logo ? "flow-icon-logo" : ""}`} aria-hidden="true">
                  {step.logo ? <Logo size={46} className="logo" /> : step.icon && <step.icon size={26} />}
                </span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="home-band" id="connect">
        <div className="home-wrap home-split home-split-code">
          <div className="home-split-copy">
            <p className="eyebrow">Integrate in minutes</p>
            <h2>Connect without rewriting your agent</h2>
            <p className="home-lede">
              Use Handrail with the tools and frameworks you already have. Point your MCP client at it, or swap PayPal's toolkit for
              Handrail's drop-in and keep building.
            </p>
            <ul className="check-list">
              <li>
                <CircleCheck size={18} aria-hidden="true" /> Over MCP or plain HTTP
              </li>
              <li>
                <CircleCheck size={18} aria-hidden="true" /> LangChain, CrewAI, Vercel AI SDK and LangChain JS
              </li>
              <li>
                <CircleCheck size={18} aria-hidden="true" /> The agent gets a Handrail key, never PayPal credentials
              </li>
            </ul>
          </div>
          <CodePanel />
        </div>
      </section>

      <section className="home-band home-band-tint" id="features">
        <div className="home-wrap">
          <div className="home-head">
            <p className="eyebrow">Built for money that moves</p>
            <h2>What Handrail does</h2>
            <p className="home-lede">Rules decide. People approve. AI only explains.</p>
          </div>
          <ul className="feature-cards">
            {FEATURES.map((f) => (
              <li key={f.title} className="feature-card">
                <span className="feature-card-icon" aria-hidden="true">
                  <f.icon size={20} />
                </span>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="home-band" id="problem">
        <div className="home-wrap">
          <div className="home-head">
            <p className="eyebrow">Why it's needed</p>
            <h2>The toolkit alone can't say no</h2>
            <p className="home-lede">
              Connect an agent to PayPal's toolkit and it can move money on its own. The toolkit lets you switch whole tools on or off,
              and that's the only control there is.
            </p>
          </div>
          <ul className="problem-grid">
            {PROBLEMS.map((p) => (
              <li key={p.title}>
                <h3>{p.title}</h3>
                <p>{p.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="home-demo" id="demo">
        <div className="home-wrap home-demo-inner">
          <div className="home-demo-copy">
            <p className="eyebrow eyebrow-mint">See it in action</p>
            <h2>Run the demo</h2>
            <p>
              Sign in as an approver on PayPal's sandbox and run the demo agent. A small refund goes through. A large one waits for you,
              with an AI brief. Its retry is caught. Three small refunds that add up too much are held. Approve or reject, then check the
              record.
            </p>
            <div className="home-hero-actions">{primary}</div>
          </div>
          <DashboardMock />
        </div>
      </section>

      <footer className="home-foot">
        <div className="home-wrap home-foot-inner">
          <a className="home-foot-brand" {...link("/")}>
            <Logo size={26} />
            <span>Handrail</span>
          </a>
          <span>Built for PayPal's “Build What's Next with PayPal and AI” hackathon</span>
          <span>Sandbox only. AI explains; your rules decide.</span>
        </div>
      </footer>
    </div>
  );
}

/**
 * Part of the hero at the top of the page; once the page scrolls, a floating
 * rounded bar. Fixed throughout, so the switch never shifts the layout.
 */
function SiteNav({
  auth,
  session,
  demo,
  signInPath,
  signInLabel,
}: {
  auth: AuthState;
  session: Session | null;
  demo: ReturnType<typeof useDemoSignIn>;
  signInPath: string;
  signInLabel: string;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const [floating, setFloating] = useState(false);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setFloating(!entry!.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <>
      <div ref={sentinel} className="site-nav-sentinel" aria-hidden="true" />
      <header className={`site-nav ${floating ? "is-floating" : ""}`}>
        <div className="site-nav-bar">
          <a className="site-nav-brand" {...link("/")} aria-label="Handrail home">
            <Logo size={44} className="logo site-nav-logo" />
            <span>Handrail</span>
          </a>
          <nav className="site-nav-links" aria-label="Sections">
            <a href="#product">Product</a>
            <a href="#how">How it works</a>
            <a href="#connect">Developers</a>
            <a href="#demo">Demo</a>
          </nav>
          <div className="site-nav-actions">
            <ThemeToggle className="site-nav-icon" />
            {session ? (
              <a className="site-nav-cta" {...link("/app")}>
                Dashboard
              </a>
            ) : auth.demoAccess ? (
              <>
                <a className="site-nav-login" {...link(signInPath)}>
                  {signInLabel}
                </a>
                <button className="site-nav-cta" onClick={demo.start} disabled={demo.busy}>
                  {demo.busy ? "Opening…" : "Try the demo"}
                </button>
              </>
            ) : (
              <a className="site-nav-cta" {...link(signInPath)}>
                {signInLabel}
              </a>
            )}
          </div>
        </div>
      </header>
    </>
  );
}

const OUTCOMES: Array<{ title: string; sub: string; tone: "good" | "warn" | "bad"; icon: LucideIcon; points: string[] }> = [
  {
    title: "Allow",
    sub: "Safe actions run automatically.",
    tone: "good",
    icon: Check,
    points: ["Under your limits", "Sent once, with its own request id", "Matched to PayPal's webhook", "Fully logged"],
  },
  {
    title: "Hold",
    sub: "Sensitive actions wait for a person.",
    tone: "warn",
    icon: CirclePause,
    points: ["Approvers alerted by email or Slack", "PayPal-verified facts and an AI brief", "Approve or reject in the dashboard", "Expires if nobody decides"],
  },
  {
    title: "Block",
    sub: "Off-policy actions are stopped.",
    tone: "bad",
    icon: Ban,
    points: ["Over a hard limit or rate", "Never sent to PayPal", "No one can approve past a block", "Fully logged"],
  },
];

const FLOW: Array<{ title: string; body: string; icon?: LucideIcon; logo?: boolean }> = [
  {
    title: "Agent makes a PayPal call",
    body: "Your agent calls create_refund or accept_dispute_claim as usual, with a Handrail key instead of PayPal credentials.",
    icon: Bot,
  },
  {
    title: "Handrail checks your rules",
    body: "Amounts are looked up from PayPal, then limits, running totals, rate limits and payee rules decide: allow, hold or block.",
    logo: true,
  },
  {
    title: "A person decides when needed",
    body: "Approvers see verified facts and an AI brief. Approved calls reach PayPal exactly once, even if the agent retries.",
    icon: UserCheck,
  },
];

const FEATURES: Array<{ icon: LucideIcon; title: string; body: string }> = [
  {
    icon: Sigma,
    title: "Running totals stop split refunds",
    body: "Limits count what's already been refunded on the same payment, order, customer or agent, including requests still waiting for approval.",
  },
  {
    icon: Scale,
    title: "Facts apart from claims",
    body: "Approval cards show what PayPal confirmed separately from what the agent says. The AI brief sticks to the confirmed facts.",
  },
  {
    icon: ShieldAlert,
    title: "Bypasses get noticed",
    body: "A refund, dispute concession or cancellation PayPal reports that didn't go through Handrail is flagged, and you're alerted.",
  },
  {
    icon: Bell,
    title: "Alerts, and calls that expire",
    body: "Approvers get an email or Slack message with a link. Nothing can be approved from the message. Undecided calls expire.",
  },
  {
    icon: Repeat2,
    title: "Retries never pay twice",
    body: "Each request gets its own PayPal idempotency key, so a refund the agent retries runs at most once.",
  },
  {
    icon: Hash,
    title: "A record you can check",
    body: "Every decision, approval and PayPal response is hash-chained, and PayPal's webhooks are matched back to the calls that caused them.",
  },
];

const PROBLEMS = [
  { title: "Refunds go straight out.", body: "A confused or manipulated agent can refund any amount, as often as it likes." },
  { title: "Disputes get conceded.", body: "One accept_dispute_claim call gives the money back to the buyer, and no one is asked first." },
  { title: "Cancellations are instant.", body: "Invoices, subscriptions and recurring billing can be cancelled in a single call." },
  { title: "No approvals or limits.", body: "There's no per-call ceiling, no daily cap, and no way to have a person sign off on a large refund." },
  { title: "Retries can pay out twice.", body: "PayPal's idempotency id is set once per client, not per call, so a retried refund can run again." },
  { title: "No record.", body: "Nothing shows what the agent asked for, who allowed it, or whether PayPal's events match." },
];

type DiffLine = [" " | "-" | "+", string];
const SNIPPETS: Array<{ label: string; lang: string; icon?: LucideIcon; lines: DiffLine[] }> = [
  {
    label: "MCP",
    lang: "JSON",
    icon: Plug,
    lines: [
      [" ", "{"],
      [" ", '  "mcpServers": {'],
      [" ", '    "paypal": {'],
      ["+", '      "url": "https://your-handrail.example.com/mcp",'],
      ["+", '      "headers": { "Authorization": "Bearer hr_agent_…" }'],
      [" ", "    }"],
      [" ", "  }"],
      [" ", "}"],
    ],
  },
  {
    label: "LangChain",
    lang: "Python",
    lines: [
      ["-", "from paypal_agent_toolkit.langchain.toolkit import PayPalToolkit"],
      ["+", "from handrail_langchain import HandrailToolkit"],
      [" ", ""],
      ["-", "toolkit = PayPalToolkit(client_id=PAYPAL_CLIENT_ID, secret=PAYPAL_CLIENT_SECRET, configuration=configuration)"],
      ["+", "toolkit = HandrailToolkit(url=HANDRAIL_URL, agent_key=HANDRAIL_AGENT_KEY, configuration=configuration)"],
      [" ", "tools = toolkit.get_tools()"],
    ],
  },
  {
    label: "CrewAI",
    lang: "Python",
    lines: [
      ["-", "from paypal_agent_toolkit.crewai.toolkit import PayPalToolkit"],
      ["+", "from handrail_crewai import HandrailToolkit"],
      [" ", ""],
      ["-", "toolkit = PayPalToolkit(client_id=PAYPAL_CLIENT_ID, secret=PAYPAL_SECRET, configuration=configuration)"],
      ["+", "toolkit = HandrailToolkit(url=HANDRAIL_URL, agent_key=HANDRAIL_AGENT_KEY, configuration=configuration)"],
      [" ", 'agent = Agent(role="PayPal Assistant", tools=toolkit.get_tools(), …)'],
    ],
  },
  {
    label: "Vercel AI SDK",
    lang: "TypeScript",
    lines: [
      ["-", "import { PayPalAgentToolkit, ALL_TOOLS_ENABLED } from '@paypal/agent-toolkit/ai-sdk';"],
      ["+", "import { HandrailAgentToolkit, ALL_TOOLS_ENABLED } from 'handrail-ai-sdk';"],
      [" ", ""],
      ["-", "const toolkit = new PayPalAgentToolkit({ clientId, clientSecret, configuration: { actions: ALL_TOOLS_ENABLED } });"],
      ["+", "const toolkit = new HandrailAgentToolkit({ url, agentKey, configuration: { actions: ALL_TOOLS_ENABLED } });"],
      [" ", "await generateText({ model, tools: toolkit.getTools(), maxSteps: 10, prompt });"],
    ],
  },
  {
    label: "LangChain JS",
    lang: "TypeScript",
    lines: [
      ["-", "import { PayPalAgentToolkit, ALL_TOOLS_ENABLED } from '@paypal/agent-toolkit/langchain';"],
      ["+", "import { HandrailAgentToolkit, ALL_TOOLS_ENABLED } from 'handrail-langchain';"],
      [" ", ""],
      ["-", "const toolkit = new PayPalAgentToolkit({ clientId, clientSecret, configuration: { actions: ALL_TOOLS_ENABLED } });"],
      ["+", "const toolkit = new HandrailAgentToolkit({ url, agentKey, configuration: { actions: ALL_TOOLS_ENABLED } });"],
      [" ", "const agent = createReactAgent({ llm, tools: toolkit.getTools() });"],
    ],
  },
];

/** Before/after for each way of connecting: only the highlighted lines change. Copy takes the "after" version. */
function CodePanel() {
  const [active, setActive] = useState(0);
  const snippet = SNIPPETS[active]!;
  const after = snippet.lines
    .filter(([sign]) => sign !== "-")
    .map(([, text]) => text)
    .join("\n");
  return (
    <div className="code-panel">
      <div className="code-panel-bar">
        <div className="code-tabs" role="tablist" aria-label="How you connect">
          {SNIPPETS.map((s, i) => (
            <button key={s.label} role="tab" aria-selected={i === active} className={`code-tab ${i === active ? "active" : ""}`} onClick={() => setActive(i)}>
              {s.icon && <s.icon size={15} aria-hidden="true" />}
              {s.label}
            </button>
          ))}
        </div>
        <div className="code-panel-tools">
          <span className="code-lang">{snippet.lang}</span>
          <CopyButton text={after} label="Copy" className="code-copy" />
        </div>
      </div>
      <pre className="code-body" aria-label={`${snippet.label}: before and after`}>
        {snippet.lines.map(([sign, text], i) => (
          <span key={i} className={`code-line ${sign === "+" ? "add" : sign === "-" ? "del" : ""}`}>
            <span className="code-ln" aria-hidden="true">
              {i + 1}
            </span>
            <span className="code-sign" aria-hidden="true">
              {sign === " " ? "" : sign === "-" ? "−" : "+"}
            </span>
            <span className="code-text">{text || " "}</span>
            {"\n"}
          </span>
        ))}
      </pre>
      <p className="code-panel-foot">
        <CircleCheck size={16} aria-hidden="true" />
        Same tools and schemas as PayPal's toolkit. Only the highlighted lines change.
      </p>
    </div>
  );
}

/** An illustration of a held refund, as an approver sees it. Decorative only. */
function HeroCard() {
  const rows: Array<[LucideIcon, string, string, "ok" | "held"]> = [
    [ReceiptText, "Rule", "Refunds over $100.00 need approval", "held"],
    [ShieldCheck, "Idempotency", "One request id: sent once", "ok"],
    [Hash, "Audit log", "Recorded in the hash chain", "ok"],
  ];
  return (
    <div className="hero-card" aria-hidden="true">
      <div className="hero-card-top">
        <span className="hero-pill">
          <span className="hero-pill-dot" />
          Needs approval
        </span>
        <span className="hero-card-id">#apr_8f3c2e</span>
      </div>
      <div className="hero-card-panel">
        <div className="hero-card-head">
          <span className="hero-card-icon">
            <Undo2 size={22} strokeWidth={2.2} />
          </span>
          <div className="hero-card-who">
            <p className="hero-card-title">Refund payment</p>
            <p>To Jordan Lee</p>
            <p className="hero-card-email">jordan.lee@example.com</p>
          </div>
          <div className="hero-card-amount num">
            $250.00
            <span>USD</span>
          </div>
        </div>
        <p className="hero-card-label">
          <Sparkles size={14} /> AI brief
        </p>
        <p className="hero-card-brief">
          PayPal confirms a $250.00 card payment with nothing refunded yet. The agent says the item arrived damaged; that isn't verified,
          so check it before approving.
        </p>
        <ul className="hero-card-rows">
          {rows.map(([Icon, label, text, state]) => (
            <li key={label}>
              <Icon size={18} />
              <span className="hero-card-row-label">{label}</span>
              <span className="hero-card-row-text">{text}</span>
              <span className={`hero-card-state hero-card-state-${state}`}>{state === "ok" ? <Check size={13} strokeWidth={3} /> : <Clock size={13} strokeWidth={2.6} />}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="hero-card-actions">
        <span className="hero-card-approve">
          <Check size={20} strokeWidth={2.6} /> Approve refund
        </span>
        <span className="hero-card-reject">
          <X size={20} strokeWidth={2.4} /> Reject
        </span>
      </div>
    </div>
  );
}

/** A small picture of the dashboard's approval queue. Decorative only. */
function DashboardMock() {
  const nav = ["Dashboard", "Approvals", "Activity", "Webhooks", "Audit log", "Policy"];
  const rows: Array<[string, string, string, ReactNode]> = [
    ["Refund", "$250.00", "22 min left", <span className="mock-pill mock-warn">Needs approval</span>],
    ["Accept dispute", "$180.00", "1 h 14 min left", <span className="mock-pill mock-warn">Needs approval</span>],
    ["Refund", "$5.00", "Sent to PayPal", <span className="mock-pill mock-good">Allowed</span>],
    ["Refund (retry)", "$250.00", "Not re-sent", <span className="mock-pill mock-info">Duplicate</span>],
  ];
  return (
    <div className="dash-mock" aria-hidden="true">
      <div className="dash-mock-bar">
        <Logo size={18} />
        <span className="dash-mock-name">Handrail</span>
        <span className="dash-mock-tabs">
          <b>Approvals</b>
          <span>Activity</span>
          <span>Audit log</span>
        </span>
        <span className="dash-mock-live">
          <span className="hero-pill-dot" /> Sandbox
        </span>
      </div>
      <div className="dash-mock-body">
        <ul className="dash-mock-nav">
          {nav.map((n) => (
            <li key={n} className={n === "Approvals" ? "active" : undefined}>
              {n}
            </li>
          ))}
        </ul>
        <div className="dash-mock-main">
          <p className="dash-mock-title">Approvals</p>
          <ul className="dash-mock-rows">
            {rows.map(([tool, amount, meta, pill], i) => (
              <li key={i}>
                <span className="dash-mock-tool">
                  {tool}
                  <small>{meta}</small>
                </span>
                <span className="num">{amount}</span>
                {pill}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/** Sweeping handrail curves behind the hero copy. Decorative only. */
export function RailArt() {
  return (
    <svg className="rail-art" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="rail-a" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#8fe3b0" stopOpacity="0" />
          <stop offset="0.45" stopColor="#8fe3b0" stopOpacity="0.55" />
          <stop offset="1" stopColor="#d6f5e3" stopOpacity="0.15" />
        </linearGradient>
        <linearGradient id="rail-b" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="0.6" stopColor="#ffffff" stopOpacity="0.22" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d="M-120 960 C 280 700, 760 600, 1580 120" stroke="url(#rail-a)" strokeWidth="14" fill="none" strokeLinecap="round" />
      <path d="M-120 1010 C 300 760, 790 660, 1580 190" stroke="url(#rail-b)" strokeWidth="3" fill="none" />
      <path d="M-120 1080 C 330 830, 830 740, 1580 290" stroke="url(#rail-b)" strokeWidth="1.5" fill="none" />
      <path d="M380 -60 C 640 160, 1000 260, 1580 300" stroke="url(#rail-b)" strokeWidth="1.2" fill="none" opacity="0.6" />
    </svg>
  );
}
