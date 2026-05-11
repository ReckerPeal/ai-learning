# RAG 进阶

> 假设你已经读过 [langchain/07-rag.md](../langchain/07-rag.md)，会写"Loader → Splitter → Embedding → Retriever → LLM"的最小 RAG 链。本主题专注于把 RAG 从 demo 推到**真正能用的生产系统**。

## 章节索引

1. [01 · 进阶路线图](./01-overview.md) — Naive RAG 的天花板、Advanced RAG / Modular RAG / Agentic RAG 演进
2. [02 · 分块进阶](./02-chunking.md) — 递归 / 层级 / 语义 / 父子文档；metadata 设计
3. [03 · Embedding 与向量库选型](./03-embeddings-and-stores.md) — 中英文模型对比、维度、向量库选型
4. [04 · 混合检索](./04-hybrid-retrieval.md) — BM25 + 向量 + metadata 过滤、Reciprocal Rank Fusion
5. [05 · Query 变换](./05-query-transformation.md) — Multi-query、HyDE、Step-back、Decomposition
6. [06 · 重排序](./06-reranking.md) — Cohere / BGE-Reranker / LLM-as-Judge；何时用、用哪种
7. [07 · Agentic RAG](./07-agentic-rag.md) — CRAG / Self-RAG / Adaptive-RAG（用 LangGraph 实现）
8. [08 · 多模态与结构化](./08-multimodal-and-structured.md) — 表格 / 图片 / PDF / SQL RAG
9. [09 · 评测](./09-evaluation.md) — Golden set、RAGAS、LangSmith Datasets，离线 + 在线
10. [10 · 生产化](./10-production.md) — 成本、延迟、增量索引、安全、版本管理

## 心智地图

```
                ┌── 索引侧（离线）─────────────────┐
                │  Loader → Splitter → Embedding   │
                │              ↓                   │
                │  metadata 设计 + 向量库 + 倒排    │
                └────────────┬─────────────────────┘
                             │
   query ─────► Query 变换 ──► Hybrid Retrieve ──► Rerank ──► LLM ──► Answer
                  (rewrite/HyDE)   (BM25+vec)      (Cohere)
                             │                                  │
                             └──── Agentic 控制（CRAG / Self-RAG）
                                   评估检索结果 → 必要时重检索
```

把每一个箭头都做对，RAG 才能跑过"demo 看着挺好，上线一塌糊涂"这道关。

## 资源

- 综述：[Retrieval-Augmented Generation for Large Language Models: A Survey](https://arxiv.org/abs/2312.10997)（必读）
- LangGraph RAG 模板：https://github.com/langchain-ai/langgraph/tree/main/examples/rag
- RAGAS：https://github.com/explodinggradients/ragas
- 中文社区评测榜：MTEB-zh / C-MTEB

## 资源目录

图片放在 [`assets/`](./assets/) 下。
