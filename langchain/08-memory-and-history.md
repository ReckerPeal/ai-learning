# 08 · 对话记忆

LangChain 的 "memory" 概念经历了一次大转向，**新老 API 差别巨大**。本章直接讲清楚：

1. 老 `Memory` 类（`ConversationBufferMemory` 等）—— 已弃用
2. 当前 LangChain 推荐方式：`RunnableWithMessageHistory`
3. **真正的生产推荐**：用 LangGraph 的 Checkpointer

## 1. 老 Memory 类（不要再用）

```python
# ❌ 不要再用
from langchain.memory import ConversationBufferMemory
from langchain.chains import ConversationChain

memory = ConversationBufferMemory()
conv = ConversationChain(llm=llm, memory=memory)
```

为什么弃用：
- 和 LCEL 不兼容（无法 `prompt | llm | parser` 那样组合）
- 状态藏在对象里，不可观测、不可持久化、不可时间旅行
- 在多用户/多会话场景下要自己管理隔离

**所有新代码都不应再写 `ConversationXxxMemory`。** 老代码可以继续跑，但建议迁移。

## 2. 推荐方式：`RunnableWithMessageHistory`

它把"记历史"做成 LCEL 链上的 wrapper：

```python
from langchain_core.chat_history import InMemoryChatMessageHistory
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.runnables.history import RunnableWithMessageHistory
from langchain_openai import ChatOpenAI

# 1. 普通 LCEL 链（含历史占位符）
prompt = ChatPromptTemplate.from_messages([
    ("system", "你是助手。"),
    MessagesPlaceholder("history"),
    ("human", "{input}"),
])
chain = prompt | ChatOpenAI(model="gpt-4o-mini")

# 2. session_id → ChatMessageHistory 的工厂
store: dict[str, InMemoryChatMessageHistory] = {}
def get_history(session_id: str) -> InMemoryChatMessageHistory:
    if session_id not in store:
        store[session_id] = InMemoryChatMessageHistory()
    return store[session_id]

# 3. 包一层
chain_with_history = RunnableWithMessageHistory(
    chain,
    get_history,
    input_messages_key="input",
    history_messages_key="history",
)

# 4. 调用：每次传 session_id
cfg = {"configurable": {"session_id": "user-123"}}
chain_with_history.invoke({"input": "我叫小王"}, config=cfg)
chain_with_history.invoke({"input": "我叫什么？"}, config=cfg)
# AI: "你叫小王。"
```

要点：
- `session_id` 隔离不同用户/会话
- 历史**自动**追加到 `MessagesPlaceholder("history")` 位置
- 输入新消息也自动写入历史

## 3. 持久化历史：换实现就行

`InMemoryChatMessageHistory` 重启即丢。换持久化版本：

| 实现 | 来源 |
|---|---|
| `RedisChatMessageHistory` | `langchain-redis` |
| `PostgresChatMessageHistory` | `langchain-postgres` |
| `SQLChatMessageHistory` | `langchain-community` |
| `FileChatMessageHistory` | `langchain-community` |
| `MongoDBChatMessageHistory` | `langchain-mongodb` |

```python
from langchain_postgres import PostgresChatMessageHistory

def get_history(session_id):
    return PostgresChatMessageHistory(
        connection_string=DB_URI,
        session_id=session_id,
        table_name="chat_history",
    )
```

## 4. 控制历史长度

不裁剪历史的话，长对话很快会爆 token。三种策略：

### 4.1 取最后 N 条

```python
from langchain_core.messages import trim_messages

trimmer = trim_messages(
    max_tokens=2000,
    strategy="last",
    token_counter=llm,    # 用模型自己的 tokenizer 估算
    include_system=True,
    allow_partial=False,
    start_on="human",
)

chain = (
    {"input": lambda x: x["input"],
     "history": lambda x: trimmer.invoke(x["history"])}
    | prompt | llm
)
```

### 4.2 摘要 + 最近 N 条

老消息让 LLM 摘要成一段，加上最近 N 条原文。需要自己写一个 summarize 节点。

### 4.3 滑窗

只保留最近 K 轮。粗暴但有效，适合简单 chatbot。

## 5. 问题：`RunnableWithMessageHistory` 的局限

够用，但**有几个硬伤**：

1. **只能记 messages**——其他 state（用户偏好、任务进度、检索结果）没地方放
2. **不能中断/恢复**——长任务/HITL 做不了
3. **不能时间旅行**——回到上一步重跑改 prompt？做不到
4. **多 Agent 协作时**很难把历史合理切分到不同 Agent

## 6. 真正的生产推荐：LangGraph Checkpointer

LangGraph 的 Checkpointer 把整个 state（不只是 messages）持久化，免费给你：

- 多轮对话记忆
- 中断/恢复（HITL）
- 时间旅行
- 多 Agent 共享 state

最小例子：

```python
from typing import TypedDict, Annotated
from langchain_core.messages import BaseMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages
from langgraph.checkpoint.memory import MemorySaver
# 生产用 langgraph.checkpoint.postgres.PostgresSaver

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

cfg = {"configurable": {"thread_id": "user-123"}}
app.invoke({"messages": [HumanMessage("我叫小王")]}, cfg)
app.invoke({"messages": [HumanMessage("我叫什么？")]}, cfg)
```

**`thread_id` ≈ `session_id`**，但 LangGraph 保存的是**整个 state**，不只是历史。详见 [LangGraph 06 · 持久化](../langgraph/06-persistence.md)。

## 7. 跨会话长记忆：Store

`RunnableWithMessageHistory` 和 LangGraph Checkpointer 都是**单会话内**的记忆。

如果你想要"用户在不同会话里都能记住"——比如他几年前说过自己讨厌香菜——那是**长期记忆**，不是对话记忆。

LangGraph 的 **Store API** 专门干这个（[LangGraph 06 第 6 节](../langgraph/06-persistence.md)）。LangChain 本身没有完整的长期记忆原语，社区方案有：

- 把"用户事实"做成单独的向量库 + 检索（最常见）
- 用第三方记忆服务（mem0、Zep 等）

## 8. 决策树：选哪个

```
你需要"记忆"吗？
├─ 单次问答，不需要 → 啥也不用
├─ 多轮对话，仅记 messages，简单 → RunnableWithMessageHistory
├─ 多轮对话，state 里还有别的字段 → LangGraph Checkpointer
├─ 需要中断/审批/时间旅行 → LangGraph Checkpointer
└─ 跨会话/长期事实 → Store API（LangGraph）或自建向量库
```

**新项目从一开始就上 LangGraph 是更优解**——多花 30 行代码，省后面所有迁移。

## 9. 常见坑

| 现象 | 原因 |
|---|---|
| AI 总是失忆 | session_id / thread_id 没传或每次不一样 |
| 不同用户消息串了 | session_id 设计错——必须按用户/会话隔离 |
| 历史越长越慢、token 爆 | 没接 `trim_messages` |
| `MessagesPlaceholder` 报错"missing key" | 配置 `history_messages_key` 和 placeholder 名字不一致 |
| 重启后历史没了 | 用了内存实现；换持久化的 |
| 老代码 `ConversationBufferMemory` 警告 | 迁移到 `RunnableWithMessageHistory` 或 LangGraph |

## 10. 下一步

- [09 · Agents](./09-agents.md)：Agent 的"记忆"也是这个机制
- LangGraph [06 · 持久化](../langgraph/06-persistence.md)：完整的 state 持久化
