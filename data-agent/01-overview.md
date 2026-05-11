# 01 · 场景全景

Data Analysis Agent 不是"一个产品"，是**四类业务形态共享同一套底座**。先把场景划清楚——你做的是 BI 自助、自动报表、探索分析，还是数据问答？四类的 RICE 不同、技术栈不同、评测口径也不同。本章把全景画完，后续 9 章再分别钻。

## 1. 四种典型形态

| 形态 | 谁用 | 输入 | 输出 | 关键技术 |
| --- | --- | --- | --- | --- |
| **BI 自助** | 业务分析师 / 产品 / 运营 | 自然语言问题 | SQL + 表格 + 图 | NL2SQL + 语义层 |
| **自动报表** | 管理层 | 定时触发（每日 9 点）| 邮件 / PPT / 飞书 doc | 报告生成 + 调度 |
| **探索分析（EDA）** | 数据科学家 / 算法 | 一个 DataFrame + 一句话 | 代码 + 图 + 洞察 | Code Interpreter |
| **数据问答（Q&A）** | 销售 / 客服 / 高管 | 一句话（"上月华南 GMV"）| 一句话 + 数字 | NL2SQL + 摘要 |

**速判**：

- "我们要给业务方做个 Chat-BI" → 形态 1 + 形态 4 的合体（先 SQL 后摘要）。
- "PM 不想自己跑 SQL，每天看报表" → 形态 2（调度 + 模板）。
- "DS 在 Jupyter 里要 AI 帮做 EDA" → 形态 3（Code Interpreter）。
- "客服侧'本月退款金额'弹窗" → 形态 4（窄场景、固定模板）。

四个形态的**核心 95% 相同**——schema 注入、SQL 生成、执行沙箱、错误恢复都共享。差异在"输出层"和"触发方式"。

## 2. 架构总图

```
            ┌──────────────────────────────────────────┐
            │       User: 自然语言问题 / 调度触发        │
            └──────────────────────────────────────────┘
                              │
                              ▼
     ┌─────────────────────────────────────────────────┐
     │  1. Intent & Routing                            │
     │     "这是 SQL 类？Pandas 类？还是闲聊？"          │
     └─────────────────────────────────────────────────┘
                              │
                              ▼
     ┌─────────────────────────────────────────────────┐
     │  2. Schema / Context Retrieval（RAG over meta）  │
     │     表名 / 列名 / 业务术语 / 历史问题             │
     └─────────────────────────────────────────────────┘
                              │
                              ▼
     ┌─────────────────────────────────────────────────┐
     │  3. Code Generation（SQL / Pandas / Vega-Lite） │
     └─────────────────────────────────────────────────┘
                              │
                              ▼
     ┌─────────────────────────────────────────────────┐
     │  4. Sandbox Execution（DB / Python / Plot）     │
     │     失败 → retry-with-error 回到 §3              │
     └─────────────────────────────────────────────────┘
                              │
                              ▼
     ┌─────────────────────────────────────────────────┐
     │  5. Result Formatting（table / chart / narrative│
     └─────────────────────────────────────────────────┘
```

每一层在后续章节展开：§2 注入 + §3 生成 → [02](./02-sql-agent.md)/[03](./03-nl2sql-advanced.md)；§4 执行 → [07](./07-code-interpreter.md)；§5 输出 → [05](./05-visualization.md)/[06](./06-report-generation.md)。

## 3. 与通用 Coding Agent 的边界

经常有人问："Data Agent 不就是 Coding Agent 跑 SQL 吗？" 一半对。共享/差异表：

| 维度 | Coding Agent | Data Agent |
| --- | --- | --- |
| 主要语言 | Python / TS / Rust | **SQL** + Python |
| 代码上下文 | 仓库（百万行） | **Schema**（数千列）+ 历史 query |
| 执行环境 | 通用 Docker | **DB connection** + Notebook kernel |
| 错误恢复 | 编译报错、测试失败 | **SQL syntax** / **空结果** / **wrong join** |
| 评测 | SWE-bench、HumanEval | **Spider / BIRD** / 执行结果一致 |
| 风险 | rm -rf、git push | **写穿生产库**、PII 泄露、慢查询打挂仓库 |
| 输出 | diff / patch | **表格 + 图 + 文字** |

**结论**：Data Agent 是 Coding Agent 的"垂直特化版"——沙箱、工具设计沿用，但 schema 注入、SQL 评测、可视化是自己的工程问题。

## 4. 真实产品形态对比

| 产品 | 形态 | 核心定位 | 技术亮点 |
| --- | --- | --- | --- |
| OpenAI Code Interpreter / Advanced Data Analysis | 3 | 上传 CSV/Excel，跑 Python | 内置沙箱 + 富输出（图、文件） |
| Claude Analysis Tool | 3 | 浏览器内 JS 沙箱跑数据 | 客户端执行，无数据上传 |
| Vanna AI | 1 | 开源 NL2SQL + RAG | 把 schema/历史 query 当 RAG 文档 |
| Wren AI | 1 | 带 semantic layer 的 NL2SQL | MDL 语义层减少幻觉 |
| Snowflake Cortex Analyst | 1 | 仓库原生 BI Copilot | 语义模型 + 仓内执行 |
| Databricks Genie | 1 | Lakehouse 上的对话 BI | 复用 Unity Catalog 权限 |
| Uber QueryGPT | 1 | 内部 SQL 助手 | RAG over 30K 历史 query |
| Hex Magic | 3 | Notebook 内 AI | 编辑 cell / 解释结果 |
| PandasAI | 3 | Pandas 包的 LLM 增强 | `df.chat("...")` API |
| Defog | 1 | 离线小模型 NL2SQL | SQLCoder 7B/15B 可本地跑 |

**观察**：

- B 端做 BI（形态 1）通常**要求结果可追溯**——必须显示 SQL，业务方可以改。
- C 端做 EDA（形态 3）**要求体验流畅**——隐藏代码，直接出图。
- "形态 1 + 不让业务方看 SQL"基本必死——错了一次就再也不信。

## 5. 一个最小可跑的 SQL Agent（preview）

后续章节会把每一步深挖。先看一遍闭环长什么样：

```python
"""
最小 SQL Agent：自然语言 → SQL → 结果。
依赖：pip install langchain langchain-openai sqlalchemy
仅用作概念演示，生产请看 §02-§03。
"""
from langchain_openai import ChatOpenAI
from langchain_community.utilities import SQLDatabase
from langchain_community.agent_toolkits import create_sql_agent

db = SQLDatabase.from_uri("sqlite:///chinook.db")  # 经典样例库
llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)

agent = create_sql_agent(llm=llm, db=db, agent_type="openai-tools", verbose=True)
print(agent.invoke({"input": "Top 5 countries by total invoice amount in 2009?"}))
```

这就是形态 1 + 形态 4 的雏形。**坑**：

- 直接把整个 DB schema 塞 prompt → 表多了就爆 context。
- 没有 retry-with-error → 一次 SQL 错就吐错给用户。
- 没有权限隔离 → LLM 编出 `DROP TABLE` 直接跑。
- 没有评测 → 你不知道它对的概率是 30% 还是 90%。

四个坑分别由 §02 / §02 / §07 / §10 解决。

## 6. 复杂度阶梯（落地路线图）

按 ROI 倒序，从最快出价值开始：

| Level | 范围 | 工作量 | 用户感受 |
| --- | --- | --- | --- |
| L0 | 固定 5 个高频问题 → 模板 SQL，LLM 仅做参数提取 | 1 周 | 准确率 99%，覆盖低 |
| L1 | 单表 NL2SQL + 简单聚合 | 2–4 周 | 准确率 ~85%，开始有 wow |
| L2 | 多表 join + 时间窗口 + group by | 1–2 月 | 准确率 60–75%，开始遇到现实复杂度 |
| L3 | 加业务语义层（指标定义、维度别名）| 2–3 月 | 准确率回到 85%+ |
| L4 | 加可视化 + 报告 + 多源数据 | 3–6 月 | 完整 BI Copilot |
| L5 | EDA + Pandas Agent + 自动洞察 | 6 月+ | 比肩 Code Interpreter |

**经验**：跳过 L0 直接做 L2 是最常见的失败。**先把"业务方最常问的 20 个问题"模板化**，再用 NL2SQL 兜住长尾。

## 7. 评测先于工程

数据 Agent **没有客观评测就是黑盒**。第一周就要：

| 评测层 | 度量 | 工具 |
| --- | --- | --- |
| SQL 等价 | execution match | DB diff |
| 语义等价 | LLM-as-judge | gpt-4o |
| 可读性 | 列名、注释、CTE 命名 | rubric |
| 安全 | 是否含写操作、是否越权 | regex + ACL check |

数据集：**Spider / BIRD 开局，自家 200 条 golden questions 收尾**。详见 [§10 · 评测](./10-evaluation.md)。

## 8. 团队配置与角色

落地一个生产级 Data Agent 通常需要：

| 角色 | 职责 | 比例 |
| --- | --- | --- |
| 数据工程 | 表清理、语义层维护 | 30% |
| LLM 工程 | Prompt、Agent 编排、评测 | 30% |
| 前端 | 表格 / 图表组件、SQL editor | 20% |
| 业务对接 | 需求分类、golden set 标注 | 20% |

**最容易缺的**是"业务对接"——没人标 golden set，LLM 工程师永远在猜需求。

## 9. 用户体验四个细节

技术对了，产品上线第一周还可能崩——细节决定信任：

| 细节 | 错示 | 对示 |
| --- | --- | --- |
| 露出 SQL | 只显示数字 | 数字 + SQL + "编辑 SQL" 按钮 |
| 数字格式 | `1250000.0` | `1,250,000`、`125 万`、`$1.25M` |
| 时间口径 | "上月" 不解释 | "上月 = 2026-04（4 月 1 日 - 4 月 30 日）" |
| 无数据时 | 空白页 | "未匹配到符合条件的订单——是否过滤条件过严？" |

业务方信任一旦失去，**重建成本远高于做对**。

## 10. 与本系列其他主题的依赖图

```
data-agent/                                 ←── 本系列
   ├── §02 SQL Agent      ──depends on──► rag-advanced/（schema 检索本质是 RAG）
   ├── §04 Pandas Agent   ──depends on──► coding-agent/05-sandbox.md
   ├── §06 Report         ──depends on──► langgraph/（多步状态机）
   ├── §07 Code Interpr.  ──depends on──► coding-agent/05-sandbox.md
   ├── §10 评测            ──depends on──► eval/07-agent-eval.md
   └── 全章                ──depends on──► agents/（工具设计、规划范式）
                          ──guarded by──► llm-security/06-tool-safety.md
```

读本系列前**至少需要的前置知识**：

- 已读 [`../agents/04-tool-use.md`](../agents/04-tool-use.md)（工具设计七条铁律）
- 已读 [`../coding-agent/05-sandbox.md`](../coding-agent/05-sandbox.md)（沙箱基础）
- 大致看过 [`../eval/01-overview.md`](../eval/01-overview.md)（评测心智）

否则建议先开两扇窗——本系列不重复造轮子。

## 常见坑

1. **把所有问题都丢给 NL2SQL**：80% 的查询是 20 个高频问题，**模板化它们**比追求"通用 NL2SQL"性价比高 10 倍。
2. **schema 全塞 prompt**：30 张表 × 20 列 = 几千 token，没必要。**先做 schema 检索**（§02）。
3. **跳过"显示 SQL"**：业务方第一次发现 LLM 编错，整个产品信任崩塌。**永远露出 SQL + 一键改**。
4. **没读写隔离**：用同一个 DB 账号既能 select 又能 drop。**只给只读账号 + 视图层**。
5. **不设超时**：业务方一句"全表 join"把仓库打挂。**所有 query 强制 timeout + LIMIT**。
6. **没评测就上线**：上线第二周开始有人投诉数字不对，无法定位是 SQL 错、口径错、还是真实业务变化。**先评测后产品**。

## 下一步

- [02 · SQL Agent 基础](./02-sql-agent.md) — 把 §5 的玩具变成真闭环：schema 检索、few-shot、错误恢复。
- [04 · Pandas Agent](./04-pandas-agent.md) — 形态 3（EDA）的核心：Code Interpreter 路径。
- [07 · Code Interpreter](./07-code-interpreter.md) — 执行链路细节，沙箱选型见 [`../coding-agent/05-sandbox.md`](../coding-agent/05-sandbox.md)。
- [10 · 评测](./10-evaluation.md) — Spider / BIRD 怎么跑、golden set 怎么搭。
- 形态 1 实战起步：[`../langchain/`](../langchain/) 的 SQL toolkit + [`../langgraph/`](../langgraph/) 的状态机。
- 安全旁路读：[`../llm-security/06-tool-safety.md`](../llm-security/06-tool-safety.md) 关于 SQL/Tool 权限的章节。
