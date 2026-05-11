# 09 · 框架对比

> 对应 [hello-agents](https://github.com/datawhalechina/hello-agents) 第 6 章。
> 本章横向对比主流 Agent 框架（截至 2025 年中），给清楚**各自定位、何时选哪个、迁移路径**。

## 1. 框架概览（10 秒版）

| 框架 | 出品方 | 范式 | 适合 |
|---|---|---|---|
| **LangGraph** | LangChain | 状态机 / 图 | 通用、定制深、生产首选 |
| **LangChain (LCEL)** | LangChain | 管道 / Chain | 无状态链、RAG、Prompt 工程 |
| **AutoGen** | Microsoft | Multi-Agent / 消息总线 | 多 Agent 协作、研究 |
| **CrewAI** | CrewAI Inc. | Role-based 协作 | "团队"模式、易上手 |
| **AgentScope** | 阿里 | 多 Agent / 分布式 | 工业级多 Agent、中文场景 |
| **Smolagents** | Hugging Face | Code agents | 极简、研究、教学 |
| **OpenAI Agents SDK** | OpenAI | Handoff / Swarm | OpenAI 生态、轻量 |
| **Claude Agent SDK** | Anthropic | Agent + MCP | Claude 生态、强 MCP 集成 |
| **Pydantic AI** | Pydantic | Type-safe Agent | Python 严格类型派 |

## 2. LangGraph

> 已在 [`langgraph/`](../langgraph/) 全面覆盖。本章只做对比定位。

**核心抽象**：`State` + `Node` + `Edge`，用图明确控制流。

**优势**：
- 控制流灵活（循环、分支、并行、子图、HITL）
- 状态管理一等公民（Checkpointer 时间旅行）
- 流式 / 异步 / 多 stream_mode 完整
- 与 LangChain 生态无缝
- 调试友好（LangSmith trace）

**劣势**：
- 学习曲线（需要理解 reducer、超步、Pregel）
- 代码量比 CrewAI 多
- 偏 LangChain 风格，迁移到其他生态有成本

**何时选**：
- 需要复杂控制流（HITL、retry、条件分支）
- 需要持久化状态、时间旅行
- 已用 LangChain 生态
- 长期演化的产品（不是一次性 demo）

## 3. LangChain（LCEL）

**核心抽象**：`Runnable`，用 `|` 组合成管道。

**对比 LangGraph**：

| 维度 | LangChain (LCEL) | LangGraph |
|---|---|---|
| 控制流 | DAG（不能回头） | 任意图（可循环） |
| 状态 | 无状态 | 有状态 + checkpoint |
| 适合 | RAG / Chain / Prompt 工程 | Agent / 工作流 |
| 难度 | 低 | 中高 |

**何时选**：
- 任务是单向流程（输入 → 处理 → 输出）
- 不需要循环和回头
- 主要做 RAG 或 prompt-only 应用
- LangGraph 节点**内部**也用 LCEL

详见 [`langchain/`](../langchain/) 主题。

## 4. AutoGen

[Microsoft AutoGen](https://github.com/microsoft/autogen)（v0.4+ 大重构）。

**核心抽象**：消息驱动的 Multi-Agent 系统。Agent 之间通过 `send` / `receive` 消息协作。

```python
from autogen_agentchat.agents import AssistantAgent
from autogen_agentchat.teams import RoundRobinGroupChat

researcher = AssistantAgent("researcher", model_client=llm, system_message="...")
writer = AssistantAgent("writer", ...)
team = RoundRobinGroupChat([researcher, writer])
result = await team.run(task="写一份关于 X 的报告")
```

**优势**：
- 多 Agent 一等公民（GroupChat、Round-robin、Selector）
- 异步消息总线，扩展性好
- 微软出品，积极维护
- v0.4 后架构清晰（Core / AgentChat / Extensions）

**劣势**：
- v0.x → v0.4 大改，老代码迁移成本
- 偏研究风格，工程细节不如 LangGraph 完善
- HITL / 持久化弱

**何时选**：
- 项目核心就是多 Agent 协作
- 微软 / Azure 技术栈
- 学术研究、需要灵活拓扑

## 5. CrewAI

[CrewAI](https://github.com/crewAIInc/crewAI) —— **"组建一个 Agent 团队"** 抽象。

```python
from crewai import Agent, Task, Crew

researcher = Agent(role="Senior Researcher", goal="...", backstory="...")
writer = Agent(role="Tech Writer", goal="...")

task1 = Task(description="调研 X", agent=researcher)
task2 = Task(description="基于调研写报告", agent=writer)

crew = Crew(agents=[researcher, writer], tasks=[task1, task2])
result = crew.kickoff()
```

**优势**：
- 抽象直观（Role / Goal / Backstory / Task）
- 上手快，PoC 神器
- 内置常用集成（搜索、文件、scrape）
- 文档和模板友好

**劣势**：
- 抽象固定，深度定制时反而碍事
- 复杂控制流不如 LangGraph
- 早期生产稳定性争议

**何时选**：
- 快速 PoC、demo
- 任务清晰的"团队协作"场景（写报告、做调研）
- 团队成员不是工程出身（Role 抽象易理解）

## 6. AgentScope

[AgentScope](https://github.com/modelscope/agentscope)（阿里达摩院）—— **工业级多 Agent + 中文场景**。

**特点**：
- 分布式 Agent（跨进程 / 跨机器）
- 内置 GUI 工作室（拖拽建 Agent）
- 阿里通义系生态绑定
- 中文文档完整

**何时选**：
- 阿里云 / 通义大模型为主
- 中文场景重度依赖
- 需要分布式部署多 Agent

不太适合：海外 / 标准开源生态优先项目。

## 7. Smolagents

[Hugging Face Smolagents](https://github.com/huggingface/smolagents) —— **极简 + Code Agent**。

**核心思路**：让 Agent 用**写 Python 代码**的方式调用工具，而非 JSON tool calling：

```python
from smolagents import CodeAgent, HfApiModel

agent = CodeAgent(tools=[search, calc], model=HfApiModel("..."))
result = agent.run("分析 X 公司过去 5 年的营收增长")
# Agent 输出：
# code:
#   data = search("X 公司年报")
#   growth = calc("5年增长率", data)
#   return growth
```

**优势**：
- 代码不到 1000 行，全可读
- Code Agent 范式（[Wang et al. 2024](https://arxiv.org/abs/2402.01030)）效果好
- 教学 / 研究友好
- 可直接接 HF 模型

**劣势**：
- 生态小、生产工具少
- HITL / 多 Agent 弱

**何时选**：
- 学习 Agent 内部机制
- 数据分析 / 计算密集型任务（Code 范式适合）
- HF 生态

## 8. OpenAI Agents SDK

[OpenAI Agents SDK](https://github.com/openai/openai-agents-python)（2025 春）—— OpenAI 官方 Agent 框架。

```python
from agents import Agent, Runner, function_tool

@function_tool
def get_weather(city: str) -> str: ...

agent = Agent(
    name="Assistant",
    instructions="...",
    tools=[get_weather],
)

result = Runner.run_sync(agent, "北京天气怎么样？")
```

**特点**：
- Handoff 内置（类似 Swarm）
- 与 OpenAI 平台深度集成（响应流、Assistants API）
- 极简 API
- 内置 trace 和 evaluator

**优势**：
- 上手最快
- OpenAI 自家优化（ Assistants v2 / Realtime API 都有）
- 类型完整（Pydantic）

**劣势**：
- OpenAI 锁定（用其他模型时优势消失）
- 多 Agent 复杂场景能力不如 AutoGen / LangGraph

**何时选**：
- 主用 OpenAI 模型
- 简单到中等复杂度 Agent
- 不想引入复杂框架

## 9. Claude Agent SDK

[Anthropic Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-python)（2025）—— Claude 主推方向。

**特点**：
- 与 Claude 模型深度集成（thinking、cache、artifacts）
- MCP 一等公民（直接接现成 MCP server）
- 内置 Skills 概念
- 偏向**编程类 Agent**（基于 Claude Code 经验）

```python
from claude_agent_sdk import Agent

agent = Agent(
    model="claude-sonnet-4-5",
    mcp_servers={"github": ..., "filesystem": ...},
    skills=["code-review.md", "release-prep.md"],
)
result = await agent.run("帮我审查 PR #123 并准备 release notes")
```

**何时选**：
- 主用 Claude
- 需要 MCP 生态深度集成
- 编程 / 文档 / 代码处理类 Agent

## 10. 横向对比矩阵

| 维度 | LangGraph | AutoGen | CrewAI | OpenAI Agents | Claude SDK | Smolagents |
|---|---|---|---|---|---|---|
| 学习曲线 | 中高 | 中 | 低 | 极低 | 低 | 极低 |
| 控制流灵活度 | ★★★★★ | ★★★★ | ★★★ | ★★★ | ★★★ | ★★ |
| 多 Agent | ★★★★ | ★★★★★ | ★★★★ | ★★★ | ★★ | ★ |
| 状态 / HITL | ★★★★★ | ★★ | ★★ | ★★★ | ★★★ | ★ |
| 生态 / 集成 | ★★★★★ | ★★★★ | ★★★★ | ★★★（OpenAI 限定） | ★★★（Claude） | ★★ |
| MCP 支持 | ★★★★ | ★★★ | ★★ | ★★ | ★★★★★ | ★ |
| 流式 / 异步 | ★★★★★ | ★★★★ | ★★★ | ★★★★ | ★★★★ | ★★ |
| 调试 / Trace | ★★★★★（LangSmith） | ★★★ | ★★★ | ★★★★ | ★★★★ | ★★ |
| 中文文档 | ★★★ | ★★ | ★★ | ★ | ★ | ★ |
| 生产稳定性 | ★★★★★ | ★★★★ | ★★★ | ★★★★ | ★★★ | ★★★ |

## 11. 选型决策树

```
你的需求是什么？
│
├── 简单 PoC、demo
│      ├── 用 OpenAI → OpenAI Agents SDK
│      ├── 用 Claude → Claude Agent SDK
│      └── 通用 → CrewAI
│
├── 长期演进的生产 Agent
│      ├── 复杂控制流 / HITL → LangGraph（首选）
│      ├── 多 Agent 协作主导 → AutoGen
│      └── 阿里云 / 通义 → AgentScope
│
├── 教学 / 研究
│      ├── 极简、看懂内部 → Smolagents
│      └── 多 Agent 论文复现 → AutoGen
│
└── 不是 Agent 而是 Workflow
       └── LangChain (LCEL) / 自家 Python
```

## 12. 多框架共存？

实战中常见：

```
- LangGraph 主框架（编排）
- LangChain 子模块（RAG、prompt 工具）
- 通过 MCP 集成第三方服务
- LangSmith 评测和 trace
```

或：

```
- OpenAI Agents SDK（外层）
- 内部某些环节调 LangChain RAG chain
```

**别让框架锁定你**——保持你的核心业务逻辑（prompt、tool 实现）框架无关，只让"编排"绑定到框架。这样换框架时改的是几百行编排代码，不是几千行业务代码。

## 13. 框架的"通用最小接口"

不管什么框架，Agent 需要的最小能力：

```python
class AgentInterface:
    def with_tools(self, tools: list) -> Self: ...
    def with_memory(self, memory) -> Self: ...
    def invoke(self, input) -> Output: ...
    def stream(self, input) -> Iterator[Chunk]: ...
    async def ainvoke(self, input) -> Output: ...
```

把你的业务逻辑围绕**这层抽象**写，下面是 LangGraph / AutoGen / 自家代码无所谓——这就是"框架无关"的实操。

## 14. 实战经验

### 14.1 框架选错的代价

不是大问题——典型 Agent 业务核心是 **prompt + tool 实现**，框架只是编排。换框架的成本一般是几百行代码，不是几千行。所以**别为选型纠结太久**——选个看起来合理的，干起来再说。

### 14.2 框架版本的稳定性

- LangGraph：API 已较稳，0.2 之后较少破坏性变更
- LangChain：0.1+ 较稳，老 0.0.x 教程别看
- AutoGen：v0.4 是大改写，v0.x 知识基本作废
- CrewAI：迭代快，生产升级要看 changelog
- OpenAI Agents SDK：2025 新发布，预计 1-2 年内会改
- Claude Agent SDK：2025 新发布，同上

**经验法则**：选**主版本稳定 6 个月以上**的框架做生产。

### 14.3 看仓库 health 信号

| 信号 | 怎么看 |
|---|---|
| 维护活跃 | 最近 30 天 commit / PR / issue 反应速度 |
| 社区规模 | star 数（粗）+ Discord/issues 提问质量（细） |
| 文档质量 | 有完整教程、API ref、迁移指南 |
| 生产案例 | 是否有公开生产用户 |
| 企业背书 | 公司主导（Anthropic / Microsoft / OpenAI 等）vs 个人 |

## 15. 反模式

| 反模式 | 后果 |
|---|---|
| 选框架花一个月、写代码两周 | 不如直接选个常用的开干 |
| 把业务逻辑深度耦合框架 | 换框架成本爆炸 |
| 用最新发布的 v0.0.1 框架做生产 | 踩坑爆炸 |
| 同时引入 3+ 框架 | 抽象冲突，调试困难 |
| 用 CrewAI 做复杂 HITL 流程 | 抽象不够；换 LangGraph |
| 用 LangGraph 做单步 chain | 杀鸡用牛刀；用 LCEL 即可 |

## 16. 学习路径

| 你是什么阶段 | 学哪个 |
|---|---|
| 完全新手 | OpenAI Agents SDK 或 CrewAI（先跑通） |
| 有一定经验 | LangChain（LCEL）→ LangGraph |
| 工业级落地 | LangGraph（深度）+ MCP（生态） |
| 多 Agent 研究 | AutoGen + 论文 |
| 内核控 | Smolagents 看源码 |

## 17. 下一步

- [10 · 生产部署](./10-production.md) — 选完框架的下一步
- [`langgraph/`](../langgraph/) — LangGraph 全主题
- [`langchain/`](../langchain/) — LangChain 全主题
- [07 · 通信协议](./07-protocols.md) — MCP / A2A 框架无关，可与任何上面的框架组合
