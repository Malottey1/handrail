import json

from handrail_core import result_json

import pytest
from langchain_core.tools import BaseTool
from langchain_core.utils.function_calling import convert_to_openai_tool

from handrail_langchain import Configuration, Context, HandrailToolkit

REFUNDS = Configuration(actions={"payments": {"createRefund": True}}, context=Context(sandbox=True))


def test_same_shape_as_paypals_toolkit(handrail, key):
    toolkit = HandrailToolkit(url=handrail.url, agent_key=key, configuration=REFUNDS)
    tools = toolkit.get_tools()
    assert [t.name for t in tools] == ["create_refund", "handrail_get_approval"]
    assert all(isinstance(t, BaseTool) for t in tools)
    assert toolkit.get_client().url == handrail.url


def test_allowed_refund_and_held_refund(handrail, key):
    refund = HandrailToolkit(url=handrail.url, agent_key=key, configuration=REFUNDS).get_tools()[0]
    small = refund.invoke({"capture_id": "2GG27306VR5212345", "amount": {"currency_code": "USD", "value": "5.00"}})
    assert result_json(small)["status"] == "COMPLETED"
    held = refund.invoke({"capture_id": "2GG27306VR5212345", "amount": {"currency_code": "USD", "value": "250.00"}, "idempotency_key": "r-2"})
    assert held.startswith("Not executed. Pending human approval (id apr_0123456789abcdef0123). Do not retry this call."), "plain words first, for the model"
    assert result_json(held)["handrail"]["status"] == "pending_approval"
    # What Handrail received: plain JSON, no None fields, nothing from PayPal's credentials.
    assert handrail.calls()[-1] == {
        "name": "create_refund",
        "arguments": {"capture_id": "2GG27306VR5212345", "amount": {"currency_code": "USD", "value": "250.00"}, "idempotency_key": "r-2"},
    }


def test_function_schema_for_the_model(handrail, key):
    refund = HandrailToolkit(url=handrail.url, agent_key=key, configuration=REFUNDS).get_tools()[0]
    spec = convert_to_openai_tool(refund)["function"]
    assert spec["name"] == "create_refund"
    assert "capture_id" in spec["parameters"]["properties"]
    assert "capture_id" in spec["parameters"].get("required", [])


def test_bad_arguments_never_reach_handrail(handrail, key):
    refund = HandrailToolkit(url=handrail.url, agent_key=key, configuration=REFUNDS).get_tools()[0]
    with pytest.raises(Exception):
        refund.invoke({"amount": {"currency_code": "USD", "value": "5.00"}})  # no capture_id
    assert handrail.calls() == []


def test_handrail_errors_come_back_as_text_for_the_agent(handrail, key):
    toolkit = HandrailToolkit(url=handrail.url, agent_key=key, configuration=REFUNDS, timeout=3)
    handrail.close()
    out = toolkit.get_tools()[0].invoke({"capture_id": "C1"})
    assert "Error calling 'create_refund' through Handrail" in out


def test_paypals_example_agent_loop_runs_through_handrail(handrail, key):
    """The agent type PayPal's example uses (OPENAI_FUNCTIONS), driven by a scripted model instead of OpenAI."""
    from langchain.agents import AgentType, initialize_agent
    from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
    from langchain_core.messages import AIMessage

    def call(value):
        args = {"capture_id": "2GG27306VR5212345", "amount": {"currency_code": "USD", "value": value}}
        return AIMessage(content="", additional_kwargs={"function_call": {"name": "create_refund", "arguments": json.dumps(args)}})

    class ScriptedModel(FakeMessagesListChatModel):
        def bind_functions(self, *args, **kwargs):  # the agent binds tools as functions; the script ignores them
            return self

        def bind(self, **kwargs):
            return self

    llm = ScriptedModel(responses=[call("5.00"), call("150.00"), AIMessage(content="The $5.00 refund went through; the $150.00 one is waiting for approval.")])
    tools = HandrailToolkit(url=handrail.url, agent_key=key, configuration=REFUNDS).get_tools()
    agent = initialize_agent(tools=tools, llm=llm, agent=AgentType.OPENAI_FUNCTIONS, verbose=False)
    out = agent.run("Refund $5 then $150 of capture 2GG27306VR5212345.")
    assert "waiting for approval" in out
    assert [c["arguments"]["amount"]["value"] for c in handrail.calls()] == ["5.00", "150.00"]
