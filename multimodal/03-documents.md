# 03 · 文档理解

文档处理是 2025 年企业 AI 应用的**最大单一场景**：合同、发票、研报、招股书、专利、医疗病历……都是文档。本章只讲**怎么把 PDF 变成 LLM 能理解的结构化内容**，RAG 部分见 §05 与 [`../rag-advanced/08-multimodal-and-structured.md`](../rag-advanced/08-multimodal-and-structured.md)。

## 1. 文档类型分类

| 类型 | 特征 | 处理路径 | 难度 |
| ---- | ---- | -------- | ---- |
| 数字版 PDF（导出） | 文字层完整 | 直接抽文字 | 低 |
| 扫描件 PDF | 全是图片 | OCR / VLM 直读 | 中 |
| 双栏 / 多栏 | 学术论文 / 报刊 | 版式还原 + 重排 | 中 |
| 含表格 / 公式 | 财报 / 学术 / 教材 | 专用模型 | 高 |
| 手写笔记 | 病历 / 答题卡 | 专用 OCR + VLM | 极高 |
| 混合（部分扫描） | 合同 / 政府文件 | 检测后分流 | 高 |

**第一步永远是检测**：这份 PDF **有没有文字层**？有就走 PyMuPDF；没有才走 OCR。

```python
import pymupdf  # PyMuPDF

def has_text_layer(pdf_path):
    doc = pymupdf.open(pdf_path)
    text = "".join(p.get_text() for p in doc)
    return len(text.strip()) > 100   # 经验阈值
```

## 2. 三条主路径对比

| 路径 | 说明 | 优 | 劣 | 推荐场景 |
| ---- | ---- | -- | -- | -------- |
| **纯 OCR** | Tesseract / PaddleOCR / 云 OCR | 便宜、可离线 | 不懂版式、表格丢结构 | 大量、单一格式 |
| **VLM 直读** | 整页喂给 VLM | 懂版式、能问答 | 贵、长文档 token 爆 | 少量、复杂版式 |
| **混合管道** | 版式分析 + OCR + VLM 校验 | 精度高、可控 | 工程复杂 | 生产级 |

**生产推荐**：**混合管道**。先用 layout 模型切区域，文本走 OCR、表格 / 公式走专用模型、复杂区域走 VLM。

## 3. 工具矩阵（2025 实测）

| 工具 | 类型 | 强项 | 弱项 |
| ---- | ---- | ---- | ---- |
| **Marker** | PDF→Markdown | 速度快、表格还原好 | 复杂版面有错位 |
| **Docling**（IBM 开源） | 全栈管道 | 集成度高、社区活跃 | 中文 OCR 一般 |
| **MinerU**（上海 AI Lab） | 中文优化 | 中文 / 公式 / 双栏 | 装环境痛苦 |
| **unstructured** | 通用 loader | 格式覆盖最广 | 精度中等 |
| **LlamaParse**（云服务） | 商用 API | 即开即用 | 按页计费 |
| **Tesseract** | 经典 OCR | 老牌、免费 | 中文需训练 |
| **PaddleOCR** | OCR | 中文最强 | 不还原版式 |
| **GPT-4o / Claude / Gemini** | VLM 直读 | 一站式 | 贵、长文档不行 |

## 4. 实战：Marker 把 PDF 转 Markdown

```python
# pip install marker-pdf
from marker.converters.pdf import PdfConverter
from marker.models import create_model_dict
from marker.output import text_from_rendered

converter = PdfConverter(artifact_dict=create_model_dict())
rendered = converter("contract.pdf")
md_text, _, images = text_from_rendered(rendered)

with open("contract.md", "w") as f:
    f.write(md_text)
```

输出 Markdown 里**表格保持结构**、**公式 LaTeX**、**图片引用**自动留好，下游直接喂 LLM。

## 5. 实战：VLM 直读单页（高质量场景）

```python
import base64, pathlib, pymupdf
from openai import OpenAI

def page_to_image(pdf_path, page_no, dpi=200):
    doc = pymupdf.open(pdf_path)
    pix = doc[page_no].get_pixmap(dpi=dpi)
    return pix.tobytes("png")

img_b64 = base64.b64encode(page_to_image("research.pdf", 0)).decode()

client = OpenAI()
resp = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": [
        {"type": "text", "text": (
            "把这页学术论文转成 Markdown：\n"
            "1. 标题、段落、列表保留层级\n"
            "2. 公式用 LaTeX\n"
            "3. 表格用 Markdown table\n"
            "4. 图标记为 ![描述](image_N)\n"
            "5. 不要省略、不要总结。"
        )},
        {"type": "image_url", "image_url": {
            "url": f"data:image/png;base64,{img_b64}", "detail": "high"
        }},
    ]}],
)
print(resp.choices[0].message.content)
```

**经验值**：VLM 直读 1 页 ≈ 0.01-0.05 美元。100 页文档 1-5 美元，**只在乎精度时才这么干**。

## 6. 难点逐个攻：版式

| 难点 | 现象 | 应对 |
| ---- | ---- | ---- |
| 多栏 | 文字被读成 "左右左右" 错位 | layout 模型先分栏 |
| 页眉页脚 | 反复出现噪声 | 按 y 坐标过滤前 5% / 后 5% |
| 跨页表格 | 表格被切成两段 | 启发式拼接（同列宽 + 无表头） |
| 脚注 | 与正文混淆 | 字号过滤 |
| 旋转页 | 横版页 | EXIF / cv2.minAreaRect 自动旋转 |
| 水印 | 噪声 | 颜色阈值 / 形态学开运算 |

## 7. 难点逐个攻：表格

表格是 PDF 提取的**第一痛点**。处理路径：

| 方法 | 工具 | 效果 |
| ---- | ---- | ---- |
| 规则（线条检测） | Camelot / Tabula | 简单表格强、复杂废 |
| 模型（结构识别） | Table Transformer / PaddleOCR-PP-Structure | 主流可用 |
| VLM 直读 | GPT-4o / Claude | 最强但最贵 |

**生产做法**：先用模型抽出表格区域 → 单独 crop → 用 VLM 出 Markdown / JSON。

```python
prompt = """
把这张表格转成 JSON：
{
  "headers": [...],
  "rows": [[...], ...]
}
注意：合并单元格按"重复填充"展开；空值用 null；不要解释。
"""
```

## 8. 难点逐个攻：公式与化学

| 内容 | 工具 |
| ---- | ---- |
| 数学公式 | Pix2Tex / Nougat / VLM |
| 化学结构 | DECIMER / MolScribe |
| 电路图 / 流程图 | VLM 描述（不结构化） |
| 物理示意 | VLM 描述 |

**实践**：公式区域单独截图喂 Pix2Tex，得到 LaTeX 后塞回 Markdown 即可。

## 9. 端到端混合管道（伪代码骨架）

```python
def parse_pdf(pdf_path):
    pages = []
    for page in load_pdf(pdf_path):
        if has_text_layer(page):
            blocks = pymupdf_extract(page)
        else:
            blocks = layout_model(page)   # 给出区域+类型
        for b in blocks:
            if b.type == "text":
                b.content = ocr(b.image) if b.is_scan else b.text
            elif b.type == "table":
                b.content = vlm_table_to_md(b.image)
            elif b.type == "formula":
                b.content = pix2tex(b.image)
            elif b.type == "figure":
                b.content = vlm_describe(b.image)
        pages.append(blocks)
    return assemble_markdown(pages)
```

落地时把每个步骤都做成**可观测、可重跑**，单步失败不要拖垮整篇文档。

## 10. 真实业务示例

| 业务 | 流水线 |
| ---- | ------ |
| 合同审查 | 数字版 → PyMuPDF → 条款分块 → LLM 抽取关键字段 |
| 发票识别 | 扫描件 → VLM 直读（schema 强约束） |
| 研报问答 | Marker → 图表保留 → ColPali 检索（见 §05） |
| 病历结构化 | 手写 OCR + VLM 校验 + 医学术语字典 |
| 招股书 | Mineru → 双栏 + 表格 → 章节切分 → RAG |

## 11. 与 RAG 的衔接

文档**抽取完不是终点**，下游通常进 RAG。两件事不要混：

- **本章** = 抽取（PDF → 结构化文本 / Markdown）。
- **§05 多模态 RAG** = 检索（文本 + 图像层级索引）。

详见 [`../rag-advanced/08-multimodal-and-structured.md`](../rag-advanced/08-multimodal-and-structured.md)（基础版）+ [05 · 多模态 RAG](./05-multimodal-rag.md)（深化版）。

## 常见坑

- **以为所有 PDF 都能抽文字**。扫描件 PyMuPDF 提出来是空的，必须先做"是否有文字层"检测。
- **跨页表格丢一半**。Marker / unstructured 默认按页切，跨页表格需要二次合并。
- **VLM 直读全文档**。100 页文档塞给 VLM = token 爆 + 精度反降，应该按页处理。
- **OCR 完不修复换行**。PDF 抽出来常带强制断行，要按句号 / 标点重新组段。
- **忽略字号信息**。版式模型会输出字号，标题 / 正文 / 脚注的层级信息别丢，下游 RAG 要用。

## 下一步

- [04 · 表格与图表](./04-charts.md) — 表格 / 图表的精细化处理。
- [05 · 多模态 RAG](./05-multimodal-rag.md) — 文档抽取 → 检索的下一跳。
- [10 · 评测与生产化](./10-production.md) — 文档处理的精度怎么评。
- [`../rag-advanced/08-multimodal-and-structured.md`](../rag-advanced/08-multimodal-and-structured.md) — RAG 视角的多模态简介。
