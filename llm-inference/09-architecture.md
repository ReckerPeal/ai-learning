# 09 · 推理服务架构

vLLM 启起来只是一台 backend。生产是**多 backend、多模型、多租户、多 region**的系统。本章给上层架构。

与 [../agents/10-production.md](../agents/10-production.md) 的区别：那里关注 agent 行为层（trace、guard、retries），本章关注**模型推理层**（路由、副本、capacity）。

## 1. 架构演进路线

```
阶段 1（PoC）：     Client → vLLM
阶段 2（小规模）：    Client → nginx → 2× vLLM 副本
阶段 3（多模型）：    Client → API Gateway → Router → {7B 池, 70B 池, ...}
阶段 4（生产）：      Client → CDN → API GW → Router → Region/AZ 副本 + 监控 + 灰度
```

不要一上来搞阶段 4，按业务规模演进。

## 2. 单 backend → 多 backend

### 2.1 反向代理 + 多副本

最朴素的多副本（DP）：

```nginx
upstream vllm_pool {
    least_conn;                   # 流式连接，用最少连接
    server vllm-1:8000 max_fails=2 fail_timeout=10s;
    server vllm-2:8000 max_fails=2 fail_timeout=10s;
    server vllm-3:8000 backup;
}

server {
    listen 443 ssl;
    location /v1/ {
        proxy_pass http://vllm_pool;
        proxy_buffering off;          # 流式必须
        proxy_request_buffering off;
        proxy_read_timeout 600s;       # 长输出用
        proxy_set_header Host $host;
    }
}
```

### 2.2 健康检查

vLLM 的 `/health` 简单返回 200：

```bash
curl http://vllm-1:8000/health
```

更细的健康判定（要进流量）：

```bash
# liveness：进程活着
curl http://vllm-1:8000/health

# readiness：能服务请求
curl http://vllm-1:8000/v1/models   # 返回 model list 才算 ready
```

k8s readinessProbe 用后者。

## 3. API Gateway 层

业务规模上来后必须有 gateway，承担：

| 职责     | 工具选项                                       |
| ------ | ------------------------------------------ |
| 鉴权     | API key / OAuth / JWT                      |
| 限流     | per-user / per-model / global              |
| 计费     | token usage 记账                             |
| 模型路由   | 按 model 名 / tenant 分发                      |
| 监控     | 请求日志、SLO                                   |
| 协议适配   | OpenAI 兼容 → 内部协议                           |

常见选型：

| 方案                   | 主用                       | 优劣                  |
| -------------------- | ------------------------ | ------------------- |
| **LiteLLM Proxy**    | LLM 专用 GW，模型路由 / fallback | 上手快，专为 LLM          |
| **Portkey**          | 类似 LiteLLM，商业化            | 监控好，闭源              |
| Kong / Apigee / Tyk  | 通用 GW                    | 强大，但要自己写 LLM 逻辑     |
| Envoy                | 流式 / gRPC 友好，复杂           | 适合大公司               |
| 自家 Python FastAPI    | 灵活                       | 业务紧耦合时             |
| nginx + Lua          | 轻量                       | 简单场景                |

### 3.1 LiteLLM Proxy 示例

```yaml
# config.yaml
model_list:
  - model_name: chat-fast
    litellm_params:
      model: openai/qwen2.5-7b
      api_base: http://vllm-7b:8000/v1
      api_key: dummy

  - model_name: chat-smart
    litellm_params:
      model: openai/qwen2.5-72b
      api_base: http://vllm-72b:8000/v1
      api_key: dummy

  - model_name: chat-fallback
    litellm_params:
      model: anthropic/claude-3-haiku
      api_key: os.environ/ANTHROPIC_API_KEY

router_settings:
  routing_strategy: simple-shuffle
  fallbacks:
    - chat-smart: [chat-fast, chat-fallback]    # 大模型挂了降级到小模型/API

litellm_settings:
  cache: true
  cache_params:
    type: redis
    host: redis
    port: 6379
```

```bash
litellm --config config.yaml --port 4000
```

业务侧只用 `chat-fast` / `chat-smart`，不用关心后端是 vLLM 还是 API。

## 4. 模型路由策略

| 路由策略         | 场景                       | 实现                          |
| ------------ | ------------------------ | --------------------------- |
| 按 model 名    | 一个客户用 fast，一个用 smart     | 最常见                         |
| 按 tenant     | 每个租户独享 backend           | LiteLLM team-based routing  |
| 按延迟          | 把急的请求路由到低延迟池             | 自家逻辑，按 SLA 标签               |
| 按 prompt 长度  | 长 prompt 走 long-context 池 | 自家逻辑                        |
| 按 cost 上限    | hit budget 后降级到 cheap     | LiteLLM virtual key + budget |
| 智能路由（按任务）   | 简单问题 → 7B，复杂 → 70B       | LLM router（自己实现）            |

### 4.1 智能路由的取舍

"自动选模型"听起来美好，实操有坑：

- 增加额外延迟（路由 LLM 调用本身要 50-200ms）。
- 路由错决策代价高（简单题给 70B 浪费，难题给 7B 答错）。
- 评测困难。

**生产建议**：先做"按业务标签的静态路由"（比如 `/api/v1/chat/quick` vs `/api/v1/chat/expert`），让用户/前端选。智能路由作为后续优化。

## 5. 流式响应的 LB 处理

流式有两个特殊点：

### 5.1 长连接

每个请求是 SSE 流，可能持续 30-300 秒。LB 要：
- 关闭 buffer：响应来一段发一段。
- 长 idle timeout：默认 60s 不够，至少 300s。
- 不要跨 backend 重试（已经发了部分响应不能重试）。

### 5.2 粘性？

vLLM 单请求处理在一个实例内完成，不需要 cross-instance sticky。但：
- 如果你做了 prefix cache 优化，希望同一用户的多次请求路由到同一实例，**那就需要 sticky**（按 user_id hash）。
- agent 多轮对话，sticky 能让 prefix cache 命中率高。

nginx 粘性：

```nginx
upstream vllm_pool {
    hash $http_x_user_id consistent;     # 按 user_id 一致性哈希
    server vllm-1:8000;
    server vllm-2:8000;
    server vllm-3:8000;
}
```

## 6. 容错与降级

### 6.1 失败模式 vs 缓解

| 失败              | 影响范围        | 缓解                                |
| --------------- | ----------- | --------------------------------- |
| 一个 vLLM 实例挂     | 该实例所有请求失败   | LB 健康检查剔除，副本数 ≥ 2                 |
| 多卡 TP 实例 NCCL 死锁 | 整个实例僵死      | watchdog（vLLM `--enforce-eager` debug + 进程监控） |
| 模型仓库（HF）不可达    | 启动 / 重启失败  | 镜像 / 本地缓存                         |
| 整个 GPU 节点挂      | 该节点所有实例失败  | 跨节点副本                             |
| Region 整个挂      | 业务不可用       | 多 region 部署 + DNS / GeoLB         |
| 流量突增超容量         | 排队 / 超时    | 限流 + 降级到小模型 / 商业 API              |

### 6.2 降级链

```python
# LiteLLM 风格 fallback
try:
    resp = client.chat(model="qwen2.5-72b", ...)
except (Timeout, RateLimit):
    try:
        resp = client.chat(model="qwen2.5-7b", ...)   # 小模型
    except Exception:
        resp = client.chat(model="claude-3-haiku", ...)  # API 兜底
```

设计原则：
- **降级路径必须便宜且高可用**——不能降级到另一个同样会挂的东西。
- **降级要可观测**：每次降级打 metric，频繁降级是容量问题。
- **降级前告诉用户**："系统繁忙，已为您切换到精简版 AI"。

## 7. 灰度发布（model swap）

切换模型版本（比如 Qwen2.5-7B → Qwen2.5-7B-v2）：

### 7.1 不能用 in-place 升级

vLLM 不支持热加载新模型，必须重启进程。在线升级方案：

```yaml
策略：双池 + 流量切分
1. 新模型起新池（vllm-v2-pool）
2. 原池（vllm-v1-pool）保留
3. LiteLLM / nginx 按权重切流量：v1 95%，v2 5%
4. 监控 v2 池效果（错误率、用户反馈、eval 指标）
5. 渐进 5% → 25% → 100%
6. v2 稳定后回收 v1 池
```

### 7.2 监控差异

灰度期必看：

| 指标                | v1 vs v2 是否一致           |
| ----------------- | ----------------------- |
| 错误率               | v2 是否更高                 |
| TTFT / TBT        | v2 是否慢                  |
| 输出长度分布            | v2 突然变啰嗦或简短             |
| 业务指标（任务完成率 / 满意度） | 真正答案                    |
| 离线 eval 分数        | 必须先离线过线才上灰度（[../eval/](../eval/)） |

## 8. Auto-scaling

LLM serving 的 auto-scale 比 web 服务复杂：

| 痛点                     | 原因                              |
| ---------------------- | ------------------------------- |
| 扩容慢（model 加载 1-3 分钟）   | 70B 从磁盘到 GPU 慢                  |
| 缩容代价低（释放即可）            | -                               |
| 不能 0 起步（cold start 太慢） | 必须有 warm pool                  |
| 扩容粒度大（一次至少 1-N 张卡）     | 不像 CPU 副本那么轻                    |

### 8.1 KEDA + GPU node pool

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: vllm-7b
spec:
  scaleTargetRef:
    name: vllm-7b-deployment
  pollingInterval: 30
  cooldownPeriod: 300
  minReplicaCount: 2          # 最小 warm pool
  maxReplicaCount: 10
  triggers:
    - type: prometheus
      metadata:
        serverAddress: http://prometheus:9090
        metricName: vllm_queue_depth
        threshold: '10'        # 排队 > 10 就扩
        query: avg(vllm:num_requests_waiting{deployment="vllm-7b"})
    - type: prometheus
      metadata:
        threshold: '0.85'      # KV cache 持续 > 85% 就扩
        query: avg(vllm:gpu_cache_usage_perc{deployment="vllm-7b"})
```

### 8.2 关键调参

| 参数              | 推荐                          | 原因               |
| --------------- | --------------------------- | ---------------- |
| `minReplicas`   | 2-3                         | 永远 warm，低于此 LB 都没法平衡 |
| `cooldownPeriod` | 300-600s                   | 避免抖动             |
| 扩容指标            | queue depth + KV usage 双指标 | 任一触发都扩           |
| 节点池 type        | dedicated GPU node pool    | 不要和 CPU 业务混      |

### 8.3 突发流量预案

auto-scale 跟不上突发：
- **预留余量**：日常副本数 = 峰值预测 × 1.3。
- **降级到 API**：平时用自部署，超了 fallback 到商业 API（参 §6.2）。
- **请求队列 + 排队提示**：让客户端等待而不是 5xx。

## 9. 多 region / 多 AZ

| 模式                   | 适用                           | 工程量                |
| -------------------- | ---------------------------- | ------------------ |
| 单 region 多 AZ        | 国内业务、绝大多数公司                  | 中：跨 AZ 负载均衡         |
| 双 region active-active | 全球业务、高 SLA                  | 大：DNS GeoLB + 跨region replication |
| 主备 region            | 容灾                           | 中：备 region 平时低成本    |
| 边缘小模型 + 中心大模型        | 移动端 / 实时性极强                 | 大：模型同步 + 路由          |

LLM 跨 region 一般**不需要数据复制**——模型权重在镜像里、KV cache 是临时的，只要部署一致，请求落哪里都行。复杂度在 DNS / GeoLB / 健康监控。

## 10. 与 agent 层的对接

[../agents/10-production.md](../agents/10-production.md) 讲 agent 层的生产化（trace / human-in-loop / guard）。**两层是栈关系**：

```
Browser/App
    ↓
Agent layer (LangGraph / LangChain / 自家)   ← ../agents/, ../langgraph/
    ↓ OpenAI-compatible
LLM Inference Gateway (LiteLLM)   ← 本章
    ↓
vLLM Pools (多模型，多副本)            ← 本章 + §03 §05
    ↓
GPU 集群（k8s + GPU operator）
```

工程边界：
- agent 层 retry / fallback：业务语义级（这条工具调用失败重试）。
- 推理层 retry / fallback：模型 / 实例级（这个 vLLM 副本超时换一个）。
- **不要把这两层混**。混了之后调试痛苦：一个超时到底是 vLLM 慢还是 agent 内部 retry 风暴。

## 11. 一份生产 checklist

上线前过一遍：

```yaml
inference_layer:
  capacity:
    - [ ] benchmark 真实流量，确认副本数 + 30% headroom
    - [ ] 压测过 2x 流量，看 fail / 退化模式
  reliability:
    - [ ] 副本 ≥ 2，跨节点 / AZ
    - [ ] 健康检查（liveness + readiness）
    - [ ] watchdog：实例僵死自动重启
    - [ ] 降级路径（小模型 / API），降级有 metric
  routing:
    - [ ] LiteLLM / Gateway 部署
    - [ ] 模型名 <-> backend 映射文档化
    - [ ] 流式 buffer 关闭、timeout 设长
    - [ ] 粘性策略（如需 prefix cache 收益）
  observability:
    - [ ] Prometheus 抓 vLLM metrics
    - [ ] Grafana 仪表盘（§08 §6 那 6 张图）
    - [ ] 告警：queue / KV / TTFT p95 / 错误率
    - [ ] 请求级日志（采样，不要全量）
  release:
    - [ ] 模型升级 = 双池切流，不是 in-place
    - [ ] 离线 eval 通过 + 灰度 5% → 100%
    - [ ] Rollback 演练过
  security:
    - [ ] API key 不在 vLLM 层（Gateway 处理）
    - [ ] 模型 weights 来源可信（HF org 验证 / 自训）
    - [ ] PII 不入推理日志
  cost:
    - [ ] auto-scale 配置 + 节流策略
    - [ ] 每天 token 总量 / 每个租户配额监控
```

## 常见坑

1. **直接把 vLLM 暴露到公网**——没鉴权、没限流、没监控，分分钟被刷。前面必须有 Gateway。
2. **nginx 没关 buffer**——流式接口看起来不流（被攒了）。`proxy_buffering off; proxy_request_buffering off;`。
3. **k8s readinessProbe 用 `/health`**——`/health` 在模型还没 load 完时就 200 了，流量打过去全 503。用 `/v1/models` 才靠谱。
4. **auto-scale 算 CPU util**——LLM 实例 CPU 永远 5%，HPA 永远不扩。要按 queue / KV usage 自定义指标。
5. **min replicas 设 0 / 1**——cold start 几分钟，第一波用户必崩。≥ 2，warm 着。
6. **降级路径没演练**——平时不切，真出事时降级链路根本没走通。月度演练。
7. **多模型混部到同一个 vLLM 进程**——vLLM 一个进程一个模型。多模型必须多副本。
8. **金丝雀发布只看技术指标**——错误率好看不代表业务好。要监控**任务完成率 / 用户行为**。
9. **没考虑模型权重的下载带宽**——大规模扩容时 100 个 pod 同时从 HF 拉 70B，内网带宽崩。预先入镜像或 NAS 缓存。

## 下一步

- 把 vLLM 调好 → [03 · vLLM 实战](./03-vllm.md)
- 多卡部署底层 → [05 · 多 GPU 调度](./05-multi-gpu.md)
- benchmark 数据支撑容量规划 → [08 · 性能基准与调优](./08-benchmarking.md)
- 算清楚成本 → [10 · 成本与延迟权衡](./10-cost-latency.md)
- agent 应用层生产化 → [../agents/10-production.md](../agents/10-production.md)
- 上层 agent 编排 → [../langgraph/10-deployment.md](../langgraph/10-deployment.md)
- LiteLLM 文档 → <https://docs.litellm.ai/>
- KEDA → <https://keda.sh/>
