# 01 · 成本结构拆解

降本的前提是知道钱花在哪里。LLM 应用的成本远不止「API 账单」一项——它分散在 token 调用、缓存命中、向量检索、自部署 GPU 时、网络出口、存储、监控 SaaS 各个角落。本章把成本结构展开，建立后续 9 章共用的成本视图。

## 1. 全局成本视图

一个生产 LLM 应用的月度成本，通常落在六大块：

| 成本项               | 占比（典型 API-only 应用） | 占比（典型自部署应用）  | 备注              |
| ----------------- | ----------------- | ----------- | --------------- |
| LLM 推理（input/output token） | 60-85%            | 30-50%（折算 GPU 时） | 最大头，本主题重点       |
| Embedding / 检索    | 3-10%             | 2-8%        | RAG 应用更高        |
| 向量库 / 索引存储        | 1-5%              | 1-5%        | 自部署 Milvus 接近 0 |
| 网络出口 / CDN        | 2-5%              | 3-8%        | 跨 region 时显著上升  |
| 监控 / 日志 / SaaS    | 1-4%              | 2-6%        | Helicone / Langfuse 等 |
| 工程师工时分摊           | 不显性             | 显性          | 自部署一定要算         |

**几个反直觉点：**

- API-only 应用很少把工程师工时算成本，但其实初创团队 LLM 工程师 1 个人月就够买 200M GPT-4o input token。
- 自部署应用的 token 推理成本看似低，但加上 SRE 工时 + GPU 闲置时间，临界点经常比想象的高。
- 网络出口在多 region 部署里能吃掉 5-10%——AWS / GCP 跨 region traffic 不便宜。

## 2. Input vs Output：不对称定价

几乎所有商业 API 的 output 都比 input 贵 3-5 倍。原因是 decode 阶段每个 token 都要走一遍前向，而 input 一次性 prefill。

| 模型                  | $/1M input | $/1M output | 倍数  |
| ------------------- | ---------- | ----------- | --- |
| GPT-5                | ~$2.50     | ~$10.00     | 4x  |
| GPT-5 mini           | ~$0.25     | ~$1.00      | 4x  |
| Claude Sonnet 4.5    | ~$3.00     | ~$15.00     | 5x  |
| Claude Haiku 4.5     | ~$0.80     | ~$4.00      | 5x  |
| Gemini 2.5 Flash     | ~$0.10     | ~$0.40      | 4x  |
| DeepSeek V3.2 API    | ~$0.27     | ~$1.10      | 4x  |

> 价格为 2026 年公开 list price 的量级参考，真实合同有企业折扣 / batch 折扣 / cache 折扣，单价快速变动，决策时请以厂商最新页面为准。

**实践含义**：

- 系统消息、few-shot examples、长 RAG context 计 input 价，廉价。
- 长生成内容（写文章、长 JSON）计 output 价，贵 4-5 倍。
- 让模型「想清楚再说」（CoT 思考写到 output）会显著推高账单——extended thinking / reasoning model 的 reasoning token 通常计 output 价。

## 3. Cache 命中折扣

主流厂商都引入了 prompt cache，命中部分大幅降价：

| 厂商                | 命中后 input 单价     | 折扣比例          | 命中条件                        |
| ----------------- | --------------- | ------------- | --------------------------- |
| OpenAI            | ~50% off        | 命中部分 5 折      | prompt prefix ≥ 1024 token，自动 |
| Anthropic         | ~90% off        | 命中部分 1 折      | 显式 `cache_control` block，5 分钟 TTL |
| DeepSeek          | ~90% off        | 命中部分 1 折      | 自动检测 prefix                  |
| Gemini            | ~75% off        | 命中部分 2.5 折    | 显式 cache，最少 32K token，按存储计费   |

**实算一例**：

```python
# 一个客服 bot，每次 prompt:
# - system + 知识库（共 8000 input token，固定）
# - 用户消息（平均 200 input token，变化）
# - 回答（平均 300 output token）
# 模型：Claude Sonnet 4.5，cache 命中 90% 折扣

base_input_price = 3.0   # $/1M
cache_input_price = 0.30 # 命中后 1 折
output_price = 15.0      # $/1M

cached_tokens = 8000
fresh_input = 200
output_tokens = 300

# 不开 cache
cost_no_cache = (cached_tokens + fresh_input) * base_input_price / 1e6 \
              + output_tokens * output_price / 1e6
# = 8200 * 3 / 1e6 + 300 * 15 / 1e6 = $0.0246 + $0.0045 = $0.0291

# 开 cache（命中之后）
cost_with_cache = cached_tokens * cache_input_price / 1e6 \
                + fresh_input * base_input_price / 1e6 \
                + output_tokens * output_price / 1e6
# = 8000 * 0.3 / 1e6 + 200 * 3 / 1e6 + 300 * 15 / 1e6
# = $0.0024 + $0.0006 + $0.0045 = $0.0075

savings_pct = 1 - cost_with_cache / cost_no_cache  # ≈ 74%
```

100 万次调用每月，从 $29,100 降到 $7,500。

## 4. 自部署的成本构成

自部署不是「只算卡钱」。完整公式：

```
月度自部署成本 =
    GPU 月租 / 折旧
  + 工程师 / SRE 工时分摊
  + 网络出口 + 存储
  + 监控 / 日志 SaaS
  + 模型权重存储 + 镜像仓库
  - 闲置时间机会成本（白白付着）
```

| 项                       | 典型月成本（中型团队）       | 备注                       |
| ----------------------- | ----------------- | ------------------------ |
| 2× A100 80G 云租赁         | $3,000 - $5,000   | 主算力                      |
| 1× H100 突发              | $2,500 - $4,000   | 可选，峰值                    |
| SRE 50% FTE             | $6,000 - $12,000  | 这一项最容易漏算                 |
| 网络（跨 AZ + 出口）           | $200 - $800       | RAG 检索 + LLM gateway 流量  |
| 监控 SaaS                 | $200 - $500       | Datadog / Grafana Cloud  |
| 模型权重 + 容器存储             | $50 - $200        | S3 / GCS                 |
| **合计**                  | $12,000 - $22,500 | 不含突发                    |

对比同等工作量的纯 API 方案：要每月 $12K+ token 量才追平自部署起步。

## 5. Embedding 与向量库的隐性账单

RAG 系统里 embedding 成本很容易被低估：

| 项                              | 典型单价 / 量              | 月成本示例（100 万文档，10 万次检索 / 天） |
| ------------------------------ | -------------------- | ------------------------- |
| Embedding API（text-embedding-3-small） | $0.02 / 1M token       | 100 万文档 × 500 token = 5 亿 → $10（一次性） |
| Embedding API（增量更新）            | 同上                    | 1 万 / 天 × 500 × 30 = $0.30 |
| 查询侧 embedding                   | 同上                    | 10 万 / 天 × 50 × 30 = $0.30 |
| Pinecone Standard（1M vectors）   | $70 / 月                | $70                       |
| 自建 Milvus（中小规模）                 | 1 台 8C32G              | $80 - $150               |
| Qdrant Cloud                    | 按存储 + QPS              | $50 - $200               |

**坑：** 一次大规模文档重新 embedding（模型升级、chunk 策略改了）能在一天里花掉一个月的预算。建议任何全量 re-embed 都先估算。

## 6. 网络与存储

```
应用 → LLM API：       几乎免费（client 出去的流量厂商不收）
LLM API → 应用：       收费（response token 走流量回来，部分云厂商按 GB 计）
应用 → 向量库（跨 AZ）：    $0.01 - $0.02 / GB
应用 → 向量库（跨 region）：  $0.08 - $0.12 / GB
日志 → S3：              $0.023 / GB / 月 存储 + 出口
监控 SaaS ingest：       $0.10 - $1.00 / GB
```

实际算账时，对于普通对话流量这部分占比小（< 5%）；对于多模态（图片 / 音频）流量，可能涨到 20%+。

## 7. 一个完整成本拆解示例

> 假设一个企业知识库 chatbot 应用：1 万 DAU、平均每个用户 5 次对话 / 天、单次平均 input 4000 token / output 400 token，使用 Claude Sonnet 4.5 + 自建 Milvus + Helicone 监控。

```sql
-- 月度成本拆解（30 天）
-- 总请求：10000 * 5 * 30 = 1.5M req/month
-- 总 input：1.5M * 4000 = 6B token
-- 总 output：1.5M * 400 = 600M token

WITH usage AS (
  SELECT
    1_500_000        AS requests,
    6_000_000_000    AS input_tokens,
    600_000_000      AS output_tokens,
    0.7              AS cache_hit_rate   -- 70% input 命中
)
SELECT
  -- LLM 成本（Sonnet 4.5）
  (input_tokens * 0.3        * 0.30 / 1e6)            AS cached_input_cost,
  (input_tokens * (1 - 0.3)  * 3.00 / 1e6)            AS fresh_input_cost,
  (output_tokens             * 15.0 / 1e6)            AS output_cost,

  -- Embedding（500 万次查询，每次 50 token）
  (5_000_000 * 50 * 0.02 / 1e6)                       AS embedding_cost,

  -- Milvus（自建，2 节点 4C16G）
  150.0                                               AS vector_db_cost,

  -- 监控
  299.0                                               AS observability_cost,

  -- 网络
  200.0                                               AS network_cost
FROM usage;
```

跑出来大约：

| 项              | 月成本    | 占比     |
| -------------- | ------ | ------ |
| Output token  | $9,000  | 53%    |
| Fresh input    | $3,780 | 22%    |
| Cached input   | $540    | 3%     |
| Embedding     | $5      | <1%    |
| Vector DB     | $150    | 1%     |
| 监控            | $299    | 2%     |
| 网络            | $200    | 1%     |
| **小计**         | $13,974 | 82%    |
| SRE 25% FTE   | $3,000  | 18%    |
| **合计**         | $16,974 | 100%   |

**单位经济**：$16,974 / 10,000 DAU = $1.70 / DAU / 月。如果 ARPU 是 $5，毛利率 66%；如果 ARPU 是 $2，亏死。

## 8. 成本归因的最小数据模型

要在第 9 章做 dashboard，先在每次调用日志里埋足够的字段：

```sql
CREATE TABLE llm_usage_log (
  request_id       UUID PRIMARY KEY,
  ts               TIMESTAMP NOT NULL,
  tenant_id        VARCHAR(64) NOT NULL,
  user_id          VARCHAR(64),
  feature          VARCHAR(64) NOT NULL,    -- 'chat' | 'summarize' | 'search'
  model            VARCHAR(64) NOT NULL,    -- 'claude-sonnet-4-5' 等
  provider         VARCHAR(32) NOT NULL,    -- 'anthropic' | 'openai' | 'self-host'

  input_tokens     INT NOT NULL,
  cached_tokens    INT NOT NULL DEFAULT 0,
  output_tokens    INT NOT NULL,
  reasoning_tokens INT NOT NULL DEFAULT 0,

  input_price_per_m  DECIMAL(10,4),         -- 写入时快照价格
  cached_price_per_m DECIMAL(10,4),
  output_price_per_m DECIMAL(10,4),

  total_cost_usd   DECIMAL(12,6) GENERATED ALWAYS AS (
      (input_tokens - cached_tokens) * input_price_per_m / 1e6
    + cached_tokens                  * cached_price_per_m / 1e6
    + (output_tokens + reasoning_tokens) * output_price_per_m / 1e6
  ) STORED,

  latency_ms       INT,
  status           VARCHAR(16)
);

CREATE INDEX idx_log_tenant_ts ON llm_usage_log(tenant_id, ts DESC);
CREATE INDEX idx_log_feature_ts ON llm_usage_log(feature, ts DESC);
```

字段设计要点：

- 写入时**快照价格**：未来价格变了，历史账单不会被改写。
- `total_cost_usd` 用 generated column，省得每次查询都算。
- `reasoning_tokens` 单独列出来，便于看 thinking 类模型的开销。
- 不要只存 `total_tokens`——拆开 input / output / cached 才能优化。

## 常见坑

1. **只盯 LLM 账单，忽略 embedding 与向量库**——文档量大时它们能占 5-15%，全量 re-embedding 一次性消耗惊人。
2. **把 reasoning token 当 input 算**——extended thinking 模型的 thinking 部分通常按 output 计价，遗漏后估算偏低 2-3 倍。
3. **网络出口不算**——跨 region 多副本部署一旦上线，月底账单会被 $500-$2000 的 network egress 砸到。
4. **自部署只算 GPU**——SRE 工时分摊 + 闲置时间机会成本，二者加起来经常超过卡钱。
5. **没埋成本数据**——上线半年才想起做 dashboard，发现日志里没记 tenant_id，回填都没法回填。

## 下一步

- 看到具体哪些 token 是大头 → [02 · Token 经济](./02-token-economics.md)
- 用模型路由让贵 token 走便宜模型 → [03 · 模型路由](./03-model-routing.md)
- 上 cache 砍 input 成本 → [04 · Prompt cache 系统设计](./04-prompt-cache.md)
- 把数据模型变成 dashboard → [09 · 成本监控](./09-cost-monitoring.md)
- 看真实规模下的成本曲线 → [10 · 规模化案例](./10-scaling-case.md)
- 自部署经济性深度对比 → [../llm-inference/10-cost-latency.md](../llm-inference/10-cost-latency.md)
