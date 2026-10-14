// The examples' two refunds without an LLM: calls the AI SDK tools directly.
//   HANDRAIL_URL=http://127.0.0.1:8787 HANDRAIL_AGENT_KEY=hr_agent_... CAPTURE_ID=... npx tsx try-refunds.ts
import { HandrailAgentToolkit, resultJson } from "handrail-ai-sdk";

const toolkit = new HandrailAgentToolkit({
  url: process.env.HANDRAIL_URL ?? "",
  agentKey: process.env.HANDRAIL_AGENT_KEY ?? "",
  configuration: { actions: { payments: { createRefund: true } } },
});
const refund = toolkit.getTools().create_refund!;

for (const value of ["5.00", "150.00"]) {
  const out: string = await refund.execute!({ capture_id: process.env.CAPTURE_ID, amount: { currency_code: "USD", value } }, { toolCallId: value, messages: [] });
  const body = resultJson(out) ?? {};
  console.log(
    body.handrail
      ? `${value} USD: ${body.handrail.status} (approval ${body.handrail.approval_id}). Approve it in Handrail's dashboard.`
      : `${value} USD: sent to PayPal: refund ${body.id ?? "?"} is ${body.status ?? out.slice(0, 120)}`,
  );
}
