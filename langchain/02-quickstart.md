# 02 · 快速上手

目标：5 分钟跑通"Prompt → LLM → 解析"的最小链，建立 LangChain 的第一印象。

## 1. 安装

```bash
pip install -U langchain langchain-openai
```

需要其他模型时按需加：

```bash
pip install -U langchain-anthropic    # Claude
pip install -U langchain-ollama       # 本地（Llama / Qwen 等）
pip install -U langchain-google-genai # Gemini
```

## 2. 配置环境变量

```bash
export OPENAI_API_KEY=sk-...
# 国内代理：export OPENAI_BASE_URL=https://your-proxy/v1
```

## 3. 第一次调用：直接 invoke

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)
print(llm.invoke("用一句话介绍 LangChain。").content)
```

要点：
- `ChatOpenAI` 是一个 `Runnable`，对应 OpenAI 的 chat 接口
- `.invoke(input)` 输入可以是 `str` 或消息列表，输出是 `AIMessage`
- 不同厂商换 import 即可，行为一致：

```python
from langchain_anthropic import ChatAnthropic
llm = ChatAnthropic(model="claude-sonnet-4-5")
```

## 4. 加上 Prompt 模板

```python
from langchain_core.prompts import ChatPromptTemplate
from langchain_openai import ChatOpenAI
from langchain_core.output_parsers import StrOutputParser

prompt = ChatPromptTemplate.from_messages([
    ("system", "你是一个简洁的助手，回答不超过 20 字。"),
    ("human", "用一句话介绍 {topic}。"),
])

llm = ChatOpenAI(model="gpt-4o-mini")
parser = StrOutputParser()

chain = prompt | llm | parser     # ← LCEL：用 | 串成链

print(chain.invoke({"topic": "LangGraph"}))
# 输出：LangGraph 是用图编排有状态 LLM 应用的框架。
```

要点：
- `ChatPromptTemplate.from_messages([...])` 用占位符模板创建 prompt
- `| ` 把 Runnable 串起来：`{topic: "..."}` → prompt → `[messages]` → llm → `AIMessage` → parser → `str`
- `StrOutputParser()` 只取 `AIMessage.content`

## 5. 流式输出

```python
for chunk in chain.stream({"topic": "向量数据库"}):
    print(chunk, end="", flush=True)
```

任何 LCEL 链都自带 `.stream()`，不用改链结构。

## 6. 异步与批量

```python
import asyncio

async def main():
    answers = await chain.abatch([
        {"topic": "LangChain"},
        {"topic": "LangGraph"},
        {"topic": "RAG"},
    ])
    print(answers)

asyncio.run(main())
```

`invoke` / `batch` / `stream` 都有对应的 `ainvoke` / `abatch` / `astream`。

## 7. 结构化输出（一次预览）

让 LLM 直接吐 Pydantic 对象：

```python
from pydantic import BaseModel, Field
from langchain_openai import ChatOpenAI

class Movie(BaseModel):
    title: str = Field(description="电影名")
    year: int = Field(description="上映年份")
    rating: float = Field(description="豆瓣评分 0-10")

llm = ChatOpenAI(model="gpt-4o-mini").with_structured_output(Movie)

result = llm.invoke("推荐一部 2023 年的科幻片，给出标题、年份、评分")
print(result)
# Movie(title='奥本海默', year=2023, rating=8.9)
```

`with_structured_output` 内部用模型的 tool calling 能力做了 schema 约束。详见 [05 · 结构化输出](./05-output-parsers.md)。

## 8. 切换模型只改一行

```python
# OpenAI
from langchain_openai import ChatOpenAI
llm = ChatOpenAI(model="gpt-4o-mini")

# Anthropic
# from langchain_anthropic import ChatAnthropic
# llm = ChatAnthropic(model="claude-sonnet-4-5")

# 本地
# from langchain_ollama import ChatOllama
# llm = ChatOllama(model="qwen2.5:7b")

# 链不动：
chain = prompt | llm | parser
```

这是 LangChain 最大的卖点之一——**接口抽象**。

## 9. 常见坑

| 现象 | 原因 |
|---|---|
| `from langchain.chat_models import ...` 报弃用 | 老 API；改用 `from langchain_openai import ChatOpenAI` |
| `ImportError: langchain_openai not found` | 没装：`pip install -U langchain-openai` |
| 输出是 `AIMessage` 不是字符串 | 加上 `StrOutputParser()` 或取 `.content` |
| 中文出现繁体 / 啰嗦 | system prompt 加约束，或 `temperature=0` |
| 国内调用超时 | 设 `OPENAI_BASE_URL` 走代理；或 timeout：`ChatOpenAI(timeout=30)` |
| 流式没效果 | 部分 wrapper 默认未开 streaming，多数 ChatModel 无需配置；如果用了 `.invoke` 就没流，要 `.stream` |

## 10. 下一步

- [03 · Prompt 与 ChatModel](./03-prompts-and-models.md)：把 prompt 玩明白
- [04 · LCEL](./04-lcel.md)：`|` 背后的全部能力
