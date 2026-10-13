import os
from langchain.agents import initialize_agent, AgentType
from langchain_openai import ChatOpenAI 

from dotenv import load_dotenv

from handrail_langchain import HandrailToolkit, Configuration, Context

#uncomment after setting the env file
# load_dotenv()
HANDRAIL_URL = os.getenv("HANDRAIL_URL")
HANDRAIL_AGENT_KEY = os.getenv("HANDRAIL_AGENT_KEY")
OPENAI_API_VERSION = "2024-02-15-preview"


# --- STEP 1: Setup OpenAI LLM ---
llm = ChatOpenAI(
    temperature=0.3,
    model="gpt-4o",  # or "gpt-3.5-turbo"
)


# --- STEP 2: Setup PayPal Configuration ---
configuration = Configuration(
    actions={
        "orders": {
            "create": True,
            "get": True,
            "capture": True,
        },
        "payments": {
            "createRefund": True,
        }
    },
    context=Context(
        sandbox=True
    )
)


# --- STEP 3: Build PayPal Toolkit ---
toolkit = HandrailToolkit(url=HANDRAIL_URL, agent_key=HANDRAIL_AGENT_KEY, configuration = configuration)
tools = toolkit.get_tools()



# --- STEP 4: Initialize LangChain Agent ---
agent = initialize_agent(
    tools=tools,
    llm=llm,
    agent=AgentType.OPENAI_FUNCTIONS,
    verbose=True
)


# --- STEP 5: Run Agent with Prompt ---
if __name__ == "__main__":
    capture_id = os.getenv("CAPTURE_ID")
    prompt = (
        f"Refund $5.00 of PayPal capture {capture_id}: the item arrived damaged. "
        f"Then refund $150.00 of the same capture for a missing order. Report what happened to each refund."
    )
    result = agent.run(prompt)
    print("Agent Output:", result)
