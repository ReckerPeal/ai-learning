# 03 · vLLM 实战

vLLM 是当下自部署 LLM 的**事实标准**。本章给的不是文档复读，是踩过的配置和参数解释。

## 1. 安装

### 1.1 推荐路径

```bash
# 最稳：CUDA 12.1+ / PyTorch 2.4+ / Python 3.10-3.12 / Linux
pip install vllm

# Docker（生产推荐）
docker pull vllm/vllm-openai:latest
```

### 1.2 平台兼容

| 平台              | 支持           | 备注                                |
| --------------- | ------------ | --------------------------------- |
| Linux + NVIDIA  | ✅ 一等公民       | 这是 vLLM 主力路径                      |
| Linux + AMD ROCm | ✅            | 走 `vllm-rocm` build               |
| WSL2 + NVIDIA   | ✅            | 但显存有 overhead                     |
| Mac M 系列        | ❌            | 用 llama.cpp / Ollama              |
| Windows native  | ❌            | 用 WSL2                            |
| Linux + CPU     | 实验性          | 性能不行，仅测试用                         |
| TPU             | ✅            | `vllm-tpu` build                  |

## 2. 最小启动命令

```bash
python -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen2.5-7B-Instruct \
  --port 8000
```

启动后：
- `http://localhost:8000/v1/chat/completions` — OpenAI 格式 chat
- `http://localhost:8000/v1/completions` — OpenAI 格式 completion
- `http://localhost:8000/v1/models` — 列出 model id
- `http://localhost:8000/metrics` — Prometheus metrics
- `http://localhost:8000/health` — k8s 探针用

## 3. 核心启动参数

按重要度排序：

### 3.1 模型与基本配置

| 参数                               | 作用                          | 推荐值                              |
| -------------------------------- | --------------------------- | ------------------------------- |
| `--model`                        | HF 模型 id 或本地路径              | `Qwen/Qwen2.5-7B-Instruct`      |
| `--served-model-name`            | API 中暴露的 model 名（可与 hub 名不同） | 业务友好名，如 `qwen2.5-7b`            |
| `--tokenizer`                    | 单独指定 tokenizer              | 默认与 model 同                     |
| `--trust-remote-code`            | 允许跑 model repo 自带代码         | 国产模型常需开                         |
| `--dtype`                        | 权重精度                        | `auto`（默认 BF16），H100 可用 `bfloat16` |
| `--seed`                         | 随机种子                        | 有需要复现时设                         |

### 3.2 显存与 KV cache

| 参数                         | 作用                                | 推荐值                              |
| -------------------------- | --------------------------------- | ------------------------------- |
| `--gpu-memory-utilization` | 用多少 GPU 显存（0-1）                   | `0.9`（默认），共享卡降到 `0.5-0.7`       |
| `--max-model-len`          | 最大 context（含 prompt + output）     | 业务需求，越大 KV 越占                   |
| `--max-num-seqs`           | 同时跑的最多请求数                        | 默认 256，按 KV 算实际能放多少              |
| `--max-num-batched-tokens` | 一个 step 处理的最大 token 数             | 默认 = max_model_len，长 prompt 时调高 |
| `--block-size`             | KV cache block 大小（token）          | 16（默认），不要乱改                     |
| `--swap-space`             | CPU swap KV 大小（GB），换页用            | 4 GB（默认）                        |
| `--kv-cache-dtype`         | KV cache 精度                       | `auto` / `fp8` / `fp8_e5m2`     |

### 3.3 多 GPU

| 参数                            | 作用                | 备注                      |
| ----------------------------- | ----------------- | ----------------------- |
| `--tensor-parallel-size`      | TP 大小             | 单机多卡，要 NVLink           |
| `--pipeline-parallel-size`    | PP 大小             | 跨节点 / 极大模型              |
| `--distributed-executor-backend` | `mp` / `ray`     | 默认 `mp`，跨节点用 `ray`      |

### 3.4 量化

| 参数              | 作用             | 取值                                          |
| --------------- | -------------- | ------------------------------------------- |
| `--quantization` | 量化方式           | `awq` / `gptq` / `fp8` / `bitsandbytes` / `marlin` |
| `--load-format`  | 权重格式           | 一般 `auto`，sharded 用 `safetensors`           |

### 3.5 性能优化开关

| 参数                            | 作用                          | 推荐                  |
| ----------------------------- | --------------------------- | ------------------- |
| `--enable-prefix-caching`     | 开启 prefix cache             | **生产强烈推荐开**         |
| `--enable-chunked-prefill`    | 长 prompt 切片                 | **生产强烈推荐开**（默认开）    |
| `--speculative-model`         | 草稿模型                        | 见 [§07](./07-decoding.md) |
| `--num-speculative-tokens`    | 草稿一次出几个                     | 4-8                 |
| `--enable-lora`               | 多 LoRA 支持                   | 业务需要时               |
| `--max-lora-rank`             | 最大 LoRA rank                | 默认 16，按训练时设         |
| `--max-loras`                 | 同时加载几个 LoRA                 | 8-16                |

### 3.6 API 与多租户

| 参数                  | 作用                     |
| ------------------- | ---------------------- |
| `--api-key`         | 简单 API key 鉴权（生产应在 LB 层）   |
| `--allowed-origins` | CORS                   |
| `--ssl-keyfile`     | TLS                    |
| `--root-path`       | 反代 path 前缀（如 `/llm`）   |
| `--disable-log-requests` | 不记录每个请求（生产高 QPS 时关）  |

## 4. 生产推荐配置

### 4.1 单卡 7B（A10 / 4090 / L40）

```bash
python -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen2.5-7B-Instruct \
  --served-model-name qwen2.5-7b \
  --port 8000 \
  --gpu-memory-utilization 0.9 \
  --max-model-len 8192 \
  --max-num-seqs 128 \
  --enable-prefix-caching \
  --enable-chunked-prefill \
  --disable-log-requests
```

### 4.2 单机多卡 70B（4×A100 80GB / 4×H100）

```bash
python -m vllm.entrypoints.openai.api_server \
  --model meta-llama/Llama-3.1-70B-Instruct \
  --tensor-parallel-size 4 \
  --port 8000 \
  --gpu-memory-utilization 0.92 \
  --max-model-len 8192 \
  --max-num-seqs 64 \
  --enable-prefix-caching \
  --kv-cache-dtype fp8
```

### 4.3 量化模型（24GB 卡跑 14B）

```bash
python -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen2.5-14B-Instruct-AWQ \
  --quantization awq \
  --port 8000 \
  --gpu-memory-utilization 0.9 \
  --max-model-len 8192 \
  --enable-prefix-caching
```

### 4.4 Docker compose 模板

```yaml
version: "3.9"
services:
  vllm:
    image: vllm/vllm-openai:latest
    runtime: nvidia
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
    ports:
      - "8000:8000"
    volumes:
      - ~/.cache/huggingface:/root/.cache/huggingface
    environment:
      - HUGGING_FACE_HUB_TOKEN=${HF_TOKEN}
      - VLLM_LOGGING_LEVEL=INFO
    ipc: host
    command: >
      --model Qwen/Qwen2.5-7B-Instruct
      --served-model-name qwen2.5-7b
      --gpu-memory-utilization 0.9
      --max-model-len 8192
      --enable-prefix-caching
```

## 5. 客户端调用

### 5.1 OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(base_url="http://vllm:8000/v1", api_key="not-needed")

# 普通
resp = client.chat.completions.create(
    model="qwen2.5-7b",
    messages=[{"role": "user", "content": "你好"}],
    max_tokens=200,
)

# 流式
stream = client.chat.completions.create(
    model="qwen2.5-7b",
    messages=[{"role": "user", "content": "写一段诗"}],
    stream=True,
)
for chunk in stream:
    delta = chunk.choices[0].delta.content
    if delta:
        print(delta, end="", flush=True)

# 结构化输出（vLLM 支持 json schema）
resp = client.chat.completions.create(
    model="qwen2.5-7b",
    messages=[{"role": "user", "content": "解析这条订单：USR123 买了 3 个 iPhone"}],
    extra_body={
        "guided_json": {
            "type": "object",
            "properties": {
                "user_id": {"type": "string"},
                "product": {"type": "string"},
                "qty": {"type": "integer"},
            },
            "required": ["user_id", "product", "qty"],
        }
    },
)
```

### 5.2 LangChain / LangGraph

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    base_url="http://vllm:8000/v1",
    api_key="not-needed",
    model="qwen2.5-7b",
    temperature=0.3,
)
# 之后所有 LangChain / LangGraph 应用照常用，参考 ../langgraph/05-tools-and-agents.md
```

## 6. Metrics 监控

vLLM 暴露的 Prometheus metrics（部分）：

| metric                                | 说明                  |
| ------------------------------------- | ------------------- |
| `vllm:num_requests_running`           | 当前并发                |
| `vllm:num_requests_waiting`           | 排队中（红灯指标）           |
| `vllm:gpu_cache_usage_perc`           | KV cache 占用率        |
| `vllm:time_to_first_token_seconds`    | TTFT histogram      |
| `vllm:time_per_output_token_seconds`  | TBT histogram       |
| `vllm:e2e_request_latency_seconds`    | 端到端延迟               |
| `vllm:prompt_tokens_total`            | 累计 prompt token     |
| `vllm:generation_tokens_total`        | 累计 output token     |
| `vllm:request_success_total`          | 成功请求数               |
| `vllm:request_failure_total`          | 失败数                 |

Grafana 面板要先看的三张图：
1. `num_requests_waiting` 是否长期 > 0（容量不够）
2. `gpu_cache_usage_perc` 是否长期 > 0.95（KV 满）
3. TTFT p95（用户感知）

详 [08 · 性能基准与调优](./08-benchmarking.md) 和 [09 · 推理服务架构](./09-architecture.md)。

## 7. 多 LoRA 服务

在一个 base 模型上挂多个 LoRA，按请求路由到不同 LoRA：

```bash
python -m vllm.entrypoints.openai.api_server \
  --model meta-llama/Llama-3.1-8B-Instruct \
  --enable-lora \
  --max-loras 4 \
  --max-lora-rank 16 \
  --lora-modules \
    sql-bot=/lora/sql-bot \
    customer-support=/lora/cs-bot
```

调用时指定 `model="sql-bot"`：

```python
client.chat.completions.create(
    model="sql-bot",   # ← LoRA 名
    messages=[{"role": "user", "content": "查上周销售额"}],
)
```

省钱原理：100 个细分场景 → 1 个 base 模型 + 100 个 LoRA（每个几十 MB）→ 少买几十张卡。LoRA 训练见 [../fine-tuning/](../fine-tuning/)。

## 8. AWQ / GPTQ / FP8 加载

### 8.1 加载现成量化模型

```bash
# AWQ（最常见的 4-bit）
--model Qwen/Qwen2.5-7B-Instruct-AWQ --quantization awq

# GPTQ
--model TheBloke/Llama-2-7B-Chat-GPTQ --quantization gptq

# FP8（H100 / Ada Lovelace）
--model neuralmagic/Meta-Llama-3-8B-Instruct-FP8 --quantization fp8

# Marlin（GPTQ kernels 加速版，性能更好）
--model TheBloke/...-GPTQ --quantization marlin
```

### 8.2 KV cache 量化（FP8 KV）

不动权重，只把 KV cache 存 FP8。**显存省一半，精度几乎不掉**。H100 / Ada Lovelace 强烈推荐：

```bash
--kv-cache-dtype fp8
# 或显式：fp8_e5m2 / fp8_e4m3
```

详 [04 · 量化](./04-quantization.md)。

## 9. 与 TGI / SGLang 对比

| 维度          | vLLM                | TGI                 | SGLang             |
| ----------- | ------------------- | ------------------- | ------------------ |
| 主语言         | Python + CUDA       | Rust + Py           | Python + CUDA      |
| API         | OpenAI 兼容           | 自家 + OpenAI         | 自家 + OpenAI        |
| Continuous batching | ✓             | ✓                   | ✓                  |
| PagedAttention | ✓（首创）            | ✓（叫 paged）          | ✓                  |
| Prefix cache | ✓                   | 部分                  | ✓（RadixAttention，最强） |
| Speculative | ✓                   | ✓                   | ✓                  |
| Structured output | ✓ guided      | ✓                   | ✓（最早原生）            |
| LoRA serving | ✓                   | ✓                   | 部分                 |
| 多模态         | ✓（VLM）              | ✓                   | ✓                  |
| 企业支持        | 社区 + Anyscale       | HuggingFace 商业      | 社区                 |
| 上手          | 中                   | 中                   | 略陡                 |

迁移成本：vLLM ↔ TGI 几乎是改启动命令；切到 SGLang 要改 prompt 编排代码。

## 10. 常见错误诊断

| 报错 / 现象                                         | 原因 / 排查                                                  |
| ----------------------------------------------- | -------------------------------------------------------- |
| `CUDA out of memory` 启动时                        | 调低 `--gpu-memory-utilization` / 减 `--max-model-len`       |
| 启动卡 1-3 分钟没反应                                   | 大模型在 load，正常。70B 第一次 load 3+ 分钟                          |
| `RuntimeError: GET was unable to find an engine` | CUDA 版本和 PyTorch 不匹配                                     |
| `model_max_length` 超了                           | tokenizer 配置问题，加 `--max-model-len 显式设`                   |
| 推理结果乱码                                          | tokenizer 不对（HF 模型有时 tokenizer 在另一个 repo）                |
| TP=4 启动卡死                                       | NCCL 问题：`export NCCL_DEBUG=INFO` 看，常见是 IB 没起               |
| TTFT 突然变高                                       | 看 `gpu_cache_usage_perc`，KV 满了开始 swap                    |
| Prefix cache 没生效                                | 加 `--enable-prefix-caching`，重复 prefix ≥ block_size（16）才共享 |
| 每次第一个请求超慢                                       | CUDA graph capture，正常预热行为，第二个开始正常                       |
| 量化模型加载报 "kernel not found"                       | 卡架构太旧（如 V100 不支持 Marlin），换 quantization 或换卡             |

## 常见坑

1. **不开 `--enable-prefix-caching` 上生产**——agent / chatbot 系统提示几千 token，不开等于每个请求白跑一遍 prefill。开了立刻省钱。
2. **`--max-model-len` 设太大**——KV cache = max_len × num_seqs × per_token。设 128K 你只能服务 1-2 并发。按业务真实需求设，留点余量。
3. **`--gpu-memory-utilization 1.0`**——OOM 概率大。0.9 是合理上限。
4. **生产开 `--disable-log-requests` 没设**——高 QPS 下日志写穿磁盘。
5. **拿 vLLM 离线 batch 当 serving**——`LLM(...)` Python API 是离线模式，没 HTTP server。生产用 `vllm.entrypoints.openai.api_server`。
6. **量化模型 + LoRA 期望叠加**——多数量化模型不支持 LoRA hot swap。要 LoRA 就用 FP16 base。
7. **以为 `--served-model-name` 改了模型 id 就 OK**——LangChain 配置里也得改成同一个名字，否则模型路由 404。

## 下一步

- 选 / 做量化模型 → [04 · 量化](./04-quantization.md)
- 多卡跑大模型 → [05 · 多 GPU 调度](./05-multi-gpu.md)
- 配 LoRA 训完再 serve → [../fine-tuning/](../fine-tuning/)
- 性能调优 → [08 · 性能基准与调优](./08-benchmarking.md)
- 上层 agent → [../langgraph/05-tools-and-agents.md](../langgraph/05-tools-and-agents.md)
- vLLM 文档 → <https://docs.vllm.ai>
