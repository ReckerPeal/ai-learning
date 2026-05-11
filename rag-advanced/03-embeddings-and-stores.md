# 03 · Embedding 与向量库选型

## 1. Embedding 决定了召回上限

embedding 把文本压缩成 768 / 1024 / 1536 维向量。**这个压缩过程的信息损失，就是检索召回的天花板**。换个更好的 embedding，所有下游优化（reranker、query 改写、Agent）的效果都会跟着抬。

但 embedding 不是越贵越好——下面看怎么选。

## 2. 主流 embedding 速查

### 2.1 闭源 API

| 模型 | 维度 | 中文 | 价格 | 备注 |
|---|---|---|---|---|
| OpenAI `text-embedding-3-small` | 1536（可缩） | 一般 | 便宜 | 英文为主，中文凑合 |
| OpenAI `text-embedding-3-large` | 3072（可缩） | 较好 | 中等 | 比 small 贵 6.5×，中文有提升 |
| Cohere `embed-multilingual-v3` | 1024 | 较好 | 中等 | 多语，搜索优化 |
| Voyage `voyage-3` / `voyage-3-large` | 1024 | 较好 | 中等 | 学术/技术文档强 |
| 阿里 `text-embedding-v3` | 1024 | **强** | 便宜 | 中文场景首选闭源之一 |
| 智谱 `embedding-3` | 2048 | **强** | 便宜 | 中文场景 |

### 2.2 开源（自部署）

| 模型 | 维度 | 中文 | 备注 |
|---|---|---|---|
| `BAAI/bge-large-zh-v1.5` | 1024 | **强** | 中文 RAG 经典基线 |
| `BAAI/bge-m3` | 1024 | **强** | 多语 + 多功能（密集 / 稀疏 / colbert 三合一） |
| `intfloat/multilingual-e5-large-instruct` | 1024 | 较好 | 多语，需要"query: " / "passage: " 前缀 |
| `Qwen/Qwen3-Embedding-8B` | 4096 | **强** | 大模型，效果顶但慢 |
| `BAAI/bge-small-zh-v1.5` | 512 | 一般 | 极致便宜，适合海量索引 |

### 2.3 怎么选

按场景：

```
中文为主、追求效果   → bge-large-zh-v1.5 / bge-m3 / 阿里 v3
中文为主、要便宜      → bge-small-zh-v1.5
英文为主              → text-embedding-3-large 或 voyage-3
多语混合              → bge-m3 / cohere multilingual-v3
不想运维              → 闭源 API
有 GPU 想省钱         → 开源自部署
要做混合检索（密集+稀疏）→ bge-m3（一个模型一次出三种向量）
```

**最重要的一条：用 [MTEB-zh](https://github.com/wangyuxinwhy/uniem/blob/main/mteb-zh/README.md) / [C-MTEB](https://huggingface.co/spaces/mteb/leaderboard) 榜单**——但要看**对应任务**（Retrieval / STS / Classification 不一样），别看综合分。

## 3. Embedding 的几个常见误区

### 3.1 "维度越高越准"

**错**。3072 维不一定比 1024 维好——取决于训练数据和目标。`text-embedding-3` 引入了 Matryoshka 技术，可以**截断**到任意维度并保持大部分性能：

```python
from langchain_openai import OpenAIEmbeddings
emb = OpenAIEmbeddings(model="text-embedding-3-large", dimensions=1024)
```

省存储省比较开销，损失通常 < 2%。

### 3.2 "用同一个模型 embed query 和文档"

通常对，但**不一定**。一些模型（如 `e5`、`bge`）要求**不同前缀**：

```python
# bge / e5 系列
query_text = "Represent this sentence for searching relevant passages: " + query
doc_text   = passage

# 或 e5：
query_text = "query: " + query
doc_text   = "passage: " + passage
```

LangChain 的 `HuggingFaceEmbeddings` 有 `query_instruction` / `embed_instruction` 参数处理这个。**忘加前缀，召回直接掉 5-10 个百分点**。

### 3.3 "embedding 一次定终身"

embedding 模型升级了，**整个索引必须重建**。规划时就要考虑：
- 索引版本号
- 灰度切换（双写双查）
- 旧索引过渡期保留

不能假设"以后换 embedding 是小事"。

## 4. 微调 embedding：什么时候值得

预训练 embedding 在通用文本上 OK，但你的领域可能有大量术语（医疗、法律、企业内部代号）——这时候微调能再涨 5-15 个点。

需要：
- 训练对：(query, positive_doc) 和（可选）(query, negative_doc)
- 一般 1k-10k 对就能见效
- 工具：`sentence-transformers`、`FlagEmbedding`（bge 官方）

但是：

**先把所有不微调的招数用完再考虑微调**。Reranker 微调通常比 embedding 微调更划算（数据需求小、训练快、效果稳）。

## 5. 向量库选型

### 5.1 主流向量库对比

| 向量库 | 部署 | 过滤 | 混合检索 | 规模 | 适合 |
|---|---|---|---|---|---|
| **FAISS** | 库（Python） | 弱 | 自己拼 | 单机大规模 | 实验、离线 |
| **Chroma** | 库 / Server | 中 | 自带 BM25（实验） | 小到中 | 起步、demo |
| **Qdrant** | Server / Cloud | **强** | 强（dense+sparse） | 中大 | 中文社区常用 |
| **Weaviate** | Server / Cloud | 强 | 强 | 中大 | 多模态友好 |
| **Milvus / Zilliz** | Server / Cloud | 强 | 强 | 超大规模 | 亿级以上 |
| **Pinecone** | Cloud | 强 | 强 | 中大 | 不想运维、有预算 |
| **pgvector** | Postgres 扩展 | 强（SQL） | 中（pg_search） | 中 | 已有 Postgres |
| **Elasticsearch / OpenSearch** | Server | 强 | 强（BM25 原生） | 大 | 已有 ES |

### 5.2 选型决策

```
索引规模 < 10 万 chunk
    ├── 已有 Postgres → pgvector（最省事）
    ├── 想本地试       → Chroma / FAISS
    └── 上云           → Pinecone

索引规模 10 万 - 1000 万
    ├── 要混合检索 + 强过滤 → Qdrant / Weaviate
    ├── 已有 ES        → Elasticsearch
    └── 上云           → Pinecone / Zilliz

索引规模 > 1000 万
    └── Milvus / Zilliz / 自建 Qdrant 集群
```

### 5.3 ANN 索引算法

向量库底层都用 ANN（近似最近邻）算法。常见：

| 算法 | 召回 | 速度 | 内存 | 备注 |
|---|---|---|---|---|
| Flat（暴力） | 100% | 慢 | 高 | 小规模或离线 |
| IVF | 高 | 快 | 中 | 经典方案 |
| HNSW | **高** | **快** | 高 | 默认推荐 |
| IVF-PQ | 中 | 极快 | 极低 | 超大规模 |
| ScaNN | 高 | 极快 | 中 | Google，集成度低 |

大多数向量库默认用 HNSW，`ef_search` / `M` 等参数控制召回-速度的权衡。**召回不够就调大 ef_search**（通常 50-200 之间）。

## 6. 混合检索的伏笔：稀疏向量

下一章会讲混合检索（BM25 + 向量）。如果你的向量库支持**稀疏向量**字段（Qdrant、Weaviate、ES），可以在同一份索引里同时存稠密和稀疏向量：

```python
# Qdrant
client.upsert(
    collection_name="docs",
    points=[
        PointStruct(
            id=i,
            vector={
                "dense":  dense_emb,    # 稠密向量
                "sparse": sparse_emb,   # BM25-like 稀疏向量
            },
            payload={...metadata...},
        )
    ],
)
```

`bge-m3` 一次出三种向量（dense + sparse + colbert），配合 Qdrant / Weaviate 的多向量字段就能做端到端混合检索——下章详述。

## 7. 索引性能与成本

### 7.1 embedding 是大头

10 万 chunk × 1536 维 × OpenAI text-embedding-3-large = 几十美元 + 几小时。
- **批量调用**：API 接 batch 接口，吞吐 ×10
- **本地模型 + GPU**：BGE-large 单 A10 卡每秒能 embed 几千段
- **缓存**：[CacheBackedEmbeddings](../langchain/10-observability-and-production.md#3-缓存)

### 7.2 存储

1536 维 float32 = 6 KB/向量。100 万向量 ≈ 6 GB。HNSW 索引会再翻 1-2 倍。
- 用 `dimensions=` 截维度
- 量化：HNSW + int8 / 二值化能再压缩 4-32×（部分库支持）

### 7.3 重建索引的成本规划

embedding 升级、分块策略变更、metadata schema 改了——都要重建索引。一定要：

- 索引可标识版本（命名加日期或哈希）
- 业务能切换（双写过渡 / 灰度）
- 数据可重放（原始文档保留，不要"切了就丢"）

## 8. 实际配置例：中文文档 RAG（生产）

```python
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_qdrant import QdrantVectorStore
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams

emb = HuggingFaceEmbeddings(
    model_name="BAAI/bge-large-zh-v1.5",
    model_kwargs={"device": "cuda"},
    encode_kwargs={"normalize_embeddings": True},
    query_instruction="为这个句子生成表示以用于检索相关文章：",
)

client = QdrantClient(url="http://qdrant:6333")
client.create_collection(
    collection_name="docs_v1",
    vectors_config=VectorParams(size=1024, distance=Distance.COSINE),
)

vs = QdrantVectorStore(client=client, collection_name="docs_v1", embedding=emb)
vs.add_documents(chunks)
```

要点：
- BGE 系列要 `normalize_embeddings=True` + COSINE
- BGE 中文 query 要加 `query_instruction`
- Qdrant collection 名带版本号

## 9. 常见坑

| 现象 | 原因 |
|---|---|
| 召回明显不如人意 | embedding 选错（中文用了英文模型） / 没加 query 前缀 / 维度截太狠 |
| 同样的 query，不同时间召回不同 | 向量库 ANN 参数太激进 / 索引仍在构建 |
| 评测分数和线上不一致 | 测试集 query 和真实分布有差异；要用真实日志做评测 |
| 加大 k 但效果不涨 | 召回够了，问题在排序——上 reranker |
| 索引升级后旧 chunk 还在 | 没清理；用 collection 版本号 + 切换流量 |
| 内存爆 | HNSW + 高维 + 大量数据；考虑量化或 IVF-PQ |
| pgvector 慢 | 没建 HNSW 索引；或 ef_search 太小 |

## 10. 下一步

- [04 · 混合检索](./04-hybrid-retrieval.md)：BM25 + 向量怎么合
- [06 · 重排序](./06-reranking.md)：embedding 之后的"二次排序"
