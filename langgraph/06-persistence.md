# 06 · 持久化与 Checkpoint

LangGraph 的 **Checkpointer** 让图变成"可暂停、可恢复、可回放"的——这是它最有价值的能力之一。一旦挂上 checkpointer，你免费获得：

- 多轮对话记忆（不用自己写 memory）
- 中断后恢复（崩溃、人工审批、长任务）
- 时间旅行（回到任意一步重跑）
- 完整审计轨迹

## 1. 心智模型

每次执行**超步**后，LangGraph 自动把整张图的 state **快照**写入 checkpointer。每个快照有：

- `thread_id`：会话/任务 ID（你定）
- `checkpoint_id`：自动生成，每步一个
- `state`：那一刻的完整 state
- `next`：下一步要执行的节点
- `metadata`：步骤号、源节点、自定义 metadata

**Thread ≈ 一段对话/一次任务**。同一个 `thread_id` 多次 invoke，state 会累积；不同 `thread_id` 之间互不影响。

## 2. 最简用法：内存 checkpointer

```python
from langgraph.checkpoint.memory import MemorySaver

checkpointer = MemorySaver()
app = graph.compile(checkpointer=checkpointer)

config = {"configurable": {"thread_id": "user-123"}}

# 第一轮
app.invoke({"messages": [HumanMessage("我叫小王")]}, config=config)

# 第二轮：state 自动从 checkpointer 恢复
app.invoke({"messages": [HumanMessage("我叫什么？")]}, config=config)
# → AI 能回答"小王"，因为整段对话都在 thread "user-123" 里
```

⚠️ `MemorySaver` 仅存进程内存，**重启即失**。生产用持久化版本（见下一节）。

## 3. 生产级 checkpointer

### 3.1 SQLite（单机/小项目）

```python
from langgraph.checkpoint.sqlite import SqliteSaver

with SqliteSaver.from_conn_string("checkpoints.db") as checkpointer:
    app = graph.compile(checkpointer=checkpointer)
    ...

# 异步版：langgraph.checkpoint.sqlite.aio.AsyncSqliteSaver
```

### 3.2 PostgreSQL（推荐生产用）

```python
# pip install langgraph-checkpoint-postgres
from langgraph.checkpoint.postgres import PostgresSaver

DB_URI = "postgresql://user:pass@localhost/db"
with PostgresSaver.from_conn_string(DB_URI) as checkpointer:
    checkpointer.setup()   # 首次建表
    app = graph.compile(checkpointer=checkpointer)
    ...

# 异步：AsyncPostgresSaver
```

### 3.3 Redis / 其他

社区有 `langgraph-checkpoint-redis`、MongoDB 等实现；自定义只要继承 `BaseCheckpointSaver` 实现几个方法即可。

## 4. 操作 checkpoint

### 4.1 取当前 state

```python
config = {"configurable": {"thread_id": "user-123"}}
snapshot = app.get_state(config)
print(snapshot.values)        # 当前完整 state
print(snapshot.next)          # 下一步要跑的节点（中断时有用）
print(snapshot.config)        # 含 checkpoint_id
```

### 4.2 列出历史快照

```python
for s in app.get_state_history(config):
    print(s.metadata["step"], s.next, s.values)
```

### 4.3 时间旅行：回到某一步

```python
target_config = {
    "configurable": {
        "thread_id": "user-123",
        "checkpoint_id": "<某个历史 checkpoint_id>",
    }
}
# 从该快照继续执行，可传新输入或不传
app.invoke(None, config=target_config)
```

会**fork** 出一条新分支：原历史保留，新执行接在那个 checkpoint 之后。

### 4.4 手工修改 state

```python
app.update_state(
    config,
    {"messages": [SystemMessage("（管理员注入：用户已升级 VIP）")]},
    as_node="admin",   # 可选：模拟"由 admin 节点产生的更新"
)
```

reducer 会按字段合并你给的 patch。这是 Human-in-the-Loop 的基础（见第 07 章）。

## 5. 多轮对话的最小完整示例

```python
from langchain_core.messages import HumanMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages
from langgraph.checkpoint.memory import MemorySaver
from typing import TypedDict, Annotated
from langchain_core.messages import BaseMessage

class State(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]

llm = ChatOpenAI(model="gpt-4o-mini")

def chat(state):
    return {"messages": [llm.invoke(state["messages"])]}

graph = StateGraph(State)
graph.add_node("chat", chat)
graph.add_edge(START, "chat")
graph.add_edge("chat", END)

app = graph.compile(checkpointer=MemorySaver())

cfg = {"configurable": {"thread_id": "demo"}}
print(app.invoke({"messages": [HumanMessage("我叫小王，记住。")]}, cfg)["messages"][-1].content)
print(app.invoke({"messages": [HumanMessage("我叫什么？")]}, cfg)["messages"][-1].content)
# → "你叫小王。"
```

注意：每次 `invoke` 只传**新消息**，框架会自动把它**追加**到 thread 里既有的 messages（因为有 `add_messages` reducer）。

## 6. 跨线程共享：Store API

Checkpoint 是**按 thread 隔离**的。如果想跨 thread 共享数据（比如同一个用户在不同会话里都该记住的信息），用 **Store**：

```python
from langgraph.store.memory import InMemoryStore
# 生产用 PostgresStore: from langgraph.store.postgres import PostgresStore

store = InMemoryStore()
app = graph.compile(checkpointer=checkpointer, store=store)

# 在节点里读写 store
def chat(state, *, store):
    user_id = "user-123"
    profile = store.get(("profiles", user_id), key="bio")
    ...
    store.put(("profiles", user_id), "bio", {"name": "小王"})
```

Store 适合放**长期记忆 / 跨会话偏好**；Checkpoint 适合放**单次会话的执行轨迹**。两者互补。

## 7. Checkpoint 的内容控制

### 7.1 不想 checkpoint 某些大字段？

把它们放进 store，或者节点里临时计算后**不写回 state**：

```python
def search(state):
    docs = vector_search(state["query"])
    return {
        "answer": summarize(docs),   # 写入 state
        # docs 不写回 → 不会进 checkpoint
    }
```

### 7.2 自定义 metadata

```python
config = {
    "configurable": {"thread_id": "user-123"},
    "metadata": {"user_role": "vip", "channel": "web"},
}
```

会随每个 checkpoint 一起存，方便后续审计/查询。

## 8. 常见坑

| 现象 | 原因 |
|---|---|
| 第二轮对话 LLM"失忆" | 没传 `thread_id`；或没挂 checkpointer |
| `MemorySaver` 重启就丢 | 生产换 SQLite/Postgres |
| Postgres 报"relation does not exist" | 忘了 `checkpointer.setup()` |
| state 越来越大、checkpoint 慢 | 大字段没拆出去；考虑 store 或外部存储 |
| 不同用户串话 | `thread_id` 设计错了，要用 `user_id` 或更细粒度 |
| `update_state` 没生效 | 字段有 reducer，是合并不是覆盖；用哨兵或单独字段 |

## 9. 下一步

- [07-human-in-the-loop.md](./07-human-in-the-loop.md)：基于 checkpoint 实现"中断 → 审批 → 继续"
- [10-deployment.md](./10-deployment.md)：生产部署的 checkpoint 选型
