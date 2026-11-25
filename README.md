# LoopHarbor

**异步多轮 Agent 工作台** · 基于 Celery、Redis、LangGraph 和 PostgreSQL

中文 | [English](README.en.md) | [日本語](README.ja.md) | [Deutsch](README.de.md)

这是一个可运行的异步 Agent 工程骨架，演示：

- FastAPI 接收任务并立即返回 `task_id`
- Redis 作为 Celery Broker / Result Backend
- Celery Worker 在后台执行任务
- LangGraph 编排 Agent 节点
- PostgreSQL 保存业务任务状态和 LangGraph Checkpoint
- 用户通过 `task_id` 查询任务状态和结果

Agent 使用支持工具调用的 OpenAI 兼容 Chat Completions 接口进行多轮问答或合同审查。模型可以调用四则计算和 Worker 本地日期时间工具，再继续生成回答。合同审查结果仅供参考，不构成法律意见。

## GitHub Pages 宣传网站

仓库管理员需先在 **Settings → Pages → Build and deployment → Source** 中选择 **GitHub Actions**。否则部署工作流在 `configure-pages` 步骤中可能因 Pages 站点不存在而报 `Not Found`。设置完成后，在 Actions 中重新运行失败的 **Deploy GitHub Pages** 工作流，或手动运行该工作流。之后推送到 `main` 会自动部署 `site/`。

## 1. 环境要求

- Python 3.12（已验证依赖安装；当前锁定的 psycopg 二进制包不支持 Python 3.14）
- Docker Desktop / Docker Engine
- Docker Compose

## 2. 启动基础设施

```bash
if [ ! -e .env ]; then cp .env.example .env; fi
docker compose up -d
```

如果 `.env` 已存在，请勿覆盖它；将 `.env.example` 中缺少的模型配置项手动补入。

检查容器：

```bash
docker compose ps
```

## 3. 安装 Python 依赖

建议使用 Python 3.12 创建虚拟环境。以下命令使用独立目录，不会覆盖已有的 `.venv`：

```bash
python3.12 -m venv .venv-py312
source .venv-py312/bin/activate
python -m pip install -r requirements.txt
```

编辑 `.env`，填写模型服务商提供的地址、密钥和模型名，例如：

```dotenv
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=填写你的密钥
LLM_MODEL=填写你的模型名
MEMORY_SUMMARIZE_EVERY_TURNS=5
```

`LLM_BASE_URL` 是 API 根地址，不包含 `/chat/completions`；模型服务必须支持 OpenAI 格式的 `tools` 和 `tool_calls`。更改配置后需重启 Worker；模型未配置、请求失败或响应无效时，任务会标记为 `FAILURE`，不会回退到本地规则。每次模型请求超时为 60 秒，单轮最多执行 8 次模型调用，每次最多 5 个工具调用。合同审查要求模型能按提示返回包含 `risks` 字符串数组和 `report` 字符串的 JSON 对象。

`MEMORY_SUMMARIZE_EVERY_TURNS` 为正整数，默认 5。每完成指定数量的成功轮次后，模型将旧摘要和这些轮次合并成新摘要，并清空活跃上下文中的原始轮次；下一轮使用新摘要。摘要调用失败时当前任务失败，已保存的旧记忆不会被替换。

输入内容会发送至配置的模型服务商，提交前请确认数据使用和隐私要求；不要将真实密钥提交到版本控制。

Windows PowerShell：

```powershell
py -3.12 -m venv .venv-py312
.venv-py312\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

## 4. 启动 API

在项目根目录执行：

```bash
uvicorn app.main:api --host 127.0.0.1 --port 8000
```

打开：

- Web 工作台: http://127.0.0.1:8000/
- Swagger: http://127.0.0.1:8000/docs
- Health: http://127.0.0.1:8000/health

**仅供本机使用**：API 和界面没有登录鉴权，会话列表及其内容对能访问服务的客户端可见。不要使用 `0.0.0.0` 或将服务暴露到网络；本机其他进程仍可能访问它。

## 5. 启动 Celery Worker

另开一个终端，进入同一个虚拟环境。macOS 建议使用单进程模式：

```bash
celery -A app.celery_app:celery_app worker --loglevel=INFO --pool=solo
```

`solo` 同时只执行一个任务，且不支持依赖 prefork 的软、硬超时。Linux 可使用多进程模式：

```bash
celery -A app.celery_app:celery_app worker --loglevel=INFO --concurrency=2
```

如果 macOS 上的 prefork worker 报 `fast_trace_task` 的 `not enough values to unpack`，先停止该 worker，再使用上述 `solo` 命令启动。该错误可能发生在业务任务开始前，导致业务状态仍为 `QUEUED` 而 Celery 状态为 `FAILURE`；确认任务未执行后，可以重新提交任务并使用新的 `task_id` 查询。

### 使用 Web 工作台

启动 API 和 Worker 后，打开 http://127.0.0.1:8000/。点击「新建会话」，选择通用问答或合同审查并发送消息；继续在同一会话输入即可多轮追问。左侧可以恢复历史会话，右侧查看任务状态、记忆摘要和工具调用的输入与输出；窄屏通过「执行详情」查看右侧内容。同一会话提交的任务按顺序排队执行。

例如先发送「请记住，我喜欢简洁的回答」，再发送「我喜欢什么样的回答？」；合同模式可先发送条款，再追问条款风险。刷新页面会恢复上次选中的会话。会话、任务、工具调用记录及检查点保存在 PostgreSQL，模型输入和工具输出可能包含敏感内容；Celery 重投时工具事件可能重复。

对话区支持 Markdown 标题、列表、引用、表格和代码块，以及 `$...$`、`$$...$$`、`\(...\)`、`\[...\]` 数学公式；复制操作复制原始文本或代码。通过「查找与定位」可以按消息内容搜索并跳转，或按轮次、标题浏览；每条消息及工具调用可展开或折叠。工具记录仅反映已持久化事件，并非模型内部推理过程。原始 HTML 不执行，图片不会自动加载，外部链接仅在点击时打开。

每条消息左下方的图标可以复制原文或折叠、展开内容；折叠后保留首行预览。会话记忆可以展开或收起。收起左侧会话后，顶部标题栏也会隐藏；输入框左侧的按钮可以打开会话列表或操作详情面板。窄屏继续使用侧栏抽屉。

输入框默认单行，内容增多时自动扩展；Enter 发送，Shift + Enter 换行。

渲染资源已随项目提供，运行工作台不需要 Node.js 或外部 CDN。修改前端渲染依赖或 [`frontend/markdown.js`](frontend/markdown.js) 后，可执行 `npm ci && npm run build:frontend` 重新生成本地资源。

更新项目代码后需重启 API 和 Worker；修改 `.env` 后也应重启两者。显示为排队中的任务需要运行中的 Worker 才能执行。

## 6. 多轮 Agent 请求

先启动 API，再启动 Worker。每次请求都必须指定 `mode`；首次不传 `thread_id`，服务端创建新会话：

```bash
FIRST=$(curl -fsS -X POST http://localhost:8000/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "chat",
    "message": "请记住，我喜欢简洁的回答。"
  }')
echo "$FIRST"
THREAD_ID=$(printf '%s' "$FIRST" | python -c 'import json,sys; print(json.load(sys.stdin)["thread_id"])')
TASK1=$(printf '%s' "$FIRST" | python -c 'import json,sys; print(json.load(sys.stdin)["task_id"])')
```

使用返回的 `thread_id` 发起第二轮；可以立即提交，不必等待第一轮完成。同一会话的任务会按数据库中登记的顺序排队执行，不同会话可以并行：

```bash
SECOND=$(curl -fsS -X POST http://localhost:8000/tasks \
  -H "Content-Type: application/json" \
  -d "{\"mode\":\"chat\",\"thread_id\":\"$THREAD_ID\",\"message\":\"我喜欢什么样的回答？\"}")
echo "$SECOND"
TASK2=$(printf '%s' "$SECOND" | python -c 'import json,sys; print(json.load(sys.stdin)["task_id"])')
```

查询每一轮的状态，必要时重复查询直到 `SUCCESS` 或 `FAILURE`：

```bash
curl -fsS "http://localhost:8000/tasks/$TASK1"
curl -fsS "http://localhost:8000/tasks/$TASK2"
```

如果上一轮失败，下一轮会继续执行，但不会把失败轮次加入记忆。任务登记与投递目前不是原子操作；如果进程在两者之间异常退出，可能出现 `QUEUED` 任务滞留并阻塞同一会话后续轮次，需要人工排查。

任务完成后，问答结果位于 `result_json.answer`。可以继续使用同一 `thread_id` 提交更多轮；每轮都有独立的 `task_id`。首次不传 `thread_id` 就会创建新会话。会话模式固定，未知 `thread_id` 返回 404，切换模式返回 409。

合同审查也支持多轮，首次使用 `contract`：

```bash
FIRST=$(curl -fsS -X POST http://localhost:8000/tasks \
  -H "Content-Type: application/json" \
  -d '{"mode":"contract","message":"甲方应在验收合格后30日内付款。"}')
THREAD_ID=$(printf '%s' "$FIRST" | python -c 'import json,sys; print(json.load(sys.stdin)["thread_id"])')
TASK1=$(printf '%s' "$FIRST" | python -c 'import json,sys; print(json.load(sys.stdin)["task_id"])')
SECOND=$(curl -fsS -X POST http://localhost:8000/tasks \
  -H "Content-Type: application/json" \
  -d "{\"mode\":\"contract\",\"thread_id\":\"$THREAD_ID\",\"message\":\"付款条件有什么风险？\"}")
TASK2=$(printf '%s' "$SECOND" | python -c 'import json,sys; print(json.load(sys.stdin)["task_id"])')
curl -fsS "http://localhost:8000/tasks/$TASK1"
curl -fsS "http://localhost:8000/tasks/$TASK2"
```

合同审查结果位于 `result_json.report` 和 `result_json.risks`；问答的兼容字段 `result_json.report` 包含同一回答，`result_json.risks` 为空数组。旧输入字段 `contract_text` 仍可替代 `message`，但现在也必须提供 `mode`。

查看 Celery 自身状态：

```bash
curl -fsS "http://localhost:8000/tasks/$TASK2/celery"
```

## 7. 关键架构说明

| 组件 | 职责 |
|---|---|
| FastAPI | 提交任务、查询业务任务 |
| Redis Broker | 传递待执行任务消息 |
| Celery Worker | 后台执行任务 |
| Celery Result Backend | 保存 Celery 执行状态/返回值 |
| LangGraph | 编排 Agent 节点 |
| PostgreSQL 业务表 | 保存会话、提交顺序、任务状态和结果 |
| PostgreSQL Checkpointer | 保存 LangGraph 检查点和活跃会话记忆 |

`task_id`、`thread_id`、`checkpoint_id` 是不同概念：

- `task_id`：一次 Celery 后台任务的标识
- `thread_id`：LangGraph 工作流状态的标识
- `checkpoint_id`：某个具体检查点的标识

摘要替换的是发送给模型的活跃上下文，不会物理删除历史检查点或任务表中的原始输入和结果。会话 ID 不是身份验证机制；生产环境必须增加鉴权、租户隔离和数据保留策略。

## 8. 重要的生产环境改造

当前项目是可运行的最小工程骨架，不应未经改造直接承载生产敏感数据。

生产部署前至少要完成：

1. **可靠投递**：当前采用“先写业务表、再投递 Celery”的简化模式。高可靠场景建议使用 Transactional Outbox，避免数据库写入成功但队列投递失败造成任务滞留。
2. **幂等性**：Celery 任务可能重复投递/执行。对付款、审批、订单等有副作用的工具调用，必须使用业务幂等键和结果核对。
3. **任务状态机**：增加重试次数、取消状态、租约/心跳、失败分类和人工补偿。
4. **进度更新**：示例只展示了开始与完成阶段。生产环境应在 LangGraph 节点边界更新业务进度，或通过事件流记录节点事件。
5. **大文件处理**：不要把大型 PDF 或文件二进制直接塞进 Redis 消息。先上传对象存储，队列只传文件 URI。
6. **安全**：增加鉴权、租户隔离、输入校验、敏感信息脱敏、TLS、密钥管理和审计日志。
7. **监控**：增加 Celery 任务队列长度、Worker 存活、执行耗时、失败率和 Checkpoint 存储监控。
8. **超时**：合理设置外部 API 超时、Celery soft/hard time limit，以及 Redis visibility timeout；长任务要验证 broker 的消息可见性与重复投递行为。
9. **数据库连接**：生产环境应使用连接池并配置连接上限、备份和迁移策略。

## 9. 恢复语义提醒

Checkpoint 保存的是 LangGraph 已持久化的工作流状态，不是 Python 函数执行现场。若某个节点在产生新检查点之前崩溃，恢复时可能重新执行该节点。节点中的外部副作用必须自行实现幂等。

本 Demo 的图节点是同步执行的；Celery Worker 负责后台运行整个图。要实现细粒度恢复，需要将业务操作拆成合适的 LangGraph 节点，并确保节点输出和外部操作具备可恢复、可幂等的语义。
