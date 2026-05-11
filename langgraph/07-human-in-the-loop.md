# 07 · 人机协作（Human-in-the-Loop）

很多场景 LLM 不能"独自做主"——下单、转账、删数据、发邮件。LangGraph 提供了一等公民的 HITL 能力：**在节点边界中断 → 等待人工 → 拿回输入继续执行**。

> HITL 必须配合 **checkpointer**（第 06 章），因为"中断后恢复"本质就是"读 checkpoint 接着跑"。

## 1. 两种风格

LangGraph 提供两种 HITL：

| 风格 | API | 适合 |
|---|---|---|
| **静态中断** | `compile(interrupt_before=[...])` / `interrupt_after=[...]` | 固定在某个节点前/后停 |
| **动态中断**（推荐） | 节点内部调用 `interrupt(value)` | 运行时按条件决定是否停、停在哪、停下来要问什么 |

新代码用**动态中断**为主，灵活很多。

## 2. 动态中断：`interrupt` + `Command(resume=...)`

### 2.1 节点内中断

```python
from langgraph.types import interrupt

def confirm_node(state):
    # 把要让人看的内容传给 interrupt，会原样吐给客户端
    decision = interrupt({
        "question": "确认转账 100 元到 Alice？",
        "summary": state["pending_action"],
    })
    # 客户端 resume 时传进来的值会作为 interrupt 的返回值
    if decision == "approve":
        return {"approved": True}
    return {"approved": False, "reason": decision}
```

调用 `interrupt()` 会让图**立即在该节点暂停**，state 写入 checkpoint。

### 2.2 触发中断

```python
config = {"configurable": {"thread_id": "txn-001"}}
result = app.invoke(initial_state, config=config)

# 当图被 interrupt 时，result 里会有 "__interrupt__" 字段
print(result["__interrupt__"])
# [Interrupt(value={"question": "...", "summary": ...}, ...)]
```

服务端这时把 `value` 推给前端，让人看；图在 thread 里"挂着"。

### 2.3 拿到人工输入后恢复

```python
from langgraph.types import Command

# 人工点了"批准"
app.invoke(Command(resume="approve"), config=config)

# 或者从某个 checkpoint 恢复并改 state
app.invoke(
    Command(resume="approve", update={"reviewer": "alice"}),
    config=config,
)
```

`Command(resume=X)` 让 `interrupt()` 返回 `X`，节点从那一行继续往下跑。

### 2.4 多次中断

一个节点里可以多次 `interrupt`，也可以多个节点各自 `interrupt`。LangGraph 通过 thread + checkpoint 自动配对哪个 resume 对应哪个 interrupt。

## 3. 静态中断：`interrupt_before` / `interrupt_after`

```python
app = graph.compile(
    checkpointer=checkpointer,
    interrupt_before=["execute_payment"],   # 进入该节点前停
    # interrupt_after=["draft_email"],
)

# 跑到要进 execute_payment 时自动停
result = app.invoke(state, config=config)
print(app.get_state(config).next)   # ('execute_payment',)

# 人工审核 state，必要时改：
app.update_state(config, {"amount": 99})

# 继续：传 None 表示"用 checkpoint 里的 state 接着跑"
app.invoke(None, config=config)
```

适合：**审批某个固定节点**、**调试时手动单步**。

## 4. 实战模式

### 4.1 工具调用前确认

```python
def review_tool_call(state):
    last = state["messages"][-1]
    if not last.tool_calls:
        return {}
    # 高风险工具才中断
    risky = [c for c in last.tool_calls if c["name"] in {"transfer", "delete_user"}]
    if not risky:
        return {}
    decision = interrupt({"calls": risky})
    if decision == "reject":
        # 删掉危险 tool_calls，让 agent 不要执行
        return {"messages": [AIMessage(content="操作已被人工拒绝", id=last.id)]}
    return {}

graph.add_edge("agent", "review_tool_call")
graph.add_conditional_edges("review_tool_call", should_continue, {...})
```

### 4.2 让人补充信息

```python
def collect_address(state):
    if state.get("address"):
        return {}
    addr = interrupt({"prompt": "请输入收货地址"})
    return {"address": addr}
```

### 4.3 让人改 LLM 的草稿

```python
def draft(state):
    text = llm.invoke(...).content
    edited = interrupt({"draft": text})   # 前端展示草稿、可改
    return {"final": edited or text}
```

### 4.4 多人会签

把 reviewer 列表放进 state，每次 `interrupt` 取下一个 reviewer，一个个轮：

```python
def multi_review(state):
    pending = state["reviewers"]
    if not pending:
        return {"approved": True}
    decision = interrupt({"reviewer": pending[0], "doc": state["doc"]})
    return {
        "reviewers": pending[1:],   # 配合 reducer 处理
        "decisions": [decision],    # 累积
    }

graph.add_edge("multi_review", "multi_review")  # 自循环直到 reviewers 空
```

## 5. 与前端的协议

典型 HTTP 服务端逻辑：

```python
@app.post("/chat")
def chat(thread_id: str, message: str | None = None, resume: str | None = None):
    cfg = {"configurable": {"thread_id": thread_id}}
    if resume is not None:
        out = graph_app.invoke(Command(resume=resume), config=cfg)
    else:
        out = graph_app.invoke({"messages": [HumanMessage(message)]}, config=cfg)

    if "__interrupt__" in out:
        # 暂停了，把问题返还给前端
        return {"status": "needs_input", "interrupt": out["__interrupt__"][0].value}
    return {"status": "done", "answer": out["messages"][-1].content}
```

前端拿到 `needs_input` → 渲染审批 UI → 人工点击 → 带着 `resume="approve"` 再请求一次 `/chat`。

## 6. 调试 HITL

- `app.get_state(config).next` 看图卡在哪个节点
- `app.get_state_history(config)` 看完整的暂停/恢复轨迹
- 用 `update_state` 在调试时手动注入数据，模拟人工操作
- LangSmith trace 会清晰标记 interrupt 边界

## 7. 常见坑

| 现象 | 原因 |
|---|---|
| `interrupt` 没生效，图跑完了 | 没挂 checkpointer |
| resume 后从头开始重跑 | 没传 `thread_id`，或传成新 thread |
| `Command(resume=...)` 报错 | 当前 thread 没有 pending interrupt |
| 节点里在 `interrupt` 后又跑了一遍前面的逻辑 | **正常**：恢复时该节点会从头重跑，但 `interrupt()` 命中已有的 resume 值会"瞬间返回"。**所以节点里 interrupt 之前的代码必须幂等**——不要在那之前发邮件、扣款 |
| 多次 interrupt 配对错乱 | 每次 interrupt 的 value 不要写成动态变化太大的，以免 LangGraph 误判；保持节点内 interrupt 顺序稳定 |

> **最重要的一条**：被 interrupt 的节点，**恢复时会整体重跑一遍**，`interrupt()` 之前的代码会再执行一次。所以 interrupt 之前**不要做有副作用的操作**——副作用应放在 interrupt 之后，或独立成一个新节点。

## 8. 下一步

- [08-streaming.md](./08-streaming.md)：把中断状态实时推给前端
- [09-subgraphs.md](./09-subgraphs.md)：审批流可以做成可复用子图
