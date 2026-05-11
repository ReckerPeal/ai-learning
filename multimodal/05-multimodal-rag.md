# 05 · 多模态 RAG

文本 RAG 已经是常识，**多模态 RAG 是 2024-2025 的新前沿**。本章不复述基础检索概念（见 [`../rag-advanced/`](../rag-advanced/)），只讲多模态特有的索引、检索与评测策略，重点是 **ColPali 类视觉 RAG** 这种新范式。

## 1. 三种典型模式

| 模式 | 索引 | 查询 | 召回 | 适用 |
| ---- | ---- | ---- | ---- | ---- |
| Text-only over MM | 把图片描述 / OCR 转文本 | 文本 | 文本 chunk | 简单、便宜 |
| Cross-modal | 文本和图各自向量化 | 文本 | 同向量空间检索图 | 商品搜索、图搜文 |
| Image-as-document | 整页图直接索引 | 文本 | 图 patch | 复杂版式文档 |

**结论**：**多数 RAG 业务用模式 1 就够了**，模式 3（ColPali）是版式复杂时的杀手锏。

## 2. 模式 1：把图变成文本再检索

最简单也最实用的路径：

```
PDF/图 → 抽取 → 文本（含 caption / OCR / 表格 markdown） → embedding → 普通 RAG
```

**关键点**：每张图必须**生成 caption**（用 VLM 描述），否则丢失信息。

```python
from openai import OpenAI
import base64, pathlib

def caption_image(path: str) -> str:
    img = base64.b64encode(pathlib.Path(path).read_bytes()).decode()
    resp = OpenAI().chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": [
            {"type": "text", "text": (
                "为这张图生成检索用 caption：\n"
                "1. 客观描述图中实体、关系、数据\n"
                "2. 包含关键术语和数字\n"
                "3. 100-200 字，不要省略要点"
            )},
            {"type": "image_url", "image_url": {
                "url": f"data:image/png;base64,{img}", "detail": "high"
            }},
        ]}],
    )
    return resp.choices[0].message.content
```

**生产经验**：caption 单独存一列；检索时同时返回原图给前端展示，给 LLM 答题时 caption + 图都送进去。

## 3. 模式 2：跨模态向量（CLIP-style）

把文本和图放到**同一向量空间**，可以用文本 query 检索图，反之亦然。

| 模型 | 维度 | 特点 |
| ---- | ---- | ---- |
| CLIP（OpenAI） | 512/768 | 经典、英文 |
| OpenCLIP（LAION） | 多种 | 开源 |
| SigLIP | 768 | 比 CLIP 准 |
| Chinese-CLIP | 512 | 中文场景 |
| BGE-VL / Jina-CLIP | 多模 | 国产，中文强 |

```python
# pip install open_clip_torch
import open_clip, torch
from PIL import Image

model, _, preprocess = open_clip.create_model_and_transforms("ViT-B-32", pretrained="laion2b_s34b_b79k")
tokenizer = open_clip.get_tokenizer("ViT-B-32")
model.eval()

img = preprocess(Image.open("product.jpg")).unsqueeze(0)
text = tokenizer(["red running shoes", "office chair"])

with torch.no_grad():
    img_emb = model.encode_image(img)
    txt_emb = model.encode_text(text)
    img_emb /= img_emb.norm(dim=-1, keepdim=True)
    txt_emb /= txt_emb.norm(dim=-1, keepdim=True)
    sims = (img_emb @ txt_emb.T).softmax(dim=-1)
print(sims)
```

**适用**：商品搜索（"红色跑鞋"）、设计资源库（"极简风海报"）、相册组织。

## 4. 模式 3：ColPali / ColQwen — 视觉 RAG 新范式

**核心思路**：跳过 OCR / 抽取，直接对**页面图像**做检索。

```
PDF 页面图 → ViT patch embeddings（每页 ~1024 个向量） → late-interaction 检索（ColBERT 风格）
```

**为什么强**：

| 传统 RAG | ColPali |
| -------- | ------- |
| 依赖 OCR / layout 抽取 | 直接吃图 |
| 表格 / 公式抽取丢信息 | 视觉信息全保留 |
| 索引快、检索快 | 索引慢、检索中等 |
| 文本 query → 文本 chunk | 文本 query → 页面图 |

**当文档版式复杂、抽取链路一直翻车**时，ColPali 是降维打击。

```python
# pip install colpali-engine
from colpali_engine.models import ColPali, ColPaliProcessor
from PIL import Image
import torch

model = ColPali.from_pretrained("vidore/colpali-v1.2", torch_dtype=torch.bfloat16, device_map="cuda")
processor = ColPaliProcessor.from_pretrained("vidore/colpali-v1.2")

# 索引：每页一张图 → multi-vector embedding
images = [Image.open(f"page_{i}.png") for i in range(10)]
batch_images = processor.process_images(images).to(model.device)
with torch.no_grad():
    image_embeddings = model(**batch_images)   # [N, num_patches, dim]

# 检索：文本 query → 同空间向量
queries = ["营收同比增长率"]
batch_q = processor.process_queries(queries).to(model.device)
with torch.no_grad():
    q_emb = model(**batch_q)

scores = processor.score_multi_vector(q_emb, image_embeddings)
top_pages = scores.topk(3, dim=-1).indices
```

**召回的 top 页直接喂 VLM** 回答即可。整个链路无 OCR、无 chunking。

## 5. 文档层级 RAG（Hierarchical）

复杂文档不是"扁平 chunk"，而是**多层级**：

```
文档 → 章节 → 段落 → 句子
        ↓
        表格
        ↓
        图
```

| 层 | 索引内容 | 用途 |
| -- | -------- | ---- |
| 文档级 | 摘要 | 路由（这篇要不要查） |
| 章节级 | 标题 + 概要 | 粗筛 |
| 段落级 | 文本 chunk | 主要召回 |
| 区域级 | 图 / 表 caption | 视觉单元 |

**检索策略**：先用文档摘要筛 top-N 文档，再在文档内做段落 + 区域混合召回。

## 6. 索引构建流水线（端到端）

```python
def build_index(pdf_path: str):
    # 1. 解析（§03 的产物）
    doc = parse_pdf(pdf_path)   # 含 text/table/figure blocks

    chunks = []
    for block in doc.blocks:
        if block.type == "text":
            chunks.append({"type": "text", "content": block.text, "page": block.page})
        elif block.type == "table":
            md = block.markdown
            chunks.append({"type": "table", "content": md, "page": block.page,
                           "image_path": block.image_path})
        elif block.type == "figure":
            cap = caption_image(block.image_path)
            chunks.append({"type": "figure", "content": cap, "page": block.page,
                           "image_path": block.image_path})

    # 2. 向量化
    for c in chunks:
        c["embedding"] = embed(c["content"])

    # 3. 入库（Qdrant / Milvus / pgvector）
    vector_store.upsert(chunks)
```

**关键设计**：

- 每个 chunk 都带 `image_path`（如有），检索后 LLM 能拿到原图。
- `type` 字段用于过滤 / 加权（"只查图表"）。
- 复杂查询做 **混合检索**：BM25（关键词）+ 向量（语义）+ 类型过滤。

## 7. 召回后的多模态拼装

```python
# 召回后给 VLM 答题
def answer(query: str):
    hits = retrieve(query, top_k=5)
    content = [{"type": "text", "text": f"问题：{query}\n参考资料："}]
    for h in hits:
        if h["type"] == "figure" or h["type"] == "table":
            content.append({"type": "text", "text": f"\n[来源 P{h['page']}]"})
            content.append({"type": "image_url", "image_url": {
                "url": f"data:image/png;base64,{load_b64(h['image_path'])}"
            }})
        else:
            content.append({"type": "text", "text": f"\n[P{h['page']}] {h['content']}"})
    resp = OpenAI().chat.completions.create(
        model="gpt-4o", messages=[{"role": "user", "content": content}],
    )
    return resp.choices[0].message.content
```

**经验**：每次最多带 3-5 张图，再多 token 爆。让前端"展示更多原图"，但 LLM 上下文要克制。

## 8. 评测：跨模态相关性

文本 RAG 评测 → 多模态评测要扩展：

| 指标 | 含义 |
| ---- | ---- |
| 命中率（hit@k） | 召回的 chunk 是否包含答案 |
| MRR | 第一个相关结果的位置倒数 |
| 跨模态命中 | query 是文本时，是否能召回相关图 |
| 视觉锚点准确 | 答案声称"见图 X"，是否真的来自图 X |
| 引用一致性 | LLM 引用的页码是否真存在该信息 |

工具：**Vidore Benchmark**（ColPali 团队的评测集）、**MM-RAG-Eval**、自建业务集。

## 9. 与 ../rag-advanced 的关系

| 章节 | 关系 |
| ---- | ---- |
| [`../rag-advanced/01-overview.md`](../rag-advanced/01-overview.md) | RAG 总图，先看 |
| [`../rag-advanced/04-hybrid-retrieval.md`](../rag-advanced/04-hybrid-retrieval.md) | 混合检索、reranking 通用方法 |
| [`../rag-advanced/08-multimodal-and-structured.md`](../rag-advanced/08-multimodal-and-structured.md) | 基础版多模态 RAG，**本章是它的深化** |
| [`../rag-advanced/09-evaluation.md`](../rag-advanced/09-evaluation.md) | 评测体系，多模态扩展见本章 §8 |

## 10. 选型决策树

```
你的问题主要在哪？
│
├─ 文档版式简单（财报、合同）
│  └─ 模式 1（caption + 文本 RAG），最便宜
│
├─ 商品 / 素材库（用图找图、用文找图）
│  └─ 模式 2（CLIP-style）
│
├─ 复杂版式（学术、研报、PDF 表格灾难）
│  └─ 模式 3（ColPali / ColQwen）
│
└─ 都有
   └─ 三模式共存，按 type 路由
```

## 常见坑

- **图不生成 caption 直接索引**。空 caption 等于丢索引，检索召回为零。
- **ColPali 索引体积爆炸**。每页 1024 向量 × N 页，硬盘占用是文本索引的 100 倍，先评估。
- **混合 chunk 类型不做加权**。检索时 figure caption 和正文分数同等，结果首页全是图，用类型权重纠正。
- **检索后忘了把原图给 LLM**。caption 召回但答题时只送 caption，等于浪费。always 把 image_path 也传下去。
- **跨模态 embedding 用错语言**。中文场景用纯英文 CLIP → 召回乱七八糟，必须用 Chinese-CLIP / BGE-VL。

## 下一步

- [03 · 文档理解](./03-documents.md) — 上游抽取，决定索引质量。
- [04 · 表格与图表](./04-charts.md) — 表 / 图的特殊化处理。
- [10 · 评测与生产化](./10-production.md) — 多模态 RAG 的离线评测。
- [`../rag-advanced/`](../rag-advanced/) — RAG 通用知识。
