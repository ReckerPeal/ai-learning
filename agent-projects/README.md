# Agent 实战项目集

> **学完 10 章理论，还是写不出一个能上线的 Agent**——这是 80% 学习者的真实状态。本主题用 6 个端到端项目把零散知识串成完整应用：从需求拆解到架构、从评测到上线 checklist，全部按工程节奏走一遍。

## 本主题的定位

| 维度 | 说明 |
| --- | --- |
| **目标读者** | 已经读完 `agents/` 或 `langgraph/`，开始要交付真实项目的工程师 / 学生 |
| **对标** | hello-agents 13–16 章（项目实战），但更工程化（评测、监控、上线 checklist） |
| **形态** | 每章一个完整项目（业务背景 → 架构图 → 关键代码 → 评测 → 上线考虑） |
| **代码风格** | LangGraph + LangChain + FastAPI 为主，少量 OpenAI SDK / Claude Agent SDK 对照 |

### 本主题**不会教**

- Agent 基础概念（看 `../agents/`）
- LangGraph 状态机的最小教程（看 `../langgraph/02-quickstart.md`）
- RAG 的切分、检索算法（看 `../rag-advanced/`）
- 通用评测指标公式（看 `../eval/`）

### 本主题**会教**

- 真实业务怎么拆成 Agent 任务（PDCA 节奏）
- 6 个有差异的项目：旅行、调研、客服、代码审查、数据分析、知识库
- 每个项目的**架构决策记录**（为什么用 Plan-and-Execute 不用 ReAct？为什么 HITL 在第 3 步？）
- 评测、监控、灰度——把 demo 变成产品的最后一公里
- 6 个项目之间的**共性 vs 差异**：什么模式可以复用，什么是踩坑后的妥协

## 章节索引

1. [01 · 项目方法论](./01-methodology.md) — 需求→架构→评测→上线的 PDCA 流程、ADR、风险矩阵
2. [02 · 项目1：智能旅行助手](./02-travel-assistant.md) — 多工具协作、行程规划、HITL 确认下单
3. [03 · 项目2：自动化深度调研](./03-deep-research.md) — Plan-and-Execute、多源检索、长文报告生成
4. [04 · 项目3：客服 Agent](./04-customer-support.md) — HITL + 多轮记忆 + 工单系统对接
5. [05 · 项目4：代码审查 Agent](./05-code-review.md) — CI 集成、PR 评论分级、避免 nit 噪音
6. [06 · 项目5：数据分析助手](./06-data-assistant.md) — Text-to-SQL + Plot + 自然语言报告
7. [07 · 项目6：知识库 Agent](./07-kb-agent.md) — RAG + Memory + 多租户、权限隔离
8. [08 · 6 个项目横向对比](./08-comparison.md) — 架构差异 / 共性 / 失败模式表
9. [09 · 统一评测与监控](./09-eval-monitoring.md) — trace、metrics、cost dashboard 一套打通
10. [10 · 通用上线 checklist](./10-launch-checklist.md) — 安全 / 评测 / 监控 / 容灾 / 灰度

## 与其他主题的关系（速查表）

| 想了解 | 看哪 | 在本主题如何用 |
| --- | --- | --- |
| Agent 设计范式（ReAct / Plan-Execute / Reflection） | [`../agents/02-paradigms.md`](../agents/02-paradigms.md) | §02、§03、§06 项目里的 trade-off 讨论 |
| Agent 工具设计与错误恢复 | [`../agents/04-tool-use.md`](../agents/04-tool-use.md) | §02 旅行工具集、§06 SQL 工具 |
| Agent 多智能体拓扑 | [`../agents/06-multi-agent.md`](../agents/06-multi-agent.md) | §03 调研项目 supervisor 模式 |
| LangGraph 状态机、控制流 | [`../langgraph/04-control-flow.md`](../langgraph/04-control-flow.md) | 所有项目的节点编排 |
| LangGraph 持久化与 HITL | [`../langgraph/06-persistence.md`](../langgraph/06-persistence.md)、[`07-human-in-the-loop.md`](../langgraph/07-human-in-the-loop.md) | §02、§04 的中断/恢复 |
| LangChain 工具与函数调用 | [`../langchain/06-tools-and-function-calling.md`](../langchain/06-tools-and-function-calling.md) | 所有项目工具封装 |
| LangChain RAG | [`../langchain/07-rag.md`](../langchain/07-rag.md) | §07 知识库 Agent |
| Agentic RAG、检索策略 | [`../rag-advanced/07-agentic-rag.md`](../rag-advanced/07-agentic-rag.md) | §03、§07 |
| RAG 评测 | [`../rag-advanced/09-evaluation.md`](../rag-advanced/09-evaluation.md) | §09 评测方案 |
| Agent 评测方法 | [`../eval/07-agent-eval.md`](../eval/07-agent-eval.md) | §09 的指标设计 |
| 在线 A/B、灰度 | [`../eval/08-online-and-ab.md`](../eval/08-online-and-ab.md) | §10 上线 checklist |
| CI 中的回归评测 | [`../eval/09-ci-and-regression.md`](../eval/09-ci-and-regression.md) | §05、§09 |
| Coding Agent 产品形态 | [`../coding-agent/01-overview.md`](../coding-agent/01-overview.md) | §05 代码审查 |
| Coding Agent 沙箱 | [`../coding-agent/05-sandbox.md`](../coding-agent/05-sandbox.md) | §05、§06 工具执行 |
| 工具安全 / 多 agent 安全 | [`../llm-security/06-tool-safety.md`](../llm-security/06-tool-safety.md)、[`../llm-security/07-multi-agent-safety.md`](../llm-security/07-multi-agent-safety.md) | §10 上线 checklist |
| Prompt 注入防御 | [`../llm-security/02-prompt-injection.md`](../llm-security/02-prompt-injection.md) | §04、§07 输入校验 |

## 资源

### 参考实现（可直接读源码）

- **GPT Researcher** — <https://github.com/assafelovic/gpt-researcher> — §03 深度调研的最广为流传开源参考
- **Open Deep Research（LangChain）** — <https://github.com/langchain-ai/open_deep_research> — Plan-and-Execute 调研 agent 模板
- **LangGraph 官方 examples** — <https://github.com/langchain-ai/langgraph/tree/main/examples> — supervisor、customer-support、reflection 各一份
- **Vanna.AI** — <https://github.com/vanna-ai/vanna> — §06 Text-to-SQL 参考
- **PandasAI** — <https://github.com/sinaptik-ai/pandas-ai> — §06 数据助手另一路径
- **CodeRabbit / PR-Agent** — <https://github.com/qodo-ai/pr-agent> — §05 代码审查参考
- **Chatwoot / FastGPT** — §07 知识库 / 客服 SaaS 参考

### 数据集（评测可直接用）

| 数据集 | 用途 | 链接 |
| --- | --- | --- |
| τ-bench (tau-bench) | 客服 / 工具调用 agent 评测 | <https://github.com/sierra-research/tau-bench> |
| WebArena | 浏览器任务 | <https://webarena.dev/> |
| GAIA | 通用 agent 评测 | <https://huggingface.co/gaia-benchmark> |
| BIRD-SQL | Text-to-SQL | <https://bird-bench.github.io/> |
| Spider 2.0 | 复杂 SQL 评测 | <https://spider2-sql.github.io/> |
| SWE-bench Verified | 代码 agent | <https://www.swebench.com/> |
| MS MARCO / BEIR | RAG 检索基线 | <https://microsoft.github.io/MSMARCO-Passage-Ranking/> |

### 工具与平台

- **追踪**：LangSmith / LangFuse / Phoenix（Arize） / Opik (Comet)
- **向量库**：Qdrant / Weaviate / pgvector / Milvus
- **沙箱**：E2B / Modal / Docker（看 [`../coding-agent/05-sandbox.md`](../coding-agent/05-sandbox.md)）
- **HITL UI**：Streamlit / Gradio / LangGraph Studio
- **任务队列**：Celery / Dramatiq / Temporal（长任务）
- **可观测**：OpenTelemetry + Grafana / SigNoz

### 论文（按项目对应）

- *Plan-and-Solve Prompting*（Wang et al., 2023）— §03
- *ReAct*（Yao et al., 2022）— 多个项目对照
- *Reflexion*（Shinn et al., 2023）— §03、§05
- *τ-bench: A Benchmark for Tool-Agent-User Interaction*（Sierra, 2024）— §04 评测
- *Self-RAG*、*Corrective RAG (CRAG)* — §07
- *AutoGen: Enabling Next-Gen LLM Applications via Multi-Agent Conversation*（Microsoft, 2023）

### 模板（直接 fork）

- **LangGraph Cloud templates** — <https://github.com/langchain-ai/langgraph/tree/main/libs/cli/langgraph_cli/templates>
- **OpenAI Agents SDK examples** — <https://github.com/openai/openai-agents-python/tree/main/examples>
- **CrewAI examples** — <https://github.com/crewAIInc/crewAI-examples>

## 阅读顺序建议

按项目类型分 4 条路径，可以根据手头的目标挑一条走：

- **C 端工具型产品**（旅行 / 助手类）：§01 → §02 → §06 → §09 → §10
- **B 端运营型产品**（客服 / 知识库 / 工单）：§01 → §04 → §07 → §09 → §10
- **研发内部工具**（代码审查 / 数据分析）：§01 → §05 → §06 → §08 → §10
- **研究 / 评测向**（深度调研、长任务）：§01 → §03 → §08 → §09 → §10
- **全面通读**：§01 → §02 → §03 → §04 → §05 → §06 → §07 → §08 → §09 → §10
- **不想读细节，只看结论**：§01 → §08（共性/差异） → §10（checklist）

每章末尾的「下一步」会指向相邻项目或 `agents/`、`langgraph/` 的对应章节，方便回炉。

---

**仓库索引**：[../README.md](../README.md)
