"""The example's two refunds without an LLM: calls the LangChain tools directly.

    HANDRAIL_URL=http://127.0.0.1:8787 HANDRAIL_AGENT_KEY=hr_agent_... CAPTURE_ID=... python try_refunds.py
"""

import os

from handrail_langchain import Configuration, HandrailToolkit, result_json

toolkit = HandrailToolkit(
    url=os.environ["HANDRAIL_URL"],
    agent_key=os.environ["HANDRAIL_AGENT_KEY"],
    configuration=Configuration(actions={"payments": {"createRefund": True}}),
)
refund = next(t for t in toolkit.get_tools() if t.name == "create_refund")
capture_id = os.environ["CAPTURE_ID"]

for value in ("5.00", "150.00"):
    out = refund.invoke({"capture_id": capture_id, "amount": {"currency_code": "USD", "value": value}})
    body = result_json(out) or {}
    if "handrail" in body:
        print(f"{value} USD: {body['handrail']['status']} (approval {body['handrail'].get('approval_id')}). Approve it in Handrail's dashboard.")
    else:
        print(f"{value} USD: sent to PayPal: refund {body.get('id', '?')} is {body.get('status', out[:120])}")
