# 07 · GRPO 与推理模型

> GRPO（Group Relative Policy Optimization）一句话：**用同一个 prompt 采 N 条回答的内部排名当 advantage，省掉 critic 和 value model**。DeepSeek-R1、Qwen-Math、Llama-3-Reward-Math 都在用。

GRPO 出自 DeepSeekMath (Shao et al., 2024)，2025 年因 DeepSeek-R1 出圈。本章把算法、实现、调参、踩坑全过一遍。

## 1. GRPO vs PPO 的关键差异

```text
PPO advantage：A_t = r_t + γV(s_{t+1}) - V(s_t)
  → 要 value model（与 policy 同规模），显存翻倍

GRPO advantage：A_i = (r_i - mean(r_group)) / std(r_group)
  → 用同一 prompt 采样 N 条，组内 z-score 当 advantage
  → 不需要 value model
```

| 维度 | PPO | GRPO |
| --- | --- | --- |
| 常驻模型 | 4（policy / ref / RM / value） | 3（policy / ref / RM 或 verifier） |
| 显存 | 4× model | 2-3× model |
| sample 模式 | 单 sample + critic 估 V | 多 sample（group_size 8-64） |
| 适合任务 | reward 密集 | reward 稀疏（如 0/1 verifier） |
| 收敛 | 慢但稳 | 快但需 group 足够大 |

> 引用：DeepSeekMath paper Table 5 显示 GRPO 在 GSM8K 上比 PPO 快 ~2× 收敛、显存 -30%。

## 2. GRPO loss（精简版）

```text
对每个 prompt q：
  采样 group: y_1, y_2, ..., y_G       （从 π_old）
  reward: r_1, ..., r_G
  group baseline: μ = mean(r), σ = std(r)
  advantage: A_i = (r_i - μ) / (σ + ε)

L_GRPO(θ) = E[ 1/G · Σ_i {
     min( ρ_i · A_i ,  clip(ρ_i, 1-ε, 1+ε) · A_i )  ← PPO clip
     - β · KL( π_θ || π_ref )
}]

其中 ρ_i = π_θ(y_i|q) / π_old(y_i|q)
```

关键点：

- **per-token surrogate**：实际实现是 per-token 算 ratio 和 clip（与 PPO 一致）
- **group baseline 是 prompt 内**：跨 prompt 不可比
- **KL 项**：与 ref model（通常是 SFT model）的 KL，防漂离

## 3. group_size 的工程含义

```text
group_size G 越大：
  + advantage 估计方差越小
  + 探索充分
  - 显存线性涨
  - 单 step 时间长

G 越小：
  + 显存友好
  - reward 全相等时 advantage = 0（全组要么都对要么都错）
  - 学习信号弱
```

| group_size | 适合 | 备注 |
| --- | --- | --- |
| 4 | 调试 / 显存紧 | 经常 advantage=0 |
| 8 | DeepSeekMath 标配 | 平衡点 |
| 16 | DeepSeek-R1 用过 | 大 GPU 环境 |
| 32-64 | 研究 / 极致 | 收益递减 |

> 当 reward 0/1 时，**G 太小特别容易全对或全错**，要保证 group 内有差异。经验：让初始 accuracy 在 30-70% 区间，G=8 可用；accuracy 偏极端时 G 要大。

## 4. TRL GRPOTrainer 完整示例

```python
# pip install "trl>=0.12" vllm
from trl import GRPOTrainer, GRPOConfig
from transformers import AutoTokenizer, AutoModelForCausalLM
from datasets import load_dataset
from math_verify import verify as math_verify

MODEL = "Qwen/Qwen2.5-Math-7B"
tok = AutoTokenizer.from_pretrained(MODEL)
model = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype="bfloat16")

ds = load_dataset("HuggingFaceH4/MATH-500", split="train")

SYSTEM = ("Solve the math problem step by step. "
          "Put your final answer in \\boxed{}.")

def fmt(ex):
    return {"prompt": [{"role":"system","content":SYSTEM},
                       {"role":"user","content": ex["problem"]}],
            "answer": ex["answer"]}
ds = ds.map(fmt)

def reward_answer(prompts, completions, answer, **kw):
    out = []
    for c, g in zip(completions, answer):
        text = c[0]["content"] if isinstance(c, list) else c
        out.append(1.0 if math_verify(text, g) else 0.0)
    return out

def reward_format(prompts, completions, **kw):
    out = []
    for c in completions:
        text = c[0]["content"] if isinstance(c, list) else c
        out.append(0.1 if r"\boxed{" in text else 0.0)
    return out

cfg = GRPOConfig(
    output_dir="grpo-r1-style",
    per_device_train_batch_size=1,
    gradient_accumulation_steps=8,
    num_generations=8,                          # group_size G
    max_prompt_length=512,
    max_completion_length=4096,                 # reasoning 模型要长
    learning_rate=5e-6,
    lr_scheduler_type="cosine",
    warmup_ratio=0.03,
    beta=0.04,                                  # KL 系数
    num_train_epochs=1,
    bf16=True,
    use_vllm=True,                              # 用 vLLM 加速 rollout（关键）
    vllm_device="auto",
    vllm_gpu_memory_utilization=0.5,
    logging_steps=5,
    save_strategy="steps",
    save_steps=500,
)

trainer = GRPOTrainer(
    model=model,
    args=cfg,
    train_dataset=ds,
    reward_funcs=[reward_answer, reward_format],   # 多 reward 合成
    tokenizer=tok,
)
trainer.train()
```

> `use_vllm=True` 极其关键：GRPO 一个 step 要采 G 条样本，HF generate 慢，用 vLLM 推理加速 3-10×。

## 5. 训练曲线解读（GRPO 专属）

| metric | 健康 | 异常诊断 |
| --- | --- | --- |
| reward/mean | 缓慢上升 | 平 → group_size 太小或 lr 太低 |
| reward/std | 一开始大，慢慢降 | 全程 0 → 全 batch 同 reward，学不动 |
| reward/accuracies | 整体准确率 | 应稳定上升 |
| kl | 0.01-0.5 区间 | > 1.0 漂离太远，降 β 上限 |
| completion/mean_length | 缓慢增长 | 突然爆炸 → reward hacking 灌水 |
| clip_ratio | < 0.3 | > 0.5 说明 update 太激进，降 lr |

> R1 风格的训练 reasoning 长度从 ~500 token 增长到 ~5000 token 是**正常的 emergent behavior**，不是 reward hack。但要看 reward 也跟着涨。

## 6. R1-Zero vs R1：纯 RL 还是 SFT + RL

DeepSeek-R1 paper 提了两个变体：

| 变体 | 起点 | 流程 | 特点 |
| --- | --- | --- | --- |
| R1-Zero | DeepSeek-V3-Base（裸 base） | 直接 GRPO + RLVR | reasoning emerge 但语言混乱 |
| R1 | V3-Base → 冷启动 SFT → GRPO → 再 SFT → 再 RL | 多阶段 | 工业可用 |

> R1-Zero 证明了"不必 SFT 也能 emerge reasoning"，但实际生产用 R1 多阶段。直接 R1-Zero 复现通常因为模型回答语言切换、格式崩坏不可用。

R1 完整四阶段：

```text
1. Cold start SFT：~thousands 条 long CoT 数据，让模型学会"用 boxed 输出 + 长链思考"
2. Reasoning RL（GRPO + RLVR）：math/code，让 reasoning 涨
3. Reject sampling SFT：用 stage 2 模型采样，选好的回答 + 通用数据混合 SFT
4. 全任务 RL：再来一轮 RL（含通用 helpfulness reward）
```

## 7. "Aha moment" 与 emergent reasoning

R1 paper Figure 3 展示模型在某个训练步突然"学会自我反思"，输出含 "Wait, let me reconsider..."。这种现象在多个 GRPO 复现里都见到：

| 触发条件 | 经验 |
| --- | --- |
| group_size ≥ 8 | 给模型探索空间 |
| reward = 0/1 严格 | 防止学习走捷径 |
| max_completion_length 足够大（≥2K） | 给思考空间 |
| 训练 step ≥ 1000 | 不是几十步就能 emerge |
| base model 已有基础推理 | 完全弱的 base 学不出 |

> 复现 R1-Zero 的开源项目：TinyZero、open-r1、SimpleRL-Zoo。社区共识：**7B 模型用 GSM8K + MATH 训 ~2000 step 能看到 aha moment**。

## 8. 显存 / 速度优化

GRPO 的显存大头：

```text
显存占用 = policy + ref + RM/verifier
        + group_size × max_completion_length × KV cache（rollout）
```

| 优化 | 节省 | 代价 |
| --- | --- | --- |
| ref 用 LoRA base + 不加 adapter | -30% | 实现复杂 |
| 把 ref offload 到 CPU | -25% | rollout 慢 5-15% |
| vLLM 做 rollout | rollout 时间 ÷ 5 | vLLM 占额外 GPU 内存 |
| flash-attention 2 | KV -30% | 必开 |
| gradient_checkpointing | -40% activation | 训练慢 20% |
| group_size 减半 | -50% rollout 显存 | 信号方差大 |

> verl 框架（DeepSeek-R1 同款）专门做了 hybrid engine：训练用 FSDP，rollout 用 vLLM，自动权重同步。比 TRL 高 ~2× 吞吐量。详见 [09 · 工具](./09-tools.md)。

## 9. GRPO 的局限与变种

| 问题 | 应对 |
| --- | --- |
| Group 内全对/全错 → advantage=0 | 用 difficulty-aware sampling，选模型刚好 30-70% 的题 |
| KL 项不稳定 | 用 token-level KL clip 或 dual-clip |
| Off-policy（用旧权重 sample） | rollout 后立刻 update；多 epoch on group |
| 长输出梯度噪声 | Dr.GRPO / DAPO 等变种归一化 per-token |

变种：

- **Dr.GRPO** (Liu et al., 2024)：去除 length normalization 的偏差
- **DAPO** (ByteDance, 2025)：dynamic sampling + clip higher
- **VAPO** (ByteDance, 2025)：value-augmented GRPO，加 critic 回来
- **REINFORCE++** (Hu, 2025)：简化版 GRPO，更省

## 常见坑

1. **不开 vLLM rollout**：HF 原生 generate 在 G=8 + 4K token 下 1 step 要几分钟。开 vLLM 才能跑得动。
2. **max_completion_length 太短**：截断后 boxed 答案没出来，verifier 一律给 0，永远学不会。reasoning 任务建议 4K+。
3. **β 太大锁死**：β > 0.1 模型基本不动，学习信号传不到。R1 用 β=0，DeepSeekMath 用 0.04。激进路线 β=0.01-0.04。
4. **mixed task 不分桶 reward**：数学题和代码题混训，verifier 不区分 reward 尺度，模型偏向单类。要么分阶段，要么 reward 归一化。
5. **不看 completion length 曲线**：reward 涨但 length 爆炸 → 灌水 hack。要看 reward / length 比。

## 下一步

- 上一章 reward 设计：[06 · RLVR](./06-rlvr.md)
- 用过程奖励代替结果：[08 · 过程 vs 结果](./08-process-vs-outcome.md)
- verl / OpenRLHF 跑 R1 复现：[09 · 工具](./09-tools.md)
- 看 R1 / o1 详细案例：[10 · 案例](./10-case-study.md)
- 跨主题：reasoning 模型部署 [`../llm-inference/`](../llm-inference/README.md)
- 跨主题：怎么评 reasoning [`../eval/`](../eval/README.md)
