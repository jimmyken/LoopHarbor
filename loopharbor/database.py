from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .config import settings


def connect(*, autocommit: bool = False) -> psycopg.Connection:
    return psycopg.connect(
        settings.database_url, row_factory=dict_row, autocommit=autocommit
    )


def initialize_database() -> None:
    with connect() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS tasks (
                id UUID PRIMARY KEY,
                conversation_id UUID NOT NULL,
                mode TEXT NOT NULL CHECK (mode IN ('chat', 'contract_review')),
                input TEXT NOT NULL,
                status TEXT NOT NULL CHECK (
                    status IN ('queued', 'running', 'succeeded', 'failed')
                ),
                result JSONB,
                error TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
        )


def create_task(
    task_id: str, conversation_id: str, mode: str, message: str
) -> None:
    with connect() as connection:
        connection.execute(
            """
            INSERT INTO tasks (id, conversation_id, mode, input, status)
            VALUES (%s, %s, %s, %s, 'queued')
            """,
            (task_id, conversation_id, mode, message),
        )


def update_task(
    task_id: str,
    status: str,
    result: dict[str, Any] | None = None,
    error: str | None = None,
) -> None:
    with connect() as connection:
        connection.execute(
            """
            UPDATE tasks
            SET status = %s, result = %s, error = %s, updated_at = now()
            WHERE id = %s
            """,
            (status, Jsonb(result) if result is not None else None, error, task_id),
        )


def get_task(task_id: str) -> dict[str, Any] | None:
    with connect() as connection:
        return connection.execute(
            """
            SELECT id AS task_id, conversation_id, mode, status, result, error,
                   created_at, updated_at
            FROM tasks
            WHERE id = %s
            """,
            (task_id,),
        ).fetchone()
