# 09 · 容灾与降级

LLM 应用的容灾不只是"换 region"——更高频的事故是 **OpenAI 429 / Anthropic 5xx / 自部署 vLLM OOM / 数据库连接耗尽**。这一章给真实可用的**降级链、circuit breaker、cache、stub response、多 region** 的代码。

## 1. 容灾的层次

```
1. 进程级：单个请求失败 → 重试、降级、stub
2. 实例级：单个 Pod 挂  → 副本、健康检查
3. 节点级：单个 Node 挂 → 跨节点反亲和
4. AZ 级：  单个 AZ 挂  → 跨 AZ 部署
5. Region 级：单个 region 挂 → 多 region active-active 或主备
6. Provider 级：OpenAI 挂 → 切 Anthropic / 自部署
```

90% 的事故在 1-2 层，先把这两层做扎实再谈多 region。

## 2. 失败模式 → 缓解措施矩阵

| 失败 | 频率 | 影响 | 缓解 |
|---|---|---|---|
| OpenAI 429（速率限制） | 高 | 单请求失败 | 重试 + provider fallback |
| OpenAI 5xx / 超时 | 中 | 单请求失败 | 重试 + provider fallback |
| OpenAI 中等区域故障 | 低 | 全局失败 | provider fallback + cache |
| 自部署 vLLM OOM | 中 | 实例失效 | watchdog + 副本 |
| Postgres 连接耗尽 | 中 | 写 checkpoint 失败 | 池配置 + 降级到内存 |
| Redis 不可用 | 中 | cache miss | 应用层 fallback to no-cache |
| 集群网络抖动 | 低 | 5-30s 不可用 | 重试 + 客户端 retry |
| 单 Pod OOM | 高 | 该 Pod 请求失败 | 副本 + LB 健康检查 |
| 节点故障 | 中 | 一波 Pod 失效 | k8s 自动重建 + PDB |
| AZ 故障 | 低 | 该 AZ Pod 全失 | 跨 AZ 反亲和 |
| Region 故障 | 极低 | 全失 | 多 region |

## 3. 重试策略：tenacity 模板

```python
from tenacity import (
    AsyncRetrying, stop_after_attempt, wait_exponential_jitter,
    retry_if_exception_type, before_sleep_log,
)
from openai import APITimeoutError, APIConnectionError, RateLimitError, InternalServerError

import logging
log = logging.getLogger(__name__)

RETRYABLE = (APITimeoutError, APIConnectionError, RateLimitError, InternalServerError)

async def call_with_retry(fn, *args, **kw):
    async for attempt in AsyncRetrying(
        stop=stop_after_attempt(3),
        wait=wait_exponential_jitter(initial=1, max=10, jitter=1),
        retry=retry_if_exception_type(RETRYABLE),
        before_sleep=before_sleep_log(log, logging.WARNING),
        reraise=True,
    ):
        with attempt:
            return await fn(*args, **kw)
```

**关键点**：

| 配置 | 原因 |
|---|---|
| `stop_after_attempt(3)` | 不要无限重试；超过 3 次说明系统性问题 |
| `wait_exponential_jitter` | 指数退避 + 抖动，避免 thundering herd |
| `RETRYABLE` 类型筛选 | 4xx 业务错误不该重试 |
| `reraise=True` | 失败后抛原异常给上层降级 |

**不要重试**：

- HTTP 400 / 401 / 403 / 422（业务错）
- 流式请求中途断（已经发了部分响应）
- 用户主动取消

## 4. Provider Fallback（多 LLM 降级链）

最实用的降级——主模型挂了切备用：

```python
class FallbackLLM:
    def __init__(self, providers: list[tuple[str, callable]]):
        # [("primary", openai_client), ("fallback", anthropic_client), ...]
        self.providers = providers

    async def chat(self, messages, **kw):
        last_exc = None
        for name, client in self.providers:
            try:
                resp = await call_with_retry(client.chat, messages=messages, **kw)
                FALLBACK_USED.labels(name).inc()
                return resp
            except Exception as e:
                log.warning("provider.failed", provider=name, error=str(e))
                last_exc = e
                continue
        raise RuntimeError(f"all providers failed: {last_exc}")
```

LiteLLM 自带这套，推荐直接用（参 [../llm-inference/09](../llm-inference/09-architecture.md)）：

```yaml
# litellm config.yaml
model_list:
  - model_name: chat
    litellm_params: { model: openai/gpt-4o-mini, api_key: os.environ/OPENAI_API_KEY }
  - model_name: chat
    litellm_params: { model: anthropic/claude-3-5-haiku-20241022, api_key: os.environ/ANTHROPIC_API_KEY }
  - model_name: chat
    litellm_params: { model: openai/qwen2.5-7b, api_base: http://vllm-7b:8000/v1, api_key: dummy }

router_settings:
  fallbacks: [{ "chat": ["chat-anthropic", "chat-vllm"] }]
  num_retries: 2
  timeout: 30
```

业务代码只调 `model="chat"`，路由 + fallback 全在 LiteLLM。

## 5. Circuit Breaker（熔断）

OpenAI 抽风 30 分钟，重试只会浪费时间。**熔断**：连续失败超阈值后直接短路一段时间。

```python
import time
from enum import Enum
from dataclasses import dataclass

class State(Enum):
    CLOSED = "closed"      # 正常
    OPEN = "open"          # 熔断中，直接拒绝
    HALF_OPEN = "half_open"  # 试探恢复

@dataclass
class CircuitBreaker:
    name: str
    failure_threshold: int = 5
    timeout: float = 60.0
    state: State = State.CLOSED
    failures: int = 0
    last_failure: float = 0

    def call_allowed(self) -> bool:
        if self.state == State.OPEN:
            if time.monotonic() - self.last_failure > self.timeout:
                self.state = State.HALF_OPEN
                return True
            return False
        return True

    def record_success(self):
        self.failures = 0
        self.state = State.CLOSED

    def record_failure(self):
        self.failures += 1
        self.last_failure = time.monotonic()
        if self.failures >= self.failure_threshold:
            self.state = State.OPEN
            log.warning("circuit.opened", name=self.name)

BREAKERS = {
    "openai": CircuitBreaker("openai"),
    "anthropic": CircuitBreaker("anthropic"),
}

async def call_protected(provider: str, fn, *args, **kw):
    cb = BREAKERS[provider]
    if not cb.call_allowed():
        raise CircuitOpenError(provider)
    try:
        r = await fn(*args, **kw)
        cb.record_success()
        return r
    except Exception:
        cb.record_failure()
        raise
```

更工业的实现：[pybreaker](https://github.com/danielfm/pybreaker) 或 [purgatory](https://github.com/mardiros/purgatory)。

## 6. Cache 降级

LLM 响应可以 cache：相同 prompt 直接返回上次答案，**provider 全挂时是救命稻草**。

```python
import hashlib, json

async def cached_chat(messages, model, ttl=3600):
    key = "llm:" + hashlib.sha256(
        json.dumps({"m": model, "msgs": messages}, sort_keys=True).encode()
    ).hexdigest()[:32]

    cached = await redis.get(key)
    if cached:
        CACHE_HITS.inc()
        return json.loads(cached)

    try:
        resp = await call_with_retry(llm.chat, messages=messages, model=model)
        await redis.setex(key, ttl, json.dumps(resp.model_dump()))
        return resp
    except Exception:
        # 降级：尝试更长 TTL 的旧 cache
        stale = await redis.get(f"stale:{key}")
        if stale:
            STALE_CACHE_USED.inc()
            return json.loads(stale)
        raise
```

**注意**：

- LLM 大部分是 stateful chat，cache 命中率低（要看具体业务）
- 长 system prompt 用 Anthropic / OpenAI 的 **prompt cache**（不是响应 cache）
- Helicone / Portkey 内置 cache，可省自己实现

## 7. Stub Response（极端降级）

所有 LLM 都挂了，至少**不能让产品白屏**：

```python
STUB_RESPONSES = {
    "general": "抱歉，我暂时无法回答您的问题，请稍后再试。",
    "support": "您的问题已记录，客服会尽快联系您。是否需要留下联系方式？",
}

async def chat_endpoint(messages):
    try:
        return await cached_chat(messages, model="chat")
    except (CircuitOpenError, RuntimeError) as e:
        log.error("chat.all_providers_failed", error=str(e))
        STUB_USED.inc()
        return {
            "content": STUB_RESPONSES["general"],
            "degraded": True,
            "reason": "service_unavailable",
        }
```

UI 拿到 `degraded: true` 时展示"系统繁忙"提示。**比 5xx 用户体验好**。

## 8. 降级策略组合

实战中往往组合使用：

```
请求来 →
  1. 进 cache？           ↓ 命中
  2. 调 primary provider  ↓ 失败 / 熔断
  3. 调 fallback provider ↓ 失败 / 熔断
  4. 找旧 cache           ↓ 没有
  5. 返回 stub            ↓ 用户看到友好提示
```

```python
async def chat(messages, model="chat", tenant="default"):
    # 1. cache
    if (r := await cache_get(messages, model)):
        return r

    # 2-3. provider chain with circuit breakers
    for provider in ["openai", "anthropic", "vllm-local"]:
        try:
            r = await call_protected(provider, llm[provider].chat, messages=messages)
            await cache_set(messages, model, r)
            return r
        except (RateLimitError, APITimeoutError, CircuitOpenError):
            continue

    # 4. stale cache
    if (r := await cache_get_stale(messages, model)):
        return r

    # 5. stub
    return STUB_RESPONSE
```

## 9. 按预算降级

成本敏感场景：超预算后**降级到 cheap model**：

```python
TENANT_BUDGETS = {  # USD / day
    "free": 0.5,
    "pro": 5.0,
    "enterprise": 100.0,
}

async def chat_with_budget(messages, tenant):
    spent = await redis.get(f"spent:{tenant}:{today()}") or 0
    budget = TENANT_BUDGETS[tenant]

    if float(spent) >= budget * 0.9:
        # 接近上限，切便宜模型
        model = "gpt-4o-mini"
        DEGRADED.labels(tenant, "budget").inc()
    elif float(spent) >= budget:
        # 超上限：要么停服，要么用免费 stub
        return {"content": "今日额度已用完，明日 00:00 重置。", "degraded": True}
    else:
        model = "gpt-4o"

    return await chat(messages, model=model, tenant=tenant)
```

## 10. 数据库 / Redis 降级

```python
class CheckpointerWithFallback:
    """Postgres 挂了用内存兜底，业务可继续但不持久化。"""
    def __init__(self, primary, memory):
        self.primary, self.memory = primary, memory
        self.use_memory = False

    async def aput(self, *a, **kw):
        if not self.use_memory:
            try:
                return await self.primary.aput(*a, **kw)
            except Exception as e:
                log.error("postgres.failed", error=str(e))
                self.use_memory = True
                CKPT_DEGRADED.inc()
        return await self.memory.aput(*a, **kw)
```

**注意**：内存兜底意味着 Pod 重启 state 全丢；要有自动恢复（Postgres 恢复后切回去），且**告警必发**——这是临时降级，不是稳态。

## 11. K8s 层的容灾

```yaml
# Deployment 关键容灾配置
spec:
  replicas: 3
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: DoNotSchedule       # 强制跨 AZ
      labelSelector: { matchLabels: { app: agent-api } }
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: agent-api }
spec:
  minAvailable: 2          # 维护 / 升级保留至少 2 个
  selector: { matchLabels: { app: agent-api } }
```

## 12. 多 Region 部署

绝大多数公司**不需要多 region**（单 region 多 AZ 已经 4 个 9）。真要做：

| 模式 | 说明 | 复杂度 |
|---|---|---|
| Active-Active（无状态） | DNS GeoLB + 各 region 独立栈 | 中：DNS / 跨 region replication |
| Active-Standby | 主 region 跑，备 region 待命 | 中：备需要预热 |
| Edge + Center | CDN/边缘做 cache + UI，中心跑模型 | 大：模型同步 |

LLM 应用跨 region 简单的是因为：

- 应用层无状态（state 在 Postgres，跨 region 用主备复制）
- 模型权重在镜像里，不需要跨 region 同步
- 主要复杂度在 DNS、健康监控、跨 region 流量切换

### 12.1 跨 region 流量切换示例

```python
# 健康探测 + DNS 切换（伪代码）
async def region_healthcheck(region):
    try:
        r = await httpx.get(f"https://api.{region}.example.com/health/deep", timeout=5)
        return r.status_code == 200
    except Exception:
        return False

while True:
    healthy = [r for r in REGIONS if await region_healthcheck(r)]
    if set(healthy) != current_set:
        update_route53(healthy)        # 改 DNS weighted records
        current_set = set(healthy)
    await asyncio.sleep(30)
```

实战中用 AWS Route53 健康检查 / Cloudflare load balancing 内置功能，不自己写。

## 13. 降级演练（必做）

**降级路径平时不走，真出事时走不通**。每月演练：

```yaml
chaos_tests:
  - name: 主 LLM provider 不可用
    method: 在 LiteLLM config 临时改 primary 的 base_url 到 127.0.0.1:9999
    expected: fallback 自动接管，error rate < 1%

  - name: Postgres 不可达
    method: kubectl scale postgres --replicas=0
    expected: 应用日志切到 memory checkpointer，告警触发

  - name: Redis 不可达
    method: kubectl scale redis --replicas=0
    expected: 应用日志说 cache disabled，错误率不变

  - name: 单 Pod OOM
    method: kubectl delete pod agent-xxx
    expected: LB 摘除后剩余 Pod 顶住流量，无 5xx

  - name: 流量翻倍
    method: 用 k6 / vegeta 压测
    expected: 自动扩容，无 5xx
```

Chaos engineering 工具：[litmus](https://litmuschaos.io/)、[chaos-mesh](https://chaos-mesh.org/)、[gremlin](https://www.gremlin.com/)。

## 14. 容灾 checklist

```yaml
application_layer:
  - [ ] 重试策略（tenacity + retryable types）
  - [ ] provider fallback（多 LLM）
  - [ ] circuit breaker
  - [ ] cache + stale cache
  - [ ] stub response
  - [ ] budget 降级（按 tenant）
  - [ ] 降级有 metric + log

infrastructure:
  - [ ] 副本 >= 3
  - [ ] 跨 AZ（topologySpread）
  - [ ] PDB
  - [ ] HPA + warm pool
  - [ ] DB / Redis 高可用

drills:
  - [ ] 月度降级演练
  - [ ] 故障注入测试（chaos）
  - [ ] runbook：每个告警 + 处理步骤
  - [ ] 24/7 on-call 流程
```

## 常见坑

1. **重试所有错误**——422 业务错误重试 3 次后还失败，浪费时间且让事故变重。只重试明确的可恢复错误。
2. **没 circuit breaker**——OpenAI 抽风 1 小时，每个请求都等 30s timeout 后 fallback，整体延迟暴涨。熔断在第 5 次失败后短路。
3. **fallback 同样会挂**——降级链全是 OpenAI 不同模型，OpenAI 全挂时全挂。降级链要**跨 provider**。
4. **降级路径从未演练**——平时不走，真出事时发现配置错了 / 鉴权过期 / 网络不通。月度演练。
5. **熔断阈值太低**——单个偶发 5xx 就开熔断，正常流量被掐。阈值看错误率而不是次数（5 次失败/分钟，且总 > 10 次）。
6. **stub 太僵硬**——所有错误返回同一句话，用户感知差。按业务场景定制 stub。
7. **降级没用户感知**——前端不知道这次响应是 stub，UI 一样展示，用户以为是正常答案。响应里加 `degraded: true`。
8. **DR 演练只测计算层**——数据库 / 监控 / 告警系统自己挂了怎么办？这些也要在演练范围。
9. **多 region 但 DB 单 region**——region A 挂了切到 region B，但 B 的应用还是连 A 的 DB。要么跨 region replica，要么本就该单 region。

## 下一步

- 让监控触发自动降级 → [07 · 监控与指标](./07-monitoring.md)
- 用 trace 调试降级路径 → [08 · 日志与 Trace](./08-logging-tracing.md)
- CI/CD 中演练降级 → [10 · CI/CD 与版本灰度](./10-cicd.md)
- 模型层（vLLM）的容灾 → [../llm-inference/09-architecture.md](../llm-inference/09-architecture.md)
- agent 行为层的容灾（HITL、guard）→ [../agents/](../agents/)
- AWS 容灾参考架构 → <https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/>
- Resilience patterns → <https://learn.microsoft.com/en-us/azure/architecture/patterns/category/resiliency>
