# Third-party notices

Handrail is MIT-licensed ([LICENSE](LICENSE)), **except** the files below. They contain material from PayPal's Agent Toolkit, https://github.com/paypal/agent-toolkit (commit `a3aa963`), Copyright 2025 PayPal. They're licensed under the Apache License, Version 2.0; a full copy is in [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt). PayPal's repository has no NOTICE file, and its source files carry no license headers, so there were no notices to carry over beyond its LICENSE.

## Copied unchanged

| File | From |
| --- | --- |
| `examples/python/langchain/paypal_app_agent.py` | `python/examples/langchain/app_agent.py` |
| `examples/typescript/ai-sdk/paypal-index.ts` | `typescript/examples/ai-sdk/index.ts` |
| `examples/typescript/langchain/paypal-index.ts` | `typescript/examples/langchain/index.ts` |

These stay byte-for-byte identical, so the README's before/after diffs compare against PayPal's real examples. Each folder's `NOTICE` file attributes them.

## Modified (each file says so in its header)

| File | From | Changes |
| --- | --- | --- |
| `examples/python/langchain/app_agent.py` | `python/examples/langchain/app_agent.py` | Uses `handrail_langchain` with a Handrail URL and agent key instead of PayPal credentials; adds the refund action; asks for two refunds. |
| `examples/typescript/ai-sdk/index.ts` | `typescript/examples/ai-sdk/index.ts` | Uses `handrail-ai-sdk` with a Handrail URL and agent key; asks for two refunds. |
| `examples/typescript/langchain/index.ts` | `typescript/examples/langchain/index.ts` | Uses `handrail-langchain` with a Handrail URL and agent key; asks for two refunds. |
| `packages/typescript/handrail-ai-sdk/src/workflows.ts` | `typescript/src/ai-sdk/workflows.ts` | Ported to Handrail's toolkit; schema from Handrail's tool list. |

## Derived

| File | From | What |
| --- | --- | --- |
| `packages/typescript/core/actions.ts` | `typescript/src/shared/tools.ts` | Tool → action-name table, and `ALL_TOOLS_ENABLED`. |
| `packages/python/handrail-core/src/handrail_core/actions.py` | `typescript/src/shared/tools.ts`, `python/paypal_agent_toolkit/shared/tools.py` | Tool → action-name table. |
| `packages/python/handrail-core/src/handrail_core/configuration.py` | `python/paypal_agent_toolkit/shared/configuration.py` | `Context`, `Configuration` and `is_tool_allowed`, with the same shape. |
| `test/fixtures/paypal-mcp-server.json` | PayPal's MCP server (built from `typescript/`) | A recording of the tool names, descriptions and schemas it serves. |
| `packages/typescript/core/tools.json` | the fixture above | The same tool names, descriptions and schemas, as Handrail serves them. |
| `packages/typescript/handrail-ai-sdk/dist/*`, `packages/typescript/handrail-langchain/dist/*` | the files above | Built bundles that include `core/tools.json`, `core/actions.ts` and (AI SDK) `workflows.ts`. |

The packages that contain this material (`handrail-ai-sdk`, `handrail-langchain`, `handrail-core`) declare `MIT AND Apache-2.0` and include both licenses and this notice.
