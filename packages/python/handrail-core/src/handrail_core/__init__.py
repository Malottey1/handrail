"""Shared pieces of the Handrail framework wrappers (handrail-langchain, handrail-crewai).

They give an agent the same PayPal tools as PayPal's Agent Toolkit, but every
call goes to Handrail with an agent key, never to PayPal with credentials.
"""

from .client import DEFAULT_TIMEOUT, HandrailClient, HandrailError
from .configuration import GET_APPROVAL_TOOL, Configuration, Context, is_tool_allowed
from .schema import model_from_schema, to_plain
from .tools import ToolSpec, tool_specs

__all__ = [
    "DEFAULT_TIMEOUT",
    "GET_APPROVAL_TOOL",
    "Configuration",
    "Context",
    "HandrailClient",
    "HandrailError",
    "ToolSpec",
    "is_tool_allowed",
    "model_from_schema",
    "to_plain",
    "tool_specs",
]
