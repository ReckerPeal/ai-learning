# 04 · DPO 直接偏好优化

> DPO 一句话：**RM + PPO 的解析解**。在偏好对齐这个特定问题上，数学上可以直接对 policy 求导，不必走 RL，loss 长得像有监督学习。

DPO（Rafailov et al., NeurIPS 2023）是 2023-2025 年偏好对齐的工业首选。Zephyr-7B、Llama 3、Tülu 3、Qwen2.5-Instruct 都在用。本章给你能跑、能调、能上线的全套。

## 1. DPO 是怎么从 PPO 推出来的

PPO 优化目标（简化）：

```text
max_π  E[ r(x, y) ]  -  β · KL( π(y|x) || π_ref(y|x) )
```

有解析解 `π*(y|x) ∝ π_ref(y|x) · exp(r(x,y)/β)`。把这个解代回 Bradley-Terry pairwise loss，**reward 项消掉了**，只剩对 policy 的优化目标：

```text
L_DPO(θ) = -E[ log σ( β · log(π_θ(y_w|x)/π_ref(y_w|x))
                    - β · log(π_θ(y_l|x)/π_ref(y_l|x)) ) ]

其中 y_w = winner（chosen），y_l = loser（rejected）
```

| 直觉 | 解释 |
| --- | --- |
| 推高 chosen 的 logprob | 同时压低 rejected 的 logprob |
| 都相对 ref model 做差 | 防止漂离 SFT（隐式 KL 约束） |
| β 取代 KL 系数 | β 越大越保守，越小越激进 |

> 引用：原论文 *Direct Preference Optimization: Your Language Model is Secretly a Reward Model* (Rafailov et al., 2023)。

## 2. 数据格式

DPO 数据需要 (prompt, chosen, rejected) 三元组：

```json
{
  "prompt":   "用 Python 写一个反转字符串的函数。",
  "chosen":   "def reverse(s):\n    return s[::-1]\n",
  "rejected": "你可以用 for 循环来反转字符串。"
}
```

| 数据集 | 规模 | 来源 |
| --- | --- | --- |
| UltraFeedback (binarized) | 64K | GPT-4 评分 64K prompt × 4 模型 |
| Anthropic HH-RLHF | 161K | 人类标注 |
| Nectar | 183K | GPT-4 评 7-wise |
| Capybara DPO | 16K | 多模型 + GPT-4 judge |
| HuggingFaceH4/ultrafeedback_binarized | 主流首选 | TRL 默认 example |

> 经验：开源 DPO 训练 70% 用 UltraFeedback。30K 高质量 pair 比 100K 噪声 pair 训得好（Tülu 2 配方）。

## 3. TRL DPOTrainer 最小配置

```python
# pip install trl peft transformers datasets bitsandbytes
from datasets import load_dataset
from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig
from peft import LoraConfig
from trl import DPOTrainer, DPOConfig

MODEL = "HuggingFaceH4/zephyr-7b-sft-full"
tok = AutoTokenizer.from_pretrained(MODEL)
tok.pad_token = tok.eos_token

bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                         bnb_4bit_compute_dtype="bfloat16")
policy = AutoModelForCausalLM.from_pretrained(MODEL, quantization_config=bnb,
                                              device_map="auto")
# ref model 自动复制，省内存可以用 peft + ref=None
# ref = AutoModelForCausalLM.from_pretrained(MODEL, quantization_config=bnb,
#                                            device_map="auto")

ds = load_dataset("HuggingFaceH4/ultrafeedback_binarized",
                  split="train_prefs[:20000]")

lora = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05,
                  target_modules=["q_proj","k_proj","v_proj","o_proj"],
                  task_type="CAUSAL_LM")

cfg = DPOConfig(
    output_dir="dpo-out",
    per_device_train_batch_size=4,
    gradient_accumulation_steps=4,        # 有效 bs = 16
    learning_rate=5e-7,                   # DPO 比 SFT 小 50-100×
    num_train_epochs=1,                   # 1-2 epoch 通常足够
    warmup_ratio=0.1,
    lr_scheduler_type="cosine",
    bf16=True,
    beta=0.1,                             # 核心超参，见 §4
    max_length=2048,
    max_prompt_length=1024,
    logging_steps=10,
    save_strategy="epoch",
    eval_strategy="steps",
    eval_steps=200,
    loss_type="sigmoid",                  # 默认；可选 hinge / ipo / kto_pair
)

trainer = DPOTrainer(
    model=policy,
    ref_model=None,                       # peft 时自动用 base
    args=cfg,
    train_dataset=ds,
    tokenizer=tok,
    peft_config=lora,
)
trainer.train()
trainer.save_model("dpo-out/final")
```

> 注意：TRL ≥0.12 推荐用 `DPOConfig` 而不是 `TrainingArguments`，旧代码 `DPOTrainer` 参数签名有变。

## 4. β 超参的工程意义

```text
β → 0  ：约束消失，可能漂离 SFT 太远，输出失控
β → ∞  ：完全锁在 ref model 不变化
```

| β 值 | 行为 | 何时用 |
| --- | --- | --- |
| 0.01-0.05 | 激进，chosen 显著强 | SFT 模型偏弱、偏好质量高 |
| 0.1 | 默认起手 | UltraFeedback 标准配方 |
| 0.2-0.5 | 保守，少漂离 ref | 已经强 SFT，怕通用能力遗忘 |
| > 0.5 | 基本不变 | 大多场景过度保守 |

> 一个反直觉发现（Tülu 3 paper Table 7）：**β=0.05 训出来在 AlpacaEval 上略好，但 MMLU 掉 2 个点**。要权衡。

## 5. DPO 训练曲线解读

```text
关键 metric（DPOTrainer 自动 log）：
  rewards/chosen      ← β·logπ(yw)/πref(yw)，应该上升
  rewards/rejected    ← β·logπ(yl)/πref(yl)，应该下降
  rewards/accuracies  ← chosen > rejected 的比例，应该上升
  rewards/margins     ← chosen - rejected，应该上升
  logps/chosen        ← π(yw) 的 logprob，可能小幅下降（注意）
  logps/rejected      ← π(yl) 的 logprob，应该明显下降
```

| 异常 | 诊断 |
| --- | --- |
| `rewards/accuracies` 卡在 0.5 | lr 太低 / β 太大 / 数据有噪声 |
| `rewards/chosen` 也在降（陷阱） | DPO 经典副作用：chosen logprob 也降，靠 rejected 降得更快胜出 |
| margin 升但生成质量降 | reward hacking——可能学到了不该学的 surface pattern |
| eval loss 升但 accuracy 升 | 正常，DPO loss 不直接对应质量 |

> Llama 3 paper 提到这个"chosen logprob 反而降"的问题，引入了 NLL 正则项（"DPO + SFT loss"）来缓解。

## 6. DPO 变种全家桶

| 变种 | loss 形态 | 解决什么 |
| --- | --- | --- |
| DPO（原版） | sigmoid + log-ratio | 基线 |
| IPO (Azar 2023) | 把 sigmoid 换成 squared loss | 防过拟合极端 pair |
| KTO (Ethayarajh 2024) | 单条 + thumbs up/down | 不要 pair |
| ORPO (Hong 2024) | DPO + SFT 合一，不要 ref | 省一个 model |
| SimPO (Meng 2024) | 用 length-normalized logp，去 ref | 更省 + 防长度偏置 |
| CPO (Xu 2024) | DPO + SFT NLL 项 | Llama 3 风格 |
| sDPO (Kim 2024) | 数据切片 + 阶段化 | 防 chosen logp 降 |
| RPO（reject-sampling DPO） | 反复采 + 标 + 训 | Llama 3 后期主力 |

TRL 大多数变种用 `loss_type` 切换：

```python
DPOConfig(loss_type="ipo")     # IPO
DPOConfig(loss_type="hinge")   # SLiC-HF
DPOConfig(loss_type="kto_pair")# 单条数据
# SimPO 需 simpo trainer / 第三方实现
```

## 7. 何时 DPO 不够用

| 场景 | DPO 力有不逮 | 替代 |
| --- | --- | --- |
| 数学 / 代码（可验证答案） | reward 是 0/1 二元，pair 信息少 | RLVR / GRPO（§06、§07） |
| 多步 Agent 决策 | pair 拿不到（哪一步该改？） | 过程监督 PRM（§08） |
| 长链推理 | DPO 拉长但思路不变 | GRPO + reward shaping |
| 红队 / 安全 | 需要 online 采新样本 | PPO + safety RM |

> 经验：**chat 偏好对齐用 DPO 几乎是上限；数学/代码用 DPO 顶多到 GSM8K +3 个点，再多就要上 RLVR**。

## 8. 端到端：从 SFT model 到 DPO chat model

```yaml
# alignment-handbook 风格 yaml
# pip install alignment-handbook
model_name_or_path: HuggingFaceH4/zephyr-7b-sft-full
dataset_mixer:
  HuggingFaceH4/ultrafeedback_binarized: 1.0
dataset_splits:
  - train_prefs
  - test_prefs
preprocessing_num_workers: 12

bf16: true
beta: 0.01
loss_type: sigmoid
do_eval: true
eval_strategy: steps
eval_steps: 100
gradient_accumulation_steps: 2
gradient_checkpointing: true
learning_rate: 5.0e-7
log_level: info
logging_steps: 10
lr_scheduler_type: cosine
max_length: 1024
max_prompt_length: 512
num_train_epochs: 1
optim: adamw_torch
output_dir: data/zephyr-7b-dpo-full
per_device_train_batch_size: 8
per_device_eval_batch_size: 8
push_to_hub: false
save_strategy: epoch
seed: 42
warmup_ratio: 0.1
```

```bash
# 启动训练（alignment-handbook recipes 提供）
ACCELERATE_LOG_LEVEL=info accelerate launch \
  --config_file recipes/accelerate_configs/deepspeed_zero3.yaml \
  scripts/run_dpo.py recipes/zephyr-7b-beta/dpo/config_full.yaml
```

> Zephyr-7B-β 用上面这套配方在 8×A100 上跑 ~10 小时复现，AlpacaEval 2 win-rate ~13.6%。Tülu 2 / 3 用类似 pipeline 但加了 reject sampling 迭代。

## 9. 评测 DPO 模型

| Benchmark | 关注 | 工具 |
| --- | --- | --- |
| AlpacaEval 2 (LC) | 长度归一化偏好胜率 | <https://github.com/tatsu-lab/alpaca_eval> |
| MT-Bench | 多轮 chat 质量（GPT-4 judge） | FastChat |
| Arena-Hard | 难 prompt 偏好 | <https://github.com/lm-sys/arena-hard-auto> |
| MMLU | 通用知识，**检查遗忘** | lm-eval-harness |
| IFEval | 指令跟随 | lm-eval-harness |
| RewardBench | RM 本身 | <https://github.com/allenai/reward-bench> |

> 必跑 MMLU before/after：DPO 经常造成 0.5-2 个点 MMLU 下降。配合 [`../eval/`](../eval/README.md) 的灾难性遗忘流程检测。

## 常见坑

1. **lr 用 SFT 的值（2e-5）**：DPO lr 应该在 1e-7 ~ 5e-6 区间。SFT lr 给 DPO 会立刻把模型炸出 SFT 邻域，输出乱码。
2. **prompt 太长被截断**：`max_prompt_length` 默认 512，多轮 chat prompt 经常超。要么调高，要么过滤掉超长样本。
3. **ref model 用错版本**：ref model 必须是当前 policy 的 SFT 起点。用 base 或别的 SFT 都会让 KL 锚错位置。
4. **β=0.1 不普世**：UltraFeedback 用 0.01-0.05 更好，HH-RLHF 用 0.1 更好。不要照搬 default。
5. **不评测 MMLU 直接上线**：DPO 经常以"通用能力轻微下降"为代价换 AlpacaEval 上涨。生产模型要权衡。

## 下一步

- 没人类偏好，用 AI 生成：[05 · RLAIF](./05-rlaif.md)
- 数学/代码用可验证 reward：[06 · RLVR](./06-rlvr.md)
- 训 reasoning Agent：[07 · GRPO](./07-grpo.md)
- 不同 DPO 变种的工具支持：[09 · 工具](./09-tools.md)
- 看 Llama 3 怎么把 DPO 用到极致：[10 · 案例](./10-case-study.md)
- 跨主题：DPO 模型怎么部署 [`../llm-inference/`](../llm-inference/README.md)
