# 04 · LLM-as-Judge 深度

> 让 LLM 给 LLM 打分听起来"用魔法打败魔法"，但只要**正确使用**，是开放生成场景下唯一可规模化的评测方法。本章讲它的原理、偏差、如何校准、什么 prompt 模板靠谱。

## 1. 为什么 LLM 能当 Judge

研究（[MT-Bench, 2023](https://arxiv.org/abs/2306.05685)）发现：**强模型（GPT-4、Claude Sonnet 4+）作为 judge 时，与人类专家的一致率达到 80%+，与人类之间的一致率（也就 80% 左右）相当**。

也就是说：在开放问答和对话场景，让 GPT-4 当 judge ≈ 让另一个人类专家当 judge。

但**前提**是：
- 用足够强的模型（不是 mini）
- 评测维度明确，prompt 设计正确
- 知道并控制 LLM judge 的偏差

## 2. LLM-as-Judge 的已知偏差

不知道这些偏差就用 judge，结果会系统性失真。

### 2.1 位置偏差（Position Bias）

Pairwise 比较时，**顺序影响判断**——把同一对答案 (A, B) 和 (B, A) 给 judge，结果可能不一致，且常常偏向第一个或第二个。

**对策**：每对都跑两次（互换位置），取一致的结果；不一致 → tie。

```python
def pairwise_consistent(q, ans_a, ans_b, judge):
    r1 = judge(q, ans_a, ans_b)   # A 在前
    r2 = judge(q, ans_b, ans_a)   # B 在前
    if r1 == "A" and r2 == "B":
        return "A"   # 两次都说"第一个的内容"赢，等价于 ans_a 赢
    if r1 == "B" and r2 == "A":
        return "B"
    return "tie"
```

### 2.2 长度偏差（Verbosity Bias）

LLM judge 倾向认为**更长**的答案更好——即使长答案在啰嗦或跑题。

**对策**：
- prompt 明确说"长度不是评分依据"
- 控制候选答案的长度差异（截断到相近）
- 加"简洁性"作为单独维度

### 2.3 自我偏好（Self-bias）

判断者倾向更高评价**和自己同家族**的输出。GPT-4 给 GPT-4 的答案高分概率比给 Claude 的略高。

**对策**：
- judge 用**与 subject 不同家族**的模型（subject 是 GPT，judge 用 Claude；反之亦然）
- 多 judge 投票（用 2-3 个不同模型的多数票）

### 2.4 风格偏差

格式好（用 markdown、有列表、有代码块）的答案被认为更好——内容相同的情况下也是。

**对策**：prompt 显式告诉 judge "格式不是判分维度"。

### 2.5 答案过长偏离主题

长答案里塞了一段相关内容、剩下都是水——LLM judge 容易被"看到了相关内容"误导。

**对策**：用"逐步打分（step-by-step rubric）"，先列出"必要点"，再判断是否覆盖。

### 2.6 顺承偏差（Sycophancy）

LLM 倾向赞同 prompt 里**已经表达的立场**。如果 judge prompt 里说"我觉得这个答案不太好，请评估"——judge 真的会更可能打低。

**对策**：judge prompt 中性化，不暗示倾向。

### 2.7 难题打高分

模型自己答不出来的题，给候选打分时反而更宽容（"难题答成这样不错了"）。

**对策**：reference-based 判断（提供标准答案）；难题用人工抽查校准。

## 3. Pointwise vs Pairwise vs Reference-based

| 方法 | 稳定性 | 信号强度 | 适合 |
|---|---|---|---|
| **Pointwise（绝对打分）** | 弱 ★★ | 强 ★★★★ | 监控指标（绝对分） |
| **Pairwise（A vs B）** | 强 ★★★★★ | 中 ★★★ | 版本对比、ranking |
| **Reference-based 二元** | 强 ★★★★ | 强 ★★★★ | 有标准答案的 QA |
| **Reference-based 多维** | 中 ★★★ | 强 ★★★★ | 详细对比 |

经验：

- **有 reference**：用 reference-based 二元（"和参考一致吗 yes/no"）
- **没 reference 但要绝对分数**：pointwise + 多次平均 + 严格 rubric
- **比较两个版本**：永远 pairwise
- **要写 leaderboard**：pairwise + ELO（如 chatbot arena）

## 4. 一个稳的 Pairwise prompt 模板

参考 MT-Bench / Arena-Hard：

```python
PAIRWISE_PROMPT = """请充当公正的评审，判断两个 AI 助手对同一用户问题的回答哪个更好。

评判维度（按重要性）：
1. 准确性：事实是否正确，没有幻觉
2. 完整性：是否充分回答了问题
3. 相关性：是否切题、不绕弯
4. 清晰性：表达是否清晰

**不**作为评判依据的：
- 答案长度（不要因为长就打高分）
- 格式装饰（markdown、emoji 等）
- 答案位置（A 还是 B）

操作步骤：
1. 先逐条分析两个答案在每个维度的表现
2. 综合判断
3. 给出最终结论

最后只输出一行，格式严格为：
[[A]] / [[B]] / [[Tie]]

---
[用户问题]
{question}

[助手 A 的答案]
{answer_a}

[助手 B 的答案]
{answer_b}
"""
```

要点：
- **明确评判维度**（关键）
- **明确不评判什么**（防长度/格式偏差）
- **要求先分析再结论**（chain-of-thought 提升质量）
- **结果格式严格**（便于解析）

解析：

```python
import re

def parse_verdict(text: str) -> str:
    m = re.search(r"\[\[(A|B|Tie)\]\]", text)
    return m.group(1) if m else "Tie"
```

## 5. Pointwise 模板（rubric-based）

绝对打分时，**给详细 rubric 比给 1-5 抽象分数好**：

```python
POINTWISE_PROMPT = """评估下面这个答案的"准确性"，按下列标准选择一个：

1（差）：事实严重错误，或与问题无关
2（弱）：核心事实有错误，但有部分正确
3（中）：基本正确，但有小错或遗漏
4（好）：完全正确，覆盖问题主要部分
5（优）：完全正确且全面，包括细节和边界

要求：
- 先列出答案中的每个事实声明
- 逐条判断对错
- 综合打分

问题：{question}
答案：{answer}
{reference_section}

最后只输出一行：[[1]] / [[2]] / [[3]] / [[4]] / [[5]]
"""
```

## 6. 用结构化输出代替正则解析

```python
from pydantic import BaseModel, Field
from typing import Literal

class PairwiseVerdict(BaseModel):
    rationale_a: str = Field(description="A 的优势和劣势")
    rationale_b: str = Field(description="B 的优势和劣势")
    final_reason: str = Field(description="综合判断的理由")
    verdict: Literal["A", "B", "Tie"]

judge = ChatOpenAI(model="gpt-4o", temperature=0).with_structured_output(PairwiseVerdict)

result = judge.invoke(prompt.format(question=q, answer_a=a, answer_b=b))
print(result.verdict, result.final_reason)
```

好处：
- 不用写正则
- 强迫 judge 写理由（便于事后审计）
- 解析失败率几乎为 0

## 7. 让 judge 更可靠的工程技巧

### 7.1 多次投票

```python
def majority_vote(q, a, b, judge, n=3):
    verdicts = [judge(q, a, b) for _ in range(n)]
    return Counter(verdicts).most_common(1)[0][0]
```

判断不稳的关键 case 用 3 次投票；普通 case 1 次省成本。

### 7.2 多 judge 集成

```python
judges = [
    ChatOpenAI(model="gpt-4o"),
    ChatAnthropic(model="claude-sonnet-4-5"),
    ChatOpenAI(model="gpt-4-turbo"),
]
verdicts = [run_judge(j, q, a, b) for j in judges]
final = Counter(verdicts).most_common(1)[0][0]
```

跨家族集成 → 缓解自我偏好。**重要决策（如发版评估）值得多投一次**。

### 7.3 强制 step-by-step

prompt 里加："请先列出 1) 2) 3) 分析步骤，再得出结论。"
LLM judge 在结构化思考下偏差降低 10-20%。

### 7.4 限制 judge 看到的信息

判断"答案是否 grounded"时，**只**给 judge 看上下文 + 答案，**不**给问题——避免 judge 用自己知识判断。
判断"答案是否回答了问题"时，**不**给上下文，只给问题 + 答案。

每个维度让 judge 看必要的、最少的信息——减少 noise。

## 8. 校准：和人类判断对齐

Judge 给的分数本身可能稳定，但要确认它和**真正的人类判断**一致。

### 8.1 校准流程

```
Step 1: 抽 50-100 条样本
Step 2: 找 2-3 个领域专家独立打分（pairwise 或 rubric）
Step 3: 计算专家之间的一致率（α，inter-rater agreement）
Step 4: 把同一批跑 LLM judge
Step 5: 计算 LLM 与专家一致率（β）
Step 6: 比较：β 应该接近 α
```

如果 β 明显低于 α → judge prompt 有问题，调整后重测。

### 8.2 一致率指标

- **百分比一致率**：直观但不调校 chance
- **Cohen's Kappa**：调校了 chance，更可靠
- **Spearman / Pearson 相关**：用于连续打分

```python
from sklearn.metrics import cohen_kappa_score
kappa = cohen_kappa_score(human_labels, llm_labels)
# > 0.6 = 实质一致；> 0.8 = 高度一致
```

### 8.3 持续校准

校准不是一次性的——每次大改 judge prompt 或换 judge 模型都该重测。

每月抽 20 条 trace 人工标注一次，跟 judge 对账，trend 明显偏离就排查。

## 9. Judge 的常见 prompt 错误

| 错误 | 后果 | 改成 |
|---|---|---|
| "你是世界上最严格的评审" | judge 给所有都打低分 | "你是公正客观的评审" |
| "请给一个 1-10 分的分数" | 分数全集中在 7-9 | 给详细 rubric，每分对应描述 |
| 没要求理由 | 不可审计、不稳定 | 强制先写 rationale |
| 没规定输出格式 | 解析失败率高 | 严格 `[[A]]` 或结构化输出 |
| 维度不清晰（"评估质量"） | judge 自由发挥 | 明确"准确性"、"相关性"分别评 |
| 给了问题答案的提示 | sycophancy | prompt 中性，让 judge 独立判 |

## 10. 端到端例子：一个完整的 Pairwise 评测器

```python
from typing import Literal
from pydantic import BaseModel, Field
from langchain_openai import ChatOpenAI
from langchain_anthropic import ChatAnthropic
from collections import Counter
import random

JUDGE_PROMPT = """..."""   # 第 4 节那段

class Verdict(BaseModel):
    rationale: str
    verdict: Literal["A", "B", "Tie"]

judges = {
    "gpt4o":   ChatOpenAI(model="gpt-4o", temperature=0).with_structured_output(Verdict),
    "claude":  ChatAnthropic(model="claude-sonnet-4-5", temperature=0).with_structured_output(Verdict),
}

def judge_pair(question, ans_a, ans_b, swap_check=True):
    """返回 (winner, confidence)"""
    votes = []
    for name, j in judges.items():
        v = j.invoke(JUDGE_PROMPT.format(question=question, answer_a=ans_a, answer_b=ans_b))
        votes.append(v.verdict)
        if swap_check:
            v2 = j.invoke(JUDGE_PROMPT.format(question=question, answer_a=ans_b, answer_b=ans_a))
            # 互换：原 A 现在是 B
            translated = {"A": "B", "B": "A", "Tie": "Tie"}[v2.verdict]
            votes.append(translated)
    counter = Counter(votes)
    winner, count = counter.most_common(1)[0]
    confidence = count / len(votes)
    return winner, confidence

def evaluate_versions(dataset, version_a, version_b):
    wins = {"A": 0, "B": 0, "Tie": 0}
    for sample in dataset:
        ans_a = version_a.invoke(sample["input"])
        ans_b = version_b.invoke(sample["input"])
        winner, conf = judge_pair(sample["question"], ans_a, ans_b)
        if conf < 0.6:
            winner = "Tie"   # 不够 confident 算平局
        wins[winner] += 1
    return wins
```

## 11. 性能与成本

每条 pairwise 判断：
- 单 judge、不互换：1 次 LLM 调用，~$0.005-0.02
- 单 judge、互换：2 次 → ~$0.01-0.04
- 双 judge、互换：4 次 → ~$0.02-0.08

跑 200 条评测，集成 + 互换 → 约 $4-16 一轮。**评测成本可控**——大头还是 subject 自己的调用。

省成本：
- 主指标用 mini judge（gpt-4o-mini / haiku）粗筛
- 关键 case（不一致、低置信）用强 judge 复核
- 把 judge 结果缓存（key = hash(question, ans_a, ans_b)）

## 12. 常见坑

| 现象 | 原因 |
|---|---|
| Judge 给所有版本都打 4-5 分 | rubric 不严；改 pairwise，或加严格示例 |
| 互换位置后结果反转 | 强 position bias；多投票 + 互换 |
| Judge 与人类不一致 | 维度模糊 / 用了弱 judge / 自我偏好 |
| 同一条样本 judge 多次结果不同 | temperature 没设 0；prompt 不够确定 |
| 上线后用户反馈和 judge 分背道而驰 | judge 评的维度和用户在乎的不一致；重新设计 rubric |
| Judge 倾向更长答案 | 长度偏差；明确"长度不是依据"；控制候选长度 |

## 13. 下一步

- [05 · 评测框架对比](./05-frameworks.md)：LangSmith / RAGAS / DeepEval 内置的 judge
- [08 · 在线评测](./08-online-and-ab.md)：用 pairwise 做 A/B
