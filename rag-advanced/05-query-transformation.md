# 05 · Query 变换

用户的 query 经常**不利于检索**——太短、太口语、有歧义、含多个问题。Query 变换就是在 embed 之前对 query 做加工，让它更适合命中索引。

## 1. 五种主流变换

| 名字 | 核心动作 | 适合 |
|---|---|---|
| **Multi-Query** | 用 LLM 把 query 改写成 N 个不同表达，分别检索后合并 | 单一 query 表达不全 |
| **HyDE** | 让 LLM 生成"假设答案"，用答案的 embedding 去检索 | query 和文档语义距离大 |
| **Step-back** | 把具体 query 抽象成更高层的问题 | 需要先理解大背景的问题 |
| **Decomposition** | 把多跳问题拆成子问题 | 多跳推理 / 复杂问答 |
| **RAG-Fusion** | Multi-Query + RRF 融合 | Multi-Query 的标准升级版 |

## 2. Multi-Query

### 2.1 原理

一个问题用户可能有多种表达方式，索引里也可能有不同表达。让 LLM 生成 3-5 个**等价但措辞不同**的 query，分别检索，结果合并去重：

```
原 query: "怎么解决 504 超时"
LLM 改写：
  - "504 Gateway Timeout 错误的处理方法"
  - "服务器超时返回 504 应该怎么办"
  - "网关超时 504 的常见原因和解决方案"
分别检索 → 合并 → 去重
```

### 2.2 LangChain 实现

```python
from langchain.retrievers.multi_query import MultiQueryRetriever
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)

retriever = MultiQueryRetriever.from_llm(
    retriever=base_retriever,
    llm=llm,
)

docs = retriever.invoke("怎么解决 504 超时")
```

默认会生成 3 个变体。要自定义 prompt：

```python
from langchain_core.prompts import PromptTemplate

QUERY_PROMPT = PromptTemplate(
    input_variables=["question"],
    template="""你是 AI 检索助手。请把下面的用户问题改写成 3 个语义等价但措辞不同的检索 query，每行一个：

问题：{question}""",
)

retriever = MultiQueryRetriever.from_llm(
    retriever=base_retriever,
    llm=llm,
    prompt=QUERY_PROMPT,
)
```

### 2.3 代价

每次查询多 1 次 LLM + N 次检索（并行）。延迟 +1-2 秒，token 成本几乎可以忽略（用便宜模型即可）。

## 3. HyDE（Hypothetical Document Embeddings）

### 3.1 原理

直觉：**问题** 和 **答案** 的 embedding 距离比想象中大。索引里存的是"答案/陈述"，用户给的是"问题"——直接 embed 问题去检索，先天劣势。

HyDE 的解法：让 LLM 先**编一个理想答案**（即使不准），然后 embed 这个假答案去检索：

```
query: "RAG 是什么？"
↓ LLM 假设性回答
"RAG 是检索增强生成的简称，它结合了向量检索和大语言模型..."
↓ embed 这段
↓ 拿这个向量去检索
召回真实文档
```

假答案的"内容真假"无所谓，只要**语义结构像目标文档**就行——embedding 看的是语义相似度。

### 3.2 实现

```python
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import RunnablePassthrough
from langchain_core.output_parsers import StrOutputParser

hyde_prompt = ChatPromptTemplate.from_template(
    "请写一段简短的回答（即使你不确定）：\n\n{question}"
)

# 1) HyDE 生成假答案 → 直接当 retriever 的输入
hyde_chain = hyde_prompt | llm | StrOutputParser()

def hyde_retrieve(question: str):
    fake_answer = hyde_chain.invoke({"question": question})
    return base_retriever.invoke(fake_answer)
```

或更原生地把"对哪段做 embedding"自定义，但通常上面这种写法够用。

### 3.3 何时有效

- query 是**问题形式**，索引是**陈述/文档**——HyDE 提升明显
- query 已经很像文档（如 "Python 装饰器的语法"）——HyDE 收益小，甚至有反效果

## 4. Step-back（退一步思考）

### 4.1 原理

某些 query 太具体，先抽象成更高层的问题，**两层都检索**，最后合并：

```
具体 query: "为什么 GPT-4 在我这个 8K 上下文场景里幻觉率比 GPT-3.5 还高？"
↓ Step-back
抽象 query: "影响 LLM 幻觉率的因素有哪些？"

两个 query 都检索，把高层文档（背景知识）和具体文档（针对性内容）都放进 prompt
```

适合：用户问得很尖锐 / 很特殊，但需要先理解通用原理才能答。

### 4.2 实现

```python
step_back_prompt = ChatPromptTemplate.from_template(
    "把下面的具体问题，改写成一个更高层、更抽象的问题：\n\n{question}"
)

step_back_chain = step_back_prompt | llm | StrOutputParser()

def retrieve_with_step_back(question: str):
    high_level = step_back_chain.invoke({"question": question})
    docs1 = base_retriever.invoke(question)       # 具体 query
    docs2 = base_retriever.invoke(high_level)     # 抽象 query
    return docs1 + docs2  # 合并，去重交给下游
```

## 5. Decomposition（问题分解）

### 5.1 原理

多跳问题需要分步：

```
原问题: "OpenAI 现任 CEO 的母校在哪个州？"
↓ 分解
子问题 1: OpenAI 现任 CEO 是谁？
子问题 2: <CEO 名字> 的母校是哪所大学？
子问题 3: <大学名字> 在哪个州？
```

每个子问题独立检索 + 回答，最后再用 LLM 综合答案。

### 5.2 两种执行方式

**串行**：子问题间有依赖，前一个的答案是后一个的输入。
**并行**：子问题各自独立，最后合并。

```python
decompose_prompt = ChatPromptTemplate.from_template(
    "把下面这个复杂问题拆成 2-4 个独立的子问题，每行一个：\n\n{question}"
)

def answer_complex(question):
    sub_qs = decompose_prompt | llm | StrOutputParser() | (lambda s: s.strip().split("\n"))
    sub_qs = sub_qs.invoke({"question": question})

    sub_answers = []
    for q in sub_qs:
        docs = base_retriever.invoke(q)
        ans = qa_chain.invoke({"context": docs, "question": q})
        sub_answers.append((q, ans))

    final = synthesize_prompt | llm
    return final.invoke({"question": question, "qa_pairs": sub_answers}).content
```

复杂分解很自然就要进 LangGraph——见 [07 · Agentic RAG](./07-agentic-rag.md)。

## 6. RAG-Fusion（推荐：Multi-Query 的升级版）

工业界事实标准之一。流程：

1. **Multi-Query** 生成 N 个等价 query
2. 每个 query 独立检索 top-k
3. 用 **RRF** 融合所有结果

LCEL 实现：

```python
from langchain.load import dumps, loads

def reciprocal_rank_fusion(results: list[list], k=60):
    scores = {}
    for docs in results:
        for rank, doc in enumerate(docs):
            key = dumps(doc)
            scores[key] = scores.get(key, 0) + 1 / (k + rank)
    ranked = sorted(scores.items(), key=lambda x: -x[1])
    return [loads(k) for k, _ in ranked]

generate_queries = (
    multi_query_prompt | llm | StrOutputParser()
    | (lambda s: s.strip().split("\n"))
)

rag_fusion = (
    generate_queries
    | base_retriever.map()      # 对每个 query 跑一次 retriever
    | reciprocal_rank_fusion
)

docs = rag_fusion.invoke({"question": "..."})
```

实测 RAG-Fusion 比纯 Multi-Query 稳定 5-10%，**几乎是 Multi-Query 的免费升级**——已经做了 Multi-Query 就一定要加 RRF。

## 7. 组合策略

不要一次堆所有变换。按问题类型选：

| 问题特征 | 推荐 |
|---|---|
| 简短、口语 | Multi-Query / RAG-Fusion |
| 长 query、信息丰富 | 直接检索（变换收益小） |
| 问题与文档语义距离大 | HyDE |
| 太具体、需要背景 | Step-back |
| 多跳、需要推理链 | Decomposition（→ Agentic RAG） |
| 不知道哪种 | RAG-Fusion，单一选择最稳 |

也可以**让 LLM 自己分类**，再分发到不同变换路径——这就是 Adaptive-RAG 的思路（见 [07](./07-agentic-rag.md)）。

## 8. 性能与成本

每种变换都要多调 1-3 次 LLM。控制成本：

- **变换用 mini 模型**（gpt-4o-mini / haiku）就够，因为只是改写
- **变换可缓存**：query → 变换结果，按归一化 query 缓存
- **延迟**：变换可以和"主 query 直接检索"**并行**——边变换边检索原 query，最后合并

## 9. 调试

每种变换都先**单独测**，看变换后的 query 是不是合理：

```python
print(generate_queries.invoke({"question": "怎么解决 504"}))
# ["...", "...", "..."]
```

变换出来的 query 不像样（重复、跑题、无意义），先调 prompt，再上链。LangSmith trace 能看到每一步的输入输出，非常有用。

## 10. 常见坑

| 现象 | 原因 |
|---|---|
| Multi-Query 改完更糟 | LLM 改得太自由跑题；prompt 加约束（"保持原意，只改措辞"） |
| HyDE 反而召回更差 | query 已经很像文档；HyDE 不适合所有场景，**评测后再决定** |
| Decomposition 拆出无关子问题 | LLM 没有上下文；先 step-back 理解再 decompose |
| 变换后 query 重复 | 没去重；按归一化（小写、去标点）去重 |
| 变换 + 检索串行慢 | 改成异步并行：原 query 直接检索 ⊕ 变换后检索，同时跑 |
| Step-back 高层 query 检不到 | 索引里没有"通用背景"文档；考虑加一份 wiki 类语料 |

## 11. 下一步

- [06 · 重排序](./06-reranking.md)：召回多了，怎么排准
- [07 · Agentic RAG](./07-agentic-rag.md)：让 LLM 自己决定用哪种变换
