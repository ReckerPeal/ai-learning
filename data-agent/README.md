# Data Analysis Agent

> 数据分析是 LLM Agent **B 端最快变现**的方向：每家公司都有数据库、表格、报表需求，每个业务方都想"问一句话出一张图"。把这条赛道吃透，就能在企业内同时落地 NL2SQL、Pandas Agent、可视化生成、自动报告——一套基础设施撑起十个 BI 工具。

数据分析 Agent 的本质：**把"自然语言问题"翻译成"可执行的数据操作（SQL / Python / DSL）"，跑在受控环境里，再把结果用图、表、文字三种形态返还给业务方**。它和通用 Coding Agent 共享沙箱、工具、规划的底座，但在 schema 注入、结果正确性、可视化、数据安全四个维度上有自己的工程问题。

**会教什么**：

- SQL Agent 的核心闭环：schema 注入 → few-shot → 生成 → 执行 → 错误恢复
- NL2SQL 进阶：多表 join、CTE、业务语义编码、Spider/BIRD 评测
- Pandas / Code Interpreter 模式：把 DataFrame 操作交给 LLM 时的内存与安全
- 可视化生成：从图表类型推荐到 Vega-Lite/Plotly 自动出图
- 自动报告：把"数据 + 图 + 叙事"组装成可发送的 Markdown / PPT
- 多源数据整合：CSV / SQL / API / Excel / Parquet + Catalog
- 数据质量：LLM-assisted profiling、异常检测、schema drift
- 评测：结果正确性 + 代码可读性 + Spider/BIRD/WikiSQL 基准

**不会教什么**（去对应主题）：

- 通用 Agent 范式、工具设计 → [`../agents/`](../agents/)
- 代码执行沙箱细节 → [`../coding-agent/05-sandbox.md`](../coding-agent/05-sandbox.md)
- 通用 RAG（文档问答）→ [`../rag-advanced/`](../rag-advanced/)
- 通用评测框架 → [`../eval/`](../eval/)
- Prompt 注入、SQL 注入纵深防御 → [`../llm-security/`](../llm-security/)

## 章节索引

1. [01 · 场景全景](./01-overview.md) — BI 自助 / 自动报表 / 探索分析 / 数据问答的形态对比与边界。
2. [02 · SQL Agent 基础](./02-sql-agent.md) — Schema 注入、Few-shot、错误恢复、retry-with-error 的标准闭环。
3. [03 · NL2SQL 进阶](./03-nl2sql-advanced.md) — 多表 join、子查询、CTE、business-logic encoding 与语义层。
4. [04 · Pandas / DataFrame Agent](./04-pandas-agent.md) — Code Interpreter 模式、内存安全、LangChain & PandasAI 路径对比。
5. [05 · 可视化生成](./05-visualization.md) — Matplotlib / Plotly / Vega-Lite Agent、图表类型推荐、Lida / Chat2Plot。
6. [06 · 报告生成](./06-report-generation.md) — 结构化 + 叙事、Insight Extraction、Markdown / PPT / Notion 输出。
7. [07 · Code Interpreter 模式](./07-code-interpreter.md) — OpenAI / Claude / 自建沙箱的执行链路、富输出、超时与重试。
8. [08 · 数据质量与清洗](./08-data-quality.md) — 缺失值、异常值、schema drift、LLM-assisted profiling。
9. [09 · 多源数据](./09-multi-source.md) — CSV / SQL / API / Excel / Parquet 整合 + Catalog + 路由层。
10. [10 · 评测](./10-evaluation.md) — 结果正确性 + 代码可读性 + Spider / BIRD / WikiSQL 跑分。

## 与其他主题的关系（速查表）

| 主题 | 关系 |
| --- | --- |
| [`../agents/`](../agents/) | Data Agent 是 Agent 范式（[02-paradigms](../agents/02-paradigms.md)、[04-tool-use](../agents/04-tool-use.md)、[05-planning](../agents/05-planning.md)）的最典型落地之一。工具设计七条铁律全部适用。 |
| [`../coding-agent/`](../coding-agent/) | 第 [04](./04-pandas-agent.md)、[07](./07-code-interpreter.md) 章直接复用 [`05-sandbox`](../coding-agent/05-sandbox.md) 的隔离方案。Pandas Agent 就是带数据的 Coding Agent。 |
| [`../rag-advanced/`](../rag-advanced/) | Schema 注入本质是"对表结构的 RAG"。第 [02 章](./02-sql-agent.md) 引用 [`08-multimodal-and-structured`](../rag-advanced/08-multimodal-and-structured.md) 的结构化检索。 |
| [`../eval/`](../eval/) | 第 [10 章](./10-evaluation.md) 把 [`agent-eval`](../eval/07-agent-eval.md) 的方法用在 NL2SQL / Pandas 上：execution accuracy、组件级指标。 |
| [`../llm-security/`](../llm-security/) | SQL 注入、读写权限、PII 泄露见 [`06-tool-safety`](../llm-security/06-tool-safety.md)；prompt 注入混进表格数据见 [`02-prompt-injection`](../llm-security/02-prompt-injection.md)。 |
| [`../langgraph/`](../langgraph/) | 多轮 SQL 修复（生成 → 执行 → 报错 → 修复 → 再执行）天然适合状态机。 |
| [`../langchain/`](../langchain/) | `SQLDatabaseToolkit` / `create_pandas_dataframe_agent` 是最常用的入门脚手架（但生产要替换）。 |

## 资源

**评测基准**

- BIRD-SQL — <https://bird-bench.github.io/> — 跨库、含业务知识的 NL2SQL 标杆（最难，目前 SOTA ~70%）
- Spider 2.0 — <https://spider2-sql.github.io/> — Spider 升级版，企业级仓库与多语言
- Spider 1.0 — <https://yale-lily.github.io/spider> — 跨库 NL2SQL 经典基准
- WikiSQL — 单表 NL2SQL 起点（偏简单）
- DS-1000 — <https://ds1000-code-gen.github.io/> — 数据科学代码生成（Pandas / NumPy / sklearn）
- ARC-AGI / TableBench — 结构化数据推理

**开源产品 / 框架**

- Vanna AI — <https://vanna.ai/> — 基于 RAG 的 NL2SQL，开源 + SaaS 双模
- PandasAI — <https://github.com/sinaptik-ai/pandas-ai> — Pandas Agent 标杆实现
- LangChain SQL Agent — <https://python.langchain.com/docs/tutorials/sql_qa/> — 入门脚手架
- LlamaIndex Text-to-SQL — <https://docs.llamaindex.ai/en/stable/examples/index_structs/struct_indices/SQLIndexDemo/> — 含 schema 索引
- Defog SQLCoder — <https://github.com/defog-ai/sqlcoder> — 开源 SQL 专用模型
- DataLine — <https://github.com/RamiAwar/dataline> — 自托管 NL2SQL 全栈
- Wren AI — <https://github.com/Canner/WrenAI> — 带语义层的 NL2SQL
- Lida — <https://github.com/microsoft/lida> — Microsoft 出的可视化 Agent
- Chat2Plot — <https://github.com/nyanp/chat2plot> — 受控可视化生成
- OpenAI Code Interpreter / Claude Code Execution — 一线 Code Interpreter 体验
- Hex / Mode / Hex Magic — 商业 SaaS 中嵌入 AI 的 Notebook

**数据集 / 示例 DB**

- Sakila / Northwind / Chinook — 经典练习库
- Spider databases — 200 个真实库 schema
- BIRD databases — 95 个跨领域库 + 业务知识 doc
- Kaggle datasets — Pandas Agent 调试常用
- DuckDB sample data — <https://duckdb.org/docs/data/sample> — 嵌入式测试

**论文**

- *RAT-SQL* (Wang et al., 2020) — 关系感知 schema encoding
- *PICARD* (Scholak et al., 2021) — 约束解码保 SQL 合法
- *DIN-SQL* (Pourreza & Rafiei, 2023) — 任务分解 + self-correction，Spider SOTA 一段时间
- *DAIL-SQL* (Gao et al., 2023) — In-context learning 综合方案
- *MAC-SQL* (Wang et al., 2024) — Multi-Agent NL2SQL 协作
- *CHESS* (Talaei et al., 2024) — Schema linking + value retrieval + 多步精修
- *TAG: Table Augmented Generation* (Biswal et al., 2024) — 把 SQL 与 LLM 推理统一
- *BIRD* (Li et al., 2023) — 跨库 + 知识增强 SQL 基准论文

**官方博客 / 实战报告**

- Pinterest 的 NL2SQL 实战 — <https://medium.com/pinterest-engineering>
- Uber QueryGPT — <https://www.uber.com/blog/query-gpt/>
- Shopify Sidekick / Magic — 商家侧 BI Agent
- Snowflake Cortex Analyst — 仓库内 NL2SQL
- Databricks Genie — Lakehouse 上的对话式 BI

## 阅读顺序建议

- **完整路径**：§01 → §02 → §03 → §04 → §05 → §06 → §07 → §08 → §09 → §10。
- **只做 NL2SQL（最常见 PoC）**：§01 → §02 → §03 → §10（评测先行）。
- **做 ChatGPT-Code-Interpreter 风格产品**：§01 → §04 → §07 → §05 → §08。
- **做企业级 BI Copilot（带语义层 + 报告）**：§01 → §03 → §06 → §09 → §10。
- **关心安全 / 合规优先**：§01 → §02（SQL 注入小节）→ §07（沙箱）→ 跳读 [`../llm-security/06-tool-safety.md`](../llm-security/06-tool-safety.md)。
- **从评测倒推工程**：§10 → §02 → §03（先有跑分再谈架构）。

**仓库索引**：[../README.md](../README.md)
