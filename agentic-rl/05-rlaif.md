# 05 · RLAIF 与 Constitutional AI

> 人类标注偏好太贵（每对 $0.5-$2）。RLAIF 把 judge 换成强 LLM——同样的钱多 10-100×。质量呢？Google 2024 paper 说"打平甚至略超 RLHF"。

本章讲怎么用 GPT-4 / Claude 给自己的模型生成偏好对，以及 Anthropic Constitutional AI 那套"用一组原则替代人类反馈"的具体做法。

## 1. RLAIF 与 RLHF 的差异

```text
RLHF: prompt → 模型 A 输出, 模型 B 输出 → 人类标 "A>B" → RM/DPO
RLAIF: prompt → 模型 A 输出, 模型 B 输出 → LLM judge 标 "A>B" → RM/DPO
```

| 维度 | RLHF | RLAIF |
| --- | --- | --- |
| 成本 / 对 | $0.5-$2 | $0.001-$0.01 |
| 速度 | 天 / 周 | 小时 |
| 一致性 | 标注者间差异大 | 同一 judge 极一致 |
| 偏见 | 人类偏见 | judge 模型偏见 |
| 标注上限 | ~100K（贵） | 数百万（便宜） |
| 涉密数据 | 适合（本地标） | 涉密要本地 judge |

> 引用：*RLAIF vs RLHF: Scaling Reinforcement Learning from Human Feedback with AI Feedback* (Lee et al., Google, 2024) 在 summarization 和 helpfulness 上 RLAIF 与 RLHF 持平，harmlessness 上 RLAIF 略好。

## 2. 一个最简单的 RLAIF pipeline

```python
# pip install openai datasets
import openai, json
from datasets import load_dataset

client = openai.OpenAI()
prompts = load_dataset("HuggingFaceH4/no_robots", split="train").select(range(1000))

JUDGE_PROMPT = """You are evaluating two responses for helpfulness.

Question: {q}

Response A: {a}

Response B: {b}

Which response is better? Answer with only "A" or "B".
Consider: factual correctness, clarity, completeness, no harmful content.
"""

def gen(model, q):
    r = client.chat.completions.create(model=model, messages=[{"role":"user","content":q}])
    return r.choices[0].message.content

def judge(q, a, b):
    r = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role":"user","content": JUDGE_PROMPT.format(q=q, a=a, b=b)}],
        temperature=0,
    )
    return r.choices[0].message.content.strip().upper()[:1]

out = open("rlaif_pairs.jsonl", "w")
for ex in prompts:
    q = ex["prompt"]
    a = gen("my-sft-model", q)     # 自己的 SFT 模型
    b = gen("gpt-4o-mini", q)      # 对照模型
    # 抗 position bias：随机换序两次
    v1 = judge(q, a, b); v2 = judge(q, b, a)
    if v1 == "A" and v2 == "B":      # 一致投票
        chosen, rejected = a, b
    elif v1 == "B" and v2 == "A":
        chosen, rejected = b, a
    else:
        continue                      # 不一致丢弃
    out.write(json.dumps({"prompt": q, "chosen": chosen,
                          "rejected": rejected}, ensure_ascii=False) + "\n")
```

| 防止 judge 偏见的技巧 | 说明 |
| --- | --- |
| 双向投票（A/B 调位） | 防 position bias |
| 多个 judge 投票 | GPT-4o + Claude 双投 |
| 加入 "Tie" 选项 | 接近时丢弃 |
| 隐藏来源（不告诉是哪个模型） | 防模型偏好自己 |
| Chain-of-thought judge | judge 先解释再选 |

## 3. Constitutional AI（CAI）流程

Anthropic 2022 paper *Constitutional AI: Harmlessness from AI Feedback* 提出的两阶段：

```text
阶段 1：Critique & Revise（SL-CAI）
  红队 prompt → 模型 A 回答
  ↓
  对照 constitution 16 条原则，模型自我批判
  ↓
  自己改写更好的回答
  ↓
  得到 SFT 数据（prompt, revised_answer）

阶段 2：RLAIF
  prompt → 模型生成 A, B
  ↓
  judge（同模型）按 constitution 选偏好
  ↓
  RM + RLHF（或 DPO）
```

```python
# CAI critique-and-revise 提示模板
CRITIQUE_PROMPT = """
Human: {prompt}
Assistant: {response}

Critique this response based on the following principles:
1. Don't help with illegal activities.
2. Don't produce harmful content.
3. Be honest about uncertainty.
...

Identify any ways the response fails these principles.
"""

REVISE_PROMPT = """
Based on your critique, write a revised response that:
- Addresses the harmful aspects
- Still helps with the legitimate part of the request
- Is honest about what you can/can't help with
"""
```

| CAI vs 普通 RLAIF | CAI 优势 |
| --- | --- |
| 有"显式 constitution" | 可审计、可改 |
| 强调自我批判 | 减少 judge 偏见 |
| 主打 harmlessness | 不只是 helpfulness |
| Claude 全系列在用 | 工业验证过 |

## 4. Judge 模型的选择

| Judge 模型 | 适合 | 成本 / 1K pair | 偏见 |
| --- | --- | --- | --- |
| GPT-4o | 通用对齐 | $5-10 | 偏长答案、偏自家风格 |
| Claude 3.5 Sonnet | 安全场景 | $5-15 | 偏结构化、偏保守 |
| Llama 3.1 70B（本地） | 涉密 / 大规模 | 0.5h GPU | 偏 Llama 风格 |
| Qwen2.5-72B（本地） | 中文 | 0.5h GPU | 偏中式表达 |
| Mixture-of-judges（3+ 投票） | 高质量 | 3× 单 judge | 减少单一偏见 |

> 经验：单 judge 准确率 ~75%，三 judge 投票可达 85%。但成本也 3×。**先用单 judge 跑 1K 看效果，再决定要不要扩**。

## 5. UltraFeedback：开源 RLAIF 标杆数据集

UltraFeedback（OpenBMB, 2024）是 RLAIF 路线的代表性数据集：

| 字段 | 说明 |
| --- | --- |
| prompt 数 | 64K |
| 每 prompt 回答 | 4 个不同模型 |
| 评分维度 | helpfulness / honesty / truthfulness / instruction-following |
| Judge | GPT-4 |
| 分数 | 1-10 整数 |

二值化为 DPO pair：

```python
from datasets import load_dataset
ds = load_dataset("openbmb/UltraFeedback", split="train")

def to_dpo(ex):
    completions = ex["completions"]  # 4 个模型回答
    # 综合分 = mean of 4 维度
    for c in completions:
        c["score"] = sum(int(c["annotations"][k]["Rating"])
                         for k in ["helpfulness","honesty","truthfulness",
                                   "instruction_following"]) / 4
    completions.sort(key=lambda c: c["score"], reverse=True)
    chosen, rejected = completions[0], completions[-1]
    if chosen["score"] - rejected["score"] < 1:
        return None    # 差距太小丢弃
    return {"prompt": ex["instruction"],
            "chosen": chosen["response"],
            "rejected": rejected["response"]}

dpo_data = [to_dpo(e) for e in ds]
dpo_data = [x for x in dpo_data if x]
```

> HuggingFaceH4 已经做好了二值化版本：`HuggingFaceH4/ultrafeedback_binarized`，DPO 直接用。

## 6. 多维 reward 的合成

```python
# 一个 prompt 多维度评分 → reward
RUBRIC = ["helpfulness", "honesty", "harmlessness", "conciseness"]

def multi_judge(q, a):
    scores = {}
    for dim in RUBRIC:
        # 各维度独立 judge，防止 halo effect
        r = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role":"user","content":
                f"Rate {dim} of this response (1-10): Q: {q}\nA: {a}\n"
                "Output only the integer."}],
            temperature=0,
        )
        scores[dim] = int(r.choices[0].message.content.strip())
    # 加权
    return 0.4*scores["helpfulness"] + 0.2*scores["honesty"] \
         + 0.3*scores["harmlessness"] + 0.1*scores["conciseness"]
```

| 多维 reward 的好处 | 坏处 |
| --- | --- |
| 可控的取舍 | 维度间冲突要权衡 |
| 减少 reward hacking | 实现复杂 |
| 可审计 | 维度越多噪声越大 |
| 适合安全场景 | 标注 5× 贵 |

## 7. RLAIF 与 RLHF 混合

工业实践通常不是 100% RLAIF 或 100% RLHF：

```text
策略：金字塔混合

  10K 真人标 (顶层)         ── 用于 calibrate judge / final RM
       ↑
  100K AI judge 标 (主体)   ── 主力训练数据
       ↑
  500K 弱信号 (底层)        ── 比如"长答案 / 包含代码块"
```

| 混合策略 | 例子 |
| --- | --- |
| 真人 calibrate judge | 选 1K 对人和 AI 都标，比一致率 |
| 真人 verify final 10% | 训完抽样检查 |
| AI 标占主体 train | UltraFeedback 思路 |
| 真人难样本 + AI 简单样本 | Anthropic 路线 |

> Tülu 3（Allen AI, 2024）混了 UltraFeedback + Nectar + 自家人类偏好，是工业混合范例。

## 8. RLAIF 失效模式

| 模式 | 现象 | 缓解 |
| --- | --- | --- |
| Judge 自我偏爱 | judge 是 GPT-4，generator 也是 GPT-4 → 几乎都 prefer 自己 | 换 judge / 隐藏来源 |
| 长度偏置 | judge 倾向长答案 | 加长度归一化 |
| Surface pattern | judge 喜欢 bullet point / 加 emoji → 模型学会刷这些 | 多 judge / 多维 |
| Sycophancy 加剧 | judge 偏好"恭维"答案 | constitution 显式禁止 |
| 知识盲区 | judge 不懂的领域瞎评 | 领域内换专家 judge |

> Sycophancy（拍马屁）是 RLAIF 最严重的隐形坑。Anthropic *Towards Understanding Sycophancy in LLMs* (2024) 实证 RLHF / RLAIF 都会加重这个问题。

## 9. 一个能跑的 Distilabel pipeline

```python
# pip install distilabel
from distilabel.pipeline import Pipeline
from distilabel.llms import OpenAILLM
from distilabel.steps import LoadDataFromHub
from distilabel.steps.tasks import TextGeneration, UltraFeedback

with Pipeline("rlaif-pipeline") as pipeline:
    data = LoadDataFromHub(repo_id="HuggingFaceH4/no_robots", split="train")
    gen_a = TextGeneration(name="gen_a", llm=OpenAILLM(model="gpt-4o-mini"))
    gen_b = TextGeneration(name="gen_b", llm=OpenAILLM(model="gpt-4o"))
    judge = UltraFeedback(name="judge", llm=OpenAILLM(model="gpt-4o"),
                          aspects=["helpfulness","honesty"])

    data >> gen_a >> gen_b >> judge

distiset = pipeline.run(use_cache=False)
distiset.push_to_hub("my-org/my-rlaif-dataset")
```

> Distilabel（Argilla 团队）是开源 RLAIF 主流 pipeline 工具，支持 GPT/Claude/Llama 接口、多步组合、缓存、断点恢复。

## 常见坑

1. **没双向投票就用 judge**：position bias 真实存在，A 在前的胜率比 B 在前的胜率高 5-15 个点。**必须 swap & 取一致投票**。
2. **judge 用太弱的模型**：GPT-3.5 当 judge 几乎和随机差不多。RewardBench 显示 GPT-3.5 judge accuracy 0.55，GPT-4o 0.85。
3. **不过滤"差距太小"的 pair**：score diff < 1 的 pair 训出来反而损害模型——这些是噪声样本。
4. **judge prompt 没禁止"我无法判断"**：judge 经常返回"两个都不错"。要强制二选一或丢弃。
5. **训完不评 sycophancy**：RLAIF 后模型往往更顺从用户错误观点。专门用 SycophancyBench 测。

## 下一步

- 加可验证 reward 而非 judge：[06 · RLVR](./06-rlvr.md)
- DPO 训练框架细节：[04 · DPO](./04-dpo.md)
- reasoning 模型路线：[07 · GRPO](./07-grpo.md)
- 跨主题：LLM-as-judge 通用方法 [`../eval/04-llm-as-judge.md`](../eval/04-llm-as-judge.md)
- 跨主题：Claude 怎么训出来的（CAI 案例）[10 · 案例拆解](./10-case-study.md)
- 数据合成框架 Distilabel 详见 [`../fine-tuning/06-synthetic-data.md`](../fine-tuning/README.md)
