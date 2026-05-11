# 09 · 子图与多 Agent 协作

当一张图变得太大、或者你想把"一个 Agent"当作可复用模块——就该用**子图（Subgraph）**了。

## 1. 子图的本质

**子图就是一张编译好的图，被当作另一张图的节点**。LangGraph 对此原生支持，没有任何特殊语法：

```python
sub_graph = StateGraph(SubState).add_node(...)...compile()

parent = StateGraph(ParentState)
parent.add_node("sub", sub_graph)   # ← 直接当节点用
```

子图保留它自己的 state schema、自己的内部节点和边。从外层看，它就是一个"接收 state、返回 state"的函数。

## 2. State 共享的两种模式

子图和父图的 state 关系，本质就两种：

### 2.1 共享 schema（直接传透）

子图和父图的 state schema **有相同字段** → 父图直接把这些字段传进去，子图返回的同名字段被合并回父图：

```python
class SharedState(TypedDict):
    messages: Annotated[list, add_messages]

# 父子用同一个 schema
sub = StateGraph(SharedState).add_node("step", step_fn)...compile()

parent = StateGraph(SharedState)
parent.add_node("sub", sub)        # messages 自动透传
parent.add_edge(START, "sub")
parent.add_edge("sub", END)
```

适合：把一段流程封装成可复用模块（如"标准 ReAct 块"）。

### 2.2 不同 schema（手动转换）

子图有自己的内部 state，父图用 wrapper 函数做"翻译"：

```python
class ParentState(TypedDict):
    user_query: str
    final_answer: str

class SubState(TypedDict):
    question: str
    answer: str

sub_app = StateGraph(SubState)...compile()

def call_sub(state: ParentState) -> dict:
    sub_in = {"question": state["user_query"]}
    sub_out = sub_app.invoke(sub_in)
    return {"final_answer": sub_out["answer"]}

parent.add_node("sub", call_sub)   # 函数节点而非直接子图
```

适合：子图是个"黑盒能力"（如外部团队提供的 Agent），不想让它的内部 state 污染父图。

## 3. 多 Agent 协作模式

### 3.1 Supervisor（监督者）

一个 supervisor agent 负责调度多个 worker agent：

```
                ┌──► researcher ──┐
user → supervisor──► writer     ──┼──► supervisor ──► END
                └──► reviewer   ──┘
```

```python
def supervisor(state):
    decision = llm.with_structured_output(Route).invoke(
        [SystemMessage("你是调度员，决定下一步该谁干"), *state["messages"]]
    )
    return {"next": decision.next_agent}   # "researcher" / "writer" / "FINISH"

def route(state):
    return END if state["next"] == "FINISH" else state["next"]

graph.add_node("supervisor", supervisor)
graph.add_node("researcher", researcher_agent)   # 子图
graph.add_node("writer", writer_agent)           # 子图
graph.add_node("reviewer", reviewer_agent)       # 子图

graph.add_edge(START, "supervisor")
graph.add_conditional_edges("supervisor", route, {
    "researcher": "researcher", "writer": "writer",
    "reviewer": "reviewer", END: END,
})
# 每个 worker 干完 → 回 supervisor
for w in ["researcher", "writer", "reviewer"]:
    graph.add_edge(w, "supervisor")
```

LangGraph 还有官方包 `langgraph-supervisor` 把这个模式封装好了。

### 3.2 Swarm（群体 / 直接交接）

Agent 之间互相 handoff，不需要中央调度——每个 Agent 自己决定"该谁接手"：

```
user → agent_A ──handoff──► agent_B ──handoff──► agent_A → END
```

实现方式：每个 agent 有个 `handoff` 工具，调用后图路由到目标 agent。官方包 `langgraph-swarm` 提供模板。

### 3.3 Hierarchical（多层）

Supervisor 下面再有 supervisor：

```
top_supervisor
   ├── research_team_supervisor
   │     ├── web_searcher
   │     └── doc_searcher
   └── writing_team_supervisor
         ├── outliner
         └── writer
```

每个 team_supervisor 是一个**子图**，整个 team 又是 top_supervisor 的一个 worker。这种分层在复杂 workflow 里很常见。

## 4. 完整示例：监督者模式

```python
from typing import TypedDict, Annotated, Literal
from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages
from langgraph.prebuilt import create_react_agent
from pydantic import BaseModel

class State(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]
    next: str

llm = ChatOpenAI(model="gpt-4o-mini")

# ---- workers：每个都是子图（这里偷懒用 prebuilt） ----
researcher = create_react_agent(llm, [search_web], state_modifier="你负责调研。")
writer     = create_react_agent(llm, [],            state_modifier="你负责写作。")

# ---- supervisor ----
class Route(BaseModel):
    next: Literal["researcher", "writer", "FINISH"]

def supervisor(state):
    msgs = [SystemMessage("决定下一步该谁工作。完成时说 FINISH。"), *state["messages"]]
    decision = llm.with_structured_output(Route).invoke(msgs)
    return {"next": decision.next}

def route(state) -> str:
    return END if state["next"] == "FINISH" else state["next"]

# 让 worker 子图把消息合并回主 state
def wrap(agent):
    def call(state):
        out = agent.invoke({"messages": state["messages"]})
        return {"messages": out["messages"][-1:]}   # 只把最新一条带回
    return call

graph = StateGraph(State)
graph.add_node("supervisor", supervisor)
graph.add_node("researcher", wrap(researcher))
graph.add_node("writer",     wrap(writer))
graph.add_edge(START, "supervisor")
graph.add_conditional_edges("supervisor", route, {
    "researcher": "researcher", "writer": "writer", END: END,
})
graph.add_edge("researcher", "supervisor")
graph.add_edge("writer", "supervisor")

app = graph.compile()
```

## 5. 子图的流式

外层 `stream` 默认**不**会流出子图内部节点的 update。要打开：

```python
for chunk in parent.stream(state, stream_mode="updates", subgraphs=True):
    # 现在 chunk = (namespace, update)
    # namespace 是父→子的路径，例如 ("sub:abc",)
    print(chunk)
```

`subgraphs=True` 让外层能"看穿"子图，但事件量会变多——按需开。

`messages` 模式下的 LLM token 流是默认穿透的（因为它是按 LLM Runnable 收集的，跟图层无关）。

## 6. 子图的 checkpoint

子图的 state 会和父图一起被 checkpoint。父图的 `thread_id` 同时管控父子两层。从外层 `update_state` 也能看到子图状态——但**修改子图内部 state** 需要更精细的 API（用 `as_node` 指定为子图节点的命名空间）。一般情况：**把交互边界放在父图层面**，避免直接戳子图内部。

## 7. 何时用子图，何时不用

**用子图**：
- 一个模块要在多张图里**复用**
- 模块有**独立的 state schema**，不想污染父图
- 想做**分层多 Agent**

**不用子图**（用普通函数节点就够）：
- 节点逻辑短、不复用
- state 完全共享，子图带来的额外抽象不值得
- 性能敏感（子图多一层 Pregel 调度开销，虽然小但存在）

## 8. 常见坑

| 现象 | 原因 |
|---|---|
| 子图返回的字段没合并到父图 | 父图 state 没那个字段；或字段名拼错 |
| 子图内部循环把外层 messages 搞乱 | worker 的 wrapper 没控制好哪些消息往外冒泡（用 `out["messages"][-1:]` 挑） |
| 流式只能看到 supervisor 的事件 | 加 `subgraphs=True` |
| supervisor 死循环（一直选同一个 worker） | LLM 没看到"我已经做过 X 了"的信号；把 worker 的输出摘要进 messages |
| 子图各自挂了 checkpointer 报错 | **子图编译时不要传 checkpointer**——继承父图的就行 |

## 9. 下一步

- [10-deployment.md](./10-deployment.md)：多 Agent 系统的部署
