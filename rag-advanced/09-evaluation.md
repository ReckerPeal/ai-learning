# 09 · 评测

> **评测是 RAG 工程化的第一公民**，不是收尾工作。没有评测就不知道改了哪一处带来了真实收益，所有进阶技巧都变成玄学。

## 1. 三层指标

把"RAG 好不好"拆成三层独立的问题：

| 层 | 问的问题 | 关键指标 |
|---|---|---|
| **检索层** | 召回正确文档了吗？ | hit rate、recall@k、MRR、NDCG |
| **生成层** | 答案有没有忠实于上下文？ | faithfulness、groundedness |
| **端到端** | 回答用户的问题了吗？ | answer correctness、relevance、人工评分 |

每层独立评测，**问题才能定位**。光看端到端，无法分辨"答错了"是检索没召到、还是 LLM 没用好上下文。

## 2. 第一步：建立 Golden Set

任何评测都从这一步开始。最低要求：50-200 条 (question, ground_truth_answer, ground_truth_docs)。

### 2.1 哪里来？

| 来源 | 可用性 |
|---|---|
| 真实用户日志 | **最好**——分布最准 |
| 客服 FAQ / 工单 | 高 |
| 让领域专家手写 | 高，但慢 |
| 让 LLM 从文档生成 | 凑数可以，注意会偏向"文档里能答的" |

### 2.2 LLM 自动生成测试集（起步用）

```python
from langchain_core.prompts import ChatPromptTemplate
from pydantic import BaseModel

class QAPair(BaseModel):
    question: str
    answer: str

gen_prompt = ChatPromptTemplate.from_template(
    "基于下面的文档，提出 1 个用户可能问的问题，并给出基于文档的答案。\n\n{doc}"
)
gen_chain = gen_prompt | llm.with_structured_output(QAPair)

dataset = [gen_chain.invoke({"doc": d.page_content}) for d in sample_docs]
```

⚠️ LLM 生成的测试集**有偏**：会绕开"文档里答不出来的问题"和"需要多跳的问题"。**起步用、长期不行**。

### 2.3 数据集要分类标注

不光记问题答案，还要标记类型：

```python
{
    "question": "...",
    "answer": "...",
    "expected_doc_ids": ["doc-42"],
    "type": "single_hop",       # single_hop / multi_hop / no_answer / chitchat
    "difficulty": "easy",
    "tags": ["api", "v3"],
}
```

后续可以按 `type` / `tags` 看每类问题的得分——发现 multi_hop 集中失败时，就该上 Decomposition 或 Agentic RAG。

## 3. 检索评测：最该先做的

```python
def hit_rate_at_k(dataset, retriever, k=5):
    hits = 0
    for sample in dataset:
        retrieved_ids = [d.metadata["id"] for d in retriever.invoke(sample["question"])[:k]]
        if any(eid in retrieved_ids for eid in sample["expected_doc_ids"]):
            hits += 1
    return hits / len(dataset)


def mrr_at_k(dataset, retriever, k=5):
    """Mean Reciprocal Rank：期望文档在 top-k 里位置的倒数。"""
    total = 0
    for sample in dataset:
        retrieved = retriever.invoke(sample["question"])[:k]
        for i, d in enumerate(retrieved):
            if d.metadata["id"] in sample["expected_doc_ids"]:
                total += 1 / (i + 1)
                break
    return total / len(dataset)
```

**hit rate** 简单粗暴，先看这个；**MRR** 考虑了排序，调 reranker 时最重要。

A/B 比较：

```python
print("baseline    ", hit_rate_at_k(dataset, base_retriever))
print("+ hybrid    ", hit_rate_at_k(dataset, hybrid_retriever))
print("+ rerank    ", hit_rate_at_k(dataset, hybrid_with_rerank))
```

每个改动看是不是真带来了提升。

## 4. RAGAS：开箱即用的 RAG 评测

[RAGAS](https://github.com/explodinggradients/ragas) 是 RAG 评测的事实标准库，覆盖三层指标：

```bash
pip install ragas
```

### 4.1 核心指标

| 指标 | 含义 | 怎么算 |
|---|---|---|
| `context_precision` | 检索到的文档里，相关的占比 | LLM 判断每个文档相关性 |
| `context_recall` | 期望文档是否都被检索到 | 比对 ground truth |
| `faithfulness` | 答案是否完全基于上下文（无幻觉） | LLM 抽答案的"声明"，逐条对照上下文 |
| `answer_relevancy` | 答案是否回答了问题 | LLM 反向生成"该答案对应什么问题" |
| `answer_correctness` | 答案对不对（vs ground truth） | 语义相似度 + 事实匹配 |

### 4.2 用法

```python
from datasets import Dataset
from ragas import evaluate
from ragas.metrics import (
    context_precision, context_recall,
    faithfulness, answer_relevancy, answer_correctness,
)

# 准备数据
data = {
    "question": [...],
    "answer": [...],          # 你的 RAG 输出
    "contexts": [[...], ...], # 检索到的上下文（list of list）
    "ground_truth": [...],    # 标准答案
}
ds = Dataset.from_dict(data)

result = evaluate(
    dataset=ds,
    metrics=[
        context_precision, context_recall,
        faithfulness, answer_relevancy, answer_correctness,
    ],
)
print(result)
# {'context_precision': 0.85, 'context_recall': 0.78, 'faithfulness': 0.91, ...}
```

RAGAS 的"打分"靠 LLM-as-Judge——所以**评测自身也消耗 token**。一次跑 100 条评测大概几美元，可控。

### 4.3 关键指标读法

- **context_precision 低**：召回了太多无关文档 → 加 reranker、收紧 k
- **context_recall 低**：漏召回 → 改 embedding / 加混合检索 / query 改写
- **faithfulness 低**：LLM 在编 → 改 prompt 强调"基于上下文"、降 temperature
- **answer_relevancy 低**：LLM 答非所问 → prompt 工程、加约束
- **answer_correctness 低**：综合不行——但定位要看上面四个

## 5. LangSmith Datasets + `evaluate()`

LangSmith（[langchain/10](../langchain/10-observability-and-production.md)）原生支持评测——把数据集和评估器都托管：

```python
from langsmith import Client
from langsmith.evaluation import evaluate

client = Client()

# 1. 创建数据集（也可以从生产 trace 收集）
dataset = client.create_dataset("rag-eval-v1")
for sample in golden_set:
    client.create_example(
        inputs={"question": sample["question"]},
        outputs={"answer": sample["answer"]},
        dataset_id=dataset.id,
    )

# 2. 定义评估器
def correctness(run, example):
    """LLM 当裁判。"""
    pred = run.outputs["answer"]
    truth = example.outputs["answer"]
    return {"key": "correctness", "score": llm_judge(pred, truth)}

# 3. 跑评测
results = evaluate(
    lambda inputs: my_rag_chain.invoke(inputs["question"]),
    data="rag-eval-v1",
    evaluators=[correctness],
    experiment_prefix="hybrid-rerank-v3",
)
```

LangSmith UI 会自动给你**版本对比表**——清楚看到 v3 比 v2 哪些 case 涨了哪些跌了。

## 6. Pairwise 比较：A/B 谁更好

绝对打分有时不稳，但"A 和 B 哪个好"很稳定：

```python
pairwise_prompt = """
问题：{question}

答案 A：{answer_a}
答案 B：{answer_b}

哪个更好？理由是什么？只输出 A / B / Tie。
"""

def pairwise(question, ans_a, ans_b):
    return llm.invoke(pairwise_prompt.format(...)).content
```

跑 50 条样本：A 赢多少次、B 赢多少次。比绝对分数更"决策有用"。

## 7. 评测 Agentic RAG：节点级 + 端到端

线性 RAG 评 4-5 个指标够了。**Agentic RAG 还要评每个决策节点**：

| 节点 | 评估问题 |
|---|---|
| classifier | 问题分类对不对？ |
| query_rewriter | 改写后的 query 比原 query 好吗？ |
| grade_docs | 文档相关性判断准吗？ |
| grade_answer | 答案 grounded 判断准吗？ |
| retry 决策 | 重试有没有真带来提升？ |

每个节点都给 (input, expected_output) 测试集，单独评。**端到端 + 节点级双管齐下**，才能找到瓶颈。

LangSmith 可以从生产 trace 里**自动收集每个节点的输入输出**——这是它对复杂图最有用的地方。

## 8. 在线评测 / 反馈

离线评测在固定数据集上，**生产里要有持续反馈**：

```python
# 用户给反馈
client.create_feedback(
    run_id=run_id,
    key="user_thumbs_up",
    score=1.0,
)
```

或被动收集：
- 用户多久看完答案（短 → 答得好/差？需要分析）
- 是不是同一会话内反复问同一问题（差信号）
- 是不是被人工接管（明确差）

在线信号 + 离线评测共同驱动迭代。

## 9. 评测的反模式

| 反模式 | 后果 |
|---|---|
| 只看自己想看的 case（cherry-pick） | 改了一个改坏一片 |
| 评测集太小（< 30 条） | LLM 评分自带 ±5% 抖动，看不出真差异 |
| 评测集分布偏离生产 | 离线分高，上线翻车 |
| 评测集泄漏到 prompt 里 | 模型记住了答案，不算评测 |
| 改完不重跑全集 | 局部改动可能影响其他 case |
| 没有版本号 | 改完不知道是哪次实验的成绩 |
| 用 GPT-4o 当裁判，自家也用 GPT-4o | 系统性偏向相似风格的答案 |

## 10. 评测节奏

| 阶段 | 做什么 |
|---|---|
| 第一天 | 建 50 条测试集，跑 baseline（Naive RAG） |
| 第一周 | 针对失败 case 改进，每改一处都跑全集 |
| 第一个月 | 数据集扩到 200-500 条，分类标注 |
| 上线后 | 收集真实日志，扩充评测集；CI 里跑回归 |
| 持续 | A/B 对比新版本；任何架构改动必须 +X% 才合并 |

## 11. 一份最小评测脚本（不用 RAGAS / LangSmith）

```python
import json, statistics
from typing import Callable

def evaluate_rag(
    dataset: list[dict],
    rag_fn: Callable[[str], dict],   # 返回 {"answer": ..., "contexts": [...]}
    judge_llm,
):
    results = []
    for sample in dataset:
        out = rag_fn(sample["question"])

        retrieved_ids = [c.get("metadata", {}).get("id") for c in out["contexts"]]
        hit = any(eid in retrieved_ids for eid in sample["expected_doc_ids"])

        # LLM 判断答案对不对
        verdict = judge_llm.invoke(
            f"问题：{sample['question']}\n标准答案：{sample['answer']}\n"
            f"系统答案：{out['answer']}\n两者一致吗？只回答 yes/no。"
        ).content.strip().lower()

        results.append({
            "question": sample["question"],
            "hit": hit,
            "correct": verdict.startswith("y"),
        })

    print(f"hit rate: {sum(r['hit'] for r in results) / len(results):.2%}")
    print(f"correctness: {sum(r['correct'] for r in results) / len(results):.2%}")
    return results
```

不到 30 行，跑出来已经能驱动迭代。**评测不需要从一开始就完美——能跑出对比就够了**。

## 12. 下一步

- [10 · 生产化](./10-production.md)：把评测接进 CI、监控
- [LangChain 10 · 可观测](../langchain/10-observability-and-production.md)：LangSmith 配置细节
