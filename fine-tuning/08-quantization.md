# 08 · 量化

> 量化是"用精度换显存/速度"。本章只讲微调相关：训练时量化（QLoRA）+ 推理时量化简介。深度推理量化（GPTQ / AWQ / GGUF 引擎差异）见即将的 llm-inference 主题。

## 1. 训练时 vs 推理时量化

| 维度 | 训练时量化 | 推理时量化 |
| --- | --- | --- |
| 目标 | 训练能跑起来（省显存） | 推理快、便宜、上设备 |
| 代表 | QLoRA（bitsandbytes nf4） | GPTQ / AWQ / GGUF |
| 精度 | 4-bit base + LoRA fp16 计算 | 全权重 4-bit / 8-bit |
| 训练能反传 | 是（dequant 后算梯度） | 否（仅推理） |
| 谁负责 | bnb / unsloth | vLLM / llama.cpp / TensorRT-LLM |

**关键**：QLoRA 训出的 LoRA + base 不等于一个量化的推理模型。要部署量化，需要再走一次推理量化流程。

## 2. 训练时量化：QLoRA 路径

```python
from transformers import BitsAndBytesConfig
import torch

bnb = BitsAndBytesConfig(
    load_in_4bit=True,                       # 4-bit
    bnb_4bit_quant_type="nf4",               # NormalFloat4
    bnb_4bit_compute_dtype=torch.bfloat16,   # 算的时候 dequant 到 bf16
    bnb_4bit_use_double_quant=True,          # 二次量化，再省一点
)
```

| 量化类型 | 显存 | 精度损失 | 推荐 |
| --- | --- | --- | --- |
| fp16 / bf16 | 2 byte/param | 0 | 默认 |
| 8-bit (`load_in_8bit`) | 1 byte | 极小 | 中规模显存 |
| **4-bit nf4** | 0.5 byte | < 1% perplexity | **QLoRA 标配** |
| 4-bit fp4 | 0.5 byte | 略大 | 不如 nf4 |

实测：QLoRA（nf4）vs LoRA（fp16）训练效果差距 < 1%，显存省 60-70%。**没理由不用**。

## 3. 推理时量化路线

| 方案 | 比特 | 速度 | 精度 | 平台 | 何时用 |
| --- | --- | --- | --- | --- | --- |
| **GPTQ** | 4 / 3 | 快 | -1 ~ -3% | GPU | vLLM / TGI |
| **AWQ** | 4 | 极快 | 接近 GPTQ | GPU | vLLM / autoawq |
| **GGUF**（k-quant） | 2-8（多档） | 灵活 | 看档位 | CPU / Mac / 移动 | llama.cpp / Ollama |
| **bnb (nf4 推理)** | 4 | 慢（不优化）| 同 QLoRA | GPU | 偷懒，生产慎用 |
| **fp8** | 8 | 极快 | 极小 | H100/H200 | 高端硬件 |
| **TensorRT-LLM int8/int4** | 4-8 | 极快 | 看 | NVIDIA GPU | 极致延迟 |
| **MLX 4/8-bit** | 4-8 | 看 | 看 | Apple Silicon | Mac 部署 |

经验默认：**vLLM 上线 → AWQ 4-bit；本地 / Mac → GGUF Q4_K_M。**

## 4. 转推理量化的命令

```bash
# AWQ（autoawq）
pip install autoawq
python -c "
from awq import AutoAWQForCausalLM
from transformers import AutoTokenizer
m = AutoAWQForCausalLM.from_pretrained('./merged-model', safetensors=True)
t = AutoTokenizer.from_pretrained('./merged-model', trust_remote_code=True)
m.quantize(t, quant_config={'zero_point':True,'q_group_size':128,'w_bit':4,'version':'GEMM'})
m.save_quantized('./merged-awq')
t.save_pretrained('./merged-awq')
"
```

```bash
# GPTQ（auto-gptq / gptqmodel）
pip install gptqmodel
gptqmodel quantize --model ./merged-model --output ./merged-gptq --bits 4
```

```bash
# GGUF（llama.cpp）
git clone https://github.com/ggerganov/llama.cpp && cd llama.cpp
python convert_hf_to_gguf.py ../merged-model --outfile model.f16.gguf
./llama-quantize model.f16.gguf model.q4_k_m.gguf q4_k_m
```

## 5. 量化对效果的实证

| 模型 | 方案 | MMLU Δ | 速度 ↑ | 显存 ↓ |
| --- | --- | --- | --- | --- |
| Llama-3-8B fp16 → AWQ-4 | -1.0% | 2.5x | -70% |
| Llama-3-8B fp16 → GPTQ-4 | -1.5% | 2.3x | -70% |
| Llama-3-8B fp16 → GGUF Q4_K_M | -1.5% | 取决于硬件 | -70% |
| Qwen2.5-7B → AWQ-4 | -0.5 ~ -1.5% | 2x | -70% |
| 70B → AWQ-4 | -0.3 ~ -1% | 2x | -70% |
| 任意 → GGUF Q2_K | -10% 以上 | 极快 | 极省 | 不推荐 |

> 越大的模型越抗量化。70B 4-bit ≈ 13B fp16 效果。

## 6. 量化模型必须重新评测

量化后**绝不能**只跑一次小样本就上线。

| 必跑 | 备注 |
| --- | --- |
| Domain eval（自家） | 量化前后 acc Δ |
| MMLU / 通用 | 衰减是否可接受 |
| 长上下文测试 | 量化对长序列影响更大 |
| 边界 case / 安全 | 量化偶尔放大不安全输出 |
| 延迟 / 吞吐 benchmark | 兑现速度承诺 |

详见 [07 · 评测](./07-evaluation.md)。

```python
# 简单速度对比
import time, torch
from vllm import LLM, SamplingParams

for path in ["./merged-model", "./merged-awq"]:
    llm = LLM(model=path, quantization=None if "awq" not in path else "awq")
    sp = SamplingParams(temperature=0, max_tokens=256)
    prompts = ["你好，请介绍一下杭州。"] * 32
    t0 = time.time(); llm.generate(prompts, sp); dt = time.time()-t0
    print(path, f"{32*256/dt:.0f} tok/s")
    del llm; torch.cuda.empty_cache()
```

## 7. 何时量化得不偿失

| 场景 | 建议 |
| --- | --- |
| 模型 < 7B | 量化收益小，fp16 直接上 |
| 长上下文（≥ 32k） | KV cache 量化更要紧（fp8 / int8 KV） |
| 评测掉 > 5% | 换更高比特或不量化 |
| 极致正确性（医疗 / 金融严格输出） | 慎用，至少 8-bit |
| 已经 H100 充足 | 量化不一定更快（fp8 已够） |

## 8. KV cache 量化（推理侧重要）

模型权重量化只解决"加载显存"。**长上下文的真正大头是 KV cache**：

```text
KV cache 显存 ≈ 2 × n_layer × n_head × head_dim × seq_len × bytes/elem
70B + 32k context + bs 8  ≈  数十 GB
```

| KV 量化 | 引擎支持 | 收益 |
| --- | --- | --- |
| fp8 KV | vLLM、TensorRT-LLM | -50% |
| int8 KV | vLLM | -50% |
| int4 KV | 实验性 | -75%，精度风险 |

vLLM 启动：`--kv-cache-dtype fp8`。

## 9. 与 llm-inference 主题的边界

| 内容 | 本章 | llm-inference（即将） |
| --- | --- | --- |
| QLoRA 训练量化 | 重点 | 简提 |
| 4-bit / GPTQ / AWQ 概念 | 速览 | 深入 |
| KV cache 量化 | 简提 | 深入 |
| Speculative decoding / vLLM 调优 | 不讲 | 重点 |
| 多 LoRA 推理工程 | 简提（[09](./09-deployment.md)） | 重点 |

## 10. 量化决策表

| 你的需求 | 推荐 |
| --- | --- |
| 训练时显存不够 | QLoRA（nf4）+ paged_adamw_8bit |
| GPU 推理 + 高 QPS | AWQ 4-bit + vLLM |
| GPU 推理 + 想要稳 | GPTQ 4-bit 或 fp8（H100） |
| Mac 本地 | GGUF Q4_K_M / Q5_K_M |
| 移动端 / 嵌入式 | GGUF Q4_0 / 更激进 |
| 极端低延迟 + 顶级硬件 | TensorRT-LLM int8 / fp8 |

## 常见坑

1. **QLoRA 直接保存当推理用**：不优化的 4-bit 推理慢得感人。要么合并到 fp16 再 AWQ，要么部署时换 vLLM/TGI 的 AWQ/GPTQ。
2. **合并 QLoRA 不 dequant 直接保存**：保存的就是 4-bit 形态，进 AWQ 量化又掉一次精度。先 dequant 到 bf16，再合并、再量化。
3. **量化后没重测就上线**：在 100 条玩具样本上没差，业务上线某些边缘 case 全错。必须跑全套 eval。
4. **盲目追低比特**：Q2_K_M 看着省，效果掉得吓人。`Q4_K_M` 是 GGUF 的甜蜜点。
5. **忽视 KV cache**：长 context 服务时 KV 量化比权重量化更重要，没人提醒就一直忽略。

## 下一步

- 训练时 4-bit 实操：[04 · PEFT](./04-peft.md)
- 量化后评测必做：[07 · 评测](./07-evaluation.md)
- 量化 → 部署：[09 · 部署微调模型](./09-deployment.md)
- 案例端到端：[10 · 案例](./10-case-study.md)
