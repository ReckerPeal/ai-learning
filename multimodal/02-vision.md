# 02 · 图像理解

图像理解是多模态的入门，但坑也最多。本章把 VQA、OCR、定位、计数、比较这五大场景过一遍，**重点在工程化**而不是 demo。

## 1. 任务分类速查

| 任务 | 输入 | 输出 | 难度 | 推荐模型 |
| ---- | ---- | ---- | ---- | -------- |
| VQA（视觉问答） | 图 + 问题 | 文本 | 低 | 任意主流 VLM |
| Captioning | 图 | 描述文本 | 低 | 任意 |
| OCR（印刷） | 图 | 文本 | 中 | GPT-4o / Claude / Qwen-VL |
| OCR（手写 / 杂场景） | 图 | 文本 | 高 | 专用 OCR + VLM 校验 |
| 物体定位（bbox） | 图 + 类别 | 坐标 | 中-高 | Qwen-VL / Gemini / Molmo |
| 计数 | 图 + 类别 | 数字 | **高** | 专用模型；VLM 仅 < 10 个 |
| 图像比较 | 多图 | 差异描述 | 中 | Claude / GPT-4o |
| 属性抽取 | 图 | 结构化 JSON | 中 | 任意 + 严格 schema |

## 2. VQA：最基础也最容易翻车

```python
from openai import OpenAI
client = OpenAI()

resp = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": [
        {"type": "text", "text": "图中有几个人在跑？他们朝什么方向？"},
        {"type": "image_url", "image_url": {
            "url": "https://example.com/marathon.jpg",
            "detail": "high",   # ← 数字相关任务必须 high
        }},
    ]}],
)
print(resp.choices[0].message.content)
```

**Prompt 模式经验**：

| 模式 | 例子 | 适用 |
| ---- | ---- | ---- |
| 直接问 | "图里有什么？" | 探索性 |
| 角色扮演 | "你是质检员，找出图中的瑕疵。" | 检验场景 |
| 强制结构化 | "输出 JSON：{物体, 位置, 颜色}" | 入库 |
| 思维链 | "先描述图，再回答问题。" | 复杂推理 |
| 自我校验 | "回答后再检查一遍是否漏数。" | 计数 / 列举 |

## 3. OCR：VLM 的杀手锏

VLM 的 OCR **能力已经超过传统 OCR + LLM 校正**的组合，尤其在多语言、表格、混排上。

| 场景 | VLM 表现 | 备注 |
| ---- | -------- | ---- |
| 印刷书籍 | 极强 | 接近完美 |
| 中文手写 | 中 | 草书仍翻车 |
| 收据 / 发票 | 强 | 但金额数字偶尔错位 |
| 复杂表单（多列对齐） | 中 | 需要 prompt 引导 |
| 古籍 / 草书 | 弱 | 必须 fine-tune |
| 自然场景文字（招牌等） | 强 | GPT-4o / Gemini 优秀 |

```python
prompt = """
你是一个 OCR 引擎，输出图片中所有文字。要求：
1. 保留原始换行与缩进。
2. 表格用 Markdown 表示。
3. 不要解释、不要补充、不要润色。
4. 无法识别的字用 [?] 占位。
"""
```

**铁律**：让 VLM 做 OCR 时，**禁止它"理解"文本**，否则它会把"5,000"自动改成"5000"或反向。

## 4. 物体定位（bbox prompts）

不是所有 VLM 都能输出坐标。下表是 2025 年实测：

| 模型 | bbox 支持 | 坐标系 | 备注 |
| ---- | --------- | ------ | ---- |
| Qwen2.5-VL | 原生支持 | 0-1000 归一化 | 最强、最稳定 |
| Gemini 2.0 | 原生支持 | 0-1000 | 文档官方推荐 |
| GPT-4o | 不可靠 | 像素 | 经常瞎写 |
| Claude 3.5 | 不可靠 | 像素 | 同上 |
| Molmo / InternVL | 支持 | 多种 | 自部署优选 |

```python
# Qwen2.5-VL bbox 输出
prompt = """
找出图中所有"红色按钮"，输出 JSON：
[{"label": "按钮", "bbox_2d": [x1, y1, x2, y2]}, ...]
坐标使用 0-1000 归一化。
"""
```

**前端可视化时**：把归一化坐标 ×（图片实际宽高）/ 1000 还原。

## 5. 计数：VLM 的死穴

> **超过 10 个就别信 VLM 的计数。** 这不是 prompt 能救的。

| 数量级 | VLM 准确率 | 推荐做法 |
| ------ | ----------- | -------- |
| 1-5 | 95%+ | 直接问 |
| 6-10 | 80% | prompt 加思维链 |
| 11-30 | 50-70% | 切片后分批 + 求和 |
| 30+ | < 50% | 用专用检测模型（YOLO + count） |

**切片求和** 思路：

```python
from PIL import Image

def count_in_grid(img_path, prompt, rows=2, cols=2):
    img = Image.open(img_path)
    w, h = img.size
    total = 0
    for r in range(rows):
        for c in range(cols):
            box = (c*w//cols, r*h//rows, (c+1)*w//cols, (r+1)*h//rows)
            tile = img.crop(box)
            n = vlm_count(tile, prompt)   # 单格调用 VLM
            total += n
    return total
```

边界物体可能被切成两半，工程上常**双数 + 求平均**。

## 6. 图像比较 / 差异检测

多图输入是 VLM 的进阶能力。各家上限：

| 模型 | 单次最大图片数 | 推荐 |
| ---- | --------------- | ---- |
| GPT-4o | 50（实际 < 10 稳定） | ≤ 4 |
| Claude 3.5 | 100（实际 < 20 稳定） | ≤ 5 |
| Gemini 2.0 | 3600（按视频帧） | ≤ 16 静态图 |
| Qwen2.5-VL | 限于 token | 看上下文 |

```python
# Claude 多图比较
import anthropic, base64, pathlib

ac = anthropic.Anthropic()
def img_block(p):
    data = base64.b64encode(pathlib.Path(p).read_bytes()).decode()
    return {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": data}}

resp = ac.messages.create(
    model="claude-3-5-sonnet-latest",
    max_tokens=1024,
    messages=[{"role": "user", "content": [
        {"type": "text", "text": "图 A 是上线前，图 B 是上线后。列出 UI 差异。"},
        {"type": "text", "text": "[图 A]"},
        img_block("before.png"),
        {"type": "text", "text": "[图 B]"},
        img_block("after.png"),
    ]}],
)
```

**文字标记每张图**（"[图 A]"）能显著降低模型混淆。

## 7. Prompt 设计要点

| 要点 | 做法 |
| ---- | ---- |
| 图片放在哪 | OpenAI / Claude：图后接问题；Gemini：先文后图也可。**先放图通常更稳**。 |
| 多图引用 | 给图片显式编号（A/B/1/2）。 |
| 输出结构 | 用 JSON Schema / Pydantic 强约束。 |
| 限制猜测 | 加一句"如不确定输出 `unknown`，禁止编造"。 |
| Few-shot | 1-2 个图文示例显著提升结构化抽取。 |
| 拒答处理 | "若图片质量太差，输出 `{\"error\": \"low_quality\"}`"。 |

## 8. 多图输入的限制

实战中遇到的真坑：

- **多图比较时模型会"串图"**：把图 A 的内容算到图 B 头上。
- **Claude 上限是 20MB / 请求**，多图要压缩。
- **GPT-4o 把每张图单独 patch**，多图时 token 涨得飞快。
- **Gemini 视频 16 帧 = 16 张图**，预算要算清。

## 9. 一段端到端示例：发票字段抽取

```python
from openai import OpenAI
from pydantic import BaseModel
import base64, pathlib

class Invoice(BaseModel):
    invoice_no: str
    date: str
    seller: str
    buyer: str
    amount: float
    tax: float | None
    items: list[dict]

client = OpenAI()
img = base64.b64encode(pathlib.Path("invoice.png").read_bytes()).decode()

resp = client.beta.chat.completions.parse(
    model="gpt-4o-2024-08-06",
    messages=[{"role": "user", "content": [
        {"type": "text", "text": "提取发票字段。无法识别的字段填 null，禁止编造。"},
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img}", "detail": "high"}},
    ]}],
    response_format=Invoice,
)
inv = resp.choices[0].message.parsed
print(inv.amount, inv.items)
```

**关键点**：用 `response_format=Pydantic` 强约束 schema，比靠 prompt "请输出 JSON" 稳得多。

## 常见坑

- **detail=low 看不清小字**。OCR / 数字相关任务一定要 `detail: high`，再贵也得开。
- **多图不加显式编号**。模型会自动"按顺序"，但顺序在 API 里其实不稳。
- **相信 VLM 的计数**。3 个鸡蛋它能数对，30 个就开始猜。专用模型 + VLM 校验才是正道。
- **图压缩太狠**。微信小图（800×600）发票看不清字；保持长边 ≥ 1568 px。
- **输出"自由文本"再后处理**。一定要用结构化 schema，正则解析在生产环境必翻车。

## 下一步

- [03 · 文档理解](./03-documents.md) — 把 OCR 能力扩展到 PDF / 扫描件。
- [04 · 表格与图表](./04-charts.md) — 结构化输入的硬场景。
- [08 · 多模态 Agent](./08-multimodal-agent.md) — 视觉 + 工具循环。
- [10 · 评测与生产化](./10-production.md) — 怎么评估 VQA 系统。
