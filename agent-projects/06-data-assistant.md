# 06 · 项目5：数据分析助手

> **"自然语言问数 → SQL → 图表 → 报告"是数据团队最早被 Agent 革命的场景**。这章做一个面向数据库的内部分析助手：Text-to-SQL、安全执行、Plot 自动选型、自然语言报告，落地在 BI 工具旁的一个 Slack bot / Web app。

## 1. 业务背景与目标

| 维度 | 内容 |
| --- | --- |
| **业务价值** | 业务方 3 分钟拿到一份带图表的小报告，不打扰数据分析师 |
| **用户** | 产品 / 运营 / 业务，少量分析师 |
| **输入** | 自然语言："上周新用户在 iOS 和 Android 的留存对比" |
| **输出** | SQL（含解释）+ 表格 + 图（PNG/HTML）+ 中文洞察 |
| **失败成本** | 错 SQL → 错误结论 → 错误决策（高）；语义偏差 → 看不懂（低）|
| **关键 SLA** | 端到端 ≤ 15s，SQL 一次成功率 ≥ 70% |

**前 3 风险**：

1. SQL 命中错表/错字段 → schema 检索 + 强 cite + dry-run
2. 越权（业务方查到工资表）→ 只暴露白名单 schema
3. 危险写操作（DROP/UPDATE）→ 只读账号 + 语法 AST 阻断

## 2. 架构图

```
                   ┌──────────────┐
                   │ Question     │
                   └──────┬───────┘
                          ▼
                   ┌──────────────┐
                   │ Schema RAG   │  ◀─ 按问题召回相关表/字段
                   └──────┬───────┘
                          ▼
                   ┌──────────────┐
                   │ SQL Plan     │  ◀─ 拆解：维度/指标/筛选/聚合
                   └──────┬───────┘
                          ▼
                   ┌──────────────┐
                   │ Generate SQL │
                   └──────┬───────┘
                          ▼
                   ┌──────────────┐
                   │ Lint + Dry-run│ ◀─ EXPLAIN / LIMIT 0
                   └──────┬───────┘
                ┌─────────┴─────────┐
                │ fail              │ ok
                ▼                   ▼
        ┌──────────────┐     ┌──────────────┐
        │ Repair       │     │ Execute      │
        │ (retry ≤ 3)  │     │ (read-only)  │
        └──────┬───────┘     └──────┬───────┘
                                    ▼
                            ┌──────────────┐
                            │ Plot Picker  │  ◀─ 时序/对比/分布
                            └──────┬───────┘
                                    ▼
                            ┌──────────────┐
                            │ Narrative    │  ◀─ 中文洞察
                            └──────┬───────┘
                                    ▼
                            ┌──────────────┐
                            │ Compose Card │  ◀─ Slack / Web
                            └──────────────┘
```

## 3. 关键模块

### 3.1 目录结构

```
data-assistant/
├── src/
│   ├── graph/
│   │   ├── state.py
│   │   ├── nodes/
│   │   │   ├── schema_rag.py
│   │   │   ├── sql_plan.py
│   │   │   ├── sql_gen.py
│   │   │   ├── sql_lint.py
│   │   │   ├── sql_run.py
│   │   │   ├── repair.py
│   │   │   ├── plot.py
│   │   │   └── narrative.py
│   │   └── graph.py
│   ├── retrievers/
│   │   └── schema_index.py     # 字段语义索引
│   ├── tools/
│   │   ├── db.py               # 只读连接
│   │   ├── sqlparse_check.py   # AST 校验
│   │   └── plotter.py          # plotly / matplotlib
│   ├── config/
│   │   ├── whitelist.yaml      # 白名单 schema
│   │   └── synonyms.yaml       # "新用户" → first_seen
└── tests/eval/data/questions.json
```

### 3.2 Schema RAG

| 索引内容 | 字段 |
| --- | --- |
| 表 | name, comment, partition, row_count, tags |
| 字段 | name, type, comment, sample_values, synonyms |
| 业务术语 | "DAU"/"留存"/"漏斗" → 关联指标定义 |

参考 [`../rag-advanced/03-embeddings-and-stores.md`](../rag-advanced/03-embeddings-and-stores.md)：schema 描述 + 字段注释 embedding。
策略：bm25（字段名）+ 向量（注释/同义词）混合检索。

### 3.3 SQL 生成的 5 步

1. **Plan**：维度、指标、筛选、聚合粒度、时间窗口
2. **Generate**：套 schema 召回上下文生成 SQL
3. **Lint**：sqlparse / sqlglot 解析 → 检查 SELECT only、表在白名单、有 LIMIT
4. **Dry-run**：`EXPLAIN` / `SELECT ... LIMIT 0`
5. **Repair**：失败带 error 回 generate（最多 3 轮）

## 4. 关键代码片段

### 4.1 状态定义

```python
# src/graph/state.py
from typing import TypedDict, Annotated
from langgraph.graph.message import add_messages

class DataState(TypedDict):
    question: str
    user_id: str
    tenant_id: str
    # 召回
    schema_chunks: list[dict]
    # 计划
    plan: dict             # {"dims": [...], "metrics": [...], "filters": [...], "time": "..."}
    # SQL
    sql: str
    sql_valid: bool
    sql_error: str | None
    repair_count: int
    # 执行
    rows: list[dict] | None
    row_count: int
    # 图与叙述
    chart_spec: dict | None
    chart_path: str | None
    narrative: str | None
    cost_usd: float
    messages: Annotated[list, add_messages]
```

### 4.2 SQL Lint（安全核心）

```python
# src/graph/nodes/sql_lint.py
import sqlglot
from sqlglot import exp
from src.config.whitelist import ALLOWED_TABLES

FORBIDDEN = (exp.Insert, exp.Update, exp.Delete, exp.Drop, exp.Alter, exp.Create)

def lint_node(state: DataState) -> dict:
    try:
        tree = sqlglot.parse_one(state["sql"], read="postgres")
    except Exception as e:
        return {"sql_valid": False, "sql_error": f"parse: {e}"}

    # 1. 只允许 SELECT
    if not isinstance(tree, exp.Select):
        return {"sql_valid": False, "sql_error": "only SELECT allowed"}
    if any(isinstance(n, FORBIDDEN) for n in tree.walk()):
        return {"sql_valid": False, "sql_error": "DDL/DML forbidden"}

    # 2. 表白名单
    tables = {t.name for t in tree.find_all(exp.Table)}
    bad = tables - set(ALLOWED_TABLES)
    if bad:
        return {"sql_valid": False, "sql_error": f"tables not allowed: {bad}"}

    # 3. 必须有 LIMIT 或聚合
    has_limit = any(isinstance(n, exp.Limit) for n in tree.walk())
    has_group = any(isinstance(n, exp.Group) for n in tree.walk())
    if not (has_limit or has_group):
        # 自动加 LIMIT 1000
        tree = tree.limit(1000)
        return {"sql": tree.sql(dialect="postgres"), "sql_valid": True}

    return {"sql_valid": True}
```

### 4.3 SQL 执行 + Repair

```python
# src/graph/nodes/sql_run.py
from src.tools.db import readonly_query

def run_node(state: DataState) -> dict:
    try:
        rows = readonly_query(state["sql"], timeout_s=30)
        return {"rows": rows, "row_count": len(rows)}
    except Exception as e:
        return {"rows": None, "sql_error": str(e), "sql_valid": False}

# src/graph/nodes/repair.py
REPAIR_PROMPT = """以下 SQL 在 PostgreSQL 上执行失败：
SQL:
{sql}
错误：{error}

可用 schema：
{schema}

修正后输出新的 SQL（仅 SQL，不要解释）。"""

def repair_node(state: DataState) -> dict:
    if state["repair_count"] >= 3:
        return {"sql_valid": False, "sql_error": "repair exhausted"}
    new_sql = LLM.invoke(REPAIR_PROMPT.format(
        sql=state["sql"],
        error=state["sql_error"],
        schema=_fmt(state["schema_chunks"]),
    )).content.strip()
    return {"sql": new_sql, "repair_count": state["repair_count"] + 1}
```

### 4.4 Plot Picker

```python
# src/graph/nodes/plot.py
import plotly.express as px

def pick_chart(plan: dict, rows: list[dict]) -> dict:
    n_dims = len(plan["dims"])
    n_metrics = len(plan["metrics"])
    time_dim = next((d for d in plan["dims"] if "date" in d or "month" in d), None)

    if time_dim and n_metrics == 1:
        return {"type": "line", "x": time_dim, "y": plan["metrics"][0]}
    if n_dims == 1 and n_metrics == 1:
        return {"type": "bar", "x": plan["dims"][0], "y": plan["metrics"][0]}
    if n_dims == 2 and n_metrics == 1:
        return {"type": "heatmap", "x": plan["dims"][0],
                "y": plan["dims"][1], "z": plan["metrics"][0]}
    return {"type": "table"}

def plot_node(state: DataState) -> dict:
    spec = pick_chart(state["plan"], state["rows"])
    if spec["type"] == "table":
        return {"chart_spec": spec, "chart_path": None}
    df = _to_df(state["rows"])
    fig = getattr(px, spec["type"])(df, **{k: v for k, v in spec.items() if k != "type"})
    path = f"/tmp/{state['session_id']}.png"
    fig.write_image(path)
    return {"chart_spec": spec, "chart_path": path}
```

### 4.5 评测配置

```yaml
# tests/eval/config.yaml
dataset: tests/eval/data/questions.json
benchmark: bird-sql / spider2  # 引用基线
metrics:
  - id: sql_first_pass_rate
    type: code
    func: tests.eval.checks.first_pass
  - id: sql_after_repair_rate
    type: code
    func: tests.eval.checks.after_repair
  - id: exec_match
    type: code                    # 与 golden SQL 结果集对比
    func: tests.eval.checks.exec_match
  - id: forbidden_block_rate
    type: code                    # 100% 必拦
    func: tests.eval.checks.forbidden_block
ci:
  fail_under:
    sql_first_pass_rate: 0.65
    sql_after_repair_rate: 0.85
    exec_match: 0.80
    forbidden_block_rate: 1.0
```

## 5. 评测设计

### 5.1 数据集

| 类别 | 数量 | 来源 |
| --- | --- | --- |
| Easy（单表 + 简单聚合） | 30 | 内部分析师常见问题 |
| Medium（多表 join） | 20 | 同上 |
| Hard（窗口函数 / CTE） | 15 | 真实业务复杂查询 |
| 业务术语对抗 | 10 | "周活" / "拉新成本" 等行话 |
| 危险 SQL 注入 | 10 | "drop table users; --" |

可直接套 BIRD-SQL / Spider 2.0 子集作为参考基线（README 链接）。

### 5.2 指标

| 指标 | 通过线 | 说明 |
| --- | --- | --- |
| SQL 首次通过率 | ≥ 65% | dry-run 即通过 |
| 修复后通过率 | ≥ 85% | ≤ 3 轮 repair 后 |
| 结果集匹配率 | ≥ 80% | 与 golden SQL 结果一致 |
| 危险 SQL 拦截率 | **100%** | 红线 |
| 中位延迟 | ≤ 15s | |
| Plot 选型一致率 | ≥ 80% | 与人工选择一致 |

## 6. 上线考虑

### 6.1 数据安全

| 措施 | 实现 |
| --- | --- |
| 只读账号 | DB user `agent_ro`，仅 SELECT |
| 白名单 schema | `whitelist.yaml` 配置 + lint 强制 |
| 行级权限 | 在 view 层包 RLS，Agent 不感知 |
| 字段脱敏 | view 层 `mask(phone)` |
| 审计 | 每次 SQL 落 `agent_audit` 表 |

### 6.2 与 BI / IM 集成

| 平台 | 集成 |
| --- | --- |
| Slack | slash command + button "explain SQL" |
| 飞书 | 卡片消息 + 图片附件 |
| Web App | Streamlit 内嵌 |
| Metabase / Superset | 直接生成 question / chart 配置 |

### 6.3 缓存与性能

- 同问题 hash 命中缓存 5 min
- schema embedding 每日刷新
- 长查询（>30s）异步队列 + 回调

### 6.4 用户教育

- 每次回复附"如何提问更准"提示（弱)
- "👎 结果不对" → 收集到 mislabel 集 → 周度回归

## 7. Trade-off 讨论：Few-shot vs Schema-RAG

| 维度 | Few-shot（库内置示例）| Schema-RAG（选） |
| --- | --- | --- |
| 上下文成本 | 固定 ~5k token | 按问题召回，可控 |
| 扩展 1000 张表 | prompt 装不下 | 召回 top-k |
| 业务术语 | 难塞 | 同义词文件 + 检索 |
| 新表上线 | 改 prompt | 重建索引 |
| 准确率（中等库）| 与 RAG 相当 | 略高 5–10 pp |

> "百表以下 few-shot 够用，百表以上必须 RAG。"——Vanna.AI 经验。

## 常见坑

1. **字段名歧义**：`amount` 在订单表和退款表都有 → schema 检索把表名一起塞进去，prompt 明确指代。
2. **时间窗口口语**："上周"在周一问 vs 周日问含义不同 → narrative 反问或默认 ISO 周。
3. **结果太大**：返回 100w 行打爆前端 → 强制 LIMIT + "结果过大已截断"提示。
4. **DISTINCT 漏写**：用户问"有多少用户"，SQL 用了 COUNT(*) → plan 强调"distinct on which key"。
5. **plot 选型错**：百万级时序硬画 line 卡死 → 先 downsample。
6. **业务方读不懂 SQL**：narrative 不带 SQL 解释 → narrative 节点附"这条 SQL 在做什么"3 行。
7. **危险 SQL 绕过**：用户在自然语言里偷渡 `; DROP TABLE` → 不可能，因为 LLM 重新生成；但要警惕 prompt 注入诱导 LLM 生成。Lint 必须严格。
8. **多方言**：写好 PostgreSQL，迁 ClickHouse 时全错 → 在生成节点显式注入方言。

## 下一步

- 下个项目：[§07 知识库 Agent](./07-kb-agent.md)（RAG 主战场）
- 复习 RAG：[`../rag-advanced/04-hybrid-retrieval.md`](../rag-advanced/04-hybrid-retrieval.md)
- 工具安全：[`../llm-security/06-tool-safety.md`](../llm-security/06-tool-safety.md)
- Vanna.AI / PandasAI 参考实现（README 链接）
- 评测：[`../eval/05-frameworks.md`](../eval/05-frameworks.md)
