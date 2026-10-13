# Handrail for Python agent frameworks

Give a LangChain or CrewAI agent PayPal's Agent Toolkit tools, with every call going through Handrail: policy, approvals, idempotency, the audit log and alerts. The wrappers hold an **agent key** and nothing else. They never get PayPal credentials and never call PayPal: they call Handrail's tool-call API (`GET /v1/tools`, `POST /v1/tools/call`), and Handrail calls PayPal.

| Package | Replaces | Import |
| --- | --- | --- |
| `handrail-langchain` | `paypal_agent_toolkit.langchain.toolkit.PayPalToolkit` | `from handrail_langchain import HandrailToolkit` |
| `handrail-crewai` | `paypal_agent_toolkit.crewai.toolkit.PayPalToolkit` | `from handrail_crewai import HandrailToolkit` |
| `handrail-core` | (shared by both) | |

## Install (from this repo; not on PyPI)

```bash
pip install \
  "handrail-core @ git+https://github.com/Malottey1/handrail#subdirectory=packages/python/handrail-core" \
  "handrail-langchain @ git+https://github.com/Malottey1/handrail#subdirectory=packages/python/handrail-langchain"
# or handrail-crewai in place of handrail-langchain
```

## Switch

Change the import and the constructor. Keep everything else:

```diff
-from paypal_agent_toolkit.langchain.toolkit import PayPalToolkit
-from paypal_agent_toolkit.shared.configuration import Configuration, Context
+from handrail_langchain import HandrailToolkit, Configuration, Context

-toolkit = PayPalToolkit(client_id=PAYPAL_CLIENT_ID, secret=PAYPAL_CLIENT_SECRET, configuration=configuration)
+toolkit = HandrailToolkit(url=HANDRAIL_URL, agent_key=HANDRAIL_AGENT_KEY, configuration=configuration)
 tools = toolkit.get_tools()
```

- **`configuration`:** works the same. `Configuration(actions={...})` selects tools with PayPal's own action names, e.g. `{"orders": {"create": True}}` or `{"payments": {"createRefund": True}}`. Any object with an `actions` mapping works, including PayPal's `Configuration`.
- **Credentials:** remove PayPal credentials from the agent's environment. Handrail holds them.

## How it behaves

- **The tools are Handrail's**, built at startup from `GET /v1/tools`. They have the same names, descriptions and argument schemas an MCP agent sees, so they always match what Handrail runs.
  - Each tool's argument schema becomes a Pydantic model for the framework, and arguments are validated before anything is sent.
  - `handrail_get_approval` is always included, so the agent can check on a held call.
- **Held calls:** a held refund returns Handrail's JSON to the agent instead of PayPal's, e.g. `{"handrail": {"status": "pending_approval", "approval_id": "apr_…", "next_step": "NOT EXECUTED YET…"}}`. The agent reports it, and a person approves it in the dashboard.
  - Blocked and duplicate calls also come back as text.
  - Errors (Handrail unreachable, key refused) return as an error string, the way PayPal's toolkit returns its errors.
- **Timeouts:** a held call waits about 20 seconds for a decision before Handrail answers. The default timeout is 60 s (`timeout=`).

**Differences from PayPal's Python toolkit** (because the tools come from Handrail, which serves PayPal's MCP tool set):
- `create_refund`, `get_refund`, `update_product` and `update_subscription` are available. PayPal's Python toolkit doesn't have them.
- The order lookup is named `get_order`, where PayPal's Python toolkit says `get_order_details`.
- `Context(access_token=...)` is refused. A PayPal token has no place in the agent.

## Example

[`examples/python/langchain/`](../../examples/python/langchain) contains:
- `paypal_app_agent.py`: PayPal's official LangChain example, unchanged.
- `app_agent.py`: the same file switched to Handrail, asking for a small refund (allowed) and a large one (held).
- `try_refunds.py`: the same two refunds without an LLM.

## Tests

```bash
cd packages/python
pip install -e handrail-core -e handrail-langchain pytest   # -e handrail-crewai too, for the CrewAI test
python -m pytest tests
```

The tests run against a fake Handrail (`tests/fake_handrail.py`) that serves PayPal's real recorded tool list.
