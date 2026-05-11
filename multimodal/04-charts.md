# 04 · 表格与图表

表格和图表是文档里的**信息密度黑洞**：一张图的语义可能等于一页文字。但 VLM 在这两者上的表现充满陷阱，本章把雷区一一过清。

## 1. 任务谱系

| 任务 | 输入 | 输出 | 难度 | 推荐路径 |
| ---- | ---- | ---- | ---- | -------- |
| 表格识别（结构） | 表格图 | 行列结构 | 中 | Table Transformer / PaddleOCR-PP-Structure |
| 表格 → JSON / Markdown | 表格图 | 结构化数据 | 中-高 | VLM + Schema |
| 图表理解（描述） | 图表图 | 文字概括 | 低 | 任意 VLM |
| Chart → Table（数据反提） | 图表图 | 表格 | 高 | 专用模型 / VLM |
| 图表问答 | 图表 + 问题 | 文本 | 中 | VLM |
| 多图表对比 | 多张 | 文本 / 表 | 高 | VLM + 提示工程 |

## 2. 表格识别：先结构后内容

**正确顺序**：先识别表格的**行列骨架**（哪些线、哪些合并），再填**单元格内容**。

| 模型 | 类型 | 强项 |
| ---- | ---- | ---- |
| Table Transformer（微软） | 结构 + 单元格 | 学术表格 |
| PaddleOCR PP-Structure | 中文 / 工程版 | 中文报表 |
| Tabby / Camelot | 规则（PDF 文字层） | 数字版 PDF |
| GPT-4o / Claude | VLM 全栈 | 复杂版式 |

```python
# pip install paddleocr
from paddleocr import PPStructure
import cv2

table_engine = PPStructure(layout=False, show_log=False)
result = table_engine(cv2.imread("financial_table.png"))
for region in result:
    if region["type"] == "table":
        print(region["res"]["html"])    # 还原成 HTML 表
```

## 3. VLM 出表格 → JSON 的标准做法

```python
from openai import OpenAI
from pydantic import BaseModel
import base64, pathlib

class Row(BaseModel):
    指标: str
    Q1: float | None
    Q2: float | None
    Q3: float | None
    Q4: float | None

class Table(BaseModel):
    title: str
    rows: list[Row]

client = OpenAI()
img = base64.b64encode(pathlib.Path("table.png").read_bytes()).decode()

resp = client.beta.chat.completions.parse(
    model="gpt-4o-2024-08-06",
    messages=[{"role": "user", "content": [
        {"type": "text", "text": (
            "把表格转成结构化数据。\n"
            "- 数值去掉千分位逗号、单位\n"
            "- 空格 / `-` / `N/A` 一律输出 null\n"
            "- 不要四舍五入、不要插值\n"
        )},
        {"type": "image_url", "image_url": {
            "url": f"data:image/png;base64,{img}", "detail": "high"
        }},
    ]}],
    response_format=Table,
)
table = resp.choices[0].message.parsed
```

**Schema 约束 > Prompt 约束**。在表格场景，二者结合才稳定。

## 4. 合并单元格陷阱

合并单元格是表格识别的**头号杀手**。常见情况：

| 形态 | 处理 |
| ---- | ---- |
| 横向合并（标题分组） | 按层级展开，子列继承父名 |
| 纵向合并（同类项） | 重复填充值到所有行 |
| 斜线表头 | 拆为两个字段 |
| 跨页延续表 | 第二页表头补全 |

**实战**：让 VLM 显式输出"展开后"的形式，禁止用 `colspan/rowspan`：

```text
要求：把所有合并单元格展开为完全填充的方阵，不允许出现"同上"、"——"等占位。
```

## 5. 图表理解：先分类再深入

| 图表类型 | VLM 准确率 | 难点 |
| -------- | ----------- | ---- |
| 柱状图 | 高 | 数值精度 |
| 折线图 | 中 | 多线缠绕、读数 |
| 饼图 | 高 | 标签遮挡 |
| 散点图 | 中 | 点数多就丢 |
| 雷达图 | 中 | 轴方向迷惑 |
| 桑基图 / 矩形树图 | 低 | 关系提取乱 |
| 热力图 | 中 | 数值靠颜色 |
| K 线 | 低 | 专业领域弱 |

**第一招**：先让模型回答"这是什么图、有几条数据序列、坐标轴是什么"，**再**问数据。

## 6. Chart → Table 数据反提

最难的子任务，也是最有商业价值的——把图变回数据，下游就能算。

| 工具 | 类型 | 效果 |
| ---- | ---- | ---- |
| **DePlot**（Google） | 专用 | 标准图表强 |
| **ChartQA / OneChart** | 专用 | 学术/财报 |
| **GPT-4o / Claude / Gemini** | 通用 VLM | 简单图表强、复杂翻车 |
| **Qwen2.5-VL** | 通用 VLM + bbox | 数据点多时较好 |

```python
prompt = """
你是图表数据提取器。任务：把图变回原始数据表。
要求：
1. 输出 CSV，第一列是 X 轴值，后续列是每条曲线
2. 数值精度按图中刻度推断（坐标轴最小刻度）
3. 无法读出的点输出 ?，不要猜
4. 输出前先列出"每条曲线对应什么标签"
"""
```

**经验值**：5-10 个数据点的简单柱状图，GPT-4o 准确率 ~90%；超过 30 点的折线图掉到 50% 以下。

## 7. 数字精度问题（数轴读不准）

VLM "看"图表时**不会用刻度计算**，是估计值。后果：

| 图特征 | 误差幅度 |
| ------ | -------- |
| 坐标轴有完整刻度 + 数值 | ±5% |
| 只有部分刻度 | ±10-20% |
| 无刻度（只有标签） | ±30% 起 |
| 对数轴 | 灾难 |

**减小误差技巧**：
- Prompt 强调"以坐标轴最小刻度为单位"。
- 让模型先输出"X 轴范围 / Y 轴范围 / 每格数值"，再读点。
- 关键数字必须用文本标注（数据标签）才信任 VLM 输出。

## 8. VLM vs 专用模型决策矩阵

| 场景 | VLM | 专用模型（DePlot 等） |
| ---- | --- | --------------------- |
| 一次性、几张图 | 选 VLM | 部署成本不值 |
| 每天 10 万张 | 太贵 | 选专用 |
| 图表样式多变 | 选 VLM | 专用模型泛化弱 |
| 学术 / 财报固定样式 | 都行 | 专用更稳 |
| 中文图表 | Qwen / GPT-4o | DePlot 中文一般 |

## 9. 端到端示例：研报图表入库

```python
# 抽取 → 结构化 → 入库（Postgres + pgvector）
import json, base64, pathlib
from openai import OpenAI

def extract_chart(image_path: str) -> dict:
    img = base64.b64encode(pathlib.Path(image_path).read_bytes()).decode()
    resp = OpenAI().chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": [
            {"type": "text", "text": (
                "提取图表数据，输出 JSON：\n"
                "{type, title, x_axis, y_axis, series: [{name, points: [[x, y], ...]}]}\n"
                "无法读出的 y 用 null。"
            )},
            {"type": "image_url", "image_url": {
                "url": f"data:image/png;base64,{img}", "detail": "high"
            }},
        ]}],
        response_format={"type": "json_object"},
    )
    return json.loads(resp.choices[0].message.content)

# 入库时同时存：原图 / 抽取的 JSON / VLM 写的 caption
# 检索时：caption 走 BM25，JSON 走结构化查询，原图走 ColPali（§05）
```

## 10. 多图表对比

| 模式 | 做法 |
| ---- | ---- |
| 同公司多年财报 | 先各自抽 → 程序对比，不要让模型直接"看出趋势" |
| 多公司同期对比 | 抽数据 → SQL group by；让 VLM 写洞察 |
| 不同图风格 | 都标准化为同 JSON schema，再入库 |

**核心原则**：**让 VLM 提取，让代码计算**。绝不让模型自己心算。

## 11. 与下游分析的衔接

抽出来的结构化数据通常进入分析管道：

- → 入数据库（Postgres / DuckDB / ClickHouse）
- → 进 RAG（文本 caption + JSON 数据双索引）
- → 进 BI（Metabase / Grafana）
- → 进 data-agent（让 LLM 写 SQL 查这张表，参考即将的 data-agent 主题）

## 常见坑

- **直接信任 VLM 报出的数字**。任何超过 2 位有效数字的关键决策都必须人工 / 程序复核。
- **让 VLM 直接做"分析"**。让它写"销售额上升 12%"——它没真的算，是猜的。先抽后算。
- **schema 太松**。`amount: str` 让模型把 "1,234.5 万元" 整段塞进来，下游处理崩掉。用强类型 + 单位字段。
- **合并单元格用 colspan**。下游程序要再解析一遍，直接展开成方阵更简单。
- **小图喂 VLM**。图表里的数字标签 < 10px 时，VLM 几乎读不出，先放大或重新生成大图。

## 下一步

- [05 · 多模态 RAG](./05-multimodal-rag.md) — 表格 / 图表入库后怎么检索。
- [09 · 模型选型](./09-model-selection.md) — 各家 VLM 在图表任务上的强弱。
- [10 · 评测与生产化](./10-production.md) — 图表抽取的精度评测。
- [03 · 文档理解](./03-documents.md) — 图表通常嵌在文档里，先看上游。
