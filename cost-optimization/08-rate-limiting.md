# 08 · 限流与配额

成本失控有三种典型剧本：**单租户 abuse**、**单任务跑飞**、**业务 bug 死循环**。任何一个都能在一晚上烧掉一个月的预算。限流不是「让用户用得不爽」的工具，是**成本上限的最后一道闸门**——本章讲 per-user / per-task / token-bucket / fairness 调度的工程实现与策略选择。

## 1. 限流的三层目标

```
┌────────────────────────────────────────┐
│  目标 1：保护成本（不让账单失控）          │
│  目标 2：保护可用性（不让一个租户拖垮全局） │
│  目标 3：保证公平（资源在租户间合理分配）  │
└────────────────────────────────────────┘
```

不同业务侧重不同：

- B2C 大量个人用户 → 防 abuse、保成本。
- B2B SaaS → 保 SLA、保公平、按 tier 限速。
- 内部工具 → 防死循环、按团队预算。

## 2. 限流维度全景

| 维度                  | 粒度       | 防什么                | 实现复杂度 |
| ------------------- | -------- | ------------------ | ----- |
| Per-user RPM/TPM     | 用户 ID    | 单用户 abuse           | 低     |
| Per-tenant TPM       | 租户        | 单租户挤占资源            | 低     |
| Per-API-key TPM      | API key  | 第三方 key 滥用           | 低     |
| Per-feature TPM      | 功能模块     | 单 feature bug      | 中     |
| Per-task token budget | 单次请求    | 单请求 prompt 太长 / 失控生成 | 低     |
| Per-tenant 月度 $ budget | 租户 + 时段 | 月成本上限             | 中     |
| Per-provider RPM     | 上游 API   | 不超 OpenAI / Anthropic 限速 | 中 |
| Concurrency limit    | 并发数      | LLM backend 不被打满   | 低     |

实战中**至少要有 per-user RPM + per-tenant 月度 budget**，否则就是裸奔。

## 3. Token bucket：经典算法实现

最常用算法，Redis 一行 Lua 搞定：

```python
# token_bucket.py
import redis

r = redis.Redis()

# Lua 原子操作：refill + take
SCRIPT = """
local key       = KEYS[1]
local capacity  = tonumber(ARGV[1])
local refill    = tonumber(ARGV[2])     -- tokens per second
local now       = tonumber(ARGV[3])
local cost      = tonumber(ARGV[4])

local bucket = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(bucket[1]) or capacity
local ts     = tonumber(bucket[2]) or now

-- refill
local elapsed = math.max(0, now - ts)
tokens = math.min(capacity, tokens + elapsed * refill)

if tokens < cost then
    redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
    redis.call('EXPIRE', key, 3600)
    return 0    -- rejected
end

tokens = tokens - cost
redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', key, 3600)
return 1
"""

_script = r.register_script(SCRIPT)

def take(key: str, capacity: int, refill_per_sec: float, cost: int = 1) -> bool:
    """capacity tokens, refill rate, take `cost` tokens. Return True if allowed."""
    import time
    return bool(_script(keys=[key], args=[capacity, refill_per_sec, time.time(), cost]))

# 用法：每用户 100 req / min（capacity 100, refill 100/60）
if not take(f"rate:user:{user_id}", capacity=100, refill_per_sec=100/60):
    raise HTTPException(429, "Rate limit exceeded")
```

**为啥要 Lua**：Redis 单线程，Lua 保证 refill + take 原子，避免高并发竞态。

## 4. Token-budget rate limit（按 token 而非按请求）

请求数限速对 LLM 不够——一个 100K token 的请求和一个 100 token 的请求消耗完全不一样。

```python
# token_rate_limit.py
def check_token_budget(tenant_id: str, estimated_tokens: int) -> bool:
    """每租户每分钟 100K token 上限。"""
    return take(
        key=f"rate:tenant:{tenant_id}:tpm",
        capacity=100_000,
        refill_per_sec=100_000 / 60,
        cost=estimated_tokens,
    )

# 调用前用 tokenizer 估算
import tiktoken
enc = tiktoken.encoding_for_model("gpt-5")
n = len(enc.encode(prompt)) + max_tokens   # 含 output 预算

if not check_token_budget(tenant_id, n):
    return JSONResponse(429, {"error": "tenant TPM exceeded"})
```

**两阶段限流**（最优实践）：

1. **请求前**：按 estimated tokens 预扣预算。
2. **请求后**：按 actual tokens 退还差额或补扣。

```python
async def call_with_budget(tenant_id, prompt, max_tokens):
    est = estimate_tokens(prompt) + max_tokens
    if not check_token_budget(tenant_id, est):
        raise RateLimitError()
    try:
        resp = await llm_call(prompt, max_tokens=max_tokens)
    finally:
        actual = resp.usage.input_tokens + resp.usage.output_tokens
        refund = est - actual
        if refund > 0:
            refund_tokens(tenant_id, refund)   # 退还差额
        elif refund < 0:
            consume_tokens(tenant_id, -refund) # 补扣（超预算）
    return resp
```

## 5. 按月预算（cost-budget enforcement）

RPM/TPM 控的是峰值，**月度成本上限**控的是总量：

```sql
-- 每分钟扫一次，超出 budget 的 tenant 拉黑
WITH spend AS (
  SELECT
    tenant_id,
    SUM(total_cost_usd) AS month_cost
  FROM llm_usage_log
  WHERE ts >= date_trunc('month', now())
  GROUP BY tenant_id
)
UPDATE tenant
SET status = CASE
  WHEN s.month_cost > t.monthly_budget * 1.0 THEN 'suspended'
  WHEN s.month_cost > t.monthly_budget * 0.9 THEN 'warning'
  ELSE 'active'
END
FROM spend s
WHERE tenant.id = s.tenant_id;
```

**警示阶梯**（推荐）：

| 占预算  | 动作                       |
| ---- | ------------------------ |
| 50%  | 邮件提醒（一次性）              |
| 80%  | 邮件 + UI banner          |
| 95%  | 限速到 50%、要求确认续费             |
| 100% | 暂停服务、转人工 review            |
| 120% | 强制阻断、需要管理员手动恢复            |

**重要**：**永远不要硬卡 100% 然后断服**——给个 10-20% 软超额缓冲，避免业务高峰直接挂掉。

## 6. Fairness scheduling：多租户排队

高负载时所有人都来抢 backend，**fairness** 决定谁先谁后。

```python
# weighted_fair_queue.py
from collections import deque
from heapq import heappush, heappop

class WeightedFairQueue:
    """按 tenant tier 加权调度。Pro 用户优先。"""
    def __init__(self):
        self.queues: dict[str, deque] = {}  # tier -> queue
        self.weights = {"free": 1, "pro": 4, "enterprise": 16}
        self.deficit = {k: 0 for k in self.weights}

    def enqueue(self, tier: str, task):
        self.queues.setdefault(tier, deque()).append(task)

    def dequeue(self):
        # Deficit Round Robin
        while True:
            for tier, w in sorted(self.weights.items(), key=lambda x: -x[1]):
                q = self.queues.get(tier)
                if q:
                    self.deficit[tier] += w
                    if self.deficit[tier] > 0 and q:
                        self.deficit[tier] -= 1
                        return q.popleft()
            return None
```

**当 free tier 把 backend 打满时**，pro 用户依然能拿到 4x 资源，enterprise 16x。**比简单 FIFO 队列体感好得多**。

## 7. 上游 provider 限速避免

商业 API 自己也有 RPM / TPM 限制：

| Provider     | 默认 tier 限速           | 升级方式                  |
| ------------ | ------------------- | --------------------- |
| OpenAI       | tier 1-5，按消费递增      | 充值 + 历史用量              |
| Anthropic    | tier 1-4              | 申请 / 消费递增              |
| Gemini       | 按 project 配额         | 控制台申请                  |
| DeepSeek     | RPS 60-300            | 联系销售                   |

**不监控上游限速会被打 429 雪崩**。客户端要做：

```python
# upstream_aware_limiter.py
from openai import RateLimitError, AsyncOpenAI
from tenacity import retry, retry_if_exception_type, wait_exponential, stop_after_attempt

@retry(
    retry=retry_if_exception_type(RateLimitError),
    wait=wait_exponential(multiplier=1, min=4, max=60),
    stop=stop_after_attempt(5),
)
async def safe_call(...):
    return await client.chat.completions.create(...)
```

更好的做法：**主动限速到上游 quota 的 90%**，根本不让 429 发生。

## 8. 限流决策矩阵

| 场景                         | 限流策略                              |
| -------------------------- | --------------------------------- |
| B2C 免费用户                    | per-user RPM + per-user 日 token budget |
| B2C 付费用户                    | tier 区分，pro RPM > free 5x           |
| B2B SaaS 多租户                | per-tenant TPM + 月度 cost budget    |
| Internal 工具（员工）             | per-user 日预算 + 突发上限             |
| API 平台（开发者）                 | per-API-key RPM + TPM + 月度预算       |
| 多 LLM provider 混合           | 各 provider 独立 TPM 池，+ 总池            |
| Agent 多步调用                  | 单 task 步数上限 + 单 task token 上限      |
| 长上下文场景                     | per-request input token 上限         |

## 9. 真实事故案例（脱敏）

**Case 1：免费用户写脚本刷 API**

- 现象：某 free tier 用户写脚本，10 万次 / 天，月底烧出 $30K。
- 根因：注册不需要验证 + 没设 per-user 日预算。
- 修复：注册加邮箱验证；free tier 100 req/day + 30K token/day 硬上限。

**Case 2：业务 bug 死循环**

- 现象：客服 bot 进入死循环，对自己回答继续提问，3 小时打了 50K 次 API。
- 根因：循环检测不在 LLM 层，rate limit 又没设单 user 短时频次。
- 修复：per-conversation 5 min 内 max 20 turn 硬卡；agent loop 5 步必停。

**Case 3：上游 API outage 雪崩**

- 现象：Anthropic 限速突然降，业务无重试，5 分钟 50% 错误率。
- 根因：客户端没主动 rate limit，所有流量打到上游 quota。
- 修复：客户端主动限到 80% quota；剩余 20% 留给 retry。

## 10. 端到端限流配置示例

```python
# limiter_stack.py
from fastapi import FastAPI, Request, HTTPException

app = FastAPI()

@app.middleware("http")
async def rate_limit(request: Request, call_next):
    user_id   = request.state.user_id
    tenant_id = request.state.tenant_id
    feature   = request.url.path.split("/")[1]
    body      = await request.body()
    est_tokens = estimate_tokens(body) + 1000  # 含 output 预算

    # 1. 用户级 RPM
    if not take(f"rate:user:{user_id}:rpm", 60, 1.0):
        raise HTTPException(429, "user RPM exceeded")
    # 2. 用户级日 token budget
    if not take(f"rate:user:{user_id}:tpd",
                capacity=50_000, refill_per_sec=50_000/86400, cost=est_tokens):
        raise HTTPException(429, "user TPD exceeded")
    # 3. 租户 TPM
    if not take(f"rate:tenant:{tenant_id}:tpm",
                capacity=tenant_tpm(tenant_id),
                refill_per_sec=tenant_tpm(tenant_id)/60,
                cost=est_tokens):
        raise HTTPException(429, "tenant TPM exceeded")
    # 4. 租户月度成本
    if get_month_cost(tenant_id) > tenant_budget(tenant_id) * 1.2:
        raise HTTPException(402, "tenant budget exceeded — contact sales")
    # 5. feature 全局并发上限
    if not take(f"rate:feature:{feature}:concurrency",
                capacity=feature_concurrency_max(feature),
                refill_per_sec=1.0):
        raise HTTPException(503, "feature throttled")

    return await call_next(request)
```

## 常见坑

1. **只限 RPM 不限 token**——10K token 的请求和 100 token 的请求被同等对待，账单还是失控。必须 TPM。
2. **没设月度预算**——某客户写 bug 一周烧 $20K，月底吵架算谁的。每个 tenant 必须有月度硬上限。
3. **限流逻辑写在业务代码**——分散在 30 个 endpoint，维护噩梦。中间件 / gateway 层统一。
4. **限流不退预算**——按 estimated 扣，实际短得多，余量浪费。要么用 sliding window，要么 actual 时退还。
5. **429 没区分 user vs provider**——业务方分不清是「我超了」还是「上游挂了」。错误码细化。
6. **没有 fairness**——一个大 tenant 把 backend 打满，小 tenant 全挂。重要 backend 必须 fair queue。
7. **测试环境没限流**——测试时随便跑，上线发现限流逻辑根本没验过，bug 漫天。staging 也要开。
8. **限流告警不接通知**——429 量飙升没人知道，等用户投诉才反应。Slack / PagerDuty 接告警。

## 下一步

- 限流数据接入 dashboard → [09 · 成本监控](./09-cost-monitoring.md)
- 看大规模下限流的实际收益 → [10 · 规模化案例](./10-scaling-case.md)
- 路由策略与限流配合 → [03 · 模型路由](./03-model-routing.md)
- 缓存配合限流减少 backend 压力 → [07 · 缓存设计](./07-semantic-cache.md)
- 部署架构层的限流配置 → [../deployment/](../deployment/)
- Token bucket 算法详解 → <https://en.wikipedia.org/wiki/Token_bucket>
