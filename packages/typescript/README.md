# Handrail for TypeScript agent frameworks

Give a Vercel AI SDK or LangChain JS agent PayPal's Agent Toolkit tools, with every call going through Handrail: policy, approvals, idempotency, the audit log and alerts. The wrappers hold an **agent key** and nothing else. They never get PayPal credentials and never call PayPal: they call Handrail's tool-call API (`POST /v1/tools/call`), and Handrail calls PayPal.

| Package | Replaces | Import |
| --- | --- | --- |
| `handrail-ai-sdk` | `@paypal/agent-toolkit/ai-sdk` | `import { HandrailAgentToolkit, HandrailWorkflows, ALL_TOOLS_ENABLED } from 'handrail-ai-sdk'` |
| `handrail-langchain` | `@paypal/agent-toolkit/langchain` | `import { HandrailAgentToolkit, ALL_TOOLS_ENABLED } from 'handrail-langchain'` |

**Peer dependencies:**
- `handrail-ai-sdk`: `ai` 4.x and `zod` 3.x.
- `handrail-langchain`: `@langchain/core` 0.3.x and `zod` 3.x.

## Install (from this repo; not on npm)

The packages ship their built code (`dist/`), so they install straight from a checkout or from GitHub:

```bash
# from a clone of the repo
npm install --install-links /path/to/handrail/packages/typescript/handrail-ai-sdk
# with pnpm, straight from GitHub
pnpm add "github:Malottey1/handrail#path:packages/typescript/handrail-ai-sdk"
```

`--install-links` copies the package instead of symlinking it, so it uses your app's `ai`/`zod`. npm can't install a subfolder of a GitHub repo directly.

## Switch

Change the import and the constructor. Keep everything else:

```diff
-import { PayPalAgentToolkit, ALL_TOOLS_ENABLED } from '@paypal/agent-toolkit/ai-sdk';
+import { HandrailAgentToolkit, ALL_TOOLS_ENABLED } from 'handrail-ai-sdk';

-const toolkit = new PayPalAgentToolkit({ clientId, clientSecret, configuration: { actions: ALL_TOOLS_ENABLED } });
+const toolkit = new HandrailAgentToolkit({ url: HANDRAIL_URL, agentKey: HANDRAIL_AGENT_KEY, configuration: { actions: ALL_TOOLS_ENABLED } });
 const tools = toolkit.getTools();
```

- **`configuration`:** works the same. `{ actions: {...} }` selects tools with PayPal's own action names, e.g. `{ orders: { create: true } }` or `{ payments: { createRefund: true } }`.
- **Workflows:** `HandrailWorkflows` replaces `PayPalWorkflows`, with the same `generateOrder` and `getDisputeDetails`.
- **Credentials:** remove PayPal credentials from the agent's environment. Handrail holds them.

## How it behaves

- **The constructor is synchronous**, like PayPal's. The tool list (names, descriptions, JSON Schemas) is a snapshot of what Handrail serves, bundled in the package (`core/tools.json`, generated with `npm run snapshot`). A test fails if it ever differs from what Handrail would serve. Each tool's schema is converted to Zod for the framework, so arguments are validated before anything is sent.
- **`handrail_get_approval`** is always included, so the agent can check on a held call.
- **Held calls:** a held refund returns Handrail's JSON instead of PayPal's, e.g. `{"handrail": {"status": "pending_approval", "approval_id": "apr_…", "next_step": "NOT EXECUTED YET…"}}`. Blocked and duplicate calls also come back as text.
- **Errors:** Handrail unreachable or key refused returns as text, `Error calling '<tool>' through Handrail: …`.
- **Timeouts:** a held call waits about 20 seconds for a decision; the default timeout is 60 s (`timeoutMs`).
- **Tool names:** the tools are Handrail's (PayPal's MCP tool set). These match PayPal's TypeScript toolkit, including `create_refund`.
- **Credentials can't be passed in.** `context.access_token` is refused.

## Examples

[`examples/typescript/`](../../examples/typescript) has PayPal's official AI SDK and LangChain examples, unchanged (`paypal-index.ts`), next to versions switched to Handrail (`index.ts`) that ask for a small refund (allowed) and a large one (held). `ai-sdk/try-refunds.ts` runs the two refunds without an LLM.

## Development

```bash
cd packages/typescript
npm install
npm test          # against a real Handrail (tool-call API, gate, policy, audit) with a fake PayPal
npm run build     # rebuild dist/ (commit it: installs use it)
npm run snapshot  # after PayPal's tools change (npm run check:drop-in -- --update in the repo root)
```
