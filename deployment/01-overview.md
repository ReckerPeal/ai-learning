# 01 · 部署形态总览

LLM 应用要落地，第一个问题不是"用什么框架"，而是**"跑在哪里"**。这一章给一个能用的决策树，把 VM / 容器 / Serverless / 托管 PaaS 几条路线的边界讲清楚。

模型层选型（vLLM / TGI / 量化）见 [../llm-inference/](../llm-inference/)。本章只管**应用层**——RAG pipeline、agent 编排、API 服务跑在哪里。

## 1. 四条主流路径

| 路径 | 代表 | 心智模型 |
|---|---|---|
| **VM / 裸机** | EC2、阿里云 ECS、自建机房 | 自己拿一台服务器，啥都自己装 |
| **容器（K8s/ECS）** | EKS / GKE / AKS / 自建 K8s | 把应用打成镜像，调度器帮我跑 |
| **Serverless 函数** | Lambda / Cloud Functions / Vercel | 写一段函数，请求来时才跑 |
| **托管 PaaS** | Cloud Run / Modal / Fly.io / Railway / LangGraph Cloud | 推一份代码，平台帮我跑 |

这四条不是互斥的——大型系统通常**组合使用**：核心 agent 跑 K8s，文档摄取 worker 跑 Lambda，前端跑 Vercel，长任务跑 Modal。

## 2. LLM 应用的几个"非标"约束

通用 Web 部署经验在 LLM 场景会踩坑，因为：

| 约束 | 影响 |
|---|---|
| **响应长**（5–300 秒） | Serverless 默认超时（Lambda 15min、Vercel Edge 25s）容易踩线，LB idle timeout 要调长。 |
| **流式输出**（SSE/WS） | 反代 buffering 必须关；某些 Serverless（早期 Lambda）不支持流式响应；CDN 中间层要透传 SSE。 |
| **请求体大** | RAG context、多轮历史，单请求 100KB-1MB 常见，Serverless 有 6MB-10MB 限制。 |
| **长连接（agent 多轮）** | Stateful 路径要 sticky / Redis；纯无状态 Serverless 不友好。 |
| **GPU 节点稀缺** | 跑 vLLM 必须 GPU node pool；CPU node 跑应用层，混部要 taint/toleration。 |
| **冷启动成本极高** | 模型 load 1–3 分钟，scale-to-zero 几乎不可行（应用层可以，模型层不行）。 |
| **依赖外部 API** | 应用层延迟 = 自己 + OpenAI/Anthropic 网络，跨 region 部署要考虑出口。 |

## 3. 决策树

```
                          ┌─ 是 → 走商业 API（OpenAI/Anthropic/Bedrock）
                          │      ├─ 流量 < 100 RPS → Serverless / Cloud Run
   要不要自部署模型？─────┤      ├─ 流量 100-1000 RPS → 容器 + K8s（无 GPU）
                          │      └─ 流量 > 1000 RPS → K8s + 多 region + CDN
                          │
                          └─ 否（自部署）→ 走 vLLM/TGI（→ ../llm-inference/）
                                ├─ < 10 GPU → 容器 + K8s（带 GPU node pool）
                                └─ > 10 GPU → 多机 K8s + IB 网络 + GPU operator

   应用层（agent/RAG/chain）：
       ├─ 团队 < 5 人，求快 → 托管 PaaS（Cloud Run / Modal / Vercel）
       ├─ 团队 5-50 人，已用 K8s → K8s（沿用现有 infra）
       ├─ 流量超低 / 偶发 → Serverless
       └─ 长任务（>15min）/ 复杂依赖 → Modal / Cloud Run jobs / K8s job
```

## 4. 四条路径的真实对比

| 维度 | VM | K8s（自管） | Serverless | 托管 PaaS |
|---|---|---|---|---|
| **上手时间** | 2 小时（写脚本） | 1–2 周（学曲线） | 1 天 | 1 小时 |
| **冷启动** | 无 | 无（pod 常驻） | 100ms–10s | 100ms–几秒 |
| **超时上限** | 无 | 无 | 15min（Lambda）/ 60min（Cloud Run） | 通常无 / 看平台 |
| **流式支持** | 完美 | 完美 | Lambda Response Streaming 之后 OK；Vercel Edge 支持 | 多数支持 |
| **GPU** | 灵活 | 完美（GPU operator） | 几乎不支持 | Modal 支持，多数不支持 |
| **运维负担** | 极高 | 高（但有团队就值） | 极低 | 极低 |
| **成本（小流量）** | 持续付（即便没流量） | 持续付 | 按请求付，闲时近 0 | 中（通常有 free tier） |
| **成本（大流量）** | 中（要规模化运维） | 低（最优） | 高（按请求贵） | 中–高 |
| **vendor lock-in** | 无 | 低（标准 k8s） | 高（Lambda 特定 API） | 中–高 |
| **可观测性** | 全自己装 | 全自己装 | 平台默认有，深度自己装 | 平台默认有 |

## 5. 三个典型场景

### 5.1 创业 demo / MVP

**推荐**：Vercel（前端）+ Cloud Run / Modal（agent backend）+ OpenAI API。

理由：
- 团队没人会 k8s，也不该学。
- 流量小，Serverless 计费友好。
- 流式、长任务 Cloud Run / Modal 都行。
- 一键 deploy from GitHub，CI/CD 零配置。

成本：流量 < 1000 用户/天时月成本通常 < $100。

### 5.2 中型公司，已有 K8s

**推荐**：直接打镜像上 EKS/GKE，加 GPU node pool 跑 vLLM。

理由：
- 沿用现有 CI/CD、监控、secrets management。
- 应用层和模型层在同一集群，网络延迟低。
- 复用公司已有 SRE 能力。

注意：K8s 上跑 GPU 工作负载和 CPU 应用要明确分离 node pool（taint），别让普通 pod 占 GPU 节点。

### 5.3 大流量 / 全球业务

**推荐**：多 region K8s + CDN（CloudFront/Fastly）+ 全球路由（Route53 GeoLB / Cloudflare）+ 区域 vLLM 集群。

理由：
- 用户跨地理分布，单 region 延迟大。
- 容灾要求高（双活）。
- 成本敏感，K8s 最优。

复杂度：跨 region 的 prompt cache、模型权重分发、监控聚合都是工程难题，本主题 §09 给出降级路径，但完整方案超出范围。

## 6. 决策清单（10 个问题）

上线前回答这 10 题，路径基本就定了：

1. 流量峰值预估多少 RPS？日活多少？
2. 单请求平均响应时长？（< 1s / 1-10s / 10-60s / > 60s）
3. 自部署模型还是用 API？（如自部署 → 必须 K8s 或 Modal）
4. 是否需要流式？（绝大多数 LLM 应用都需要）
5. 是否需要长连接 / WebSocket？（agent UI / 协作）
6. 团队会 K8s 吗？（不会就别勉强）
7. 已有什么 infra？（沿用最划算）
8. 多 region 需求？（全球业务才需要）
9. 预算每月多少？（< $500 走 Serverless/PaaS）
10. 合规要求？（金融/医疗可能必须自部署 + 私有云）

## 7. 反模式

下面这些"看起来合理但生产会爆"的组合：

| 反模式 | 为什么爆 |
|---|---|
| **Lambda + vLLM** | Lambda 没 GPU，vLLM 跑不起来；即使能跑也 15min 超时。 |
| **Vercel Edge + 长任务** | Edge runtime 25s 超时，agent 多轮跑不完。 |
| **K8s 无 readiness probe + 模型 load** | pod 刚起来还在 load 模型，流量打过去全 503。见 §03。 |
| **Serverless 跑 stateful agent** | 函数无内存，每次重新初始化 graph，性能差。 |
| **多容器塞一个 pod 跑 vLLM + app** | 资源争抢、扩缩容粒度不对；应该分两个 Deployment。 |
| **HPA 按 CPU 扩 vLLM** | vLLM CPU 永远 5%，永远不扩。要按 queue depth / KV usage（见 [../llm-inference/09](../llm-inference/09-architecture.md)）。 |
| **托管 PaaS 跨平台依赖** | A 平台跑 backend，B 平台跑数据库，网络延迟大且 egress 费贵。 |

## 8. 一个起步组合（推荐）

如果你完全不知道选什么，下面这个组合能覆盖 90% 中小项目：

```
┌──────────────────────────────────────────────┐
│  Vercel / Cloudflare Pages    (前端)         │
└──────────────┬───────────────────────────────┘
               │ HTTPS
               ▼
┌──────────────────────────────────────────────┐
│  Cloud Run / Modal            (Agent backend)│
│  - FastAPI + LangGraph                       │
│  - 流式 SSE                                  │
│  - 自动扩缩容                                │
└──────────────┬───────────────────────────────┘
               │
       ┌───────┴────────────────────┐
       ▼                            ▼
┌──────────────────┐       ┌────────────────────┐
│  OpenAI/Claude   │       │  Postgres (Supabase│
│  (LLM API)       │       │  /Neon/RDS)        │
└──────────────────┘       └────────────────────┘
               │
               ▼
       ┌──────────────────┐
       │  LangSmith /     │
       │  Langfuse (trace)│
       └──────────────────┘
```

后续章节会展开：

- 把这个 backend 打镜像 → §02
- 当流量大了要上 K8s → §03
- 流式细节 → §06
- 监控接 Langfuse → §07/§08
- 灰度发布 → §10

## 9. 决策示例：三种规模

### 9.1 PoC 阶段（demo 用 1 周）

```yaml
frontend: Vercel
backend: Modal（一行 deploy）
llm: OpenAI API
db: Supabase
trace: Langfuse Cloud
total_cost: ~$30/月
ops_time: 0
```

### 9.2 早期产品（1000 DAU）

```yaml
frontend: Vercel
backend: Cloud Run（auto-scale 1-10 instances）
llm: OpenAI + Anthropic（LiteLLM 路由）
db: Neon Postgres
cache: Upstash Redis
trace: Langfuse Cloud
ci_cd: GitHub Actions
total_cost: ~$300/月
ops_time: ~2 小时/周
```

### 9.3 中型产品（10K DAU，自部署模型）

```yaml
frontend: Vercel / CloudFront
backend: EKS（3 nodes m5.xlarge）
llm: vLLM on EKS（2 nodes g5.12xlarge）
db: RDS Postgres
cache: ElastiCache Redis
gateway: LiteLLM Proxy（pod 内）
trace: Langfuse self-hosted
ci_cd: GitHub Actions + ArgoCD
total_cost: ~$8000/月（GPU 占大头）
ops_team: 1-2 人
```

每跨一阶段，运维复杂度跳升一档。**不要跨级跳——不要 PoC 直接上 EKS+vLLM**。

## 常见坑

1. **过早上 K8s**——3 人小队学 k8s 学一个月，业务没动。先 Cloud Run / Modal 跑半年，再考虑迁移。
2. **Serverless 跑长任务**——以为加大 timeout 就行，结果客户端 LB / nginx / Cloudflare 上还有更短的 timeout，请求被中间环节切断。
3. **拿 GPU 节点跑应用 pod**——一个 g5.12xlarge ($5/小时) 拿来跑 FastAPI 是浪费，应用 pod 只需 m5.large。
4. **没规划流量增长曲线**——Serverless 按请求计费，DAU 上 10x 后账单上 10x，到某个点切自托管反而便宜。
5. **多 region 一开始上**——绝大多数业务单 region 多 AZ 已足够，多 region 工程量大、概率超出业务实际需要。
6. **托管 PaaS lock-in 没评估**——Vercel/Modal 的某些 API 不通用，迁移成本大；早期就该写抽象层。
7. **PoC 时未估算生产成本**——demo 用 GPT-4 跑得爽，上线发现 token cost 一个月 $50K，必须切自部署或路由。

## 下一步

- 把应用打镜像 → [02 · Docker 与 Compose](./02-docker.md)
- 已选 K8s → [03 · Kubernetes 模式](./03-kubernetes.md)
- 走 Serverless → [04 · Serverless 路径](./04-serverless.md)
- LangGraph 应用部署 → [05 · LangGraph Server vs FastAPI](./05-langgraph-server.md)
- 流式细节 → [06 · 流式服务部署](./06-streaming.md)
- 监控起步 → [07 · 监控与指标](./07-monitoring.md)
- 模型层架构 → [../llm-inference/09-architecture.md](../llm-inference/09-architecture.md)
