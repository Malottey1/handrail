# Contains material from PayPal's Agent Toolkit (https://github.com/paypal/agent-toolkit, python/paypal_agent_toolkit/shared/configuration.py),
# Copyright 2025 PayPal, licensed under the Apache License, Version 2.0
# (https://www.apache.org/licenses/LICENSE-2.0; see LICENSES/Apache-2.0.txt in Handrail's repo).
# Modified for Handrail, 2026: same shape; Context refuses access tokens and nothing in it is sent anywhere; is_tool_allowed takes a tool name and allows handrail_get_approval.

"""Configuration with the same shape as PayPal's Agent Toolkit, so existing code keeps working."""

from __future__ import annotations

from typing import Any, Mapping, Optional

from .actions import TOOL_ACTIONS

# The tool for checking a call Handrail held for approval. It can't move money,
# so it's offered whenever any tool is.
GET_APPROVAL_TOOL = "handrail_get_approval"


class Context:
    """Accepted for compatibility with paypal_agent_toolkit's Context.

    PayPal credentials, access tokens and the sandbox/live choice live in
    Handrail, never in the agent, so these values aren't sent anywhere.
    """

    @classmethod
    def default(cls) -> "Context":
        return cls(sandbox=True)

    def __init__(
        self,
        merchant_id: Optional[str] = None,
        sandbox: Optional[bool] = None,
        access_token: Optional[str] = None,
        request_id: Optional[str] = None,
        tenant_context: Optional[Any] = None,
        source: Optional[str] = None,
        **kwargs: Any,
    ) -> None:
        if access_token:
            raise ValueError("Don't give the agent a PayPal access token: Handrail holds PayPal credentials. Use an agent key instead.")
        self.merchant_id = merchant_id
        self.sandbox = sandbox or False
        self.request_id = request_id
        self.tenant_context = tenant_context
        self.source = source
        self.extra = kwargs


class Configuration:
    """Which tools to offer, e.g. ``Configuration(actions={"payments": {"createRefund": True}})``."""

    def __init__(self, actions: Mapping[str, Mapping[str, bool]], context: Optional[Context] = None) -> None:
        self.actions = actions
        self.context = context


def is_tool_allowed(tool_name: str, configuration: Optional[Any]) -> bool:
    """Same rule as PayPal's toolkit: a tool is offered if any of its actions is enabled.

    Any object with an ``actions`` mapping works, including paypal_agent_toolkit's
    own Configuration. ``None`` offers every tool. A tool Handrail offers but
    this table doesn't know is left out when a configuration is given.
    """
    if configuration is None:
        return True
    if tool_name == GET_APPROVAL_TOOL:
        return True
    actions = getattr(configuration, "actions", None) or {}
    for product, product_actions in TOOL_ACTIONS.get(tool_name, {}).items():
        for action in product_actions:
            if actions.get(product, {}).get(action, False):
                return True
    return False
