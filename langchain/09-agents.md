# 09 · Agent：从 AgentExecutor 到 LangGraph

> **TL;DR**：LangChain 老的 `AgentExecutor` 已经**不推荐**用于新项目，官方迁移方向是 LangGraph 的 `create_react_agent`。本章先讲清楚老 Agent 长什么样、为什么被替代，然后给迁移路径。

## 1. 什么是 Agent

**Agent = 一个会自己决定下一步做什么的 LLM 应用**。

普通链是固定流程：`prompt → llm → parser`。Agent 不是——它会循环：

```
观察当前状态 → LLM 思考 → 决定调哪个工具 → 执行 → 看结果 → 再思考...
```

最经典的 Agent 模式是 **ReAct**（Reasoning + Acting）：让 LLM 边思考边调工具，直到给出最终答案。

## 2. 老路：`AgentExecutor`

```python
# ❌ 不推荐用于新项目
from langchain.agents import AgentExecutor, create_openai_tools_agent
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_openai import ChatOpenAI
from langchain_core.tools import tool

@tool
def search(q: str) -> str:
    """搜索网络。"""
    return f"关于 {q} 的搜索结果..."

prompt = ChatPromptTemplate.from_messages([
    ("system", "你是助手。"),
    ("human", "{input}"),
    MessagesPlaceholder("agent_scratchpad"),
])

llm = ChatOpenAI(model="gpt-4o-mini")
agent = create_openai_tools_agent(llm, [search], prompt)
executor = AgentExecutor(agent=agent, tools=[search], verbose=True)

executor.invoke({"input": "LangGraph 是什么？"})
```

老风格还有几个变体：`create_react_agent`（旧版字符串解析）、`create_tool_calling_agent`、`create_structured_chat_agent`……都是不同 prompt 模板。

## 3. 老 Agent 为什么被替代

`AgentExecutor` 的核心问题——它**把循环藏在黑盒里**：

| 痛点 | 表现 |
|---|---|
| 不可观测 | 只能 `verbose=True` 看打印；想在中间塞个审计、缓存、降级很难 |
| 不可定制控制流 | 想做"调三次工具就停"、"某种工具调完直接结束"——要 hack |
| 不可中断 | 想做"人工审批后再继续"——做不到 |
| 不可持久化 | state 在对象里，重启就丢；多轮对话要外挂 memory |
| 不可时间旅行 | 出了 bug 想回到上一步重跑——做不到 |
| 多 Agent 协作 | 没有原生支持，只能层层嵌套 |
| 流式粗糙 | 流不到节点级、状态级，只有 token 流 |

这些问题**单独看每个都能 hack 解决**，但堆在一起，代码很快就难维护。

LangGraph 的设计就是**把循环显式画出来**——每一步是个节点，路径是边，状态是 state。所有上面那些"做不到"，在 LangGraph 里都是**一行代码**。

## 4. 新路：LangGraph 的 `create_react_agent`

一行代码替代整个 `AgentExecutor`：

```python
from langgraph.prebuilt import create_react_agent
from langchain_openai import ChatOpenAI
from langchain_core.tools import tool
from langchain_core.messages import HumanMessage

@tool
def search(q: str) -> str:
    """搜索网络。"""
    return f"关于 {q} 的搜索结果..."

llm = ChatOpenAI(model="gpt-4o-mini")
app = create_react_agent(llm, [search])

result = app.invoke({"messages": [HumanMessage("LangGraph 是什么？")]})
print(result["messages"][-1].content)
```

API 看起来更简单，但下面的能力**全部免费**：

```python
# 加 system prompt
app = create_react_agent(llm, [search], state_modifier="你是助手，回答用中文。")

# 加对话记忆（Checkpointer）
from langgraph.checkpoint.memory import MemorySaver
app = create_react_agent(llm, [search], checkpointer=MemorySaver())
cfg = {"configurable": {"thread_id": "user-1"}}
app.invoke({"messages": [...]}, cfg)
app.invoke({"messages": [...]}, cfg)   # 自动有上下文

# 加人工审批（HITL）
app = create_react_agent(llm, [search],
    checkpointer=MemorySaver(),
    interrupt_before=["tools"],   # 调工具前停下等审批
)

# 流式 token
for chunk in app.stream({"messages": [...]}, stream_mode="messages"):
    ...
```

详见 LangGraph 学习仓 [02 · 快速上手](../langgraph/02-quickstart.md)、[05 · 工具与 Agent](../langgraph/05-tools-and-agents.md)、[07 · HITL](../langgraph/07-human-in-the-loop.md)。

## 5. 迁移指南：AgentExecutor → LangGraph

### 5.1 标准 ReAct（最常见）

```python
# 老
agent = create_openai_tools_agent(llm, tools, prompt)
executor = AgentExecutor(agent=agent, tools=tools)
executor.invoke({"input": user_input})

# 新
app = create_react_agent(llm, tools, state_modifier=system_prompt)
app.invoke({"messages": [HumanMessage(user_input)]})
```

### 5.2 加历史

```python
# 老：AgentExecutor + RunnableWithMessageHistory，配置很啰嗦
# 新：
app = create_react_agent(llm, tools, checkpointer=PostgresSaver(...))
app.invoke({"messages": [...]}, config={"configurable": {"thread_id": "..."}})
```

### 5.3 自定义控制流

老 `AgentExecutor` 想加"评审节点"很麻烦。LangGraph 直接画图：

```python
from langgraph.graph import StateGraph, START, END

graph = StateGraph(State)
graph.add_node("agent", agent_node)
graph.add_node("audit", audit_node)         # 自定义审计节点
graph.add_node("tools", ToolNode(tools))
graph.add_edge(START, "agent")
graph.add_conditional_edges("agent", should_audit_or_continue, {...})
graph.add_edge("audit", "tools")
graph.add_edge("tools", "agent")
app = graph.compile()
```

### 5.4 拿到中间步骤

```python
# 老
result = executor.invoke({"input": "..."}, return_intermediate_steps=True)
result["intermediate_steps"]   # list of (action, observation)

# 新：用 stream 看每个节点
for chunk in app.stream({"messages": [...]}, stream_mode="updates"):
    print(chunk)   # {"agent": {...}} / {"tools": {...}}
```

### 5.5 输出格式不同

老 `AgentExecutor`：返回 `{"input": ..., "output": "..."}`。
新 LangGraph：返回完整 state，文字答案在 `result["messages"][-1].content`。

## 6. 什么时候真的要"自己画图"，不用 prebuilt

`create_react_agent` 适合标准 ReAct。下面这些场景要自己写 LangGraph：

- **多 Agent**：supervisor / swarm / hierarchical（[LangGraph 09](../langgraph/09-subgraphs.md)）
- **Plan-and-Execute**：先出计划再执行
- **RAG-Agent**：先判断要不要检索 → 检索 → 评估 → 再回答
- **特殊控制流**：固定步数上限、特定工具触发特殊路径、跳过某些循环
- **复杂 HITL**：多个审批节点、条件审批

## 7. 决策树

```
我要构建一个 Agent
├─ 单次工具调用就够（如"调一次搜索回答"）
│    → LangChain LCEL：prompt | llm.bind_tools(tools) + 自己处理 tool_calls
├─ 标准 ReAct 循环
│    → LangGraph create_react_agent
├─ 需要 HITL / 持久化 / 时间旅行
│    → LangGraph create_react_agent + checkpointer
├─ 复杂控制流（plan-execute、self-correction、agentic RAG）
│    → 自写 LangGraph
├─ 多 Agent 协作
│    → 自写 LangGraph + Subgraph
└─ ⚠️ 不要再用 AgentExecutor 写新项目
```

## 8. 老代码怎么办

**短期**：`AgentExecutor` 还能跑，没紧急压力别动。
**中期**：新功能用 LangGraph，老的不动。
**长期**：找一个迭代窗口整体迁移——往往比想象的容易，因为工具定义可以**直接复用**（`@tool` 装饰的函数两边都吃）。

迁移成本主要在：
- prompt 写法略不同（`state_modifier` vs `agent_scratchpad`）
- 输入输出 dict 字段名不同（`input/output` vs `messages`）
- 历史/记忆要从 `RunnableWithMessageHistory` 换成 Checkpointer

工具本身、LLM 配置、业务逻辑——都不用动。

## 9. 常见坑（迁移时）

| 现象 | 原因 |
|---|---|
| 迁移后 LLM 不会调工具 | `bind_tools` 没生效，或换了支持 tool calling 的模型 |
| `state_modifier` 不起作用 | 写法变了：可以是 str / SystemMessage / 函数 `(state) -> messages` |
| 输出找不到 `output` 字段 | 新 API 里在 `result["messages"][-1].content` |
| 多轮对话不记忆 | 没传 `thread_id`；或没挂 checkpointer |
| 中间步骤丢了 | 用 `app.stream(..., stream_mode="updates")` 看节点更新 |
| 性能变了 | 行为本身一致；如有差异多半是 prompt 微调或并行 tool calls 的影响 |

## 10. 下一步

- [10 · 可观测与生产](./10-observability-and-production.md)：上线前的最后一公里
- LangGraph 完整学习路径：[../langgraph/README.md](../langgraph/README.md)
