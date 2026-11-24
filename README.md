# LoopHarbor

异步多轮 Agent 工作台，基于 FastAPI、Celery、Redis、LangGraph 和 PostgreSQL。

## 功能

- `POST /tasks` 接收请求并立即返回 `task_id` 和 `conversation_id`。
- Celery worker 通过 Redis 后台执行 LangGraph Agent，API 从 PostgreSQL 返回任务状态和结果。
- PostgreSQL 同时保存业务任务记录和 LangGraph 对话 checkpoint；后续轮次传入相同的 `conversation_id`。
- Agent 可调用加、减、乘、除以及 worker 本地日期时间工具。
- `mode` 可设为 `contract_review`，生成的合同审阅仅供参考，不构成法律意见。

## 启动

需要 Docker Compose 和一个支持工具调用的 OpenAI 兼容 Chat Completions API。

```sh
cp .env.example .env
# 编辑 .env，设置 OPENAI_API_KEY、OPENAI_BASE_URL 和 OPENAI_MODEL
docker compose up --build
```

API 文档位于 <http://localhost:8000/docs>。

## 使用

```sh
curl -X POST http://localhost:8000/tasks \
  -H 'Content-Type: application/json' \
  -d '{"message":"计算 12 除以 3"}'
```

提交响应包含 `task_id` 与 `conversation_id`。用任务 ID 轮询结果：

```sh
curl http://localhost:8000/tasks/<task_id>
```

继续多轮对话时，在下一次提交中带上原响应中的 `conversation_id`：

```json
{"message":"刚才的结果再加 4","conversation_id":"<conversation_id>"}
```

合同审阅请求示例：

```json
{"message":"请审阅以下合同：...","mode":"contract_review"}
```

## 测试

```sh
python -m unittest discover -s tests
```
