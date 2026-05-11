# 10 · 部署

把 LangGraph 应用从 notebook 推到生产，主要解决四件事：**怎么暴露服务、怎么持久化、怎么观测、怎么扩容**。

## 1. 三种部署形态

| 形态 | 说明 | 适用 |
|---|---|---|
| **自托管 + 自封 API** | 自己写 FastAPI 等服务，把 graph 当库用 | 最大灵活度；和现有后端融合 |
| **LangGraph Server（自托管）** | 用 `langgraph-cli` 跑官方服务（OSS） | 想用官方协议但不想上云 |
| **LangGraph Platform / Cloud** | 官方托管 SaaS | 不想运维，要 UI / Studio / 自动扩容 |

下面分别讲。

## 2. 形态一：自封 FastAPI

最常见、最自由。

### 2.1 项目结构

```
my-agent/
├── pyproject.toml
├── app/
│   ├── graph.py          # 图定义 + compile()
│   ├── api.py            # FastAPI 路由
│   └── deps.py           # checkpointer / store / llm 依赖
└── Dockerfile
```

### 2.2 关键代码骨架

```python
# graph.py
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.graph import StateGraph, START, END
...

async def build_app(checkpointer):
    graph = StateGraph(State)
    ...
    return graph.compile(checkpointer=checkpointer)
```

```python
# api.py
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.responses import StreamingResponse

@asynccontextmanager
async def lifespan(app: FastAPI):
    async with AsyncPostgresSaver.from_conn_string(DB_URI) as cp:
        await cp.setup()
        app.state.graph = await build_app(cp)
        yield

api = FastAPI(lifespan=lifespan)

@api.post("/chat")
async def chat(thread_id: str, message: str):
    cfg = {"configurable": {"thread_id": thread_id}}
    async def gen():
        async for token, meta in api.state.graph.astream(
            {"messages": [HumanMessage(message)]}, cfg, stream_mode="messages",
        ):
            yield f"data: {token.content}\n\n"
    return StreamingResponse(gen(), media_type="text/event-stream")
```

### 2.3 Dockerfile

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN pip install uv && uv sync --frozen
COPY app/ ./app/
CMD ["uvicorn", "app.api:api", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
```

## 3. 形态二：LangGraph Server（自托管 OSS）

LangChain 提供了一个 OSS 服务器，能直接把图变成标准 REST API（threads / runs / state / streaming 全套）。

### 3.1 项目布局

```
my-agent/
├── langgraph.json        # 声明哪些图被暴露
├── pyproject.toml
└── src/
    └── my_agent/
        └── graph.py      # 必须暴露顶层 `graph` 变量
```

```json
// langgraph.json
{
  "dependencies": ["."],
  "graphs": {
    "my-agent": "./src/my_agent/graph.py:graph"
  },
  "env": ".env"
}
```

### 3.2 本地跑

```bash
pip install -U "langgraph-cli[inmem]"
langgraph dev      # 本地内存模式，零配置
# 打开 http://127.0.0.1:2024，自带 LangGraph Studio UI
```

### 3.3 生产

```bash
langgraph build -t my-agent:latest    # 打 docker 镜像
langgraph up                          # docker compose 起 server + postgres + redis
```

得到的 API 包括：
- `POST /threads` 建 thread
- `POST /threads/{id}/runs/stream` 启动并流式
- `GET  /threads/{id}/state` 查 state
- `POST /threads/{id}/state` 改 state
- HITL：`POST /threads/{id}/runs` with `command={"resume": ...}`

可以直接给前端用，不用自己写 API。

## 4. 形态三：LangGraph Platform / Cloud

官方托管，最省事：

- 把项目推 GitHub
- 在 LangSmith 控制台连仓库
- 自动 build / deploy / 扩容
- 自带 Studio（图可视化、对话调试、时间旅行 UI）
- 自带 Postgres + Redis
- 与 LangSmith trace 深度集成

成本：付费 SaaS。适合"不想运维 + 团队需要协作 UI"的场景。

## 5. 持久化选型

| 场景 | 选型 |
|---|---|
| 开发 / demo | `MemorySaver` |
| 单机小项目 | `SqliteSaver`（异步：`AsyncSqliteSaver`） |
| 生产 | `AsyncPostgresSaver`（推荐） |
| 已有 Redis | 社区 `langgraph-checkpoint-redis` |

跨会话长记忆走 **Store**（第 06 章），生产用 `PostgresStore`。

### 5.1 数据量管理

- 老 thread 的 checkpoint 不会自动清理——上线前规划清理策略（按 TTL / 按用户配额）
- 大 state 字段（文档全文、向量）放外部存储，state 里只放 key
- Postgres 用专门 schema（如 `langgraph`），便于备份和监控

## 6. 配置外部化

把会变的参数从 state 中分出来，用 `RunnableConfig.configurable`：

```python
def chat(state, config):
    cfg = config["configurable"]
    user_id = cfg["user_id"]
    persona = cfg.get("persona", "default")
    ...

app.invoke(state, config={
    "configurable": {
        "thread_id": "abc",
        "user_id": "u-123",
        "persona": "vip",
    }
})
```

好处：同一份图，按 config 出多种行为；checkpoint 也会带上这些 metadata 便于审计。

## 7. 观测：必装 LangSmith

```bash
export LANGCHAIN_TRACING_V2=true
export LANGCHAIN_API_KEY=ls__...
export LANGCHAIN_PROJECT=my-agent-prod
```

每次 `invoke` 都会上报一条 trace，包含：
- 整张图的执行树（节点 / LLM / tool 调用）
- 每个 LLM 的 prompt / completion / token 用量
- 每个 tool 的输入输出
- 错误堆栈
- 端到端延迟

调试 Agent 几乎离不开它。也可以接 OpenTelemetry 到自家可观测系统。

## 8. 性能与成本

### 8.1 模型路由

不是每个节点都需要顶级模型：
- supervisor / router → haiku / mini 级别
- 主要推理 → sonnet / 4o
- 工具调用 → 看复杂度

```python
small_llm = ChatOpenAI(model="gpt-4o-mini")
big_llm   = ChatOpenAI(model="gpt-4o")

def supervisor(state):
    return {"next": small_llm.with_structured_output(Route).invoke(...)}

def reasoner(state):
    return {"messages": [big_llm.invoke(...)]}
```

### 8.2 Prompt caching

Anthropic / OpenAI 都支持 prompt cache。把**长且稳定的 system prompt** 放最前面，开启 cache：

```python
SystemMessage(content=long_system, additional_kwargs={"cache_control": {"type": "ephemeral"}})
```

Agent 多轮循环时，每轮重发整段 messages，cache 命中能省 50%+ 输入 token。

### 8.3 并发

- Python：`uvicorn --workers N` 多进程；图内部多用 `async`
- 数据库：Postgres 连接池足够（asyncpg + 池大小 = 进程数 × 几）
- 上限保护：`recursion_limit`、超时、单 thread QPS 限制

### 8.4 流式必开

流式不止是体验问题——长任务里**不流式 = 长 HTTP 连接超时**。生产几乎一定要 SSE / WebSocket。

## 9. 安全

| 风险 | 对策 |
|---|---|
| 用户串话 | `thread_id` 必须按用户/会话隔离，**永不来自客户端**（用 server 侧 user_id 派生） |
| Prompt 注入工具 | 高危工具走 HITL；工具内做参数校验；用最小权限的服务账户 |
| 长 messages 爆 token | 在 agent 节点前加 trim 节点，按 token 预算裁剪 |
| 密钥 | 走环境变量 / KMS，不要进 state（state 会被 checkpoint 持久化） |
| Store 跨用户串数据 | Store key 第一段必须是 `user_id` 或租户 ID |

## 10. 上线 checklist

- [ ] 换掉 `MemorySaver` → 持久化 checkpointer，调通 `setup()`
- [ ] `thread_id` 服务端派生，不可被客户端伪造
- [ ] 接入 LangSmith trace（或自家可观测）
- [ ] 配置 `recursion_limit`、超时、单租户限流
- [ ] 高危工具加 HITL（第 07 章）
- [ ] 流式接口走 SSE / WebSocket
- [ ] 大字段不进 state；老 checkpoint 有清理策略
- [ ] 错误路径：LLM 超时、工具异常、外部依赖挂掉，都能优雅降级
- [ ] e2e 测试：覆盖中断/恢复、多轮对话、并行节点、子图

## 11. 进一步阅读

- 官方 deployment 文档：https://langchain-ai.github.io/langgraph/cloud/
- LangGraph CLI：https://github.com/langchain-ai/langgraph/tree/main/libs/cli
- LangSmith：https://docs.smith.langchain.com/
- 例子仓库：https://github.com/langchain-ai/langgraph/tree/main/examples
