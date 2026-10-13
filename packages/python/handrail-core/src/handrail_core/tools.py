"""The tool set an agent gets, built from what Handrail offers."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Type

from pydantic import BaseModel

from .client import HandrailClient
from .configuration import is_tool_allowed
from .schema import model_from_schema


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    input_schema: Dict[str, Any]
    args_schema: Type[BaseModel]


def tool_specs(client: HandrailClient, configuration: Optional[Any] = None) -> List[ToolSpec]:
    """Handrail's tools (PayPal's, plus handrail_get_approval), filtered like PayPal's toolkit filters them."""
    specs = []
    for tool in client.list_tools():
        if not is_tool_allowed(tool["name"], configuration):
            continue
        schema = tool.get("inputSchema") or {"type": "object", "properties": {}}
        specs.append(
            ToolSpec(
                name=tool["name"],
                description=(tool.get("description") or tool["name"]).strip(),
                input_schema=schema,
                args_schema=model_from_schema(f"{tool['name']}_args", schema),
            )
        )
    return specs
