# 成本优化

> Token 经济不是抠门，是规模化前提。从 100 DAU 到 100 万 DAU，决定你能不能活下来的，常常不是模型能力，而是单位经济模型——每个活跃用户、每个会话、每个任务的边际成本，能不能压到价格之下。

LLM 时代的成本曲线和传统 SaaS 不一样：**它跟着 token 走，跟着模型选择走，跟着 prompt 设计走**。早期忽视成本的应用，到 10 万 DAU 时账单会让 CFO 找上门；做对了的，能在同样 ARR 下毛利率高 20-40 个百分点。

本主题覆盖**应用层全成本视角**：API 成本、自部署成本、缓存收益、限流、按租户拆账、跨模型路由、批处理折扣。不只讲怎么省钱，更讲怎么**算清楚钱、监控钱、按业务维度归因钱**——让 LLM 成为可预测的成本中心而不是黑洞。

## 会教 / 不会教

**会教：**

- 不同厂商（OpenAI / Anthropic / Google / DeepSeek 等）2026 年的真实定价对照与单位经济模型计算。
- 模型路由策略：cheap-first / quality-first / 难度分级，何时让 Haiku 跑、何时让 Opus 跑。
- Prompt cache 系统设计：OpenAI / Anthropic / DeepSeek 的实现差异，自建语义 cache 的命中率优化。
- Batch API 折扣机制（50% off 是怎么省下来的）、async batching、micro-batch 在线场景应用。
- 量化、自部署 vs API 的盈亏临界点测算（带真实 QPS 数字）。
- 限流、配额、token bucket、fairness 调度——保护成本上限的工程手段。
- 多租户拆账：从原始日志到 dashboard，per-tenant / per-feature 成本归因的 SQL 与数据模型。
- 真实案例：10K → 100K → 1M DAU 的成本曲线与优化时序，什么时候该上什么。

**不会教：**

- 模型本身怎么训练得便宜——见 [../fine-tuning/](../fine-tuning/)。
- 自部署推理引擎参数怎么调——见 [../llm-inference/](../llm-inference/)。
- 怎么写 prompt 把效果做好——见 [../prompt-engineering/](../prompt-engineering/)。
- 怎么评估降成本之后效果有没有掉——见 [../eval/](../eval/)。

## 章节索引

1. [01 · 成本结构拆解](./01-cost-structure.md) — input / output / cache / GPU 时 / 网络 / 存储，每一项都要看清。
2. [02 · Token 经济](./02-token-economics.md) — 什么贵什么省，2026 跨模型价格表与单位经济模型推导。
3. [03 · 模型路由](./03-model-routing.md) — cheap-first / quality-first / 难度分级，LiteLLM / Portkey 实战。
4. [04 · Prompt cache 系统设计](./04-prompt-cache.md) — OpenAI / Anthropic / DeepSeek 命中规则与 prompt 结构改造。
5. [05 · 批处理](./05-batching.md) — OpenAI Batch API、async batching、micro-batch，50% 折扣怎么吃下来。
6. [06 · 量化与自部署经济性](./06-quantization-economics.md) — API vs 自部署的盈亏临界 QPS 推导，带真实算例。
7. [07 · 缓存设计](./07-semantic-cache.md) — 精确 cache、语义 cache、GPTCache、Redis 命中策略与失效。
8. [08 · 限流与配额](./08-rate-limiting.md) — per user / per task / token bucket / fairness，保护成本上限。
9. [09 · 成本监控](./09-cost-monitoring.md) — 按租户、按功能拆账，Helicone / Langfuse / 自建 metrics + dashboard。
10. [10 · 规模化案例](./10-scaling-case.md) — 10K → 100K → 1M DAU 成本曲线，优化时序与决策点。

## 与其他主题的关系（速查表）

| 主题                                                    | 关系                                                                            |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| [../llm-inference/](../llm-inference/)                | §10 聚焦自部署模型成本（推理引擎层），本主题是**应用层全成本**视角，包含 API + 自部署 + 缓存 + 限流 + 拆账。           |
| [../deployment/](../deployment/)                      | 部署层关心 SLA、容量、回滚；本主题关心钱。常用 §06 / §08 / §10 的结论指导部署架构选择。                       |
| [../eval/](../eval/)                                  | 任何降本动作（路由到 mini 模型、缓存命中、量化）都要靠 eval 验证效果不掉。本主题给降本动作，eval 给验证方法。              |
| [../prompt-engineering/](../prompt-engineering/)      | Prompt 设计直接决定 input/output token 量。本主题 §04 的 cache 命中率与 prompt 结构紧密相关。       |
| [../rag-advanced/](../rag-advanced/)                  | RAG 把上下文外挂避免塞满 prompt，是本主题 §02 token 经济的实操路径之一；检索阶段的 embedding 成本本主题 §01 涵盖。 |
| [../agents/](../agents/)                              | Agent 多步调用让 token 量翻倍，本主题 §03 / §08 / §09 的限流、监控是 agent 上线必备配套。              |

## 资源

### 成本计算器与价格看板

- Artificial Analysis（实时价格 + 性能对照）：<https://artificialanalysis.ai/>
- OpenAI Pricing：<https://openai.com/api/pricing/>
- Anthropic Pricing：<https://www.anthropic.com/pricing>
- Google Gemini Pricing：<https://ai.google.dev/pricing>
- DeepSeek Pricing：<https://api-docs.deepseek.com/quick_start/pricing>
- Together AI / Fireworks（开源模型托管价格）：<https://together.ai/pricing>、<https://fireworks.ai/pricing>

### 监控与可观测性工具

- Helicone（LLM observability + cost tracking）：<https://www.helicone.ai/>
- Langfuse（开源，self-host 友好）：<https://langfuse.com/>
- Portkey（gateway + analytics）：<https://portkey.ai/>
- LangSmith（LangChain 官方）：<https://smith.langchain.com/>
- LiteLLM（统一网关 + cost callback）：<https://github.com/BerriAI/litellm>
- OpenLLMetry（OTel for LLM）：<https://github.com/traceloop/openllmetry>

### 缓存与路由

- GPTCache：<https://github.com/zilliztech/GPTCache>
- Portkey semantic cache：<https://docs.portkey.ai/docs/product/ai-gateway/cache-simple-and-semantic>
- RouteLLM（学术 + 开源路由器）：<https://github.com/lm-sys/RouteLLM>
- OpenRouter（多厂商网关）：<https://openrouter.ai/>

### 论文与博客

- *RouteLLM: Learning to Route LLMs with Preference Data*（Ong et al., 2024）
- *FrugalGPT: How to Use Large Language Models While Reducing Cost*（Chen et al., 2023）
- *Prompt Cache: Modular Attention Reuse for Low-Latency Inference*（Gim et al., 2024）
- Anthropic prompt caching 官方博客：<https://www.anthropic.com/news/prompt-caching>
- OpenAI prompt caching 文档：<https://platform.openai.com/docs/guides/prompt-caching>

## 阅读顺序建议

- **从零到一搭应用的工程师**：§01 → §02 → §04 → §07 → §09。先看清成本来源，再上 cache，最后上监控。
- **正在规模化、账单失控的团队**：§09 → §03 → §08 → §10。先把账查清楚，再做路由与限流，对照案例时序。
- **决策自部署还是 API 的架构师**：§02 → §06 → §10。看价格、算临界、对照规模曲线。
- **多租户 SaaS 平台方**：§08 → §09 → §03。限流 + 拆账 + 路由，按租户控成本。
- **追求极致单位成本的极客**：§04 → §05 → §07 → §06。把 cache、batch、量化、自部署组合用满。
- **CFO / 投资人视角**：§02 → §10。单位经济 + 规模曲线。

**仓库索引**：[../README.md](../README.md)
