from celery.exceptions import SoftTimeLimitExceeded
from langgraph.checkpoint.postgres import PostgresSaver
from typing import Literal

from app.celery_app import celery_app
from app.config import DATABASE_URL
from app.db import get_task, has_pending_predecessor, lock_session, update_task
from app.agent import build_graph

@celery_app.task(
    bind=True,
    name="app.tasks.run_contract_agent",
    acks_late=True,
    max_retries=None,
)
def run_contract_agent(
    self, task_id: str, thread_id: str, contract_text: str,
    mode: Literal["chat", "contract"] = "contract",
    auto_split: bool = False,
):
    with lock_session(thread_id):
        task = get_task(task_id)
        if task is None:
            raise RuntimeError("业务任务不存在")
        if task["status"] == "SUCCESS":
            return task["result_json"]
        if task["status"] in ("FAILURE", "ENQUEUE_FAILED", "RETRYABLE"):
            raise RuntimeError("业务任务已结束，不能重复执行")
        if has_pending_predecessor(task_id):
            raise self.retry(countdown=2)
        return execute_turn(task_id, thread_id, contract_text, mode, auto_split)


def execute_turn(task_id: str, thread_id: str, contract_text: str, mode: str, auto_split: bool = False):
    try:
        update_task(
            task_id, status="RUNNING", progress=5,
            current_step="Worker 已领取任务"
        )

        # psycopg connection string 用于 LangGraph 持久化 Checkpoint。
        with PostgresSaver.from_conn_string(DATABASE_URL) as checkpointer:
            checkpointer.setup()
            graph = build_graph(checkpointer)

            config = {
                "configurable": {
                    "thread_id": thread_id
                }
            }

            update_task(
                task_id, status="RUNNING", progress=20,
                current_step="正在请求大模型"
            )
            previous = graph.get_state(config).values
            if previous.get("completed_task_id") == task_id:
                result = previous
            else:
                result = graph.invoke(
                    {"message": contract_text, "mode": mode, "task_id": task_id, "auto_split": auto_split},
                    config=config,
                )

        payload = {
            "thread_id": thread_id,
            "mode": mode,
            "risks": result["risks"],
            "report": result["report"],
        }
        if mode == "chat":
            payload["answer"] = result["answer"]
        update_task(
            task_id,
            status="SUCCESS",
            progress=100,
            current_step="任务完成",
            result_json=payload,
        )
        return payload

    except SoftTimeLimitExceeded:
        update_task(
            task_id, status="RETRYABLE",
            current_step="任务超过软超时限制，可由调度策略处理",
            error="Soft time limit exceeded",
        )
        raise
    except Exception as exc:
        update_task(
            task_id, status="FAILURE",
            current_step="任务执行失败",
            error=str(exc)[:2000],
        )
        raise
