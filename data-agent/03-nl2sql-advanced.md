# 03 · NL2SQL 进阶

§02 把单表、简单聚合的闭环跑通了。进入企业级仓库就会被四件事打回：**多表 join 选错路径、子查询/CTE 写不顺、业务术语映射错列、口径与文档不一致**。本章把每一项的工程对策讲透，并指向 Spider 2.0 / BIRD 这类企业基准。

## 1. 进阶难点全景

| 难点 | 表现 | 治理方向 |
| --- | --- | --- |
| 多表 join 路径选错 | 把 `orders` 直接 join `payments` 漏掉 `order_items` | Schema linking + 外键图 |
| 业务术语不对应列名 | "GMV" → 不知该用 `amount_cents` 还是 `paid_amount` | 语义层 / metric definition |
| 时间窗口表达 | "上月" / "MoM" / "近 7 天" | 时间词典 + 日历表 |
| 复杂语义 | "活跃用户" / "新客" / "复购" | 指标定义文档 + few-shot |
| 嵌套查询 | 需要 CTE / 窗口函数 | 任务分解 + 多步生成 |
| 数据值理解 | `status='paid'` vs `status='PAID'` | Value retrieval |
| 跨库 join | 仓库 + ODPS + ClickHouse | 联邦层（Trino）或 ELT 先合并 |

## 2. Schema Linking：把"问题→表→列"建图

NL2SQL 论文（RAT-SQL, CHESS, DAIL-SQL）共识：**先做 schema linking 再生成 SQL** 远好于直接生成。两步：

1. **表层链接**：question 里的实体 → 表名
2. **列层链接**：question 里的属性 → 列名

实现：

```python
"""
两步 schema linking：先选表，再选列。
LLM 先做"哪些表可能相关"，过滤后再做"哪些列必要"。
"""
from langchain_openai import ChatOpenAI
llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)

TABLE_PROMPT = """\
给定用户问题和候选表（带注释），输出最多 5 张相关表的列表（JSON 数组）。
只输出表名，不要解释。

【问题】{question}
【候选表】
{tables_with_comments}
"""

COLUMN_PROMPT = """\
给定问题和已选表的完整 schema，输出回答这个问题必须用到的列（JSON）。
格式：[{{"table": "...", "column": "..."}}]

【问题】{question}
【Schema】
{full_schema}
"""

def schema_link(question: str):
    tables = llm.invoke(TABLE_PROMPT.format(
        question=question,
        tables_with_comments=retrieve_table_summaries(question, k=20),
    )).content
    cols = llm.invoke(COLUMN_PROMPT.format(
        question=question,
        full_schema=fetch_ddl_for(tables),
    )).content
    return tables, cols
```

这一步的 ROI 极高——把 prompt 里的 schema 从"30 张表"压到"5 张表 + 12 列"，**生成的 SQL accuracy 提升 10–15%**（DAIL-SQL 在 Spider 上验证过）。

## 3. 外键图与 join 路径

仓库里 join 写错的最常见原因：LLM 不知道两张表之间的"正确路径"。例：

```
orders (id, user_id)
order_items (id, order_id, sku_id)
skus (id, name, category_id)
categories (id, name)
```

问"按类目统计 GMV"：
- 错误路径：`orders × skus`（没有外键，cross join 灾难）
- 正确路径：`orders → order_items → skus → categories`

### 3.1 外键图注入

把仓库外键关系生成一段紧凑文本，**永远在 prompt 里出现**：

```text
JOIN GRAPH:
orders.user_id -> users.id
order_items.order_id -> orders.id
order_items.sku_id -> skus.id
skus.category_id -> categories.id
users.region_id -> regions.id
```

实测：加这段后多表 join 错误率显著下降（BIRD 上 +5–8% execution accuracy）。

### 3.2 缺失外键怎么办

历史仓库经常**逻辑外键没在数据库里 declare**。两种处理：

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| 离线扫描 + 命名约定（`*_id`）推断 | 自动 | 误报 |
| 维护一份 `joins.yaml` 手动 | 准确 | 人工 |
| dbt manifest / Wren MDL 复用 | 准确且与 dbt 工程一致 | 需要先有 dbt |

强烈建议**最终走 dbt / 语义层** —— §4。

## 4. 业务语义层（Semantic Layer）

### 4.1 痛点

业务问"GMV 多少"，应该走哪条 SQL？十个数据团队有十种口径：

- 取 `orders.amount_cents`？
- 还是 `orders.amount_cents - refund_cents`？
- 退款要不要扣？取消订单算不算？

把口径硬塞 prompt 不可持续。**抽离成语义层**：

```yaml
# metrics.yaml（dbt 风格）
metrics:
  - name: gmv
    label: "GMV（成交总额）"
    description: "成交总金额，扣除退款，不含取消订单"
    type: simple
    sql: "amount_cents / 100.0"
    model: ref('fct_orders_clean')
    filters:
      - "status NOT IN ('cancelled')"
  - name: gmv_net
    label: "净 GMV"
    sql: "(amount_cents - coalesce(refund_cents, 0)) / 100.0"
    model: ref('fct_orders_clean')
```

LLM 看到的不再是表+列，而是**指标 + 维度**：

```text
Available metrics: gmv, gmv_net, orders_count, paying_users, ARPU
Available dimensions: date, region, category, channel, user_segment
```

生成的"SQL"实际是语义层 DSL（dbt Semantic Layer / Cube.js / MetricFlow），再编译成执行 SQL。

### 4.2 主流语义层

| 系统 | 来源 | 适合 |
| --- | --- | --- |
| dbt Semantic Layer / MetricFlow | dbt | 已有 dbt 仓 |
| Cube.js | OSS | 中后台、API 化 |
| Looker LookML | 商业 | Looker 用户 |
| Wren MDL | OSS for NL2SQL | 没 dbt 起步 |
| AtScale | 商业 | 大企 |

接入 LLM 时**给 LLM 一份 metric/dimension 清单 + 5 个 few-shot 例子**，准确率立刻上一个台阶——尤其在 BIRD 这种有业务知识的 benchmark 上。

## 5. 时间表达：被低估的难点

业务最爱说"上月"、"近 7 天"、"环比"。LLM 容易错在：

- 把"上月"翻成 `current_date - interval '30 days'`（错：跨月不对齐）
- 把"近 7 天"翻成 `>= current_date - 7`（错：包不包含今天？）
- 把"环比"翻成自己拼一个 lag（容易错列）

### 5.1 标准化"时间词典"

```yaml
# time_terms.yaml
"上月":
  start: "date_trunc('month', current_date - interval '1 month')"
  end:   "date_trunc('month', current_date)"
"上周":
  start: "date_trunc('week', current_date - interval '1 week')"
  end:   "date_trunc('week', current_date)"
"近 7 天":
  start: "current_date - interval '7 days'"
  end:   "current_date + interval '1 day'"
"今年至今":
  start: "date_trunc('year', current_date)"
  end:   "current_date + interval '1 day'"
```

Prompt 注入"时间表达必须用以下宏"，LLM 翻得稳。

### 5.2 日历表（dim_date）

复杂时间逻辑（"国庆前后两周"、"618 期间"）维护一张 `dim_date(date, year, quarter, week, is_holiday, season_name, big_promo_id)`，LLM 直接 join：

```sql
SELECT SUM(o.amount_cents)/100.0 AS gmv
FROM orders o JOIN dim_date d ON o.created_at::date = d.date
WHERE d.big_promo_id = 'JD-618-2025';
```

无需 LLM 自己算日期范围。

## 6. 任务分解：让 LLM 写多步而不是一个长查询

复杂分析（"找出连续 3 个月购买并最近 30 天未活跃的高价值用户"）让 LLM 一次写一个嵌套 SQL 容易错。**DIN-SQL 论文**的核心思想：**先分类、再分解、再生成、再 self-correct**。

```text
Step 1（分类）：这个问题是 Easy / Nested / Non-Nested with JOIN / 计算指标？
Step 2（分解）：按 sub-question 拆，每个 sub-question 给一个 CTE 名
Step 3（生成）：组装成最终 SQL，使用 CTE 而不是嵌套子查询
Step 4（自检）：检查列名是否在 schema 里、是否有歧义、LIMIT 是否合理
```

输出形如：

```sql
WITH active_buyers AS (
    SELECT user_id, count(*) AS months
    FROM (SELECT user_id, date_trunc('month', created_at) AS m
          FROM orders WHERE status='paid' GROUP BY 1, 2) t
    GROUP BY 1
    HAVING count(*) >= 3
),
high_value AS (
    SELECT user_id FROM orders
    WHERE status='paid' GROUP BY 1
    HAVING SUM(amount_cents) >= 100000
),
inactive AS (
    SELECT u.id AS user_id
    FROM users u LEFT JOIN events e
      ON u.id = e.user_id AND e.event_time > current_date - interval '30 days'
    WHERE e.user_id IS NULL
)
SELECT u.id, u.name
FROM users u
JOIN active_buyers a USING (user_id)
JOIN high_value    h USING (user_id)
JOIN inactive      i USING (user_id);
```

**CTE 比嵌套子查询更利于 LLM**：每个 CTE 是一个"中间表名 + 注释"，错了好定位。

## 7. Value Retrieval：枚举值与字符串字面量

业务问"已退款订单"，LLM 不知道 `status` 列具体存的是 `'refunded'` 还是 `'REFUNDED'` 还是 `'已退款'`。三种应对：

| 方案 | 实现 |
| --- | --- |
| sample row 注入 | §02 已讲，DDL 后附 3 行 sample |
| 枚举字典 | `status` 列的可能值预先列出："paid, refunded, cancelled, pending" |
| Value retrieval（CHESS）| 在 question 出现的字面量与列值做向量检索 |

**枚举字典**是性价比最高的：每张表维护一份 `enum_values.yaml`，加到 schema 注入。

```yaml
orders:
  status: [pending, paid, refunded, cancelled, partially_refunded]
users:
  segment: [vip, regular, churned, new]
  region: [华东, 华南, 华北, 西南, 西北, 海外]
```

## 8. Self-correction：让 LLM 看执行结果

不只看错误，**也看"对的结果"**。LLM 拿到执行结果后做一次 sanity check：

```text
你刚才执行了 SQL，结果如下（前 10 行）：
{rows_preview}

请回答：
1. 行数 = {row_count}。这个量级是否合理？
2. 列名是否符合用户问题的意图？
3. 时间范围、单位是否正确？

如果有问题，给出修正版 SQL；否则输出 OK。
```

DIN-SQL / MAC-SQL 这一步能再提 2–5%。但**别每次都做**——latency 翻倍，仅在低置信度（schema linking 时 LLM 自报 confidence < 0.7）触发。

## 9. 真实例子：从问题到 SQL 全链路

**用户问题**："Q1 华东各省份的新客 GMV 和复购率，按 GMV 倒序前 10。"

**Schema linking 输出**：

```
tables: [orders, users, regions]
columns: [orders.id, orders.user_id, orders.amount_cents, orders.created_at, orders.status,
          users.id, users.region_id, users.first_order_at, regions.id, regions.name, regions.province, regions.area]
```

**Metric 解析**：

```
gmv -> SUM(amount_cents)/100 where status='paid'
新客 -> users.first_order_at in [Q1 start, Q1 end]
复购率 -> count(distinct user with >=2 paid orders in window) / count(distinct user with >=1 paid order in window)
```

**生成 SQL**：

```sql
WITH q1 AS (
    SELECT date_trunc('quarter', current_date)         AS q_start,
           date_trunc('quarter', current_date) + interval '3 months' AS q_end
),
east AS (
    SELECT id, province FROM regions WHERE area = '华东'
),
new_user_orders AS (
    SELECT o.user_id, e.province, o.amount_cents, o.status
    FROM orders o
      JOIN users   u ON u.id = o.user_id
      JOIN east    e ON e.id = u.region_id
      CROSS JOIN q1
    WHERE u.first_order_at >= q1.q_start AND u.first_order_at < q1.q_end
      AND o.created_at      >= q1.q_start AND o.created_at      < q1.q_end
),
agg AS (
    SELECT province,
           SUM(CASE WHEN status='paid' THEN amount_cents END) / 100.0 AS gmv,
           COUNT(DISTINCT CASE WHEN status='paid' THEN user_id END) AS buyers,
           COUNT(DISTINCT CASE WHEN status='paid' THEN user_id END)
             FILTER (WHERE user_id IN (
                SELECT user_id FROM new_user_orders
                WHERE status='paid'
                GROUP BY user_id HAVING COUNT(*) >= 2
             )) AS repeat_buyers
    FROM new_user_orders
    GROUP BY province
)
SELECT province, gmv,
       ROUND(repeat_buyers::numeric / NULLIF(buyers,0), 3) AS repurchase_rate
FROM agg
ORDER BY gmv DESC NULLS LAST
LIMIT 10;
```

**评估**：业务方点"对"或"错口径"——这个反馈直接回到 few-shot 库（§4）。

## 10. 评测口径

| 指标 | 度量 | 备注 |
| --- | --- | --- |
| Execution Accuracy | 结果集与 gold SQL 跑出来一致 | Spider/BIRD 主指标 |
| Exact Match | SQL 字符串等价 | 太严，参考即可 |
| Component Match | join / where / group by 各对一半 | 诊断 |
| Valid SQL Rate | 可执行率 | 工程基线 |
| **业务对齐率** | 业务方点对 / 总数 | **生产唯一指标** |

详见 [§10 · 评测](./10-evaluation.md)。

## 常见坑

1. **跳过 schema linking 直接生成**：表多 join 就乱。先链接再生成是基础流程。
2. **没有语义层硬塞口径**：每个 prompt 都要重复"GMV 怎么算"，而且各 prompt 不一致。**抽到 dbt / Cube**。
3. **时间表达不标准化**："上月"被 LLM 翻 5 种写法。**词典 + 宏**。
4. **CTE 命名瞎起**：`a`、`t1`、`tmp` → 错了难追。**强制有语义的 CTE 名**（active_buyers、high_value 等）。
5. **不检索枚举值**：把 `status='已支付'` 写进去执行 0 行。**注入枚举字典或 sample row**。

## 下一步

- [04 · Pandas Agent](./04-pandas-agent.md) — 同样的语义层思想用于 Python 侧。
- [06 · 报告生成](./06-report-generation.md) — 把 §9 的复杂 query 结果转叙事。
- [10 · 评测](./10-evaluation.md) — Spider/BIRD 怎么跑、execution match 实现。
- [`../rag-advanced/`](../rag-advanced/) — Schema 检索 / few-shot 检索的 RAG 视角。
- [`../langchain/`](../langchain/) — 语义层接入：Cube.js / dbt MetricFlow Python SDK。
- 论文：DIN-SQL、DAIL-SQL、CHESS、MAC-SQL（[§README 的论文清单](./README.md#资源)）。
