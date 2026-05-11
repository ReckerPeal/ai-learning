# 06 · 报告生成

"问一句出张图"只是 Data Agent 的 1.0；2.0 是**"每天 9 点自动给我一份昨日业务摘要"**。本章讲：报告的结构、Insight Extraction、Markdown / PPT / 飞书 / Notion 几种输出形态，以及调度、版本、复盘的工程闭环。

## 1. 报告 vs 查询

| 维度 | 查询（§02-§05）| 报告 |
| --- | --- | --- |
| 触发 | 用户发问 | 调度（cron / 事件）|
| 长度 | 几行 + 1 张图 | 多段 + 多图 + 数字摘要 |
| 受众 | 自己 | 老板 / 跨部门 |
| 重点 | 准确 | 准确 + **叙事 + 洞察** |
| 风险 | 数错单次 | 错了发 200 人 = 公关事故 |

**核心新增能力**：

- **叙事生成**：把表格数字翻译成"上月华东 GMV 1,250 万元，环比 +12%"
- **Insight Extraction**：从一堆数字里挑出"最值得讲的 3 件事"
- **结构化输出**：Markdown / PPT / 飞书 / 邮件，多端一致
- **模板与版本**：每周报模板能演进、可回溯

## 2. 标准模板

```
# 业务日报｜2026-05-10

## 一句话摘要
华东 GMV 达 412 万，环比 +18%，活跃用户数突破 50 万创年内新高。

## 关键指标
| 指标 | 今日 | 昨日 | 环比 | 上周同日 | 同比 |
| --- | --- | --- | --- | --- | --- |
| GMV     | 412 万 | 349 万 | +18% | 352 万 | +17% |
| 订单数  | 23,180 | 19,400 | +19% | 20,100 | +15% |
| 活跃用户| 50.2 万 | 45.1 万 | +11% | 46.0 万 | +9% |
| 复购率  | 28.3% | 27.1% | +1.2pp | 27.5% | +0.8pp |

## 洞察 Top 3
1. 华东 GMV 创新高，主要驱动是 SKU-1234 (+340%)，疑似某 KOL 带货
2. 复购率连续 7 天提升，与上周上线的 vip-callback 活动时间吻合
3. 西南区域订单数同比 -8%，需重点关注（图见附）

## 详细数据
（每个指标一张图 + 一段说明）
...

## 数据口径
- GMV 定义：见 metrics/gmv（v3 起扣除全额退款）
- 时间窗：2026-05-10 00:00 ~ 24:00（UTC+8）
- 数据生成：2026-05-11 05:30，pipeline=daily_v17

## 反馈
对本日报有疑问？回复邮件或点击 [反馈链接]。
```

**结构化部分（指标表、口径）来自 SQL**；**叙事部分（一句话摘要、洞察）由 LLM 生成**；**版本字段（pipeline=...）由调度系统注入**。

## 3. 三段式生成 pipeline

```
┌────────────┐   ┌─────────────────┐   ┌──────────────┐
│ 1. 数据层  │ → │ 2. 洞察层 (LLM) │ → │ 3. 渲染层    │
└────────────┘   └─────────────────┘   └──────────────┘
跑 SQL              生成"3 条洞察"        Jinja / Marp / 飞书 API
得指标 + 图         + 一句话摘要          
```

每层独立可测，独立可缓存。

## 4. Insight Extraction：让 LLM 别瞎说

最大的坑：LLM 看数字"自由发挥"——编原因、编趋势。约束：

| 约束 | 实现 |
| --- | --- |
| 数字必须来自数据 | 把数据 JSON 化喂 prompt，禁止 LLM "估算" |
| 不能编原因 | prompt 写明"只描述，不臆测原因" |
| 显著性阈值 | 环比变化 < 5% 不入选；样本数 < 30 不入选 |
| 同类合并 | 3 条洞察都讲 GMV 太重复，启发式去重 |

```text
你是数据日报的洞察生成助手。给定下面的数据，输出**最多 3 条**洞察。

【数据】
{json_dump_of_all_metrics}

【硬约束】
1. 每条洞察必须引用具体数字，且数字必须出现在上方数据里
2. 不要推测原因；如果要给假设，前面加"疑似/可能"
3. 环比 / 同比变化绝对值 < 5% 的不要写
4. 样本数 < 100 的细分维度不要写（统计噪声）
5. 三条洞察必须覆盖不同维度（不能都讲同一个指标）
6. 每条 ≤ 40 字

【输出格式】
[
  {"text": "...", "metric": "...", "value": "...", "change": "..."},
  ...
]
```

**最关键的一条**：数字必须出现在喂的数据里——**生成后 regex 检查**：每个数字字符串都能在 input 里 grep 到。失败 → 重生成。

## 5. 数字幻觉验证

LLM 写"GMV 1,253 万"，但实际是 1,250 万——这种小幻觉日积月累毁信任。验证策略：

```python
"""
洞察数字校验：每个数字必须能在源数据里找到。
"""
import re

def validate_insight(text: str, source_data: dict) -> list[str]:
    errors = []
    numbers = re.findall(r'[\d,]+\.?\d*', text)
    flat = str(source_data)
    for n in numbers:
        norm = n.replace(',', '')
        # 允许 ±0.5% 浮动（四舍五入引起）
        try:
            num = float(norm)
            if not any(abs(float(m.replace(',', '')) - num) / max(num, 1) < 0.005
                       for m in re.findall(r'[\d,]+\.?\d*', flat)):
                errors.append(f"幻觉数字: {n}")
        except ValueError:
            pass
    return errors
```

进生产前**每条洞察必须过校验**，否则丢回 LLM 重写。

## 6. 渲染层：Markdown / PPT / 飞书 / 邮件

### 6.1 Markdown（基线）

Jinja 模板 + 数据填充：

```python
from jinja2 import Template

TPL = Template("""\
# 业务日报｜{{ date }}

## 一句话摘要
{{ summary }}

## 关键指标
| 指标 | 今日 | 昨日 | 环比 |
| --- | --- | --- | --- |
{% for m in metrics -%}
| {{ m.name }} | {{ m.today }} | {{ m.yesterday }} | {{ m.mom }} |
{% endfor %}

## 洞察 Top {{ insights | length }}
{% for i in insights -%}
{{ loop.index }}. {{ i.text }}
{% endfor %}
""")

print(TPL.render(date="2026-05-10", summary="...", metrics=[...], insights=[...]))
```

### 6.2 PPT

两条路：

| 方案 | 优 | 劣 |
| --- | --- | --- |
| python-pptx | 全控 | 写起来繁琐 |
| Marp（Markdown → PPT）| 一份 md 出两种 | 排版死板 |

Marp 示例：

```markdown
---
marp: true
theme: default
---
# 业务日报｜2026-05-10
---
## 关键指标
- GMV: 412 万 (+18%)
- 订单: 23,180 (+19%)
![bg right](gmv.png)
```

`marp file.md --pptx` → 直接出 PPT。

### 6.3 飞书 / 钉钉 / Slack

飞书富文本 / 钉钉卡片 / Slack Block Kit 都是 JSON。LLM 输出统一的 IR（intermediate representation），各端各自渲染：

```json
{
  "blocks": [
    {"type": "h1", "text": "业务日报 2026-05-10"},
    {"type": "summary", "text": "华东 GMV 达 412 万..."},
    {"type": "table", "headers": [...], "rows": [...]},
    {"type": "image", "url": "https://cdn/...png", "alt": "GMV 趋势"},
    {"type": "bulletlist", "items": [...]}
  ]
}
```

下游各有 renderer。这层抽象**几乎不可省**——业务方会同时要求飞书 + 邮件 + Notion。

### 6.4 邮件

邮件天生 HTML 不友好（Outlook 渲染坑、暗色模式）。推荐：

- 用 **MJML** 写邮件模板（编译到 inline CSS）
- 图片用 `cid:` 内联（避免被防火墙拦截）
- 表格用 `<table>` 而非 flexbox（Outlook 渲染稳）

## 7. 调度 + 失败处理

| 层 | 工具 | 注意 |
| --- | --- | --- |
| 调度 | Airflow / Dagster / Prefect / cron | 失败重试、SLA 告警 |
| pipeline 编排 | dbt + 调度的 task | 数据先就绪再生成报告 |
| Agent runtime | LangGraph + checkpoint | LLM 调用失败可断点续 |
| 通知 | 飞书机器人 / SES / PagerDuty | 报告失败比报告错更严重 |

**绝对禁止"silent fail"**：报告挂了不发，业务方第二天发现的时候你已经丢了信任。设置：

- 报告挂 → **立即发"报告生成失败"占位 + 工程值班告警**
- 报告生成但置信度低 → 加红色 banner"今日数据存疑，需人工复核"

## 8. 多份报告：模板库

一家公司通常有 10–30 份周期性报告。维护成本爆炸。模板化：

```yaml
# reports/daily_gmv.yaml
name: daily_gmv
schedule: "0 5 * * *"
audience: ["sales-leadership@", "data-team@"]
output: ["lark", "email"]
metrics:
  - gmv
  - orders_count
  - active_users
  - repurchase_rate
charts:
  - {type: line, metric: gmv, window: "last_30d"}
  - {type: bar,  metric: orders_count, group_by: region}
insights:
  count: 3
  llm: "gpt-4o-mini"
  filters: [significant_only, no_speculation]
template: templates/standard_daily.md.j2
```

LLM 在固定字段内填空，工程上只维护 YAML + 模板。新增一份报告 = 抄一份 YAML。

## 9. 反馈闭环

业务方点"赞 / 踩 / 看不懂" → 直接进**报告 quality 数据集**：

```yaml
report_id: daily_gmv_2026-05-10
insights:
  - text: "华东 GMV 创新高..."
    feedback: "thumbs_up"
  - text: "西南区订单 -8%..."
    feedback: "thumbs_down"
    reason: "西南 KA 上月就停了，数字正常下降"
```

负反馈样本进入 **"反例集"**，下次 prompt 加："以下情况已知不应作为洞察：..."。**反馈闭环是报告质量持续提升的唯一路径**。

## 10. 实战例子（端到端）

```python
"""
端到端日报 pipeline：从 SQL 到飞书。
为简化省略 import / 配置；生产请用 Airflow + 各模块单测。
"""

def run_daily_report(date: str):
    # 1. 跑 SQL，取所有指标
    metrics = run_metric_queries(date)
    charts  = generate_charts(metrics)              # §05

    # 2. LLM 生成摘要 + 洞察
    summary = llm.invoke(SUMMARY_PROMPT.format(metrics=metrics)).content
    insights_raw = llm.invoke(INSIGHT_PROMPT.format(metrics=metrics)).content
    insights = json.loads(insights_raw)

    # 3. 校验数字幻觉
    for i in insights:
        errs = validate_insight(i["text"], metrics)
        if errs:
            i["text"] = regenerate(i, errs)

    # 4. 渲染 + 发送
    ir = build_ir(date, summary, metrics, insights, charts)
    md = render_markdown(ir)
    upload_to_lark_doc(md, audience=["sales-leadership"])
    send_email(ir, audience=["data-team@"])

    # 5. 记录版本
    log_report_version(date, ir_hash=hash(ir))
```

## 常见坑

1. **直接把 SQL 结果喂 LLM 让它"总结"**：LLM 会胡说。**先抽指标、再校验、再叙事**。
2. **图越多越好**：业务方一页能看 3 张图就极限。**3 张图原则**。
3. **没有"无变化日"的 fallback**：今天 GMV 跟昨天一样，LLM 强行编"稳定增长"。**显著性阈值过滤后允许"无显著变化"作为洞察**。
4. **数字格式不一致**：上面千分位、下面小数 4 位。**统一 format 配置**。
5. **没版本号**：业务方上周看到 412 万，今天发现是 410 万——重跑了？口径变了？**所有报告必须带 `report_version + pipeline_run_id`**。

## 下一步

- [05 · 可视化生成](./05-visualization.md) — 报告里的图怎么出。
- [02 · SQL Agent](./02-sql-agent.md) — 报告的数据从哪来。
- [10 · 评测](./10-evaluation.md) — 报告质量的度量（洞察准确率、业务方满意度）。
- [`../eval/04-llm-as-judge.md`](../eval/04-llm-as-judge.md) — LLM 作为"洞察评审"。
- [`../langgraph/`](../langgraph/) — 多步报告生成的状态机 + checkpoint。
- 工具栈：dbt（数据层）、Airflow（调度）、Marp（PPT）、MJML（邮件）、飞书 OpenAPI。
