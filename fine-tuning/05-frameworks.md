# 05 · 训练框架

> 微调框架百花齐放。本章给出选型矩阵 + 每个框架的最简跑通命令。**先选框架，再选超参**。

## 1. 选型矩阵

| 框架 | 学习曲线 | 灵活度 | 速度 | 多 GPU | 中文社区 | 适合 |
| --- | --- | --- | --- | --- | --- | --- |
| **HF TRL** | 中 | 高 | 中 | 是（accelerate） | 一般 | 学习原理、自定义 |
| **Axolotl** | 中 | 高 | 中-快 | 是（DS / FSDP） | 一般 | 工业、可复现 |
| **LLaMA-Factory** | 低 | 中 | 中 | 是 | 强 | 中文团队、UI 派 |
| **Unsloth** | 低 | 中 | 极快（2-5x） | 弱（单卡） | 一般 | 单卡极致省时 |
| **DeepSpeed** | 高 | 极高 | 极快（多卡） | 是 | 一般 | 大模型多卡训练 |
| **FSDP（PyTorch 原生）** | 中 | 高 | 快（多卡） | 是 | 一般 | 不想引 DeepSpeed |
| **MLX-LM** | 低 | 中 | 中（Mac） | - | 弱 | Apple Silicon |
| **手写 PyTorch** | 极高 | 极高 | 看实现 | 自己处理 | - | 几乎不该 |

> 个人推荐：**入门 LLaMA-Factory（UI 跑通）→ 进阶 Axolotl（YAML 工业化）→ 自定义 TRL（写代码）→ 极致速度 Unsloth → 大模型 DeepSpeed**。

## 2. HuggingFace TRL（基础）

最贴近原生、文档最全、研究侧首选。支持 SFT / DPO / KTO / GRPO / ORPO。

```bash
pip install trl peft bitsandbytes accelerate datasets
```

```bash
# 5 行跑通：CLI 直接训 LoRA
trl sft \
  --model_name_or_path Qwen/Qwen2.5-7B-Instruct \
  --dataset_name trl-lib/Capybara \
  --learning_rate 2e-4 --num_train_epochs 1 \
  --packing --use_peft --lora_r 16 --lora_alpha 32 \
  --output_dir trl-out --bf16
```

适合：跟 PyTorch 生态紧、想自己改 trainer、新方法（GRPO / DPO）出来最早实现。

## 3. Axolotl（YAML 驱动，工业首选）

```bash
pip install axolotl[deepspeed]
```

`config.yaml`：

```yaml
base_model: Qwen/Qwen2.5-7B-Instruct
load_in_4bit: true
strict: false

datasets:
  - path: ./clean.jsonl
    type: chat_template
    chat_template: chatml

dataset_prepared_path: last_prep
val_set_size: 0.05
output_dir: ./axolotl-out

adapter: qlora
lora_r: 16
lora_alpha: 32
lora_dropout: 0.05
lora_target_modules: all-linear

sequence_len: 2048
sample_packing: true
gradient_accumulation_steps: 8
micro_batch_size: 2
num_epochs: 3
optimizer: paged_adamw_8bit
lr_scheduler: cosine
learning_rate: 0.0002
warmup_ratio: 0.03
bf16: auto
gradient_checkpointing: true
flash_attention: true

logging_steps: 10
saves_per_epoch: 1
evals_per_epoch: 2
```

```bash
accelerate launch -m axolotl.cli.train config.yaml
```

特性：YAML 即配置即版本控制，prompt template 内置（chatml / alpaca / llama3 …），DeepSpeed / FSDP 一键开。

## 4. LLaMA-Factory（中文友好，UI 派）

```bash
pip install llamafactory
llamafactory-cli webui    # 浏览器打开 GUI
```

或命令行：

```bash
llamafactory-cli train \
  --model_name_or_path Qwen/Qwen2.5-7B-Instruct \
  --stage sft --do_train \
  --finetuning_type lora --lora_target all \
  --quantization_bit 4 \
  --dataset alpaca_zh_demo \
  --template qwen \
  --output_dir ./lf-out \
  --per_device_train_batch_size 2 --gradient_accumulation_steps 8 \
  --learning_rate 2e-4 --num_train_epochs 3 --bf16
```

特性：
- WebUI 全中文，新手 30 分钟跑通
- 内置百余个数据集 + 模型模板
- 支持 SFT / DPO / KTO / PPO / RM / 预训练
- 中文场景文档密
- 缺点：自定义自由度低于 Axolotl

## 5. Unsloth（速度王者，单卡极致）

```bash
pip install unsloth
```

```python
from unsloth import FastLanguageModel
import torch

model, tok = FastLanguageModel.from_pretrained(
    "unsloth/Qwen2.5-7B-Instruct-bnb-4bit",
    max_seq_length=2048, load_in_4bit=True,
)
model = FastLanguageModel.get_peft_model(
    model, r=16, lora_alpha=32, lora_dropout=0.05,
    target_modules=["q_proj","k_proj","v_proj","o_proj",
                    "gate_proj","up_proj","down_proj"],
    use_gradient_checkpointing="unsloth",
)

from trl import SFTTrainer, SFTConfig
from datasets import load_dataset
ds = load_dataset("json", data_files="clean.jsonl", split="train")

trainer = SFTTrainer(
    model=model, tokenizer=tok, train_dataset=ds,
    args=SFTConfig(
        output_dir="us-out", per_device_train_batch_size=2,
        gradient_accumulation_steps=8, num_train_epochs=3,
        learning_rate=2e-4, bf16=True, packing=True,
        max_seq_length=2048, optim="adamw_8bit",
    ),
)
trainer.train()
```

| 维度 | Unsloth |
| --- | --- |
| 速度 | 比 HF 快 2-5x（通过手写 Triton kernel） |
| 显存 | 比 HF 省 40-70% |
| 多卡 | 弱（社区版仅单卡 / Pro 版多卡） |
| 模型支持 | 主流模型（Llama / Qwen / Mistral / Gemma 等） |
| 何时用 | 单卡用户 / 速度敏感 / 大数据快迭代 |

## 6. DeepSpeed / FSDP（多卡 / 大模型）

70B 模型必须多卡。两种主流并行：

| 方案 | 原理 | 优 | 劣 |
| --- | --- | --- | --- |
| **DeepSpeed ZeRO-2** | 切 optimizer + grad | 速度好 | 显存还需一份模型 |
| **DeepSpeed ZeRO-3** | 切 optimizer + grad + 参数 | 显存最省 | 通信开销大 |
| **FSDP** | PyTorch 原生切片 | 没有外部依赖 | 配置略复杂 |
| **TP（张量并行）** | 单层切多卡 | 单层超大模型 | 通信瓶颈 |
| **PP（流水线并行）** | 不同层不同卡 | 极大模型 | 利用率低 |

```bash
# DeepSpeed ZeRO-3 launch（配合 Axolotl / TRL）
accelerate launch \
  --config_file ds_zero3.yaml \
  -m axolotl.cli.train 70b_qlora.yaml
```

`ds_zero3.yaml`（accelerate 配置）：

```yaml
compute_environment: LOCAL_MACHINE
distributed_type: DEEPSPEED
deepspeed_config:
  zero_stage: 3
  offload_optimizer_device: cpu        # 显存不够再开
  offload_param_device: none
  zero3_init_flag: true
num_processes: 8
mixed_precision: bf16
```

## 7. 框架命令对照表

| 操作 | TRL | Axolotl | LLaMA-Factory | Unsloth |
| --- | --- | --- | --- | --- |
| LoRA SFT | `trl sft ...` | `axolotl train cfg.yaml` | `llamafactory-cli train ...` | Python script |
| DPO | `trl dpo ...` | `rl: dpo` 配置 | `--stage dpo` | 内置 + TRL |
| GRPO | `trl grpo ...` | `rl: grpo` | 不支持/弱 | 实验性 |
| 多卡 | `accelerate launch` | 内置 DS/FSDP | `--ddp_*` flags | 单卡为主 |
| WebUI | 无 | 无 | 强项 | 无 |
| 配置形态 | argparse / Python | YAML | argparse / WebUI | Python |

## 8. 何时手写 PyTorch

- 99% 不需要。已经有人写得比你好。
- 真正需要：完全新颖的优化目标（不是 SFT/DPO/GRPO 任一）、研究侧的纯 PoC、教学。
- 哪怕你要写新 loss，也基于 TRL 的 `Trainer.compute_loss` 改。

## 9. 选型决策树

```text
你有几张卡？
├─ 单卡（24-48GB）
│   ├─ 中文团队 / 想要 UI       → LLaMA-Factory
│   ├─ 速度第一                 → Unsloth
│   └─ 想学原理 / 改框架        → TRL
├─ 单机多卡（4-8 卡）
│   ├─ 工业可复现               → Axolotl + DeepSpeed
│   └─ 自定义多                 → TRL + accelerate
└─ 多机多卡（≥ 16 卡，大模型）  → DeepSpeed / FSDP（任何前端皆可）
```

## 10. 训练监控

| 工具 | 用途 |
| --- | --- |
| TensorBoard | 默认 |
| W&B（wandb） | 业界标配，多实验对比强 |
| MLflow | 企业内部 |
| SwanLab | 国产 W&B 替代 |
| 自家 logging hook | 大公司常做 |

```python
# TRL / SFTConfig 中开 wandb
SFTConfig(report_to="wandb", run_name="qwen7b-domain-v1")
```

## 常见坑

1. **多卡跑出来效果比单卡差**：90% 是 batch size 没等比放大或 lr 没线性 scale。8 卡时 lr 对应 × 4-8。
2. **Axolotl 模板选错**：`type: alpaca` 跑 Qwen 会拼接错 chat template，输出乱。Qwen 用 `chat_template: chatml` 或 `qwen`。
3. **DeepSpeed ZeRO-3 + LoRA 报错**：参数切片后 PEFT 状态字典异常。要么用 ZeRO-2 + LoRA，要么 ZeRO-3 + 全参。组合看版本。
4. **Unsloth 版本飘**：每月大改，pin 死版本号 + 跑通后别动。
5. **flash_attention 没开**：长 seq 训练慢一倍 + 显存高 30%。`pip install flash-attn`，配置里开 `flash_attention: true`。

## 下一步

- 用什么数据训：[02 · 数据](./02-data.md)
- LoRA 超参怎么定：[04 · PEFT](./04-peft.md)
- 数据合成：[06 · 数据合成](./06-synthetic-data.md)
- 评测：[07 · 评测](./07-evaluation.md)
- 端到端跑通一个：[10 · 案例](./10-case-study.md)
