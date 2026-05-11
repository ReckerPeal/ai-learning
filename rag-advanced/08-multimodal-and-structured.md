# 08 · 多模态与结构化数据

文本 RAG 之外，真实业务里还有：**表格、图片、PDF 扫描件、SQL 数据库**。这些数据不能简单 chunking + embedding——需要专门处理。

## 1. PDF：表格 / 图片 / 扫描件混合

### 1.1 普通文本 PDF

`PyPDFLoader` 够用，但**版面信息会丢**——多列、页眉页脚、表格全被拼成一团乱字符。

更好的：

| 工具 | 优势 |
|---|---|
| `pdfplumber` | 自带表格检测 |
| `unstructured` | 智能识别 title / paragraph / table / image |
| `pymupdf4llm` | 直接出 Markdown，保留结构 |
| `marker` / `mineru` | 学术级 PDF → Markdown，处理公式表格图 |

```python
import pymupdf4llm
md = pymupdf4llm.to_markdown("paper.pdf")
# 直接得到带 #、|表格|、![图]() 的 Markdown
```

### 1.2 扫描件（图片型 PDF）

需要 OCR：

```python
from langchain_community.document_loaders import UnstructuredPDFLoader

loader = UnstructuredPDFLoader("scanned.pdf", strategy="hi_res")  # OCR + 版面分析
```

或更专业的 OCR 方案：
- **PaddleOCR / RapidOCR**：开源中英文 OCR，效果好
- **腾讯/百度/阿里 OCR API**：精度更高，按量付费
- **Mistral OCR**（2025 起）：LLM-grade OCR

OCR 之后还要做表格还原、阅读顺序修复——这些都在 `unstructured` / `marker` 等工具里有。

### 1.3 PDF 处理的真实工程

90% 的"我的 RAG 不行" 其实是**PDF 解析不行**。建议：

1. 先用 2-3 种工具解同一份文档，**肉眼对比**
2. 表格、目录、公式是不是被正确保留？
3. 阅读顺序对不对（多列 PDF 经常错位）？
4. 选定一种为主，其他做 fallback

## 2. 表格 RAG

表格里的数据**不能切碎 embed**——切碎了行列关系就丢了。三种处理路线：

### 2.1 把表格转成自然语言

让 LLM 把每行写成一段陈述：

```
表格：员工工资
| 姓名 | 部门 | 工资 |
| 张三 | 研发 | 30000 |
| 李四 | 销售 | 25000 |

→ "张三是研发部的员工，工资是 30000 元。"
→ "李四是销售部的员工，工资是 25000 元。"
```

每行一个 chunk，metadata 带原表 ID。语义检索能命中"研发部工资"这类 query。

代价：LLM 一次性消耗、部分数值精度可能丢失。

### 2.2 多向量索引：表格摘要 + 原表

参考 [02 章 多向量索引](./02-chunking.md#6-多向量索引)：

- 索引：让 LLM 给表写一段摘要 + 关键字段说明
- 检索时：摘要的 embedding 命中
- 返回：**完整原表**喂给 LLM

LLM 看到完整结构化表格，回答数值问题准得多。

### 2.3 转成 SQL：让 LLM 写查询

如果表格规整、可入库（CSV / Excel），干脆别 RAG，**走 NL2SQL**：

```python
from langchain_community.utilities import SQLDatabase
from langchain.chains import create_sql_query_chain

db = SQLDatabase.from_uri("sqlite:///data.db")
chain = create_sql_query_chain(llm, db)

sql = chain.invoke({"question": "研发部工资最高的人是谁？"})
result = db.run(sql)
```

适合：数值统计、聚合、join。**不要让 RAG 干 SQL 的活**。

后面有专门一节讲 NL2SQL（第 4 节）。

## 3. 图片 RAG

### 3.1 三种模式

| 模式 | 索引 | 检索 |
|---|---|---|
| **图片描述（caption）** | LLM/VLM 生成 caption，embed caption | 文本 → 文本 |
| **图文对齐 embedding（CLIP-like）** | 图直接 embed | 文本 query embed → 跨模态比 |
| **多模态 LLM** | 图存原图 | 文本 query 召回 → VLM 看图回答 |

### 3.2 模式一：caption + 文本检索（最实用）

```python
from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage

vlm = ChatOpenAI(model="gpt-4o")

def caption(image_url):
    msg = HumanMessage(content=[
        {"type": "text", "text": "用一段话详细描述这张图，包括关键文字、数据、对象。"},
        {"type": "image_url", "image_url": {"url": image_url}},
    ])
    return vlm.invoke([msg]).content

# 索引时
for img in images:
    cap = caption(img.url)
    vs.add_documents([Document(page_content=cap, metadata={"image_url": img.url})])
```

检索完文字描述，把**原图 URL 喂回 VLM** 让它再看一次回答：

```python
def answer_with_image(question, retrieved_caps):
    images = [d.metadata["image_url"] for d in retrieved_caps]
    content = [{"type": "text", "text": f"问题：{question}\n以下是相关图片："}]
    content += [{"type": "image_url", "image_url": {"url": u}} for u in images]
    return vlm.invoke([HumanMessage(content=content)]).content
```

### 3.3 模式二：CLIP-like

`OpenCLIP` 系列、`bge-visualized`、`jina-clip`：图和文字 embed 到同一空间。

```python
from langchain_experimental.open_clip import OpenCLIPEmbeddings
emb = OpenCLIPEmbeddings(model_name="ViT-H-14", checkpoint="laion2b_s32b_b79k")

img_vec = emb.embed_image([img_path])
text_vec = emb.embed_query("一张猫的照片")
```

适合：纯图搜（"找类似这张图的"）、图搜文。
不适合：图里包含文字/数字（CLIP 对 OCR 不敏感）。

### 3.4 何时选哪个

```
图里关键信息是文字 / 数字（图表、扫描件）
   → 模式一（caption）

图本身就是内容（产品图、艺术图、地图）
   → 模式二（CLIP-like）

要回答"这个图说了什么 + 为什么"
   → 模式一 + 三（caption 检索 + VLM 回答）
```

## 4. SQL / 结构化数据：NL2SQL

### 4.1 LangChain 的 SQL Agent

```python
from langchain_community.agent_toolkits import create_sql_agent
from langchain_community.utilities import SQLDatabase

db = SQLDatabase.from_uri("postgresql+psycopg://...")
agent = create_sql_agent(
    llm=ChatOpenAI(model="gpt-4o"),
    db=db,
    agent_type="openai-tools",
    verbose=True,
)

agent.invoke("过去 7 天 GMV 最高的 5 个商品是什么？")
```

Agent 会自动：
- 列出表
- 看表 schema
- 写 SQL
- 执行
- 看结果，必要时修正
- 综合答案

### 4.2 实战要点

**Schema 检索**：表多了（>20 张），不能把所有 schema 塞进 prompt。先用一个 schema retriever 召回相关表，再喂 schema 给 SQL Agent。

**Few-shot 例子**：把"问题 → SQL"的例子做成检索库，按相似度找最相关的 3-5 条作为示例：

```python
from langchain_core.example_selectors import SemanticSimilarityExampleSelector

example_selector = SemanticSimilarityExampleSelector.from_examples(
    examples=[{"question": "...", "sql": "..."}, ...],
    embeddings=emb,
    vectorstore_cls=Chroma,
    k=5,
)
```

**只读权限**：必须给 LLM 一个**只读账户**。绝不让它有 DELETE/UPDATE 权限。

**LIMIT 兜底**：每条 SQL 自动加 `LIMIT 100` 之类，防止 LLM 写出 `SELECT * FROM huge_table` 拖垮库。

**审计 + HITL**：高风险查询（金融、医疗）走审批，详见 [LangGraph 07](../langgraph/07-human-in-the-loop.md)。

### 4.3 SQL + RAG 的混合

经典场景："给我看销售额最高的产品的产品文档"——
- SQL：查销售额最高的产品 ID 和名称
- RAG：拿名称去文档库检索

用 LangGraph 编排：

```
question → classify ─┬─► SQL agent
                     ├─► RAG retriever
                     └─► both → SQL → 用结果做 RAG → 综合答案
```

## 5. 知识图谱 RAG（GraphRAG）

文档之间的关系（实体、引用、概念关联）做不到——这是普通 RAG 的盲点。

GraphRAG（微软开源）的做法：
1. 用 LLM 抽取实体和关系，构建图
2. 在图上做社区检测，给每个社区写摘要
3. 检索时既看局部（chunk）也看全局（社区摘要）

适合：需要"全局视野"的问题（"这本书的核心矛盾是什么"），普通 RAG 只看到片段。
不适合：FAQ 类查询，过度复杂。

工具：
- `microsoft/graphrag`
- `langchain-experimental` 里的 GraphCypherQAChain（Neo4j）
- `Nano-GraphRAG`（轻量复刻）

## 6. 长文档 RAG：层级摘要

文档极长（合同 200 页 / 论文 50 页），单 chunk 看不到全局。

层级摘要：

```
原文档
  └─ 章节摘要（每章 1 段）
       └─ 整体摘要（全文 1 段）
```

索引时所有层级都写入：

- 检索具体细节 → 命中 chunk
- 检索"整本书讲了什么" → 命中整体摘要

`MultiVectorRetriever` 也能做这件事——一个 doc 多个不同粒度的索引。

## 7. 多语 RAG

中英混合、跨语言检索：

- 用**多语 embedding**（bge-m3、multilingual-e5、cohere multilingual-v3）
- query 是中文、文档是英文（或反过来）也能召回
- 必要时 query 端做翻译（用 LLM 把中文 query 翻成英文再检索）

最简单的方案：**索引时全翻成同一种语言**（保留原文 metadata），检索就是单语问题。代价是翻译 + 索引成本翻倍，但简单可靠。

## 8. 与文本 RAG 共存

实战中最常见的是**混合数据源**：

```
question → router ─┬─► 文本文档 RAG
                   ├─► 表格 RAG / SQL
                   ├─► 图片 RAG
                   └─► 知识图谱
                       │
                       ▼
                    各自检索结果合并
                       │
                       ▼
                       LLM 综合回答
```

router 可以是 LLM 分类（用 [05 章 Adaptive-RAG](./05-query-transformation.md)），也可以是规则。

## 9. 常见坑

| 现象 | 原因 |
|---|---|
| PDF 解出来一团乱 | 工具不对，换 unstructured / pymupdf4llm / marker |
| 表格答错数值 | 切碎了；改用整表 + multi-vector，或 NL2SQL |
| 图片召回乱 | caption 太短、不准；让 VLM 写更详细的 caption |
| CLIP 召不回带文字的图 | CLIP 对 OCR 弱；改用 caption 路线 |
| SQL Agent 写出错的 SQL | schema 没给清晰、缺 few-shot；加示例和约束 |
| SQL Agent 跑超时 / 拖库 | 加 LIMIT 兜底、加超时、表过滤 |
| 多模态延迟高 | 图片 caption 离线生成；VLM 推理只在 top-k 上跑 |
| GraphRAG 太重 | 小项目用不着；先 hybrid + reranker 跑通 |

## 10. 下一步

- [09 · 评测](./09-evaluation.md)：多模态/SQL 怎么评测
- [10 · 生产化](./10-production.md)：增量索引、安全、监控
