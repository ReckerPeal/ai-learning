# 05 · LangGraph Server vs 自建 FastAPI

LangGraph 应用上生产，第一个问题：**用官方 langgraph-cli 起 LangGraph Server，还是自己写 FastAPI 把 graph 当库调用？** 两条路都能跑通，工程取舍差异很大。

本章把 [../langgraph/10-deployment.md](../langgraph/10-deployment.md) 已经介绍的部署形态深入展开：两种方案的协议、持久化、HITL、观测、可演进性、运维代价。

## 1. 两种方案的本质区别

| 维度 | LangGraph Server | 自建 FastAPI |
|---|---|---|
| 谁定义 HTTP 协议 | 官方（threads / runs / state） | 你自己 |
| graph 加载方式 | 通过 `langgraph.json` 注册 | Python 直接 import |
| 持久化 | 内置 Postgres / Redis（开箱即用） | 自己接 `AsyncPostgresSaver` |
| 流式 | 内置 SSE 协议（含 events / messages / values 多种模式） | 自己写 SSE |
| HITL | 内置 resume API | 自己实现 interrupt 协议 |
| LangGraph Studio | 自动可用 | 不支持（只 dev 时可临时连） |
| 可演进性 | 中（绑官方协议） | 高（爱怎么写怎么写） |
| 学习成本 | 中（要懂官方 API） | 低（FastAPI 是标准） |
| 与现有后端融合 | 难（额外服务） | 易（融进现有项目） |
| 多 graph 同集群 | 容易（一行配置） | 自己写路由 |
| 二进制依赖 | langgraph-cli + Docker | uvicorn + 你的依赖 |
| Cloud Run 部署难度 | 中（要起 Postgres / Redis） | 低 |
| 商业托管 | LangGraph Cloud 支持 | 不支持（要自己上 K8s/Cloud Run） |

## 2. 决策树

```
                                  ┌─ 是 → LangGraph Server / LangGraph Cloud
                                  │
   你的产品就是"agent + chat UI"？─┤
                                  │
                                  └─ 否（agent 是大产品里的一小块）
                                        │
                                        └→ 自建 FastAPI（融进现有 backend）

   还有几个加分项偏向 LangGraph Server：
       - 团队 < 5 人，不想自己写持久化 / 流式
       - 想用 LangGraph Studio 做协作调试
       - 多个 graph 在同一服务暴露
       - 走 LangGraph Cloud SaaS

   加分项偏向自建：
       - 现有后端是 FastAPI / Express，agent 只是一个 endpoint
       - 鉴权 / 计费 / 多租户逻辑复杂，要深度定制
       - 想避免 vendor 协议绑定
       - 不能上 Postgres / Redis（只有 SQLite / 内存）
```

## 3. LangGraph Server 路径

### 3.1 项目结构

```
my-agent/
├── langgraph.json
├── pyproject.toml
├── .env
└── src/
    └── my_agent/
        ├── __init__.py
        ├── graph.py            # 必须暴露顶层 `graph`
        ├── nodes.py
        └── tools.py
```

```json
// langgraph.json
{
  "dependencies": ["."],
  "graphs": {
    "agent": "./src/my_agent/graph.py:graph",
    "rag":   "./src/my_agent/rag_graph.py:graph"
  },
  "env": ".env",
  "python_version": "3.12",
  "image_distro": "wolfi"
}
```

```python
# src/my_agent/graph.py
from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.memory import MemorySaver   # dev 用，prod 由 server 注入
from .nodes import State, llm_node, tool_node

builder = StateGraph(State)
builder.add_node("llm", llm_node)
builder.add_node("tool", tool_node)
builder.add_edge(START, "llm")
builder.add_conditional_edges("llm", lambda s: "tool" if s["next"] else END)
builder.add_edge("tool", "llm")

graph = builder.compile()      # 不传 checkpointer，server 会注入
```

### 3.2 本地开发

```bash
pip install -U "langgraph-cli[inmem]"
langgraph dev
# 自动开 http://127.0.0.1:2024，自带 Studio UI
```

### 3.3 生产构建 / 部署

```bash
langgraph build -t agent:1.4.2

docker run -p 8123:8000 \
  -e REDIS_URI=redis://host.docker.internal:6379 \
  -e DATABASE_URI=postgresql://postgres:postgres@host.docker.internal:5432/lg \
  -e LANGSMITH_API_KEY=ls__... \
  agent:1.4.2
```

或直接 `langgraph up`（带 docker-compose 起 postgres + redis）。

### 3.4 自动得到的 API

| 路径 | 用途 |
|---|---|
| `POST /threads` | 建会话 |
| `POST /threads/{tid}/runs/stream` | 启动 + SSE 流式 |
| `GET /threads/{tid}/state` | 查 state |
| `POST /threads/{tid}/state` | 改 state |
| `POST /threads/{tid}/runs` | 启动并 resume（HITL） |
| `GET /assistants` | 列出注册的 graph（=assistant） |
| `POST /assistants` | 注册一个 graph 实例化（带不同 config） |
| `GET /threads/{tid}/history` | 时间旅行 |

业务前端可以直接对接这套 API，不用自己写 chat-history / state-save 那些逻辑。

### 3.5 自定义鉴权 / 中间件

LangGraph Server 暴露了 middleware 接口：

```python
# src/my_agent/auth.py
from langgraph_sdk.auth import Auth

auth = Auth()

@auth.authenticate
async def authenticate(authorization: str) -> dict:
    # 验证 JWT / API key，返回 user
    user = verify_token(authorization)
    return {"identity": user.id, "permissions": user.scopes}

@auth.on
async def add_owner(ctx, value):
    # 写入到 thread metadata，保证用户只看到自己的 thread
    metadata = value.setdefault("metadata", {})
    metadata["owner"] = ctx.user.identity
    return {"owner": ctx.user.identity}
```

```json
// langgraph.json 加一行
{
  "auth": { "path": "src/my_agent/auth.py:auth" }
}
```

## 4. 自建 FastAPI 路径

### 4.1 项目结构

```
my-agent/
├── pyproject.toml
├── Dockerfile
└── app/
    ├── api.py              # FastAPI routes
    ├── graph.py            # graph 定义
    ├── deps.py             # checkpointer / settings
    ├── auth.py
    └── streaming.py        # SSE helpers
```

### 4.2 关键代码骨架

```python
# app/deps.py
from contextlib import asynccontextmanager
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from .graph import build_graph

class AppState:
    graph = None
    checkpointer = None

state = AppState()

@asynccontextmanager
async def lifespan(app):
    async with AsyncPostgresSaver.from_conn_string(settings.DB_URI) as cp:
        await cp.setup()
        state.checkpointer = cp
        state.graph = build_graph(cp)
        yield
```

```python
# app/api.py
from fastapi import FastAPI, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
import json, uuid
from .deps import lifespan, state
from .auth import get_user

api = FastAPI(lifespan=lifespan)

@api.post("/threads")
async def create_thread(user=Depends(get_user)):
    tid = f"t-{uuid.uuid4().hex[:8]}"
    return {"thread_id": tid, "owner": user.id}

@api.post("/threads/{tid}/run")
async def run_thread(tid: str, payload: dict, user=Depends(get_user)):
    # 校验 thread 属于该用户（thread_id 服务端派生）
    if not await user_owns_thread(user.id, tid):
        raise HTTPException(403)

    cfg = {"configurable": {"thread_id": tid, "user_id": user.id}}
    msg = payload["message"]

    async def gen():
        async for chunk, meta in state.graph.astream(
            {"messages": [{"role": "user", "content": msg}]},
            cfg,
            stream_mode="messages",
        ):
            data = json.dumps({"content": chunk.content, "meta": meta})
            yield f"data: {data}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",      # nginx 上层提示别 buffer
        },
    )

@api.post("/threads/{tid}/resume")
async def resume_thread(tid: str, payload: dict, user=Depends(get_user)):
    """HITL：用户审批后继续。"""
    cfg = {"configurable": {"thread_id": tid}}
    # Command(resume=...) 是 langgraph 0.2+ 的 API
    from langgraph.types import Command
    result = await state.graph.ainvoke(Command(resume=payload["approval"]), cfg)
    return result

@api.get("/threads/{tid}/state")
async def get_state(tid: str, user=Depends(get_user)):
    cfg = {"configurable": {"thread_id": tid}}
    snap = await state.graph.aget_state(cfg)
    return {
        "values": snap.values,
        "next": list(snap.next),
        "tasks": [t.name for t in snap.tasks],
    }
```

### 4.3 Dockerfile

跟 [02 章](./02-docker.md) 完全一致，没特殊点。

### 4.4 Stream modes 的取舍

LangGraph 的 `astream(stream_mode=...)`：

| mode | 内容 | 适合 |
|---|---|---|
| `values` | 每次 state 全量 | 调试 |
| `updates` | 每个节点的变更 diff | 监控 |
| `messages` | token 级 stream | **chat UI 唯一选择** |
| `events` | LangChain events（最细） | 高级 UI |
| `custom` | 节点内 `dispatch_custom_event` | 自定义事件 |

生产 chat UI 通常 `messages` + 自家协议；高级场景多通道 `[messages, custom]`。

## 5. 持久化对比

| 选项 | LangGraph Server | 自建 FastAPI |
|---|---|---|
| Postgres | 自动（启动时建表） | `AsyncPostgresSaver.from_conn_string` + `await cp.setup()` |
| Redis | 自动（缓存） | 自己装 `langgraph-checkpoint-redis` |
| Sqlite | dev only | `AsyncSqliteSaver` |
| Memory | dev only | `MemorySaver` |

Server 路径强依赖 Postgres + Redis，"dev only" 模式就是 inmem，灵活度低但**省得自己装**。

## 6. HITL 流程对比

```
LangGraph Server：
  1. 前端 POST /threads/{tid}/runs/stream
  2. Server 推送 SSE 直到 interrupt
  3. 前端展示审批 UI
  4. 用户批准
  5. 前端 POST /threads/{tid}/runs (with command={resume: "..."})
  6. Server 继续推 SSE

自建 FastAPI：
  1. 前端 POST /threads/{tid}/run
  2. 你 stream，遇到 interrupt 时 yield 特定 event
  3. 前端展示审批
  4. 前端 POST /threads/{tid}/resume
  5. 你用 Command(resume=...) 继续 ainvoke
```

逻辑一样，自建版本你完全控制协议，但要自己定义 interrupt 在 SSE 里如何编码。

## 7. 多 graph / 多版本

### LangGraph Server

```json
{
  "graphs": {
    "agent-v1": "./src/my_agent/graph_v1.py:graph",
    "agent-v2": "./src/my_agent/graph_v2.py:graph",
    "rag": "./src/my_agent/rag.py:graph"
  }
}
```

API 用 `assistant_id` 区分调用哪个 graph。灰度时直接前端切 ID 即可（见 §10）。

### 自建 FastAPI

```python
GRAPHS = {
    "agent-v1": build_v1_graph(cp),
    "agent-v2": build_v2_graph(cp),
}

@api.post("/threads/{tid}/run")
async def run(tid, payload, user=Depends(get_user)):
    graph_id = payload.get("graph", "agent-v1")
    g = GRAPHS.get(graph_id)
    ...
```

工作量差不多。

## 8. 观测对比

| 维度 | LangGraph Server | 自建 FastAPI |
|---|---|---|
| LangSmith trace | 自动（同 LANGCHAIN env vars） | 自动（同上） |
| Studio 调试 | ✅ 内置 | ❌（只 dev 时连） |
| Prometheus 指标 | 部分内置 + 可扩展 | 自己加 `prometheus-fastapi-instrumentator` |
| Trace（OTel） | 通过 callbacks 接 | 同样 |

LangGraph Studio 是大杀器：可视化 graph 执行、时间旅行、修改 state 重跑，**对没经验的产品/PM 也能用**。这是自建 FastAPI 比不了的。

## 9. 性能与扩缩

两者性能基本一致（都是 ASGI + asyncio）。差异在：

- LangGraph Server 自动管 Postgres 连接池
- 自建 FastAPI 要自己写 asyncpg pool 大小，但更可控

水平扩缩都靠 k8s HPA，与 LangGraph 框架无关。

## 10. 选型示例

### 10.1 创业 chat 产品（用 LangGraph Server）

- 团队 3 人，要快
- 产品就是 chat agent，没别的
- 接 LangGraph Cloud 全托管，一键扩缩
- Studio 给 PM 调 prompt
- LangSmith trace 全闭环

### 10.2 既有 SaaS 加 agent 功能（用自建 FastAPI）

- 后端已经是 FastAPI / Django
- agent 是某个功能模块的一部分
- 鉴权、计费、多租户已经在主系统
- 不想多一个独立服务运维

### 10.3 平台型公司（混合）

- 内部多个团队用 LangGraph
- 平台组提供"LangGraph Server 基础镜像 + 公共中间件"
- 各业务团队按 `langgraph.json` 部署自己的 graph
- 平台层做鉴权、限流、监控统一

## 11. 迁移路径

**自建 FastAPI → LangGraph Server**：

中等工作量。主要是把现有 endpoint 改用 server 提供的协议。前端如果按 server 协议写过则平滑。

**LangGraph Server → 自建 FastAPI**：

简单。把 graph.py 拷出来，自己包 endpoint。Server 协议如果业务已依赖，要兼容实现。

**两者并存**：

完全可以。LangGraph Server 跑专门的 agent 服务，自建 FastAPI 跑业务 API，前端调两个域名。

## 12. 一个真实选型对话

> Q: 我们 5 人小队，准备做企业知识库 chat 产品，3 个月上线，怎么选？
>
> A: LangGraph Server + LangGraph Cloud。理由：
>
> 1. Studio 让 PM/客服自己调 prompt，省你时间
> 2. threads/state/HITL API 不用造轮子
> 3. Cloud 自动扩缩、Postgres/Redis 托管，运维 0
> 4. trace 跟 LangSmith 闭环
> 5. 月成本 < $500，比自己运维 EKS 便宜
>
> 唯一缺点：vendor 绑定，但**这阶段先活下来比 lock-in 重要**。

> Q: 我们已有 100 人 Django 后端，想加 agent，怎么选？
>
> A: 自建 FastAPI（或 Django + langgraph 库直接调）。理由：
>
> 1. 现有鉴权、计费、用户体系都在 Django
> 2. 不想多一个独立服务
> 3. 部署、监控走公司既有 K8s 流程
> 4. LangGraph 当库用，不引入新协议

## 常见坑

1. **直接把 dev `langgraph dev` 当生产用**——inmem 模式没持久化，重启数据全丢。生产必须 `langgraph build` + 接 Postgres。
2. **LangGraph Server 的 thread_id 让前端生成**——绕过鉴权，用户能看别人的 thread。**永远服务端派生**。
3. **自建 FastAPI 忘了 `await checkpointer.setup()`**——首次启动表没建，第一次 invoke 报错。lifespan 里务必跑。
4. **流式响应没设 `X-Accel-Buffering: no`**——Nginx Ingress 上面可能还有 nginx 反代，buffer 没关。这个 header 是流式的"祖宗"。
5. **LangGraph Server Studio 在生产域名暴露**——内部调试 UI 上公网，prompt 内容、state 全曝光。Studio 仅 dev 用。
6. **自建版本忘了限并发**——一个用户开多个 tab，单 thread 多请求并发，LangGraph 可能因为 checkpoint 写入冲突而失败。加 per-thread 锁或前端排队。
7. **graph 全局变量持有 LLM client 但未线程安全**——大多数 SDK 是协程安全的，但自家工具未必。
8. **没区分 `messages` 和 `updates` stream mode**——chat UI 用 `updates` 拿不到 token-level 流式。
9. **Server 镜像默认带的依赖太重**——`image_distro: "wolfi"` 比 debian 小，构建 Dockerfile 主动指定。

## 下一步

- 流式协议细节（SSE / WebSocket） → [06 · 流式服务部署](./06-streaming.md)
- 把 server / 自建 都接到监控 → [07 · 监控与指标](./07-monitoring.md)
- trace 与 LangSmith / Langfuse → [08 · 日志与 Trace](./08-logging-tracing.md)
- 灰度多 graph 版本 → [10 · CI/CD 与版本灰度](./10-cicd.md)
- LangGraph 基础部署 → [../langgraph/10-deployment.md](../langgraph/10-deployment.md)
- LangGraph Cloud → <https://langchain-ai.github.io/langgraph/cloud/>
- LangGraph 鉴权 SDK → <https://langchain-ai.github.io/langgraph/concepts/auth/>
