# 06 · 重排序（Rerank）

## 1. 为什么必须有 Reranker

向量检索 + BM25 给出的是**召回**，不是**排序**——它们的相似度分数和"真正相关度"之间有 gap：

- top-1 不一定最相关
- top-5 里大概率有相关的，但顺序不准
- 把无关文档塞进 prompt 会**主动伤害 LLM 输出**（"lost in the middle"现象）

**Reranker 的目标**：把召回的 50-100 条，**按真正的相关度重排**，截取 top-3/5 给 LLM。

> 经验法则：对生产 RAG，**reranker 是单项收益最高的进阶组件**——通常带来 15-30% 的端到端答案准确度提升。

## 2. 三种 Reranker 路线

| 类型 | 代表 | 速度 | 效果 | 部署 |
|---|---|---|---|---|
| **Cross-Encoder（重排专用模型）** | BGE-Reranker / Cohere Rerank | 中 | **强** | API / 自部署 |
| **LLM-as-Judge（LLM 直接打分）** | GPT-4o-mini / Claude Haiku | 慢 | 强 | API |
| **嵌入式特殊检索（Late Interaction）** | ColBERTv2 / bge-m3 colbert | 快 | 强 | 自部署 |

最常用的是前两类。下面分别讲。

## 3. Cross-Encoder Reranker

### 3.1 原理

向量检索是**双塔**结构：query 和 doc 各自 encode，余弦相似度比较。
Cross-encoder 是**单塔**：(query, doc) 一起进 transformer，输出一个相关度分数。

```
向量检索（双塔）          Cross-encoder（单塔）
─────────────            ──────────────────
[query] → encoder → vec  [query, doc] → encoder → score
[doc]   → encoder → vec
cosine(vec_q, vec_d)
```

单塔精度高很多，但**不能预先 encode 所有文档**——必须在线对每对 (query, doc) 跑一次。所以它只能用于"召回之后"，不能直接做向量库索引。

### 3.2 Cohere Rerank

最简单的 reranker——一行 API：

```python
import cohere

co = cohere.Client(api_key="...")
results = co.rerank(
    model="rerank-multilingual-v3.0",   # 多语，含中文
    query="怎么解决 504 超时",
    documents=[d.page_content for d in candidate_docs],
    top_n=5,
)

# results.results: [(index, relevance_score), ...]
reranked = [candidate_docs[r.index] for r in results.results]
```

LangChain 包装：

```python
from langchain.retrievers import ContextualCompressionRetriever
from langchain_cohere import CohereRerank

reranker = CohereRerank(model="rerank-multilingual-v3.0", top_n=5)

retriever = ContextualCompressionRetriever(
    base_retriever=base_retriever,   # 先粗检 50 条
    base_compressor=reranker,        # 再 rerank 到 top-5
)

retriever.invoke("...")
```

价格：约 $1-2 per 1000 次请求（每次 ≤ 1000 文档），便宜。

### 3.3 BGE-Reranker（开源）

```python
from sentence_transformers import CrossEncoder

reranker = CrossEncoder("BAAI/bge-reranker-large", device="cuda")

scores = reranker.predict([(query, d.page_content) for d in candidate_docs])
ranked_idx = sorted(range(len(scores)), key=lambda i: -scores[i])[:5]
reranked = [candidate_docs[i] for i in ranked_idx]
```

主流选择：

| 模型 | 大小 | 中文 | 备注 |
|---|---|---|---|
| `BAAI/bge-reranker-base` | 280M | 强 | 快、便宜 |
| `BAAI/bge-reranker-large` | 560M | **强** | 默认推荐 |
| `BAAI/bge-reranker-v2-m3` | 568M | **强** | 多语；目前 SOTA 之一 |
| `BAAI/bge-reranker-v2-gemma` | 2B | **极强** | 慢；high-stakes 场景 |
| `jinaai/jina-reranker-v2-base-multilingual` | 270M | 强 | 长上下文支持好 |

### 3.4 在 LangChain 中用 BGE Reranker

```python
from langchain.retrievers.document_compressors import CrossEncoderReranker
from langchain_community.cross_encoders import HuggingFaceCrossEncoder

ce = HuggingFaceCrossEncoder(model_name="BAAI/bge-reranker-v2-m3")
reranker = CrossEncoderReranker(model=ce, top_n=5)

retriever = ContextualCompressionRetriever(
    base_retriever=base_retriever,
    base_compressor=reranker,
)
```

## 4. LLM-as-Judge Reranker

让一个便宜的 LLM 直接给文档打分：

```python
from langchain_core.prompts import ChatPromptTemplate
from pydantic import BaseModel, Field

class Score(BaseModel):
    score: float = Field(description="相关度 0-10")

scoring_prompt = ChatPromptTemplate.from_template(
    """打分：下面这段文档对回答问题有多相关？0=无关，10=完全相关。

问题：{question}

文档：{doc}"""
)

scorer = scoring_prompt | llm.with_structured_output(Score)

def llm_rerank(query: str, docs: list[Document], top_k=5):
    scored = []
    for d in docs:
        s = scorer.invoke({"question": query, "doc": d.page_content})
        scored.append((s.score, d))
    scored.sort(key=lambda x: -x[0])
    return [d for _, d in scored[:top_k]]
```

特点：
- **效果**：上限非常高（GPT-4o 级别打分接近人工）
- **成本**：每个文档一次 LLM 调用——粗检 50 条就是 50 次。批量并行勉强可控
- **延迟**：明显高于 cross-encoder

适合：**high-stakes 场景**（法律、医疗）+ 召回数量不大（<20）。

### 4.1 优化：listwise 打分

让 LLM 一次看多个文档，给出排序：

```python
listwise_prompt = ChatPromptTemplate.from_template("""
对下面的文档按"对问题的相关性"从高到低排序，返回索引列表 [0, 3, 1, ...]。

问题：{question}

文档：
{docs}
""")
```

减少调用次数，但需要更强模型才稳。LangChain 有 `LLMListwiseRerank`。

## 5. ColBERT / Late Interaction（高阶）

ColBERT 是一种特殊架构：每个 token 都有自己的 embedding，query-doc 比较时用**MaxSim**（每个 query token 找 doc 里最相似的 token）。

效果接近 cross-encoder，但因为可以**预先 encode 所有 doc tokens**，比 cross-encoder 快很多。

`bge-m3` 就内置 colbert 输出，配合 Qdrant 等多向量库可以做"端到端混合"——先 dense + sparse RRF 召回，再 colbert rerank，全部在向量库里完成。

工程门槛比前两类高。除非你已经在用 bge-m3 + Qdrant，否则先用 cross-encoder。

## 6. 召回 → 重排的"金字塔"管线

```
1) 召回（数量大、相关度粗）：
   Hybrid retrieve  → top-50 / 100

2) 重排（数量中、相关度精）：
   Reranker         → top-10

3) 截断（数量小、给 LLM）：
   按 token 预算截    → top-3 ~ 5

4) 生成：
   stuff into prompt → LLM
```

每一层 k 不一样：粗检拿 50-100，重排到 5-10，最终塞 LLM 3-5。

为什么不直接拿向量 top-5？因为向量 top-5 里 noise 多。**多召回 + 精重排 = 双赢**。

## 7. 多阶段重排

更进阶：用便宜模型粗排 + 强模型精排：

```
50 → cross-encoder base (快)  → 20 → LLM-as-Judge (强)  → 5
```

成本不变（强模型只看 20 条），但效果接近"全部用 LLM 打分"。

## 8. Reranker 微调

Cross-encoder 微调比 embedding 微调**门槛低、收益稳**。需要：

- (query, doc, label) 三元组：label 是相关度（0/1 或 0-10）
- 1k-5k 条就能见效
- 工具：`sentence-transformers`、`FlagEmbedding`

通常只需要在你的领域上微调一次 `bge-reranker-base`，效果就能逼近闭源 API。

## 9. 怎么知道 Reranker 有没有用

——还是评测。最小指标：

- **MRR@5（Mean Reciprocal Rank）**：期望文档在 top-5 里的位置倒数的平均
- **NDCG@5**：考虑相关度等级的排序质量
- **答案准确度**（端到端，最重要）

A/B 对比"无 reranker" vs "有 reranker"，**通常能看到明显差距**。如果看不到——大概率是评测集太小或太简单，不是 reranker 没用。

## 10. 与其他模块的关系

```
chunking      → 决定每个 chunk 是不是"独立可读"
embedding     → 决定召回的"语义粗排"
hybrid        → 加上"字面精排"，提高召回上限
query 变换    → 让 query 和文档更对齐
reranker      → 在召回之上做精排
agentic       → 必要时整体重来
```

**召回阶段（embedding + hybrid + 变换）的目标是"recall 高"**——宁多勿缺。
**重排阶段（reranker）的目标是"precision 高"**——宁缺勿滥。

**召回靠的是"宽"，重排靠的是"准"——分工不能模糊。**

## 11. 性能与成本

| 方案 | 50 条 rerank 延迟 | 成本 |
|---|---|---|
| Cohere API | ~300-500ms | $1-2 / 1k req |
| BGE-base on T4 GPU | ~200-400ms | 自托管 |
| BGE-large on A10 GPU | ~150-300ms | 自托管 |
| LLM-as-Judge（gpt-4o-mini，串行） | ~10-30s | $0.005-0.02 / 次 |
| LLM-as-Judge（并行 + listwise） | ~1-3s | 同上但调用次数少 |

生产首选 cross-encoder（API 或自部署），LLM-as-Judge 留给 high-stakes 或离线评测。

## 12. 常见坑

| 现象 | 原因 |
|---|---|
| Reranker 没明显效果 | 召回阶段已经很好（k=5 都够），reranker 没空间发挥；试着把 base k 调大到 30-50 |
| Reranker 后丢了正确文档 | 召回 k 太小没召到，reranker 救不回 |
| Cross-encoder 慢 | 模型太大 / 没 GPU；换 base 版或上 GPU |
| 多语场景 reranker 跑偏 | 用了纯英文 reranker；换 multilingual / m3 |
| LLM-as-Judge 排序不稳 | temperature 没设 0；或 prompt 没要求结构化分数 |
| Cohere 偶尔抽风 | 多语模型对极短文档不稳；过滤掉极短 chunk |
| 加了 reranker 答案反而差 | 这是**指标/评估**问题——先看检索 hit rate 是否真的提升；不是的话排查 reranker 配置 |

## 13. 下一步

- [07 · Agentic RAG](./07-agentic-rag.md)：让 reranker 的结果也成为决策依据
- [09 · 评测](./09-evaluation.md)：怎么科学地比"加 vs 不加 reranker"
