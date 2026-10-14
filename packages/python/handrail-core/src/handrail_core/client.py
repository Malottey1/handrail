"""A small HTTP client for Handrail's tool-call API (GET /v1/tools, POST /v1/tools/call).

It holds an agent key and nothing else: never PayPal credentials, and it never
calls PayPal. Every call goes through Handrail's policy, approvals,
idempotency, audit log and alerts.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List

# A held call waits about 20 seconds inline for a person before Handrail answers.
DEFAULT_TIMEOUT = 60.0


class HandrailError(Exception):
    """Handrail couldn't be reached, refused the key, or rejected the request."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


def result_json(text: str) -> Any:
    """The JSON in a tool's text result: PayPal's answer, or Handrail's own.

    When Handrail answers instead of PayPal (held, blocked, expired…), the text
    starts with plain instructions for the model and the JSON follows on its
    own line. Returns None if there's no JSON.
    """
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        pass
    start = text.find("\n{") if isinstance(text, str) else -1
    if start >= 0:
        try:
            return json.loads(text[start + 1 :])
        except json.JSONDecodeError:
            return None
    return None


class HandrailClient:
    def __init__(self, url: str, agent_key: str, timeout: float = DEFAULT_TIMEOUT) -> None:
        parsed = urllib.parse.urlparse(url or "")
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError(f"Handrail URL must look like https://handrail.example.com, got {url!r}")
        if not agent_key:
            raise ValueError("An agent key is required. Create one in Handrail's dashboard (Team & keys).")
        self.url = url.rstrip("/")
        self._agent_key = agent_key
        self.timeout = timeout

    def __repr__(self) -> str:  # never show the key
        return f"HandrailClient(url={self.url!r})"

    def _request(self, method: str, path: str, body: Any = None) -> Any:
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            f"{self.url}{path}",
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self._agent_key}",
                "Accept": "application/json",
                **({"Content-Type": "application/json"} if data is not None else {}),
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8") or "null")
        except urllib.error.HTTPError as err:
            try:
                detail = json.loads(err.read().decode("utf-8")).get("error", "")
            except Exception:
                detail = ""
            if err.code == 401:
                raise HandrailError(f"Handrail refused the agent key: {detail or 'missing, unknown or revoked'}", 401) from None
            raise HandrailError(f"Handrail answered HTTP {err.code}{': ' + detail if detail else ''}", err.code) from None
        except urllib.error.URLError as err:
            raise HandrailError(f"Couldn't reach Handrail at {self.url}: {err.reason}") from None
        except TimeoutError:
            raise HandrailError(f"Handrail at {self.url} didn't answer within {self.timeout:g} seconds") from None

    def list_tools(self) -> List[Dict[str, Any]]:
        """Every tool, with the same names and JSON schemas an MCP client sees."""
        return self._request("GET", "/v1/tools")["tools"]

    def call_tool(self, name: str, arguments: Dict[str, Any] | None = None) -> Dict[str, Any]:
        """The MCP CallToolResult: ``{"content": [...], "isError": bool}``.

        A held, blocked or duplicate call is a normal result whose text is
        Handrail's JSON (e.g. ``{"handrail": {"status": "pending_approval", ...}}``).
        """
        return self._request("POST", "/v1/tools/call", {"name": name, "arguments": arguments or {}})

    def run(self, name: str, arguments: Dict[str, Any] | None = None) -> str:
        """The result as text, the way PayPal's toolkit returns it to the agent."""
        result = self.call_tool(name, arguments)
        return "\n".join(part.get("text", "") for part in result.get("content", []) if part.get("type") == "text")
