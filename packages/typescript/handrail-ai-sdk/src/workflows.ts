/**
 * Ported from PayPal's Agent Toolkit (paypal/agent-toolkit, Apache-2.0):
 * typescript/src/ai-sdk/workflows.ts. The same two workflows, using Handrail's
 * toolkit, so every PayPal call they make goes through Handrail.
 */
import { generateObject, generateText, type LanguageModelV1 } from "ai";
import { HandrailAgentToolkit } from "./index.js";
import { objectFromJsonSchema } from "../../core/schema.js";
import type { HandrailToolkitOptions } from "../../core/toolkit.js";
import TOOLS from "../../core/tools.json" with { type: "json" };

const createOrderSchema = objectFromJsonSchema((TOOLS as Array<{ name: string; inputSchema: Record<string, unknown> }>).find((t) => t.name === "create_order")!.inputSchema);

export class HandrailWorkflows {
  readonly toolkit: HandrailAgentToolkit;
  log: (message: any) => void;

  constructor(options: HandrailToolkitOptions & { log?: (message: any) => void }) {
    this.log = options.log ?? console.log;
    this.toolkit = new HandrailAgentToolkit(options);
  }

  async generateOrder(llm: LanguageModelV1, userPrompt: string, systemPrompt: string): Promise<string> {
    this.log("Step 1: I am using the provided prompts to create a request object for PayPal.");
    const { object: orderObject } = await generateObject({ model: llm, schema: createOrderSchema, system: systemPrompt, prompt: userPrompt });
    this.log(`Response 1: I have now created the request object with provided details;\n ${JSON.stringify(orderObject)}`);
    this.log("Step 2: I am now choosing the correct tool to create an order using the generated object from the previous step.");
    const { text: orderId } = await generateText({
      model: llm,
      tools: this.toolkit.getTools(),
      maxSteps: 10,
      prompt: `Create an order using the following details: ${JSON.stringify(orderObject, null, 2)}`,
    });
    this.log(`Response 2: I have created the order in PayPal's system with order ID: ${orderId}.`);
    this.log("Step 3: I am now retrieving the order details with the order ID from the previous step.");
    const { text: orderDetails } = await generateText({
      model: llm,
      tools: this.toolkit.getTools(),
      maxSteps: 10,
      system: "You are processing an order using PayPal APIs. Use the order ID to retrieve the order details.",
      prompt: `Retrieve the details of the order with ID: ${orderId}.`,
    });
    this.log(`Response 3: Here is the order details with ID: ${orderId}; ${JSON.stringify(orderDetails, null, 2)}`);
    this.log("Step 4: I am now generating the summary of the order using the order details retrieved in the previous step.");
    const { text: summary } = await generateText({
      model: llm,
      maxSteps: 10,
      system:
        "You are tasked with generating an summary text for the order. Use the provided order details. For each item in order, update item level tax to be the tax amount*quantity of the item. Show the payment approval link only at the end of the page for the customer and hide all other links related to the order.",
      prompt: `Generate a summary for the following order details: ${orderDetails}.`,
    });
    this.log(`Response 4: \n${summary}`);
    return summary;
  }

  async getDisputeDetails(llm: LanguageModelV1, userPrompt: string): Promise<string> {
    this.log("Step 1. I am now retrieving the details from PayPal.");
    const { text: disputeDetail } = await generateText({
      model: llm,
      tools: this.toolkit.getTools(),
      maxSteps: 10,
      system: "You are a tool to retrieve the dispute details based on the dispute ID.",
      prompt: userPrompt,
    });
    this.log("Step 2. I am now generating the summary of the dispute using the dispute details retrieved in the previous step.");
    const { text: summary } = await generateText({
      model: llm,
      tools: this.toolkit.getTools(),
      system: "You are tasked with generating an summary text for the dispute. Use the provided dispute details. Show the appropriate links only at the end of the page.",
      prompt: `Generate a summary for the following dispute details: ${disputeDetail}.`,
    });
    return summary;
  }
}
