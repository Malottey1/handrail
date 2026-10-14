import inspect
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from handrail_core import Configuration, Context, HandrailClient, HandrailError, is_tool_allowed, model_from_schema, result_json, to_plain, tool_specs
from handrail_core.actions import TOOL_ACTIONS


def test_lists_handrail_tools_filtered_like_paypals_toolkit(handrail, key):
    client = HandrailClient(handrail.url, key)
    everything = [s.name for s in tool_specs(client)]
    assert len(everything) == 47 and everything[-1] == "handrail_get_approval"

    orders = Configuration(actions={"orders": {"create": True, "get": True, "capture": True}})
    assert [s.name for s in tool_specs(client, orders)] == ["create_order", "get_order", "pay_order", "handrail_get_approval"]

    refunds = Configuration(actions={"payments": {"createRefund": True}})
    assert [s.name for s in tool_specs(client, refunds)] == ["create_refund", "handrail_get_approval"]


def test_every_tool_handrail_offers_has_an_action():
    fixture = Path(__file__).resolve().parents[3] / "test" / "fixtures" / "paypal-mcp-server.json"
    names = {t["name"] for t in json.loads(fixture.read_text())["tools"]}
    assert names <= set(TOOL_ACTIONS), names - set(TOOL_ACTIONS)


def test_accepts_paypals_own_configuration_object():
    class PayPalConfiguration:  # the shape of paypal_agent_toolkit.shared.configuration.Configuration
        actions = {"disputes": {"create": True}}

    assert is_tool_allowed("accept_dispute_claim", PayPalConfiguration())
    assert not is_tool_allowed("create_refund", PayPalConfiguration())
    assert is_tool_allowed("anything", None)


def test_calls_go_to_handrail_with_the_agent_key_and_nothing_else(handrail, key):
    client = HandrailClient(handrail.url + "/", key)
    assert client.run("create_refund", {"capture_id": "C1", "amount": {"currency_code": "USD", "value": "5.00"}}).startswith('{"id": "REFUND1"')
    held_text = client.run("create_refund", {"capture_id": "C1", "amount": {"currency_code": "USD", "value": "250.00"}})
    assert held_text.splitlines()[0].startswith("Not executed. Pending human approval")
    held = result_json(held_text)
    assert held["handrail"]["status"] == "pending_approval"
    assert all(r["auth"] == f"Bearer {key}" for r in handrail.requests)
    assert [r["path"] for r in handrail.requests] == ["/v1/tools/call", "/v1/tools/call"]
    assert key not in repr(client)


def test_no_paypal_credentials_anywhere():
    for ctor in (HandrailClient.__init__,):
        params = set(inspect.signature(ctor).parameters)
        assert not params & {"client_id", "secret", "client_secret", "access_token"}
    with pytest.raises(ValueError, match="access token"):
        Context(access_token="A21AA" + "x" * 30)


def test_errors_are_clear(handrail, key):
    with pytest.raises(HandrailError, match="refused the agent key") as err:
        HandrailClient(handrail.url, "wrong-key").list_tools()
    assert err.value.status == 401
    with pytest.raises(HandrailError, match="Couldn't reach Handrail"):
        HandrailClient("http://127.0.0.1:9", key, timeout=2).list_tools()
    with pytest.raises(ValueError, match="URL"):
        HandrailClient("handrail.example.com", key)
    with pytest.raises(ValueError, match="agent key"):
        HandrailClient(handrail.url, "")


def test_schemas_become_pydantic_models():
    Model = model_from_schema(
        "refund",
        {
            "type": "object",
            "properties": {
                "capture_id": {"type": "string", "description": "The capture"},
                "amount": {"type": "object", "properties": {"currency_code": {"type": "string"}, "value": {"type": "string"}}, "required": ["value"]},
                "status": {"type": "string", "enum": ["A", "B"]},
                "items": {"type": "array", "items": {"type": "object", "properties": {"sku": {"type": "string"}}}},
                "class": {"type": "string"},
            },
            "required": ["capture_id"],
        },
    )
    m = Model(capture_id="C1", amount={"value": "5.00"}, items=[{"sku": "x"}], **{"class": "gold"})
    assert to_plain(m) == {"capture_id": "C1", "amount": {"value": "5.00"}, "items": [{"sku": "x"}], "class": "gold"}
    with pytest.raises(ValidationError):
        Model(amount={"value": "5.00"})  # capture_id is required
    with pytest.raises(ValidationError):
        Model(capture_id="C1", status="C")
    assert Model.model_json_schema()["properties"]["capture_id"]["description"] == "The capture"
