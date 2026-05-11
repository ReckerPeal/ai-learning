# 09 · 成本监控

「这个月 LLM 账单 $42K，谁烧的？哪个 feature？哪个 model？」——回答不出来就改不动。本章把可观测层搭起来：从原始 usage 日志、到 OLAP 聚合、到多维度 dashboard、到告警。覆盖自建方案与 Helicone / Langfuse 等 SaaS，并给出**按租户、按 feature、按模型**的拆账 SQL 与数据模型。

## 1. 监控的三个层次

```
┌───────────────────────────────────────────────────┐
│ L1：每次调用都有 trace（请求级，秒级写入）            │
│   - request_id, ts, tenant, feature, model, tokens, cost │
├───────────────────────────────────────────────────┤
│ L2：按维度聚合（小时 / 天，分钟级延迟）               │
│   - 按 tenant、feature、model 分别 sum cost           │
├───────────────────────────────────────────────────┤
│ L3：Dashboard + 告警（业务视图、SLA、异常检测）       │
│   - Grafana / Metabase / Looker / Helicone UI       │
└───────────────────────────────────────────────────┘
```

最常见的错误是**只做 L1 / L3**，缺 L2 → dashboard 每次查询都扫几亿行原始日志，慢得没法用。

## 2. 自建：原始日志 schema

延续 [§01 章节](./01-cost-structure.md) 的字段，完整生产 schema：

```sql
CREATE TABLE llm_usage_log (
  request_id        UUID PRIMARY KEY,
  ts                TIMESTAMPTZ NOT NULL,
  trace_id          VARCHAR(64),                  -- 串多次 LLM 调用
  span_id           VARCHAR(64),

  -- 业务维度
  tenant_id         VARCHAR(64) NOT NULL,
  user_id           VARCHAR(64),
  feature           VARCHAR(64) NOT NULL,
  feature_subtype   VARCHAR(64),                  -- 'chat-faq', 'chat-tech-support'
  ab_group          VARCHAR(32),

  -- 模型维度
  provider          VARCHAR(32) NOT NULL,
  model             VARCHAR(64) NOT NULL,
  is_self_hosted    BOOLEAN DEFAULT FALSE,

  -- token 计量
  input_tokens      INT NOT NULL,
  cached_tokens     INT DEFAULT 0,
  cache_write_tokens INT DEFAULT 0,
  output_tokens     INT NOT NULL,
  reasoning_tokens  INT DEFAULT 0,

  -- 价格快照（写入时定价）
  input_price_per_m   DECIMAL(10,4),
  cached_price_per_m  DECIMAL(10,4),
  output_price_per_m  DECIMAL(10,4),

  total_cost_usd DECIMAL(12,6) GENERATED ALWAYS AS (
      (input_tokens - cached_tokens - cache_write_tokens) * input_price_per_m / 1e6
    + cached_tokens                                       * cached_price_per_m / 1e6
    + cache_write_tokens                                  * (input_price_per_m * 1.25) / 1e6
    + (output_tokens + reasoning_tokens)                  * output_price_per_m / 1e6
  ) STORED,

  -- 性能维度
  latency_ms        INT,
  ttft_ms           INT,
  status            VARCHAR(16),                  -- 'success', 'rate_limited', 'error'
  error_code        VARCHAR(32),

  -- 缓存维度
  cache_hit_type    VARCHAR(16),                  -- 'exact', 'semantic', 'prompt', NULL
  cache_similarity  REAL,

  -- 追加
  metadata          JSONB
);

-- 索引必备
CREATE INDEX idx_log_tenant_ts ON llm_usage_log(tenant_id, ts DESC);
CREATE INDEX idx_log_feature_ts ON llm_usage_log(feature, ts DESC);
CREATE INDEX idx_log_model_ts ON llm_usage_log(model, ts DESC);
CREATE INDEX idx_log_trace ON llm_usage_log(trace_id);
```

## 3. 写入路径：异步 + 批量

直接在业务请求里同步写日志 = 拖慢首字时间。**异步管线**：

```python
# usage_emitter.py
import asyncio, time
from dataclasses import asdict

queue: asyncio.Queue = asyncio.Queue(maxsize=10000)

async def emit(record: UsageRecord):
    try:
        queue.put_nowait(asdict(record))
    except asyncio.QueueFull:
        # 队列满 = 监控 backend 故障，宁可丢监控数据也别拖业务
        log.warning("usage queue full, dropping record")

async def flusher():
    while True:
        batch = []
        deadline = time.monotonic() + 5     # 最多攒 5 秒
        while time.monotonic() < deadline and len(batch) < 1000:
            try:
                rec = await asyncio.wait_for(queue.get(), timeout=1)
                batch.append(rec)
            except asyncio.TimeoutError:
                break
        if batch:
            await bulk_insert(batch)        # Postgres COPY 或 ClickHouse insert
```

**性能数字**（实测）：

- 单业务进程 emit 100K 条/秒 不阻塞主链路。
- ClickHouse bulk insert：单节点 1M+ 行/秒。
- Postgres COPY：100K-300K 行/秒（足够大多数业务）。

**百万 DAU 以上**：用 ClickHouse / BigQuery / Snowflake，普通 Postgres 扛不住聚合查询。

## 4. 物化聚合：避免 dashboard 每次扫全表

```sql
-- 小时聚合（每小时 cron 跑）
CREATE TABLE llm_usage_hourly AS
SELECT
  date_trunc('hour', ts)         AS hour,
  tenant_id, feature, model, provider,
  COUNT(*)                        AS requests,
  SUM(input_tokens)               AS input_tokens,
  SUM(cached_tokens)              AS cached_tokens,
  SUM(output_tokens)              AS output_tokens,
  SUM(reasoning_tokens)           AS reasoning_tokens,
  SUM(total_cost_usd)             AS cost_usd,
  AVG(latency_ms)                 AS avg_latency_ms,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_latency_ms,
  COUNT(*) FILTER (WHERE status = 'success') AS successes,
  COUNT(*) FILTER (WHERE cache_hit_type IS NOT NULL) AS cache_hits
FROM llm_usage_log
WHERE ts >= now() - interval '1 hour'
GROUP BY 1, 2, 3, 4, 5;

CREATE UNIQUE INDEX ON llm_usage_hourly(hour, tenant_id, feature, model);

-- 日聚合从小时聚合再 roll up，更快
CREATE MATERIALIZED VIEW llm_usage_daily AS
SELECT
  date_trunc('day', hour) AS day,
  tenant_id, feature, model, provider,
  SUM(requests) AS requests,
  SUM(cost_usd) AS cost_usd,
  ...
FROM llm_usage_hourly
GROUP BY 1, 2, 3, 4, 5;
```

**ClickHouse 用 materialized view** 自动 rollup，不用 cron：

```sql
CREATE MATERIALIZED VIEW llm_usage_hourly_mv
ENGINE = SummingMergeTree()
ORDER BY (hour, tenant_id, feature, model)
AS SELECT
  toStartOfHour(ts) AS hour,
  tenant_id, feature, model, provider,
  count() AS requests,
  sum(total_cost_usd) AS cost_usd,
  sum(input_tokens) AS input_tokens,
  sum(output_tokens) AS output_tokens
FROM llm_usage_log
GROUP BY hour, tenant_id, feature, model, provider;
```

## 5. 关键查询：按租户拆账

```sql
-- Q1：本月每个租户花了多少钱
SELECT
  tenant_id,
  SUM(cost_usd) AS month_cost,
  SUM(requests) AS month_requests,
  SUM(cost_usd) / NULLIF(SUM(requests), 0) AS avg_cost_per_req
FROM llm_usage_hourly
WHERE hour >= date_trunc('month', now())
GROUP BY tenant_id
ORDER BY month_cost DESC
LIMIT 20;

-- Q2：每个租户 cost / DAU（单位经济）
WITH tenant_dau AS (
  SELECT
    tenant_id,
    COUNT(DISTINCT user_id) AS dau
  FROM llm_usage_log
  WHERE ts >= now() - interval '1 day'
  GROUP BY tenant_id
)
SELECT
  t.tenant_id,
  t.dau,
  SUM(h.cost_usd) AS day_cost,
  SUM(h.cost_usd) / NULLIF(t.dau, 0) AS cost_per_dau
FROM tenant_dau t
JOIN llm_usage_hourly h ON t.tenant_id = h.tenant_id
WHERE h.hour >= now() - interval '1 day'
GROUP BY t.tenant_id, t.dau
ORDER BY cost_per_dau DESC;

-- Q3：本月每个 feature 的成本占比
SELECT
  feature,
  SUM(cost_usd) AS month_cost,
  SUM(cost_usd) * 100.0 /
    SUM(SUM(cost_usd)) OVER ()  AS pct_total
FROM llm_usage_hourly
WHERE hour >= date_trunc('month', now())
GROUP BY feature
ORDER BY month_cost DESC;

-- Q4：每个模型的 cost / quality（要 join eval 表）
SELECT
  h.model,
  SUM(h.cost_usd) AS cost,
  AVG(e.score) AS avg_quality,
  SUM(h.cost_usd) / NULLIF(AVG(e.score), 0) AS cost_per_quality_pt
FROM llm_usage_hourly h
LEFT JOIN eval_scores e
  ON e.feature = h.feature
WHERE h.hour >= now() - interval '7 days'
GROUP BY h.model
ORDER BY cost_per_quality_pt;
```

## 6. Dashboard 必备图表

| 图表                           | 数据                  | 告警    |
| ---------------------------- | ------------------- | ----- |
| 月度累计成本曲线 vs 预算               | daily rollup        | 90% / 100% |
| 当日 top 20 租户成本               | daily 排序            | 异常增长 > 3x |
| Per-feature 成本饼图              | 月度 by feature       | 占比突变  |
| Per-model 成本 + quality 散点    | join eval           | 性价比下降 |
| Cache 命中率走势（exact/sem/prompt） | hourly by type      | 突降 30% |
| 单请求 cost 分布（p50/p95/p99）    | log percentile       | p99 飙升 |
| 限流率（429 / 总）                  | error counter       | > 5%  |
| 自部署 GPU 利用率                   | exporter metrics    | < 30% |

**Grafana 例：单月 cost 监控查询（PromQL 或 SQL data source）**

```sql
-- 本月每日成本
SELECT
  toDate(hour) AS d,
  sum(cost_usd) AS cost
FROM llm_usage_hourly
WHERE hour >= toStartOfMonth(now())
GROUP BY d
ORDER BY d;
```

## 7. SaaS 选型：Helicone / Langfuse / Portkey / LangSmith

| 工具              | 优势                              | 劣势                  | 价格（参考）            |
| --------------- | ------------------------------- | ------------------- | ----------------- |
| Helicone        | 一行代理改 base_url 即接入；多 provider | self-host 早期版功能少    | $20-$500 / 月      |
| Langfuse        | 开源 self-host 友好；trace 丰富；evals 集成 | UI 比 Helicone 简陋点  | 免费 self-host / 云版 $50-$500 |
| Portkey         | gateway + cache + routing 一体化   | vendor lock-in       | $99-$500 / 月      |
| LangSmith       | LangChain 官方，trace 最深             | 主要 for LangChain 用户  | $39-$999 / 月      |
| LiteLLM Proxy   | OSS，gateway + cost callback    | dashboard 简单         | 免费 self-host       |
| OpenLLMetry     | 标准 OTel，与现有 Datadog 等打通        | LLM 专属维度自己加         | 免费 + 后端按用量         |

**选型经验**：

- 早期（< $10K/月 LLM 账单）：Helicone 或 Langfuse 云版即可。
- 中期：Langfuse self-host（数据自留）+ 自建 Grafana 视图。
- 大规模 / 多团队：自建 ClickHouse + 自定义 dashboard，SaaS 当辅助。

## 8. 告警与异常检测

成本异常检测的核心：**对比基线**。

```python
# anomaly_check.py
def check_tenant_anomaly(tenant_id: str):
    """对比本小时 vs 过去 7 天同时段。"""
    today  = get_cost(tenant_id, last_hour=1)
    last7  = [get_cost(tenant_id, last_hour=1, days_ago=d) for d in range(1, 8)]
    p95    = np.percentile(last7, 95)
    if today > p95 * 3:
        alert(f"Tenant {tenant_id} cost {today:.2f}, p95(7d)={p95:.2f}, 3x spike!")
```

**告警阈值参考**：

| 信号              | 阈值                 | 严重度    |
| --------------- | ------------------ | ------ |
| 单租户小时成本 > p95(7d) × 3 | 3x          | P2     |
| 单租户日成本 > $1000 且环比 +200% | -      | P1     |
| 总成本 vs 预算 ≥ 90%       | 一次性      | P2     |
| 总成本 vs 预算 ≥ 100%      | -        | P1     |
| 错误率 > 5%                | 持续 10 min | P1     |
| 缓存命中率突降 > 30%        | 持续 10 min | P2     |
| 上游 429 > 1%             | 持续 5 min  | P1     |

## 9. Trace：把多次 LLM 调用串起来

Agent 系统一个用户请求触发 5-20 次 LLM 调用，要把它们串起来分析。

```python
# tracing.py
import contextvars
trace_id_var = contextvars.ContextVar("trace_id")
span_id_var  = contextvars.ContextVar("span_id")

def with_trace(func):
    async def wrapper(*args, **kwargs):
        if not trace_id_var.get(None):
            trace_id_var.set(uuid.uuid4().hex)
        span_id_var.set(uuid.uuid4().hex)
        return await func(*args, **kwargs)
    return wrapper

@with_trace
async def call_llm(...):
    resp = await client.messages.create(...)
    await emit(UsageRecord(
        request_id=uuid.uuid4(),
        trace_id=trace_id_var.get(),
        span_id=span_id_var.get(),
        ...
    ))
```

**OTel 兼容**：把 `trace_id` 与 OpenTelemetry trace 对齐，业务监控 + LLM 监控同 trace 一体看。

## 10. 真实案例：发现并定位「沉默烧钱」

某 SaaS 月底发现 LLM 账单比上月涨 60%，DAU 没怎么变。逐层下钻：

```sql
-- Step 1：按 feature 看，找出涨幅最大的
SELECT feature,
  SUM(CASE WHEN ts >= now() - interval '30 days' THEN cost_usd END) AS m1,
  SUM(CASE WHEN ts BETWEEN now() - interval '60 days' AND now() - interval '30 days'
           THEN cost_usd END) AS m0
FROM llm_usage_hourly
GROUP BY feature
ORDER BY (m1 / NULLIF(m0, 0)) DESC NULLS LAST;
-- 发现：feature "smart_search" 涨了 4x
```

```sql
-- Step 2：smart_search 内部按 model 看
SELECT model, SUM(cost_usd) AS cost, SUM(requests) AS reqs,
       SUM(cost_usd) / SUM(requests) AS unit
FROM llm_usage_hourly
WHERE feature='smart_search' AND hour >= now() - interval '30 days'
GROUP BY model ORDER BY cost DESC;
-- 发现：从 GPT-5-mini 切到了 GPT-5（PR 改路由没注意）
```

```sql
-- Step 3：定位是哪天切的
SELECT date_trunc('day', hour) AS d,
       SUM(CASE WHEN model='gpt-5' THEN cost_usd END) AS gpt5,
       SUM(CASE WHEN model='gpt-5-mini' THEN cost_usd END) AS mini
FROM llm_usage_hourly
WHERE feature='smart_search'
GROUP BY d ORDER BY d;
-- 12 天前那一天的 PR 改了路由
```

3 分钟从「账单异常」定位到 commit。**没有这个 dashboard 体系，调查可能要 1 周。**

## 常见坑

1. **价格不快照**——历史数据按当前价格回算，价格变化后账单回算错的离谱。写入时快照。
2. **没区分 cached / fresh token**——dashboard 显示「成本下降了」但其实是 cache 命中变多，业务方误以为优化生效。分开记录。
3. **trace_id 缺失**——agent 多步调用之间没串联，分析问题挑出某次调用却看不到完整链路。
4. **dashboard 查原始表**——查询慢到没人看，dashboard 形同虚设。必须聚合表。
5. **告警风暴**——一次 API outage 触发上百条告警，重要信号埋没。告警合并 + de-dupe。
6. **PII 写日志**——审计 / GDPR 不合规。prompt / response 内容要么不存、要么脱敏。
7. **只看总成本不看单位经济**——总成本涨 30% 不一定是坏事（如果 DAU 涨 50%）。永远看 cost / DAU。
8. **Helicone / Langfuse 锁死数据**——监控 SaaS 突然涨价或停服，自家根本没数据。重要业务自己存一份。

## 下一步

- 把监控结果反过来驱动决策 → [10 · 规模化案例](./10-scaling-case.md)
- A/B 路由验证用同样的 schema → [03 · 模型路由](./03-model-routing.md)
- 限流告警接入 → [08 · 限流与配额](./08-rate-limiting.md)
- 监控信号驱动 cache 优化 → [07 · 缓存设计](./07-semantic-cache.md)
- 业务效果监控见 → [../eval/](../eval/)
- 部署可观测 → [../deployment/](../deployment/)
- Helicone → <https://www.helicone.ai/>
- Langfuse → <https://langfuse.com/>
