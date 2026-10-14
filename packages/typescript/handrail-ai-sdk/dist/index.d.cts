import { LanguageModelV1, Tool } from 'ai';

/*!
 * Contains material from PayPal's Agent Toolkit (https://github.com/paypal/agent-toolkit, typescript/src/shared/tools.ts),
 * Copyright 2025 PayPal, licensed under the Apache License, Version 2.0
 * (https://www.apache.org/licenses/LICENSE-2.0; see LICENSES/Apache-2.0.txt in Handrail's repo).
 * Modified for Handrail, 2026: only the tool to action-name table is kept, plus ALL_TOOLS_ENABLED built from it.
 */
type Actions = {
    [product: string]: {
        [action: string]: boolean;
    };
};
/** Every action enabled, like PayPal's ALL_TOOLS_ENABLED. */
declare const ALL_TOOLS_ENABLED: Actions;

declare class HandrailError extends Error {
    readonly status?: number | undefined;
    constructor(message: string, status?: number | undefined);
}
type CallToolResult = {
    content?: Array<{
        type: string;
        text?: string;
    }>;
    isError?: boolean;
};
declare class HandrailClient {
    #private;
    readonly url: string;
    readonly timeoutMs: number;
    constructor({ url, agentKey, timeoutMs }: {
        url: string;
        agentKey: string;
        timeoutMs?: number;
    });
    toJSON(): {
        url: string;
    };
    private request;
    /** Every tool, with the same names and JSON Schemas an MCP client sees. */
    listTools(): Promise<Array<{
        name: string;
        description?: string;
        inputSchema: Record<string, unknown>;
    }>>;
    /**
     * The MCP CallToolResult. A held, blocked or duplicate call is a normal result
     * whose text is Handrail's JSON, e.g. {"handrail": {"status": "pending_approval", ...}}.
     */
    callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
    /** The result as text, the way PayPal's toolkit returns it to the agent. */
    run(name: string, args?: Record<string, unknown>): Promise<string>;
}

declare const GET_APPROVAL_TOOL = "handrail_get_approval";
/** Same shape as PayPal's Configuration. `context` is accepted and never sent: PayPal settings live in Handrail. */
type Configuration = {
    actions: Actions;
    context?: {
        access_token?: string;
        [key: string]: unknown;
    };
};
type HandrailToolkitOptions = {
    /** Where Handrail runs, e.g. https://handrail.example.com */
    url: string;
    /** An agent key from Handrail's dashboard (Team & keys). Never PayPal credentials. */
    agentKey: string;
    configuration: Configuration;
    timeoutMs?: number;
};
/** Same rule as PayPal's isToolAllowed: a tool is offered if any of its actions is enabled. */
declare function isToolAllowed(name: string, configuration: Configuration): boolean;

/*!
 * Contains material from PayPal's Agent Toolkit (https://github.com/paypal/agent-toolkit, typescript/src/ai-sdk/workflows.ts),
 * Copyright 2025 PayPal, licensed under the Apache License, Version 2.0
 * (https://www.apache.org/licenses/LICENSE-2.0; see LICENSES/Apache-2.0.txt in Handrail's repo).
 * Modified for Handrail, 2026: uses Handrail's toolkit and Handrail's create_order schema; log text shortened.
 */

declare class HandrailWorkflows {
    readonly toolkit: HandrailAgentToolkit;
    log: (message: any) => void;
    constructor(options: HandrailToolkitOptions & {
        log?: (message: any) => void;
    });
    generateOrder(llm: LanguageModelV1, userPrompt: string, systemPrompt: string): Promise<string>;
    getDisputeDetails(llm: LanguageModelV1, userPrompt: string): Promise<string>;
}

/**
 * PayPal's Agent Toolkit tools for the Vercel AI SDK, with every call going
 * through Handrail. A drop-in for `@paypal/agent-toolkit/ai-sdk`: the same
 * `configuration`, `getTools()` and `ALL_TOOLS_ENABLED`, but the constructor
 * takes Handrail's URL and an agent key instead of PayPal credentials.
 */

declare class HandrailAgentToolkit {
    readonly client: HandrailClient;
    private readonly _tools;
    constructor(options: HandrailToolkitOptions);
    getTools(): {
        [name: string]: Tool;
    };
}

export { ALL_TOOLS_ENABLED, type Configuration, GET_APPROVAL_TOOL, HandrailAgentToolkit, HandrailClient, HandrailError, type HandrailToolkitOptions, HandrailWorkflows, isToolAllowed };
