# 02 · 分块进阶

分块（chunking）是 RAG 里**最被低估**的环节。同一份语料、同一个 embedding，换个切法，效果能差一倍。

## 1. 为什么分块这么重要

一个 chunk = 检索的最小单位 = LLM 看到的最小单位。它必须同时满足：

1. **小到能精准检索**：相关性集中，不被无关内容稀释 embedding
2. **大到语义完整**：单独读得懂，不能"上一句没了"
3. **边界合理**：不要把"假设：A 是 B"和"则 C 成立"切开

这三件事经常打架——这就是为什么有那么多分块策略。

## 2. 基线：递归字符分块

`RecursiveCharacterTextSplitter` 是 90% 场景的合理起点：

```python
from langchain_text_splitters import RecursiveCharacterTextSplitter

splitter = RecursiveCharacterTextSplitter(
    chunk_size=500,
    chunk_overlap=50,
    separators=["\n\n", "\n", "。", "！", "？", "；", " ", ""],
    length_function=len,
)
```

工作方式：**优先在大边界（段落）切；切完还太大就降级到小边界（句号、空格）**。`separators` 列表的顺序就是优先级。

中文必须自己写 separators——默认列表全是英文标点。

### 2.1 chunk_size 怎么选

经验值：

| 场景 | chunk_size | overlap |
|---|---|---|
| FAQ / 短文档 | 200-400 | 20-50 |
| 一般技术文档 | 500-800 | 50-100 |
| 长篇分析 / 论文 | 800-1200 | 100-150 |
| 代码 | 按函数（特殊） | 0-20 |

更准的方式：用 token 计数：

```python
splitter = RecursiveCharacterTextSplitter.from_tiktoken_encoder(
    encoding_name="cl100k_base",   # GPT-4 系列
    chunk_size=500,                 # 这里是 token 数
    chunk_overlap=50,
)
```

### 2.2 overlap 的真相

很多人无脑设 `overlap = chunk_size * 0.1`。但 overlap 的作用是**避免句子被切断**——
- 切到段落/句子边界时，**不需要 overlap**
- 切到字符 fallback 时，需要 overlap 让相邻块的尾巴能在下一块见到

所以 `RecursiveCharacterTextSplitter` 用合适的 separators，overlap 可以很小。

## 3. 结构化分块：保留文档骨架

技术文档、Markdown、HTML 通常有**天然的层级结构**——按 `#` `##` `###` 切，比按字符切好得多。

### 3.1 Markdown header

```python
from langchain_text_splitters import MarkdownHeaderTextSplitter

splitter = MarkdownHeaderTextSplitter(
    headers_to_split_on=[
        ("#",   "H1"),
        ("##",  "H2"),
        ("###", "H3"),
    ],
    strip_headers=False,   # 保留标题在 chunk 里
)
docs = splitter.split_text(md_text)
# 每个 doc.metadata 自动带 H1/H2/H3
```

后续可以再叠一层 `RecursiveCharacterTextSplitter` 把过大的 section 切碎——但 metadata 已经带上了层级信息。

### 3.2 HTML

```python
from langchain_text_splitters import HTMLHeaderTextSplitter

splitter = HTMLHeaderTextSplitter(headers_to_split_on=[("h1", "H1"), ("h2", "H2")])
```

### 3.3 代码

```python
from langchain_text_splitters import (
    PythonCodeTextSplitter, JavaScriptCodeTextSplitter, ...
)

splitter = PythonCodeTextSplitter(chunk_size=500, chunk_overlap=0)
```

按函数 / 类的语法边界切，比按字符切对代码 RAG 友好得多。

## 4. 语义分块（Semantic Chunking）

按"句子之间的语义距离"切——相邻句子语义相近就合并，差距大就切开。

```python
from langchain_experimental.text_splitter import SemanticChunker
from langchain_openai import OpenAIEmbeddings

splitter = SemanticChunker(
    OpenAIEmbeddings(),
    breakpoint_threshold_type="percentile",   # 也可 "standard_deviation" / "interquartile"
    breakpoint_threshold_amount=95,
)
chunks = splitter.split_documents(docs)
```

工作方式：
1. 把文档切成句子
2. 每对相邻句子算 embedding 相似度
3. 在相似度突降的位置切

适合：散文、自由格式文本，**没有清晰结构**的长文。
不适合：技术文档（结构本身就清晰）、短文档（句子太少没意义）。

代价：需要多调一次 embedding API。

## 5. 父子文档（Parent-Child / Small-to-Big）

**核心问题**：小 chunk 检索精准，但 LLM 看着信息不全；大 chunk 信息全，但检索 noise 多。

**解法**：分两层——
- 索引时存**小 chunk**
- 检索时返回**所属的大 chunk**（甚至整段父文档）

```python
from langchain.retrievers import ParentDocumentRetriever
from langchain.storage import InMemoryStore
from langchain_chroma import Chroma

# 父分块器（粗）
parent_splitter = RecursiveCharacterTextSplitter(chunk_size=2000)
# 子分块器（细）
child_splitter  = RecursiveCharacterTextSplitter(chunk_size=400)

vs = Chroma(embedding_function=OpenAIEmbeddings())
docstore = InMemoryStore()   # 存父文档；生产用 Redis/Postgres

retriever = ParentDocumentRetriever(
    vectorstore=vs,
    docstore=docstore,
    child_splitter=child_splitter,
    parent_splitter=parent_splitter,
)
retriever.add_documents(raw_docs)

# 检索：用子 chunk 匹配，但返回父 chunk
results = retriever.invoke("query")
```

**这是最划算的进阶技巧之一**——召回率几乎不变，但 LLM 的回答质量明显提升。

## 6. 多向量索引（Multi-Vector）

更激进：**一个文档生成多个 embedding 向量**，但都指向同一个原文档。

常见的多向量来源：

1. **摘要**：让 LLM 给每段写摘要，embed 摘要
2. **假设性问题**：让 LLM 给每段生成"这段能回答的问题"，embed 问题
3. **不同粒度**：句级 + 段级 + 章节级各一份

```python
from langchain.retrievers import MultiVectorRetriever

# 给每个文档生成 N 个假设性问题
def gen_questions(doc):
    return llm.invoke(f"为下面的内容生成 3 个用户可能问的问题：\n{doc.page_content}").content.split("\n")

questions_with_id = []
for doc in docs:
    qs = gen_questions(doc)
    for q in qs:
        questions_with_id.append(Document(page_content=q, metadata={"doc_id": doc.id}))

vs.add_documents(questions_with_id)   # embed 的是问题
docstore.mset([(doc.id, doc) for doc in docs])  # 存原文

retriever = MultiVectorRetriever(vectorstore=vs, docstore=docstore, id_key="doc_id")
```

**问题-召回**经常比"原文-召回"好很多——因为用户的 query 也是问题，问题之间的相似度比"问题-陈述"更高。

## 7. metadata 设计：被忽略的杀手锏

光靠语义相似度，无法表达"只在 2024 年后的文档里找"、"只在 API 文档里找"这类约束。

**索引时**就把可过滤维度写进 `metadata`：

```python
Document(
    page_content="...",
    metadata={
        "source": "docs/api/v3.md",
        "doc_type": "api",          # api / tutorial / blog / faq
        "language": "zh",
        "version": "3.2",
        "updated_at": "2026-04-15",
        "section": "Authentication",
        "h1": "Authentication",
        "h2": "OAuth",
    },
)
```

**检索时**做过滤：

```python
vs.as_retriever(search_kwargs={
    "k": 4,
    "filter": {"doc_type": "api", "version": {"$gte": "3.0"}},
})
```

不同向量库的过滤语法不一样（Chroma / Pinecone / Qdrant 各有方言），但能力都有。

### 7.1 Self-Query：让 LLM 自己生成过滤条件

```python
from langchain.retrievers.self_query.base import SelfQueryRetriever

retriever = SelfQueryRetriever.from_llm(
    llm, vs,
    document_contents="技术文档",
    metadata_field_info=[
        AttributeInfo(name="version", type="string", description="文档版本，如 '3.2'"),
        AttributeInfo(name="doc_type", type="string", description="api / tutorial / blog"),
    ],
)

retriever.invoke("v3.0 之后的 API 文档里关于 OAuth 的部分")
# LLM 自动产出 filter={"version": ">=3.0", "doc_type": "api"} + query="OAuth"
```

适合：用户输入里**自然包含约束条件**的场景。

## 8. 上下文增强：给 chunk 注入"周围信息"

一个孤立的小 chunk 检索时容易丢上下文（前一段在说什么、文档讲什么主题）。两种增强：

### 8.1 Contextual Retrieval（Anthropic 提出）

索引前，让 LLM 给每个 chunk 写一段"它在原文档里的上下文"：

```python
def add_context(chunk_text, full_doc_text):
    prompt = f"""<document>{full_doc_text}</document>
请为下面这段 chunk 写 1-2 句话，说明它在文档里的位置和讨论什么：
<chunk>{chunk_text}</chunk>"""
    return llm.invoke(prompt).content + "\n\n" + chunk_text
```

embed 增强后的版本。原始论文报告检索失败率降低 35%（结合 reranker）。代价是索引时多一次 LLM 调用——可以用 prompt cache 把 full_doc 缓存住，成本可控。

### 8.2 元数据注入到 page_content

把关键 metadata 直接拼进文本前面，让 embedding 能"看到"：

```python
chunk.page_content = f"[文档：{meta['source']} | 章节：{meta['h2']}]\n{chunk.page_content}"
```

便宜的"穷人版"，对中等水平的 embedding 有帮助。

## 9. 调试：怎么判断分块好不好

不要靠想，要测：

### 9.1 看 chunk 长度分布

```python
import statistics
lens = [len(c.page_content) for c in chunks]
print(f"min={min(lens)}, max={max(lens)}, mean={statistics.mean(lens):.0f}, p95={sorted(lens)[int(len(lens)*0.95)]}")
```

发现极小（<50）和极大（>3000）的 chunk 就该警觉——splitter 没切对。

### 9.2 抽样人工读

随机抽 20 个 chunk，自己读：
- 能不能"独立看懂"？（不能 → chunk 太小或没上下文增强）
- 是不是"主题集中"？（不集中 → chunk 太大）
- 句子有没有被切断？（有 → separators 没设对）

### 9.3 用评测集打分

详见 [09 · 评测](./09-evaluation.md)。最简单的指标：**期望文档是否在 top-k 里**（hit rate）。换个分块策略重跑一遍，比较。

## 10. 常见坑

| 现象 | 原因 |
|---|---|
| 中文文档大量奇怪截断 | `separators` 没加中文标点 |
| chunk_size 加大效果反而差 | embedding 容量有上限，过长内容被截断；或 noise 稀释了关键信息 |
| `MarkdownHeaderTextSplitter` 有些段没标题 | 文档里直接写正文没 header；先用 markdown header 切，再嵌套 recursive |
| 父子文档 docstore 重启就丢 | `InMemoryStore` 是内存的；生产换 Redis/Postgres |
| 多向量索引嵌入贵 | 给每个 chunk 生成 3 个问题 = embedding 量 ×3；评估收益是否值得 |
| metadata 过滤后召回为 0 | 过滤太严；先不过滤看召回，再加过滤逐步收紧 |
| 表格被切碎 | 表格不要用通用 splitter；专门处理（见 [08 章](./08-multimodal-and-structured.md)） |

## 11. 下一步

- [03 · Embedding 与向量库选型](./03-embeddings-and-stores.md)：分好块之后用什么 embed
- [04 · 混合检索](./04-hybrid-retrieval.md)：metadata 过滤 + 混检结合
