# 03 · RLHF 简史与 PPO

> RLHF 不是一个算法，是一套**"SFT → 训 RM → PPO"三阶段流水线**。看懂这三阶段为什么这么排，比看 PPO 论文公式更有用。

本章把 InstructGPT 那张著名的"three steps"图拆到工程颗粒度，讲清楚每一步真正做什么、为什么会崩、为什么后面出现了 DPO 把它取代。

## 1. InstructGPT 三阶段管线（2022.03）

```text
Step 1: SFT
  ┌──────────────┐
  │ base model   │ +  人工演示 (prompt, demo)  →  SFT model
  └──────────────┘

Step 2: Reward Model
  ┌──────────────┐
  │ SFT model    │ +  (prompt, A, B, label A>B)  →  RM (scalar reward)
  └──────────────┘

Step 3: PPO
  ┌──────────────┐
  │ SFT model    │  policy
  │ RM           │  reward
  │ ref model    │  KL anchor (=SFT model 冻结副本)
  └──────────────┘
      ↓ rollout + PPO update
  ┌──────────────┐
  │ aligned model│
  └──────────────┘
```

| 阶段 | 数据形态 | 模型数量 | 损失 |
| --- | --- | --- | --- |
| SFT | (prompt, demo) | 1 | CE on response |
| RM | (prompt, chosen, rejected) | 1（头变 scalar） | Bradley-Terry pairwise |
| PPO | (prompt) → rollout → reward | 4（policy / ref / RM / value） | PPO clip + KL penalty |

> 引用：InstructGPT (Ouyang et al., 2022) 用 13K SFT demo + 33K RM pair + 31K PPO prompt 训出 GPT-3.5 雏形。

## 2. Reward Model 训练

RM 本质是把 LM 的最后一层换成 scalar head，然后用 Bradley-Terry pairwise loss：

```python
# pip install transformers trl
from trl import RewardTrainer, RewardConfig
from transformers import AutoModelForSequenceClassification, AutoTokenizer
from datasets import load_dataset

MODEL = "Qwen/Qwen2.5-7B-Instruct"
tok = AutoTokenizer.from_pretrained(MODEL)
# num_labels=1 → scalar reward head
model = AutoModelForSequenceClassification.from_pretrained(MODEL, num_labels=1)

ds = load_dataset("Anthropic/hh-rlhf", split="train[:5000]")

# Bradley-Terry: P(chosen > rejected) = sigmoid(r_chosen - r_rejected)
# loss = -log sigmoid(r_chosen - r_rejected)

cfg = RewardConfig(
    output_dir="rm-out",
    per_device_train_batch_size=4,
    gradient_accumulation_steps=4,
    learning_rate=5e-6,             # RM 比 SFT 还小一个量级
    num_train_epochs=1,             # RM 一般 1 epoch 防过拟合
    max_length=2048,
    bf16=True,
    eval_strategy="steps",
    eval_steps=200,
)

trainer = RewardTrainer(model=model, tokenizer=tok, args=cfg,
                        train_dataset=ds.select(range(4500)),
                        eval_dataset=ds.select(range(4500, 5000)))
trainer.train()
```

| RM 训练要点 | 说明 |
| --- | --- |
| 1 epoch 即可 | 多了会过拟合到标注者偏见 |
| lr 比 SFT 低 5-10× | 防止 head 训飞 |
| 评测指标 = pairwise accuracy | 起步 0.6+，好的 RM 0.7-0.75 |
| 不同标注者的 pair 要混合 | 否则 RM 学到"标注者风格" |
| 长度偏置严重 | RM 倾向给长回答高分（reward hacking 主因） |

> 引用：RewardBench (Lambert et al., 2024) 显示 SOTA RM 平均 0.75-0.85，但 hard set 上经常 < 0.5（甚至比随机差）。

## 3. PPO 三阶段为什么这么复杂

显存账：跑 PPO 同时要 4 个模型常驻：

| 模型 | 作用 | 是否训练 |
| --- | --- | --- |
| policy | actor，要更新的目标 | 是 |
| ref model | KL 锚点，防止漂太远 | 否（冻结） |
| reward model | 给 rollout 打分 | 否（冻结） |
| value model | critic，估计 V(s) 减方差 | 是 |

7B 模型 PPO，单卡基本不够，常见配置 H100×8。这就是为什么大家拼命想去掉 RM 和 value model——DPO（§04）和 GRPO（§07）的动机。

## 4. PPO 损失（精简版）

```text
L_PPO(θ) =  E[ min( r_t(θ) · A_t , clip(r_t(θ), 1-ε, 1+ε) · A_t ) ]
            - c1 · KL( π_θ || π_ref )         ← 防止漂离 SFT
            + c2 · L_value
            - c3 · H(π_θ)                    ← entropy bonus

  r_t(θ) = π_θ(a_t|s_t) / π_old(a_t|s_t)
  A_t    = GAE advantage（用 V 估）
```

关键超参经验值：

| 超参 | 推荐 | 说明 |
| --- | --- | --- |
| `init_kl_coef` | 0.1-0.2 | KL 系数初值，太小会漂飞 |
| `target_kl` | 0.01-0.1 | 自适应 KL 控制目标 |
| `cliprange` | 0.2 | PPO clip ε |
| `cliprange_value` | 0.2 | value clip |
| `gamma` | 1.0（LM 通常不折扣） | 单步 reward 时无所谓 |
| `lam` | 0.95 | GAE λ |
| `ppo_epochs` | 4 | 每批 rollout 跑几轮更新 |
| `mini_batch_size` | 64-128 | PPO 更新 batch |
| `rollout_batch_size` | 512-1024 | 一次采多少 trajectory |
| lr | 1e-6 ~ 5e-6 | 比 SFT 小一个量级 |

## 5. TRL PPOTrainer 最小示例

```python
# pip install trl
from trl import PPOTrainer, PPOConfig, AutoModelForCausalLMWithValueHead
from transformers import AutoTokenizer
from datasets import load_dataset

cfg = PPOConfig(
    model_name="sft-model",
    learning_rate=1.41e-5,
    batch_size=64,
    mini_batch_size=8,
    ppo_epochs=4,
    init_kl_coef=0.2,
    target_kl=6,
    cliprange=0.2,
    cliprange_value=0.2,
    gamma=1.0,
    lam=0.95,
)

policy = AutoModelForCausalLMWithValueHead.from_pretrained("sft-model")
ref    = AutoModelForCausalLMWithValueHead.from_pretrained("sft-model")
tok    = AutoTokenizer.from_pretrained("sft-model")
rm     = ...  # 加载训好的 RM

ppo = PPOTrainer(cfg, policy, ref, tokenizer=tok)

for batch in dataloader:
    queries = batch["input_ids"]
    # 1) rollout
    responses = ppo.generate(queries, max_new_tokens=256)
    # 2) score
    rewards = [rm(q + r).logits.squeeze() for q, r in zip(queries, responses)]
    # 3) step
    stats = ppo.step(queries, responses, rewards)
    ppo.log_stats(stats, batch, rewards)
```

> 注意：TRL 0.11+ 的 API 改用 `PPOv2Trainer`，写法略有差异。生产环境推荐用 verl / OpenRLHF（详见 [§09](./09-tools.md)）。

## 6. PPO 的工程崩塌模式

| 症状 | 原因 | 修复 |
| --- | --- | --- |
| reward 一直升但生成变垃圾 | reward hacking | 降 KL 强度 / 改 reward |
| KL 爆炸 → loss NaN | lr 太高 / init_kl 太小 | lr × 0.5，init_kl_coef × 2 |
| reward 不动 | RM 区分度差 | 重训 RM，检查 pair accuracy |
| 输出越来越长 | RM 长度偏置 | reward 减长度归一化项 |
| 输出全是同一句 | entropy 崩 | 加大 entropy bonus c3 |
| value loss 一直涨 | value head 训飞 | clip value，降 lr |

> "RLHF is more art than science" 不是玩笑。InstructGPT 团队在 paper 里直说调了 6 个月才稳。

## 7. 长度偏置与 reward 归一化

RM 几乎 100% 会学到"长回答打分高"——因为标注者倾向选长答案。生产里通常加：

```python
# 长度归一化（Anthropic 风格）
reward = rm_score - length_penalty * len(response)
# 或者归一到 token 平均
reward = rm_score / sqrt(len(response))
# 或者 reward 标准化（DeepMind 风格）
rewards = (rewards - rewards.mean()) / (rewards.std() + 1e-8)
```

| 归一化方法 | 效果 |
| --- | --- |
| 减常数长度惩罚 | 简单但要调系数 |
| 除 sqrt(len) | 适合长短差异大 |
| batch z-norm | PPO 默认必开 |
| 用 length-normalized RM（重训 RM） | 一劳永逸但贵 |

## 8. 为什么后来都不用 PPO 了

成本对比（7B 模型，公开 paper 数据汇总）：

| 方法 | GPU 时（H100×8 单 epoch） | 显存峰值 | 稳定性 | 效果（AlpacaEval 2 win-rate） |
| --- | --- | --- | --- | --- |
| PPO | 24-48h | 4×7B | 易崩 | 25-30% |
| DPO | 4-8h | 2×7B | 较稳 | 26-32% |
| GRPO | 8-16h（含 rollout） | 2×7B | 较稳 | 30%+（含 reasoning bonus） |

> 引用：Zephyr-7B（Tunstall et al., 2023）用 DPO 在更少算力下打平 PPO 训的 Llama 2-70B-chat 的 MT-Bench 分数，是 DPO 出圈的关键事件。

但 PPO 没死。在以下场景仍是首选：

- 复杂多步 reward（多 RM 加权）
- 在线 RL（持续收集人类反馈）
- 安全对齐（红队 reward）

## 9. RLHF 在 Agent 场景的扩展

普通 RLHF：reward 在序列末尾给一次。Agent RL：

```text
trace:  [user] → [assistant tool_call] → [tool result] → [assistant tool_call]
                                                        ↓
                                       [tool result] → [assistant final]
                                                                ↓ reward here

奖励选项：
  (a) 末尾 reward（最常见）
  (b) 每个 tool_call 后给中间 reward（PRM 思路）
  (c) 子任务完成 reward（环境驱动）
```

(b) 引出过程监督（§08），(c) 引出 RLVR（§06）。Agent RL 比 chat RLHF 更难，但奖励信号也更"硬"——只要任务做完了就 1，没做完就 0，比 RM 评分客观。

## 常见坑

1. **没标 chosen=rejected 的 tie**：RM 训练数据全是严格 pair，但人类标注里很多 "差不多"，硬训成 chosen 会让 RM 学到噪声。允许 tie 或丢弃。
2. **PPO rollout 用 greedy**：探索为 0，PPO 学不到东西。**rollout 必须 sample（temp=1.0, top_p=0.95）**。
3. **ref model 没冻结**：常见 bug，policy 跟 ref 同步漂走，KL 永远 0。
4. **reward 没 batch-norm**：PPO 对 reward 尺度敏感。reward 范围在 [0, 100] 比 [0, 1] 训出来完全不同。
5. **以为 RLHF 一次性**：Llama 2 / Llama 3 都是**反复迭代 SFT → DPO → 重新生成**多轮。一次跑完不要期待 Llama-2-chat 水平。

## 下一步

- 取代 PPO 的简化方案：[04 · DPO](./04-dpo.md)
- 没人类标注怎么办：[05 · RLAIF](./05-rlaif.md)
- 数学 / 代码 reward 怎么设计：[06 · RLVR](./06-rlvr.md)
- 训练框架选型：[09 · 工具](./09-tools.md)
- 看 InstructGPT 的当代变种：[10 · 案例拆解](./10-case-study.md)
- 跨主题：评测 RM 用 LLM-as-judge：[../eval/04-llm-as-judge.md](../eval/04-llm-as-judge.md)
