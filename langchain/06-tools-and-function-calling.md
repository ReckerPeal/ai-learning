# 06 · 工具与函数调用

LLM 自己只能"思考"，要让它"做事"——查数据库、调 API、算数学——必须给它**工具**。LangChain 把工具抽象成 `Tool`/`BaseTool`，主流模型用 tool calling 协议，跟 [05 · 结构化输出](./05-output-parsers.md) 是同一套机制的两种用法。

## 1. 定义工具：`@tool` 装饰器

```python
from langchain_core.tools import tool

@tool
def add(a: int, b: int) -> int:
    """两个整数相加。"""
    return a + b
```

要点：
- **docstring 必填且重要**——LLM 用它判断什么时候用
- 类型注解会被转成 JSON Schema
- `@tool` 把普通函数包成 `Tool` 对象（也是 Runnable）

直接调用：

```python
add.invoke({"a": 1, "b": 2})    # → 3
```

## 2. 复杂参数：Pydantic schema

```python
from pydantic import BaseModel, Field
from langchain_core.tools import tool

class SearchInput(BaseModel):
    query: str = Field(description="搜索关键词")
    top_k: int = Field(default=3, description="返回条数", ge=1, le=10)

@tool(args_schema=SearchInput)
def search(query: str, top_k: int = 3) -> str:
    """搜索并返回前 top_k 条摘要。"""
    ...
```

适合：参数多、要校验、有约束（min/max/枚举）。

## 3. 给模型绑工具：`bind_tools`

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(model="gpt-4o-mini")
llm_with_tools = llm.bind_tools([add, search])

resp = llm_with_tools.invoke("3 + 5 = ?")
print(resp.tool_calls)
# [{'name': 'add', 'args': {'a': 3, 'b': 5}, 'id': 'call_abc123', 'type': 'tool_call'}]
```

`bind_tools` 把工具 schema 注入给 LLM。模型回复的 `AIMessage` 会带 `tool_calls`：是一个**结构化决定列表**——但**没有真的执行**，需要你自己跑。

## 4. 执行工具调用

### 4.1 手工执行

```python
tools_by_name = {t.name: t for t in [add, search]}

resp = llm_with_tools.invoke("3 + 5 = ?")
for call in resp.tool_calls:
    tool = tools_by_name[call["name"]]
    result = tool.invoke(call["args"])
    print(f"{call['name']}({call['args']}) = {result}")
```

### 4.2 一次让 LLM 看到结果再回答（手写循环）

```python
from langchain_core.messages import ToolMessage, HumanMessage

messages = [HumanMessage("3 + 5 加 7 等于多少？")]
while True:
    resp = llm_with_tools.invoke(messages)
    messages.append(resp)
    if not resp.tool_calls:
        break    # LLM 不再调工具，结束
    for call in resp.tool_calls:
        result = tools_by_name[call["name"]].invoke(call["args"])
        messages.append(ToolMessage(content=str(result), tool_call_id=call["id"]))

print(resp.content)
```

⚠️ **这就是 ReAct 循环**——手写一次有教学价值，但生产**强烈推荐用 LangGraph 的 `create_react_agent`**：

- 自动处理循环、并行 tool calls、错误恢复
- 一行代码搞定
- 详见 LangGraph 学习仓的 [02-quickstart.md](../langgraph/02-quickstart.md) 第 6 节、[05-tools-and-agents.md](../langgraph/05-tools-and-agents.md)

## 5. 并行 tool calls

主流模型（GPT-4 系列、Claude 等）一次可以决定**同时调多个工具**。`resp.tool_calls` 会是个多元素列表。手写循环时记得**全部执行完**再回 LLM：

```python
import asyncio

async def run_calls(calls):
    return await asyncio.gather(*[
        tools_by_name[c["name"]].ainvoke(c["args"]) for c in calls
    ])
```

LangGraph 的 `ToolNode` 默认并行执行，省心。

## 6. 工具与结构化输出的关系

它们底层是**同一个机制**（tool calling），区别在用法：

| 用法 | 目的 | 关键 API |
|---|---|---|
| 工具调用 | 让 LLM 决定**调哪个工具、传什么参数** | `bind_tools([t1, t2])` |
| 结构化输出 | 让 LLM 按 schema **吐对象** | `with_structured_output(Schema)` |

可以同时用：

```python
llm.bind_tools([add, search]).with_structured_output(FinalAnswer)
```

——告诉 LLM"先用工具，结束时按 FinalAnswer 格式给最终答案"。

## 7. 工具内拿到运行时上下文：`InjectedToolArg`

有些参数你不想让 LLM 看到（如 user_id、auth token），但工具又需要。用 `InjectedToolArg`：

```python
from typing import Annotated
from langchain_core.tools import tool, InjectedToolArg

@tool
def get_orders(
    status: str,
    user_id: Annotated[str, InjectedToolArg],   # 不暴露给 LLM
) -> list:
    """查询当前用户的订单。"""
    return db.query(user_id, status)

# 调用方拼参数
result = get_orders.invoke({"status": "paid", "user_id": "u-123"})
```

LLM 看到的 schema 里**没有** `user_id`；执行前由你的代码注入。在 LangGraph 里配合 `RunnableConfig` 自动注入，更优雅。

## 8. 错误处理

工具会抛错（参数错、外部 API 挂）。两种处理：

### 8.1 让错误回传给 LLM（推荐）

```python
@tool
def divide(a: float, b: float) -> float:
    """除法。"""
    if b == 0:
        return "Error: 除数不能为 0，请重新提供参数。"
    return a / b
```

LLM 看到错误后通常会自动改参数重试。LangGraph 的 `ToolNode(handle_tool_errors=True)` 把异常自动包成 `ToolMessage`，效果一样。

### 8.2 完全屏蔽错误

```python
@tool
def safe_search(query: str) -> str:
    """搜索（不会抛错）。"""
    try:
        return search_api(query)
    except Exception as e:
        return f"(搜索失败：{e})"
```

## 9. 实战经验

### 9.1 工具粒度

- **太粗**：一个工具做多件事，LLM 不知道怎么用
- **太细**：N 个相似工具，浪费 token
- **甜蜜点**：每个工具 = 一个清晰能力（`get_user` / `update_user_email` / `delete_user`）

### 9.2 描述要"对 LLM 说话"

```python
# ❌ 给人看的
"""更新数据库中用户的邮箱。"""

# ✅ 给 LLM 看的
"""更新指定用户的邮箱。仅在用户明确请求修改邮箱时调用。需要 user_id 和 new_email。"""
```

### 9.3 副作用工具走 HITL

涉及钱、数据删除、对外发消息的工具——**必须**在执行前加人工确认。这是 LangGraph 的强项（见 [LangGraph 07](../langgraph/07-human-in-the-loop.md)），LangChain 本身不提供原生 HITL。

### 9.4 长输出截断

工具返回 100KB 文本会吃爆上下文。要么截断，要么把全文存外部、只把 ID + 摘要喂给 LLM。

### 9.5 工具命名

用 `verb_object` 风格：`search_web`、`get_weather`、`book_flight`。**不要重名**——LLM 会困惑。

## 10. 与 LangGraph 的关系

LangChain 提供"工具的定义和调用机制"，LangGraph 提供"用工具的 Agent 编排"：

```
LangChain：       LangGraph：
─────────         ─────────
@tool 定义工具  → 直接复用
bind_tools     → 在节点里用
手写 ReAct 循环 → 用 ToolNode + create_react_agent 替代
```

如果你的需求是**单次工具调用**（比如让 LLM 调一次搜索就出答案），LangChain 够用。
如果是**多步推理 + 反复调工具**，转 LangGraph。

## 11. 常见坑

| 现象 | 原因 |
|---|---|
| `bind_tools` 后 `tool_calls` 始终为空 | 模型不支持 tool calling；或 prompt 引导不够 |
| 工具被反复调用同一个 | LLM 没看到上一次的结果——确认你把 `ToolMessage` 加回 messages 了 |
| `ToolMessage` 报 `tool_call_id` 不匹配 | 没把 LLM 返回的 `call["id"]` 原样传回 |
| docstring 没了 | 用了 `functools.wraps` 之类的装饰，覆盖掉了；用原函数 |
| 多工具时 LLM 选错 | 工具描述区分度不够，加更具体的 description / 加 few-shot |
| 流式时 tool_calls 拼接异常 | 用 `AIMessageChunk` 累加；推荐别在流式中段处理工具，等完整 message 再处理 |

## 12. 下一步

- [05 · 结构化输出](./05-output-parsers.md)：tool calling 的"另一种用法"
- LangGraph [05 · 工具与 Agent](../langgraph/05-tools-and-agents.md)：用 LangGraph 编排工具循环
