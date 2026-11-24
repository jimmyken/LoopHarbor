import json
import os
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import psycopg
from celery.exceptions import Retry
from fastapi.testclient import TestClient
from psycopg import sql
from psycopg.conninfo import make_conninfo

from app import db, tasks
from app.main import api


@unittest.skipUnless(os.getenv("TEST_DATABASE_URL"), "TEST_DATABASE_URL 未设置")
class PostgresSessionTests(unittest.TestCase):
    def setUp(self):
        self.url = os.environ["TEST_DATABASE_URL"]
        self.schema = "agent_test_" + uuid.uuid4().hex
        with psycopg.connect(self.url, autocommit=True) as conn:
            conn.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(self.schema)))
        self.addCleanup(self.drop_schema)
        isolated = make_conninfo(self.url, options="-c search_path=" + self.schema)
        self.db_patch = patch("app.db.DATABASE_URL", isolated)
        self.task_patch = patch("app.tasks.DATABASE_URL", isolated)
        self.db_patch.start()
        self.task_patch.start()
        self.addCleanup(self.db_patch.stop)
        self.addCleanup(self.task_patch.stop)
        db.init_db()

    def drop_schema(self):
        with psycopg.connect(self.url, autocommit=True) as conn:
            conn.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(self.schema)))

    def test_fifo_checkpoint_summary_and_redelivery(self):
        calls = []

        def fake_model(messages, *, tools=False):
            calls.append(json.loads(json.dumps(messages)))
            return {"content": "回答" if tools else "用户喜欢简洁"}

        with patch("app.agent.call_model", side_effect=fake_model), \
             patch("app.agent.MEMORY_SUMMARIZE_EVERY_TURNS", 2):
            db.create_task("a", "session", "我喜欢简洁", "chat", new_session=True)
            db.create_task("b", "session", "记住了吗", "chat", new_session=False)
            with self.assertRaises(Retry):
                tasks.run_contract_agent.run("b", "session", "记住了吗", "chat")
            self.assertEqual(db.get_task("b")["status"], "QUEUED")
            tasks.run_contract_agent.run("a", "session", "我喜欢简洁", "chat")

            db.update_task("a", status="RUNNING")
            tasks.run_contract_agent.run("a", "session", "我喜欢简洁", "chat")
            self.assertEqual(len(calls), 1)

            tasks.run_contract_agent.run("b", "session", "记住了吗", "chat")
            self.assertTrue(any(m.get("content") == "我喜欢简洁" for m in calls[1]))
            self.assertEqual(db.get_task("b")["status"], "SUCCESS")
            db.create_task("c", "session", "我的偏好", "chat", new_session=False)
            tasks.run_contract_agent.run("c", "session", "我的偏好", "chat")
            self.assertTrue(any("用户喜欢简洁" in m.get("content", "") for m in calls[3]))
            self.assertFalse(any(m.get("content") == "我喜欢简洁" for m in calls[3]))

    def test_session_must_exist_and_mode_is_fixed(self):
        with self.assertRaises(db.SessionNotFound):
            db.create_task("a", "missing", "文本", "chat", new_session=False)
        db.create_task("b", "session", "文本", "chat", new_session=True)
        with self.assertRaises(db.SessionModeMismatch):
            db.create_task("c", "session", "文本", "contract", new_session=False)

    def test_tool_events_and_session_history_are_persisted(self):
        db.create_task("a", "session", "请计算", "chat", new_session=True)
        calls = [
            {"tool_calls": [{
                "id": "call-1", "type": "function",
                "function": {"name": "calculate", "arguments": '{"operation":"add","a":2,"b":3}'},
            }]},
            {"content": "5"},
        ]
        with patch("app.agent.call_model", side_effect=calls):
            tasks.run_contract_agent.run("a", "session", "请计算", "chat")
        session = db.get_session("session")
        self.assertEqual(session["tasks"][0]["input_text"], "请计算")
        self.assertEqual(session["tool_events"][0]["name"], "calculate")
        self.assertEqual(json.loads(session["tool_events"][0]["output"])["result"], 5)
        self.assertEqual(db.list_sessions()[0]["thread_id"], "session")
        with patch("app.main.DATABASE_URL", db.DATABASE_URL):
            response = TestClient(api).get("/sessions/session")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["memory"]["active_turns"], 1)
        self.assertEqual(response.json()["tool_events"][0]["name"], "calculate")

    def test_overlapping_turns_are_serialized(self):
        started = threading.Event()
        second_started = threading.Event()
        release = threading.Event()
        calls = []

        def fake_model(messages, *, tools=False):
            calls.append(messages[-1]["content"])
            if len(calls) == 1:
                started.set()
                if not release.wait(5):
                    raise RuntimeError("test timed out waiting for release")
            return {"content": "回答"}

        db.create_task("a", "session", "第一轮", "chat", new_session=True)
        db.create_task("b", "session", "第二轮", "chat", new_session=False)

        def run_second():
            second_started.set()
            return tasks.run_contract_agent.run("b", "session", "第二轮", "chat")

        with patch("app.agent.call_model", side_effect=fake_model), \
             ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(tasks.run_contract_agent.run, "a", "session", "第一轮", "chat")
            try:
                self.assertTrue(started.wait(5))
                second = executor.submit(run_second)
                self.assertTrue(second_started.wait(5))
                self.assertFalse(second.done())
            finally:
                release.set()
            first.result(timeout=10)
            second.result(timeout=10)
        self.assertEqual(calls, ["第一轮", "第二轮"])


if __name__ == "__main__":
    unittest.main()
