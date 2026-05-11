# 部署进阶

> 把 Agent / Chain / RAG / LLM 服务从「能跑」推到「能扛流量、能扛事故、能升级」。

`llm-inference` 把模型层（vLLM / TGI / 多卡 / 量化）讲透了，但生产系统不止模型。模型外面包着 **FastAPI / LangGraph Server / RAG pipeline / agent 编排**，这些应用层代码同样要打镜像、上 k8s、做监控、做容灾、做灰度。

本主题覆盖**容器化、Kubernetes、Serverless 取舍、流式服务、可观测性、容灾降级、CI/CD 与版本灰度**。不是通用 SRE 教程，而是**针对 LLM 应用特性**——长连接、大响应、token streaming、GPU 节点调度、prompt/模型版本一起灰度——把工程要点说清楚。

学习前提：你写过 Python 服务、用过 Docker、知道 k8s 是什么。不要求你是 SRE，但要愿意打开 YAML。

**会教**：

- 应用层 Dockerfile / Compose / Helm chart 的真实模板
- k8s 上 LLM 应用的特殊配置（HPA、sidecar、GPU node selector）
- Serverless 在 LLM 场景的边界（哪些能 Lambda，哪些只能 K8s）
- LangGraph Server 自托管 vs 自封 FastAPI 的工程取舍
- 流式 SSE/WebSocket 的 LB、超时、断线重连
- Prometheus / Grafana / OpenTelemetry 接 LangSmith / Langfuse / Helicone
- 多区域、降级链、断路器的真实写法
- CI/CD 蓝绿、金丝雀，**prompt 版本与模型版本一起灰度**的流程

**不会教**：

- 通用 K8s 基础（请先看官方文档或 *Kubernetes Up & Running*）
- vLLM / TGI / 量化 / GPU 调度（→ `llm-inference/`）
- Agent / Graph 设计（→ `agents/`、`langgraph/`）
- 通用 SRE / Linux 性能（请看 Brendan Gregg）

## 章节索引

1. [01 · 部署形态总览](./01-overview.md) — VM / 容器 / Serverless / 托管 PaaS 决策树，按规模、延迟、运维能力选。
2. [02 · Docker 与 Compose](./02-docker.md) — LLM app 专用 Dockerfile（多阶段、非 root、uv/poetry）、Compose 编排、镜像瘦身实测。
3. [03 · Kubernetes 模式](./03-kubernetes.md) — Deployment / Service / Ingress / HPA / Sidecar / Helm chart，附 GPU node pool 配置。
4. [04 · Serverless 路径](./04-serverless.md) — AWS Lambda / Cloud Run / Modal / Vercel Functions 取舍矩阵，冷启动与超时边界。
5. [05 · LangGraph Server vs 自建 FastAPI](./05-langgraph-server.md) — 协议、持久化、HITL、studio、可演进性对比。
6. [06 · 流式服务部署](./06-streaming.md) — SSE / WebSocket 选型、Pod 设计、LB（nginx/Envoy/ALB）的 buffer 与 timeout 配置。
7. [07 · 监控与指标](./07-monitoring.md) — Prometheus / Grafana / OpenTelemetry + LLM 特化指标（TTFT、token/s、cost/req）。
8. [08 · 日志与 Trace](./08-logging-tracing.md) — 结构化日志、Trace 关联、LangSmith / Langfuse / Helicone 对接示例。
9. [09 · 容灾与降级](./09-disaster-recovery.md) — 多 region、fallback model、cache、stub response、circuit breaker 的代码。
10. [10 · CI/CD 与版本灰度](./10-cicd.md) — GitHub Actions / ArgoCD、蓝绿、金丝雀、回滚，prompt 与模型版本一起灰度的真实流程。

## 与其他主题的关系（速查表）

| 主题 | 关系 |
|---|---|
| [../llm-inference/](../llm-inference/) | **模型层 vs 应用层**。inference 讲 vLLM/TGI/量化/多卡（模型层）；本主题讲应用层服务部署。栈式关系：本主题应用层调用 inference 层。 |
| [../langgraph/](../langgraph/) | langgraph §10 给出 LangGraph 部署的"骨架"；本主题 §05 深入对比 LangGraph Server vs 自建 FastAPI 的工程取舍。 |
| [../agents/](../agents/) | agents §10 讲 agent 行为层的生产化（trace/guard/HITL）；本主题给基础设施（容器、k8s、CI/CD），两者拼成完整的 agent 上线方案。 |
| [../eval/](../eval/) | CI/CD 灰度发布必须先过离线 eval。本主题 §10 给"eval 进流水线"的写法。 |
| [../llm-security/](../llm-security/) | 安全是部署的横切面——secrets、API gateway 鉴权、网络策略本主题 §03/§10 都涉及，详细攻防请看 llm-security。 |
| [../rag-advanced/](../rag-advanced/) | RAG 系统有额外的部署组件：向量库（Qdrant/Milvus/PGVector）、文档摄取 worker。本主题 §03/§07 给配套 k8s/监控示例。 |

> 仓库内尚未独立成主题的 *cost-optimization* 主题：成本控制在本主题 §07 监控（cost/req 指标）、§09 降级（按预算降级）、§10 CI/CD（成本门禁）中分散出现，等独立成主题后会替换为深链接。

## 资源

### 官方文档

- Docker 多阶段构建：<https://docs.docker.com/build/building/multi-stage/>
- Kubernetes 文档：<https://kubernetes.io/docs/home/>
- Helm：<https://helm.sh/docs/>
- AWS Lambda：<https://docs.aws.amazon.com/lambda/>
- Google Cloud Run：<https://cloud.google.com/run/docs>
- Modal：<https://modal.com/docs>
- KEDA：<https://keda.sh/>
- ArgoCD：<https://argo-cd.readthedocs.io/>
- OpenTelemetry：<https://opentelemetry.io/docs/>
- Prometheus：<https://prometheus.io/docs/>

### 工具

- **LangGraph CLI / Server**：<https://github.com/langchain-ai/langgraph>
- **LangSmith**（trace + dataset + eval）：<https://docs.smith.langchain.com/>
- **Langfuse**（OSS LLM observability）：<https://langfuse.com/>
- **Helicone**（LLM gateway + 监控）：<https://helicone.ai/>
- **LiteLLM Proxy**（LLM 网关 / fallback / 限流）：<https://docs.litellm.ai/>
- **Portkey**（商业 LLM gateway）：<https://portkey.ai/>
- **OpenLLMetry**（LLM-aware OpenTelemetry instrumentation）：<https://github.com/traceloop/openllmetry>
- **Argo Rollouts**（k8s 蓝绿 / 金丝雀）：<https://argo-rollouts.readthedocs.io/>

### 论文与博客

- *Site Reliability Engineering* (Google, O'Reilly) — SRE 原典，本主题前置背景。
- *Designing Data-Intensive Applications* (Kleppmann) — 分布式与可靠性。
- "Patterns for Resilient Architecture" (Microsoft) — circuit breaker / bulkhead / retry。
- LangChain blog: production patterns — <https://blog.langchain.dev/>
- OpenAI Cookbook: production examples — <https://cookbook.openai.com/>
- Anthropic engineering blog — <https://www.anthropic.com/engineering>

### 模板

- 本主题各章节代码块（Dockerfile / k8s YAML / GitHub Actions）均为可直接复用模板。
- 推荐起步：`02-docker.md` 的 Dockerfile + `03-kubernetes.md` 的 Deployment + `10-cicd.md` 的 workflow，能拼成一个最小可上线的 LLM 应用骨架。

## 阅读顺序建议

- **从零开始上线一个 LLM 应用**：§01 → §02 → §03 → §07 → §10。先选形态、打镜像、上 k8s、加监控、串 CI/CD。
- **已有 K8s 集群，要把 LLM 应用塞进去**：§03 → §06 → §07 → §09。重点是流式、监控、容灾。
- **小团队 / 创业**：§01 → §04 → §05 → §08。优先 Serverless / 托管，少运维负担。
- **要把 LangGraph 推上生产**：§05 → §06 → §08 → §10。先选服务器形态，搞定流式、trace 和灰度。
- **故障复盘 / SRE 强化**：§07 → §08 → §09 → §10。监控告警、trace 定位、降级演练、回滚预案，一条线。
- **成本优先**：§01（决策树）→ §04（Serverless 计费）→ §07（cost/req 指标）→ §09（按预算降级）。

**仓库索引**：[../README.md](../README.md)
