# 01 · 概览与核心概念

## 1. LangGraph 是什么

**LangGraph** 是 LangChain 团队推出的、用于构建**有状态（stateful）、多步骤（multi-step）、可循环（cyclic）** LLM 应用的底层编排框架。

它把一个 LLM 应用抽象成一张**有向图（Graph）**：

- 每个**节点（Node）**是一个函数（可包含 LLM 调用、工具调用、任意 Python 逻辑）
- 节点之间通过**边（Edge）**连接，边可以是固定的，也可以是基于状态动态决定的（条件边）
- 整张图共享一个**状态（State）**对象，节点读取状态、返回更新，框架按 reducer 合并

> 一句话：**LangChain 关注"链"，LangGraph 关注"图 + 状态机"**。链是 DAG（不能回头），图可以循环、分支、并行、暂停、恢复。

## 2. 为什么需要 LangGraph

传统 LangChain Chain / AgentExecutor 的局限：

| 痛点                  | LangGraph 的回应                   |
| ------------------- | ------------------------------- |
| Agent 内部循环是黑盒，难调试   | 把循环显式画成图，每步可观测                  |
| 状态散落在各处，难持久化        | 单一 `State` + `Checkpointer` 持久化 |
| 难以做"中断 → 人工审批 → 继续" | 原生 Human-in-the-Loop（中断/恢复）     |
| 多 Agent 协作只能靠 hack  | 子图（Subgraph）+ 路由                |
| 流式只能流 token         | 流 token / 流节点输出 / 流状态变化         |

适用场景：**Agent、复杂工作流、多轮对话、人机协作审批、多 Agent 协同**。

## 3. 四个核心概念

### 3.1 State（状态）

整张图共享的数据结构，通常用 `TypedDict` 或 Pydantic 定义。

```python
from typing import TypedDict, Annotated
from operator import add

class State(TypedDict):
    messages: Annotated[list, add]   # add 是 reducer：新值追加到旧值
    counter: int                     # 无 reducer：新值覆盖旧值
```

关键点：

- 字段上的 `Annotated[T, reducer]` 决定**如何合并**节点返回的更新
- 没有 reducer 的字段 → 默认覆盖（overwrite）
- 有 reducer 的字段 → 调用 `reducer(old, new)` 合并（如 `add`、`operator.add`、自定义函数）

### 3.2 Node（节点）

一个普通的 Python 函数（同步或 `async`），签名为 **State → 部分 State**：

```python
def my_node(state: State) -> dict:
    # 读 state
    last = state["messages"][-1]
    # 返回部分更新（不需要返回整个 state）
    return {"messages": [f"echo: {last}"]}
```

特点：

- **只返回需要更新的字段**，框架按 reducer 合并到全局 state
- 节点可以是任何东西：LLM 调用、工具调用、HTTP 请求、纯计算……
- 可以是 `async def`，框架会正确 await

### 3.3 Edge（边）

定义节点之间的流转：

- **普通边**：`graph.add_edge("a", "b")` —— a 完成后无条件去 b
- **条件边**：`graph.add_conditional_edges("a", router_fn, {"x": "b", "y": "c"})` —— `router_fn(state)` 返回的 key 决定下一步
- **入口/出口**：`START` → 第一个节点；任意节点 → `END` 结束

条件边是循环/分支的关键：

```python
def should_continue(state: State) -> str:
    return "tools" if state["messages"][-1].tool_calls else "end"

graph.add_conditional_edges("agent", should_continue, {"tools": "tools", "end": END})
graph.add_edge("tools", "agent")  # 工具执行完回到 agent → 形成循环
```

### 3.4 Graph（图）

把节点和边组合起来 → 编译 → 得到可运行对象（Runnable）：

```python
from langgraph.graph import StateGraph, START, END

graph = StateGraph(State)
graph.add_node("agent", agent_node)
graph.add_node("tools", tools_node)
graph.add_edge(START, "agent")
graph.add_conditional_edges("agent", should_continue, {"tools": "tools", "end": END})
graph.add_edge("tools", "agent")

app = graph.compile()           # 编译后的 app 是 LangChain Runnable
result = app.invoke({"messages": [...]})
```

编译后的 `app` 支持 `.invoke()`、`.stream()`、`.astream()`、`.batch()`，并能挂载 `checkpointer` 实现持久化。

## 4. 心智模型：状态机 vs 函数式

可以用两种视角理解 LangGraph：

- **状态机视角**：每个节点是一个状态，边是转移；整张图是一个有限状态机（但状态本身是结构化数据，而非简单标签）
- **函数式视角**：`State -> State` 的函数们被串联/组合起来，reducer 决定如何"折叠"更新

两种视角都对，调试时切换视角往往能快速定位问题。

## 5. 与 LangChain 的关系

```
LangChain          LangGraph
─────────          ─────────
LLM/Prompt/Tool  → 直接复用（节点内部就是这些）
Chain (LCEL)     → 编译后的 Graph 也是 Runnable
AgentExecutor    → 推荐用 LangGraph 重写（官方方向）
Memory           → 用 Checkpointer 替代
```

LangGraph **不取代** LangChain，而是**取代 AgentExecutor**，在编排层提供更强表达力。LLM、Prompt、Tool、Retriever 等仍来自 LangChain。

## 6. 一张图记住

```
        ┌─────────────────────────────────────┐
        │             State                   │
        │   { messages, counter, ... }        │
        └────────────┬────────────────────────┘
                     │ 读 / 写（reducer 合并）
        ┌────────────┴────────────┐
        ▼                         ▼
   ┌─────────┐  edge        ┌─────────┐
   │  Node A │ ───────────► │  Node B │
   └─────────┘              └─────────┘
        ▲   conditional edge     │
        └────────────────────────┘
```

## 7. 下一步

- [02-quickstart.md](./02-quickstart.md)：动手跑一个最小可运行示例
- [03-state-and-reducers.md](./03-state-and-reducers.md)：深入 state 设计
- [04-control-flow.md](./04-control-flow.md)：条件边、循环、并行
