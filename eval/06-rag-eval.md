# 06 · RAG 评测

> 本章是 [rag-advanced/09-evaluation.md](../rag-advanced/09-evaluation.md) 的延续与系统化。前者面向 RAG 工程师，本章从 eval 视角进一步深化指标与方法。

## 1. RAG 评测的核心难点

普通 LLM 评测一对一：(question, answer)。RAG 评测多了**两层中间态**——**检索的文档**和**答案对文档的依赖关系**。常见错位：

- 答案是对的，但**不是**从检索文档得到的（"幻觉刚好猜对"）
- 检索的文档是对的，但 LLM **没用上**
- 检索文档很好，LLM 答得很好，但**用了错误的 doc 推出对的答**（运气）

**只看端到端的对错会放过这些问题**——必须分层评测。

## 2. 三层评测拆解

```
┌─── 层 1：检索 ────────────┐
│  question → retrieved docs │
│  指标：hit rate / MRR / context precision / recall
└────────────────────────────┘
            ↓
┌─── 层 2：生成 ────────────┐
│  (question, contexts) → answer
│  指标：faithfulness / answer relevancy
└────────────────────────────┘
            ↓
┌─── 层 3：端到端 ──────────┐
│  question → answer
│  指标：answer correctness / 用户满意度
└────────────────────────────┘
```

每层独立评测，**才能定位故障**。

## 3. 检索层指标（详）

### 3.1 Hit Rate@k

期望文档是否在 top-k 里：

```python
def hit_rate(retrieved, expected_ids, k=5):
    return any(d.metadata["id"] in expected_ids for d in retrieved[:k])

avg = sum(hit_rate(retrieve(s["q"]), s["expected"]) for s in dataset) / len(dataset)
```

**最简单粗暴的检索指标**——k=5 命中率到不了 80%，下游怎么优化都白搭。

### 3.2 MRR@k（Mean Reciprocal Rank）

期望文档排第几——排越前分越高：

```python
def mrr(retrieved, expected_ids, k=10):
    for i, d in enumerate(retrieved[:k], 1):
        if d.metadata["id"] in expected_ids:
            return 1 / i
    return 0
```

`MRR=0.5` 意味着平均期望文档排在 2 位，`0.33` 排在 3 位。**调 reranker 时这是主指标**。

### 3.3 NDCG@k

如果文档相关度有"等级"（高度相关 / 一般相关 / 不相关），用 NDCG：

```python
import math

def dcg(rels):
    return sum(r / math.log2(i + 2) for i, r in enumerate(rels))

def ndcg(retrieved_rels, ideal_rels, k=10):
    return dcg(retrieved_rels[:k]) / dcg(sorted(ideal_rels, reverse=True)[:k])
```

`retrieved_rels` 是检索结果按顺序的相关度等级，`ideal_rels` 是该 query 所有相关文档的等级。

适合：标注精细的评测集；学术 IR 评测。

### 3.4 Context Precision / Recall（来自 RAGAS）

| 指标 | 算法 |
|---|---|
| Context Precision | top-k 检索结果里**真正相关**的占比（LLM 判断每个 doc 与 query 相关性） |
| Context Recall | 期望文档里**有多少**被检索到了 |

```python
from ragas.metrics import context_precision, context_recall
```

特点：
- **不需要 expected doc IDs**（context_precision 用 LLM judge）
- 但需要 **ground_truth answer**（context_recall 用它推断"该答案需要哪些信息"）

适合：评测集没有标注期望文档，但有标准答案。

## 4. 生成层指标（详）

### 4.1 Faithfulness（忠实度 / 不幻觉）

答案里的每个声明，能不能从上下文找到支撑。

RAGAS 实现：
1. 让 LLM 把答案拆成"独立声明（claims）"
2. 对每个 claim，问 LLM "上下文里能不能推出这个 claim"
3. 比例 = faithfulness

```python
from ragas.metrics import faithfulness
```

**Faithfulness 是 RAG 最关键的指标**——业务上"宁可说不知道，不要瞎编"。

实操阈值：
- < 0.7：严重幻觉，prompt 工程兜底
- 0.7-0.9：可接受，需关注
- ≥ 0.9：合格

### 4.2 Answer Relevancy

答案是否回答了问题（不偏题、不水）。

RAGAS 实现：
1. 让 LLM 反向"由答案生成可能的问题"
2. 计算反向问题与原问题的 embedding 相似度
3. 平均相似度 = relevancy

直觉：好答案能反推出原问题，差答案推不出。

### 4.3 Groundedness vs Faithfulness

很多文献把 groundedness 和 faithfulness 混用。**严格意义**：
- **Faithfulness**：答案里的事实**没超出**上下文（不无中生有）
- **Groundedness**：答案里的事实**能在**上下文中**定位**（每句话有引用）

工程上一般合在一起评。

### 4.4 Citation 评测（可选）

如果要求 LLM 给引用：

```python
def citation_accuracy(answer, citations, contexts):
    """
    answer = "...[1]...[2]..."
    citations = {1: "doc-42", 2: "doc-7"}
    检查每个引用真的支持对应陈述。
    """
    ...
```

实现稍复杂——一般用 LLM judge 做。

## 5. 端到端指标

### 5.1 Answer Correctness（vs Ground Truth）

最直接：和标准答案一致吗。

```python
from ragas.metrics import answer_correctness
```

RAGAS 的 answer_correctness 是**事实匹配 + 语义相似**的混合分。

替代方案：**reference-based 二元 LLM judge**（[04 · LLM-as-Judge](./04-llm-as-judge.md)）：

```python
prompt = """
两个回答说的是同一个意思吗？只看核心事实。
标准答案：{reference}
系统答案：{prediction}
[[YES]] / [[NO]]
"""
```

### 5.2 No-Answer Detection

某些问题的正确答案是 **"我不知道"**——评估系统是否会"该不知道时不知道"：

```python
no_answer_set = [
    {"q": "你的 API 中第 47 个 endpoint 叫什么？", "expected": None, "should_refuse": True},
    {"q": "下季度财务预测", "expected": None, "should_refuse": True},
]

def refuse_score(answer, should_refuse):
    answered = "不知道" not in answer and "无法" not in answer
    return int(answered != should_refuse)
```

**很多 RAG 系统的"幻觉"本质是"该说不知道却答了"**——这个指标专治这个。

## 6. 一份完整 RAGAS 例子

```python
from datasets import Dataset
from ragas import evaluate
from ragas.metrics import (
    context_precision, context_recall,
    faithfulness, answer_relevancy, answer_correctness,
)
from ragas.llms import LangchainLLMWrapper
from ragas.embeddings import LangchainEmbeddingsWrapper
from langchain_openai import ChatOpenAI, OpenAIEmbeddings

# 1. 跑你的 RAG 链得到结果
results = []
for sample in golden_set:
    ans = my_rag_chain.invoke({"question": sample["q"]})
    results.append({
        "question": sample["q"],
        "answer": ans["answer"],
        "contexts": [d.page_content for d in ans["contexts"]],
        "ground_truth": sample["a"],
    })

# 2. 转成 ragas Dataset
ds = Dataset.from_list(results)

# 3. 配置 judge LLM（默认 OpenAI）
judge_llm = LangchainLLMWrapper(ChatOpenAI(model="gpt-4o", temperature=0))
judge_emb = LangchainEmbeddingsWrapper(OpenAIEmbeddings())

# 4. 评测
result = evaluate(
    ds,
    metrics=[context_precision, context_recall, faithfulness, answer_relevancy, answer_correctness],
    llm=judge_llm,
    embeddings=judge_emb,
)
print(result)

# 5. 单条详细
df = result.to_pandas()
df[df["faithfulness"] < 0.7]   # 找出幻觉案例
```

## 7. 把 RAG 评测接进 LangSmith

```python
from langsmith.evaluation import evaluate

def run_rag(inputs):
    out = my_rag_chain.invoke({"question": inputs["question"]})
    return {
        "answer": out["answer"],
        "contexts": [d.page_content for d in out["contexts"]],
    }

def faithfulness_evaluator(run, example):
    # 用 RAGAS 的实现
    score = compute_faithfulness(
        question=run.inputs["question"],
        answer=run.outputs["answer"],
        contexts=run.outputs["contexts"],
    )
    return {"key": "faithfulness", "score": score}

results = evaluate(
    run_rag,
    data="rag-golden-v1",
    evaluators=[faithfulness_evaluator, ...],
    experiment_prefix="rag-v3.2-hybrid-rerank",
)
```

LangSmith UI 直接出每个 metric 的分布、按 metadata 切片、对比历史实验。

## 8. 评测 Agentic RAG 的额外维度

[Agentic RAG（rag-advanced/07）](../rag-advanced/07-agentic-rag.md) 比线性 RAG 多了**决策节点**（grade_docs、rewrite、retry...）。除了上面那些指标，还要评：

| 节点 | 评估 |
|---|---|
| classifier | 问题分类对吗？（accuracy） |
| grade_docs | 文档相关性判断对吗？（与人工标注比对） |
| rewrite_query | 改写后的 query 是否真的更好？（hit rate 提升对比） |
| grade_answer | "答案是否 grounded"判断准吗？ |
| retry 决策 | 重试是否真的带来 hit rate 提升 |

实操：每个评估节点都做成可单测的函数，**单独**评测它的输入输出。

```python
def test_grader_recall():
    """grader 不应该把相关文档判成 irrelevant。"""
    for sample in grader_test_set:
        verdict = grade_doc(sample["question"], sample["doc"])
        assert verdict == sample["expected_verdict"]
```

## 9. 把"失败 case"反向构造评测集

每发现一个失败，分类登记：

| 失败类型 | 测试集 |
|---|---|
| 召回不到正确 doc | retrieval_set（重点测检索） |
| 召回了但答错 | generation_set（contexts 已知，只测 LLM） |
| 该说不知道却答了 | no_answer_set |
| 多跳问题答不出 | multi_hop_set |
| 用户输入很模糊 | query_quality_set |

每类 20-50 条，单独跟踪指标——比一个大综合分有用得多。

## 10. RAG 评测节奏

| 频率 | 做什么 |
|---|---|
| 每次 PR | 跑 mini set（30 条），分钟级 |
| 每天 | 跑 full golden（200-500 条），10 分钟级 |
| 每周 | 跑 stress / regression set + 对比上周 baseline |
| 每月 | 抽 30 条人工 review，校准 LLM judge |
| 大改 / 上线前 | 跑全部 + pairwise vs 当前线上版本 |

## 11. 常见坑（RAG eval 专属）

| 现象 | 原因 |
|---|---|
| Faithfulness 低但答案肉眼看对 | LLM 引入了上下文里没明说但常识对的事；判断偏严；调 prompt 或换 judge |
| Context Recall 高但 Faithfulness 低 | 检索召到了相关 doc，但 LLM 没用、自己编了；prompt 工程或换强模型 |
| Answer Correctness 高但用户反馈差 | 评测集偏离真实分布；用真实日志重建 |
| RAGAS 跑得慢 | 默认顺序调用 judge；用 `is_async=True` 并行 |
| 不同 judge 模型分差很大 | 模型偏差；固定一个 judge，记录版本号 |
| 评测集和文档库重叠 | golden set 的问题在文档库里能找到原话；要么是好事（测召回），要么是泄漏（测生成时给 LLM 直接抄）；分层评估 |

## 12. 下一步

- [07 · Agent 评测](./07-agent-eval.md)：评测 Agent 的轨迹和决策
- [09 · CI 与回归](./09-ci-and-regression.md)：把 RAG 评测接进 CI
