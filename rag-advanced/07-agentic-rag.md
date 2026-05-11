# 07 · Agentic RAG

> 前 6 章是"线性"的 RAG——固定流水线一条道跑到底。但真实问题不总是一次能搞定：检索可能返回垃圾、query 可能太模糊、问题可能要拆分。**Agentic RAG = 用 Agent 编排可选模块 + 必要时回头**。
>
> 这就是为什么本章主要用 **LangGraph** 实现——线性的 LCEL 表达不了循环和条件分支。

## 1. 三种主流 Agentic RAG 范式

学界三个代表性论文：

| 名字 | 一句话 | 关键创新 |
|---|---|---|
| **CRAG**（Corrective RAG, 2024） | 检索后**评估文档质量**，不够就走外部搜索 | 文档质量分类器 |
| **Self-RAG**（2023） | 让 LLM 自己决定"要不要检索"、"检索的结果有用吗"、"答案有没有支撑" | 反思 token |
| **Adaptive-RAG**（2024） | 先**分类问题难度**，简单走单跳，复杂走多跳 | query 分类器 |

它们的共同点：**用 LangGraph 风格的有向图 + 循环表达"必要时重来"**。

## 2. 通用图结构

```
                       ┌─── classify ───┐
                       │                │
                       ▼                ▼
            ┌── simple QA            multi-step
            │                            │
            ▼                            ▼
         direct LLM ◄─────► retrieve ──► grade
                                          │
                                ┌─────────┼──────────┐
                                ▼         ▼          ▼
                              good      partial      bad
                                │         │          │
                                ▼         ▼          ▼
                            generate   rewrite    web_search
                                │         │          │
                                │         └─►retrieve│
                                │                    │
                                ▼                    ▼
                              answer              generate
```

每个图都是这一类——**节点是动作（检索/评估/重写/搜索/回答），边是判断**。

## 3. CRAG：文档质量评估 + Web 兜底

### 3.1 思想

经典 RAG 的盲点：检索结果不行的时候，prompt 工程救不了。CRAG 的解法：

1. 检索完，加一个 **grader 节点**——LLM 给每个文档打 `relevant / ambiguous / irrelevant`
2. 如果**全 irrelevant**：query 重写后走**网络搜索**（外部知识源）
3. 如果**部分 ambiguous**：对相关部分做摘要 + 网络搜索补充
4. 如果**都 relevant**：正常生成

### 3.2 LangGraph 骨架

```python
from typing import TypedDict, Annotated
from langchain_core.messages import BaseMessage
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages

class State(TypedDict):
    question: str
    docs: list
    grade: str       # "good" | "bad" | "partial"
    web_docs: list
    answer: str

def retrieve(state):
    return {"docs": base_retriever.invoke(state["question"])}

def grade_docs(state):
    relevances = [grade_one(state["question"], d) for d in state["docs"]]
    if all(r == "irrelevant" for r in relevances):
        return {"grade": "bad"}
    if any(r == "irrelevant" for r in relevances):
        return {"grade": "partial", "docs": [d for d, r in zip(state["docs"], relevances) if r != "irrelevant"]}
    return {"grade": "good"}

def rewrite_query(state):
    new_q = rewrite_chain.invoke({"question": state["question"]})
    return {"question": new_q}

def web_search(state):
    return {"web_docs": tavily.invoke(state["question"])}

def generate(state):
    docs = state["docs"] + state.get("web_docs", [])
    return {"answer": qa_chain.invoke({"context": docs, "question": state["question"]})}

graph = StateGraph(State)
graph.add_node("retrieve", retrieve)
graph.add_node("grade", grade_docs)
graph.add_node("rewrite", rewrite_query)
graph.add_node("web_search", web_search)
graph.add_node("generate", generate)

graph.add_edge(START, "retrieve")
graph.add_edge("retrieve", "grade")
graph.add_conditional_edges("grade", lambda s: s["grade"], {
    "good":    "generate",
    "partial": "web_search",
    "bad":     "rewrite",
})
graph.add_edge("rewrite", "web_search")
graph.add_edge("web_search", "generate")
graph.add_edge("generate", END)

app = graph.compile()
```

要点：
- `grade_docs` 是关键——通常用结构化输出（[langchain/05](../langchain/05-output-parsers.md)）让 LLM 返回 `Literal["relevant", "irrelevant", "ambiguous"]`
- 网络搜索可以用 Tavily / SerpAPI / Bing
- `rewrite_query` 在 query 太差时改写，避免反复检索同样的烂结果

详见 LangGraph 学习笔记的 [04 · 控制流](../langgraph/04-control-flow.md) 和官方 CRAG 模板。

## 4. Self-RAG：自我反思

### 4.1 思想

Self-RAG 用一个**特殊微调过**的 LLM，能输出几种"反思 token"：

| Token | 含义 |
|---|---|
| `[Retrieve]` / `[No Retrieve]` | 当前需不需要检索 |
| `[Relevant]` / `[Irrelevant]` | 检索结果是否相关 |
| `[Supported]` / `[Partially]` / `[No support]` | 答案是否被上下文支持 |
| `[Useful: 5/4/3/2/1]` | 回答是否有用 |

工作流：

```
question
  │
  ▼ [Retrieve?]
  ├── No  → 直接 LLM 生成
  └── Yes → 检索
              │
              ▼ 对每个 doc
              [Relevant?]
              ├── No  → 丢
              └── Yes → 用它生成候选答案
                          │
                          ▼ [Supported?] [Useful?]
                          → 多个候选打分 → 选最高
```

### 4.2 实战版

实际工程中，**用普通 LLM 模拟 Self-RAG** 就够（不用专门微调）：

```python
def need_retrieve(state):
    out = llm.with_structured_output(NeedRetrieve).invoke(state["question"])
    return "retrieve" if out.needed else "direct_answer"

def grade_doc(state):
    grades = [grade_chain.invoke({"q": state["question"], "doc": d}) for d in state["docs"]]
    return {"docs": [d for d, g in zip(state["docs"], grades) if g.relevant]}

def grade_answer(state):
    g = grader_chain.invoke({"q": state["question"], "ans": state["answer"], "ctx": state["docs"]})
    if not g.supported and state["retry"] < 2:
        return "rewrite"
    return END
```

把这几个评估节点串进图，就有了 Self-RAG 的核心能力。

## 5. Adaptive-RAG：先分类，再分发

### 5.1 思想

不是所有问题都需要检索：

| 问题类型 | 应对 |
|---|---|
| 闲聊 / 通用知识 | LLM 直答 |
| 单跳事实查询 | 标准 RAG |
| 多跳推理 | Decomposition + 多次检索 |
| 复杂分析 | Plan-and-Execute |

Adaptive-RAG 的第一步就是**分类问题难度**，再走对应路径。

### 5.2 实现

```python
class Classification(BaseModel):
    route: Literal["direct", "single_hop", "multi_hop"]

classifier = (
    classify_prompt | llm.with_structured_output(Classification)
)

def route(state) -> str:
    return classifier.invoke({"question": state["question"]}).route

graph.add_conditional_edges(START, route, {
    "direct":     "direct_llm",
    "single_hop": "retrieve",
    "multi_hop":  "decompose",
})
```

### 5.3 何时值得做

- 流量大、问题分布广（B2C 客服、通用助手）
- 简单问题占多数（每个都跑全 RAG 浪费）
- 复杂问题占少数但很重要

如果你的所有问题都长得差不多（如"内部文档查询"），分类反而是 overhead。

## 6. 用 LangGraph 实现的几个共通模式

### 6.1 评估节点

不只是 CRAG/Self-RAG——任何复杂 RAG 都该加几个评估节点：

```python
def grade_relevance(state):
    """每个文档相关吗？"""
    ...

def grade_completeness(state):
    """检索结果够回答吗？"""
    ...

def grade_groundedness(state):
    """答案有上下文支撑吗？"""
    ...

def grade_answer_quality(state):
    """答案真的回答了问题吗？"""
    ...
```

每个评估节点都是一次"小 LLM 调用"，但**几个加起来通常比改 prompt 调一万次都有效**。

### 6.2 重试循环

```python
graph.add_conditional_edges("grade_groundedness", lambda s:
    "regenerate" if not s["grounded"] and s["retry"] < 2 else END,
)
graph.add_edge("regenerate", "generate")
```

注意 `recursion_limit`（[LangGraph 04](../langgraph/04-control-flow.md)）和**重试上限**——LLM 错一次很正常，错三次就该早早退出。

### 6.3 工具增强 RAG

不止"检索本地索引"，让 Agent 能选**多个数据源**：

```python
@tool
def search_docs(query: str) -> list:
    """搜索内部技术文档。"""
    return base_retriever.invoke(query)

@tool
def search_web(query: str) -> list:
    """搜索最新网络资讯。"""
    return tavily.invoke(query)

@tool
def query_database(sql: str) -> list:
    """查业务数据库。"""
    return db.execute(sql)

app = create_react_agent(llm, [search_docs, search_web, query_database])
```

这就回到 LangGraph 的 `create_react_agent`。每个数据源是个工具，Agent 自己决定调什么。

## 7. 一个完整的"生产级 Agentic RAG"骨架

把前面所有要素拼起来：

```
                  question
                     │
                     ▼
                 classify ──────────────► simple → direct_llm → END
                     │
                     ▼ (need retrieval)
              query_transform (rewrite / multi-query)
                     │
                     ▼
              hybrid_retrieve (BM25 + vector + filter)
                     │
                     ▼
                  rerank
                     │
                     ▼
              grade_docs ◄────────────────── retry < N
                 │  │  │
                 │  │  └─ bad      ─► rewrite_query / web_search ─┐
                 │  └─── partial   ─► web_search ─────────────────┤
                 └────── good      ─► generate                    │
                                       │                          │
                                       ▼                          │
                                grade_answer ─── bad ─────────────┘
                                       │
                                       ▼ good
                                      END
```

## 8. 复杂度的代价

Agentic RAG 不是免费午餐：

| 维度 | 普通 RAG | Agentic RAG |
|---|---|---|
| LLM 调用次数 | 1 | 3-10 |
| 延迟 | 1-3s | 5-15s |
| 成本 | $0.001-0.01 | $0.01-0.1 |
| 可调试性 | 高 | 复杂度上升 |
| 维护成本 | 低 | 高 |

**先把 Naive RAG 用评测框死**，证明它确实有解决不了的问题，再上 Agentic。否则只是把简单的事变复杂。

## 9. 调试 Agentic RAG

### 9.1 LangSmith trace

每个节点的输入输出都在树上看得到，**比单独 print 强 100 倍**。

### 9.2 流式 updates

```python
for chunk in app.stream(state, stream_mode="updates"):
    print(chunk)   # {"grade_docs": {"grade": "bad"}}
```

实时看哪个节点产出了什么——尤其是分类、评估节点的判断。

### 9.3 时间旅行回放

LangGraph Checkpointer（[LangGraph 06](../langgraph/06-persistence.md)）能让你回到任意一步重跑，**改 prompt 后立刻看效果**。

## 10. 常见坑

| 现象 | 原因 |
|---|---|
| grade_docs 全判 irrelevant | grader prompt 太严；放宽标准或用更大模型当 grader |
| 死循环重写 query | 没设 retry 上限；加 `state["retry"]` 计数 |
| 网络搜索返回不可信内容 | Web 结果要单独标注来源；prompt 让 LLM 区分内部/外部 |
| 性能差 | 评估节点太多，串行慢；评估节点用 mini 模型 + 异步 |
| Adaptive 分类不稳 | classifier 的 few-shot 要给真实例子；分类用结构化输出 |
| Self-RAG 答非所问 | 反思 token 没真正影响生成；让 grader 直接挡住坏答案，重新生成 |

## 11. 下一步

- [08 · 多模态与结构化](./08-multimodal-and-structured.md)：扩展到图片、表格、SQL
- [09 · 评测](./09-evaluation.md)：怎么评 Agentic RAG（端到端 + 节点级）
