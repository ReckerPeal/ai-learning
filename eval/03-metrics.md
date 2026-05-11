# 03 · 指标体系

> 选错指标比选错框架危险得多——**框架可以换，指标错了所有数据归零**。

## 1. 指标分类（按计算方式）

| 类 | 例子 | 输入要求 | 速度 | 成本 |
|---|---|---|---|---|
| **确定性匹配** | exact match、regex、JSON schema 校验 | 精确格式 | ⚡⚡⚡ | 0 |
| **统计/启发式** | BLEU、ROUGE、编辑距离、F1（token 级） | 文本相似 | ⚡⚡⚡ | 0 |
| **嵌入相似** | cosine(embedding) | 任意文本 | ⚡⚡ | embed 调用 |
| **分类/抽取专用** | precision / recall / hit rate / MRR | 标注好的 ground truth | ⚡⚡⚡ | 0 |
| **LLM-as-Judge** | faithfulness, relevance, helpfulness | 自由文本 | ⚡ | LLM 调用 |
| **Pairwise** | A vs B 谁更好 | 两个候选 | ⚡ | LLM 或人 |
| **人工** | likert 1-5 / 二元判断 | 任意 | 🐢🐢🐢 | 高 |

## 2. 选指标的"决策树"

```
任务输出能 exact match 吗？
├── 能（分类、SQL、JSON schema、URL）
│      → 用确定性匹配 + 分类指标（acc / F1）
├── 部分能（结构化生成里某些字段）
│      → 字段级 exact match + 整体 LLM judge
└── 不能（开放问答、摘要、翻译）
       │
       有标准答案吗？
       ├── 有（QA、翻译）
       │      → embed 相似度 + LLM-as-Judge 校验
       └── 没有（创意写作、开放对话）
              → Pairwise 比较（A vs B vs ground truth-free）
              → 或定义维度（流畅度 / 相关度）+ LLM-as-Judge
```

## 3. 确定性匹配：最便宜可靠

**只要能用就用**。便宜、快、不抖动。

```python
# Exact match
def exact_match(pred, ref):
    return pred.strip() == ref.strip()

# Normalized exact match（去标点 / 大小写）
import re
def normalize(s):
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", "", s.lower())).strip()

def nem(pred, ref):
    return normalize(pred) == normalize(ref)

# Regex
def matches_pattern(pred, pattern):
    return bool(re.search(pattern, pred))

# JSON schema
import jsonschema
def valid_json(pred, schema):
    try:
        jsonschema.validate(json.loads(pred), schema)
        return True
    except Exception:
        return False
```

适合：
- 分类任务（标签 in 固定集合）
- 抽取任务（JSON 字段精确匹配）
- 结构化输出格式校验（必校验）
- 包含/不包含某关键词（如"应该提到 v3.2"）

## 4. 统计/启发式指标

### 4.1 N-gram 类（BLEU / ROUGE / chrF）

经典 NLP 指标，按 n-gram 重叠打分：

```python
from sacrebleu import corpus_bleu, corpus_chrf
from rouge_score import rouge_scorer

bleu = corpus_bleu([pred], [[ref]]).score
chrf = corpus_chrf([pred], [[ref]]).score
rouge = rouge_scorer.RougeScorer(["rougeL"]).score(ref, pred)["rougeL"].fmeasure
```

用途：翻译、摘要、改写场景的"基线指标"。
**局限**：和人类判断相关性弱，**不能单独作为决定性指标**。

### 4.2 编辑距离 / 序列相似度

```python
import Levenshtein
def edit_sim(a, b):
    return 1 - Levenshtein.distance(a, b) / max(len(a), len(b))
```

适合：拼写纠错、规整化、SQL 比较。

### 4.3 Embedding 相似度

```python
from langchain_openai import OpenAIEmbeddings
import numpy as np

emb = OpenAIEmbeddings()
def cos_sim(a: str, b: str) -> float:
    va, vb = emb.embed_query(a), emb.embed_query(b)
    return float(np.dot(va, vb) / (np.linalg.norm(va) * np.linalg.norm(vb)))
```

比 BLEU 更接近"语义相似"，但仍然**不等于"答得对"**——两个意思相近但事实错的答案分也会高。

适合：用作**辅助/兜底**指标，不要当主指标。

## 5. 分类 / 抽取的标准指标

```python
from sklearn.metrics import accuracy_score, precision_recall_fscore_support

acc = accuracy_score(y_true, y_pred)
prec, rec, f1, _ = precision_recall_fscore_support(y_true, y_pred, average="weighted")
```

| 指标 | 含义 | 何时关注 |
|---|---|---|
| Accuracy | 总体准确率 | 类别平衡 |
| Precision | 预测为正里真的占比 | 误报代价高（垃圾邮件） |
| Recall | 真正的里被预测出来的占比 | 漏报代价高（医疗筛查） |
| F1 | P 和 R 的调和平均 | 两者都重要 |
| Macro F1 | 各类 F1 算平均 | 类别不平衡时用 |

LLM 分类任务（intent classification、moderation）首选 **macro F1 + 混淆矩阵**——单看 accuracy 会被多数类掩盖问题。

## 6. 检索类指标（RAG 必备）

| 指标 | 公式 | 意义 |
|---|---|---|
| **Hit Rate@k** | 期望 doc 在 top-k 里的比例 | 召回了吗？ |
| **MRR@k** | 1 / 期望 doc 的排名 | 排得靠前吗？ |
| **NDCG@k** | 考虑相关度等级的归一化排序质量 | 多级相关度场景 |
| **Recall@k** | top-k 里的相关 doc 数 / 总相关数 | 召全了吗？ |
| **Precision@k** | top-k 里相关 doc 数 / k | top-k 的纯净度 |

```python
def hit_rate(results, expected_ids, k=5):
    return any(d.id in expected_ids for d in results[:k])

def mrr(results, expected_ids, k=5):
    for i, d in enumerate(results[:k], 1):
        if d.id in expected_ids:
            return 1 / i
    return 0
```

详见 [rag-advanced/09](../rag-advanced/09-evaluation.md) 和 [eval/06](./06-rag-eval.md)。

## 7. 生成质量指标：LLM-as-Judge

开放生成场景没有标准答案，主流做法是让 LLM 当 judge。基础几种：

### 7.1 Pointwise（单样本打分）

让 LLM 对单个回答按某维度 1-5 / 1-10 打分：

```python
from pydantic import BaseModel, Field

class Score(BaseModel):
    rationale: str = Field(description="评分理由")
    score: int = Field(ge=1, le=5)

prompt = """请按"答案是否回答了问题"打分（1-5）：

问题：{question}
答案：{answer}

评分标准：
1: 完全没回答
2: 偏题
3: 部分回答
4: 基本回答
5: 完整准确回答
"""

judge = ChatOpenAI(model="gpt-4o", temperature=0).with_structured_output(Score)
```

**问题**：Pointwise 不稳——同一个 judge 对同一答案打分，不同时间 / 措辞会有 ±1 抖动。

### 7.2 Reference-based 二元判断（更稳）

有标准答案时，直接问"和标准答案一致吗？"：

```python
class Verdict(BaseModel):
    same: bool

prompt = """以下两个回答说的是同一个意思吗？只看核心事实，措辞可以不同。

标准答案：{reference}
系统答案：{prediction}
"""
```

二元判断（yes/no）比 Likert 打分稳定得多——**有 reference 必用**。

### 7.3 Pairwise（最稳）

两个候选答案，让 judge 选谁更好：

```python
class Pairwise(BaseModel):
    winner: Literal["A", "B", "tie"]
    rationale: str

prompt = """问题：{question}
答案 A：{ans_a}
答案 B：{ans_b}

哪个更好？只输出 A、B 或 tie。
"""
```

Pairwise 一致性远高于 Pointwise——同一对答案 judge 多次结果几乎一致。**建议默认用 pairwise 比版本**。

详见 [04 · LLM-as-Judge 深度](./04-llm-as-judge.md)。

## 8. RAG / Agent 专用复合指标

### 8.1 RAG 三件套（来自 RAGAS）

| 指标 | 测什么 |
|---|---|
| **Faithfulness** | 答案是否完全基于上下文（无幻觉） |
| **Answer Relevancy** | 答案是否回答了问题 |
| **Context Precision** | 检索结果里相关 doc 占比 |
| **Context Recall** | 期望 doc 是否都被检索到 |
| **Answer Correctness** | 答案是否正确（vs ground truth） |

详见 [06 · RAG 评测](./06-rag-eval.md)。

### 8.2 Agent 维度

| 指标 | 测什么 |
|---|---|
| **Task Success** | 最终结果对吗？ |
| **Tool Selection** | 选对工具了吗？ |
| **Trajectory Match** | 步骤序列是否合理 |
| **Step Count** | 多少步完成 |
| **Cost** | Token / 工具调用费用 |

详见 [07 · Agent 评测](./07-agent-eval.md)。

## 9. 多指标合成：怎么权衡

很少有"一个指标解决一切"。常见做法：

### 9.1 主指标 + 守门指标

```
主指标:    answer_correctness（最关心）
守门指标:  faithfulness ≥ 0.9 且 latency_p95 ≤ 5s
```

主指标涨了，但 faithfulness 跌破 0.9 → **拒绝合并**。

### 9.2 加权综合

```
final = 0.5 * correctness + 0.3 * faithfulness + 0.2 * relevancy
```

简单粗暴，但**权重靠拍**。慎用——一旦大家盯着 final 分，就会出现 over-fit 单一权重的优化。

### 9.3 Pareto 前沿

把每个候选画在指标空间，看哪些是"非劣"的（没有任何候选在所有维度都更好）。适合需要综合考虑成本-质量-延迟的场景。

## 10. 指标的"meta-指标"：你的指标可信吗

任何指标自身要被检验：

| 元指标 | 怎么测 |
|---|---|
| **稳定性** | 同样的输入跑 5 次，结果方差多大 |
| **可解释性** | 分数高/低时能不能说出"为什么" |
| **与人类判断的相关性** | 抽 50 条人工打分，算 Spearman 相关系数 |
| **区分度** | 在两个明显不同的版本上能不能拉开差距 |
| **作弊难度** | 是不是改一行 prompt 就能刷分（坏信号） |

**新引入一个指标，先做这 5 项检验再用**——否则可能引入错误导向。

## 11. 实操：一个生产级 RAG 项目的指标盘

```
┌────── 检索层 ──────────────┐
│  Hit Rate@5            > 0.85
│  MRR@5                  > 0.6
│  Context Precision      > 0.7
└────────────────────────────┘
┌────── 生成层 ──────────────┐
│  Faithfulness           > 0.9    ← 守门
│  Answer Relevancy       > 0.85
│  No-answer detection    > 0.9    ← 不该答的别答
└────────────────────────────┘
┌────── 端到端 ──────────────┐
│  Answer Correctness     ↑       ← 主指标
│  Pairwise Win vs v_prev > 50%
└────────────────────────────┘
┌────── 守门 ────────────────┐
│  Latency p95          < 5s
│  Cost / call          < $0.02
│  Hallucination rate   < 1%
└────────────────────────────┘
```

每次实验报告都填这一张表 + 分组细化。**有这张表的团队和没这张表的团队，迭代效率差 10 倍**。

## 12. 常见坑

| 现象 | 原因 |
|---|---|
| 主指标涨了，用户体验跌 | 指标和真实目标错位；加 pairwise 校准 |
| 同一版本两次评测分不同 | 用 LLM judge 没设 t=0；或 judge 自身漂移 |
| BLEU/ROUGE 看不出差距 | 任务不适合 n-gram 指标；上 LLM-as-Judge |
| LLM-as-Judge 总打 4-5 分 | judge 太宽容；改 prompt 加严格示例 / 用 pairwise |
| Embedding 相似度高但答错 | 指标只测"像"不测"对"；加 reference-based judge |
| 加权综合分一直涨但局部退化 | 权重 over-fit；改用守门 + Pareto |

## 13. 下一步

- [04 · LLM-as-Judge 深度](./04-llm-as-judge.md)：让 judge 稳、准、可解释
- [05 · 评测框架对比](./05-frameworks.md)：哪个工具落地这些指标
