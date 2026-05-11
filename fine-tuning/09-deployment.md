# 09 · 部署微调模型

> 训完不部署等于零。本章给从权重合并到上线监控的完整路径，重点：合并、格式转换、推理引擎、多 LoRA、监控。

## 1. 部署路径选择

| 路径 | 引擎 | 量化 | 何时 |
| --- | --- | --- | --- |
| **vLLM**（推荐 GPU） | vLLM | AWQ / GPTQ / fp8 | 标准生产 |
| **TGI** | HF Text-Generation-Inference | 同 | HF 生态 |
| **SGLang** | SGLang | 同 | 高级路由 / multi-modal |
| **TensorRT-LLM** | NVIDIA | int4/8 / fp8 | 极致延迟 |
| **llama.cpp / Ollama** | llama.cpp | GGUF | CPU / Mac / 私有部署 |
| **LMDeploy** | MMRazor | AWQ / W4A16 | 国产 / 商汤生态 |
| **MLX** | Apple | mlx q4/q8 | Mac M 系列 |

> 起手默认：**vLLM + AWQ**。私有 / Mac 走 GGUF。

## 2. 合并 LoRA 权重

```python
# 标准合并：LoRA → 完整权重
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel

BASE = "Qwen/Qwen2.5-7B-Instruct"
LORA = "./qlora-out/final"
OUT = "./merged-model"

# QLoRA 必须先 dequant，不要再开 4bit 加载
base = AutoModelForCausalLM.from_pretrained(BASE, torch_dtype=torch.bfloat16, device_map="cpu")
peft = PeftModel.from_pretrained(base, LORA)
merged = peft.merge_and_unload()

merged.save_pretrained(OUT, safe_serialization=True)
AutoTokenizer.from_pretrained(BASE).save_pretrained(OUT)
print("done")
```

| 注意 | 解释 |
| --- | --- |
| QLoRA 合并要 dequant 到 bf16 | 否则精度损失叠加 |
| `safe_serialization=True` | safetensors 比 pytorch_model.bin 更快/安全 |
| `device_map="cpu"` 合并 | 显存够才放 GPU；7B + LoRA 合并 32GB CPU 内存够用 |

合并后**必跑评测**。Δ 基本应为 0；不为 0 说明合并出错。

## 3. 格式转换

| 目标格式 | 工具 | 命令 |
| --- | --- | --- |
| HF safetensors | 默认 | `save_pretrained` |
| **GGUF** | llama.cpp | `convert_hf_to_gguf.py` + `llama-quantize` |
| **AWQ** | autoawq | 见 [§08](./08-quantization.md) |
| **GPTQ** | gptqmodel / autogptq | 同上 |
| **TensorRT-LLM** | trtllm-build | 较复杂，看官方文档 |
| **MLX** | mlx_lm | `mlx_lm.convert --hf-path ./merged --quantize -q 4` |
| **ONNX** | optimum | `optimum-cli export onnx ...` |

## 4. vLLM 部署（最常用）

```bash
pip install vllm

# 直接用 fp16 / bf16
vllm serve ./merged-model \
  --port 8000 --host 0.0.0.0 \
  --tensor-parallel-size 1 \
  --max-model-len 8192 \
  --gpu-memory-utilization 0.9 \
  --served-model-name my-ft-7b

# AWQ 量化
vllm serve ./merged-awq \
  --quantization awq --max-model-len 8192

# 多 LoRA
vllm serve Qwen/Qwen2.5-7B-Instruct \
  --enable-lora --max-loras 4 --max-lora-rank 32 \
  --lora-modules intent=./qlora-out/final copy=./copy-lora
```

OpenAI 兼容协议，调用方式：

```python
from openai import OpenAI
cli = OpenAI(base_url="http://localhost:8000/v1", api_key="sk-x")
r = cli.chat.completions.create(
    model="my-ft-7b",     # 单模型
    # model="intent",     # 多 LoRA 时按 lora-modules 名字选
    messages=[{"role": "user", "content": "申请退款"}],
)
print(r.choices[0].message.content)
```

| vLLM 关键参数 | 作用 |
| --- | --- |
| `--tensor-parallel-size N` | 多卡张量并行 |
| `--max-model-len` | 上下文长度（影响 KV cache） |
| `--gpu-memory-utilization` | 占多少显存（0.85-0.95） |
| `--kv-cache-dtype fp8` | KV cache 量化 |
| `--enable-prefix-caching` | 系统 prompt 复用，明显加速 |
| `--enable-chunked-prefill` | 长上下文吞吐 |
| `--quantization awq/gptq/fp8` | 推理量化 |

## 5. Ollama / llama.cpp（本地 / Mac）

```bash
# 转 GGUF（见 §08）
# 创建 Modelfile
cat > Modelfile <<'EOF'
FROM ./merged.q4_k_m.gguf
TEMPLATE """<|im_start|>system
{{ .System }}<|im_end|>
<|im_start|>user
{{ .Prompt }}<|im_end|>
<|im_start|>assistant
"""
PARAMETER stop "<|im_end|>"
PARAMETER temperature 0.7
EOF

ollama create my-ft -f Modelfile
ollama run my-ft "申请退款"
```

| 适合 | 不适合 |
| --- | --- |
| 私有部署 / 离线 | 高 QPS（单进程串行） |
| Mac Apple Silicon | 多卡集群 |
| 演示 / Demo | 大上下文（KV 实现弱） |

## 6. 多 LoRA 共享 base 部署

| 引擎 | 多 LoRA |
| --- | --- |
| **vLLM** | 原生支持，`--enable-lora`，请求带 `model=<lora_name>` |
| **TGI** | `--lora-adapters` |
| **LoRAX**（Predibase） | 专门做这个，热加载 |
| **SGLang** | 支持 |

```python
# vLLM 多 LoRA：一份 base + 多份 adapter，按请求切
# 启动见 §4
# 请求时 model= 各 adapter 名

cli.chat.completions.create(model="intent", messages=[...])  # 走意图 LoRA
cli.chat.completions.create(model="copy",   messages=[...])  # 走文案 LoRA
```

收益：
- 显存：1×base + N×adapter（vs N×完整模型）
- 切换：几乎 0 开销
- 适合：N 个相关任务同 base，QPS 中等

## 7. API 兼容（OpenAI 协议）

vLLM / TGI / Ollama / LMDeploy 都默认提供 OpenAI 兼容 API。前端 / Agent 框架（[../langchain/](../langchain/README.md)、[../langgraph/](../langgraph/README.md)）几乎不用改代码：

```python
from openai import OpenAI
# 切到自家服务
cli = OpenAI(base_url="http://my-host:8000/v1", api_key="x")
```

| 接口 | 兼容 |
| --- | --- |
| `/v1/chat/completions` | 是 |
| `/v1/completions` | 是 |
| `/v1/embeddings` | 部分（看模型类型） |
| Tool calling（function call） | 是（vLLM 0.5+, TGI 较新） |
| Streaming（SSE） | 是 |

## 8. 监控（必做）

| 维度 | 指标 | 怎么取 |
| --- | --- | --- |
| Latency | TTFT、TPOT、p50/p99 | vLLM `/metrics` Prometheus |
| Throughput | tokens/s、requests/s | 同上 |
| 错误率 | 5xx / 超时 | 网关层 |
| 输出质量 | LLM-judge 抽样 / 业务指标 | 自建 pipeline |
| Quality drift | 与 ft 时 eval 对比 | 定期回归 |
| GPU | 利用率 / 显存 / 温度 | nvidia-smi / dcgm-exporter |
| 安全 | 不当输出比例 | 审核模型 |

```yaml
# Prometheus scrape vLLM
scrape_configs:
  - job_name: vllm
    static_configs:
      - targets: ["vllm-host:8000"]
    metrics_path: /metrics
```

详见 [../eval/](../eval/README.md) 的 online eval 部分。

## 9. 灰度 / 回滚策略

| 策略 | 适用 |
| --- | --- |
| 流量分桶（5% → 50% → 100%） | 通用 |
| 影子流量（双发，仅记录） | 风险高的业务 |
| 用户 ID Hash 灰度 | 一致性体验 |
| Feature flag | 快速回滚 |
| Auto rollback | 错误率超阈值自动切回上版本 |

```python
# 一个最简流量切分（Python 网关）
import hashlib
def pick_model(user_id: str) -> str:
    h = int(hashlib.md5(user_id.encode()).hexdigest(), 16) % 100
    return "ft-v2" if h < 10 else "ft-v1"   # 10% 灰度
```

## 10. 部署 checklist

| 项 | 必做 |
| --- | --- |
| 合并 LoRA 后 eval 与训练时一致 | 是 |
| 量化后 eval（包含通用能力） | 是 |
| chat template 推理时和训练时完全一致 | 是 |
| 上下文长度配齐（KV / vLLM max_model_len） | 是 |
| Stop tokens 配齐（防复读不停） | 是 |
| 监控 + 告警上线前就跑通 | 是 |
| 灰度路径 + 一键回滚 | 是 |
| Rate limit / cost guard | 是 |
| 安全审核（输入 / 输出双侧） | 是 |
| 文档 + on-call runbook | 是 |

## 11. 与 llm-inference 主题的边界

| 内容 | 本章 | llm-inference（即将） |
| --- | --- | --- |
| 微调模型部署路径 | 重点 | 提及 |
| vLLM / TGI 详细调优 | 简介 | 重点 |
| Speculative decoding / 推测解码 | 不讲 | 重点 |
| 推理调度 / continuous batching | 简介 | 重点 |
| GPU 选型 / 成本核算 | 不讲 | 重点 |

## 常见坑

1. **chat template 推理时和训练时不一致**：训练 ChatML，推理 vLLM 默认走别的，输出全乱。在 vLLM 启动加 `--chat-template ./chat_template.jinja`，或确认 tokenizer.chat_template 已被保存。
2. **stop tokens 漏配**：模型不会停，输出到 max_tokens 还在复读。把 `<|im_end|>` 等加进 SamplingParams.stop。
3. **合并后没 eval**：合并代码差一行，权重错了 0.1%，模型行为变得完全不可控。一定 base vs merged 跑 eval set。
4. **量化后只在 demo 数据上看**：上线后特定 case 全错。必跑完整 eval（[§07](./07-evaluation.md)）。
5. **没监控就上线**：模型可能默默退化（数据漂移、上游变化），等用户投诉才发现已晚。

## 下一步

- 量化路径：[08 · 量化](./08-quantization.md)
- 评测 / 监控指标：[07 · 评测](./07-evaluation.md) + [../eval/](../eval/README.md)
- 与 Agent 编排集成：[../langgraph/](../langgraph/README.md)、[../agents/](../agents/README.md)
- 端到端跑通：[10 · 案例](./10-case-study.md)
