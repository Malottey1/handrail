# Handrail

Built for the PayPal "Build What's Next with PayPal and AI" hackathon on Devpost.
Deadline: Nov 12, 2026, 12:00 pm PT. Target: Nov 10, 2026.

## What Handrail is

A safety layer between an AI agent and PayPal's Agent Toolkit / sandbox MCP server. To the agent it looks like PayPal's MCP server, exposing the same tools, but it checks every money-moving call before forwarding it.

## Positioning

- Handrail answers "should my agent be allowed to make this PayPal call?", not "did the work earn payment?"
- It protects a business from its own agent, sitting in front of PayPal's Agent Toolkit / MCP server.
- Core pitch: drop-in (an existing Agent Toolkit agent works with no code changes; Handrail never claims to be PayPal). Point an existing Agent Toolkit agent at Handrail and every money-moving call gets limits, approval, idempotency and an audit trail, with no agent code changes.
- Lead with refunds (`create_refund`) and dispute concessions (`accept_dispute_claim`) in docs and the demo. Capture (`pay_order`) is secondary.
- Another entry, Stood (github.com/ma-za-kpe/stood), is a proof gate for agent-to-agent milestone payments. It shares some philosophy (rules move money, models only report), idempotent hold/capture/void, and AG Grid. Don't copy its wording or framing in the README, UI text or docs.

## The problem

An agent connected to PayPal's toolkit can issue refunds, concede disputes, cancel invoices or subscriptions, and capture payments with nothing checking the call first. The toolkit only lets you turn tools on or off. It has no approval step, no spending limit, and no per-call idempotency key (PayPal-Request-Id is set per client, never per call), so a retried request can duplicate an action. There's also no record of what the agent actually did.

Evidence: github.com/paypal/agent-toolkit issues #82, #95, #98.

Money-out tools to guard: `create_refund`, `accept_dispute_claim`, `cancel_sent_invoice`, `cancel_subscription`, `pay_order` (capture), plus invoice sending.

## Components

- **Policy engine**: deterministic rules decide allow / needs approval / block for each call (amount ceilings, per-tool rules, rate limits, payee checks). AI never makes this decision.
- **Approval queue**: held calls wait for a human to approve or reject, then forward or return a structured denial.
- **Idempotency manager**: assigns a stable PayPal-Request-Id per logical operation so retries never duplicate.
- **Audit log**: SQLite, tamper-evident (hash chain), recording request, decision, reason, and PayPal response.
- **Webhook endpoint**: receives PayPal events (refund completed, invoice paid, dispute updated), matches them to the original agent request, and flags mismatches.
- **REST API for the dashboard**: audit log, policies, pending approvals.
- **React dashboard**: plain-English policy editor (AI compiles English into structured rules; the user confirms), approval queue with live updates, audit log grid using AG Grid.
- **AI usage**: compiling plain-English rules into structured policy and explaining flagged decisions. Enforcement is always deterministic code.

## Stack

TypeScript, Node.js, the official MCP TypeScript SDK (Handrail is an MCP server toward the agent and an MCP client toward PayPal), SQLite, React, and AG Grid. Hosted on Render. One repo.

## Verified facts (Oct 2026)

- PayPal's sandbox MCP server only works over **SSE** at `https://mcp.sandbox.paypal.com/sse` (46 tools). The documented Streamable HTTP path `/http`, and `/mcp`, return 404 even with a valid token. `npm run probe` re-checks this.
- The bearer token for the MCP server is a normal REST access token from `/v1/oauth2/token` (client credentials).
- SQLite uses Node's built-in `node:sqlite` (Node >= 22.13). `better-sqlite3` segfaulted on Node 23.4. Scripts pass `--disable-warning=ExperimentalWarning`.
- PayPal's MCP server reports API failures as a normal result (`isError: false`) whose text is JSON like `{"ok":false,"status":404,...}`. `isUpstreamError` in `src/gate.ts` treats those as errors.
- Many money tools carry no amount (full refunds, `pay_order`, `accept_dispute_claim`, `send_invoice`), so `src/policy/facts.ts` looks the amount up via read-only REST before deciding. Unknown amount or payee fails closed to `require_approval`.
- Idempotency (`src/idempotency.ts`): every non-read call maps to an operation (agent's `idempotency_key`, or a hash of tool + canonical args within a 1-hour window). Repeats of in-flight / succeeded / held / rejected operations are answered without contacting PayPal. The Agent Toolkit sets `PayPal-Request-Id` once per client (agent-toolkit `typescript/src/shared/client.ts`), so `create_refund` and `pay_order` are sent directly to the REST API (`src/paypal/direct.ts`) with a per-operation request id; the body and result format match the toolkit. Unknown outcomes (timeout, 5xx, crash) reuse the request id for direct tools and are held for approval for MCP tools.
- Webhooks (`src/webhooks.ts`, `src/webhook-endpoint.ts`): `POST /webhooks/paypal` verifies via `/v1/notifications/verify-webhook-signature`, stores each event once, and matches it to the forwarded agent call. Statuses: matched, mismatch (amount differs, or Handrail recorded failed/unknown), outside_handrail (refund or invoice cancellation with no agent call), unrelated, ignored. `GET /api/webhooks`.
- Verified end to end against the sandbox (Oct 10, 2026): a real capture via `pay_order`, then a 10-call retry storm on it gave one $5 refund at PayPal. Both webhooks (`PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`) arrived signed, verified, and matched their calls. The registered webhook URL must end in `/webhooks/paypal`. PayPal can resend past events via `POST /v1/notifications/webhooks-events/{id}/resend`.
- Audit log (`src/audit-chain.ts`): every write to tool_calls, approvals and webhook_events appends an `audit_chain` entry in the same `BEGIN IMMEDIATE` transaction. `hash = sha256(prev_hash, seq, at, kind, ref, data_json)`; triggers reject UPDATE/DELETE. `verify()` recomputes the chain and replays it against the working tables, so edits to either are caught. The first entry (`chain.started`, written at boot) snapshots rows that predate the chain. `GET /api/audit`, `GET /api/audit/verify`. Truncating the newest entries is only detectable against a head hash noted elsewhere.
- HTTP `/mcp` requires `HANDRAIL_AGENT_TOKEN` (disabled without it) because a tunnel would otherwise expose it. Tokens must be >= 24 chars.
- Dashboard: polls the admin API (approvals 2s, summary 3s, audit verify 10s); no websockets. Registers only the AG Grid modules it uses. Grid containers need an explicit height (a flex-grown height collapses the grid to 0).
- AI (`src/ai/`), advisory only and off without `ANTHROPIC_API_KEY` (model `HANDRAIL_AI_MODEL`, default `claude-opus-5-5`). Structured output via `output_config.format` (Opus 5.5 rejects forced `tool_choice`); `structuredSchema` strips keywords it may not accept (oneOf → anyOf, length/range/pattern limits), and every answer is still validated with zod. Verified with real Claude (Oct 12): a brief takes ~8s, a policy draft ~10s.
  - Explanations: the gate's `onHeld` hook (fire-and-forget, after the decision is recorded) runs `Explainer`. Totals and related calls are computed in code; agent arguments are fenced as untrusted, and injection attempts are surfaced as concerns. Stored on the approval and recorded as `approval.explained`.
  - Policy: `POST /api/policy/compile` returns a proposal (add/remove rules, assumptions) validated by `parsePolicy`, plus Handrail's own restatement and deterministic warnings (removed strict rules, tools losing coverage, no-op allow rules). One repair round on validation failure. Nothing changes until `PUT /api/policy` with the base hash (409 on a stale edit). `PolicyStore` writes the file atomically, records `policy.changed` (who, the English source, diff), and reloads the file when it changes on disk (so stdio instances pick up dashboard edits).
  - Local UI testing without a key: point `ANTHROPIC_BASE_URL` at a fake Messages API.
- Drop-in means an existing Agent Toolkit agent works with no code changes; Handrail never claims to be PayPal. (`src/tool-parity.ts`, `test/drop-in.test.ts`): toward the agent, Handrail identifies as `handrail` with its own version, and mirrors PayPal's capabilities, instructions and resources (passed through), and every tool's name, description, input schema and `execution` field, in the same order. The only additions are an optional `idempotency_key` on non-read tools and the `handrail_get_approval` tool (`HANDRAIL_ADDITIONS`). The test replays `test/fixtures/paypal-mcp-server.json` as a fake upstream and fails on any other difference, or if Handrail uses PayPal's server name; `npm run check:drop-in` compares against the live server, and `-- --update` refreshes the fixture. PayPal computes `list_transactions`' `start_date`/`end_date` defaults from the clock on every listing, so timestamp defaults compare as equal. Not forwarded: `list_changed` notifications (PayPal's list is static in practice).
- Default port is 8787 (3000 is used by another app on the dev machine).

## Commands

- `npm run build:web`: builds the dashboard (`web/`, React + AG Grid) into `web/dist`, which Handrail serves at `/` (sign in with `HANDRAIL_ADMIN_TOKEN`). `npm run dev:web` runs it with hot reload on :5173, proxying `/api` to :8787.
- `npm test`: unit tests (policy engine and gate; no network).
- `npm run smoke`: starts Handrail over stdio, lists tools, makes one read-only call.
- `npm run demo:approval [-- --auto]`: end-to-end allow / hold+approve / block / hold+reject against the sandbox, using a fake capture ID so no money moves.
- `npm run sandbox:capture [-- --amount 20.00]`: creates a real sandbox order, waits for buyer approval in the browser, captures it through Handrail, prints the capture ID.
- `npm run demo:retry-storm [-- --capture <id> --amount 5.00 --count 10]`: identical refunds fired at once; PayPal receives one.
- `npm run approvals [-- approve|reject <id> [note]]`: decide held calls via the admin API.
- `npm run audit:verify`: checks the hash chain and that the working tables match it; exits 1 on tampering.
- `npm run probe`: re-checks which PayPal MCP endpoints work.
- `npm run check:drop-in [-- --update]`: compares what an agent sees from PayPal's MCP server with what it sees from Handrail; exits 1 on any difference beyond the documented additions.

## Auth

Handrail holds `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` and gets access tokens itself via the OAuth client-credentials flow, refreshing before expiry (tokens last roughly 9 hours). The agent never sees PayPal credentials. Secrets stay in `.env`, server side only.

## Build order

1. Proxy that passes MCP calls through to PayPal's sandbox MCP server and logs them. Drop-in: same server identity, tools and schemas as upstream.
2. Policy engine and approval flow, with `create_refund` and `accept_dispute_claim` first (rules, approval, demo coverage); other money tools after.
3. Idempotency and webhook matching.
4. Dashboard. The AG Grid audit log and the approval queue are the most polished parts: filtering, status badges, and row detail showing the decision reason and PayPal's response.
5. Plain-English policy feature, demo polish, README, demo video.

## Demo (under 3 minutes)

An over-limit refund gets held, the approval card shows an AI explanation, a human approves, and the log records it. Then a retry storm produces no duplicate. Then a plain-English rule compiles to policy.

## Testing notes

- Sandbox only, never live credentials.
- Disputes: a Personal sandbox account can't own a REST app. Use a second Business sandbox account as the buyer, with its own REST app; pay the merchant Business account, then create the dispute from the buyer app using the buyer-side transaction ID. The merchant app then runs list / respond / accept.
- Enable Transaction Search in the sandbox app settings (it takes up to about 10 minutes).

## Rules

- Never commit secrets. Never print secrets in logs.
- The policy engine stays deterministic and unit-tested.
- No co-author or "generated with Claude" lines in commits or PRs.
- Small, clear commits.
- No GitHub remote until the owner says so.
