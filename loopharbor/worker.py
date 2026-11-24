from typing import Any

from .agent import run_agent
from .celery_app import celery_app
from .database import update_task


@celery_app.task(name="loopharbor.run_agent")
def execute_agent(
    task_id: str, conversation_id: str, mode: str, message: str
) -> dict[str, Any]:
    update_task(task_id, "running")
    try:
        result = run_agent(message, mode, conversation_id)
        update_task(task_id, "succeeded", result=result)
        return result
    except Exception:
        update_task(
            task_id,
            "failed",
            error="The task failed. Check the worker logs for details.",
        )
        raise
