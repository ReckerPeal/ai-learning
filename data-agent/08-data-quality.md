# 08 · 数据质量与清洗

"垃圾进，垃圾出"在 LLM 时代加倍：**LLM 不会告诉你这列其实有 30% 缺失**——它会自信地用 70% 的数据算出一个数字，并叙事化包装。生产 Data Agent 必须把数据质量做成"第一类公民"——profiling、缺失值、异常值、schema drift 全要自动化。本章给出 LLM-assisted 的工程方案。

## 1. 数据质量的六个维度

| 维度 | 定义 | 检查 |
| --- | --- | --- |
| Completeness | 缺失值占比 | `df.isnull().mean()` |
| Validity | 是否合法（格式、范围）| 正则、CHECK 约束 |
| Uniqueness | 主键是否唯一 | `df['id'].nunique() == len(df)` |
| Consistency | 表间/列间逻辑一致 | join 后矛盾检查 |
| Timeliness | 数据新鲜度 | `max(updated_at)` vs SLA |
| Accuracy | 是否反映真实 | 抽样 + 业务核对 |

前 5 个能自动；第 6 个永远靠人。LLM 主要帮你做前 5 个的"自动 profiling + 一段叙事化的总结"。

## 2. Profiling：进入 Agent 前的第一步

### 2.1 标准 profiling 报告

```python
"""
Profiling：用 pandas-profiling / ydata-profiling 或自家轻量实现。
"""
def profile(df) -> dict:
    out = {"nrow": len(df), "ncol": len(df.columns), "columns": {}}
    for col in df.columns:
        s = df[col]
        info = {
            "dtype": str(s.dtype),
            "missing_pct": s.isnull().mean(),
            "unique": s.nunique(dropna=True),
            "sample": s.dropna().head(3).tolist(),
        }
        if pd.api.types.is_numeric_dtype(s):
            info.update({
                "min": float(s.min()),
                "max": float(s.max()),
                "mean": float(s.mean()),
                "p50": float(s.median()),
                "p99": float(s.quantile(0.99)),
                "zero_pct": (s == 0).mean(),
            })
        if pd.api.types.is_object_dtype(s) and s.nunique() < 30:
            info["value_counts"] = s.value_counts().head(10).to_dict()
        out["columns"][col] = info
    return out
```

### 2.2 LLM-assisted profiling

让 LLM 看 profiling 输出，**生成自然语言诊断**：

```text
你是数据质量审计员。下面是一个 DataFrame 的 profiling 输出（JSON）：

{profile_json}

请给出：
1. **风险等级** (low/medium/high)
2. **关键问题 Top 5**（每条 ≤ 25 字）
3. **建议**（清洗步骤的列表，可直接交给 LLM 执行）

【输出格式】JSON
```

输出示例：

```json
{
  "risk": "medium",
  "issues": [
    "email 列 12% 缺失",
    "amount 列存在负值（-3 条），疑似退款记账错误",
    "phone 列格式混乱：含 11/13/15 位",
    "created_at 类型为 object，需 parse",
    "region 列有 4 种拼写：'华东'/'华 东'/'East'/'east'"
  ],
  "actions": [
    "df = df.dropna(subset=['email'])",
    "df = df[df['amount'] > 0]  # 或单独保留为退款表",
    "df['phone'] = df['phone'].str.replace(r'\\D', '', regex=True)",
    "df['created_at'] = pd.to_datetime(df['created_at'], errors='coerce')",
    "df['region'] = df['region'].str.strip().str.lower().map({'east':'华东','华东':'华东'})"
  ]
}
```

**关键设计**：actions 必须是**可直接执行的代码**——下一步直接喂到 §07 的 Code Interpreter 跑。

## 3. 缺失值

| 模式 | 处理 |
| --- | --- |
| 缺失 < 5% 且非关键列 | 直接 dropna |
| 缺失 5–30% 数值 | 均值 / 中位数 / 插值（业务允许时）|
| 缺失 5–30% 类目 | 单独 `'Unknown'` 类目 |
| 缺失 > 30% | 报警告，不自动处理 |
| 时间序列缺失 | 前向填充 / 插值 |

**Agent 行为约束**：

```text
关于缺失值处理：
1. 缺失率 > 30% 的列不要直接 drop，先告知用户
2. 数值列填充必须用 median 而非 mean（防 outlier 影响）
3. 时间序列必须用 ffill 或时间插值，不要用 mean
4. 任何填充操作必须 print 出 "filled {n} NaN in {col}"
```

## 4. 异常值

```python
"""
异常值检测：IQR + Z-score 双判，业务列允许单独 rule。
"""
def outliers(df, col):
    s = df[col].dropna()
    q1, q3 = s.quantile(0.25), s.quantile(0.75)
    iqr = q3 - q1
    iqr_mask = (s < q1 - 1.5*iqr) | (s > q3 + 1.5*iqr)
    z = (s - s.mean()) / s.std()
    z_mask = z.abs() > 3
    return iqr_mask | z_mask
```

**业务规则常胜于统计**：

- 订单金额 `> 100 万` 报警告（B2C 上限合理）
- 用户年龄 `< 0 或 > 120` 直接置 null
- 折扣率 `> 100%` 必错

每张表建一份 `business_rules.yaml`：

```yaml
orders:
  amount_cents: {min: 0, max: 100000000, action: "warn"}
  discount_pct: {min: 0, max: 1, action: "reject"}
users:
  age:    {min: 0, max: 120, action: "set_null"}
  email:  {regex: "^[\\w.+-]+@[\\w-]+\\.[\\w.-]+$", action: "set_null"}
```

LLM 读 rules → 生成清洗代码。

## 5. Schema Drift

最坑的不是错——是"昨天还对的今天突然错了"。常见 drift：

| Drift | 例 |
| --- | --- |
| 列改名 | `user_id` → `uid` |
| 类型变 | `amount` 从 int 变 string（带千分位）|
| 枚举新增 | `status` 加了 `'frozen'`，下游 case 没覆盖 |
| 时区变 | 上游切到 UTC，下游还按本地时间过滤 |
| 单位变 | 金额从"分"变"元"，缩了 100 倍 |

### 5.1 自动检测

每天对比"今日 profiling"与"昨日 profiling"：

```python
def diff_profile(today, yesterday):
    diffs = []
    today_cols = set(today["columns"].keys())
    y_cols     = set(yesterday["columns"].keys())
    for c in y_cols - today_cols:
        diffs.append({"type": "column_removed", "col": c})
    for c in today_cols - y_cols:
        diffs.append({"type": "column_added", "col": c})
    for c in today_cols & y_cols:
        t, y = today["columns"][c], yesterday["columns"][c]
        if t["dtype"] != y["dtype"]:
            diffs.append({"type": "dtype_changed", "col": c, "from": y["dtype"], "to": t["dtype"]})
        if abs(t.get("mean", 0) - y.get("mean", 0)) / max(abs(y.get("mean", 1)), 1) > 0.5:
            diffs.append({"type": "mean_shift", "col": c, "from": y["mean"], "to": t["mean"]})
    return diffs
```

**接告警**：drift 检出 → 工程 + 数据 + LLM Agent 全部停服待复核（不要让 Agent "硬跑"出错数字）。

### 5.2 工具栈

| 工具 | 用途 |
| --- | --- |
| Great Expectations | 数据契约 + 校验 |
| dbt tests | warehouse 内置 |
| Soda Core | YAML 写规则 |
| Monte Carlo / Bigeye | SaaS，"数据可观测性" |
| 自家 + LLM | 灵活但维护成本 |

成熟仓库强烈推荐 **Great Expectations + dbt tests** 双层，LLM Agent 作为"自然语言查 expectations 失败原因"的增强。

## 6. Cleansing Agent：端到端

```python
"""
LLM 驱动的清洗 Agent。
1) profile -> 2) diagnose -> 3) generate cleaning code -> 4) execute -> 5) re-profile -> 6) report
"""
def cleansing_agent(df):
    profile_before = profile(df)
    diagnosis = llm.invoke(DIAG_PROMPT.format(p=profile_before)).content
    diagnosis = json.loads(diagnosis)

    actions = diagnosis["actions"]
    # 在 sandbox 里跑
    code = "\n".join(actions)
    df_cleaned = run_in_sandbox(df, code)

    profile_after = profile(df_cleaned)
    report = llm.invoke(REPORT_PROMPT.format(
        before=profile_before, after=profile_after, diagnosis=diagnosis
    )).content

    return df_cleaned, diagnosis, report
```

**重要**：

- diagnosis 与 cleaning code **必须给用户审阅**才能跑——禁止"全自动悄悄改你的数据"
- 每个清洗动作 log "before/after row count + dtype changes"，用户能 audit

## 7. PII 与脱敏

数据进 LLM 前要识别 PII（姓名、手机、邮箱、身份证、银行卡）：

| 工具 | 适用 |
| --- | --- |
| Microsoft Presidio | OSS，多语言 PII 检测 |
| Amazon Macie | AWS S3 上 PII 扫描 |
| 正则 + LLM 二审 | 自家轻量 |

工程做法：

```python
"""
PII 检测：列名 + sample value 两路。
"""
PII_REGEX = {
    "phone_cn": r"1[3-9]\d{9}",
    "email":    r"[\w.+-]+@[\w-]+\.[\w.-]+",
    "id_cn":    r"\d{17}[\dXx]",
}
PII_NAME = re.compile(r"phone|email|mobile|id_?card|name|address", re.I)

def detect_pii_columns(df):
    flagged = {}
    for col in df.columns:
        if PII_NAME.search(col):
            flagged[col] = "name_match"
        sample = df[col].dropna().astype(str).head(20).tolist()
        for label, rgx in PII_REGEX.items():
            if any(re.search(rgx, v) for v in sample):
                flagged[col] = label
    return flagged
```

检出 PII → 默认**不喂 LLM 真实值**，只喂列名 + 类型；如果业务确实需要分析（如手机号归属地），脱敏（hash / 掩码）后再喂。详见 [`../llm-security/04-data-leak.md`](../llm-security/04-data-leak.md)。

## 8. 数据契约（Data Contract）

把 schema + 期望写成**契约**，上下游都遵守：

```yaml
# contracts/orders.yaml
table: analytics.orders
owner: order-team
columns:
  - name: id
    type: bigint
    constraints: [primary_key, not_null]
  - name: user_id
    type: bigint
    constraints: [not_null, foreign_key(users.id)]
  - name: status
    type: varchar
    constraints: [not_null, in(['pending','paid','refunded','cancelled'])]
  - name: amount_cents
    type: bigint
    constraints: [not_null, ">=", 0]
  - name: created_at
    type: timestamp
    constraints: [not_null]
slas:
  freshness: "1 hour"
  completeness: 0.999
```

LLM Agent 读契约 → 知道 status 只有 4 个枚举（同 §03 的 value retrieval）+ schema drift 时与契约对比就知道哪条违约。

## 9. Profiling 输出给 NL2SQL：闭环

把 profiling 结果**回馈到 §02 的 schema 注入**：

```
分析师执行 LLM Agent 第一次时：
  1) profile 一次
  2) 把 missing_pct、enum_values、unit 注入到 schema doc
  3) 后续 SQL 生成都有这些上下文

举例：amount_cents 列注释里加 "12% NULL，单位=分（人民币）"
     → LLM 自动 / 100、自动 dropna
```

这是**质量 → Agent 性能**的直接转化。

## 10. 真实例子：从烂数据到可分析

**输入**：客户上传 `orders.csv`，30 万行，10 列。

**Profiling 摘要（LLM 生成）**：

```
风险等级：medium

主要问题：
1. user_id 列含 1.2% 字符串（应为数字）
2. amount 列疑似单位混乱（分布双峰：1-1000 和 100-100000）
3. status 列 6 种取值，与契约 4 个枚举不一致：多了 'PAID'、'REFND'（疑似拼写错）
4. created_at 类型 object，需 parse；含 5 行 1970-01-01（unix epoch 0）
5. country 列 80% 为空

建议清洗：
- df['user_id'] = pd.to_numeric(df['user_id'], errors='coerce')
- df = df.dropna(subset=['user_id'])
- df['status'] = df['status'].str.lower().replace({'paid':'paid', 'refnd':'refunded'})
- df['created_at'] = pd.to_datetime(df['created_at'], errors='coerce')
- df = df[df['created_at'] > '2000-01-01']
- # amount 双峰建议人工确认是否两种单位混合
```

**执行后 re-profile**：

```
- 行数：300,000 → 295,400（删了 4,600 行：user_id 异常 + epoch 时间）
- amount 双峰未处理，HITL 标记
- status 4 个合法枚举，与契约一致
- created_at 全部 valid datetime
```

数据可用，**保留处理 log**，业务方能复核。

## 常见坑

1. **盲目 dropna**：删掉 30% 数据还在算 GMV——LLM 当 100% 算，业务方看不出。**强制告知 drop 数**。
2. **填充用 mean**：有 outlier 时 mean 飘——比如某条 1 亿元订单把 mean 拉到 5000。**用 median**。
3. **不查 schema drift**：上游悄悄改字段，Agent 跑出错数字一周后才发现。**自动 drift detection + 告警**。
4. **PII 直接进 LLM context**：手机号被 logging / cached 到 OpenAI。**先检测后脱敏**。
5. **质量问题闷头清理不告诉用户**：业务方拿数字时不知道原始 12% 缺失。**所有清洗动作必须 surface**。

## 下一步

- [02 · SQL Agent](./02-sql-agent.md) — Profiling 输出回写到 schema 注入。
- [09 · 多源数据](./09-multi-source.md) — 多源场景下质量问题更复杂。
- [`../llm-security/04-data-leak.md`](../llm-security/04-data-leak.md) — PII / 敏感数据进入 LLM 上下文的风险与防御。
- 工具：Great Expectations、dbt tests、Soda Core、Microsoft Presidio。
- 论文 / 标准：Data Contracts、PipelineDP（差分隐私）。
- 调度场景下的契约执行：[`../eval/09-ci-and-regression.md`](../eval/09-ci-and-regression.md)。
