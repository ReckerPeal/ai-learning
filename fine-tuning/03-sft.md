# 03 · SFT 基础

> SFT（Supervised Fine-Tuning）是所有微调的起点，本质是"在指令-回答对上做 next-token prediction，但只对回答部分算 loss"。看懂这一句，比看 10 篇博客都强。

## 1. 损失函数：response-only cross-entropy

不是所有 token 都参与 loss。`prompt` 部分**不算 loss**（loss mask = 0），只在 `response` 部分算：

```text
<|im_start|>user
翻译：今天天气真好<|im_end|>     ← loss=0
<|im_start|>assistant            ← loss=0
The weather is nice today.<|im_end|>  ← loss=1（这部分才训）
```

为什么？因为 prompt 是输入条件（已知），不需要模型"学会预测 prompt"。早期实现忽略 mask，效果显著变差。

| 方式 | loss 范围 | 何时用 |
| --- | --- | --- |
| Response-only | 仅 assistant tokens | SFT 默认（推荐） |
| Full sequence | 所有 token | continued pretrain / 长文 |
| User+Assistant | 不 mask system | 极少用 |

> TRL `SFTTrainer` 用 `DataCollatorForCompletionOnlyLM` 实现 response-only。Axolotl 用 `train_on_inputs: false`。

## 2. 数据 → 训练样本

```python
# 一个最小 SFT 数据 collator（演示原理）
from transformers import AutoTokenizer
import torch

tok = AutoTokenizer.from_pretrained("Qwen/Qwen2.5-7B-Instruct")

def build(example):
    msgs = example["messages"]  # [{"role":"user","content":"..."},{"role":"assistant","content":"..."}]
    # 整段文本（applied chat template）
    full = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=False)
    # 仅到 assistant 起始位置（用于 mask 边界）
    prompt_only = tok.apply_chat_template(msgs[:-1], tokenize=False, add_generation_prompt=True)

    full_ids = tok(full, add_special_tokens=False).input_ids
    prompt_ids = tok(prompt_only, add_special_tokens=False).input_ids

    labels = list(full_ids)
    # mask 掉 prompt 部分
    for i in range(len(prompt_ids)):
        labels[i] = -100   # -100 是 ignore_index

    return {
        "input_ids": full_ids,
        "labels": labels,
        "attention_mask": [1] * len(full_ids),
    }

ex = {"messages": [
    {"role": "user", "content": "翻译：今天天气真好"},
    {"role": "assistant", "content": "The weather is nice today."},
]}
out = build(ex)
print("len:", len(out["input_ids"]),
      "first masked:", out["labels"][:5],
      "last unmasked:", out["labels"][-5:])
```

## 3. 关键超参（SFT）

| 超参 | 推荐范围 | 说明 |
| --- | --- | --- |
| learning_rate | 全参 1e-5 ~ 5e-5；LoRA 1e-4 ~ 5e-4 | LoRA 比全参高一个量级 |
| batch_size | 实际 64-256（gradient_accumulation 凑） | 小了 loss 抖；大了显存炸 |
| epochs | 2-5（小数据 5-10） | 看 eval loss 早停 |
| warmup_ratio | 0.03-0.1 | 防早期发散 |
| weight_decay | 0.01-0.1 | 防过拟合 |
| max_grad_norm | 1.0 | 梯度裁剪标准值 |
| lr_scheduler | cosine | linear 也行 |
| gradient_accumulation_steps | 凑到有效 batch=128 | 显存不够时调高 |
| max_seq_length | 2048-8192 | 越长越费显存 |
| neftune_noise_alpha | 5（可选） | 加噪提升泛化 |
| packing | True（同长样本合并） | 训练加速 1.5-3x |

> 经验起手：`lr=2e-4 (LoRA) / 2e-5 (全参), bs=128, epochs=3, warmup=0.03, cosine, weight_decay=0.01, packing=True`

## 4. TRL SFT 最小可跑

```python
# pip install trl peft transformers datasets bitsandbytes
from datasets import load_dataset
from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig
from peft import LoraConfig
from trl import SFTTrainer, SFTConfig

MODEL = "Qwen/Qwen2.5-7B-Instruct"

bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                         bnb_4bit_compute_dtype="bfloat16")
tok = AutoTokenizer.from_pretrained(MODEL)
model = AutoModelForCausalLM.from_pretrained(MODEL, quantization_config=bnb,
                                             device_map="auto")
ds = load_dataset("json", data_files="clean.jsonl", split="train")

lora = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, bias="none",
                  task_type="CAUSAL_LM",
                  target_modules=["q_proj","k_proj","v_proj","o_proj"])

cfg = SFTConfig(
    output_dir="out",
    per_device_train_batch_size=4,
    gradient_accumulation_steps=8,    # 有效 bs = 32
    learning_rate=2e-4,
    num_train_epochs=3,
    warmup_ratio=0.03,
    lr_scheduler_type="cosine",
    bf16=True,
    logging_steps=10,
    save_strategy="epoch",
    max_seq_length=2048,
    packing=True,
)

trainer = SFTTrainer(model=model, tokenizer=tok, args=cfg,
                     train_dataset=ds, peft_config=lora)
trainer.train()
trainer.save_model("out/final")
```

## 5. 训练曲线解读

| 信号 | 健康 | 异常 → 原因 |
| --- | --- | --- |
| train loss | 平滑下降，从 ~2 到 0.5-1.0 | 飞升 → lr 太高；不动 → mask 错了 / lr 太低 |
| eval loss | 跟随 train loss 下降，后期略发散 | 早期就发散 → 数据有问题 / 过拟合 |
| grad_norm | 0.3 ~ 3 之间 | 持续 >10 → 不稳；<0.01 → 不学 |
| learning_rate | warmup 升 → cosine 降 | 没 warmup 易爆 |
| token accuracy | 逐步上升 | 不动 → 模板错位最常见 |

经验：train loss < 0.3 通常是过拟合。eval loss 才是参考，但**eval loss 也会骗人**（见下节）。

## 6. 灾难性遗忘（catastrophic forgetting）

SFT 过头，模型在专业任务上提升，但通用能力（数学 / 代码 / 多语）下降，称为灾难性遗忘。

| 缓解 | 效果 |
| --- | --- |
| 混入通用数据（10-30%） | 强烈推荐 |
| 训练 epoch 减少（2-3） | 简单有效 |
| 用 PEFT 而非全参 | LoRA 天生不易遗忘 |
| 学习率减小 | 配合 epoch 调 |
| 在 base model 上 SFT 而非 instruct | 看场景，instruct 已对齐用 LoRA 更安全 |
| Replay buffer（混入预训练数据） | 工业级方案 |

具体评测方法：[07 · 评测](./07-evaluation.md)。Agentic RL 是 SFT 的高阶形态：[../agents/10-production.md#7-agentic-rl-简介](../agents/10-production.md)。

## 7. Early stopping 策略

```python
from transformers import EarlyStoppingCallback

trainer = SFTTrainer(
    ...,
    callbacks=[EarlyStoppingCallback(
        early_stopping_patience=2,        # 连续 2 次 eval 不降就停
        early_stopping_threshold=0.001,
    )],
)
```

| 配置 | 适用 |
| --- | --- |
| `eval_strategy="steps"` + `eval_steps=200` | 数据多 |
| `eval_strategy="epoch"` | 数据少 |
| `metric_for_best_model="eval_loss"` | 默认 |
| `metric_for_best_model="eval_accuracy"` | 自定义 metric |
| `load_best_model_at_end=True` | 必开 |

## 8. 全参 vs PEFT 选择

| 因素 | 全参 | PEFT (LoRA) |
| --- | --- | --- |
| 显存 | 模型 + 优化器（4×参数） | 模型 + adapter（~10%） |
| 速度 | 慢 | 快 1.5-3x |
| 效果（任务内） | 略好 1-3% | 接近 |
| 通用能力保留 | 差 | 好（adapter 不动 base） |
| 多任务部署 | 多份完整权重 | 共享 base + 多 adapter |
| 调试 / 回滚 | 麻烦 | adapter 文件几十 MB |

> 默认从 LoRA 起步。除非你有 8 卡 + 充裕预算 + LoRA 已经吃满。详见 [04 · PEFT](./04-peft.md)。

## 9. Multi-turn 对话训练注意事项

```python
# 多轮对话：每个 assistant 回合都参与 loss
# 用 TRL 的 conversational format + apply_chat_template 自动处理

ds = ds.map(lambda x: {
    "text": tok.apply_chat_template(x["messages"], tokenize=False)
})

# 重要：collator 要识别 multiple assistant blocks
from trl import DataCollatorForCompletionOnlyLM
# instruction_template / response_template 要和模型 chat template 对齐
```

| 坑 | 后果 |
| --- | --- |
| 只算最后一轮 loss | 浪费数据，效果差 |
| 模板里少 `<|im_end|>` | 模型不会停 |
| 多轮历史超 max_seq_length | 截断逻辑要对（前截 / 后截） |
| 系统消息每轮重复 | packing 友好但浪费 |

## 10. SFT vs Agentic RL（衔接）

| 阶段 | 数据 | 目标 |
| --- | --- | --- |
| **SFT（本章）** | 人工 / 蒸馏的"正确轨迹" | 模仿学习 |
| RFT / GRPO | 可验证奖励（数学答案、单测） | 自我提升 |
| Agentic RL | 多步交互、tool reward | 决策优化 |

SFT 是地基。没有好的 SFT 模型，RL 训不动。Agentic RL 详见 [../agents/10-production.md#7-agentic-rl-简介](../agents/10-production.md)。

## 常见坑

1. **chat template 没对齐**：训练用 ChatML，推理用别的，输出全乱。固定一套 template，训练前先跑 `apply_chat_template` 打印一条样本人工 verify。
2. **没 mask prompt**：loss 全算了，模型在"复述 prompt"上花资源，eval 看似没问题但生成质量差。
3. **lr 套全参的值给 LoRA**：LoRA lr 应该是全参的 5-10 倍。`lr=2e-5` 给 LoRA 几乎不学。
4. **train loss 0.05 还在训**：过拟合。验证集上看泛化，不是 train loss 越低越好。
5. **没混通用数据**：domain SFT 后中文都说不利索了。10-30% 通用数据掺入。

## 下一步

- 用 LoRA 训：[04 · PEFT 全家桶](./04-peft.md)
- 选什么框架：[05 · 训练框架](./05-frameworks.md)
- 怎么评测训完的模型：[07 · 评测](./07-evaluation.md)
- 高级形态 Agentic RL：[../agents/10-production.md](../agents/10-production.md)
- 端到端案例：[10 · 案例](./10-case-study.md)
