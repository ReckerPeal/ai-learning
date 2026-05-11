# 04 · 混合检索

## 1. 为什么单一向量检索不够

向量检索擅长"语义相似"——`苹果手机` 能召到 `iPhone`、`Apple 移动设备`。但有几类情况它**会输给老派的 BM25**：

| 场景 | 原因 |
|---|---|
| 精确关键词、罕见术语 | embedding 把罕见词压缩没了 |
| 数字、代号、产品型号 | "iPhone 15 Pro Max" 的型号差异 embedding 不敏感 |
| 人名、专有名词 | 同上，被泛化 |
| 极短 query（1-2 字） | 上下文太少，embedding 不稳定 |

反过来 BM25 也有它的短板：完全靠**字面匹配**，同义词/换种说法就 miss。

**结论**：两者结合（hybrid retrieval）几乎在所有场景下都比任一单独的强。

## 2. BM25 + 向量：一个直观的例子

query：`怎么用 v3.2 的 OAuth`

- 向量检索：召到一堆讲 OAuth 概念、原理的文档（语义对，但版本不对）
- BM25 检索：召到包含字面 `v3.2` 和 `OAuth` 的精准段落
- 合并后：精准版本 + 语义补充 → top 列表都很相关

## 3. 实现一：LangChain `EnsembleRetriever`

最简单的混合检索——两个 retriever 各自跑，结果用 **Reciprocal Rank Fusion（RRF）** 合并：

```python
from langchain_community.retrievers import BM25Retriever
from langchain.retrievers import EnsembleRetriever

bm25 = BM25Retriever.from_documents(chunks)
bm25.k = 10

vector = vs.as_retriever(search_kwargs={"k": 10})

hybrid = EnsembleRetriever(
    retrievers=[bm25, vector],
    weights=[0.4, 0.6],   # 权重，根据评测调
)

docs = hybrid.invoke("怎么用 v3.2 的 OAuth")
```

要点：
- `BM25Retriever.from_documents` 是**内存版**——重启就丢、没法增量；适合小语料 / 实验
- 两个 retriever 各取 top-10，最后合并、去重、按 RRF 排序
- `weights` 不是相加成 1，是加权 RRF 分数；按评测调

### 3.1 RRF 是什么

```
RRF_score(d) = Σ_i  weight_i / (k + rank_i(d))
```

- `rank_i(d)`：文档 d 在第 i 个 retriever 里的排名（1, 2, 3...）
- `k`：常数（通常 60），抑制极端高排名的影响
- 多个 retriever 的排名转换成统一的可加分数

**优点**：不需要不同 retriever 之间的分数有可比性。BM25 的分数和 cosine 相似度本来就没法直接相加，RRF 用排名规避了这问题。

## 4. 实现二：原生 BM25 + Postgres / ES

生产用 BM25 不能用 LangChain 的内存版。两个常见路径：

### 4.1 Elasticsearch / OpenSearch

ES 原生 BM25 + 向量（dense_vector），同一份索引同一次查询：

```python
es.search(index="docs", body={
    "query": {
        "bool": {
            "should": [
                {"match": {"content": "OAuth v3.2"}},                    # BM25
                {"knn": {"field": "embedding", "query_vector": vec, "k": 10}}  # 向量
            ],
        }
    }
})
```

或用 `rank` / `rrf` API（ES 8.x 起）原生做 RRF。

### 4.2 Postgres + pgvector + tsvector

```sql
SELECT id, content,
       ts_rank(to_tsvector('chinese', content), plainto_tsquery('chinese', $1)) AS bm25_score,
       1 - (embedding <=> $2) AS vec_score
FROM docs
WHERE to_tsvector('chinese', content) @@ plainto_tsquery('chinese', $1)
   OR embedding <=> $2 < 0.3
ORDER BY (bm25_score * 0.4 + vec_score * 0.6) DESC
LIMIT 10;
```

中文要装 [pg_jieba](https://github.com/jaiminpan/pg_jieba) 或 zhparser 才能用 tsvector。

## 5. 实现三：Qdrant / Weaviate 原生混合检索

新一代向量库都有"多向量字段"——一个 collection 同时存 dense 和 sparse 向量。

### 5.1 Qdrant + bge-m3

`bge-m3` 一个模型同时输出 dense + sparse 向量：

```python
from FlagEmbedding import BGEM3FlagModel

model = BGEM3FlagModel("BAAI/bge-m3", use_fp16=True)
out = model.encode(["query"], return_dense=True, return_sparse=True)
dense = out["dense_vecs"][0]
sparse = out["lexical_weights"][0]   # dict: {token_id: weight}
```

写入 Qdrant：

```python
from qdrant_client.models import VectorParams, Distance, SparseVectorParams

client.create_collection(
    collection_name="docs",
    vectors_config={"dense": VectorParams(size=1024, distance=Distance.COSINE)},
    sparse_vectors_config={"sparse": SparseVectorParams()},
)
```

查询时同时打：

```python
from qdrant_client.models import Prefetch, FusionQuery, Fusion

results = client.query_points(
    collection_name="docs",
    prefetch=[
        Prefetch(query=dense_q, using="dense", limit=20),
        Prefetch(query=sparse_q, using="sparse", limit=20),
    ],
    query=FusionQuery(fusion=Fusion.RRF),   # 原生 RRF 融合
    limit=10,
)
```

**好处**：一次请求、原生融合、单一索引——比 LangChain 的内存 ensemble 强得多。

## 6. metadata 过滤 + 混合检索

混合检索之上，还要叠 metadata 过滤——这是真正能解决"召回噪音"的杀手锏：

```python
client.query_points(
    collection_name="docs",
    prefetch=[...],
    query=FusionQuery(fusion=Fusion.RRF),
    query_filter=Filter(
        must=[
            FieldCondition(key="doc_type", match=MatchValue(value="api")),
            FieldCondition(key="version", range=Range(gte="3.0")),
        ]
    ),
    limit=10,
)
```

工作顺序：**先过滤、再检索、再融合**。过滤太严会让召回变 0——监控召回率，必要时降级（先放宽过滤再检索）。

## 7. 何时该上 Reranker

混合检索 + 过滤之后，top-10/20 的相关度通常已经"对了"，但顺序还是有些乱——这时候 **reranker** 来做最后一刀。

详见 [06 · 重排序](./06-reranking.md)。

经典管线：

```
Hybrid Retrieve top-50  →  Rerank to top-5  →  LLM
```

**召回阶段宁可多取一些**（k=20-50），让 reranker 决定哪些 4-8 条进 prompt。

## 8. 调权重：评测驱动

`EnsembleRetriever` 的 `weights=[0.4, 0.6]` 该填多少？**不靠想，靠测**。

最小工作流：

1. 准备 50-200 条 (query, 期望文档) 评测集
2. 对每组权重 [(0.3,0.7), (0.4,0.6), (0.5,0.5), (0.6,0.4), (0.7,0.3)]：
3. 跑一遍 hybrid retrieve，算 hit rate / MRR
4. 选最高的

中文场景里**经常发现 BM25 的权重比想象中高**（0.4-0.5），因为关键词匹配在中文里很有用。

## 9. 完整端到端例子（LCEL + Qdrant 混合）

```python
from langchain_core.runnables import RunnablePassthrough
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser

def hybrid_retrieve(query: str, doc_filter=None) -> list[Document]:
    dense_q, sparse_q = encode_m3(query)
    res = client.query_points(
        collection_name="docs",
        prefetch=[
            Prefetch(query=dense_q,  using="dense",  limit=30),
            Prefetch(query=sparse_q, using="sparse", limit=30),
        ],
        query=FusionQuery(fusion=Fusion.RRF),
        query_filter=doc_filter,
        limit=20,
    )
    return [Document(page_content=p.payload["content"], metadata=p.payload) for p in res.points]

def rerank(query: str, docs: list[Document], top_k=5) -> list[Document]:
    # 详见 06 章
    ...

def format_docs(docs):
    return "\n\n".join(f"[{d.metadata.get('source')}]\n{d.page_content}" for d in docs)

prompt = ChatPromptTemplate.from_messages([
    ("system", "根据上下文回答。\n\n上下文：\n{context}"),
    ("human", "{question}"),
])

def retrieve_and_rerank(q: str):
    return rerank(q, hybrid_retrieve(q))

chain = (
    {
        "context": (lambda x: x["question"]) | RunnableLambda(retrieve_and_rerank) | format_docs,
        "question": lambda x: x["question"],
    }
    | prompt
    | llm
    | StrOutputParser()
)
```

## 10. 常见坑

| 现象 | 原因 |
|---|---|
| Hybrid 反而比单向量差 | BM25 那边被海量噪声 query 命中（如停用词没去）；或权重设错 |
| 中文 BM25 词不准 | 没装中文分词（pg_jieba / IK / jieba） |
| `EnsembleRetriever` 重启慢 | `BM25Retriever.from_documents` 每次启动都全量构建；生产用 ES/Qdrant |
| 过滤后召回 0 | 过滤太严，先无过滤跑一次看 baseline |
| RRF 后 top-1 仍不准 | 那是 reranker 的活儿，不是融合的问题 |
| Sparse 向量库特性不会用 | bge-m3 的 sparse 不是简单 BM25，要按文档配置；从官方示例起步 |

## 11. 下一步

- [05 · Query 变换](./05-query-transformation.md)：在检索前对 query 做手脚
- [06 · 重排序](./06-reranking.md)：检索后的最后一刀
