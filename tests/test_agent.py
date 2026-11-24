import json
import unittest
from copy import deepcopy
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from langgraph.checkpoint.memory import InMemorySaver

from pydantic import ValidationError

from app.agent import build_graph, execute_tool, model_loop, run_agent
from app.main import SubmitRequest, api
from app.tasks import execute_turn


class TestSaver(InMemorySaver):
    def setup(self):
        pass


class AgentGraphTests(unittest.TestCase):
    def setUp(self):
        self.settings = patch.multiple(
            "app.agent",
            LLM_BASE_URL="https://example.test/v1",
            LLM_API_KEY="test-key",
            LLM_MODEL="test-model",
        )
        self.settings.start()
        self.addCleanup(self.settings.stop)

    @patch("app.agent.httpx.post")
    def test_graph_calls_model_and_saves_answer(self, post):
        post.return_value = httpx.Response(
            200,
            json={"choices": [{"message": {"content": "你好！"}}]},
            request=httpx.Request("POST", "https://example.test/v1/chat/completions"),
        )
        graph = build_graph(InMemorySaver())
        config = {"configurable": {"thread_id": "test-chat"}}

        result = graph.invoke({"mode": "chat", "message": "你好"}, config)

        self.assertEqual(result["answer"], "你好！")
        self.assertEqual(graph.get_state(config).values["answer"], "你好！")
        self.assertEqual(post.call_args.args[0], "https://example.test/v1/chat/completions")
        self.assertEqual(post.call_args.kwargs["json"]["model"], "test-model")
        self.assertEqual(post.call_args.kwargs["json"]["messages"][-1], {"role": "user", "content": "你好"})
        self.assertTrue(post.call_args.kwargs["json"]["tools"])
        self.assertEqual(post.call_args.kwargs["headers"]["Authorization"], "Bearer test-key")

    @patch("app.agent.httpx.post")
    def test_contract_review_preserves_report_and_risks(self, post):
        review = {"risks": ["付款条件不明确"], "report": "请明确付款条件。"}
        post.return_value = httpx.Response(
            200,
            json={"choices": [{"message": {"content": json.dumps(review)}}]},
            request=httpx.Request("POST", "https://example.test/v1/chat/completions"),
        )
        graph = build_graph(InMemorySaver())
        config = {"configurable": {"thread_id": "test-contract"}}

        result = graph.invoke({"mode": "contract", "message": "验收后付款"}, config)

        self.assertEqual(result["risks"], review["risks"])
        self.assertEqual(result["report"], review["report"])
        self.assertEqual(graph.get_state(config).values["report"], review["report"])
        messages = post.call_args.kwargs["json"]["messages"]
        self.assertEqual(messages[0]["role"], "system")
        self.assertEqual(messages[1]["content"], "验收后付款")

    @patch("app.agent.httpx.post")
    def test_missing_configuration_fails_without_request(self, post):
        with patch("app.agent.LLM_API_KEY", ""):
            with self.assertRaisesRegex(ValueError, "LLM_API_KEY"):
                run_agent({"mode": "chat", "message": "你好"})
        post.assert_not_called()

    @patch("app.agent.httpx.post")
    def test_http_failure_does_not_expose_provider_response(self, post):
        post.return_value = httpx.Response(
            401,
            text="sensitive provider response",
            request=httpx.Request("POST", "https://example.test/v1/chat/completions"),
        )
        with self.assertRaisesRegex(RuntimeError, "HTTP 状态码：401") as error:
            run_agent({"mode": "chat", "message": "你好"})
        self.assertNotIn("sensitive provider response", str(error.exception))

    @patch("app.agent.httpx.post")
    def test_invalid_response_fails(self, post):
        post.return_value = httpx.Response(
            200,
            json={"choices": []},
            request=httpx.Request("POST", "https://example.test/v1/chat/completions"),
        )
        with self.assertRaisesRegex(RuntimeError, "响应格式无效"):
            run_agent({"mode": "chat", "message": "你好"})

    @patch("app.agent.httpx.post")
    def test_invalid_contract_result_fails(self, post):
        post.return_value = httpx.Response(
            200,
            json={"choices": [{"message": {"content": '{"risks": "bad", "report": "ok"}'}}]},
            request=httpx.Request("POST", "https://example.test/v1/chat/completions"),
        )
        with self.assertRaisesRegex(RuntimeError, "合同审查结果格式无效"):
            run_agent({"mode": "contract", "message": "合同"})

    def test_mode_required_and_legacy_request_field_supported(self):
        self.assertEqual(SubmitRequest(mode="chat", message="你好").message, "你好")
        self.assertEqual(SubmitRequest(mode="contract", contract_text="合同").message, "合同")
        with self.assertRaises(ValidationError):
            SubmitRequest(message="你好")
        with self.assertRaises(ValidationError):
            SubmitRequest(mode="other", message="你好")

    @patch("app.main.create_task")
    @patch("app.main.run_contract_agent.apply_async")
    def test_api_passes_mode_to_worker(self, enqueue, create_task):
        response = TestClient(api).post(
            "/tasks", json={"mode": "contract", "message": "验收后付款"}
        )
        self.assertEqual(response.status_code, 202)
        task_id = response.json()["task_id"]
        self.assertEqual(enqueue.call_args.kwargs["args"][2:], ["验收后付款", "contract"])
        self.assertEqual(enqueue.call_args.kwargs["task_id"], task_id)
        self.assertEqual(create_task.call_args.args[2], "验收后付款")

    @patch("app.tasks.update_task")
    @patch("app.tasks.PostgresSaver.from_conn_string")
    @patch("app.agent.httpx.post")
    def test_task_returns_chat_result_and_updates_status(self, post, saver, update):
        post.return_value = httpx.Response(
            200,
            json={"choices": [{"message": {"content": "你好！"}}]},
            request=httpx.Request("POST", "https://example.test/v1/chat/completions"),
        )
        saver.return_value.__enter__.return_value = TestSaver()

        result = execute_turn("task-1", "thread-1", "你好", "chat")

        self.assertEqual(result["answer"], "你好！")
        self.assertEqual(result["report"], "你好！")
        self.assertEqual(result["mode"], "chat")
        self.assertEqual(update.call_args.kwargs["status"], "SUCCESS")

    @patch("app.tasks.update_task")
    @patch("app.tasks.PostgresSaver.from_conn_string")
    def test_task_records_model_configuration_failure(self, saver, update):
        saver.return_value.__enter__.return_value = TestSaver()
        with patch("app.agent.LLM_MODEL", ""):
            with self.assertRaisesRegex(ValueError, "LLM_MODEL"):
                execute_turn("task-1", "thread-1", "你好", "chat")
        self.assertEqual(update.call_args.kwargs["status"], "FAILURE")

    def test_tool_loop_returns_result_to_model(self):
        requests = []

        def fake_model(messages, *, tools=False):
            requests.append(deepcopy(messages))
            if len(requests) == 1:
                return {"tool_calls": [{
                    "id": "call-1", "type": "function",
                    "function": {"name": "calculate", "arguments": '{"operation":"add","a":2,"b":3}'},
                }]}
            return {"content": "结果是 5"}

        with patch("app.agent.call_model", side_effect=fake_model):
            result = model_loop([{"role": "user", "content": "2+3?"}])
        self.assertEqual(result, "结果是 5")
        self.assertEqual(json.loads(requests[1][-1]["content"]), {"result": 5})
        self.assertEqual(requests[1][-1]["tool_call_id"], "call-1")

    @patch("app.agent.record_tool_event")
    def test_tool_events_are_recorded_during_execution(self, record):
        responses = [
            {"tool_calls": [{
                "id": "call-1", "type": "function",
                "function": {"name": "calculate", "arguments": '{"operation":"add","a":2,"b":3}'},
            }]},
            {"content": "结果是 5"},
        ]
        with patch("app.agent.call_model", side_effect=responses):
            self.assertEqual(model_loop([{"role": "user", "content": "2+3"}], task_id="task-1"), "结果是 5")
        self.assertEqual(record.call_args.args[0:2], ("task-1", "calculate"))
        self.assertEqual(json.loads(record.call_args.args[3]), {"result": 5})

    @patch("app.main.get_session")
    def test_session_endpoint_handles_new_and_unknown_sessions(self, get_session):
        get_session.return_value = {"thread_id": "chat-1", "mode": "chat", "tasks": [], "tool_events": []}
        client = TestClient(api)
        response = client.get("/sessions/chat-1")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["memory"]["active_turns"], 0)
        get_session.return_value = None
        self.assertEqual(client.get("/sessions/missing").status_code, 404)

    def test_tool_failures_are_explicit_and_no_code_execution(self):
        self.assertIn("error", json.loads(execute_tool("calculate", '{"operation":"divide","a":1,"b":0}')))
        self.assertIn("error", json.loads(execute_tool("not_allowed", "{}")))
        self.assertIn("time", json.loads(execute_tool("current_time", "{}")))

    def test_multi_turn_summary_and_followup_for_both_modes(self):
        for mode in ("chat", "contract"):
            with self.subTest(mode=mode):
                requests = []
                review = '{"risks": ["付款条件不明确"], "report": "请明确付款条件"}'

                def fake_model(messages, *, tools=False):
                    requests.append(deepcopy(messages))
                    return {"content": ("回答" if mode == "chat" else review) if tools else "用户偏好简洁"}

                graph = build_graph(InMemorySaver())
                config = {"configurable": {"thread_id": mode}}
                with patch("app.agent.call_model", side_effect=fake_model), \
                     patch("app.agent.MEMORY_SUMMARIZE_EVERY_TURNS", 2):
                    graph.invoke({"mode": mode, "message": "我喜欢简洁", "task_id": "1"}, config)
                    graph.invoke({"mode": mode, "message": "请记住", "task_id": "2"}, config)
                    state = graph.get_state(config).values
                    self.assertEqual(state["summary"], "用户偏好简洁")
                    self.assertEqual(state["history"], [])
                    graph.invoke({"mode": mode, "message": "我的偏好？", "task_id": "3"}, config)
                self.assertIn("用户偏好简洁", requests[-1][1]["content"])
                self.assertFalse(any(m["content"] == "我喜欢简洁" for m in requests[-1]))
                self.assertEqual(len(graph.get_state(config).values["history"]), 2)

    def test_summary_failure_preserves_previous_history(self):
        graph = build_graph(InMemorySaver())
        config = {"configurable": {"thread_id": "failure"}}
        with patch("app.agent.MEMORY_SUMMARIZE_EVERY_TURNS", 2):
            with patch("app.agent.call_model", return_value={"content": "回答"}):
                graph.invoke({"mode": "chat", "message": "第一轮", "task_id": "1"}, config)
            with patch("app.agent.call_model", side_effect=[{"content": "第二个回答"}, {"content": ""}]):
                with self.assertRaisesRegex(RuntimeError, "摘要"):
                    graph.invoke({"mode": "chat", "message": "第二轮", "task_id": "2"}, config)
            self.assertEqual(graph.get_state(config).values["history"][0]["content"], "第一轮")
            with patch("app.agent.call_model", side_effect=[{"content": "第三个回答"}, {"content": "新摘要"}]):
                result = graph.invoke({"mode": "chat", "message": "第三轮", "task_id": "3"}, config)
        self.assertEqual(result["summary"], "新摘要")
        self.assertEqual(result["history"], [])

    def test_summary_occurs_after_five_successful_turns(self):
        graph = build_graph(InMemorySaver())
        config = {"configurable": {"thread_id": "five-turns"}}

        def fake_model(messages, *, tools=False):
            return {"content": "回答" if tools else "五轮摘要"}

        with patch("app.agent.MEMORY_SUMMARIZE_EVERY_TURNS", 5), \
             patch("app.agent.call_model", side_effect=fake_model) as model:
            for index in range(4):
                graph.invoke({"mode": "chat", "message": f"第{index + 1}轮", "task_id": str(index)}, config)
            self.assertEqual(len(graph.get_state(config).values["history"]), 8)
            self.assertEqual(model.call_count, 4)
            result = graph.invoke({"mode": "chat", "message": "第5轮", "task_id": "4"}, config)
        self.assertEqual(model.call_count, 6)
        self.assertEqual(result["summary"], "五轮摘要")
        self.assertEqual(result["history"], [])


if __name__ == "__main__":
    unittest.main()
