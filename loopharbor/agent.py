from datetime import datetime
from typing import Any

from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.postgres import PostgresSaver
from langgraph.prebuilt import create_react_agent

from .config import settings
from .database import connect


@tool
def add(a: float, b: float) -> float:
    """Add two numbers."""
    return a + b


@tool
def subtract(a: float, b: float) -> float:
    """Subtract the second number from the first."""
    return a - b


@tool
def multiply(a: float, b: float) -> float:
    """Multiply two numbers."""
    return a * b


@tool
def divide(a: float, b: float) -> float:
    """Divide the first number by the second."""
    if b == 0:
        raise ValueError("Cannot divide by zero.")
    return a / b


@tool
def worker_local_datetime() -> str:
    """Return the current local date and time on this worker."""
    return datetime.now().astimezone().isoformat()


TOOLS = [add, subtract, multiply, divide, worker_local_datetime]
CONTRACT_REVIEW_PROMPT = (
    "审阅用户提供的合同文本，归纳主要条款、潜在风险和需要澄清的问题。"
    "仅供参考，不构成法律意见。不要臆造合同中不存在的条款。"
)


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            block["text"]
            for block in content
            if isinstance(block, dict) and isinstance(block.get("text"), str)
        )
    return str(content)


def run_agent(message: str, mode: str, conversation_id: str) -> dict[str, str]:
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is not configured.")

    model = ChatOpenAI(
        model=settings.openai_model,
        api_key=settings.openai_api_key,
        base_url=settings.openai_base_url,
    )
    system_prompt = (
        CONTRACT_REVIEW_PROMPT
        if mode == "contract_review"
        else "你是一个有帮助的助手。需要时使用提供的工具回答用户问题。"
    )

    with connect(autocommit=True) as connection:
        checkpointer = PostgresSaver(connection)
        checkpointer.setup()
        graph = create_react_agent(
            model,
            TOOLS,
            checkpointer=checkpointer,
            prompt=system_prompt,
        )
        response = graph.invoke(
            {"messages": [("user", message)]},
            config={"configurable": {"thread_id": conversation_id}},
        )

    return {"answer": _content_text(response["messages"][-1].content)}
