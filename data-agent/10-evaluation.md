# 10 · 评测

"我们的 NL2SQL 准确率 90%。" 业务方："哪个准确率？execution match 还是 exact match？数据集是 Spider 还是你们自己的？包不包含 join 复杂题？"——这就是 Data Agent 必须把评测当一类公民的原因。本章讲：评测维度、Spider/BIRD 怎么跑、自家 golden set 怎么搭、code 可读性怎么量、上线后的 online 评测。

## 1. 评测维度全表

| 维度 | 度量 | 工具 / 实现 |
| --- | --- | --- |
| **Valid SQL Rate** | 可 parse / 可执行 | sqlglot / DB execute |
| **Execution Accuracy (EX)** | 结果集与 gold 一致 | DB diff |
| **Exact Set Match (EM)** | SQL 结构相同（去别名）| Spider 官方脚本 |
| **Component Match** | join / where / group by 各对 | Spider 官方 |
| **Test Suite Accuracy (TS)** | 多组测试数据均一致 | Spider 2.0 |
| **代码可读性** | 列别名、CTE 命名、注释 | LLM-as-judge + rubric |
| **延迟** | end-to-end p50/p95 | 自己 log |
| **成本** | $/query | token 计数 |
| **业务对齐率** | 业务方点对 | 反馈系统 |
| **安全** | 越权 / 注入 / 写操作率 | 静态扫描 + audit |

**生产唯一的硬指标是"业务对齐率"**——前面所有指标是代理（proxy）。

## 2. Spider / BIRD：必跑基准

### 2.1 Spider 1.0（10K 题，200 库，跨域）

- 论文：Yu et al. 2018
- 主页：<https://yale-lily.github.io/spider>
- 难度：Easy / Medium / Hard / Extra
- 当前 SOTA：execution accuracy ~92%（gpt-4 + DAIL-SQL）

跑法：

```python
"""
Spider 跑分骨架（伪码，需要下载数据集）。
"""
import json, sqlite3
from pathlib import Path

def run_spider_eval(your_agent, spider_dir: Path):
    with open(spider_dir/"dev.json") as f:
        examples = json.load(f)
    results = []
    for ex in examples:
        db = spider_dir/"database"/ex["db_id"]/(ex["db_id"]+".sqlite")
        schema = load_schema(db)
        pred_sql = your_agent.generate(ex["question"], schema)
        results.append({
            "question": ex["question"],
            "gold":  ex["query"],
            "pred":  pred_sql,
            "db":    str(db),
        })
    # 用官方脚本算 EM/EX
    return compute_metrics(results, official_script_path)
```

### 2.2 BIRD（最难、最像生产）

- 论文：Li et al. 2023
- 主页：<https://bird-bench.github.io/>
- 特点：**含外部知识（业务定义）**、**真实复杂 schema**、**模糊问题**
- 当前 SOTA：execution accuracy ~70%（CHESS / MAC-SQL 类）

**为什么 BIRD 更重要**：

- 题里带 "evidence"（业务知识），考验 Agent 用辅助文档
- schema 真实的脏（命名乱、注释缺）
- 题面歧义大

BIRD 的 70% 对照 Spider 的 90%——**差的 20% 全是企业真实场景**。生产 Agent 应该重点优化 BIRD 风格。

### 2.3 Spider 2.0（2024 发布）

企业级仓库（BigQuery / Snowflake / DuckDB），含多语言、跨数据库、行级安全题。**目前 SOTA execution accuracy 不到 30%**——表明这是 Agent 的真前沿。

## 3. Execution Accuracy 怎么实现

不是"字符串比对" SQL，而是"跑两份 SQL 看结果集是否等价"：

```python
"""
Execution Accuracy 核心：两份 SQL 跑结果是否一致。
"""
def execution_match(pred_sql: str, gold_sql: str, db_path: str) -> bool:
    con = sqlite3.connect(db_path)
    try:
        p = con.execute(pred_sql).fetchall()
        g = con.execute(gold_sql).fetchall()
    except Exception:
        return False
    # 结果集等价：多集（multiset）相等
    return sorted(map(repr, p)) == sorted(map(repr, g))
```

**坑**：

- 浮点容差：金额计算 0.1 误差不该算错 → `math.isclose(..., rel_tol=1e-6)`
- ORDER BY 不同但题面要求排序 → 不能忽略顺序
- LIMIT 不同 → 要求 LIMIT 也对

Spider 官方脚本处理这些细节，直接复用。

## 4. 自家 Golden Set

公共 benchmark 不够——业务术语、口径、私有 schema 不一样。**自家 200 条 golden questions 比 Spider 全套都重要**。

### 4.1 怎么搭

| 来源 | 数量 | 备注 |
| --- | --- | --- |
| 历史工单 / Slack 提问 | 50 | 真实需求 |
| 业务方人工 brainstorm | 50 | 覆盖未问到的角度 |
| 数据团队"想抓的题" | 50 | 包含复杂 case |
| 历史报错 Agent 答错的 | 50 | 反例 |

每条：

```yaml
- id: q_001
  question: "上月华东 GMV"
  difficulty: easy
  tags: [time-window, region, gmv]
  gold_sql: |
    SELECT SUM(amount_cents)/100 AS gmv
    FROM orders o JOIN users u ON o.user_id=u.id JOIN regions r ON u.region_id=r.id
    WHERE r.area='华东' AND o.status='paid'
      AND o.created_at >= date_trunc('month', current_date - interval '1 month')
      AND o.created_at <  date_trunc('month', current_date);
  expected_rows: 1
  expected_columns: ["gmv"]
  approved_by: data-team
  approved_at: 2026-04-01
```

### 4.2 评测脚本

```python
"""
跑 golden set 全集，输出每题对错 + 总分。
"""
def run_golden_eval(agent, golden_yaml: str, conn) -> dict:
    cases = yaml.safe_load(open(golden_yaml))
    results = []
    for c in cases:
        try:
            pred = agent.run(c["question"])
            pred_rows = conn.execute(pred["sql"]).fetchall()
            gold_rows = conn.execute(c["gold_sql"]).fetchall()
            ex_match = compare_rows(pred_rows, gold_rows)
        except Exception as e:
            ex_match, pred = False, {"sql": "", "error": str(e)}
        results.append({
            "id": c["id"], "difficulty": c["difficulty"],
            "tags": c["tags"], "ex_match": ex_match,
            "pred_sql": pred.get("sql"),
        })
    return aggregate(results)
```

### 4.3 维度切分

不要只看总分。**按 tag 看**：

| Tag | Accuracy | 备注 |
| --- | --- | --- |
| simple-aggregation | 96% | 良 |
| time-window | 88% | 需加宏 |
| multi-table-join | 72% | schema linking 弱 |
| business-metric | 65% | 缺语义层 |
| window-function | 50% | 重点优化 |

每个 tag 跟一个工程方向。

## 5. 代码可读性评测

业务方会**修 SQL**——不可读的 SQL 等于不可用。Rubric：

```yaml
readability_rubric:
  cte_naming:        # CTE 名是否有语义？
    weight: 0.20
    score: [0, 0.5, 1]
  column_alias:      # SELECT 列别名是否清晰？
    weight: 0.20
  formatting:        # 缩进、换行
    weight: 0.10
  comments:          # 复杂逻辑是否有注释？
    weight: 0.10
  cte_vs_subquery:   # 用 CTE 还是嵌套？
    weight: 0.20
  metric_names:      # 业务术语是否对齐？
    weight: 0.20
```

LLM-as-judge：

```text
你是 SQL 评审。请按 rubric 给以下 SQL 打分。

【问题】{question}
【SQL】{sql}
【rubric】{rubric_json}

输出 JSON，每项 0 / 0.5 / 1 + 一句理由。
```

详见 [`../eval/04-llm-as-judge.md`](../eval/04-llm-as-judge.md) 的 judge 校准方法。

## 6. Agent-level 评测（多步）

NL2SQL 直接出 SQL；Data Agent 可能多步（retrieve schema → generate → execute → recover）。**组件级**评测：

| 组件 | 度量 | 数据 |
| --- | --- | --- |
| Schema linking | recall@k（gold tables 命中率）| golden set 标注 |
| SQL gen | EX / EM | golden + Spider |
| Error recovery | 失败题中 recovery 成功率 | 故意注入错例 |
| Chart selection | type accuracy | 自家可视化 golden |
| Insight | LLM-judge + 业务点击率 | 报告反馈 |

详见 [`../eval/07-agent-eval.md`](../eval/07-agent-eval.md)。

## 7. 上线后：Online Evaluation

Offline 评测告诉你"上线前能到 80%"。上线后真实分布会变。监控：

| 指标 | 实现 |
| --- | --- |
| 业务方点赞 / 点踩 | 前端按钮 → 入库 |
| SQL 执行成功率 | exec log |
| 平均 retry 次数 | Agent log |
| 触发 HITL 的比例 | HITL log |
| latency p50/p95 | tracing |
| 成本 / 次 | LLM API 计费 + DB 计费 |

每周看一次，**点踩样本必须人工 review** → 进 golden set（反例）→ 下一版优化。详见 [`../eval/08-online-and-ab.md`](../eval/08-online-and-ab.md)。

## 8. CI / Regression

每次改 prompt / 换模型 / 改 schema 注入策略 → 跑 golden set。

```yaml
# .github/workflows/eval.yml
name: data-agent-eval
on: [pull_request]
jobs:
  golden-eval:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pip install -r requirements.txt
      - run: python eval/run_golden.py --threshold 0.85
      - run: python eval/run_spider_subset.py --threshold 0.70
```

**阈值是硬门**——低于阈值阻塞合并。详见 [`../eval/09-ci-and-regression.md`](../eval/09-ci-and-regression.md)。

## 9. 真实评测报告示例

```
=== Data Agent v0.7 评测报告 ===

总体（golden 200 题）：
- Execution Accuracy: 81.5% (163/200)
- Valid SQL Rate:     99.0% (198/200)
- 平均 retry:          1.3 次
- 平均 latency:        4.2s（p95: 9.1s）
- 成本 / 次：           $0.012

按 tag：
- simple-agg:          96.0%
- time-window:         88.0%
- multi-table-join:    72.0%
- business-metric:     65.0%  ← 重点
- window-function:     50.0%

外部基准：
- Spider 1.0 (dev):    78.3%
- BIRD (dev):          54.2%

可读性（n=50 抽样）：
- CTE 命名 0.78
- 列别名   0.65
- 注释     0.20  ← 重点

回归对比 v0.6：
- 总 EX:  79.0% → 81.5% (+2.5pp) ✓
- multi-table-join: 65% → 72% (+7pp，schema-linking 改造生效)
- business-metric: 60% → 65% (语义层接 5/20 指标)

下一步优化方向：
1. window-function：加 few-shot 5 条
2. business-metric：把剩下 15 个指标接入语义层
3. SQL 注释：在 prompt 加 "复杂 join 需加 inline comment"
```

**每月发一次给业务方 + 工程**——透明度。

## 10. 评测的"评测"

评测自己也会错。两个 sanity check：

| 风险 | 应对 |
| --- | --- |
| Gold SQL 本身错 | 双人 review + 业务方核数 |
| Execution match 漏判（顺序敏感）| 人工 review 一批 false positive |
| LLM-judge 有偏差 | 用 inter-rater agreement (kappa)，跟人对齐 |
| 数据分布偏离生产 | 每月把生产真实 query 抽 50 条补进 golden |

## 常见坑

1. **只看 EX 总分**：80% 看着不错——但 business-metric 类只有 50%，业务方最常问的就是这类。**必须按 tag 看**。
2. **Spider 跑 90%，自家垮**：Spider 的 schema 简单清洁——真实仓库脏。**自家 golden 才是真分**。
3. **没 negative test**：故意写错 SQL 看 Agent 能否 recover。**注入错例**。
4. **Judge 自己幻觉**：LLM-judge 给 0.9 分但人审是 0.5。**抽样人审校准**。
5. **评测脱节于业务反馈**：线下 84%、业务方点踩率 30%。**点踩样本必须进 golden**。

## 下一步

- [02 · SQL Agent](./02-sql-agent.md) — 评测信号反哺 prompt 设计。
- [03 · NL2SQL 进阶](./03-nl2sql-advanced.md) — 按 tag 拆 Spider / BIRD 难点。
- [`../eval/07-agent-eval.md`](../eval/07-agent-eval.md) — 组件级评测方法论。
- [`../eval/08-online-and-ab.md`](../eval/08-online-and-ab.md) — 上线后 A/B 与监控。
- [`../eval/09-ci-and-regression.md`](../eval/09-ci-and-regression.md) — 把 golden set 入 CI。
- 数据集：Spider <https://yale-lily.github.io/spider>、BIRD <https://bird-bench.github.io/>、Spider 2.0 <https://spider2-sql.github.io/>、DS-1000 <https://ds1000-code-gen.github.io/>。
- 论文：DIN-SQL、DAIL-SQL、CHESS、MAC-SQL、BIRD（[README 资源](./README.md#资源)）。
