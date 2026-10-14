import json

from handrail_core import result_json

import pytest

crewai = pytest.importorskip("crewai")

from handrail_crewai import Configuration, HandrailToolkit  # noqa: E402


def test_crewai_tools_call_handrail(handrail, key):
    from crewai.tools import BaseTool

    toolkit = HandrailToolkit(url=handrail.url, agent_key=key, configuration=Configuration(actions={"payments": {"createRefund": True}}))
    tools = toolkit.get_tools()
    assert [t.name for t in tools] == ["create_refund", "handrail_get_approval"]
    assert all(isinstance(t, BaseTool) for t in tools)
    small = tools[0].run(capture_id="C1", amount={"currency_code": "USD", "value": "5.00"})
    held = tools[0].run(capture_id="C1", amount={"currency_code": "USD", "value": "150.00"})
    assert result_json(small)["status"] == "COMPLETED"
    assert held.startswith("Not executed. Pending human approval")
    assert result_json(held)["handrail"]["status"] == "pending_approval"
    assert all(r["path"].startswith("/v1/tools") for r in handrail.requests)
