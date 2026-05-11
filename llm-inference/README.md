# 推理与部署

> 自部署 LLM 必备：把开源模型从 HuggingFace 跑成生产服务，性能不掉、成本可控。

本主题覆盖**推理引擎选型、量化、多卡调度、长上下文优化、解码加速、性能调优、服务架构和成本权衡**。如果你正在考虑「这个 7B/14B/70B 模型到底自部署还是叫 API」，这里给的是工程答案。

学习前提：你已经知道 transformer 是什么、知道 HuggingFace 怎么 load 一个模型、用过至少一次 OpenAI / Anthropic API。不需要会写 CUDA。

## 章节索引

1. [01 · 推理引擎全景](./01-overview.md) — 为什么不用 transformers 裸跑：vLLM / TGI / SGLang / Llama.cpp / TensorRT-LLM 选型矩阵与决策树。
2. [02 · 关键概念](./02-key-concepts.md) — KV cache、PagedAttention、continuous batching、prefill/decode、并行三剑客（TP/PP/DP）。
3. [03 · vLLM 实战](./03-vllm.md) — 从 `pip install` 到生产 OpenAI-compatible server，启动参数、metrics、多 LoRA、量化加载。
4. [04 · 量化](./04-quantization.md) — GPTQ / AWQ / GGUF / FP8 / SmoothQuant 算法对比、精度损失实证、自家量化命令。
5. [05 · 多 GPU 调度](./05-multi-gpu.md) — TP vs PP vs DP，何时上多机多卡，NCCL/IB/RoCE 的真实带宽要求。
6. [06 · 长上下文优化](./06-long-context.md) — 128K context 几十 GB KV cache 怎么办，何时该退到 RAG。
7. [07 · 推理优化技术](./07-decoding.md) — Speculative decoding、Medusa、prompt cache、prefix sharing、constrained decoding 加速。
8. [08 · 性能基准与调优](./08-benchmarking.md) — TTFT / TBT / throughput 怎么测，A100/H100/4090 真实数字，调参顺序。
9. [09 · 推理服务架构](./09-architecture.md) — 单 backend 到多模型路由，API gateway、流式 LB、灰度、auto-scale。
10. [10 · 成本与延迟权衡](./10-cost-latency.md) — 自部署 vs API 经济模型，10K → 1M DAU 的临界点决策清单。

## 与其他主题的关系

| 主题                                          | 关系                                                              |
| ------------------------------------------- | --------------------------------------------------------------- |
| [../fine-tuning/](../fine-tuning/)          | **训练 vs 推理边界**。fine-tuning §08 讲训练时量化（QLoRA），本主题 §04 讲推理时量化加载。 |
| [../agents/10-production.md](../agents/10-production.md) | Agent 上线清单。本主题 §09 是模型层架构，那里是 agent 编排层架构，配合看。              |
| [../rag-advanced/](../rag-advanced/)        | RAG 是「不要把所有 context 塞进 prompt」的工程理由，本主题 §06 给量化数据。            |
| [../eval/](../eval/)                        | 量化、加速对效果的影响必须评测，方法见 eval 主题。                                  |
| [../langgraph/](../langgraph/)              | LangGraph 一般打到自部署 backend 的 OpenAI-compatible endpoint，§03 给配置。 |

## 资源

- vLLM 官方文档：<https://docs.vllm.ai/>
- TGI（HuggingFace Text Generation Inference）：<https://github.com/huggingface/text-generation-inference>
- SGLang：<https://github.com/sgl-project/sglang>
- TensorRT-LLM：<https://github.com/NVIDIA/TensorRT-LLM>
- llama.cpp：<https://github.com/ggerganov/llama.cpp>
- Ollama（本地体验）：<https://ollama.com/>
- 论文：*Efficient Memory Management for Large Language Model Serving with PagedAttention* (Kwon et al., 2023)
- 论文：*Fast Inference from Transformers via Speculative Decoding* (Leviathan et al., 2022)
- HuggingFace 量化模型集市：<https://huggingface.co/models?other=quantized>
- Anyscale LLM 性能 leaderboard：<https://www.anyscale.com/llm-performance-leaderboard>

## 阅读顺序建议

- **工程师赶时间**：§01 → §03 → §08 → §10
- **想吃透原理**：§01 → §02 → §07 → §05 → §06
- **选型决策**：§01 → §04 → §10
- **多卡 / 长上下文场景**：§02 → §05 → §06
- **做生产服务架构**：§03 → §08 → §09 → §10
