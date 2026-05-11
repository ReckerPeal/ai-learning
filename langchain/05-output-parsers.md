# 05 · 结构化输出

让 LLM 吐字符串容易，吐**可信、可校验的结构化对象**才是工程上最需要的。本章覆盖：

1. `with_structured_output`（首选）
2. `OutputParser` 家族（兜底/老路径）
3. 流式结构化输出
4. 失败重试与校正

## 1. 首选：`with_structured_output`

主流模型（OpenAI / Anthropic / Gemini / 通义 / DeepSeek）都支持 tool calling。LangChain 把它包成统一接口：

```python
from pydantic import BaseModel, Field
from langchain_openai import ChatOpenAI

class Movie(BaseModel):
    title: str = Field(description="电影标题")
    year: int = Field(description="上映年份")
    rating: float = Field(ge=0, le=10, description="评分 0-10")

llm = ChatOpenAI(model="gpt-4o-mini").with_structured_output(Movie)
result = llm.invoke("推荐一部 2023 年的科幻片：标题、年份、评分")
print(result)            # Movie(title='奥本海默', year=2023, rating=8.9)
print(type(result))      # <class '__main__.Movie'>
```

要点：
- 内部走模型的 tool calling，schema 由 Pydantic 自动生成
- 支持嵌套 model、`list[Model]`、`Optional`、枚举
- 校验由 Pydantic 完成——不合规会直接抛错

### 1.1 用 `TypedDict` / dict schema

```python
from typing import TypedDict

class Movie(TypedDict):
    title: str
    year: int

llm.with_structured_output(Movie)   # 也行
```

或直接给 JSON schema：

```python
schema = {"title": "Movie", "type": "object", "properties": {...}, "required": [...]}
llm.with_structured_output(schema)
```

### 1.2 选择实现方式：`method=`

```python
llm.with_structured_output(Movie, method="function_calling")  # 默认（兼容老协议）
llm.with_structured_output(Movie, method="json_mode")          # 仅 JSON 约束
llm.with_structured_output(Movie, method="json_schema")        # 强约束（部分模型）
```

不同模型支持的 method 不同——一般用默认就行。

### 1.3 拿到原始 AIMessage：`include_raw=True`

```python
result = llm.with_structured_output(Movie, include_raw=True).invoke("...")
# {"raw": AIMessage(...), "parsed": Movie(...), "parsing_error": None}
```

适合需要同时看 reasoning 和结构化输出的场景。

## 2. 多种输出之一：`Union`

```python
from typing import Union

class Movie(BaseModel): ...
class Book(BaseModel): ...

class Recommendation(BaseModel):
    item: Union[Movie, Book]
    reason: str

llm.with_structured_output(Recommendation).invoke("推荐点什么放松一下")
```

或者直接 `with_structured_output(Union[Movie, Book])` —— 模型会自己选一个 schema。

## 3. 列表输出

```python
class Movie(BaseModel):
    title: str
    year: int

# 想要 list[Movie] 时不能直接传 list[Movie]，包一层：
class Movies(BaseModel):
    items: list[Movie]

llm.with_structured_output(Movies).invoke("推荐 3 部经典科幻电影")
```

（部分模型/方法直接支持 `list[Movie]`，但用容器类更稳。）

## 4. OutputParser：另一条路径

`with_structured_output` 是新路径；老的 `OutputParser` 仍然有用：

| Parser | 输出 | 何时用 |
|---|---|---|
| `StrOutputParser` | str | 只想要文字 |
| `JsonOutputParser` | dict / Pydantic | 模型不支持 tool calling，但能输出 JSON |
| `PydanticOutputParser` | Pydantic 对象 | 同上，更严格 |
| `CommaSeparatedListOutputParser` | list[str] | 简单逗号列表 |
| `XMLOutputParser` | dict | 模型偏好 XML（部分老模型） |
| `OutputFixingParser` | 包装上面的 | 解析失败时让 LLM 重写 |
| `RetryOutputParser` | 包装上面的 | 解析失败时整体重试 |

### 4.1 `PydanticOutputParser` + 注入格式说明

```python
from langchain_core.output_parsers import PydanticOutputParser
from langchain_core.prompts import ChatPromptTemplate

parser = PydanticOutputParser(pydantic_object=Movie)

prompt = ChatPromptTemplate.from_messages([
    ("system", "按格式输出。\n\n{format_instructions}"),
    ("human", "{question}"),
]).partial(format_instructions=parser.get_format_instructions())

chain = prompt | llm | parser
chain.invoke({"question": "推荐一部 2023 年科幻片"})
```

`get_format_instructions()` 会生成一段 schema 描述塞进 prompt。比 `with_structured_output` 啰嗦，但**任何模型都能用**——包括不支持 tool calling 的本地模型。

### 4.2 `OutputFixingParser`：解析失败自动修

```python
from langchain.output_parsers import OutputFixingParser

robust = OutputFixingParser.from_llm(parser=parser, llm=llm)
robust.parse(broken_text)   # 失败时再调一次 LLM 让它修
```

## 5. 流式结构化输出

`with_structured_output` 也支持流式——每次拿到的是**部分填充的对象**：

```python
for chunk in llm.with_structured_output(Movie).stream("推荐..."):
    print(chunk)   # Movie(title='奥本...', year=None, rating=None) → 渐进填充
```

适合：
- 前端展示"正在生成结构化数据"的进度
- 长 schema（多个字段）

`JsonOutputParser` 也支持流式，吐出渐进的 dict。

## 6. 实战经验

### 6.1 字段加 `description`

`description` 会被发给 LLM，是**最有效的命中率提升手段**：

```python
class Invoice(BaseModel):
    total: float = Field(description="总金额，单位元，含税")
    date: str = Field(description="开票日期，格式 YYYY-MM-DD")
```

不写 description，模型只能从字段名猜——容易出错。

### 6.2 用枚举 / `Literal` 约束

```python
from typing import Literal

class Sentiment(BaseModel):
    label: Literal["positive", "negative", "neutral"]
    confidence: float
```

模型只能填这三个值之一，省得后面写 if/else 兜底。

### 6.3 嵌套不要太深

实测：**两层嵌套是甜蜜点**。三层以上模型容易丢字段、混淆层级。可以拆成多次调用。

### 6.4 `Optional` 和默认值

```python
class Profile(BaseModel):
    name: str
    age: int | None = None
    bio: str = ""
```

模型对 `Optional` 的语义不一定对齐你的预期——必要时在 description 里写明"如果用户没说就填 None"。

### 6.5 在 LCEL / LangGraph 中用

```python
# LCEL
chain = prompt | llm.with_structured_output(Movie)

# LangGraph 节点
def classify(state):
    out = llm.with_structured_output(Sentiment).invoke(state["text"])
    return {"sentiment": out.label, "confidence": out.confidence}
```

LangGraph 的 router 经常用结构化输出做"决定下一步走哪个节点"——比让 LLM 输出自由文本然后正则解析靠谱得多。

## 7. 常见坑

| 现象 | 原因 |
|---|---|
| `with_structured_output` 报模型不支持 | 换有 tool calling 能力的模型；或换 `method="json_mode"` |
| Pydantic 校验失败 | LLM 漏字段或类型错；加 description / 用 `OutputFixingParser` 兜底 |
| 中文字段名识别差 | 字段名用英文，description 写中文 |
| 输出对，但内容不准 | 这是模型问题，不是解析问题；改 prompt / 加 few-shot / 换模型 |
| `list[Model]` 时报 schema 错 | 用容器类（`class Items(BaseModel): items: list[Model]`） |
| 流式 `with_structured_output` 不工作 | 部分 method（如严格 json_schema）不支持流式 |

## 8. 下一步

- [06 · 工具与函数调用](./06-tools-and-function-calling.md)：`with_structured_output` 的"亲戚"
- [07 · RAG](./07-rag.md)：在检索结果上做结构化抽取
