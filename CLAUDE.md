# Handrail

Built for the PayPal "Build What's Next with PayPal and AI" hackathon on Devpost.
Deadline: Nov 12, 2026, 12:00 pm PT. Target: Nov 10, 2026.

## What Handrail is

A safety layer between an AI agent and PayPal's Agent Toolkit / sandbox MCP server. To the agent it looks like PayPal's MCP server, exposing the same tools, but it checks every money-moving call before forwarding it.

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

## Auth

Handrail holds `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` and gets access tokens itself via the OAuth client-credentials flow, refreshing before expiry (tokens last roughly 9 hours). The agent never sees PayPal credentials. Secrets stay in `.env`, server side only.

## Build order

1. Proxy that passes MCP calls through to PayPal's sandbox MCP server and logs them.
2. Policy engine and approval flow.
3. Idempotency and webhook matching.
4. Dashboard.
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
