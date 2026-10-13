import {config} from '@dotenvx/dotenvx';
import {openai} from '@ai-sdk/openai';
import {generateText} from 'ai';
import {HandrailWorkflows, HandrailAgentToolkit, ALL_TOOLS_ENABLED} from 'handrail-ai-sdk';

// Get the env file path from an environment variable, with a default fallback
const envFilePath = process.env.ENV_FILE_PATH || '.env';
config({path: envFilePath});

/*
 * This holds all the configuration required for starting PayPal Agent Toolkit
 */

const ppConfig = {
    url: process.env.HANDRAIL_URL || '',
    agentKey: process.env.HANDRAIL_AGENT_KEY || '',
    configuration: {
        actions: ALL_TOOLS_ENABLED
    }
}
/*
 * This holds all the tools that use PayPal functionality
 */
const paypalToolkit = new HandrailAgentToolkit(ppConfig);
/*
 * This holds all the preconfigured common PayPal workflows
 */
const paypalWorkflows = new HandrailWorkflows(ppConfig)

/*
 * This is the merchant's typical use case. This stays the same for most requests.
 */
const systemPrompt = `I am a plumber running a small business. I charge $120 per hour plus 50% tax. I use standard parts which typically include a new faucet costing between $50-80 and pipes for about $3 per foot. There is 12% tax for parts. My return URL is: http://localhost:3000/thank-you.`;


// User can bring their own llm
const llm = openai('gpt-4o');

(async () => {

    // The userPrompt is a specific prompt for a single transaction for the business.
    const userPrompt = `Customer needed 3 hours of work and had a standard list of parts for replacing a kitchen faucet. Create an order.`

    // Invoke preconfigured workflows that will orchestrate across multiple calls.
    const orderSummary = await paypalWorkflows.generateOrder(llm, userPrompt, systemPrompt);
    console.log(orderSummary)

    // (or) Invoke through toolkit for specific use-cases
    const {text: orderDetails} = await generateText({
        model: openai('gpt-4o'),
        tools: paypalToolkit.getTools(),
        maxSteps: 10,
        prompt: `Refund $5.00 of PayPal capture ${process.env.CAPTURE_ID}: the item arrived damaged. Then refund $150.00 of the same capture for a missing order. Report what happened to each refund.`,
    });
    console.log(orderDetails)
})();
