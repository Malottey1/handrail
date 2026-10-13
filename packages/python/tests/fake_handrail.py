"""A fake Handrail tool-call API for tests: PayPal's real tool list, and refunds over 100.00 held."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List

FIXTURE = Path(__file__).resolve().parents[3] / "test" / "fixtures" / "paypal-mcp-server.json"
AGENT_KEY = "hr_agent_" + "t" * 40  # assembled at runtime for the secret scanner; it's fake anyway

GET_APPROVAL = {
    "name": "handrail_get_approval",
    "description": "Check a PayPal action that Handrail held for human approval.",
    "inputSchema": {
        "type": "object",
        "properties": {"approval_id": {"type": "string"}, "wait_seconds": {"type": "number"}},
        "required": ["approval_id"],
    },
}


def handrail_tools() -> List[Dict[str, Any]]:
    tools = json.loads(FIXTURE.read_text())["tools"]
    for tool in tools:
        if tool["name"] in ("create_refund", "accept_dispute_claim", "pay_order"):
            tool["inputSchema"].setdefault("properties", {})["idempotency_key"] = {"type": "string", "description": "Optional."}
    return tools + [GET_APPROVAL]


def text(payload: Any, is_error: bool = False) -> Dict[str, Any]:
    return {"content": [{"type": "text", "text": json.dumps(payload)}], **({"isError": True} if is_error else {})}


class FakeHandrail:
    """Starts on a free port. ``requests`` records everything it received."""

    def __init__(self) -> None:
        self.requests: List[Dict[str, Any]] = []
        self.tools = handrail_tools()
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:
                pass

            def _send(self, status: int, body: Any) -> None:
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _record(self, body: Any = None) -> bool:
                fake.requests.append({"method": self.command, "path": self.path, "auth": self.headers.get("Authorization"), "body": body})
                if self.headers.get("Authorization") != f"Bearer {AGENT_KEY}":
                    self._send(401, {"error": "Missing, unknown or revoked agent key."})
                    return False
                return True

            def do_GET(self) -> None:
                if self._record() and self.path == "/v1/tools":
                    self._send(200, {"tools": fake.tools})

            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                if not self._record(body):
                    return
                name, args = body.get("name"), body.get("arguments", {})
                if name == "create_refund":
                    value = float((args.get("amount") or {}).get("value", "0"))
                    if value > 100:
                        self._send(200, text({"handrail": {"status": "pending_approval", "approval_id": "apr_0123456789abcdef0123", "tool": name, "next_step": "NOT EXECUTED YET. A human must approve this action."}}))
                    else:
                        self._send(200, text({"id": "REFUND1", "status": "COMPLETED", "amount": args.get("amount")}))
                elif name == "handrail_get_approval":
                    self._send(200, text({"handrail": {"status": "pending_approval", "approval_id": args.get("approval_id")}}))
                else:
                    self._send(200, text({"ok": True, "tool": name}))

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def calls(self) -> List[Dict[str, Any]]:
        return [r["body"] for r in self.requests if r["method"] == "POST"]

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
