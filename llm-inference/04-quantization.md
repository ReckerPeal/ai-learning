# 04 · 量化

量化干一件事：**把 FP16 权重 / 激活 / KV cache 压成更小的整数**。回报是显存省、decode 速度涨；代价是精度小幅损失。

本章只讲**推理时**量化。训练时量化（QLoRA 等）见 [../fine-tuning/08-quantization.md](../fine-tuning/08-quantization.md)。

## 1. 为什么要量化

```
7B FP16 = 7B × 2 byte = 14 GB
7B 4-bit = 7B × 0.5 byte = 3.5 GB
70B FP16 = 140 GB（4 卡 A100 80G 才能装）
70B 4-bit = 35 GB（单卡 A100 80G 装下）
```

三个收益：

| 收益       | 原因                                       | 实际幅度        |
| -------- | ---------------------------------------- | ----------- |
| 显存 ↓     | 权重 / KV 占字节少                             | 4-bit ≈ 1/4 |
| 速度 ↑     | decode 是 memory-bound，读字节少 = 快           | 1.5-2.5x    |
| 单卡能跑更大模型 | 14B 量化能塞进 24GB 卡                         | 直接放大可选模型库   |

代价：

| 代价         | 程度                                |
| ---------- | --------------------------------- |
| 精度损失       | 通用任务 1-3%，数学 / code 5-10%（依算法和模型） |
| 量化耗时       | 离线一次，几小时到一天                       |
| 框架支持碎片化    | 不是所有 quant 在所有引擎都跑                |
| 不能 LoRA 热加载 | 多数量化 backend 不支持                  |

## 2. 算法对比

### 2.1 主流算法

| 算法                | 量化对象       | 典型 bit | 量化时输入        | 速度    | 精度    | 谁在用                  |
| ----------------- | ---------- | ------ | ------------ | ----- | ----- | -------------------- |
| **GPTQ**          | 权重         | 4 / 8  | 校准数据 128 条   | 中     | 中     | TheBloke、auto-gptq   |
| **AWQ**           | 权重         | 4      | 校准数据 128 条   | 快     | 较高    | 阿里、Llama 官方推荐         |
| **GGUF (k-quant)** | 权重         | 2-8    | 不需要          | 中     | 中     | llama.cpp 生态         |
| **bitsandbytes (NF4)** | 权重    | 4      | 不需要          | 慢     | 中     | QLoRA 训练时用           |
| **FP8 (E4M3/E5M2)** | 权重 / 激活 / KV | 8     | 校准（or 不需要）   | 快     | 高     | H100、Ada、vLLM        |
| **SmoothQuant**   | 权重 + 激活    | 8      | 校准数据         | 较快    | 中     | TensorRT-LLM         |
| **Marlin**        | GPTQ kernels 加速 | 4 | 转化 GPTQ ckpt   | 极快    | 同 GPTQ | vLLM + Ampere/Hopper |
| **W8A8 INT8**     | 权重 + 激活 INT8 | 8     | 校准           | 中     | 中     | TensorRT-LLM         |

### 2.2 简单选择

```
H100 / L40S / Ada Lovelace 卡？
├─ 是 → FP8（最优精度 / 速度比）
└─ 否 → 看显存
        显存够 FP16？
        ├─ 够 → 不量化（FP16 / BF16）
        └─ 不够：
                NVIDIA Ampere/Turing → AWQ 或 GPTQ + Marlin
                Mac / CPU → GGUF Q4_K_M / Q5_K_M

要 KV cache 量化？
└─ H100：FP8 KV（vLLM `--kv-cache-dtype fp8`）几乎免费
```

## 3. 4-bit / 8-bit / FP8 选型

### 3.1 显存对照（7B 模型）

| 方案              | 权重     | 激活      | KV per token | 总（含 8K KV） |
| --------------- | ------ | ------- | ------------ | ---------- |
| FP16            | 14 GB  | FP16    | 128 KB       | ~16 GB     |
| INT8 W8A16      | 7 GB   | FP16    | 128 KB       | ~9 GB      |
| INT8 W8A8       | 7 GB   | INT8    | 128 KB       | ~9 GB      |
| AWQ / GPTQ 4-bit | 3.5 GB | FP16    | 128 KB       | ~5.5 GB    |
| FP8 E4M3        | 7 GB   | FP8     | 64 KB        | ~8 GB      |
| GGUF Q4_K_M     | ~4 GB  | FP16    | varies       | ~6 GB      |

### 3.2 精度对照（实证，参考公开 benchmark）

通用任务（MMLU / HellaSwag）平均掉点：

| 方案         | 掉点（Llama-3-70B） | 掉点（Qwen2.5-7B） |
| ---------- | --------------- | -------------- |
| BF16 baseline | 0           | 0              |
| FP8        | 0.1-0.5%        | 0.2-0.6%       |
| AWQ 4-bit  | 0.5-1.5%        | 1-2%           |
| GPTQ 4-bit | 0.7-2%          | 1-3%           |
| GGUF Q5_K_M | 0.3-1%        | 0.5-1.5%       |
| GGUF Q4_K_M | 0.7-2%        | 1-2.5%         |
| GGUF Q4_0  | 1-3%            | 2-4%           |
| GGUF Q3_K  | 3-6%            | 4-8%           |

数学 / Code（GSM8K / HumanEval）通常掉得更多（**1.5-2 倍**）：

| 任务         | FP16 | AWQ-4 | GPTQ-4 |
| ---------- | ---- | ----- | ------ |
| GSM8K      | 76%  | 73%   | 72%    |
| HumanEval  | 60%  | 56%   | 54%    |

**结论**：通用 chatbot AWQ 4-bit 几乎无感；如果是数学 / code / agent 这种多步推理，能不量化就不量化，要量化优先 FP8。

## 4. HuggingFace 上的量化模型

最快的路径不是自己量化，是直接拉别人量化好的。

| 来源                          | 风格           | 量化质量 |
| --------------------------- | ------------ | ---- |
| `TheBloke/...-AWQ`          | 历史悠久，Llama 系全 | 中-高  |
| `TheBloke/...-GPTQ`         | 同上           | 中    |
| 模型官方（Qwen / Llama / Mistral） | `-AWQ` `-FP8` 后缀 | 高 |
| `neuralmagic/...-FP8`       | FP8 专精        | 高    |
| `lmsys/...-AWQ`             | LLaMA 系       | 高    |

直接加载（vLLM）：

```bash
python -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen2.5-72B-Instruct-AWQ \
  --quantization awq \
  --tensor-parallel-size 2 \
  --gpu-memory-utilization 0.9
```

## 5. 自家量化命令

### 5.1 AWQ（autoawq）

```python
# pip install autoawq
from awq import AutoAWQForCausalLM
from transformers import AutoTokenizer

model_path = "Qwen/Qwen2.5-7B-Instruct"
quant_path = "./qwen2.5-7b-awq"

quant_config = {
    "zero_point": True,
    "q_group_size": 128,
    "w_bit": 4,
    "version": "GEMM",   # 或 "GEMV"，前者快
}

model = AutoAWQForCausalLM.from_pretrained(
    model_path, safetensors=True, device_map="auto"
)
tokenizer = AutoTokenizer.from_pretrained(model_path)

# 校准（必要！用业务相关数据，128 条够）
model.quantize(tokenizer, quant_config=quant_config)

model.save_quantized(quant_path)
tokenizer.save_pretrained(quant_path)
```

7B 模型在 A100 上量化大约 30-40 分钟。

### 5.2 GPTQ（auto-gptq）

```python
# pip install auto-gptq optimum
from auto_gptq import AutoGPTQForCausalLM, BaseQuantizeConfig
from transformers import AutoTokenizer

model_path = "Qwen/Qwen2.5-7B-Instruct"
quant_path = "./qwen2.5-7b-gptq"

quant_config = BaseQuantizeConfig(
    bits=4,
    group_size=128,
    desc_act=False,   # True 精度更好但加载更慢
)

tokenizer = AutoTokenizer.from_pretrained(model_path)
model = AutoGPTQForCausalLM.from_pretrained(model_path, quant_config)

# 校准数据
calib_data = [
    tokenizer("领域相关示例文本……", return_tensors="pt")
    for _ in range(128)
]

model.quantize(calib_data)
model.save_quantized(quant_path, use_safetensors=True)
```

### 5.3 FP8（llm-compressor，推荐）

```python
# pip install llmcompressor
from llmcompressor.transformers import oneshot
from llmcompressor.modifiers.quantization import QuantizationModifier

recipe = QuantizationModifier(
    targets="Linear",
    scheme="FP8_DYNAMIC",
    ignore=["lm_head"],
)

oneshot(
    model="Qwen/Qwen2.5-7B-Instruct",
    recipe=recipe,
    output_dir="./qwen2.5-7b-fp8",
)
```

FP8 dynamic 不需要校准数据（动态计算 scale），最简单。

### 5.4 GGUF（llama.cpp）

```bash
# 1. clone llama.cpp
git clone https://github.com/ggerganov/llama.cpp && cd llama.cpp && make

# 2. HF → GGUF（FP16 中间格式）
python convert_hf_to_gguf.py /path/to/qwen2.5-7b --outfile qwen2.5-7b-f16.gguf

# 3. 量化到 Q4_K_M
./llama-quantize qwen2.5-7b-f16.gguf qwen2.5-7b-q4_k_m.gguf Q4_K_M

# 常见量化级别（按精度由高到低）
# Q8_0 / Q6_K / Q5_K_M / Q4_K_M / Q4_0 / Q3_K_M / Q2_K
```

## 6. 推理时加载

### 6.1 vLLM

```bash
# AWQ
--model ./qwen2.5-7b-awq --quantization awq

# GPTQ（用 Marlin kernel 加速）
--model ./qwen2.5-7b-gptq --quantization marlin

# FP8
--model ./qwen2.5-7b-fp8 --quantization fp8

# KV cache 量化（独立于权重量化）
--kv-cache-dtype fp8
```

### 6.2 transformers + bitsandbytes

```python
from transformers import AutoModelForCausalLM, BitsAndBytesConfig

bnb_config = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_quant_type="nf4",
    bnb_4bit_compute_dtype="bfloat16",
    bnb_4bit_use_double_quant=True,
)

model = AutoModelForCausalLM.from_pretrained(
    "Qwen/Qwen2.5-7B-Instruct",
    quantization_config=bnb_config,
    device_map="auto",
)
```

注意：bitsandbytes 在 vLLM 里也支持，但**性能不如 AWQ/GPTQ**。bnb 主要用在训练（QLoRA）。

### 6.3 llama.cpp / Ollama

```bash
# llama.cpp 直接加载
./llama-server -m qwen2.5-7b-q4_k_m.gguf -c 8192 --port 8080

# Ollama
ollama create qwen2.5 -f Modelfile  # Modelfile 指向 GGUF
ollama run qwen2.5 "你好"
```

## 7. 量化对效果的实证

哪些任务最敏感：

| 任务类别                     | 敏感度  | 备注                              |
| ------------------------ | ---- | ------------------------------- |
| 多步推理（CoT 数学、planning）    | 高    | 误差累积，掉 5-10%                    |
| 代码生成（HumanEval、MBPP）     | 高    | 一个 token 错就编译不过                 |
| 工具调用 / JSON 输出            | 中-高  | 格式偏差变多                          |
| 阅读理解（SQuAD、HotpotQA）     | 中    | 短答案，掉 1-3%                      |
| 闲聊 / 简单问答                | 低    | 几乎无感                            |
| 翻译                       | 低-中  | BLEU 掉 1-2 分                    |
| 摘要                       | 低    | ROUGE 几乎不变                      |
| 嵌入 / classification      | 中    | 分类准确率掉 0.5-2%                   |

**实操建议**：上线前必须用 [../eval/](../eval/) 做 A/B（FP16 vs 量化），对你的真实业务任务量化收益要够。

## 8. 训练 vs 推理量化的边界

容易混淆的两套东西：

| 场景        | 用什么                    | 目的                  | 章节                                                            |
| --------- | ---------------------- | ------------------- | ------------------------------------------------------------- |
| 训练 / 微调   | QLoRA（bnb 4-bit + LoRA） | 用更少显存训得动 70B         | [../fine-tuning/08-quantization.md](../fine-tuning/08-quantization.md) |
| 推理 serving | AWQ / GPTQ / FP8       | 用更少显存 / 更快速度 serve  | 本章                                                            |

具体差别：
- QLoRA 量化的是 base，LoRA 是 FP16，最终 inference 时把 LoRA merge 回 FP16 才量化（或不量化）。
- AWQ / GPTQ 是 post-training quantization，对一个已经训完的模型一次性压缩。

不要搞混："我已经 QLoRA 训了，能直接 serve 吗" → 能，但用的是 bnb 4-bit，速度不如 AWQ。生产建议 merge LoRA → FP16 → AWQ 量化 → vLLM serve。

## 9. KV cache 量化（独立维度）

权重量化和 KV 量化**正交**，可以叠加：

| 配置                  | 显存占用                | 精度损失           |
| ------------------- | ------------------- | -------------- |
| FP16 + FP16 KV      | 基线                  | 0              |
| FP16 + FP8 KV       | KV 减半                | < 0.5%         |
| AWQ 4-bit + FP16 KV | 权重 1/4               | 1-2%           |
| AWQ 4-bit + FP8 KV  | 权重 1/4 + KV 减半       | 1.5-2.5%       |
| FP8 W + FP8 KV      | 权重减半 + KV 减半          | 0.3-1%（H100 推荐）|

vLLM 启用：

```bash
# 权重和 KV 都量化
--quantization fp8 --kv-cache-dtype fp8
```

## 10. 部署清单

量化模型上线前过一遍：

```yaml
checks:
  - 量化算法支持当前 GPU 架构（V100 不支持 Marlin / FP8）
  - 量化 model 在 HF 或本地路径，已下载完整
  - vLLM / TGI 版本支持该 quantization 选项
  - 校准数据是否代表业务（自己量化时）
  - eval 套件在 FP16 baseline 和量化版本上都跑过
  - 关键业务任务的精度损失在预算内（< X%）
  - benchmark 记录了 throughput / TTFT / TBT
  - 监控里能看出量化版本和 FP16 版本的差异（用于 A/B）
```

## 常见坑

1. **量化模型直接上线，不做 eval**——某次升级把 4-bit AWQ 换成 GGUF Q3_K，code 任务掉了 12%，业务投诉两周才发现。**任何量化变更都要过 [../eval/](../eval/)**。
2. **校准数据用通用语料，量化后业务效果差**——校准数据决定量化误差分布。用业务真实输入做校准（128 条就够），效果差距可达 2-3%。
3. **以为 4-bit 一定比 8-bit 快**——decode 是 memory-bound，4-bit 确实读字节少；但如果模型本来就放得下 8-bit 单卡，4-bit 多余的 dequant 计算可能反慢。
4. **GPTQ + desc_act=True 启动慢**——desc_act 加精度，但加载时要重排，启动多 30 秒-2 分钟。生产取舍。
5. **bnb 4-bit 拿来 serving**——bitsandbytes 是训练优化的，serving 性能比 AWQ 差 30-50%。serving 用 AWQ / GPTQ / FP8。
6. **FP8 跑在 Ampere（A100）**——FP8 硬件加速是 Hopper（H100）和 Ada Lovelace（L40S/4090）的特性。A100 上能跑但是用 emulation，没收益。
7. **量化完忘了重测 max_num_seqs**——量化后单请求显存少了，max_num_seqs 应该相应调高，否则没吃满 KV 容量。
8. **混用量化版本对外提供同一个 model name**——A 实例 AWQ、B 实例 GPTQ，同名服务，输出分布不一致，下游 eval 抓狂。一个 model name 对应一种量化。

## 下一步

- 量化好了用 vLLM serve → [03 · vLLM 实战](./03-vllm.md)
- 多卡跑 70B AWQ → [05 · 多 GPU 调度](./05-multi-gpu.md)
- 量化后 benchmark → [08 · 性能基准与调优](./08-benchmarking.md)
- 训练时量化（QLoRA） → [../fine-tuning/08-quantization.md](../fine-tuning/08-quantization.md)
- 量化对效果影响的评测方法 → [../eval/](../eval/)
- 论文：*GPTQ: Accurate Post-Training Quantization for Generative Pre-trained Transformers* — <https://arxiv.org/abs/2210.17323>
- 论文：*AWQ: Activation-aware Weight Quantization* — <https://arxiv.org/abs/2306.00978>
