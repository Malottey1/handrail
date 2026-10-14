# Package name check

Checked Oct 14, 2026, against npm (`npm view <name>`) and PyPI (`https://pypi.org/pypi/<name>/json`). Nothing has been published.

| Name | npm | PyPI | Used for |
| --- | --- | --- | --- |
| `handrail-ai-sdk` | free | free | TypeScript, Vercel AI SDK |
| `handrail-langchain` | free | free | TypeScript (npm) and Python (PyPI), LangChain |
| `handrail-crewai` | free | free | Python, CrewAI |
| `handrail-core` | free | free | Python, shared client |
| `handrail` | **taken** (v2.0.0, "a toolset for logical disjunctions", github.com/brekk/handrail, last updated 2022) | free | not used |
| `@handrail/*` scope | **taken** (the `@handrail` scope exists on npm, owned by someone else) | n/a | not used |

Every name the packages use is free on both registries today. Names can be claimed by anyone at any time until they're published.

PyPI treats `-`, `_` and `.` as the same, so `handrail_core` is `handrail-core`. npm rejects names that only differ from an existing one by punctuation. None of ours collide that way: `handrail` is taken, but `handrail-ai-sdk` doesn't reduce to it.

## If a name is taken before publishing

- **npm:** `handrail-agent-ai-sdk` and `handrail-agent-langchain`. Or a personal scope: `@<your-npm-user>/handrail-ai-sdk`.
- **PyPI:** `handrail-agent-langchain`, `handrail-agent-crewai` and `handrail-agent-core`. Or, since bare `handrail` is free on PyPI, a single `handrail` distribution with extras: `pip install "handrail[langchain]"`.

Keep `handrail` as the first word and the framework as the suffix, and never lead with "paypal".
