# 07 · RAG 全流程

RAG（Retrieval-Augmented Generation）是 LangChain 最经典、用得最多的场景。本章把它拆成 5 步讲清楚，每步给出可替换组件，最后一条 LCEL 端到端跑通。

## 1. RAG 的 5 步

```
原始文档
   │
   ▼  ① Document Loader
Document(page_content, metadata)
   │
   ▼  ② Text Splitter（chunking）
chunks: list[Document]
   │
   ▼  ③ Embedding + Vector Store（建索引：离线一次）
─────────────────────────────────
   ▼  ④ Retriever（在线查询）
relevant docs
   │
   ▼  ⑤ Prompt + LLM
answer
```

①②③ 是**离线建索引**；④⑤ 是**在线问答**。

## 2. ① Document Loader

把不同来源的文档读成统一的 `Document(page_content, metadata)`：

```python
# 文本/Markdown
from langchain_community.document_loaders import TextLoader
docs = TextLoader("notes.md").load()

# PDF
from langchain_community.document_loaders import PyPDFLoader
docs = PyPDFLoader("paper.pdf").load()

# 网页
from langchain_community.document_loaders import WebBaseLoader
docs = WebBaseLoader("https://example.com").load()

# 整个目录
from langchain_community.document_loaders import DirectoryLoader
docs = DirectoryLoader("./docs", glob="**/*.md").load()
```

`langchain-community` 里有几百种 Loader（Notion、Confluence、Slack、GitHub……）。**自己写**一个也容易：

```python
from langchain_core.documents import Document

docs = [Document(page_content=text, metadata={"source": "..."}) for text in my_data]
```

## 3. ② Text Splitter

LLM 上下文有限，文档要切成"chunk"。一个 chunk = 一个待检索单位。

```python
from langchain_text_splitters import RecursiveCharacterTextSplitter

splitter = RecursiveCharacterTextSplitter(
    chunk_size=500,        # 每块字符数
    chunk_overlap=50,      # 相邻块重叠（避免句子被切断）
    separators=["\n\n", "\n", "。", "！", "？", " ", ""],
)
chunks = splitter.split_documents(docs)
```

### 3.1 选切分策略

| 切分器 | 适合 |
|---|---|
| `RecursiveCharacterTextSplitter` | **默认首选**——通用文本 |
| `MarkdownHeaderTextSplitter` | Markdown 按标题层级切 |
| `HTMLHeaderTextSplitter` | HTML 按 h1/h2 切 |
| `PythonCodeTextSplitter` | Python 代码（按函数/类） |
| `TokenTextSplitter` | 严格按 token 数切（贵但精准） |
| `SemanticChunker`（experimental） | 按语义边界切 |

### 3.2 chunk_size 怎么选

- 小（200-500）：检索精度高，但答案可能拼凑感重
- 大（1000-2000）：上下文充足，但检索召回不准、token 成本高
- **从 500 + overlap 50 开始**，按效果调

## 4. ③ Embedding + Vector Store

### 4.1 Embedding：把文本变向量

```python
from langchain_openai import OpenAIEmbeddings
emb = OpenAIEmbeddings(model="text-embedding-3-small")

# 也可以本地：
# from langchain_huggingface import HuggingFaceEmbeddings
# emb = HuggingFaceEmbeddings(model_name="BAAI/bge-small-zh-v1.5")
```

中文场景常用：`bge-large-zh-v1.5`、`m3e-base`、阿里 `text-embedding-v3` 等。

### 4.2 Vector Store：存向量、查相似

```python
# 本地小项目：Chroma
from langchain_chroma import Chroma
vs = Chroma.from_documents(chunks, emb, persist_directory="./chroma_db")

# 内存（开发用）：FAISS
# from langchain_community.vectorstores import FAISS
# vs = FAISS.from_documents(chunks, emb)

# 生产：Pinecone / Weaviate / Qdrant / pgvector / Milvus / Elasticsearch ...
```

不同库 API 微差，但都实现了 `as_retriever()`。

### 4.3 查询

```python
results = vs.similarity_search("LangGraph 是什么？", k=3)
for d in results:
    print(d.page_content[:80], d.metadata)
```

### 4.4 增量更新

向量库都是"加进去就在"，但**重复加同一文档**会复制——典型方案是用稳定 ID：

```python
vs.add_documents(chunks, ids=[f"{d.metadata['source']}::{i}" for i, d in enumerate(chunks)])
```

或者用 LangChain 的 **Indexing API**（`SQLRecordManager` + `index()`），自动去重和更新。

## 5. ④ Retriever

`Retriever` 是 LangChain 的统一检索接口（也是 Runnable）：

```python
retriever = vs.as_retriever(search_kwargs={"k": 4})
docs = retriever.invoke("LangGraph 是什么？")
```

### 5.1 检索策略

```python
# 最大边际相关性（多样性）
vs.as_retriever(search_type="mmr", search_kwargs={"k": 4, "fetch_k": 20})

# 阈值过滤
vs.as_retriever(search_type="similarity_score_threshold",
                search_kwargs={"score_threshold": 0.7})
```

### 5.2 高级 Retriever

| Retriever | 干什么 |
|---|---|
| `MultiQueryRetriever` | 用 LLM 把 query 改写成多个，分别检索后合并 |
| `EnsembleRetriever` | 同时跑多个 retriever（如 BM25 + 向量），加权合并 |
| `ParentDocumentRetriever` | 索引小 chunk，但返回所在的大段落 |
| `SelfQueryRetriever` | 用 LLM 把自然语言转成 metadata 过滤条件 |
| `ContextualCompressionRetriever` | 用 LLM/Reranker 压缩 / 重排检索结果 |

混合检索（BM25 + 向量）+ Reranker 是目前生产 RAG 的"标配三连"。

### 5.3 Reranker（强烈推荐）

```python
from langchain.retrievers import ContextualCompressionRetriever
from langchain_cohere import CohereRerank

compressor = CohereRerank(model="rerank-multilingual-v3.0", top_n=4)
reranked = ContextualCompressionRetriever(
    base_retriever=vs.as_retriever(search_kwargs={"k": 20}),
    base_compressor=compressor,
)
```

先粗检 20 条，再让 reranker 选最相关的 4 条。**对效果提升非常显著**。

## 6. ⑤ 端到端 LCEL 链

```python
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import RunnablePassthrough
from langchain_core.output_parsers import StrOutputParser
from langchain_openai import ChatOpenAI

def format_docs(docs):
    return "\n\n".join(f"[{d.metadata.get('source', '?')}]\n{d.page_content}" for d in docs)

prompt = ChatPromptTemplate.from_messages([
    ("system",
     "根据下面的上下文回答用户问题。如果上下文里没答案，明说不知道。\n\n"
     "上下文：\n{context}"),
    ("human", "{question}"),
])

llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)

rag_chain = (
    {
        "context": retriever | format_docs,
        "question": RunnablePassthrough(),
    }
    | prompt
    | llm
    | StrOutputParser()
)

print(rag_chain.invoke("LangGraph 和 LangChain 有什么区别？"))
```

### 6.1 想同时返回引用？

```python
from langchain_core.runnables import RunnableParallel

rag_with_sources = RunnableParallel({
    "answer": rag_chain,
    "sources": retriever | (lambda docs: [d.metadata for d in docs]),
})

rag_with_sources.invoke("LangGraph 是什么？")
# {"answer": "...", "sources": [{"source": "..."}, ...]}
```

## 7. 进阶模式

### 7.1 Query 改写

用户问得太口语 / 太长 / 太短，先让 LLM 改写：

```python
rewrite_prompt = ChatPromptTemplate.from_template(
    "把下面的用户问题改写成 3 个不同角度的检索 query，用换行分隔：\n\n{q}"
)
rewriter = rewrite_prompt | llm | StrOutputParser() | (lambda s: s.strip().split("\n"))
```

### 7.2 HyDE（假设性文档嵌入）

让 LLM 先**编一个理想答案**，用编造答案的 embedding 去检索——经常比原 query 召回更准。

```python
hyde_prompt = ChatPromptTemplate.from_template("写一段可能的答案（即使不确定）：{q}")
hyde = hyde_prompt | llm | StrOutputParser()

retriever_with_hyde = hyde | vs.as_retriever()
```

### 7.3 Agentic RAG（用 LangGraph）

复杂场景：先判断是否需要检索 → 检索 → 评估 → 不够再换 query → 直到够 → 回答。

这是循环 + 条件 + 状态——**就该上 LangGraph**：

```
classify → (need_search?) → search → grade_docs → (good?) → answer
                              ▲                       │
                              └──── rewrite_query ────┘
```

LangGraph 的官方仓有 **CRAG / Self-RAG / Adaptive-RAG** 现成模板可以参考。

## 8. 评测：不要只靠肉眼

RAG 必须做**离线评测**，否则改 prompt 改 chunk 全靠玄学。最小套装：

- **Golden set**：50–200 条 (问题, 期望答案, 期望文档) 三元组
- **指标**：
  - 检索命中率（期望文档是否在 top-k）
  - 答案准确度（用 LLM 当裁判 / 人工抽检）
  - 引用一致性（答案里的内容是否真在检索上下文里）
- 工具：LangSmith Datasets + `evaluate()`，或自家脚本

## 9. 常见坑

| 现象 | 原因 |
|---|---|
| 答非所问 | 检索没召回相关文档；先 debug 检索结果再 debug LLM |
| LLM"瞎编" | prompt 没明确"上下文里没就说不知道"；或 chunk 切太碎 |
| 中文检索差 | embedding 选了英文优化的模型；换中文 / 多语 embedding |
| 重复加索引 | 没去重；用 Indexing API 或稳定 ID |
| 上下文超长 | k 太大 / chunk 太大；加 reranker 选 top4–6 就够 |
| 索引和 embedding 不一致 | 切换 embedding 后**整个库都要重建**——embedding 是绑定的 |
| 命中率高、答案差 | prompt 工程问题（怎么让 LLM 用上下文）；加 few-shot / 改 system prompt |

## 10. 下一步

- [08 · 对话记忆](./08-memory-and-history.md)：在 RAG 上加多轮对话
- [09 · Agents](./09-agents.md) → LangGraph：做 Agentic RAG
