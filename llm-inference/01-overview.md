# 01 · 推理引擎全景

裸 `transformers.generate()` 跑 7B 模型大概 20 tokens/s。同样硬件用 vLLM 能到 100-200 tokens/s，**5-10 倍**。这不是优化技巧的差距，是架构差距。

本章解决三个问题：
1. 为什么不能直接用 transformers。
2. 主流推理引擎各自的定位。
3. 给定场景怎么选。

## 1. 为什么不直接用 transformers

`transformers` 是训练 / 实验框架，不是推理引擎。它的默认行为对生产很不友好：

| 问题             | transformers 默认                  | 推理引擎做法                           |
| -------------- | -------------------------------- | -------------------------------- |
| KV cache       | per-request 独立分配，碎片严重            | PagedAttention，按 block 分页        |
| Batching       | 静态：等满 batch 才开跑，慢请求拖累快请求         | Continuous batching：每 step 重组    |
| Attention 实现   | 标准 PyTorch op                    | FlashAttention / 自家 CUDA kernel  |
| 多请求            | 串行（你得自己写 queue）                  | 内置调度器                            |
| API            | Python function call             | OpenAI-compatible HTTP / gRPC    |
| 多 GPU          | 你得手写 device_map / DeepSpeed      | `--tensor-parallel-size N` 一行    |
| 量化模型加载         | bitsandbytes、auto-gptq 各自一套      | 统一 `--quantization awq/gptq/fp8` |

一句话：`transformers` 适合 notebook，**生产请用推理引擎**。

> 例外：你只是离线跑 batch（比如标 100 万条数据），且不敏感于吞吐 → 直接 transformers + `pipeline` 也行。但同样数据量，vLLM offline batched inference 快 10 倍。

## 2. 主流引擎一览

| 引擎             | 维护方          | 语言     | 主打场景                    | 典型用户                |
| -------------- | ------------ | ------ | ----------------------- | ------------------- |
| vLLM           | UC Berkeley  | Py+CUDA | 生产 serving，最广泛          | 大多数自部署团队            |
| TGI            | HuggingFace  | Rust+Py | HuggingFace Hub 集成、企业支持 | HF Enterprise 客户    |
| SGLang         | LMSYS        | Py+CUDA | 复杂 prompt 编排、agent      | 研究、复杂 workflow      |
| TensorRT-LLM   | NVIDIA       | C++    | NVIDIA 卡极致性能            | 大厂、对延迟敏感的产品         |
| Llama.cpp      | ggerganov    | C++    | CPU / Mac / 边缘 / 量化     | 个人、嵌入式、Mac 用户       |
| Ollama         | Ollama Inc   | Go     | 一行命令本地体验，封装 llama.cpp   | 开发者笔记本、demo         |
| MLC-LLM        | MLC          | TVM    | 跨平台编译（iOS / WebGPU）     | 移动端、浏览器             |
| LMDeploy       | OpenMMLab    | Py+CUDA | 国产化场景、Qwen/InternLM 优化  | 国内团队                |
| DeepSpeed-MII  | Microsoft    | Py     | 与 DeepSpeed 训练栈打通       | 已用 DeepSpeed 的团队    |

### 2.1 选型矩阵

打分（5 分满）：

| 维度          | vLLM | TGI | SGLang | TRT-LLM | llama.cpp | Ollama |
| ----------- | ---- | --- | ------ | ------- | --------- | ------ |
| 吞吐（serving） | 5    | 4   | 5      | 5       | 2         | 2      |
| 延迟（首 token） | 4    | 4   | 4      | 5       | 3         | 3      |
| 易用性         | 4    | 4   | 3      | 2       | 4         | 5      |
| 模型支持广度      | 5    | 5   | 4      | 3       | 5         | 4      |
| 量化生态        | 4    | 4   | 4      | 3       | 5         | 5      |
| 多 GPU       | 5    | 4   | 5      | 5       | 2         | 1      |
| 多机          | 4    | 3   | 4      | 5       | 1         | 1      |
| 生产化（metrics / k8s） | 5    | 4   | 3      | 3       | 2         | 2      |
| 社区活跃度       | 5    | 4   | 4      | 3       | 5         | 5      |

**结论性建议**：
- 没特殊理由 → **vLLM**。这是 2024-2026 的事实标准。
- 已经买了 NVIDIA 企业支持、对 H100 极致延迟有要求 → **TensorRT-LLM**。
- HuggingFace Inference Endpoints 平移 → **TGI**。
- agent / 复杂 prompt 编排（结构化输出、prefix cache、并行 prompts）→ **SGLang**。
- Mac / 笔记本 / CPU only → **llama.cpp** 或 **Ollama**。
- iOS / 浏览器 → **MLC-LLM**。

## 3. 决策树

```
Q1: 在哪跑？
├─ Mac / 笔记本 / 边缘 → llama.cpp / Ollama → 跳到 Q4
├─ 浏览器 / iOS → MLC-LLM → 结束
└─ 服务器（NVIDIA GPU） → Q2

Q2: 模型多大？显存够不够？
├─ 7B  → 单卡 A10/4090（FP16 14GB） → vLLM 即可
├─ 14B → 单卡 A100 40GB / 4090 量化 → vLLM
├─ 70B → 多卡 A100/H100（4 卡 TP=4） → vLLM 或 TRT-LLM
└─ 405B+ → 多机多卡（8x8 H100） → TRT-LLM 或 vLLM 多节点

Q3: 要不要量化？
├─ 显存够、追求质量 → 不量化（FP16 / BF16）
├─ 显存不够、可接受微小精度损失 → AWQ / GPTQ 4-bit
├─ H100、追求极致速度 → FP8（W8A8）
└─ CPU / Mac → GGUF Q4_K_M / Q5_K_M

Q4: 工作负载？
├─ 高 QPS serving（>10 req/s） → vLLM continuous batching
├─ 长 context（>32K） → vLLM PagedAttention 或 SGLang
├─ 复杂 prompt（多次调用，前缀重复） → SGLang prefix cache
└─ 离线 batch（一次性几十万条） → vLLM offline mode
```

## 4. 自部署 vs 商业 API 的边界

不是所有场景都该自部署。决策矩阵：

| 场景                         | 商业 API | 自部署 | 理由                              |
| -------------------------- | ------ | --- | ------------------------------- |
| MVP / PoC                  | ✓      |     | 时间最重要，几美元就能验证                   |
| QPS 持续 < 1                 | ✓      |     | API 起步成本几乎为 0                   |
| QPS 持续 > 50（且模型可替代）        |        | ✓   | 自部署成本曲线开始反超                     |
| 需要 GPT-4 / Claude 级别智能     | ✓      |     | 没有可比的开源模型                       |
| 数据合规（医疗、政务、金融）             |        | ✓   | 数据不能出境 / 出企业                    |
| 微调专属模型                     |        | ✓   | API 微调贵，自部署 + LoRA 灵活           |
| 极低延迟（< 100ms TTFT）         |        | ✓   | API 网络往返就 50-200ms              |
| 嵌入式、离线                     |        | ✓   | 没网                              |
| 突发流量（峰谷 10 倍）              | ✓      |     | API 自动伸缩，自部署要么过配要么排队            |

详细经济模型见 [10 · 成本与延迟权衡](./10-cost-latency.md)。

## 5. 一个最小闭环

5 分钟从 0 跑通一个 vLLM serving，对照感受推理引擎是什么：

```bash
# 1. 安装（CUDA 12.1+, PyTorch 2.4+, Linux）
pip install vllm

# 2. 启 OpenAI-compatible server，加载 Qwen2.5-7B-Instruct
python -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen2.5-7B-Instruct \
  --port 8000 \
  --gpu-memory-utilization 0.9 \
  --max-model-len 8192

# 3. 用 curl 测（OpenAI 格式）
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen/Qwen2.5-7B-Instruct",
    "messages": [{"role":"user","content":"用一句话介绍 vLLM"}],
    "max_tokens": 100
  }'
```

或者用 Python OpenAI SDK：

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8000/v1", api_key="not-needed")

resp = client.chat.completions.create(
    model="Qwen/Qwen2.5-7B-Instruct",
    messages=[{"role": "user", "content": "用一句话介绍 vLLM"}],
    max_tokens=100,
)
print(resp.choices[0].message.content)
```

**关键观察**：你只需要把 LangChain / LangGraph 里 `OpenAI(base_url=...)` 切到这个地址，整套上层应用就接上自部署 backend 了。

## 6. 学习路径

**新人（一周内能用）**：
- §01（本章）选型 → §03 vLLM 跑通 → §10 算清成本。

**中级（理解原理）**：
- §02 关键概念 → §04 量化 → §08 benchmark。

**高级（生产团队）**：
- §05 多 GPU → §07 解码加速 → §09 服务架构 → §06 长上下文。

## 6.5 主流引擎背后的工程哲学

为什么有这么多引擎？因为它们在**不同维度做了不同取舍**：

| 引擎          | 优化重心                  | 取舍                            |
| ----------- | --------------------- | ----------------------------- |
| vLLM        | 吞吐 + 兼容广泛模型           | 不追求极限单流延迟、不追求最广泛硬件             |
| TGI         | HF 生态闭环、企业级稳定性        | 性能略落后 vLLM，但生产稳定记录更长          |
| SGLang      | 复杂 prompt 编排、prefix tree | 学习曲线陡，对 agent 场景碾压            |
| TensorRT-LLM | NVIDIA 卡极致延迟          | 闭源、模型支持窄、上手难                  |
| Llama.cpp   | 跨平台 + 量化              | NVIDIA 旗舰场景没优势                |
| Ollama      | 开发者体验                 | 不是 serving 框架                  |
| MLC-LLM     | 编译目标多（iOS / Web）      | 服务器场景不优                       |

理解了哲学，看到新引擎你也能秒判断它的目标用户。

## 6.6 推理引擎不能解决的问题

它们能让模型跑得快，但**这些事没人帮你**：

| 问题                          | 谁来解                                    |
| --------------------------- | -------------------------------------- |
| 模型选型（70B 还是 14B）            | 业务评测（[../eval/](../eval/)）              |
| Prompt 工程                   | 业务团队 / [../langchain/](../langchain/)  |
| RAG 检索质量                    | [../rag-advanced/](../rag-advanced/)   |
| Agent 行为正确性                  | [../agents/](../agents/)               |
| 数据合规                        | 法务 + 安全                                |
| 微调                          | [../fine-tuning/](../fine-tuning/)     |
| 业务级 SLA                     | 你自己                                    |

推理引擎是**底座**，不是银弹。

## 6.7 演进时间线（粗略，便于建立心智）

| 年份         | 关键事件                                                 |
| ---------- | ---------------------------------------------------- |
| 2022       | HuggingFace transformers 是大多数人推理路径，serving 慢          |
| 2022 末      | TGI 1.0 发布（HF 自家），算第一代生产推理引擎                          |
| 2023 中      | vLLM 论文 + 开源，PagedAttention 引爆，吞吐 5-10x              |
| 2023 末      | Llama.cpp 量化生态成熟，Mac 本地跑 7B 体验起飞                      |
| 2024 上      | SGLang / RadixAttention，agent 场景专精引擎崛起                |
| 2024 中      | FP8 / Marlin / Speculative 大规模生产化（vLLM、TRT-LLM）        |
| 2024 末      | Ollama 在开发者中流行，"本地 LLM" 体验门槛降到一行命令                   |
| 2025        | EAGLE-2、xgrammar 等次时代解码 / 结构化输出技术进入生产                |
| 2025 末-2026 | 长 context（1M）、MoE 模型（DeepSeek-V3）、推理引擎对应能力对齐         |

**结论**：这是个仍在快速演化的领域。**架构选型要可换**——不要把自己锁死在某个引擎的私有 API 上，OpenAI 兼容是事实标准。

## 7. 引擎之外：还要什么

推理引擎只是 stack 中的一层。完整的自部署 LLM 服务栈：

| 层                 | 选项                                  | 本主题章节            |
| ----------------- | ----------------------------------- | ---------------- |
| 模型权重              | HuggingFace Hub / 自家训练             | -                |
| 量化                | AWQ / GPTQ / FP8                    | §04              |
| 推理引擎              | vLLM / TGI / TRT-LLM                | §03              |
| 多 GPU 编排          | TP / PP / DP                        | §05              |
| 反向代理 / API gateway | nginx / Envoy / Kong              | §09              |
| 模型路由              | LiteLLM / Portkey / 自家             | §09              |
| 监控                | Prometheus + Grafana                | §08, §09         |
| 业务层（agent / RAG）  | LangChain / LangGraph / 自家         | [../langgraph/](../langgraph/) |
| 评测                | 离线评测 + 在线监控                         | [../eval/](../eval/) |

## 8. 跑通第一个 vLLM 之后该做什么

很多人卡在"我用 curl 测过了，然后呢"。下一步清单：

| 顺序 | 动作                                          | 目的                |
| -- | ------------------------------------------- | ----------------- |
| 1  | 用 OpenAI SDK 跑 5 个真实业务 prompt                 | 验证输出质量            |
| 2  | 把 base_url 接到现有 LangChain / LangGraph 应用    | 业务接通              |
| 3  | 在 Grafana 上抓 vLLM `/metrics`                  | 看到性能基线            |
| 4  | 跑 vLLM 自带 benchmark_serving               | 知道单实例容量          |
| 5  | 用 [../eval/](../eval/) 跑业务 eval                  | 验证开源模型够不够用       |
| 6  | 决定要不要量化                                     | 见 §04             |
| 7  | 写 docker-compose / k8s manifest               | 进入生产化             |
| 8  | 配 Nginx + 多副本                                | 进入 §09            |

到第 4 步你就有数据决定"要不要继续这条路"，而不是凭感觉。

## 9. 一份最小术语表

为后续章节备查：

| 术语           | 含义                                  | 出现章节            |
| ------------ | ----------------------------------- | --------------- |
| KV cache     | attention 中间结果缓存，推理主要显存大头           | §02 §06         |
| PagedAttention | 把 KV cache 按 block 分页管理            | §02 §06         |
| Continuous batching | 每个 step 重组 batch                | §02             |
| Prefill      | 处理整段 prompt 算第一个 token              | §02             |
| Decode       | 自回归生成后续每个 token                     | §02 §07         |
| TTFT         | time to first token                 | §08             |
| TBT / ITL    | inter-token latency                 | §08             |
| TP / PP / DP | tensor / pipeline / data parallel   | §05             |
| AWQ / GPTQ / FP8 | 主流权重量化算法                        | §04             |
| Speculative decoding | 草稿 + 校验加速                      | §07             |
| Prefix cache | 重复前缀的 KV cache 复用                   | §02 §07         |
| Guided decoding | 强制输出符合 schema / grammar          | §07             |
| Goodput      | 满足 SLA 的有效吞吐                        | §08             |

## 常见坑

1. **「我用 transformers 跑了，vLLM 应该差不多」**——错。同硬件 5-10 倍差距。在生产里这意味着同样的钱能服务 5-10 倍用户。
2. **盲目追新引擎**——SGLang、TensorRT-LLM 比 vLLM 在某些场景快 20-30%，但生态、社区、文档差一截。除非你测过你的负载，否则 vLLM 是默认选项。
3. **忽视 quantization 的精度成本**——4-bit 在通用任务掉 1-3%，但在数学、code、multi-step reasoning 上可能掉 5-10%。详见 [04 · 量化](./04-quantization.md)。
4. **用 Ollama 上生产**——Ollama 是开发体验工具，不是 serving solution。没 metrics、没 batching、单请求性能也一般。
5. **以为 llama.cpp 在 GPU 上能打 vLLM**——llama.cpp 的强项是 CPU/Metal/异构，纯 NVIDIA GPU serving 它不是 vLLM 对手。
6. **没考虑模型加载时间**——70B 模型从磁盘 load 到 GPU 要 1-3 分钟，启动慢比想象中影响大（rolling update、扩容）。

## 下一步

- 理解推理引擎背后的概念 → [02 · 关键概念](./02-key-concepts.md)
- 直接动手 vLLM → [03 · vLLM 实战](./03-vllm.md)
- 已经决定要量化 → [04 · 量化](./04-quantization.md)
- 算清楚到底要不要自部署 → [10 · 成本与延迟权衡](./10-cost-latency.md)
- 上层 agent 编排 → [../langgraph/01-overview.md](../langgraph/01-overview.md)
- 训练自己的模型再来部署 → [../fine-tuning/](../fine-tuning/)
