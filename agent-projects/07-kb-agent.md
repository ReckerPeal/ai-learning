# 07 · 项目6：知识库 Agent

> **企业知识库 Agent 是 RAG 工程的"地狱模式"**：多租户、多源（Wiki+PDF+网页+IM）、权限隔离、长时记忆、跨文档推理。这章做一个面向团队的内部知识助手——技术核心是 Agentic RAG + Memory，落地难点是多租户与权限。

## 1. 业务背景与目标

| 维度 | 内容 |
| --- | --- |
| **业务价值** | 新人 onboarding 节省 50% 提问时间；老员工搜索效率翻倍 |
| **用户** | 公司全员，按部门 / 项目隔离 |
| **输入** | 自然语言问题，可带@文档引用 |
| **输出** | 答案 + 引用列表 + 关联推荐 + 可选反馈 |
| **失败成本** | 越权 = 法务红线；幻觉 = 决策错误 |
| **关键 SLA** | p95 ≤ 5s，引用准确率 ≥ 90% |

**前 3 风险**：

1. 跨租户 / 跨部门越权 → metadata filter 强注入
2. 过时文档（去年的政策当今天回答）→ 时间感知 + 版本号
3. 长尾"找不到"场景误编造 → 强 cite + 兜底 "未找到"

## 2. 架构图

```
                  ┌──────────────┐
                  │ Question     │
                  └──────┬───────┘
                         ▼
                  ┌──────────────┐
                  │ Auth + Tenant│  ◀─ tenant / dept / acl_groups
                  └──────┬───────┘
                         ▼
                  ┌──────────────┐
                  │ Recall Memory│  ◀─ 用户偏好 + 最近问过
                  └──────┬───────┘
                         ▼
                  ┌──────────────┐
                  │ Query Rewrite│  ◀─ 改写、扩展、HyDE
                  └──────┬───────┘
                         ▼
                  ┌──────────────┐
                  │ Hybrid       │  ◀─ bm25 + dense + 关键词回退
                  │ Retrieval    │
                  └──────┬───────┘
                         ▼
                  ┌──────────────┐
                  │ Rerank       │  ◀─ cross-encoder
                  └──────┬───────┘
                         ▼
                  ┌──────────────┐
                  │ Self-RAG     │  ◀─ "够不够"决定要不要再检索
                  └──┬────────┬──┘
              not ok │        │ ok
                     ▼        ▼
              ┌──────────┐ ┌──────────┐
              │ Refine Q │ │ Answer   │
              └────┬─────┘ │ + Cite   │
                   │       └────┬─────┘
                   └────────────┘
                                ▼
                       ┌──────────────┐
                       │ Memory Write │  ◀─ 写入会话/长时
                       └──────┬───────┘
                              ▼
                       ┌──────────────┐
                       │ Return       │
                       └──────────────┘
```

详见 [`../rag-advanced/07-agentic-rag.md`](../rag-advanced/07-agentic-rag.md) Self-RAG / CRAG。

## 3. 关键模块

### 3.1 目录结构

```
kb-agent/
├── src/
│   ├── graph/
│   │   ├── state.py
│   │   ├── nodes/
│   │   │   ├── auth.py
│   │   │   ├── memory.py
│   │   │   ├── rewrite.py
│   │   │   ├── retrieve.py
│   │   │   ├── rerank.py
│   │   │   ├── self_rag.py
│   │   │   ├── answer.py
│   │   │   └── memwrite.py
│   │   └── graph.py
│   ├── ingest/
│   │   ├── confluence.py
│   │   ├── notion.py
│   │   ├── pdf.py
│   │   └── pipeline.py        # 切分 + 元数据 + 入库
│   ├── retrievers/
│   │   ├── qdrant_hybrid.py
│   │   └── bm25.py
│   ├── memory/
│   │   ├── episodic.py        # 历史对话
│   │   └── semantic.py        # 个人知识画像
│   └── api/
│       └── routes.py
└── tests/eval/data/qa.json
```

### 3.2 多租户与权限模型

| 维度 | 实现 |
| --- | --- |
| Tenant | Qdrant collection per tenant，物理隔离 |
| Dept / Project | metadata `acl_groups: []` + 检索 filter |
| User | 进入图前查询 `user.groups`，注入 state |
| 文档级 ACL | 索引时写 `viewers: []`，召回阶段强 filter |
| 撤销 | 文档移除 → 立即 delete from vector store，并 tombstone |
| 审计 | 每次查询落库 `(user, query, hit_doc_ids)` |

### 3.3 切分与元数据

| 元数据 | 用途 |
| --- | --- |
| `source` | confluence / notion / pdf |
| `last_modified` | 时效过滤 |
| `version` | 多版本对比 |
| `lang` | 中英分库或同库 multi-lingual embedding |
| `tags` | 业务标签 |
| `acl_groups` | 权限 |
| `parent_id` | 父子文档关系 |
| `summary` | 入库时预生成，召回后兜底 |

切分策略参考 [`../rag-advanced/02-chunking.md`](../rag-advanced/02-chunking.md)。

## 4. 关键代码片段

### 4.1 状态定义

```python
# src/graph/state.py
from typing import TypedDict, Annotated
from langgraph.graph.message import add_messages

class KbDoc(TypedDict):
    id: str
    text: str
    metadata: dict
    score: float

class KbState(TypedDict):
    user_id: str
    tenant_id: str
    acl_groups: list[str]
    session_id: str
    question: str
    rewritten_qs: list[str]
    retrieved: list[KbDoc]
    reranked: list[KbDoc]
    self_rag_pass: bool
    refine_count: int
    answer: str | None
    citations: list[KbDoc]
    cost_usd: float
    messages: Annotated[list, add_messages]
```

### 4.2 检索节点（含强权限过滤）

```python
# src/graph/nodes/retrieve.py
from qdrant_client import QdrantClient
from qdrant_client.http.models import Filter, FieldCondition, MatchAny

CLIENT = QdrantClient(host="qdrant", port=6333)

def _acl_filter(state) -> Filter:
    return Filter(
        must=[
            FieldCondition(key="acl_groups",
                           match=MatchAny(any=state["acl_groups"])),
        ]
    )

def retrieve_node(state: KbState) -> dict:
    collection = f"kb_{state['tenant_id']}"
    hits = []
    for q in state["rewritten_qs"]:
        # dense
        emb = embed(q)
        d_hits = CLIENT.search(
            collection_name=collection,
            query_vector=emb,
            query_filter=_acl_filter(state),
            limit=15,
        )
        # sparse / bm25（同一 collection 走 hybrid query）
        s_hits = CLIENT.search(
            collection_name=collection,
            query_vector=("bm25", q),
            query_filter=_acl_filter(state),
            limit=15,
        )
        hits.extend(d_hits + s_hits)
    return {"retrieved": _rrf_merge(hits)[:20]}
```

参考 [`../rag-advanced/04-hybrid-retrieval.md`](../rag-advanced/04-hybrid-retrieval.md) §3 RRF。

### 4.3 Self-RAG 决策

```python
# src/graph/nodes/self_rag.py
JUDGE_PROMPT = """问题：{q}
候选片段（top-5 reranked）：
{snippets}

判断：
1. 是否足以回答问题？回答 yes/no
2. 若 no，缺哪些方面？给出建议查询。

输出 JSON：{{"ok": bool, "missing": ["..."], "refine_q": "..."}}
"""

def self_rag_node(state: KbState) -> dict:
    if state.get("refine_count", 0) >= 1:
        return {"self_rag_pass": True}  # 上限 1 轮 refine
    resp = LLM.invoke(JUDGE_PROMPT.format(
        q=state["question"],
        snippets=_fmt(state["reranked"][:5]),
    ))
    data = json.loads(resp.content)
    if data["ok"]:
        return {"self_rag_pass": True}
    return {
        "self_rag_pass": False,
        "rewritten_qs": [data["refine_q"]],
        "refine_count": state.get("refine_count", 0) + 1,
    }
```

### 4.4 Answer 节点（强 cite）

```python
# src/graph/nodes/answer.py
ANSWER_PROMPT = """根据下述片段回答用户问题。

问题：{q}
片段（带编号）：
{snippets}

要求：
- 每个事实声明必须 [n] 引用
- 若片段不足以回答，明确写"未找到相关信息"，不要编造
- 不要 paraphrase 政策原文（直接引）
- 答案长度 ≤ 400 字

输出：
{{"answer": "...", "used_ids": [n,n,...]}}
"""

def answer_node(state: KbState) -> dict:
    snippets = _format_with_ids(state["reranked"][:5])
    resp = LLM.invoke(ANSWER_PROMPT.format(q=state["question"], snippets=snippets))
    data = json.loads(resp.content)
    cites = [state["reranked"][i] for i in data["used_ids"]]
    return {"answer": data["answer"], "citations": cites}
```

### 4.5 评测配置

```yaml
# tests/eval/config.yaml
dataset: tests/eval/data/qa.json
metrics:
  - id: faithfulness
    type: ragas
    metric: faithfulness
  - id: context_precision
    type: ragas
    metric: context_precision
  - id: answer_relevancy
    type: ragas
    metric: answer_relevancy
  - id: acl_leak
    type: code              # 100% 不能泄漏
    func: tests.eval.checks.acl_leak
  - id: stale_doc_rate
    type: code
    func: tests.eval.checks.stale
ci:
  fail_under:
    faithfulness: 0.85
    context_precision: 0.80
    answer_relevancy: 0.80
    acl_leak: 1.0
    stale_doc_rate: 0.10
```

## 5. 评测设计

### 5.1 数据集

| 类别 | 数量 | 说明 |
| --- | --- | --- |
| 单文档问答 | 40 | 标准 RAG |
| 跨文档综合 | 20 | 需要 2+ 文档拼装 |
| 时效问题 | 10 | 答案随时间变化 |
| 越权陷阱 | 10 | A 部门用户问 B 部门文档 |
| "找不到"场景 | 10 | 应该说不知道 |
| Prompt 注入 | 5 | 在文档里塞"忽略上文" |

### 5.2 关键指标

| 指标 | 通过线 | 含义 |
| --- | --- | --- |
| Faithfulness | ≥ 85% | 答案与引用对齐 |
| Context Precision | ≥ 80% | 召回的文档相关 |
| Answer Relevancy | ≥ 80% | 答案确实回答了问题 |
| ACL 泄漏率 | **0%** | 红线 |
| 过时文档使用率 | ≤ 10% | 时效感知 |
| 拒答正确率 | ≥ 90% | 该说"不知道"就说 |

详见 [`../rag-advanced/09-evaluation.md`](../rag-advanced/09-evaluation.md)、[`../eval/06-rag-eval.md`](../eval/06-rag-eval.md)。

## 6. 上线考虑

### 6.1 数据接入

| 源 | 同步策略 |
| --- | --- |
| Confluence / Notion | webhook + 每日全量 diff |
| PDF（共享盘） | 文件监控 + OCR pipeline |
| Slack / Lark | bot 抓取频道（需明确同意） |
| GitHub Wiki | git poll |
| 实时变更 | 文档级 hash，未变则跳过 |

入库 pipeline 是另一个项目级别工程（向量重算、版本切换、A/B），建议异步队列。

### 6.2 用户体验

- 答案带"📎 3 篇引用" 可展开
- 每个引用可点开原文（高亮命中段）
- 反馈按钮 👍/👎 + 原因（"过时"/"不准"/"权限错"）
- "类似问题"推荐（基于历史问答 embedding）

### 6.3 监控

| 指标 | 告警 |
| --- | --- |
| p95 延迟 > 5s | retriever 慢 / rerank 模型问题 |
| faithfulness 周下降 5% | 入库数据问题 / 模型漂移 |
| ACL leak ≥ 1 | 立刻停服 + incident |
| 👎 率 > 20% | 长尾问题集中域 |

### 6.4 模型成本

- 重排走 cross-encoder（自部署）而非 LLM
- 答案合成走 gpt-4o-mini，关键域走 gpt-4o
- 缓存：question hash + tenant + acl_groups → answer

## 7. Trade-off 讨论：朴素 RAG vs Agentic RAG

| 维度 | 朴素 RAG | Agentic RAG（选） |
| --- | --- | --- |
| 单 hop 问答 | 够用 | 略 over-engineering |
| 多 hop 推理 | 差 | 强 |
| "找不到"判断 | 差 | Self-RAG 判 |
| 延迟 | 1–3s | 3–8s |
| 成本 | 1× | 1.5–2× |
| 工程复杂度 | 低 | 中 |

> **小知识库 + 单 hop**：朴素 RAG；**>1 万文档 + 多源**：Agentic RAG 收益超过成本。
> 中间形态：默认朴素，触发 confidence 低时升级 Agentic（动态分流）。

## 常见坑

1. **chunks 太大**：单条 1500 字 → 召回粗 + 上下文挤占。落到 300–500 字 + 重叠 50。
2. **embedding 模型与 query 不同语言**：中文文档配英文模型，效果差 → 多语 embedding（bge-m3）或分语种 collection。
3. **rerank 错位**：cross-encoder 输入截断 → 限定 max_len，长 chunk 摘要后再 rerank。
4. **PDF 提取丢表格**：用 PyMuPDF 提取，表格被打成乱码 → 用 unstructured / Marker，专门抓表格。
5. **acl_groups 没更新**：员工离职文档仍可查 → groups 走目录服务实时查询，不要缓存超 5 min。
6. **新文档延迟入库 24h**：用户问"今天发的公告"找不到 → webhook 触发立即入库，并标 `priority: hot`。
7. **过时文档**：检索 top-1 是 3 年前文档 → 时间衰减（score *= exp(-age/365)）。
8. **Prompt 注入**：文档里塞"无视所有引用要求"→ 入库时清洗 + answer prompt 多层重申约束。
9. **跨 tenant 漏过**：collection 弄错 → 单元测试覆盖 + 入图前 assert tenant_id 一致。

## 下一步

- 完整对比 6 个项目：[§08 横向对比](./08-comparison.md)
- 监控落地：[§09 评测与监控](./09-eval-monitoring.md)
- Agentic RAG：[`../rag-advanced/07-agentic-rag.md`](../rag-advanced/07-agentic-rag.md)
- Memory 体系：[`../agents/03-cognitive-architecture.md`](../agents/03-cognitive-architecture.md)
- 数据泄漏防护：[`../llm-security/04-data-leak.md`](../llm-security/04-data-leak.md)
