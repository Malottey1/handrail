"""PayPal's tools for CrewAI, through Handrail.

A drop-in for ``paypal_agent_toolkit.crewai.toolkit.PayPalToolkit``: the same
``configuration`` and ``get_tools()``, but the constructor takes Handrail's URL
and an agent key instead of PayPal credentials. Every call goes through
Handrail (policy, approvals, idempotency, audit log, alerts).
"""

from __future__ import annotations

from typing import Any, List, Optional

try:  # CrewAI 0.80 and later
    from crewai.tools import BaseTool
except ImportError:  # older releases, as in PayPal's example (crewai-tools 0.13)
    from crewai_tools import BaseTool  # type: ignore[no-redef]

from handrail_core import HandrailClient, HandrailError, tool_specs, to_plain
from handrail_core.client import DEFAULT_TIMEOUT


class HandrailTool(BaseTool):
    """One PayPal tool, called through Handrail."""

    client: Any
    method: str
    name: str = ""
    description: str = ""

    def _run(self, *args: Any, **kwargs: Any) -> str:
        try:
            return self.client.run(self.method, to_plain(kwargs))
        except HandrailError as e:
            return f"Error calling '{self.method}' through Handrail: {e}"


class HandrailToolkit:
    """Same tools as PayPal's PayPalToolkit for CrewAI, backed by Handrail."""

    SOURCE = "CREWAI"

    def __init__(self, url: str, agent_key: str, configuration: Optional[Any] = None, timeout: float = DEFAULT_TIMEOUT) -> None:
        self.configuration = configuration
        self._client = HandrailClient(url, agent_key, timeout=timeout)
        self._tools: List[HandrailTool] = [
            HandrailTool(name=spec.name, description=spec.description, method=spec.name, client=self._client, args_schema=spec.args_schema)
            for spec in tool_specs(self._client, configuration)
        ]

    def get_tools(self) -> List[HandrailTool]:
        """The tools to give the agent."""
        return self._tools

    def get_client(self) -> HandrailClient:
        return self._client
