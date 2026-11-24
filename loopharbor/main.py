from contextlib import asynccontextmanager
from typing import Literal
from uuid import UUID, uuid4

from fastapi import FastAPI, HTTPException, status
from pydantic import BaseModel, Field

from .database import create_task, get_task, initialize_database, update_task
from .worker import execute_agent


class TaskRequest(BaseModel):
    message: str = Field(min_length=1, max_length=30_000)
    mode: Literal["chat", "contract_review"] = "chat"
    conversation_id: UUID | None = None


class TaskAccepted(BaseModel):
    task_id: UUID
    conversation_id: UUID
    status: str


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize_database()
    yield


app = FastAPI(
    title="LoopHarbor",
    description="An asynchronous, multi-turn agent workbench.",
    lifespan=lifespan,
)


@app.post("/tasks", response_model=TaskAccepted, status_code=status.HTTP_202_ACCEPTED)
async def submit_task(request: TaskRequest) -> TaskAccepted:
    task_id = uuid4()
    conversation_id = request.conversation_id or uuid4()
    create_task(str(task_id), str(conversation_id), request.mode, request.message)
    try:
        execute_agent.apply_async(
            args=[
                str(task_id),
                str(conversation_id),
                request.mode,
                request.message,
            ],
            task_id=str(task_id),
        )
    except Exception as exc:
        update_task(
            str(task_id),
            "failed",
            error="The task could not be queued.",
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Task queue is unavailable.",
        ) from exc
    return TaskAccepted(
        task_id=task_id, conversation_id=conversation_id, status="queued"
    )


@app.get("/tasks/{task_id}")
async def task_status(task_id: UUID):
    task = get_task(str(task_id))
    if task is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Task not found."
        )
    return task
