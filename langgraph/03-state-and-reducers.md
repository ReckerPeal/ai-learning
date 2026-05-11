# 03 · 状态与 Reducer

State 是 LangGraph 的灵魂。设计好 state，图的代码会非常清爽；设计不好，处处都是 hack。

## 1. State 的定义方式

支持三种：`TypedDict`（最常用）、`Pydantic BaseModel`、`dataclass`。

### 1.1 TypedDict

```python
from typing import TypedDict, Annotated
from operator import add

class State(TypedDict):
    messages: Annotated[list, add]
    user_id: str
    step: int
```

优点：轻量、IDE 支持好。缺点：**没有运行时校验**。

### 1.2 Pydantic（推荐用于复杂场景）

```python
from pydantic import BaseModel, Field
from typing import Annotated
from operator import add

class State(BaseModel):
    messages: Annotated[list, add] = Field(default_factory=list)
    user_id: str = ""
    step: int = 0
```

优点：运行时校验、字段默认值、序列化好。**注意**：在 Pydantic 模型上用 `Annotated[..., reducer]` 需要 LangGraph ≥ 0.2。

### 1.3 输入/输出 Schema 分离

有时候希望"对外只暴露一部分 state"：

```python
class InputState(TypedDict):
    question: str

class OutputState(TypedDict):
    answer: str

class InternalState(InputState, OutputState):
    intermediate_steps: list

graph = StateGraph(InternalState, input=InputState, output=OutputState)
```

调用方只看见 `question` 进、`answer` 出，内部步骤被隐藏。

## 2. Reducer：合并的核心

节点返回的是**部分 state**，框架按字段调用 reducer 合并。

### 2.1 默认行为：覆盖

```python
class State(TypedDict):
    counter: int  # 没有 reducer

# 节点返回 {"counter": 5} → state["counter"] 直接变成 5
```

### 2.2 常见 reducer

```python
from operator import add
from typing import Annotated

class State(TypedDict):
    items: Annotated[list, add]           # 列表追加
    total: Annotated[int, add]            # 数字累加
    flags: Annotated[set, lambda a, b: a | b]  # 集合并集
    config: Annotated[dict, lambda a, b: {**a, **b}]  # 字典合并
```

### 2.3 官方提供的 `add_messages`

专门给消息列表用的，比 `add` 更聪明：

```python
from langgraph.graph.message import add_messages

class State(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]
```

`add_messages` 的特性：

1. **追加**新消息到旧列表
2. 如果新消息有相同的 `id`，**替换**旧消息（用于编辑历史）
3. 自动把 `dict` / `str` 转成对应的 `Message` 对象
4. 支持通过 `RemoveMessage` 删除指定 id 的消息

```python
from langchain_core.messages import RemoveMessage, AIMessage

# 在节点里删除某条消息
def trim_node(state):
    return {"messages": [RemoveMessage(id=state["messages"][0].id)]}
```

### 2.4 自定义 reducer

任何 `(old, new) -> merged` 的纯函数都行：

```python
def merge_unique(old: list, new: list) -> list:
    """追加但去重。"""
    seen = set(old)
    result = list(old)
    for item in new:
        if item not in seen:
            result.append(item)
            seen.add(item)
    return result

class State(TypedDict):
    visited_urls: Annotated[list[str], merge_unique]
```

**reducer 必须是纯函数**：不要在里面写 IO、不要 mutate 入参（返回新对象）。

## 3. 节点返回值规则

### 3.1 只返回需要更新的字段

```python
class State(TypedDict):
    a: int
    b: int
    c: int

def node(state):
    return {"a": 1}  # 只更新 a，b 和 c 保持不变
```

### 3.2 返回空字典 = 不更新任何字段

```python
def side_effect_node(state):
    log_to_db(state)
    return {}   # 合法
```

### 3.3 返回 `None` 也算"不更新"

但**不推荐**，显式返回 `{}` 更清晰。

### 3.4 想"清空"一个有 reducer 的字段？

reducer 决定了你不能直接覆盖。两种办法：

```python
# 办法 1：在 reducer 里识别哨兵值
def add_or_reset(old, new):
    if new == "RESET":
        return []
    return old + new

# 办法 2：把"重置"做成单独的字段
class State(TypedDict):
    messages: Annotated[list, add_messages]
    reset_signal: bool
```

## 4. State 设计原则

### 4.1 扁平 > 嵌套

```python
# ❌ 不好：深层嵌套很难写 reducer
class State(TypedDict):
    user: dict  # {"profile": {...}, "history": [...]}

# ✅ 好：摊平
class State(TypedDict):
    user_profile: dict
    user_history: Annotated[list, add]
```

### 4.2 显式 > 隐式

需要在节点间共享的，**全部进 state**。不要用全局变量、闭包、外部数据库当"隐藏 state"——这会让 checkpoint、回放、调试全部失效。

### 4.3 Schema 稳定

state schema 一旦发布，加字段容易，**改/删字段会破坏旧的 checkpoint**。设计时多想一步。

### 4.4 大对象用引用

如果某个字段会很大（比如检索到的 100 个文档），考虑：

- 存指针/ID，按需重新加载
- 或者放进**外部存储**（向量库、对象存储），state 里只放 key

避免每个 checkpoint 都把 100MB 文档序列化一遍。

## 5. 完整示例：一个带统计的对话 state

```python
from typing import TypedDict, Annotated
from operator import add
from langchain_core.messages import BaseMessage
from langgraph.graph.message import add_messages


class ChatState(TypedDict):
    # 对话历史：用 add_messages
    messages: Annotated[list[BaseMessage], add_messages]

    # 累计 token 用量：累加
    total_tokens: Annotated[int, add]

    # 用户信息：覆盖（每次登录刷新）
    user_id: str

    # 当前轮的检索文档：覆盖（每轮重置）
    retrieved_docs: list[str]

    # 已访问过的工具：去重并集
    used_tools: Annotated[set[str], lambda a, b: a | b]
```

## 6. 调试技巧

### 6.1 打印 state schema

```python
print(app.get_graph().nodes)
print(app.get_input_schema().schema())   # JSON Schema
```

### 6.2 单步检查

用 `stream(stream_mode="values")` 看每一步后的完整 state：

```python
for snapshot in app.stream(initial_state, stream_mode="values"):
    print("---")
    print(snapshot)
```

### 6.3 reducer 逻辑可单测

reducer 是纯函数，直接写单测就行：

```python
def test_merge_unique():
    assert merge_unique([1, 2], [2, 3]) == [1, 2, 3]
```

## 7. 下一步

- [04-control-flow.md](./04-control-flow.md)：在 state 之上玩转条件边、循环、并行
- [06-persistence.md](./06-persistence.md)：state 怎么持久化（checkpoint）
