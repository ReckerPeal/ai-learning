# 05 · 工具与 Agent

LangGraph 是官方推荐的 Agent 实现方式（替代 `AgentExecutor`）。本章把工具调用、ReAct、prebuilt agent、以及常见 Agent 模式串起来。

## 1. 工具的定义

工具就是 LangChain 的 `Tool`，最简单的方式是 `@tool` 装饰器：

```python
from langchain_core.tools import tool

@tool
def add(a: int, b: int) -> int:
    """两个整数相加。"""
    return a + b

@tool
def search_web(query: str) -> str:
    """在网络上搜索 query 并返回前 3 条摘要。"""
    ...
```

要点：
- **docstring 非常重要**——LLM 用它判断"什么时候该调这个工具"
- 类型注解会被转成 JSON Schema 提供给 LLM
- 也可以用 Pydantic 做更复杂的参数：

```python
from pydantic import BaseModel, Field

class SearchInput(BaseModel):
    query: str = Field(description="搜索关键词")
    top_k: int = Field(default=3, description="返回条数")

@tool(args_schema=SearchInput)
def search_web(query: str, top_k: int = 3) -> str:
    ...
```

## 2. 把工具绑定给模型

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(model="gpt-4o-mini")
llm_with_tools = llm.bind_tools([add, search_web])

resp = llm_with_tools.invoke([HumanMessage("3 + 5 = ?")])
print(resp.tool_calls)
# [{'name': 'add', 'args': {'a': 3, 'b': 5}, 'id': 'call_abc'}]
```

`bind_tools` 把工具 schema 注入到 LLM 请求里。**不同模型实现不同**：
- OpenAI / Anthropic / 通义千问 / DeepSeek 等：原生支持
- 部分本地模型（如某些 Llama 衍生）需要用专门的 prompt template

## 3. 执行工具：`ToolNode`

LangGraph 提供了开箱即用的 `ToolNode`，它做这件事：
1. 取 `state["messages"][-1]` 里的 `tool_calls`
2. 并行执行所有 tool_calls
3. 把每个执行结果包装成 `ToolMessage` 追加到 messages

```python
from langgraph.prebuilt import ToolNode

tool_node = ToolNode([add, search_web])

# 等价于手写：
def tool_node_manual(state):
    last = state["messages"][-1]
    results = []
    for call in last.tool_calls:
        tool = {"add": add, "search_web": search_web}[call["name"]]
        output = tool.invoke(call["args"])
        results.append(ToolMessage(content=str(output), tool_call_id=call["id"]))
    return {"messages": results}
```

`ToolNode` 还能在工具抛异常时**优雅降级**——把错误包成 `ToolMessage` 喂回给 LLM，让它自己重试或换思路：

```python
tool_node = ToolNode(tools, handle_tool_errors=True)  # 默认就是 True
```

## 4. ReAct Agent：经典模式

```
        ┌─────────┐  has tool_calls   ┌─────────┐
START → │  agent  │ ─────────────────►│  tools  │
        └─────────┘                   └─────────┘
            ▲   no tool_calls              │
            │                               │
            └───────────────────────────────┘
                     END
```

完整代码（来自第 02 章的扩展）：

```python
from typing import TypedDict, Annotated
from langchain_core.messages import BaseMessage, SystemMessage, HumanMessage
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode

class State(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]

SYSTEM = SystemMessage(content="你是一个助手，能调用工具完成任务。回答用中文。")

def agent_node(state: State) -> dict:
    msgs = [SYSTEM] + state["messages"]
    return {"messages": [llm_with_tools.invoke(msgs)]}

def should_continue(state: State) -> str:
    return "tools" if state["messages"][-1].tool_calls else END

graph = StateGraph(State)
graph.add_node("agent", agent_node)
graph.add_node("tools", ToolNode([add, search_web]))
graph.add_edge(START, "agent")
graph.add_conditional_edges("agent", should_continue, {"tools": "tools", END: END})
graph.add_edge("tools", "agent")
app = graph.compile()
```

## 5. Prebuilt：`create_react_agent`

如果就是标准 ReAct，一行搞定：

```python
from langgraph.prebuilt import create_react_agent

app = create_react_agent(
    model=llm,                          # 注意传未 bind_tools 的 llm
    tools=[add, search_web],
    state_modifier="你是一个助手，回答用中文。",   # 等价于 system prompt
    # checkpointer=...                  # 可选，做对话记忆
)

result = app.invoke({"messages": [HumanMessage("3 + 5 = ?")]})
```

入参速查：
- `model`：原始 LLM，函数内部会 `bind_tools`
- `tools`：list[Tool] 或 `ToolNode`
- `state_modifier`：str / SystemMessage / 函数 `(state) -> messages`，定制 prompt
- `checkpointer`：见第 06 章
- `interrupt_before` / `interrupt_after`：见第 07 章

**何时用 prebuilt，何时手写？**
- 标准 ReAct → prebuilt
- 需要在 agent / tools 之间塞节点（如审计、缓存、降级）→ 手写
- 多 Agent 协作 → 手写 + 子图（见第 09 章）

## 6. 常见 Agent 模式

### 6.1 Plan-and-Execute

先让 LLM 出计划（list[step]），再循环执行：

```
user → planner → execute_step → done? → END
                      ▲           │
                      └─ replan ──┘
```

```python
class State(TypedDict):
    messages: Annotated[list, add_messages]
    plan: list[str]
    past_steps: Annotated[list[tuple], add]

def planner(state):
    plan = llm.with_structured_output(Plan).invoke(state["messages"])
    return {"plan": plan.steps}

def execute_step(state):
    step = state["plan"][0]
    result = agent_executor.invoke({"input": step})
    return {
        "past_steps": [(step, result)],
        "plan": state["plan"][1:],
    }

def should_end(state):
    return END if not state["plan"] else "execute"
```

### 6.2 Reflexion / Self-critique

生成 → 自我批判 → 改 → 直到达标：

```
generate → critique → quality? ─yes─► END
              │
              └── no ──► generate (with critique 作为 context)
```

### 6.3 Router Agent

一个"调度员" Agent 决定把请求分给哪个专家：

```
user → router → ┬─► sql_agent
                ├─► search_agent
                └─► math_agent
```

router 可以是 LLM（用 `with_structured_output` 出枚举），也可以是规则。

### 6.4 多 Agent 协作

见第 09 章。核心思路：每个 Agent 是一个**子图**，外层主图负责消息路由。

## 7. 工具设计的实战经验

### 7.1 工具粒度

- **太粗**：一个工具做 N 件事 → LLM 不知道怎么用、参数容易错
- **太细**：N 个工具做一件事 → LLM 来回切换、token 浪费
- **甜蜜点**：一个工具 = 一个明确的"能力"（如 `search_user`、`update_user_email`）

### 7.2 错误信息要"对 LLM 友好"

工具抛错时，错误消息会通过 `ToolMessage` 喂回给 LLM。写成"指导下一步"的形式：

```python
@tool
def book_flight(date: str, dest: str) -> str:
    if not is_valid_date(date):
        return "Error: date 必须是 YYYY-MM-DD 格式，例如 2026-01-15。请重新调用。"
    ...
```

### 7.3 副作用工具要谨慎

涉及 DB 写、付款、发邮件的工具——**强烈建议**接 Human-in-the-Loop（第 07 章），否则 LLM 误判会出大事。

### 7.4 长输出要截断或分页

如果一个工具能返回 100KB 文本，LLM 上下文会被吃爆。要么截断 + 提示"用 next_page 继续"，要么把全文存进 state 字段、只把摘要喂给 LLM。

## 8. 调试 Agent

### 8.1 看完整 messages 流

```python
for chunk in app.stream(state, stream_mode="values"):
    chunk["messages"][-1].pretty_print()
```

### 8.2 LangSmith 追踪

```bash
export LANGCHAIN_TRACING_V2=true
export LANGCHAIN_API_KEY=...
export LANGCHAIN_PROJECT=my-agent
```

每次 `invoke` 都会在 LangSmith 留下完整 trace，调试 Agent 几乎离不开它。

### 8.3 给 router 加日志

```python
def should_continue(state):
    decision = "tools" if state["messages"][-1].tool_calls else END
    print(f"[router] decision={decision}, last_msg={state['messages'][-1]}")
    return decision
```

## 9. 下一步

- [06-persistence.md](./06-persistence.md)：让 Agent 记住对话历史
- [07-human-in-the-loop.md](./07-human-in-the-loop.md)：高风险工具加审批
- [09-subgraphs.md](./09-subgraphs.md)：多 Agent 协作
