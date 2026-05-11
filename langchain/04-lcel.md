# 04 · LCEL 与 Runnable

LCEL（LangChain Expression Language）= **用 `|` 把 Runnable 串起来**。表面上像 Unix 管道，背后给你的是统一的 `invoke / stream / batch / async / 重试 / fallback / LangSmith trace`。

## 1. 一切皆 Runnable

凡是 `Runnable`，都自带这些方法：

```python
r.invoke(x)         # 同步
r.batch([x1, x2])
r.stream(x)         # 流式（迭代 chunk）
await r.ainvoke(x)
await r.abatch([...])
async for c in r.astream(x): ...
```

LangChain 里的 LLM、Prompt、Parser、Retriever、自定义函数（包成 `RunnableLambda`）都是 Runnable，所以都能塞进链。

## 2. `|` 组合：基本规则

```python
chain = prompt | llm | parser
chain.invoke({"topic": "猫"})
```

数据流：

```
input dict ──► prompt ──► messages ──► llm ──► AIMessage ──► parser ──► str
```

每一段的输出类型必须能喂给下一段。**类型不对**就会在 `.invoke` 时报错——这是最常见的 bug。

## 3. 输入适配：dict / 单值 / passthrough

下游想要 dict 但上游给了 str 怎么办？三件套：

### 3.1 `RunnablePassthrough`：原样透传

```python
from langchain_core.runnables import RunnablePassthrough
RunnablePassthrough().invoke("hi")   # → "hi"
```

### 3.2 dict 字面量：并行计算多个字段

```python
from langchain_core.runnables import RunnablePassthrough

chain = (
    {"context": retriever, "question": RunnablePassthrough()}
    | prompt
    | llm
    | StrOutputParser()
)
chain.invoke("LangChain 是什么？")
```

dict 里每个值都是 Runnable，**并行执行**，结果合并成 dict 喂给下一步。这是 RAG 的经典模式。

### 3.3 `RunnableLambda`：把普通函数包成 Runnable

```python
from langchain_core.runnables import RunnableLambda

upper = RunnableLambda(lambda s: s.upper())
chain = upper | (lambda s: s + "!")   # 第二个 lambda 也会被自动包
chain.invoke("hi")  # → "HI!"
```

链里直接写 lambda 也行，LangChain 会自动包成 `RunnableLambda`。

### 3.4 `RunnablePassthrough.assign`：在 dict 上加字段

```python
chain = (
    RunnablePassthrough.assign(
        context=lambda x: retriever.invoke(x["question"])
    )
    | prompt | llm | parser
)
chain.invoke({"question": "..."})
# 内部 dict：{"question": "...", "context": [...docs...]}
```

非常适合"前面已经有 dict，再补一个字段"。

## 4. 并行：`RunnableParallel`

dict 字面量本质就是 `RunnableParallel`：

```python
from langchain_core.runnables import RunnableParallel

parallel = RunnableParallel(
    summary=summarize_chain,
    keywords=keywords_chain,
    sentiment=sentiment_chain,
)

result = parallel.invoke("一段长文本")
# {"summary": ..., "keywords": ..., "sentiment": ...}
```

三个子链**并行执行**，全部完成后合并。同步/异步都能并行；异步收益更大。

## 5. 分支：`RunnableBranch`

```python
from langchain_core.runnables import RunnableBranch

branch = RunnableBranch(
    (lambda x: x["lang"] == "zh", chinese_chain),
    (lambda x: x["lang"] == "en", english_chain),
    default_chain,   # 兜底
)
```

> 复杂分支建议用 LangGraph 的条件边。LCEL 的 branch 适合"两三个简单条件"。

## 6. 重试与 Fallback

```python
robust_llm = llm.with_retry(
    stop_after_attempt=3,
    retry_if_exception_type=(TimeoutError,),
)

resilient = main_llm.with_fallbacks([backup_llm])
```

链层面也能用：`chain.with_retry(...)`、`chain.with_fallbacks([...])`。

## 7. 配置注入：`with_config`、`configurable_fields`

### 7.1 给运行时打标签

```python
chain.with_config({"tags": ["prod", "rag"], "run_name": "qa-chain"})
```

LangSmith trace 上看得到，方便过滤。

### 7.2 让某些字段在调用时可改

```python
from langchain_core.runnables import ConfigurableField

llm = ChatOpenAI(model="gpt-4o-mini").configurable_fields(
    temperature=ConfigurableField(id="temp"),
)

chain = prompt | llm | parser
chain.invoke({"topic": "猫"}, config={"configurable": {"temp": 0.9}})
```

避免为不同温度建多份链。

### 7.3 切换实现：`configurable_alternatives`

```python
llm = ChatOpenAI(model="gpt-4o-mini").configurable_alternatives(
    ConfigurableField(id="model"),
    default_key="openai",
    anthropic=ChatAnthropic(model="claude-sonnet-4-5"),
    ollama=ChatOllama(model="qwen2.5:7b"),
)

chain.invoke(input, config={"configurable": {"model": "anthropic"}})
```

## 8. 流式

```python
for chunk in chain.stream({"topic": "RAG"}):
    print(chunk, end="", flush=True)
```

LCEL 链会**自动 propagate** 流式：上游边输出边喂给下游。但要求**链上每一步都是流式友好**——比如 `StrOutputParser` 是的；很多自定义函数不是（它需要拿到完整输入才能算）。

如果某一步不是流式友好的，那一步会先 buffer 全部输入，导致前面的流式效果在它之后中断。

## 9. 异步

```python
async def main():
    out = await chain.ainvoke({"topic": "异步"})
    async for c in chain.astream({"topic": "异步"}):
        print(c, end="")
```

**只要链里所有 Runnable 都支持异步**就能跑。`RunnableLambda(普通函数)` 也能在异步里跑（被丢线程池），但**自己写 `RunnableLambda(async def ...)`** 更原生。

## 10. 从 LCEL 到 LangGraph：什么时候该升级

LCEL 的 sweet spot：**单向数据流**——`输入 → 多步处理 → 输出`，不回头、不需要中间状态。

```
LCEL 适合：
  prompt | llm | parser
  retriever | prompt | llm | parser           （RAG）
  parallel(summary, keywords) | merge          （并行收集）
```

下面这些就**不适合 LCEL**，应该上 LangGraph：

- ❌ "调工具 → 看结果 → 决定要不要再调一次"（循环）
- ❌ "中断 → 等人审批 → 继续"（HITL）
- ❌ "多个 Agent 互相 handoff"（动态路由）
- ❌ 需要持久化中间状态（多轮对话、长任务）

判断标准：**有没有"回头"或"等待外部输入"** —— 有就该用 LangGraph。

> LangGraph 的节点内部，仍然推荐用 LCEL 链来组织"这一步的处理"。两者不是替代关系。

## 11. 调试 LCEL 链

### 11.1 看每一步的中间值

```python
from langchain_core.runnables import RunnableLambda

def trace(name):
    return RunnableLambda(lambda x: (print(f"[{name}] {x}"), x)[1])

chain = (
    trace("input")
    | prompt
    | trace("after prompt")
    | llm
    | trace("after llm")
    | parser
)
```

简单粗暴但有效。

### 11.2 LangSmith

设置 `LANGCHAIN_TRACING_V2=true` 后，每一步的输入输出、耗时、token 用量都会上报到 LangSmith UI。详见 [10 · 可观测](./10-observability-and-production.md)。

### 11.3 类型不匹配的快速定位

报错信息里通常会指名"哪一步出错"。从那一步开始，把上游链单独 `invoke` 一下，看类型对不对。

## 12. 完整示例：一条端到端 RAG 链

```python
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import RunnablePassthrough
from langchain_core.output_parsers import StrOutputParser
from langchain_openai import ChatOpenAI

# retriever 已经是 Runnable（见第 07 章）
def format_docs(docs):
    return "\n\n".join(d.page_content for d in docs)

prompt = ChatPromptTemplate.from_messages([
    ("system", "根据上下文回答。如果不知道就说不知道。\n\n上下文：\n{context}"),
    ("human", "{question}"),
])

chain = (
    {
        "context": retriever | format_docs,
        "question": RunnablePassthrough(),
    }
    | prompt
    | ChatOpenAI(model="gpt-4o-mini")
    | StrOutputParser()
)

chain.invoke("LangChain 0.1 改了什么？")
```

## 13. 常见坑

| 现象 | 原因 |
|---|---|
| `TypeError: ... not subscriptable` | 上下游类型不匹配；用 `trace` 中间打印检查 |
| 流式不流，整段一次给 | 链里某一步把整体 buffer 住（自定义函数、需要等齐输入的步骤） |
| 并行 dict 里 key 数量不对 | dict 里某个 value 不是 Runnable，被 LangChain 当字面量 |
| `RunnableLambda` 异步失效 | 同步函数会跑在线程池；要原生异步就传 `async def` |
| 链很长难调试 | 拆小链分别 `.invoke` 单测，再组装 |

## 14. 下一步

- [05 · 结构化输出](./05-output-parsers.md)：在 LCEL 里让 LLM 直接吐对象
- [06 · 工具调用](./06-tools-and-function-calling.md)
- [07 · RAG](./07-rag.md)：把 LCEL 用到一个完整应用上
