# LLM Eval（LLM 应用评测）

> 评测是 LLM 工程化最被低估、最该早做、最容易跳过的一环。**没有评测就没有迭代**——所有 prompt 工程、RAG 优化、Agent 设计都在玄学边缘试错。本主题把评测从"事后补一下"变成"开发流程的第一公民"。

## 章节索引

1. [01 · 概览与心智模型](./01-overview.md) — 为什么 LLM eval 难、和传统 ML 的区别、三层框架
2. [02 · 评测集设计](./02-datasets.md) — Golden Set 怎么建、规模、版本化、失败 case 沉淀
3. [03 · 指标体系](./03-metrics.md) — 确定性 / 启发式 / LLM-as-Judge / Pairwise；分类、抽取、生成的不同指标
4. [04 · LLM-as-Judge 深度](./04-llm-as-judge.md) — 偏差、校准、Pairwise vs Pointwise、prompt 模板
5. [05 · 评测框架对比](./05-frameworks.md) — LangSmith / RAGAS / DeepEval / promptfoo / Braintrust 怎么选
6. [06 · RAG 评测](./06-rag-eval.md) — 检索 / 生成 / 端到端三层；与 [rag-advanced/09](../rag-advanced/09-evaluation.md) 的关系
7. [07 · Agent 评测](./07-agent-eval.md) — 轨迹 / 步骤 / 工具调用 / 最终结果四个维度
8. [08 · 在线评测与 A/B](./08-online-and-ab.md) — 用户反馈、Shadow、Pairwise 上线、灰度
9. [09 · CI 与回归](./09-ci-and-regression.md) — 把评测接进 PR、版本对比、drift 监控
10. [10 · 进阶](./10-advanced.md) — 合成数据、对抗测试、Eval-Driven Development（EDD）

## 心智地图

```
        ┌──── 设计 ────┐    ┌──── 度量 ────┐    ┌──── 自动化 ────┐
        │  Golden Set  │    │  Metrics      │    │  CI / Regression│
        │  Synthetic   │ ─► │  Judges       │ ─► │  Online / A/B   │
        │  Failure log │    │  Pairwise     │    │  Drift alerts   │
        └──────────────┘    └───────────────┘    └─────────────────┘
                                    │
                    ┌───────────────┼────────────────┐
                    ▼               ▼                ▼
              组件级评测       系统级评测         用户级反馈
        (单个 prompt/链)   (端到端 RAG/Agent)   (👍👎/会话)
```

## 前置阅读

- [LangChain · 10 可观测与生产](../langchain/10-observability-and-production.md)：LangSmith trace 基础
- [RAG 进阶 · 09 评测](../rag-advanced/09-evaluation.md)：RAG 视角的评测，本主题进一步泛化

## 资源

- LangSmith Eval 文档：https://docs.smith.langchain.com/evaluation
- RAGAS：https://docs.ragas.io/
- DeepEval：https://github.com/confident-ai/deepeval
- promptfoo：https://github.com/promptfoo/promptfoo
- 学术：[Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena (2023)](https://arxiv.org/abs/2306.05685)
- 学术：[A Survey on Evaluation of Large Language Models (2024)](https://arxiv.org/abs/2307.03109)

## 资源目录

图片放在 [`assets/`](./assets/) 下。
