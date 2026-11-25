# LoopHarbor

**An asynchronous, multi-turn agent workspace** built with Celery, Redis, LangGraph, and PostgreSQL.

[中文](README.md) | English | [日本語](README.ja.md) | [Deutsch](README.de.md)

LoopHarbor is a runnable agent skeleton:

- FastAPI accepts requests and immediately returns a `task_id`.
- Redis provides the Celery broker and result backend.
- Celery workers run tasks in the background.
- LangGraph orchestrates agent nodes.
- PostgreSQL stores task state and LangGraph checkpoints.
- Clients query task status and results using `task_id`.

The agent uses an OpenAI-compatible Chat Completions API with tool calling for multi-turn chat or contract review. It can call arithmetic and worker-local date/time tools before continuing its response. Contract reviews are for reference only and are not legal advice.

The current web interface, system prompts, error messages, and memory summaries are in Chinese; these translations cover documentation only.

## GitHub Pages promotional site

A repository administrator must first select **GitHub Actions** under **Settings → Pages → Build and deployment → Source**. Otherwise, the deployment workflow can fail at `configure-pages` with `Not Found` because the Pages site does not exist. After configuring Pages, rerun the failed **Deploy GitHub Pages** workflow in Actions or run it manually. Subsequent pushes to `main` automatically deploy `site/`.

## 1. Requirements

- Python 3.12 (dependency installation has been verified; the pinned psycopg binary package does not support Python 3.14)
- Docker Desktop or Docker Engine
- Docker Compose

## 2. Start infrastructure

```bash
if [ ! -e .env ]; then cp .env.example .env; fi
docker compose up -d
```

Do not overwrite an existing `.env`; add any missing model settings from `.env.example` manually. Check the containers:

```bash
docker compose ps
```

## 3. Install Python dependencies

Python 3.12 is recommended. This creates a separate environment without overwriting an existing `.venv`:

```bash
python3.12 -m venv .venv-py312
source .venv-py312/bin/activate
python -m pip install -r requirements.txt
```

Edit `.env` and provide your model provider's endpoint, key, and model name:

```dotenv
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=your-api-key
LLM_MODEL=your-model-name
MEMORY_SUMMARIZE_EVERY_TURNS=5
```

`LLM_BASE_URL` is the API root, without `/chat/completions`. The provider must support OpenAI-compatible `tools` and `tool_calls`. Restart the worker after changing the configuration. An unconfigured model, failed request, or invalid response marks the task `FAILURE`; there is no local rules fallback. Each model request times out after 60 seconds. Each turn allows at most eight model calls and five tool calls per model call. Contract review requires a JSON object with a `risks` array of strings and a `report` string.

`MEMORY_SUMMARIZE_EVERY_TURNS` is a positive integer, defaulting to 5. After that many successful turns, the model merges the old summary and those turns into a new summary and clears the raw turns from the active context. The next turn uses the new summary. If summarization fails, the current task fails and the previously saved memory is retained.

Inputs are sent to the configured model provider. Check its privacy and data-use terms before submitting data, and never commit real keys.

Windows PowerShell:

```powershell
py -3.12 -m venv .venv-py312
.venv-py312\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

## 4. Start the API

From the project root:

```bash
uvicorn app.main:api --host 127.0.0.1 --port 8000
```

- Web workspace: http://127.0.0.1:8000/
- Swagger: http://127.0.0.1:8000/docs
- Health: http://127.0.0.1:8000/health

**Local use only:** the API and UI have no authentication. Any client that can reach the service can see all sessions and their contents. Do not bind to `0.0.0.0` or expose the service to a network; other local processes may still access it.

## 5. Start a Celery worker

Open another terminal and activate the same virtual environment. On macOS, single-process mode is recommended:

```bash
celery -A app.celery_app:celery_app worker --loglevel=INFO --pool=solo
```

`solo` runs one task at a time and does not support prefork-dependent soft and hard time limits. On Linux, multiprocess mode can be used:

```bash
celery -A app.celery_app:celery_app worker --loglevel=INFO --concurrency=2
```

If a macOS prefork worker reports `not enough values to unpack` in `fast_trace_task`, stop it and start the `solo` worker instead. The error can occur before the business task starts, leaving its business status `QUEUED` while Celery reports `FAILURE`. After confirming the task did not run, submit it again and query the new `task_id`.

### Using the web workspace

Start the API and worker, then open http://127.0.0.1:8000/. Select **新建会话** (new session), choose **通用问答** (chat) or **合同审查** (contract review), and send a message. Continue in the same session for follow-up turns. The left panel restores history; the right panel shows task status, memory summaries, and tool inputs and outputs. On narrow screens, open the right panel with **执行详情**. Tasks submitted to one session are queued in order.

For example, ask the agent to remember that you prefer concise answers, then ask what style you prefer. In contract mode, submit a clause and then ask about its risks. Reloading restores the last selected session. Sessions, tasks, tool events, and checkpoints are stored in PostgreSQL; model inputs and tool outputs can contain sensitive data. Celery redelivery can duplicate tool events.

The conversation supports Markdown headings, lists, quotes, tables, code blocks, and `$...$`, `$$...$$`, `\(...\)`, and `\[...\]` math. Copying a message copies its original text; code blocks have their own copy button. **查找与定位** searches messages or navigates by turn and heading. Messages and tool calls can be collapsed; a collapsed message keeps a first-line preview. Memory can also be expanded or collapsed. Hiding the session panel also hides the title bar; buttons to the left of the input reopen the session list or control the details panel. On narrow screens, the panels open as drawers.

Icons below the left side of each message copy its original text or collapse and expand it. Tool records represent persisted events, not the model's internal reasoning. Raw HTML is not executed, images are not automatically loaded, and external links open only when clicked.

The input starts as one line and expands as needed. Press Enter to send or Shift + Enter for a new line.

Rendering assets are bundled locally; running the workspace does not require Node.js or an external CDN. After changing frontend rendering dependencies or [`frontend/markdown.js`](frontend/markdown.js), regenerate them with `npm ci && npm run build:frontend`.

Restart the API and worker after updating project code; restart both after changing `.env` too. Queued tasks need a running worker.

## 6. Multi-turn agent requests

Start the API and worker. Each request must specify `mode`. Omit `thread_id` on the first request to create a session:

```bash
FIRST=$(curl -fsS -X POST http://localhost:8000/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "chat",
    "message": "Please remember that I prefer concise answers."
  }')
echo "$FIRST"
THREAD_ID=$(printf '%s' "$FIRST" | python -c 'import json,sys; print(json.load(sys.stdin)["thread_id"])')
TASK1=$(printf '%s' "$FIRST" | python -c 'import json,sys; print(json.load(sys.stdin)["task_id"])')
```

Use the returned `thread_id` for the next turn. It can be submitted immediately, without waiting for the first turn. Tasks in the same session run in database registration order; different sessions can run in parallel:

```bash
SECOND=$(curl -fsS -X POST http://localhost:8000/tasks \
  -H "Content-Type: application/json" \
  -d "{\"mode\":\"chat\",\"thread_id\":\"$THREAD_ID\",\"message\":\"What style of answer do I prefer?\"}")
echo "$SECOND"
TASK2=$(printf '%s' "$SECOND" | python -c 'import json,sys; print(json.load(sys.stdin)["task_id"])')
```

Query each turn, repeating as necessary until `SUCCESS` or `FAILURE`:

```bash
curl -fsS "http://localhost:8000/tasks/$TASK1"
curl -fsS "http://localhost:8000/tasks/$TASK2"
```

After a failed turn, later turns continue, but the failed turn is not added to memory. Task registration and queue delivery are not atomic. A crash between them can leave a `QUEUED` task stuck and block later turns in that session; manual investigation is required.

On success, the chat response is in `result_json.answer`. Reuse the `thread_id` for additional turns; each has its own `task_id`. Omitting `thread_id` on the first request creates a new session. A session's mode is fixed: an unknown `thread_id` returns 404, and changing mode returns 409.

Contract review also supports multiple turns. Start with `contract`:

```bash
FIRST=$(curl -fsS -X POST http://localhost:8000/tasks \
  -H "Content-Type: application/json" \
  -d '{"mode":"contract","message":"The buyer shall pay within 30 days after acceptance."}')
THREAD_ID=$(printf '%s' "$FIRST" | python -c 'import json,sys; print(json.load(sys.stdin)["thread_id"])')
TASK1=$(printf '%s' "$FIRST" | python -c 'import json,sys; print(json.load(sys.stdin)["task_id"])')
SECOND=$(curl -fsS -X POST http://localhost:8000/tasks \
  -H "Content-Type: application/json" \
  -d "{\"mode\":\"contract\",\"thread_id\":\"$THREAD_ID\",\"message\":\"What are the risks in the payment terms?\"}")
TASK2=$(printf '%s' "$SECOND" | python -c 'import json,sys; print(json.load(sys.stdin)["task_id"])')
curl -fsS "http://localhost:8000/tasks/$TASK1"
curl -fsS "http://localhost:8000/tasks/$TASK2"
```

Contract results are in `result_json.report` and `result_json.risks`. For chat, the compatibility field `result_json.report` contains the same answer and `result_json.risks` is an empty array. The legacy `contract_text` input can still replace `message`, but `mode` is required.

To inspect Celery's own status:

```bash
curl -fsS "http://localhost:8000/tasks/$TASK2/celery"
```

## 7. Architecture

| Component | Responsibility |
|---|---|
| FastAPI | Submit and query business tasks |
| Redis broker | Deliver pending task messages |
| Celery worker | Execute tasks in the background |
| Celery result backend | Store Celery state and return values |
| LangGraph | Orchestrate agent nodes |
| PostgreSQL business tables | Store sessions, submission order, task status, and results |
| PostgreSQL checkpointer | Store LangGraph checkpoints and active session memory |

`task_id`, `thread_id`, and `checkpoint_id` are different:

- `task_id`: one Celery background task.
- `thread_id`: LangGraph workflow state.
- `checkpoint_id`: one specific checkpoint.

Summarization replaces the active context sent to the model; it does not physically delete old checkpoints or original task inputs and results. A session ID is not authentication. Production requires authentication, tenant isolation, and a data-retention policy.

## 8. Production work

This is a minimal runnable skeleton and should not handle sensitive production data without further work. At minimum:

1. **Reliable delivery:** registration and Celery delivery are separate; consider a transactional outbox.
2. **Idempotency:** Celery can redeliver tasks. Use business idempotency keys and result reconciliation for side-effecting tools.
3. **Task state machine:** add retry counts, cancellation, leases/heartbeats, failure categories, and manual recovery.
4. **Progress:** add progress at LangGraph node boundaries or record node events through an event stream.
5. **Large files:** upload large PDFs or binary files to object storage and send only a URI through the queue.
6. **Security:** add authentication, tenant isolation, input validation, redaction, TLS, secret management, and audit logs.
7. **Monitoring:** monitor queue depth, worker health, duration, failures, and checkpoint storage.
8. **Timeouts:** configure external API timeouts, Celery soft/hard limits, and Redis visibility timeout; verify visibility and redelivery for long tasks.
9. **Database connections:** use a connection pool and configure limits, backups, and migrations.

## 9. Recovery semantics

A checkpoint stores persisted LangGraph workflow state, not a Python function's execution stack. A node that crashes before producing its next checkpoint may execute again during recovery. External side effects must be made idempotent.

This demo's graph nodes execute synchronously; the Celery worker runs the whole graph in the background. Fine-grained recovery requires appropriately divided LangGraph nodes with recoverable outputs and idempotent external operations.
