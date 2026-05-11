# 03 · Prompt 与 ChatModel

## 1. 消息（Messages）

现代 LLM 都是 chat 模型，输入是**消息列表**，不是单字符串。LangChain 在 `langchain_core.messages` 里定义了几种消息类型：

| 类型 | 作用 |
|---|---|
| `SystemMessage` | 系统设定（角色、风格、约束） |
| `HumanMessage` | 用户输入 |
| `AIMessage` | LLM 输出（含 `tool_calls`） |
| `ToolMessage` | 工具执行结果（要附带 `tool_call_id`） |
| `FunctionMessage` | 老的 OpenAI function 协议（已不推荐） |

```python
from langchain_core.messages import SystemMessage, HumanMessage, AIMessage

llm.invoke([
    SystemMessage("你是一个简洁的助手。"),
    HumanMessage("北京的省会是？"),
])
# AIMessage(content='北京就是直辖市，本身就是首都，不在省内。')
```

也支持 `tuple` 形式简写：

```python
llm.invoke([
    ("system", "你是一个简洁的助手。"),
    ("human", "北京的省会是？"),
])
```

## 2. PromptTemplate vs ChatPromptTemplate

| 类 | 输出 | 用途 |
|---|---|---|
| `PromptTemplate` | 单字符串 | 老式 completion 模型（基本不用了） |
| `ChatPromptTemplate` | 消息列表 | **绝大多数场景** |

### 2.1 基本用法

```python
from langchain_core.prompts import ChatPromptTemplate

prompt = ChatPromptTemplate.from_messages([
    ("system", "你是一个 {style} 风格的助手。"),
    ("human", "{question}"),
])

msgs = prompt.invoke({"style": "幽默", "question": "天空为什么是蓝的？"})
# msgs.to_messages() → [SystemMessage(...), HumanMessage(...)]
```

### 2.2 `from_template`（单条快捷方式）

```python
prompt = ChatPromptTemplate.from_template("用一句话介绍 {topic}。")
# 等价于 [("human", "用一句话介绍 {topic}。")]
```

### 2.3 部分变量预填：`.partial()`

```python
template = ChatPromptTemplate.from_messages([
    ("system", "现在时间：{now}。你是 {role}。"),
    ("human", "{q}"),
])

bound = template.partial(now="2026-05-08", role="助手")
bound.invoke({"q": "你好"})   # now / role 已经填好
```

## 3. 模板里塞历史消息：`MessagesPlaceholder`

对话场景下，要把"之前的对话"原样插入到 prompt 中：

```python
from langchain_core.prompts import MessagesPlaceholder

prompt = ChatPromptTemplate.from_messages([
    ("system", "你是助手。"),
    MessagesPlaceholder("history"),
    ("human", "{input}"),
])

prompt.invoke({
    "history": [HumanMessage("我叫小王"), AIMessage("好的小王。")],
    "input": "我叫什么？",
})
```

`MessagesPlaceholder` 期望一个**消息列表**，会原地展开。

## 4. Few-shot：把示例塞进 prompt

```python
from langchain_core.prompts import FewShotChatMessagePromptTemplate

examples = [
    {"input": "2 + 2", "output": "4"},
    {"input": "3 * 5", "output": "15"},
]

example_prompt = ChatPromptTemplate.from_messages([
    ("human", "{input}"),
    ("ai", "{output}"),
])

few_shot = FewShotChatMessagePromptTemplate(
    example_prompt=example_prompt,
    examples=examples,
)

final = ChatPromptTemplate.from_messages([
    ("system", "做算术，只回答数字。"),
    few_shot,
    ("human", "{input}"),
])

print(final.invoke({"input": "10 - 7"}).to_string())
```

更高级：根据用户输入**动态选示例**（`SemanticSimilarityExampleSelector`）—— 用 embedding 检索最相关的 N 条示例插进去。

## 5. ChatModel 的常用参数

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="gpt-4o-mini",
    temperature=0,           # 0 = 确定性最强；写代码/抽数据用 0
    max_tokens=512,          # 输出上限
    timeout=30,              # 超时秒
    max_retries=2,           # 失败重试
    api_key="...",           # 显式传；或走环境变量
    base_url="...",          # OpenAI 兼容代理
    model_kwargs={"top_p": 0.9},  # 透传到底层 SDK
)
```

不同厂商的具体字段不同，但**通用参数**（`temperature`, `max_tokens`, `timeout`, `max_retries`）都有。

## 6. 给模型动态绑定参数：`with_config` / `bind`

### 6.1 `bind`：绑定某些固定调用参数

```python
fast = llm.bind(temperature=0)        # 永远 t=0
creative = llm.bind(temperature=1.0)  # 永远 t=1
```

### 6.2 `bind_tools`：绑工具（详见 [06](./06-tools-and-function-calling.md)）

```python
llm_with_tools = llm.bind_tools([my_tool])
```

### 6.3 `with_config`：给链/调用打 tag、设运行时 config

```python
chain.with_config({"tags": ["main"], "run_name": "summary-chain"})
```

主要给 LangSmith / 流式过滤用。

## 7. 多模型 Fallback

```python
fast = ChatOpenAI(model="gpt-4o-mini")
backup = ChatAnthropic(model="claude-haiku-4-5")

llm = fast.with_fallbacks([backup])  # 主模型挂了自动切备用
```

适合：成本敏感的主模型 + 高可用备份；或反过来主用强模型、降级到便宜模型。

## 8. 缓存：避免重复计算

```python
from langchain.globals import set_llm_cache
from langchain.cache import SQLiteCache

set_llm_cache(SQLiteCache(database_path=".llm-cache.db"))
```

同样的输入命中缓存就不再调 API。开发期省钱省时；生产期慎用（输入有微小差异就 miss，且语义重复未必字面重复）。生产更推荐**业务级缓存**（按归一化的 key）。

## 9. 流式 token

```python
for chunk in llm.stream("写一首关于秋天的短诗"):
    print(chunk.content, end="", flush=True)
```

`chunk` 是 `AIMessageChunk`。链里 `chain.stream(...)` 同理。

## 10. 与 LangGraph 的衔接

LangGraph 的节点里几乎都会用到 `ChatPromptTemplate` 和 `ChatModel`：

```python
# LangGraph 节点
def agent_node(state):
    prompt = ChatPromptTemplate.from_messages([
        ("system", "你是助手。"),
        MessagesPlaceholder("messages"),
    ])
    llm_with_tools = ChatOpenAI(model="gpt-4o-mini").bind_tools(tools)
    chain = prompt | llm_with_tools
    return {"messages": [chain.invoke({"messages": state["messages"]})]}
```

LangChain 提供"组件 + 链"，LangGraph 负责"组件之间怎么编排"。

## 11. 常见坑

| 现象 | 原因 |
|---|---|
| `prompt.invoke(...)` 返回的不是字符串 | 它是 `ChatPromptValue`，下游 LLM 直接吃；要字符串用 `.to_string()` |
| 模板里的 `{x}` 被 KeyError | 变量名拼错，或忘了把所有 `{}` 都列在 input 里。要写字面 `{` 用 `{{` |
| MessagesPlaceholder 报错"missing key 'history'" | 调用时没传 `history`；或字段名不一致 |
| 多个 system message | 大多数模型只认开头一条 system；尽量合并 |
| `temperature=0` 但输出还是变 | 多数 API 对 t=0 也不保证完全确定；模型升级、负载均衡都会引入抖动 |

## 12. 下一步

- [04 · LCEL](./04-lcel.md)：`prompt | llm | parser` 背后的完整能力
- [05 · 结构化输出](./05-output-parsers.md)：让 LLM 吐 Pydantic 对象
