# 04 · 控制流：条件边、循环、并行

LangGraph 的表达力主要来自**控制流**。本章把所有控制流模式过一遍。

## 1. 边的类型速查

| 边类型   | API                                         | 用途                               |
| ----- | ------------------------------------------- | -------------------------------- |
| 普通边   | `add_edge(a, b)`                            | a 完成 → 无条件进入 b                   |
| 条件边   | `add_conditional_edges(a, fn, mapping)`     | 根据 `fn(state)` 选下一步              |
| 入口边   | `add_edge(START, x)` 或 `set_entry_point(x)` | 起点                               |
| 入口条件边 | `add_conditional_edges(START, fn, mapping)` | 起点就分流                            |
| 出口边   | `add_edge(x, END)`                          | 终止                               |
| 并行扇出  | 多个 `add_edge(a, b1)`, `add_edge(a, b2)`     | a 完成后并行进 b1、b2                   |
| 动态分发  | `Send` API                                  | 在条件边里返回 `[Send(...)]` 动态产生多个并行任务 |

## 2. 条件边（分支）

最常见的模式：

```python
from langgraph.graph import StateGraph, START, END

def router(state) -> str:
    if state["score"] > 0.8:
        return "high"
    elif state["score"] > 0.4:
        return "mid"
    return "low"

graph.add_conditional_edges(
    "classify",
    router,
    {
        "high": "vip_handler",
        "mid":  "normal_handler",
        "low":  END,   # 也可以直接结束
    },
)
```

**简化写法**：如果 router 直接返回节点名，可以省略 mapping：

```python
graph.add_conditional_edges("classify", router)
# 等价于 mapping={"high": "high", "mid": "mid", "low": "low"}
```

但**显式 mapping 更可读**，尤其团队协作时。

## 3. 循环

循环 = 条件边指回上游节点。经典 ReAct 循环：

```python
def should_continue(state) -> str:
    last = state["messages"][-1]
    return "tools" if last.tool_calls else END

graph.add_edge(START, "agent")
graph.add_conditional_edges("agent", should_continue, {"tools": "tools", END: END})
graph.add_edge("tools", "agent")    # ← 形成循环
```

### 3.1 防失控：recursion_limit

LangGraph 默认最多执行 **25 步**就会抛 `GraphRecursionError`。可以调高：

```python
app.invoke(state, config={"recursion_limit": 50})
```

但**不要无脑调高**——失控的循环往往是 bug。先排查：

- router 是否在某个分支永远不返回 `END`
- 工具是否每次都触发新的 tool_calls
- LLM 是否陷入"反复调用同一工具"

### 3.2 自定义终止条件

```python
def should_continue(state) -> str:
    if state["step"] >= 10:        # 业务级硬上限
        return END
    if state["confidence"] >= 0.95:
        return END
    if state["messages"][-1].tool_calls:
        return "tools"
    return END
```

## 4. 并行（扇出 / 扇入）

### 4.1 静态并行

从一个节点出发连多条边 → 这些下游节点**并行执行**：

```python
graph.add_node("split", split_node)
graph.add_node("search_web", search_web)
graph.add_node("search_db",  search_db)
graph.add_node("merge", merge_node)

graph.add_edge("split", "search_web")
graph.add_edge("split", "search_db")
graph.add_edge("search_web", "merge")
graph.add_edge("search_db",  "merge")
```

`merge` 会在 `search_web` 和 `search_db` **都完成后**才执行（自动 join）。

⚠️ 并行节点对 state 的更新会**同步合并**，所以并行写同一个字段必须有 reducer，否则报错：

```python
class State(TypedDict):
    results: Annotated[list, add]   # ✅ 并行写也安全
    # results: list                 # ❌ 并行覆盖 → 报错
```

### 4.2 动态并行：`Send`

如果并行任务数量在运行时才知道（典型场景：map-reduce），用 `Send`：

```python
from langgraph.constants import Send

def fan_out(state) -> list[Send]:
    # 把 N 个 query 分发到 search 节点并行执行
    return [Send("search", {"query": q}) for q in state["queries"]]

graph.add_conditional_edges("planner", fan_out, ["search"])
graph.add_edge("search", "reduce")
```

`Send(node_name, partial_state)`：

- 对该节点**单独投递**一份 state（独立子任务）
- 多个 `Send` → 并行执行多个 `search` 实例
- 它们的返回值通过 reducer 合并到主 state（典型用 `add` 累积）

### 4.3 并行的执行顺序

LangGraph 用 **Pregel 风格的"超步（superstep）"** 模型：

- 每个超步内，所有可执行的节点**并行**跑
- 全部完成后再合并 state，进入下一个超步
- 不会出现"A 还没跑完 B 就开始读 A 的输出"

## 5. 实战模式

### 5.1 Router（一进多出）

```
       ┌──► faq_handler
classify ──► search_handler
       └──► escalate_to_human
```

```python
def router(state):
    return state["intent"]   # "faq" / "search" / "escalate"

graph.add_conditional_edges("classify", router, {
    "faq": "faq_handler",
    "search": "search_handler",
    "escalate": "escalate_to_human",
})
```

### 5.2 Map-Reduce（动态扇出 + 聚合）

```python
def fan_out(state):
    return [Send("summarize", {"chunk": c}) for c in state["chunks"]]

graph.add_node("summarize", summarize_chunk)   # 接收 {"chunk": ...}
graph.add_node("reduce", combine_summaries)
graph.add_conditional_edges("split", fan_out, ["summarize"])
graph.add_edge("summarize", "reduce")
```

### 5.3 重试（Loop with backoff）

```python
def should_retry(state) -> str:
    if state["last_error"] is None:
        return END
    if state["retry_count"] >= 3:
        return "give_up"
    return "call_api"

graph.add_conditional_edges("call_api", should_retry, {
    "call_api": "call_api",
    "give_up": "give_up",
    END: END,
})
```

### 5.4 Self-correction（评审循环）

```
generate → critique → (good?) → END
              │
              └── (bad) → generate
```

```python
def review(state):
    return END if state["quality"] >= 0.8 else "generate"

graph.add_edge("generate", "critique")
graph.add_conditional_edges("critique", review, {"generate": "generate", END: END})
```

## 6. 调试控制流

### 6.1 `stream_mode="updates"` 看每个超步

```python
for chunk in app.stream(state, stream_mode="updates"):
    # chunk = {"node_name": {field: value, ...}}
    print(chunk)
```

每个 `chunk` 就是一个超步里某个节点的更新——并行节点会在同一批出现。

### 6.2 画图

```python
print(app.get_graph().draw_mermaid())
```

把输出贴到 mermaid live editor 看图，绝大多数控制流问题肉眼可见。

### 6.3 router 单测

```python
def test_router_high_score():
    assert router({"score": 0.9}) == "high"
```

router 是纯函数，必须可单测。

## 7. 常见坑

| 现象                                 | 原因                                                                 |
| ---------------------------------- | ------------------------------------------------------------------ |
| 并行节点报"can't combine state updates" | 多个并行节点写同一字段但没 reducer                                              |
| `Send` 接收的 state 缺字段               | `Send(node, partial)` 的 partial 是**完整子任务输入**，不会自动继承主 state——按需显式传  |
| 死循环                                | router 永远不返回 `END`                                                 |
| 条件边 mapping 漏了 key                 | router 返回了 mapping 里没有的 key → 报 `InvalidUpdateError`               |
| 静态并行节点没"等齐"                        | 下游节点连了多条入边，框架会自动 join；如果只想"先到先触发"——LangGraph 不直接支持，需自己用 state 字段判断 |

## 8. 下一步

- [05-tools-and-agents.md](./05-tools-and-agents.md)：把控制流用在 Agent 上
- [09-subgraphs.md](./09-subgraphs.md)：把整张图当一个节点用
