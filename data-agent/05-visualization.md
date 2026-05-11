# 05 · 可视化生成

让 LLM 出图比让它写 SQL 更微妙：**图表类型选错就是 100% 错**，颜色配错、坐标轴错、legend 缺失都会让业务方不信。本章讲：图表类型推荐、Matplotlib / Plotly / Vega-Lite 三条路、Microsoft Lida / Chat2Plot 的工业做法，以及"可交互"前端的工程边界。

## 1. 三条主路

| 路径 | 输出 | 优势 | 劣势 |
| --- | --- | --- | --- |
| Matplotlib（PNG）| 静态图 | 装机即用 | 不可交互 |
| Plotly（HTML / JSON）| 交互式 | hover、缩放 | 体积大 |
| **Vega-Lite（JSON）** | 声明式 | LLM 友好（生成 JSON 而非代码）| 表达力略弱 |

**推荐**：

- 后端报表（邮件、PPT）→ Matplotlib
- Web 产品（BI Copilot）→ **Vega-Lite**（让 LLM 生 JSON，前端渲染）
- Notebook EDA → Plotly

Vega-Lite 是真正的"数据可视化的 SQL"——后续 §3 详谈。

## 2. 图表类型推荐：让 LLM 别瞎选

业务最常犯的错误：

| 数据形态 | 错的图 | 对的图 |
| --- | --- | --- |
| 1 个时间序列 | 柱状图 | 折线图 |
| 类目对比 ≤ 7 | 饼图（< 7 类还行）| 横向条形图 |
| 类目对比 > 7 | 饼图（灾难）| 横向条形图 |
| 占比 + 时间 | 多条折线 | 堆叠面积图 / 100% 堆叠柱 |
| 两数值相关 | 折线 | 散点图 + 趋势线 |
| 三维（X/Y/类目）| 堆叠条形图 | 分组条形图 / 小倍数（small multiples）|
| 地理分布 | 普通柱状 | choropleth 地图 |

**让 LLM 先选图、再生成**：

```text
你正在为问题"{question}"生成图表。
已知结果数据（前 5 行）：
{data_preview}
列与类型：{schema}

第一步：在以下图表类型中选 1 个，并说明理由：
- line / area / bar / barh / pie / scatter / histogram / heatmap / map

输出 JSON：{"chart": "...", "reason": "..."}
```

然后第二步再生成具体的 spec / 代码。**两步比一步准确率高**（Lida 论文有验证）。

## 3. Vega-Lite：声明式 + LLM 最友好

Vega-Lite 是一个 JSON DSL：

```json
{
  "data": {"values": [{"region": "华东", "gmv": 1250}, ...]},
  "mark": "bar",
  "encoding": {
    "x": {"field": "region", "type": "nominal", "sort": "-y"},
    "y": {"field": "gmv", "type": "quantitative", "title": "GMV (万元)"},
    "color": {"field": "region", "type": "nominal", "legend": null}
  },
  "title": "Q1 各区域 GMV"
}
```

LLM 生成这个 JSON 比生成 Plotly Python 容易得多——**没有 import、没有 plt.figure() 副作用，纯数据**。

### 3.1 生成 prompt

```text
你将生成一个 Vega-Lite v5 规范（JSON），用于回答用户问题。

【用户问题】{question}
【数据（最多 1000 行）】{rows_json}
【列与类型】{schema}

【硬约束】
1. 输出严格 JSON，外面不要有 markdown 代码块标记
2. mark 从 [bar, line, area, point, rect] 中选
3. type 用 nominal / ordinal / quantitative / temporal
4. 标题简洁明确
5. 颜色不要写死十六进制，让 Vega 自选 schema
6. 时间序列 x 轴用 temporal
7. 类目 > 12 用横向条形（bar，x 数值 y 类目）
```

### 3.2 验证 spec

LLM 生成 JSON 后**先 parse 再渲染**：

```python
import json, jsonschema
import requests

VEGA_LITE_SCHEMA = requests.get(
    "https://vega.github.io/schema/vega-lite/v5.json"
).json()

def validate_vl(spec: dict) -> str | None:
    try:
        jsonschema.validate(spec, VEGA_LITE_SCHEMA)
        return None
    except jsonschema.ValidationError as e:
        return str(e)[:500]
```

错了 → 把 error 回喂 LLM 修（同 §02 的 retry-with-error 模式）。

### 3.3 前端渲染

```javascript
import vegaEmbed from "vega-embed";
vegaEmbed("#chart", spec, { actions: false });
```

一行 npm 包搞定。比起 Plotly 的 JS bundle，Vega-Lite 体积小一半。

## 4. Matplotlib：经典稳

适合后端出 PNG（邮件、PPT、Notion）。让 LLM 生成代码而非 JSON：

```python
"""
Matplotlib Prompt + 执行。
"""
PROMPT = """\
用 matplotlib 画图回答问题"{question}"。
数据已加载为 DataFrame `df`，列：{schema}。

要求：
1. 中文字体已设好（plt.rcParams['font.sans-serif'] = ['Noto Sans CJK SC']）
2. 图大小 (8, 4.5)
3. 必须有 title、xlabel、ylabel
4. y 轴数字 > 1000 用千分位
5. 保存到 'out.png'，dpi=120，bbox_inches='tight'
6. 不要 plt.show()
"""
```

中文字体是大坑。Linux 服务器上常缺中文字体——预装 `fonts-noto-cjk` 并在镜像里 cache 字体路径。

## 5. Lida（Microsoft）：工业级 NL2Viz

Microsoft 的 [Lida](https://github.com/microsoft/lida) 把图表生成拆成 4 步：

```
Q: 用户问题
  │
  ▼
Summarize: 让 LLM 对 DataFrame 出一份"数据概要"（每列含义、统计、潜在 outlier）
  │
  ▼
Goals: LLM 提出 3–5 个"可视化目标"
  │
  ▼
VisGenerate: 每个目标生成代码（matplotlib / plotly / seaborn / altair）
  │
  ▼
Evaluate: LLM 自评 + 用户选
```

可借鉴的点：

- **summarize 是离线一次性的**——大数据集上做完缓存，后续问答复用
- **goals 显式列出来**让业务方"选一张图"，比直接出图准确率高
- **多候选 + 评分**比单候选好

Chat2Plot 走类似思路但更轻——只用 Plotly + JSON schema。

## 6. 图表 prompt 模板（综合版）

```text
你是数据可视化助手。先选图、再生成 Vega-Lite 规范。

【问题】{question}
【数据 schema】{schema}
【数据样本】{head_5}
【行数】{nrow}

【第 1 步：选图】
- 单变量分布 → histogram
- 时间序列 → line（短序列用 area）
- 类目对比 ≤ 12 → bar
- 类目对比 > 12 → barh（top N）
- 两变量相关 → point（散点）
- 矩阵 → rect（热力图）
- 占比 ≤ 5 类 → arc（饼图）；> 5 类 → bar

【第 2 步：生成 Vega-Lite v5 JSON】
- 必须包含 title
- 时间轴 type=temporal，给定 format
- 数值轴加 axis.format（千分位 ",.0f"，百分比 ".1%"）
- 类目过多时 x 轴 labelAngle=-45
- 颜色 scheme 选 "tableau10" 或 "category20"

【输出】
{"chart_type": "...", "reason": "...", "spec": { ... Vega-Lite ... }}
```

## 7. 可视化与数据 pipeline 衔接

完整 Chat-BI 的 pipeline：

```
question
  │
  ▼
SQL Agent → rows                 ← §02-§03
  │
  ▼
Chart Type Selector → "bar"      ← §6
  │
  ▼
Spec Generator → Vega-Lite JSON  ← §3
  │
  ▼
Validator → ok / error→retry     ← §3.2
  │
  ▼
Front-end Embed                  ← §3.3
  │
  ▼
"Show SQL / Edit Chart" 按钮       ← 业务方信任
```

每一步独立可测：SQL 准确率、chart-type 准确率、spec 合法率、最终业务对齐率。

## 8. 自由编辑 vs 受控生成

| 模式 | 例子 | 风险 |
| --- | --- | --- |
| 自由代码（LLM 写 matplotlib）| OpenAI Code Interpreter | 灵活但难做交互 |
| 受控 spec（LLM 填 Vega-Lite）| Wren AI / Lida | 业务方可在前端继续改 |
| 模板填空 | "只能选已注册的 5 种图" | 最稳，覆盖率低 |

**生产建议**：核心场景受控 spec，"高级模式"才放代码。让前端有"编辑图表"按钮，业务方改坐标轴、改颜色 → 改完的 spec 又能存为模板复用。

## 9. 真实例子：从问题到 Vega-Lite

**问题**："Q1 各区域 GMV 占比"

**LLM 选图**：

```json
{"chart_type": "arc", "reason": "类目数=5（≤7），适合饼图展示占比"}
```

**生成 spec**：

```json
{
  "$schema": "https://vega.github.io/schema/vega-lite/v5.json",
  "title": "Q1 各区域 GMV 占比",
  "data": {"values": [
    {"region": "华东", "gmv": 1250000},
    {"region": "华南", "gmv":  980000},
    {"region": "华北", "gmv":  870000},
    {"region": "西南", "gmv":  450000},
    {"region": "其他", "gmv":  220000}
  ]},
  "mark": {"type": "arc", "innerRadius": 60},
  "encoding": {
    "theta": {"field": "gmv", "type": "quantitative"},
    "color": {
      "field": "region", "type": "nominal",
      "scale": {"scheme": "tableau10"}
    },
    "tooltip": [
      {"field": "region", "type": "nominal"},
      {"field": "gmv", "type": "quantitative", "format": ",.0f"}
    ]
  }
}
```

**校验**：通过 Vega-Lite schema → 渲染。

**业务方在前端点"换柱状图"** → spec 的 mark 从 `arc` 改 `bar`，encoding 加 `x: region`、`y: gmv` → 一秒切换。

## 10. 多图 / 仪表盘

业务方一句话出 3 张图（dashboard）是常见需求。两种实现：

| 实现 | 思路 |
| --- | --- |
| Layered Vega（vconcat / hconcat） | LLM 生成嵌套 spec，单个 JSON 渲染多图 |
| 多次 Agent call | 把问题拆 3 个子问题，各跑一次 |

`vconcat` / `hconcat` / `facet` 是 Vega 的原生组合机制，LLM 学得动；但拆子问题更易调试。**生产倾向后者**。

## 常见坑

1. **饼图给 20 个类目**：完全不可读。**> 7 类自动转 barh top-10 + others**。
2. **时间轴 type 错**：用 nominal 而非 temporal → x 轴乱序。**强制 dtype 检查后再选 type**。
3. **千分位 / 百分比格式**：业务方一看 `1250000.0` 立刻关闭页面。**format 必填**。
4. **中文字体缺失**：服务器渲染中文变方块。**Dockerfile 装 fonts-noto-cjk**。
5. **LLM 自创字段名**：spec 里写了 `revenue`，数据里只有 `gmv`。**spec validator 同时校验字段是否存在**。

## 下一步

- [06 · 报告生成](./06-report-generation.md) — 把图嵌进 Markdown / PPT / Notion。
- [04 · Pandas Agent](./04-pandas-agent.md) — Matplotlib 的执行链路。
- [07 · Code Interpreter](./07-code-interpreter.md) — sandbox 里跑 Plotly / Vega + 文件下载。
- Lida 论文：<https://arxiv.org/abs/2303.02927>
- Vega-Lite 官方文档：<https://vega.github.io/vega-lite/>
- Chat2Plot：<https://github.com/nyanp/chat2plot>
- 评测：[10 · 评测](./10-evaluation.md) 章节有 chart-type accuracy 的度量。
