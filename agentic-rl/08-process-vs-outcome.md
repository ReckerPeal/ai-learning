# 08 · 过程监督 vs 结果监督

> ORM 看终点对不对，PRM 看每一步对不对。一句话总结争议：**ORM 简单但稀疏，PRM 密集但贵且容易刷分**。2024-2025 年的共识是"先 ORM，再 PRM，再混合"。

本章讨论 reward model 的两大分支：Outcome Reward Model（ORM）和 Process Reward Model（PRM），以及在 reasoning / Agent 场景下怎么选。

## 1. 定义与对比

```text
ORM（结果监督）：
  reward(trajectory) = f(final_answer)
  → 一个 scalar，端到端给

PRM（过程监督）：
  reward(trajectory) = Σ_t f(step_t)
  → 每个推理步骤一个 reward
```

| 维度 | ORM | PRM |
| --- | --- | --- |
| 标注成本 | 1 个标 / 样本 | N 个标 / 样本（N=步骤数） |
| 信号密度 | 稀疏 | 密集 |
| 实现简单度 | 高 | 中 |
| 易 reward hack | 中 | 高（每步都能刷） |
| RL 收敛速度 | 慢 | 快 |
| 适合任务 | 答案二值 | 长链推理 |
| 代表数据集 | GSM8K / MATH 答案 | PRM800K |
| 代表论文 | InstructGPT, R1 | Let's Verify Step by Step |

## 2. PRM800K：过程监督的奠基数据集

OpenAI 2023 *Let's Verify Step by Step* (Lightman et al.) 发布了 PRM800K：

| 字段 | 规模 |
| --- | --- |
| 问题数（MATH） | 12K |
| trajectory 数 | 75K |
| 步骤数 | 800K |
| 每步标签 | {good / neutral / bad} |
| 标注成本 | $XXM 量级 |

PRM800K 训出来的 PRM 在 MATH best-of-N 上比 ORM 高 ~10 个点。

```python
# PRM 数据示意
{
  "problem": "Compute 12 × 34",
  "steps": [
    {"text": "12 × 34 = 12 × 30 + 12 × 4", "label": "good"},
    {"text": "= 360 + 48",                  "label": "good"},
    {"text": "= 380",                       "label": "bad"},   # 算错
    {"text": "So the answer is 380.",       "label": "bad"},
  ]
}
```

## 3. PRM 训练

```python
# 把 PRM 当 step-level 分类器训
from transformers import (AutoTokenizer, AutoModelForSequenceClassification,
                          Trainer, TrainingArguments)

tok = AutoTokenizer.from_pretrained("Qwen/Qwen2.5-Math-7B")
# num_labels=2 表示 good / bad 二分类（或回归 -1/0/1）
model = AutoModelForSequenceClassification.from_pretrained(
    "Qwen/Qwen2.5-Math-7B", num_labels=2)

# 数据：每条 = (problem + steps_so_far, label_of_last_step)
def to_step_samples(ex):
    samples = []
    prefix = ex["problem"]
    for s in ex["steps"]:
        prefix = prefix + "\n" + s["text"]
        label = 1 if s["label"] == "good" else 0
        samples.append({"text": prefix, "label": label})
    return samples

# 训出来的 PRM：给 (problem + partial_trace)，输出 good 概率
def prm_score(problem, trace_steps):
    prefix = problem
    scores = []
    for s in trace_steps:
        prefix = prefix + "\n" + s
        logits = model(**tok(prefix, return_tensors="pt")).logits
        scores.append(logits.softmax(-1)[0, 1].item())  # P(good)
    return scores
```

| 关键 | 说明 |
| --- | --- |
| 输入是 prefix 而非孤立 step | 评估"这一步对不对"需要上下文 |
| 二分类 vs 回归 | 实际多用二分类 + 阈值 |
| 数据增广 | 用 SFT 模型生成新 trace，弱 PRM 标 |
| Aggregation | 整 trace reward = min / mean / product |

> aggregation 选择影响很大：min 最严苛（任何一步坏整 trace 0），product 平滑，mean 折中。MATH 上 min 效果最好（Lightman 2023 Table 3）。

## 4. PRM 在 RL 里怎么用

```python
# GRPO + PRM 混合 reward
def hybrid_reward(prompts, completions, answer, **kw):
    rewards = []
    for c, g in zip(completions, answer):
        steps = c.split("\n")
        # outcome reward
        ans_r = math_verify(c, g)
        # process reward
        prm_scores = prm_score(prompts, steps)
        proc_r = sum(prm_scores) / len(prm_scores)   # mean aggregation
        # 加权
        r = 0.7 * ans_r + 0.3 * proc_r
        rewards.append(r)
    return rewards
```

| 混合策略 | 效果 |
| --- | --- |
| 0/1 ans + small PRM bonus | 防 advantage 全 0 |
| PRM 当 dense reward，每 token decay | 类似 reward shaping |
| ORM 主，PRM 用来 best-of-N rerank | 推理时用 |
| PRM 训完独立做 search-based decoding | MCTS / beam |

## 5. PRM 在推理时（test-time scaling）

PRM 不只用于训练，o1 系列把 PRM 当**推理时 verifier** 大放异彩：

```text
test-time scaling 三种路径：

(a) Best-of-N：采 N 条，PRM 评分选最高
(b) Beam search：每步留 top-k 部分 trace
(c) MCTS：树搜索 + PRM 估值

PRM 越好，scaling 收益越大
```

| 方法 | 计算量 | MATH 提升 |
| --- | --- | --- |
| Greedy（baseline） | 1× | 0 |
| Best-of-32 + ORM | 32× | +5-8 pt |
| Best-of-32 + PRM | 32× | +10-15 pt |
| MCTS + PRM（o1 风格） | 100-1000× | +20+ pt |

> 引用：*Scaling LLM Test-Time Compute Optimally* (Snell et al., 2024) 给了详细的 compute-vs-accuracy 曲线。

## 6. PRM 也会被 hack

PRM 的弱点：

| Hack | 例子 |
| --- | --- |
| 每步刷"听起来合理的废话" | "Let me think step by step. First, I need to... Step 1: ..." 但内容空 |
| 重复正确步骤多次 | 每步都对但解题进度为 0 |
| 偷题面 | step = "原题说 12+34，所以 12+34=46"（重复输入刷分） |
| 跨步矛盾 | 单看每步都合理但整体逻辑矛盾 |

> Anthropic *Process Rewards That Lie* (2024) 系统研究了 PRM hacking。结论：PRM 必须配 ORM gate（最终答案错则整 trace 强制 0）。

## 7. ORM 作为 PRM 的便宜替代

实战中 PRM 标注太贵，替代方案：

| 替代 | 思路 | 效果 |
| --- | --- | --- |
| Math-Shepherd | 用 MC rollout 估每步对最终对答案的概率 | 接近 PRM800K |
| Implicit PRM | 训 ORM 时做 step-wise margin | 接近，更便宜 |
| LLM-as-judge step PRM | 用 GPT-4 标每步好坏 | 主流（Distilabel 支持） |
| Self-PRM | 模型自己评估自己 | 弱但零成本 |

> Math-Shepherd (Wang et al., 2023)：对每步采 N 条 completion 跑到底，用 P(最终对) 估 step quality。可自动化，**不需要人工 step 标注**。

```python
# Math-Shepherd 风格：自动生成 step labels
def auto_label_step(problem, steps_so_far, ans_gold, n_rollout=16):
    """从当前 prefix 接着采 n 条，看多少条最终答对。"""
    prefix = problem + "\n" + "\n".join(steps_so_far)
    correct = 0
    for _ in range(n_rollout):
        completion = policy.generate(prefix, max_new_tokens=512)
        if math_verify(completion, ans_gold):
            correct += 1
    return correct / n_rollout    # P(good | prefix) 的估计
```

### 7.1 Math-Shepherd 实战配置

```yaml
# 用 SFT 模型自动生成 step labels
sft_model: Qwen/Qwen2.5-Math-7B
math_dataset: hendrycks/competition_math
n_rollout_per_step: 16          # 每个 prefix 采 16 条估 P(good)
rollout_temperature: 0.8        # 多样性
rollout_top_p: 0.95
max_response_length: 1024
batch_size: 64

# 输出格式
output:
  - problem
  - step_idx
  - step_text
  - p_correct        # rollout 估出来的过程 reward
```

然后训 PRM：

```python
# 用 BCE loss 训 implicit PRM
from transformers import AutoModelForSequenceClassification, Trainer
import torch.nn as nn

class PRM(nn.Module):
    def __init__(self, base):
        super().__init__()
        self.backbone = base
        self.head = nn.Linear(base.config.hidden_size, 1)

    def forward(self, input_ids, labels=None):
        hidden = self.backbone(input_ids, output_hidden_states=True).hidden_states[-1]
        # 在 step 结束 token 处取 hidden state
        logits = self.head(hidden[:, -1, :])
        if labels is not None:
            loss = nn.BCEWithLogitsLoss()(logits.squeeze(-1), labels)
            return {"loss": loss, "logits": logits}
        return {"logits": logits}
```

## 8. 工程实践推荐

| 场景 | 推荐 |
| --- | --- |
| 第一次跑 RLVR | ORM only（最简单） |
| MATH / 代码竞赛刷分 | ORM 训练 + PRM 推理时 rerank |
| 长链 Agent task | PRM（中间步骤太多） |
| 安全 / 推理审查 | PRM + 显式规则 |
| 资源紧张 | Math-Shepherd 风格 implicit PRM |

> DeepSeek-R1 paper 的关键发现：**纯 ORM + GRPO 就能涌现 reasoning，不需要 PRM**。这跟之前 OpenAI PRM800K 路线相反。社区猜测：PRM 在 best-of-N 推理时贵但有用，在 RL 训练时反而限制探索。

## 9. Agent 场景下的 PRM

Agent 多步决策天然契合"过程监督"——每一步 tool call 都可以打分：

```python
# Agent step PRM 思路
def agent_step_reward(state, action, next_state):
    """每步给一个 0/1 信号。"""
    r = 0.0
    # 1. 工具调用格式正确（JSON schema 通过）
    if validate_schema(action):
        r += 0.1
    # 2. 工具执行成功（无 exception）
    if next_state.get("tool_success"):
        r += 0.2
    # 3. 进度（子目标完成度）
    if subgoal_progress(state, next_state) > 0:
        r += 0.3
    # 4. 没有无效循环（重复同一 action）
    if not is_loop(state, action):
        r += 0.1
    return r

# 整 trace reward = ORM × 0.5 + sum(step_reward) × 0.5
```

| Agent PRM 类型 | 例子 |
| --- | --- |
| Tool format reward | JSON 合法、函数存在、参数对 |
| Tool success reward | API 200 vs 4xx/5xx |
| Subgoal reward | 任务子步完成（如 "找到文件" → "读出内容"） |
| Anti-loop reward | 不重复相同 action |
| Cost reward | 减少冗余调用 |

> 引用：*WebRL* (Qi et al., 2024) 和 *AgentTuning* (Zeng et al., 2023) 都在 Agent RL 里加了多种 step reward。Agent RL 比 chat RL 更依赖过程信号。

## 10. 对比一览：从 RM 到 PRM

| 方法 | 信号 | 训练时用 | 推理时用 |
| --- | --- | --- | --- |
| RM（标量 RM） | end-of-sequence | PPO / DPO | 评分 |
| ORM | 答案对错 0/1 | RLVR / GRPO | best-of-N |
| Implicit PRM | step margin | DPO 变种 | rerank |
| PRM（显式标） | 每步 good/bad | dense reward | MCTS, best-of-N |
| Math-Shepherd | rollout 估 step | RL | rerank |

## 常见坑

1. **拿 PRM 当训练 reward 又不 ORM gate**：模型刷过程分但最终答案错。**必须加"最终错则归 0"门**。
2. **PRM 标注没控质量**：标注者对"什么是好步骤"理解不一，导致 PRM 学到噪声。要双标 + 一致率 > 0.7 才用。
3. **PRM 和 policy 同 base 训**：PRM 跟着 policy 飘，等于自己评自己。最好用不同 base。
4. **best-of-N 直接用 final logprob**：等于没用 PRM。要用 PRM 给整 trace 评分，而不是 logprob mean。
5. **以为 PRM 万能**：reward hacking 在 PRM 上更严重。**先看几条训练后 trace 人工 review**。

## 下一步

- 上一章 reward 设计：[06 · RLVR](./06-rlvr.md)
- 怎么训 GRPO：[07 · GRPO](./07-grpo.md)
- DeepSeek-R1 为什么不用 PRM：[10 · 案例](./10-case-study.md)
- 训练工具选型：[09 · 工具](./09-tools.md)
- 跨主题：reward model 评测 [`../eval/04-llm-as-judge.md`](../eval/04-llm-as-judge.md)
- 跨主题：Agent 任务的 step reward [`../agents/05-planning.md`](../agents/README.md)
