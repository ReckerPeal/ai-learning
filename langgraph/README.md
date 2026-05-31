# LangGraph

LangGraph 学习笔记。

> LangGraph 是 LangChain 生态下用于构建**有状态、多步骤、可循环的 LLM 应用**的框架，以图（Graph）的方式编排节点（Node）与边（Edge），适合 Agent、工作流、人机协作等场景。

## 章节索引

1. [01 · 概览与核心概念](./01-overview.md) — State / Node / Edge / Graph
2. [02 · 快速上手](./02-quickstart.md) — 最小可运行示例 + ReAct Agent
3. [03 · 状态与 Reducer](./03-state-and-reducers.md) — state 设计、reducer、`add_messages`
4. [04 · 控制流](./04-control-flow.md) — 条件边、循环、并行、`Send` 动态分发
5. [05 · 工具与 Agent](./05-tools-and-agents.md) — 工具、`ToolNode`、ReAct、prebuilt
6. [06 · 持久化与 Checkpoint](./06-persistence.md) — 多轮记忆、时间旅行、Store
7. [07 · 人机协作](./07-human-in-the-loop.md) — `interrupt` / `Command(resume)` / 审批流
8. [08 · 流式输出](./08-streaming.md) — `stream_mode` 全集 + SSE 协议
9. [09 · 子图与多 Agent](./09-subgraphs.md) — Subgraph、Supervisor、Swarm、Hierarchical
10. [10 · 部署](./10-deployment.md) — FastAPI / LangGraph Server / Platform / 上线 checklist
11. [11 · 实战练习：从工作流到多 Agent 系统](./11-practical-scenarios.md) — 5 个由浅到深的实战案例 + 全套测试练习

## 资源

- 官方文档：https://langchain-ai.github.io/langgraph/
- GitHub：https://github.com/langchain-ai/langgraph

## 资源目录

图片、示意图等放在 [`assets/`](./assets/) 下，章节中以相对路径引用：

```markdown
![架构图](./assets/architecture.png)
```
