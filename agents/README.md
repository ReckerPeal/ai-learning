# Agents · 智能体系统

> **本主题关注"Agent 设计原则、范式、模式"——与具体框架解耦。**
> 框架级实战（LangGraph）见 [`langgraph/`](../langgraph/)；记忆 / 检索见 [`rag-advanced/`](../rag-advanced/)；评测见 [`eval/`](../eval/)。本主题填补的是**横跨框架的 Agent 工程心智**。

> 主要参考资料：[datawhalechina/hello-agents](https://github.com/datawhalechina/hello-agents)（Datawhale 16 章中文 Agent 教程）。本主题与之**互补而非平行**——hello-agents 强教程实战，本主题强**抽象与对比**。

## 章节索引

1. [01 · Agent 是什么](./01-overview.md) — 定义、演化（符号 → ReAct → Agentic）、与 LLM 工程的边界
2. [02 · 经典范式](./02-paradigms.md) — ReAct / Plan-and-Solve / Reflection / Reflexion / Tree of Thoughts
3. [03 · 认知架构](./03-cognitive-architecture.md) — Memory 体系（短时/长时/工作/情景）、Skills、持续学习
4. [04 · 工具使用](./04-tool-use.md) — 工具设计、错误恢复、并发、HITL、安全
5. [05 · 规划](./05-planning.md) — 任务分解、Plan-Execute、重规划、HTN、Tree Search
6. [06 · 多 Agent 系统](./06-multi-agent.md) — Supervisor / Swarm / Hierarchical / Network 拓扑
7. [07 · 通信协议](./07-protocols.md) — MCP / A2A / ANP / OpenAI Agents protocol
8. [08 · 上下文工程](./08-context-engineering.md) — 窗口管理、压缩、分层记忆、token 预算
9. [09 · 框架对比](./09-frameworks.md) — LangGraph / AutoGen / CrewAI / AgentScope / Smolagents / OpenAI Agents SDK / Claude Agent SDK
10. [10 · 生产部署与高级话题](./10-production.md) — 安全、成本、Agentic RL 简介、真实案例剖析

## 与其他主题的关系

| 想了解 | 看哪 |
|---|---|
| Agent 是什么、有哪些范式 | 本主题 |
| 用 LangGraph 写一个 Agent | [`langgraph/`](../langgraph/) |
| Agent 的记忆怎么落地 | 本主题 §3 + [`rag-advanced/`](../rag-advanced/) |
| Agent 怎么评测 | 本主题 §10 + [`eval/07`](../eval/07-agent-eval.md) |
| Agent 框架选型 | 本主题 §9 |
| MCP / A2A 协议细节 | 本主题 §7 |

## 学习路径

```
快速入门：     01 → 02 → 04（基本能跑一个 Agent）
做产品的：     01 → 02 → 03 → 05 → 09 → 10
做研究的：     01 → 02 → 03 → 06 → 10（Agentic RL）
做平台的：     07（协议）→ 09（框架）→ 10（生产）
对比 hello-agents 自学：本主题章末"对应 hello-agents X 章"标记
```

## 资源

- [hello-agents](https://github.com/datawhalechina/hello-agents) — Datawhale 16 章 Agent 教程
- [LangChain 官方 Agents 指南](https://python.langchain.com/docs/concepts/agents)
- [Anthropic: Building effective agents (2024-12)](https://www.anthropic.com/research/building-effective-agents) — 工程视角必读
- [Lilian Weng: LLM Powered Autonomous Agents (2023-06)](https://lilianweng.github.io/posts/2023-06-23-agent/) — 经典综述
- [OpenAI: A Practical Guide to Building Agents (2024)](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)
- 学术综述：[A Survey on Large Language Model based Autonomous Agents (2023)](https://arxiv.org/abs/2308.11432)

## 资源目录

图片放在 [`assets/`](./assets/) 下。
