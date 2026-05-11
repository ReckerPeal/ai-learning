# 02 · 快速上手

目标：5 分钟跑通一个**带工具调用的最小 Agent**，建立对 LangGraph 编程模型的第一印象。

## 1. 安装

```bash
pip install -U langgraph langchain langchain-openai
# 可选：本地模型
# pip install -U langchain-ollama
```

环境变量：

```bash
export OPENAI_API_KEY=sk-...
```

> 国内用户可用兼容 OpenAI 协议的代理，设置 `OPENAI_BASE_URL` 即可；或换 `langchain-ollama` 跑本地模型。

## 2. Hello, Graph（无 LLM 版）

先不引入 LLM，理解最小骨架：

```python
from typing import TypedDict, Annotated
from operator import add
from langgraph.graph import StateGraph, START, END


class State(TypedDict):
    messages: Annotated[list[str], add]


def greet(state: State) -> dict:
    return {"messages": ["hello"]}


def shout(state: State) -> dict:
    last = state["messages"][-1]
    return {"messages": [last.upper() + "!"]}


graph = StateGraph(State)
graph.add_node("greet", greet)
graph.add_node("shout", shout)
graph.add_edge(START, "greet")
graph.add_edge("greet", "shout")
graph.add_edge("shout", END)

app = graph.compile()
print(app.invoke({"messages": []}))
# {'messages': ['hello', 'HELLO!']}
```

要点回顾：

- `messages` 字段用 `add` reducer，所以两个节点各自 `return {"messages": [x]}`，最终被**追加**而非覆盖
- `START → greet → shout → END` 是固定链路
- `app.invoke()` 接收**初始 state**，返回**最终 state**

## 3. 加上 LLM 与工具：最小 ReAct Agent

下面是一个能"自己决定要不要调工具"的 Agent。结构：

```
        ┌────────┐    tool_calls?   ┌────────┐
START → │ agent  │ ───────────────► │ tools  │
        └────────┘                  └────────┘
            ▲                           │
            └───────────────────────────┘
                  执行完回到 agent
            │
            └──── 无 tool_calls ───► END
```

```python
from typing import TypedDict, Annotated
from langchain_core.messages import BaseMessage, HumanMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode


# ---------- 1) 状态：用官方的 add_messages reducer ----------
class State(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]


# ---------- 2) 工具 ----------
@tool
def get_weather(city: str) -> str:
    """查询某个城市的天气。"""
    return f"{city} 今天晴，25°C"


tools = [get_weather]
llm = ChatOpenAI(model="gpt-4o-mini").bind_tools(tools)


# ---------- 3) 节点 ----------
def agent_node(state: State) -> dict:
    response = llm.invoke(state["messages"])
    return {"messages": [response]}


tool_node = ToolNode(tools)  # 官方预置：自动执行 last message 中的 tool_calls


# ---------- 4) 路由 ----------
def should_continue(state: State) -> str:
    last = state["messages"][-1]
    return "tools" if getattr(last, "tool_calls", None) else END


# ---------- 5) 组图 ----------
graph = StateGraph(State)
graph.add_node("agent", agent_node)
graph.add_node("tools", tool_node)
graph.add_edge(START, "agent")
graph.add_conditional_edges("agent", should_continue, {"tools": "tools", END: END})
graph.add_edge("tools", "agent")

app = graph.compile()


# ---------- 6) 跑 ----------
result = app.invoke({"messages": [HumanMessage(content="北京天气怎么样？")]})
for m in result["messages"]:
    m.pretty_print()
```

预期输出（节选）：

```
================================ Human Message =================================
北京天气怎么样？
================================== Ai Message ==================================
Tool Calls:
  get_weather  args={'city': '北京'}
================================= Tool Message =================================
北京 今天晴，25°C
================================== Ai Message ==================================
北京今天晴，25°C。
```

## 4. 流式输出

把 `invoke` 换成 `stream`，能看到每一步的中间输出：

```python
for chunk in app.stream(
    {"messages": [HumanMessage(content="北京天气怎么样？")]},
    stream_mode="updates",   # 每个节点产生的更新；也可用 "values" / "messages"
):
    print(chunk)
```

`stream_mode` 速查（详见 [08-streaming.md](./08-streaming.md)）：

- `values`：每步后的**完整 state**
- `updates`：每个节点返回的**增量更新**
- `messages`：LLM 的 token 流（最常用）

## 5. 可视化图结构

```python
# 需要安装 grandalf：pip install grandalf
print(app.get_graph().draw_ascii())

# 或导出 mermaid
print(app.get_graph().draw_mermaid())

# 或在 notebook 里：
# from IPython.display import Image
# Image(app.get_graph().draw_mermaid_png())
```

## 6. 用 prebuilt 进一步简化

如果只是想要"一个能用工具的 Agent"，连图都不用自己画：

```python
from langgraph.prebuilt import create_react_agent

app = create_react_agent(llm, tools)
result = app.invoke({"messages": [HumanMessage(content="北京天气怎么样？")]})
```

`create_react_agent` 内部就是上面那张图。**学习时建议先手写一遍**，再用 prebuilt。

## 7. 常见坑

| 现象                        | 原因                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `messages` 被覆盖而不是追加       | 忘了 `Annotated[..., add_messages]`                                                                        |
| 节点返回值报错                   | 节点必须返回 `dict`（部分 state），不是返回新 state 整体                                                                   |
| 死循环跑不停                    | 条件边 router 永远不返回 `END`；或 `recursion_limit` 默认 25，要在 `app.invoke(..., config={"recursion_limit": 50})` 调高 |
| 工具调用没触发                   | `llm` 没 `.bind_tools(tools)`；或模型本身不支持 tool calling                                                       |
| 中文乱码 / `pretty_print` 不好看 | 直接 `print(m.content)` 即可                                                                                 |

## 8. 下一步

- [03-state-and-reducers.md](./03-state-and-reducers.md)：把 state 设计讲透
- [05-tools-and-agents.md](./05-tools-and-agents.md)：工具与 Agent 模式深入
