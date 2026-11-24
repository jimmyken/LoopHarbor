import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
import json
from contextlib import contextmanager
from app.config import DATABASE_URL

def connect():
    return psycopg.connect(DATABASE_URL, row_factory=dict_row)

def init_db():
    with connect() as conn:
        conn.execute(
            '''
            CREATE TABLE IF NOT EXISTS agent_sessions (
                thread_id TEXT PRIMARY KEY,
                mode TEXT NOT NULL,
                next_sequence BIGINT NOT NULL DEFAULT 1
            )
            '''
        )
        conn.execute(
            '''
            CREATE TABLE IF NOT EXISTS agent_tasks (
                task_id TEXT PRIMARY KEY,
                thread_id TEXT NOT NULL,
                status TEXT NOT NULL,
                progress INTEGER NOT NULL DEFAULT 0,
                current_step TEXT,
                input_text TEXT NOT NULL,
                result_json JSONB,
                error TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            '''
        )
        conn.execute("ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS sequence_no BIGINT")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS agent_tasks_session_order "
            "ON agent_tasks (thread_id, sequence_no)"
        )
        conn.execute(
            '''
            CREATE TABLE IF NOT EXISTS agent_tool_events (
                id BIGSERIAL PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES agent_tasks(task_id),
                name TEXT NOT NULL,
                arguments TEXT NOT NULL,
                output TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            '''
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS agent_tool_events_task "
            "ON agent_tool_events (task_id, id)"
        )


class SessionNotFound(Exception):
    pass


class SessionModeMismatch(Exception):
    pass


def create_task(task_id: str, thread_id: str, input_text: str, mode: str, *, new_session: bool):
    with connect() as conn:
        if new_session:
            conn.execute(
                "INSERT INTO agent_sessions (thread_id, mode) VALUES (%s, %s)",
                (thread_id, mode),
            )
        session = conn.execute(
            "SELECT mode, next_sequence FROM agent_sessions WHERE thread_id = %s FOR UPDATE",
            (thread_id,),
        ).fetchone()
        if session is None:
            raise SessionNotFound()
        if session["mode"] != mode:
            raise SessionModeMismatch()
        sequence = session["next_sequence"]
        conn.execute(
            "UPDATE agent_sessions SET next_sequence = next_sequence + 1 WHERE thread_id = %s",
            (thread_id,),
        )
        conn.execute(
            '''
            INSERT INTO agent_tasks
                (task_id, thread_id, status, progress, current_step, input_text, sequence_no)
            VALUES (%s, %s, 'QUEUED', 0, '任务已进入队列', %s, %s)
            ''',
            (task_id, thread_id, input_text, sequence),
        )


@contextmanager
def lock_session(thread_id: str):
    with connect() as conn:
        conn.execute("SELECT pg_advisory_lock(hashtextextended(%s, 0))", (thread_id,))
        conn.commit()
        try:
            yield
        finally:
            conn.execute("SELECT pg_advisory_unlock(hashtextextended(%s, 0))", (thread_id,))


def has_pending_predecessor(task_id: str):
    with connect() as conn:
        row = conn.execute(
            '''
            SELECT EXISTS (
                SELECT 1 FROM agent_tasks previous
                JOIN agent_tasks current ON previous.thread_id = current.thread_id
                WHERE current.task_id = %s
                  AND previous.sequence_no < current.sequence_no
                  AND previous.status IN ('QUEUED', 'RUNNING')
            ) AS pending
            ''',
            (task_id,),
        ).fetchone()
        return row["pending"]

def update_task(task_id: str, *, status=None, progress=None,
                current_step=None, result_json=None, error=None):
    fields = []
    values = []
    for key, value in (
        ("status", status),
        ("progress", progress),
        ("current_step", current_step),
        ("result_json", result_json),
        ("error", error),
    ):
        if value is not None:
            fields.append(f"{key} = %s")
            if key == "result_json" and isinstance(value, (dict, list)):
                values.append(Jsonb(value))
            elif key == "result_json" and isinstance(value, str):
                values.append(Jsonb(json.loads(value)))
            else:
                values.append(value)
    if not fields:
        return
    fields.append("updated_at = NOW()")
    values.append(task_id)
    with connect() as conn:
        conn.execute(
            f"UPDATE agent_tasks SET {', '.join(fields)} WHERE task_id = %s",
            values,
        )

def get_task(task_id: str):
    with connect() as conn:
        return conn.execute(
            '''
            SELECT task_id, thread_id, status, progress, current_step,
                   result_json, error, created_at, updated_at
            FROM agent_tasks WHERE task_id = %s
            ''',
            (task_id,),
        ).fetchone()


def list_sessions():
    with connect() as conn:
        return conn.execute(
            '''
            SELECT s.thread_id, s.mode, s.next_sequence - 1 AS task_count,
                   first_task.input_text AS first_message,
                   last_task.status AS last_status,
                   last_task.updated_at
            FROM agent_sessions s
            LEFT JOIN LATERAL (
                SELECT left(input_text, 160) AS input_text FROM agent_tasks
                WHERE thread_id = s.thread_id ORDER BY sequence_no ASC LIMIT 1
            ) first_task ON TRUE
            LEFT JOIN LATERAL (
                SELECT status, updated_at FROM agent_tasks
                WHERE thread_id = s.thread_id ORDER BY sequence_no DESC LIMIT 1
            ) last_task ON TRUE
            ORDER BY last_task.updated_at DESC NULLS LAST, s.thread_id
            '''
        ).fetchall()


def get_session(thread_id: str):
    with connect() as conn:
        session = conn.execute(
            "SELECT thread_id, mode FROM agent_sessions WHERE thread_id = %s",
            (thread_id,),
        ).fetchone()
        if session is None:
            return None
        session["tasks"] = conn.execute(
            '''
            SELECT task_id, thread_id, status, progress, current_step, input_text,
                   result_json, error, created_at, updated_at, sequence_no
            FROM agent_tasks WHERE thread_id = %s ORDER BY sequence_no
            ''',
            (thread_id,),
        ).fetchall()
        session["tool_events"] = conn.execute(
            '''
            SELECT e.id, e.task_id, e.name, e.arguments, e.output, e.created_at
            FROM agent_tool_events e JOIN agent_tasks t ON t.task_id = e.task_id
            WHERE t.thread_id = %s ORDER BY e.id
            ''',
            (thread_id,),
        ).fetchall()
        return session


def record_tool_event(task_id: str, name: str, arguments: str, output: str):
    with connect() as conn:
        conn.execute(
            '''
            INSERT INTO agent_tool_events (task_id, name, arguments, output)
            VALUES (%s, %s, %s, %s)
            ''',
            (task_id, name, arguments, output),
        )
        conn.execute(
            '''
            UPDATE agent_tasks SET current_step = %s, updated_at = NOW()
            WHERE task_id = %s
            ''',
            ("已调用工具，正在继续推理", task_id),
        )
