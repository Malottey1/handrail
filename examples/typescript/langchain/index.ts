/*!
 * Contains material from PayPal's Agent Toolkit (https://github.com/paypal/agent-toolkit, typescript/examples/langchain/index.ts),
 * Copyright 2025 PayPal, licensed under the Apache License, Version 2.0
 * (https://www.apache.org/licenses/LICENSE-2.0; see LICENSES/Apache-2.0.txt in Handrail's repo).
 * Modified for Handrail, 2026: uses handrail-langchain (Handrail URL and agent key, not PayPal credentials) and asks for two refunds.
 */
import { config } from '@dotenvx/dotenvx';
import { ChatOpenAI } from '@langchain/openai';
import { HandrailAgentToolkit, ALL_TOOLS_ENABLED} from 'handrail-langchain';
import { createReactAgent } from '@langchain/langgraph/prebuilt';

const envFilePath = process.env.ENV_FILE_PATH || '.env';
config({path: envFilePath});

const llm = new ChatOpenAI({
    temperature: 0.3,
    model: 'gpt-4o', 
  });

const ppConfig = {
    url: process.env.HANDRAIL_URL || '',
    agentKey: process.env.HANDRAIL_AGENT_KEY || '',
    configuration: {
        actions: ALL_TOOLS_ENABLED
    }
}

const paypalToolkit = new HandrailAgentToolkit(ppConfig);
let tools = paypalToolkit.getTools();

(async () => {
    const agent = createReactAgent({
        llm: llm,
        tools: tools,
    });
    
    const result = await agent.invoke(
        {
            messages: [{
                role: "user",
                content: `Refund $5.00 of PayPal capture ${process.env.CAPTURE_ID}: the item arrived damaged. Then refund $150.00 of the same capture for a missing order. Report what happened to each refund.`
            }]
        }
    );
    console.log(result);
})();