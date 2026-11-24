import uuid
from pathlib import Path
from typing import Literal
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from langgraph.checkpoint.postgres import PostgresSaver
from pydantic import AliasChoices, BaseModel, Field
from celery.result import AsyncResult

from app.celery_app import celery_app
from app.db import (
    SessionModeMismatch, SessionNotFound, create_task, get_session, get_task, init_db,
    list_sessions,
)
from app.agent import build_graph
from app.config import DATABASE_URL, MEMORY_SUMMARIZE_EVERY_TURNS
from app.tasks import run_contract_agent

api = FastAPI(
    title="Celery + Redis Async Agent",
    description="FastAPI + Celery + Redis + LangGraph + PostgreSQL",
    version="1.0.0",
)
STATIC_DIR = Path(__file__).parent / "static"
api.mount("/assets", StaticFiles(directory=STATIC_DIR), name="assets")

class SubmitRequest(BaseModel):
    mode: Literal["chat", "contract"]
    thread_id: str | None = Field(default=None, min_length=1, max_length=128)
    message: str = Field(
        min_length=1,
        max_length=100000,
        validation_alias=AliasChoices("message", "contract_text"),
    )

@api.on_event("startup")
def startup():
    init_db()

@api.get("/health")
def health():
    return {"status": "ok"}


@api.get("/", include_in_schema=False)
def workspace():
    return FileResponse(STATIC_DIR / "index.html")


@api.get("/sessions")
def sessions():
    return list_sessions()


@api.get("/sessions/{thread_id}")
def session_detail(thread_id: str):
    session = get_session(thread_id)
    if session is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    memory = {"summary": "", "active_turns": 0, "summarize_every_turns": MEMORY_SUMMARIZE_EVERY_TURNS}
    if any(task["status"] == "SUCCESS" for task in session["tasks"]):
        with PostgresSaver.from_conn_string(DATABASE_URL) as checkpointer:
            snapshot = build_graph(checkpointer).get_state({"configurable": {"thread_id": thread_id}})
            memory["summary"] = snapshot.values.get("summary", "")
            memory["active_turns"] = len(snapshot.values.get("history", [])) // 2
    session["memory"] = memory
    return session


@api.post("/tasks", status_code=202)
def submit_task(req: SubmitRequest):
    task_id = str(uuid.uuid4())
    thread_id = req.thread_id or f"{req.mode}-{task_id}"

    try:
        create_task(
            task_id, thread_id, req.message, req.mode,
            new_session=req.thread_id is None,
        )
    except SessionNotFound:
        raise HTTPException(status_code=404, detail="会话不存在") from None
    except SessionModeMismatch:
        raise HTTPException(status_code=409, detail="会话模式不可更改") from None
    try:
        run_contract_agent.apply_async(
            args=[task_id, thread_id, req.message, req.mode],
            task_id=task_id,
        )
    except Exception as exc:
        from app.db import update_task
        update_task(
            task_id, status="ENQUEUE_FAILED",
            current_step="任务投递失败",
            error=str(exc)[:2000],
        )
        raise HTTPException(status_code=503, detail="任务队列暂不可用")

    return {
        "task_id": task_id,
        "thread_id": thread_id,
        "status": "QUEUED",
        "status_url": f"/tasks/{task_id}",
    }

@api.get("/tasks/{task_id}")
def task_status(task_id: str):
    row = get_task(task_id)
    if row is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    data = dict(row)
    for key in ("created_at", "updated_at"):
        if data.get(key):
            data[key] = data[key].isoformat()
    return data

@api.get("/tasks/{task_id}/celery")
def celery_status(task_id: str):
    result = AsyncResult(task_id, app=celery_app)
    return {
        "task_id": task_id,
        "celery_state": result.state,
        "celery_result": result.result if result.successful() else None,
    }
