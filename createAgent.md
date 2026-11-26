# 如何用 Celery + Redis 搭建一个异步 Agent？

**建议时长：7～9 分钟**

## 开场：让 Agent 执行十分钟，用户凭什么等十分钟？

上一期我们讲了一个问题：

为什么 Agent 不能一直依赖 HTTP 请求执行任务？

因为 Agent 可能需要调用大模型、查询外部系统、解析文件，整个任务可能持续几分钟，甚至几十分钟。

如果用户提交请求之后，服务器一直等待 Agent 执行完成，就会遇到请求超时、连接断开、重复提交等问题。

那么，真正的解决办法是什么？

答案是：异步任务架构。

今天我们不只讲概念，直接搭建一个可以运行的 Agent 系统。

我们使用四个核心技术：

FastAPI、Celery、Redis 和 LangGraph。

最终实现一个功能：

用户提交一份合同，系统立即返回任务编号，后台 Agent 自动分析合同。用户可以关闭网页，过一会儿再回来查询任务进度和最终报告。

## 第一部分：先看我们要搭建什么

先假设一个真实场景。

用户上传一份合同，Agent 需要完成三个步骤：

第一，解析合同内容。

第二，分析合同风险。

第三，生成审查报告。

整个过程可能需要十分钟。

我们不再让 HTTP 请求一直等待，而是把整个过程拆成几个角色。

第一个角色：FastAPI。

它负责接收用户请求，生成任务 ID，然后把任务交出去。

第二个角色：Redis。

它就像一个任务收发站，暂存等待执行的任务消息。

第三个角色：Celery Worker。

它负责从 Redis 获取任务，真正执行后台工作。

第四个角色：LangGraph。

它负责组织 Agent 的执行流程，让解析、分析和报告生成按照设定的步骤运行。

另外，我们还需要 PostgreSQL。

它负责保存业务任务状态，以及 LangGraph 的 Checkpoint。

所以，整个架构就是：

用户提交任务，FastAPI 接收请求，Celery 把任务交给 Redis，Worker 从 Redis 领取任务，再调用 LangGraph 执行 Agent。

任务完成之后，结果写入数据库，用户通过任务 ID 查询。

这就是今天要搭建的系统。

## 第二部分：为什么需要 Celery？

先解释一个概念。

Celery 是什么？

你可以把它理解成一个后台任务管理系统。

它负责把任务发送出去，再由后台 Worker 领取和执行。

比如用户提交了一份合同。

FastAPI 不需要自己解析合同，也不需要自己调用大模型。

它只需要告诉 Celery：

这里有一个任务，请安排后台 Worker 执行。

Celery 接收到任务之后，会把任务消息交给 Broker。

今天我们使用 Redis 作为 Broker。

Redis 负责传递任务消息，Celery Worker 负责领取和执行。

这里要记住：

**Celery 不是大模型，也不是 Agent，它负责管理后台任务的执行。**

## 第三部分：第一步，启动 Redis

我们先启动 Redis。

本地开发可以使用 Docker：

```bash
docker run -d \
  --name agent-redis \
  -p 6379:6379 \
  redis:7
```

Redis 启动之后，就有了一个任务消息中转站。

接下来安装 Python 依赖：

```bash
pip install -r requirements.txt
```

项目里包含 FastAPI、Celery、Redis 客户端和 LangGraph。

## 第四部分：第二步，创建 Celery 应用

我们先看一段核心代码：

```python
from celery import Celery

celery_app = Celery(
    "async_agent",
    broker="redis://localhost:6379/0",
    backend="redis://localhost:6379/1"
)
```

这里有两个 Redis 地址。

第一个，0 号数据库，作为 Broker。

它负责传递任务消息。

第二个，1 号数据库，作为 Result Backend。

它负责保存 Celery 的任务执行状态和返回结果。

注意，这两个功能并不一样。

Broker 负责把任务交给 Worker。

Result Backend 负责保存 Celery 的执行结果。

它们都可以使用 Redis，但职责不同。

## 第五部分：第三步，创建 Agent 工作流

现在我们开始创建 Agent。

假设这是一个合同审查 Agent。

我们使用 LangGraph，把工作拆成三个节点：

合同解析、风险分析、生成报告。

每个节点负责一个明确的工作。

合同解析节点读取文本。

风险分析节点识别合同中的付款、违约、解除等风险点。

报告节点把分析结果整理成最终报告。

这里的重点不是合同审查算法有多复杂，而是：

**Agent 的工作流由 LangGraph 管理，后台执行由 Celery 管理。**

它们不是一个东西。

## 第六部分：第四步，让 Celery Worker 执行 Agent

现在把两套系统连接起来。

我们创建一个 Celery 任务：

```python
@celery_app.task(bind=True)
def run_agent(self, task_id, thread_id, contract_text):

    config = {
        "configurable": {
            "thread_id": thread_id
        }
    }

    result = graph.invoke(
        {"contract_text": contract_text},
        config=config
    )

    return result
```

这段代码非常关键。

Celery Worker 领取任务之后，调用 LangGraph。

LangGraph 按照工作流执行合同解析、风险分析和报告生成。

这里传入了一个 thread_id。

它用来标识这条 LangGraph 工作流。

如果我们配置了 PostgreSQL Checkpointer，LangGraph 就可以持久化保存工作流状态。

注意：

Celery 的 task_id 和 LangGraph 的 thread_id 不是一个概念。

task_id 标识一次后台任务。

thread_id 标识一条 LangGraph 工作流。

Checkpoint ID 则标识这条工作流中的某个具体检查点。

三个 ID 不要混用。

## 第七部分：第五步，让 HTTP 立即返回任务编号

现在是最关键的变化。

以前的同步模式是：

用户提交请求，服务器执行 Agent，执行完成后再返回结果。

现在我们改成异步模式。

FastAPI 只需要做一件事：

```python
task = run_agent.delay(
    task_id,
    thread_id,
    contract_text
)

return {
    "task_id": task.id,
    "status": "QUEUED"
}
```

`.delay()` 就是把任务发送给 Celery。

任务进入队列之后，API 就可以立即返回。

例如：

```json
{
  "task_id": "abc123",
  "status": "QUEUED"
}
```

用户不需要等待十分钟。

他只需要保存这个任务编号。

之后再通过任务编号查询任务状态。

这就是异步任务最重要的价值：

**提交任务和执行任务彻底分开了。**

## 第八部分：启动系统，看看它怎么运行

现在我们启动三个服务。

第一，Redis。

第二，Celery Worker。

第三，FastAPI。

启动 Worker：

```bash
celery -A app.celery_app:celery_app \
  worker --loglevel=INFO --concurrency=2
```

启动 API：

```bash
uvicorn app.main:api \
  --host 0.0.0.0 --port 8000
```

打开接口文档：

```text
http://localhost:8000/docs
```

提交一份合同。

API 立即返回 task_id。

此时你可以观察 Worker 的终端。

它会从 Redis 获取任务，开始执行 Agent。

合同解析完成。

风险分析完成。

报告生成完成。

最后，任务状态变成 SUCCESS。

用户通过任务 ID 查询，就可以拿到最终报告。

到这里，一个完整的异步 Agent 就跑起来了。

## 第九部分：真正进入生产环境，还要解决什么？

这里必须提醒大家：

能够跑通 Demo，不代表已经具备生产级可靠性。

至少还有五件事需要考虑。

第一，任务重复执行。

Worker 可能在执行成功、但还没有确认消息之前崩溃。

任务重新投递后，就可能再次执行。

所以涉及订单、审批、付款等操作，必须设计幂等机制。

第二，任务状态持久化。

不要只依赖 Redis 保存业务状态。

建议把任务编号、用户、执行状态、错误信息和最终结果保存到业务数据库。

第三，Checkpoint。

Celery 负责后台任务调度，LangGraph Checkpointer 负责保存 Agent 工作流状态。

如果 Worker 重启，需要结合持久化 Checkpoint 和任务恢复逻辑，才能恢复执行。

第四，大文件处理。

如果用户上传几百兆的 PDF，不要直接把文件内容放进 Redis 消息。

应该先把文件上传到对象存储，队列里只传文件地址和任务参数。

第五，监控和超时。

需要关注 Worker 是否存活、队列是否积压、任务执行时间是否过长，以及外部模型和工具调用是否超时。

这些才是系统真正进入企业业务时需要解决的问题。

## 结尾：Agent 不只是会思考，还要能持续执行

现在我们把整个系统总结一下：

FastAPI 负责接收任务。

Celery 负责后台调度。

Redis 负责任务消息传递。

Worker 负责真正执行。

LangGraph 负责 Agent 工作流。

PostgreSQL 负责保存业务状态和工作流 Checkpoint。

每个组件各司其职。

记住一句话：

**FastAPI 负责把任务交出去，Celery 负责安排谁来干活，LangGraph 负责 Agent 怎么干活。**

这才是从一个简单的 Agent Demo，走向真正异步执行系统的关键一步。
