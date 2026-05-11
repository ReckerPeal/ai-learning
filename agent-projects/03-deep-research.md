# 03 · 项目2：自动化深度调研

> **"给我一份关于 X 的调研报告"**——这是 LLM 时代最被低估的 killer use case。一次任务消耗 10–30 次检索、5–15 分钟、几万 token，但产出一份 3–8k 字的结构化报告。把 GPT Researcher / Open Deep Research 的关键设计抽出来，按工程化重做一遍。

## 1. 业务背景与目标

| 维度 | 内容 |
| --- | --- |
| **业务价值** | 替代分析师 2–4 小时桌面调研：竞品、技术、市场 |
| **用户** | 产品经理、咨询顾问、投资人、技术 lead |
| **输入** | 调研题目 + 可选范围（"近 6 个月"、"中文"、"学术为主"） |
| **输出** | Markdown 报告（含目录、引用、图表 hook） |
| **失败成本** | 信息错误 < 引用缺失 < 报告无产出（按损失递增） |
| **关键 SLA** | 端到端 10 min 内出报告，预算 $1/份 |

**前 3 风险**：

1. 幻觉引用（编造 URL）→ 检索结果强 cite，编译期 URL 校验
2. 主题漂移 → Plan 阶段固定 outline，execute 不允许改 outline
3. 成本失控 → 每 query 预算 cap + 并发 limit

## 2. 架构图

```
                  ┌──────────────┐
                  │ Topic + Scope │
                  └──────┬───────┘
                         ▼
                  ┌──────────────┐
                  │ Brief / Plan │  ◀─ 题目澄清 → 大纲 → 子问题列表
                  └──────┬───────┘
                         ▼
        ┌────────────────┴───────────────┐
        ▼                                ▼
  ┌──────────┐    ┌──────────────────────────────┐
  │ Sub Q 1  │... │ Researcher pool (并发 N=5)    │
  └────┬─────┘    └──────────┬───────────────────┘
       │                     │
       │   ┌──────────────┐  │
       └──▶│ Search       │◀─┘  ◀─ Tavily / Exa / arXiv / Google
           ├──────────────┤
           │ Read + Cite  │  ◀─ 摘要+引用
           ├──────────────┤
           │ Reflect      │  ◀─ 查证、补漏（Reflexion 模式）
           └──────┬───────┘
                  ▼
            ┌──────────────┐
            │ Section Draft│  ◀─ 每子问题一段
            └──────┬───────┘
                  ▼
            ┌──────────────┐
            │ Compile      │  ◀─ 全文拼装 + 引用列表
            └──────┬───────┘
                  ▼
            ┌──────────────┐
            │ Critique     │  ◀─ Reflection: 是否回答了 brief？
            └──────┬───────┘
                  ▼
            ┌──────────────┐
            │ Final Report │
            └──────────────┘
```

参考 [`../agents/06-multi-agent.md`](../agents/06-multi-agent.md) §3 supervisor 模式与本架构一致。

## 3. 关键模块

### 3.1 目录结构

```
deep-research/
├── src/
│   ├── graph/
│   │   ├── state.py            # ResearchState
│   │   ├── nodes/
│   │   │   ├── brief.py        # 题目澄清
│   │   │   ├── planner.py      # 大纲
│   │   │   ├── researcher.py   # 单子问题（被并发调用）
│   │   │   ├── compiler.py
│   │   │   └── critic.py
│   │   └── graph.py
│   ├── retrievers/
│   │   ├── tavily.py
│   │   ├── exa.py
│   │   ├── arxiv.py
│   │   └── google_scholar.py
│   ├── tools/
│   │   ├── fetch.py            # 读取 URL 全文
│   │   └── cite.py             # 引用编号管理
│   └── prompts/
│       ├── brief.j2
│       ├── researcher.j2
│       └── compile.j2
└── tests/eval/data/topics.json
```

### 3.2 子问题分解

| 子问题类型 | 例子 |
| --- | --- |
| 定义类 | "X 是什么 / 与 Y 的区别" |
| 现状类 | "X 当前的主要玩家有哪些" |
| 数据类 | "X 市场规模在 2023–2025 的复合增长率" |
| 趋势类 | "X 在下一年的关键技术演化方向" |
| 案例类 | "X 在金融行业的 3 个落地案例" |

Plan 阶段强制输出 4–8 个子问题（不少不多）。

### 3.3 多源检索策略

| 源 | 强项 | 弱项 | 何时用 |
| --- | --- | --- | --- |
| Tavily | 通用 web | 学术弱 | 默认 |
| Exa（neural） | 语义匹配 | 中文弱 | 英文技术调研 |
| arXiv | 学术 | 慢、限学术 | 技术深度 |
| Google Scholar | 学术 + 综合 | 反爬 | 学术 backup |
| Crawl4AI / Firecrawl | 全文抓取 | 慢 | 关键 URL 深读 |

参考 [`../rag-advanced/04-hybrid-retrieval.md`](../rag-advanced/04-hybrid-retrieval.md) 的多源融合思路。

## 4. 关键代码片段

### 4.1 状态定义

```python
# src/graph/state.py
from typing import Annotated, TypedDict
from langgraph.graph.message import add_messages

class Citation(TypedDict):
    id: int
    url: str
    title: str
    snippet: str

class SubAnswer(TypedDict):
    sub_q: str
    answer: str
    citations: list[Citation]

class ResearchState(TypedDict):
    topic: str
    scope: dict | None        # {"lang": "zh", "since": "2025-01"}
    brief: str                # 题目澄清后的精炼描述
    outline: list[str]        # 章节大纲
    sub_questions: list[str]
    sub_answers: list[SubAnswer]
    citations: list[Citation]
    report_md: str | None
    critique_passes: int
    cost_usd: float
    messages: Annotated[list, add_messages]
```

### 4.2 LangGraph 节点（researcher 子图）

```python
# src/graph/nodes/researcher.py
from langchain_openai import ChatOpenAI
from src.retrievers import tavily, exa, arxiv
from src.tools.fetch import fetch_url

LLM = ChatOpenAI(model="gpt-4o-mini", temperature=0)

RESEARCH_PROMPT = """子问题：{sub_q}

检索片段：
{snippets}

请综合以上片段写出 200–400 字答案。每条事实后用 [n] 标注引用编号。
若片段不足以回答，明确写"现有材料不足"。
"""

async def research_one(sub_q: str, max_sources: int = 8) -> dict:
    # 多源并发
    tav = await tavily.search(sub_q, k=4)
    ex = await exa.search(sub_q, k=4)
    candidates = _dedup(tav + ex)[:max_sources]

    # 拉全文（仅对得分前 3 拉）
    full_texts = []
    for c in candidates[:3]:
        full_texts.append(await fetch_url(c["url"]))

    snippets = _format_snippets(candidates, full_texts)
    resp = LLM.invoke(RESEARCH_PROMPT.format(sub_q=sub_q, snippets=snippets))
    citations = _extract_citations(resp.content, candidates)
    return {"sub_q": sub_q, "answer": resp.content, "citations": citations}
```

### 4.3 主图（并发 fan-out → fan-in）

```python
# src/graph/graph.py
import asyncio
from langgraph.graph import StateGraph, START, END
from src.graph.state import ResearchState
from src.graph.nodes import (
    brief_node, plan_node, compile_node, critic_node,
)
from src.graph.nodes.researcher import research_one

async def parallel_research(state: ResearchState) -> dict:
    sem = asyncio.Semaphore(5)
    async def _run(q):
        async with sem:
            return await research_one(q)
    answers = await asyncio.gather(*(_run(q) for q in state["sub_questions"]))
    all_cites = [c for a in answers for c in a["citations"]]
    return {"sub_answers": answers, "citations": _renumber(all_cites)}

def build_graph():
    g = StateGraph(ResearchState)
    g.add_node("brief", brief_node)
    g.add_node("plan", plan_node)
    g.add_node("research", parallel_research)
    g.add_node("compile", compile_node)
    g.add_node("critic", critic_node)

    g.add_edge(START, "brief")
    g.add_edge("brief", "plan")
    g.add_edge("plan", "research")
    g.add_edge("research", "compile")
    g.add_edge("compile", "critic")
    g.add_conditional_edges(
        "critic",
        lambda s: "research" if s["critique_passes"] < 1 and s.get("needs_more") else END,
    )
    return g.compile()
```

### 4.4 Critic 节点（Reflection 模式）

```python
# src/graph/nodes/critic.py
CRITIC_PROMPT = """以下是初稿报告：
---
{report}
---
原始 brief：{brief}
请回答：
1. 是否每个 outline 段都被回答？
2. 是否有事实声明缺引用？
3. 是否存在自相矛盾？
4. 给出 3 条改进建议（如需要补做哪些 sub_q）。

输出 JSON：{{"pass": bool, "missing_sub_qs": [...], "issues": [...]}}
"""
```

详见 [`../agents/02-paradigms.md`](../agents/02-paradigms.md) §4 Reflection / Reflexion。

## 5. 评测设计

### 5.1 评测数据集

构造 20 个调研题目，覆盖：

| 维度 | 题目示例 |
| --- | --- |
| 技术调研 | "对比 LangGraph 与 OpenAI Agents SDK 的状态管理" |
| 市场调研 | "2025 年中国 RAG SaaS 主要玩家与定价" |
| 学术综述 | "LLM 多智能体强化学习近 12 个月进展" |
| 时效性 | "本月 Anthropic 新发布的产品" |
| 边角 | 超冷门概念 / 错别字主题 |

### 5.2 指标表

| 指标 | 通过线 | 方法 |
| --- | --- | --- |
| 引用 URL 可访问率 | ≥ 95% | 编译期 HTTP HEAD |
| 引用与正文对齐率 | ≥ 90% | LLM-as-judge：随机抽 5 条声明 + 引用判断是否支撑 |
| Outline 覆盖率 | ≥ 90% | 检查每个 outline 段长度 ≥ 100 字 |
| 报告字数 | 3k–8k 字 | 直接统计 |
| 端到端成本 | ≤ $1.5 | LangSmith usage |
| 时长 | ≤ 12 min | clock |
| 主观质量 | ≥ 4/5 | 人工双盲 |

### 5.3 评测脚本

```python
# tests/eval/run.py
from src.graph.graph import build_graph
from tests.eval.judges import url_check, citation_align, outline_coverage

DATASET = [...]  # 20 topics

def evaluate(topic):
    graph = build_graph()
    state = graph.invoke({"topic": topic["title"], "scope": topic.get("scope")})
    return {
        "url_ok": url_check(state["citations"]),
        "cite_align": citation_align(state["report_md"], state["citations"]),
        "outline_cov": outline_coverage(state["outline"], state["report_md"]),
        "cost": state["cost_usd"],
        "len": len(state["report_md"]),
    }
```

## 6. 上线考虑

### 6.1 长任务挑战

| 问题 | 方案 |
| --- | --- |
| 10 min 超过 HTTP 超时 | 任务队列（Celery / Dramatiq），返回 job_id |
| 中途失败 | 每节点 checkpoint，从最近成功节点恢复 |
| 用户中途想看进度 | 流式：每完成 1 个子问题推送一条 SSE |
| 重复任务 | 主题 hash 缓存 24h |

### 6.2 成本控制

| 杠杆 | 节省 |
| --- | --- |
| Brief / Critic 用 gpt-4o-mini | 60% |
| 检索结果 LRU 缓存 | 30% |
| 子问题并发上限 = 5 | 防爆炸 |
| critic 最多 1 轮（不要无限 reflect）| 防发散 |

### 6.3 引用诚信

- URL 编译期 HEAD 200 才纳入
- 标注"未验证"标记（HEAD 失败但有快照）
- 永远不"美化"——LLM 倾向编造看似学术的引用，必须删

## 7. Trade-off 讨论：单 Agent vs Supervisor

| 维度 | 单 Agent（ReAct）| Supervisor + Researcher 池（选） |
| --- | --- | --- |
| 并发能力 | 串行调用工具 | 子问题并发，10 min → 3 min |
| 上下文长度 | 滚雪球 50k+ | 每 researcher 独立 8k |
| 失败粒度 | 一处错全废 | 单 sub_q 失败可独立 retry |
| 编排复杂度 | 低 | 中（要管 fan-out/fan-in） |
| 调试 | 难（trace 长）| 容易（每 researcher 独立 trace） |

参考 [`../agents/06-multi-agent.md`](../agents/06-multi-agent.md) §3 Supervisor 模式。

## 常见坑

1. **子问题相似度高**：5 个都是"X 是什么"换皮 → plan prompt 强制每个角度不同 + cosine 去重。
2. **检索全是 SEO 垃圾**：Tavily 默认会返回低质 → 配 `include_domains` 偏向官方/学术；或追加 Exa 神经索引。
3. **报告头重脚轻**：第 1 段 1k 字，最后一段 200 字 → 在 compile prompt 里给出"每段 ±50 字"约束。
4. **引用编号错乱**：并发后合并 → 必须重编号（保留 URL→新编号 mapping）。
5. **Critic 总是不通过**：无限 reflect 烧钱 → 硬上限 1 轮，第 2 轮直接接受。
6. **PDF / paywall 抓不到**：要么跳过、要么仅用 abstract；不要让 LLM 编造内容。
7. **没有时效 filter**：调研"今天发生的事"返回 2022 年的内容 → scope.since 注入检索 query。
8. **中文 + Exa**：Exa 中文效果差 → 中文走 Tavily + 搜狗学术混合。

## 下一步

- 看产品参考：GPT Researcher、Open Deep Research（README 链接）
- 下一个项目：[§04 客服 Agent](./04-customer-support.md)（HITL 更深 + 多轮记忆）
- 复习多 Agent：[`../agents/06-multi-agent.md`](../agents/06-multi-agent.md)
- Agentic RAG：[`../rag-advanced/07-agentic-rag.md`](../rag-advanced/07-agentic-rag.md)
- 评测细节：[`../eval/06-rag-eval.md`](../eval/06-rag-eval.md)
