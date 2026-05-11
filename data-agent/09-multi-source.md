# 09 · 多源数据

真实企业的数据从来不是"一个仓库"：CRM 在 Salesforce、产品事件在 Snowflake、订单在 MySQL、附件在 S3 + Excel、广告数据在第三方 API。Data Agent 想"一句话回答跨源问题"，必须有一层**路由 + Catalog + 统一执行**。本章讲架构选型、统一接入层、Catalog 设计、跨源 join 三种实现，以及"什么时候老老实实搞 ELT"。

## 1. 多源场景全景

| 源类型 | 例 | 接入方式 | 难点 |
| --- | --- | --- | --- |
| SQL DB | MySQL/PG/Snowflake/BigQuery | SQLAlchemy / 直连 | 方言差异 |
| 文件 | CSV/Parquet/Excel | pandas / DuckDB | schema 不统一 |
| REST API | Stripe/Salesforce/HubSpot | requests / 客户端 SDK | 限流、分页 |
| GraphQL | Shopify/GitHub | gql 客户端 | schema 学习成本 |
| 文档 | Notion / Confluence | API + RAG | 非结构化 |
| 流 | Kafka / Pulsar | consumer | 实时 |
| 向量 | Pinecone / Weaviate | 语义检索 | 与 SQL 协同 |

**Data Agent 主战场**：前 3 类——SQL DB、文件、REST API。

## 2. 三种架构

```
┌────────────────────────────────────────────────────────────┐
│ 方案 A：ELT 到一个仓库（推荐 80%）                          │
│                                                            │
│  Source1 ┐                                                 │
│  Source2 ├─► Fivetran/Airbyte ─► dbt ─► Warehouse ◄─ Agent │
│  Source3 ┘                                                 │
└────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────┐
│ 方案 B：联邦查询                                            │
│                                                            │
│  Source1 ┐                                                 │
│  Source2 ├─► Trino / Presto / Starburst ◄─ Agent          │
│  Source3 ┘  (虚拟仓库，join 跨源)                            │
└────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────┐
│ 方案 C：Agent 自己 orchestrate                              │
│                                                            │
│  Agent ─► Tool: query_sql                                  │
│         ─► Tool: call_api                                  │
│         ─► Tool: read_file                                 │
│         ─► 在内存 / DuckDB 里 join                         │
└────────────────────────────────────────────────────────────┘
```

**速判**：

- 数据量大、SLA 严、查询频繁 → A（先 ELT 再查）
- 多源轻量、不能复制（合规）→ B（Trino 联邦）
- 小规模 PoC、文件 + API 混合 → C

90% 的 B 端项目最终走 A。**别一开始就贪联邦**——Trino 维护成本远高于 ELT pipeline。

## 3. Data Catalog：让 Agent 知道有什么

跨源前提：**Agent 知道有哪些表、列、API**。Catalog 系统：

| 工具 | 类型 | 适合 |
| --- | --- | --- |
| dbt docs | OSS | dbt 用户 |
| DataHub | OSS | 全栈，含 lineage |
| Atlan | SaaS | 商业 |
| OpenMetadata | OSS | 自托管 |
| Wren MDL | OSS | 专为 NL2SQL |
| 自家 JSON / YAML | DIY | 早期 |

最小 Catalog（JSON）：

```json
{
  "sources": [
    {
      "id": "warehouse_pg",
      "type": "postgres",
      "uri": "postgresql://ro@warehouse/analytics",
      "schemas": ["analytics", "marketing"]
    },
    {
      "id": "sf_crm",
      "type": "rest",
      "base_url": "https://example.my.salesforce.com/services/data/v60.0",
      "auth": "oauth2:sf_token"
    },
    {
      "id": "s3_excel",
      "type": "file",
      "uri": "s3://reports/manual/*.xlsx"
    }
  ],
  "datasets": [
    {
      "id": "orders",
      "source": "warehouse_pg",
      "table": "analytics.fct_orders",
      "owner": "orders-team",
      "freshness_sla": "1h",
      "pii": ["email"]
    },
    {
      "id": "salesforce_accounts",
      "source": "sf_crm",
      "endpoint": "/query/?q=SELECT+...+FROM+Account",
      "owner": "sales-ops"
    }
  ]
}
```

Catalog 喂 Agent 做 routing：用户问"和销售对账"→ Agent 知道要走 `warehouse_pg.orders` + `sf_crm.salesforce_accounts`。

## 4. 统一接入层：Tool Per Source

Agent 不应直接 `requests.get`——每种源封装成 tool：

```python
@tool
def query_warehouse(sql: str) -> list[dict]:
    """对主仓库（PostgreSQL analytics）执行只读 SQL。

    可用 schema：analytics, marketing, finance（前两个开放）
    限制：仅 SELECT/WITH，statement_timeout=30s，LIMIT 默认 1000
    """
    return run_readonly_pg(sql)

@tool
def query_salesforce(soql: str) -> list[dict]:
    """对 Salesforce 执行 SOQL（Salesforce Query Language）。

    SOQL 语法接近 SQL 但有限制：不能 join 任意表，仅父子关系。
    Schema 见 catalog.salesforce_objects.
    """
    return sf_client.query(soql)

@tool
def read_excel(s3_path: str, sheet: str | None = None) -> dict:
    """从 S3 读取 Excel 文件，返回 schema + head(5).

    返回：{"schema": {...}, "head": [...], "nrow": int}
    """
    return _read_excel(s3_path, sheet)
```

每个 tool **独立 schema 注入 + 独立错误恢复**。LLM 看 catalog 决定调哪个。

## 5. 跨源 Join：放到 DuckDB

最常见需求：仓库订单 + 手工 Excel 合并。三步：

```python
"""
跨源 join：仓库拉数据 + Excel 读入 + DuckDB 内存 join。
"""
import duckdb, pandas as pd

con = duckdb.connect(":memory:")

# 1. 从仓库拉子集（先过滤）
orders = pd.read_sql(
    "SELECT id, user_id, amount_cents FROM fct_orders WHERE created_at > current_date - 30",
    pg_engine,
)
con.register("orders", orders)

# 2. 从 Excel 读
adj = pd.read_excel("s3://reports/manual/adjustments_2025_04.xlsx")
con.register("adj", adj)

# 3. join
result = con.execute("""
    SELECT o.id, o.amount_cents/100 - COALESCE(a.adjust_amount, 0) AS net
    FROM orders o LEFT JOIN adj a ON o.id = a.order_id
""").df()
```

**DuckDB 是中等规模跨源 join 的最佳工具**——零依赖、SQL 全特性、几百万行内存稳。LLM 生成 SQL 直接喂 DuckDB。

## 6. Agent 路由：决定调哪些 tool

```text
你是数据助手。可用数据源（见 catalog）：

【catalog】
{catalog_summary}

【用户问题】
{question}

【任务】
1. 决定问题涉及哪些数据源（输出 source id 列表）
2. 输出执行计划：[
     {"step": 1, "tool": "query_warehouse", "purpose": "..."},
     {"step": 2, "tool": "query_salesforce", "purpose": "..."},
     {"step": 3, "tool": "duckdb_join", "purpose": "..."}
   ]
3. 如果问题不涉及任何数据源，直接回答"不在已注册数据源范围内"

只输出 JSON。
```

**LangGraph 实现**：每个 step 一个节点；任一节点失败回到 router 重规划。

```python
from langgraph.graph import StateGraph, END

g = StateGraph(...)
g.add_node("plan", router_node)
g.add_node("warehouse", warehouse_node)
g.add_node("salesforce", sf_node)
g.add_node("join", duckdb_join_node)
g.add_node("answer", answer_node)
g.set_entry_point("plan")
# plan 决定下一步 / 失败回 plan
g.add_conditional_edges("plan", route_from_plan, {...})
```

## 7. 接 API：限流、分页、缓存

API tool 远比 SQL 复杂——每次问"上月销售"都打 Salesforce → 速率限制。三层缓存：

| 层 | 时长 | 实现 |
| --- | --- | --- |
| In-process LRU | 5 分钟 | `functools.lru_cache` |
| Redis | 1 小时 | key=hash(endpoint+params) |
| 落地到表 | 1 天 | 增量 sync 到 DB |

如果一个 API 每天被问 100 次以上，**默认应该 sync 到仓库**——回到方案 A。

```python
@tool
def query_salesforce(soql: str) -> list[dict]:
    """..."""
    key = f"sf:{hashlib.md5(soql.encode()).hexdigest()}"
    if cached := redis.get(key):
        return json.loads(cached)
    rate_limiter.acquire()
    out = sf_client.query_all(soql)
    redis.setex(key, 3600, json.dumps(out))
    return out
```

## 8. Schema Mapping：跨源字段对齐

业务方说"客户"——CRM 里是 `Account`，仓库里是 `users`，订单系统里是 `customer_id`。需要一份 **mapping**：

```yaml
entities:
  customer:
    aliases: ["customer", "客户", "user", "用户"]
    sources:
      - source: warehouse_pg
        table: users
        id_col: id
      - source: sf_crm
        object: Account
        id_col: Id
      - source: orders_db
        table: customers
        id_col: customer_id
    joins:
      - "warehouse_pg.users.email == sf_crm.Account.Email"
      - "warehouse_pg.users.sf_id == sf_crm.Account.Id"
```

LLM 看到"客户" → 解析为 entity `customer` → 查 mapping 拼 join 条件。

## 9. 真实例子：跨源问答

**问题**："上月华东区，Salesforce 标记 Enterprise 的客户的订单 GMV。"

**Agent 规划**：

```json
{
  "sources_used": ["warehouse_pg", "sf_crm"],
  "plan": [
    {"step": 1, "tool": "query_salesforce",
     "purpose": "取 Enterprise 客户的 Id 列表",
     "soql": "SELECT Id FROM Account WHERE Tier__c = 'Enterprise'"},
    {"step": 2, "tool": "query_warehouse",
     "purpose": "在 users 表里通过 sf_id 找对应 user_id",
     "sql": "SELECT id FROM users WHERE sf_id IN (...)"},
    {"step": 3, "tool": "query_warehouse",
     "purpose": "聚合上月 GMV，限定 user_id + 华东",
     "sql": "SELECT SUM(amount_cents)/100 FROM orders o JOIN users u ... WHERE ..."}
  ]
}
```

**执行**：三步 SQL/SOQL 串行 → 最后一步出数字 → 渲染给业务方。

**优化**：如果该问题每天都问，把 step 1 的结果 sync 到一张 `dim_customer_tier` 表，LLM 一句 SQL 出结果——再次回到 ELT。

## 10. 选型决策清单

| 你的情况 | 建议 |
| --- | --- |
| 团队没数据工程师 | 方案 C（Agent orchestrate），坚持不了大 |
| 已有仓库 + dbt | 方案 A，Catalog 用 dbt docs |
| 多源都要实时 | 方案 B（Trino），算力贵 |
| 合规要求数据不出 SaaS | 方案 B，源端查询 |
| 一个 API 调用 < 100/天 | 在 Agent 内直调即可 |
| 一个 API 调用 > 100/天 | sync 进仓库（方案 A） |
| 文件源占主导 | DuckDB on Parquet/CSV |

## 常见坑

1. **没 catalog 让 Agent "自由发挥"**：Agent 编了一个不存在的表名硬跑。**Catalog 强约束**。
2. **跨源 join 在 LLM 提示里口算**：把两份 100 万行喂 LLM 让它 join → token 爆 + 错。**DuckDB / Trino 算**。
3. **每问都打源 API**：限流封号。**三层缓存 / sync to warehouse**。
4. **schema mapping 散落各 prompt**：业务方改个字段名所有 prompt 改一遍。**集中 YAML**。
5. **方案 B 当 silver bullet**：联邦看着好用，跨源 join 性能差到没法用。**先 A 后 B**。

## 下一步

- [02 · SQL Agent](./02-sql-agent.md) — 单源做扎实再做跨源。
- [08 · 数据质量](./08-data-quality.md) — 多源后质量问题翻倍，先治理。
- [06 · 报告生成](./06-report-generation.md) — 跨源数据是高阶报告的输入。
- [`../agents/06-multi-agent.md`](../agents/06-multi-agent.md) — 多源调度可考虑 Multi-Agent 分工。
- [`../langgraph/`](../langgraph/) — 多步规划 + checkpoint 强需求。
- 工具：dbt、Fivetran/Airbyte、Trino、DuckDB、DataHub、OpenMetadata。
- 真实参考：Snowflake Cortex Analyst（仓库内）、Databricks Genie（Lakehouse 内）。
