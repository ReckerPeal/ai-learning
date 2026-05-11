# 04 · PEFT 全家桶（LoRA / QLoRA）

> Parameter-Efficient Fine-Tuning：用 1-3% 的可训练参数，跑出接近全参 95-99% 的效果。所有人都该把 LoRA 和 QLoRA 当默认。

## 1. 为什么 PEFT 必学

| 痛点 | 全参 | LoRA / QLoRA |
| --- | --- | --- |
| 7B 模型显存占用 | ≥ 80GB（含 optimizer） | 16-24GB |
| 多任务存储 | 每任务一份完整权重（14GB） | 共享 base + adapter（几十 MB） |
| 训练速度 | 慢 | 快 1.5-3x |
| 易过拟合 / 遗忘 | 严重 | 轻 |
| 单卡训 70B | 几乎不可能 | QLoRA 单卡 H100 / 双 4090 可 |

## 2. LoRA 原理（最少必要数学）

把权重更新分解成两个小矩阵：

```text
W_new = W + ΔW
ΔW = B · A,  其中 A ∈ R^{r×k}, B ∈ R^{d×r}, r << min(d, k)
训练：A、B；冻结：W
推理（合并后）：W' = W + B·A，无额外开销
```

只训 `A`、`B` 两个小矩阵。`r` 是低秩维度。

| 参数 | 含义 | 推荐 |
| --- | --- | --- |
| `r` (rank) | 秩，决定容量 | 8 / 16 / 32 / 64 |
| `lora_alpha` | 缩放因子 | r 的 1-2 倍 |
| `lora_dropout` | dropout | 0.05-0.1 |
| `target_modules` | 哪些层加 LoRA | 见下表 |
| `bias` | 是否训 bias | "none" |
| `modules_to_save` | 完全训某些层 | embed / lm_head（看任务） |

### target_modules 怎么选

| 选法 | 说明 | 何时用 |
| --- | --- | --- |
| q,v | 最经典（原 LoRA 论文） | 资源紧 |
| q,k,v,o | attention 全 | 标准推荐 |
| q,k,v,o + gate,up,down (MLP) | 全 linear | 最佳效果，参数翻倍 |
| `target_modules="all-linear"` | peft 提供的简写 | 偷懒首选 |

```python
from peft import LoraConfig
LoraConfig(
    r=16, lora_alpha=32, lora_dropout=0.05,
    bias="none", task_type="CAUSAL_LM",
    target_modules="all-linear",  # 或 ["q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj"]
)
```

## 3. QLoRA：4-bit 量化 + LoRA

QLoRA 把 base model 量化成 4-bit，再加 LoRA。显存进一步降到 30%。

```python
from transformers import BitsAndBytesConfig
bnb = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_quant_type="nf4",          # NormalFloat4，比 fp4 好
    bnb_4bit_compute_dtype="bfloat16",  # 计算时 dequant 到 bf16
    bnb_4bit_use_double_quant=True,     # 二次量化，省 0.4 bit/param
)
```

| 配置 | 7B 训练显存 | 13B | 70B |
| --- | --- | --- | --- |
| 全参 fp16 | 80GB+ | 130GB+ | 750GB+ |
| LoRA bf16 | 22GB | 36GB | 180GB |
| **QLoRA nf4** | **8-12GB** | **18GB** | **45-50GB** |

QLoRA 微调质量与 LoRA 接近（论文 < 1% 差距），实战可放心用。

## 4. 完整 QLoRA 训练（可跑）

```python
# pip install transformers peft trl bitsandbytes accelerate datasets
import torch
from datasets import load_dataset
from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig
from peft import LoraConfig, prepare_model_for_kbit_training
from trl import SFTTrainer, SFTConfig

MODEL = "Qwen/Qwen2.5-7B-Instruct"

bnb = BitsAndBytesConfig(
    load_in_4bit=True, bnb_4bit_quant_type="nf4",
    bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True,
)
tok = AutoTokenizer.from_pretrained(MODEL)
model = AutoModelForCausalLM.from_pretrained(MODEL, quantization_config=bnb, device_map="auto")
model = prepare_model_for_kbit_training(model)   # 关键：开启 grad checkpoint + cast layer norm

lora = LoraConfig(
    r=16, lora_alpha=32, lora_dropout=0.05,
    target_modules="all-linear", bias="none", task_type="CAUSAL_LM",
)

ds = load_dataset("json", data_files="clean.jsonl", split="train")

cfg = SFTConfig(
    output_dir="qlora-out",
    per_device_train_batch_size=2,
    gradient_accumulation_steps=16,
    learning_rate=2e-4,
    num_train_epochs=3,
    warmup_ratio=0.03,
    lr_scheduler_type="cosine",
    bf16=True,
    optim="paged_adamw_8bit",   # 关键：8-bit AdamW，显存再省 30%
    logging_steps=10,
    save_strategy="epoch",
    max_seq_length=2048,
    packing=True,
    gradient_checkpointing=True,
)

trainer = SFTTrainer(model=model, tokenizer=tok, args=cfg,
                     train_dataset=ds, peft_config=lora)
trainer.train()
trainer.save_model("qlora-out/final")
```

显存还不够？降到 `bs=1, max_seq_length=1024, r=8`。

## 5. 超参指南（实战值）

| 任务规模 | r | alpha | lr | epochs | 备注 |
| --- | --- | --- | --- | --- | --- |
| 风格调整（< 5k 样本） | 8 | 16 | 3e-4 | 2-3 | r 太大易过拟合 |
| 标准 SFT（5-50k） | 16 | 32 | 2e-4 | 3 | 默认起手 |
| 大数据 SFT（50k+） | 32-64 | 64-128 | 1e-4 | 2-3 | 接近全参 |
| 领域知识强注入 | 64 | 128 | 1e-4 | 3-5 | 配合 modules_to_save 嵌入层 |
| 蒸馏 | 32 | 64 | 1e-4 | 2 | 小 lr 防教师模式坍塌 |
| DPO（偏好对齐） | 16 | 32 | 5e-7 ~ 5e-6 | 1-2 | 注意 lr 比 SFT 小 1-2 个数量级 |

经验：**alpha = 2r** 是最常见的组合，相当于 scaling 固定 = 2，调 r 等价于调容量。

## 6. PEFT 家族对比

| 方法 | 思路 | 参数量 | 推理 overhead | 何时选 |
| --- | --- | --- | --- | --- |
| **LoRA** | 加低秩 ΔW | 0.1-3% | 0（合并后） | 默认 |
| **QLoRA** | LoRA + 4-bit base | 同上 | 不合并：有 dequant | 显存紧 |
| **DoRA** | 拆 magnitude+direction | 1.2x LoRA | 略高 | 想多 1-2% 效果 |
| **LoRA+** | A/B 不同 lr | 同 LoRA | 0 | 简单加分 |
| **rsLoRA** | 缩放因子改 1/√r | 同 LoRA | 0 | r 大时 |
| **Prefix Tuning** | 在 KV 前加可学 prefix | 极小 | 有（占 context） | 老方法，少用 |
| **Prompt Tuning** | 学 soft prompt | 极小 | 占 context | 大模型 + 小数据 |
| **IA³** | 缩放 K/V/FFN | 极小 | 0 | 多任务存档 |
| **AdaLoRA** | 自适应分配 r | 同 LoRA | 0 | 调参懒得人 |

实务上：**LoRA + QLoRA + 偶尔 DoRA**。其它了解即可。

## 7. 合并 vs 不合并 LoRA 权重

```python
# 合并：得到完整模型，推理时无 LoRA overhead
from peft import PeftModel
from transformers import AutoModelForCausalLM

base = AutoModelForCausalLM.from_pretrained("Qwen/Qwen2.5-7B-Instruct",
                                            torch_dtype="bfloat16", device_map="auto")
peft = PeftModel.from_pretrained(base, "qlora-out/final")
merged = peft.merge_and_unload()
merged.save_pretrained("merged-model")

# 注意：QLoRA 训出的 adapter 合并前要先 dequant base 到 fp16/bf16
# 否则合进 4-bit base 会精度损失
```

| 场景 | 合并 | 不合并 |
| --- | --- | --- |
| 单一微调上线 | 推荐 | - |
| 多任务部署（同 base） | 不合并，多 adapter 共享 | 浪费显存 |
| 转 GGUF / AWQ | 必须合并 | 不支持直接转 |
| 二次微调 | 视情况，一般不合并 | 保留 LoRA 继续训 |

## 8. 多 LoRA 服务

一个 base model 上挂多个任务 adapter，按请求切换。常见生产方案：

| 方案 | 特性 |
| --- | --- |
| **vLLM multi-lora** | 原生支持 `--enable-lora`，按请求 `lora_request` 选 |
| **LoRAX**（Predibase） | 多 LoRA 推理引擎，支持热加载 |
| **HuggingFace TGI** | `--lora-adapters` |
| **PEFT 直接切换** | 开发期方便，生产不行 |

```python
# vLLM 多 LoRA 示例
from vllm import LLM, SamplingParams
from vllm.lora.request import LoRARequest

llm = LLM(model="Qwen/Qwen2.5-7B-Instruct", enable_lora=True, max_loras=4, max_lora_rank=32)
params = SamplingParams(temperature=0.7, max_tokens=256)

out_a = llm.generate("分类该工单：申请退款",
                     params, lora_request=LoRARequest("intent", 1, "qlora-out/final"))
out_b = llm.generate("写一段宣传文案",
                     params, lora_request=LoRARequest("copy", 2, "/path/to/copy-lora"))
```

| 取舍 | 多 LoRA 共享 | 多个完整模型 |
| --- | --- | --- |
| 显存 | 1×base + n×adapter（小） | n×完整模型（大） |
| 切换成本 | 几乎为 0 | 重新加载 |
| 单 adapter 性能 | 略低 5-10% | 满血 |
| 适合 | 多任务、QPS 不极致 | 单任务、QPS 高 |

## 9. modules_to_save 用法

LoRA 默认只动 attention/MLP 的 linear。但有些场景**必须训 embedding / lm_head**：

| 场景 | 必加 modules_to_save |
| --- | --- |
| 加新 token / 扩词表 | embed_tokens, lm_head |
| 严重领域偏移 | embed_tokens（可选） |
| 普通 SFT | 不需要 |

```python
LoraConfig(
    r=16, lora_alpha=32, target_modules="all-linear",
    modules_to_save=["embed_tokens", "lm_head"],   # 这两层完全训
)
```

注意：`modules_to_save` 会显著增加显存。

## 常见坑

1. **`prepare_model_for_kbit_training` 漏调**：QLoRA 必须先调它，否则 grad checkpoint 不开 / layer norm 精度错，loss 不降。
2. **alpha 设错**：经常看到 `r=64, alpha=16`，scaling 仅 0.25，等于没训。`alpha=2r` 当默认。
3. **lr 套 SFT 全参的值**：LoRA lr 应是全参的 5-10 倍（2e-4 vs 2e-5）。
4. **target_modules 错位**：模型结构换了（Llama → Qwen），target name 不一样。`all-linear` 最稳。
5. **合并 QLoRA 权重精度坍塌**：合并前要先把 base 反量化到 bf16，再合并保存。直接合 4-bit 会掉点。

## 下一步

- 训练框架对比：[05 · 训练框架](./05-frameworks.md)
- 评测 LoRA 效果：[07 · 评测](./07-evaluation.md)
- 推理量化（不同于训练量化）：[08 · 量化](./08-quantization.md)
- 多 LoRA 部署：[09 · 部署微调模型](./09-deployment.md)
- 案例：[10 · 案例](./10-case-study.md)
