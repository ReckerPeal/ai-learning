# LangChain

LangChain 学习笔记。

> LangChain 是构建 LLM 应用的**组件库 + 编排框架**：把 LLM、Prompt、工具、向量库、文档加载器等抽象成统一接口（`Runnable`），通过 **LCEL** 组合成可运行的链。配合 LangGraph 处理复杂的有状态/循环逻辑。

## 章节索引

1. [01 · 概览与生态](./01-overview.md) — LangChain 是什么、与 LangGraph 关系、包结构
2. [02 · 快速上手](./02-quickstart.md) — 安装、第一次调用、模型适配
3. [03 · Prompt 与 ChatModel](./03-prompts-and-models.md) — 消息、PromptTemplate、Chat 模型差异
4. [04 · LCEL 与 Runnable](./04-lcel.md) — pipe 组合、并行、`RunnableLambda` / `RunnablePassthrough`
5. [05 · 结构化输出](./05-output-parsers.md) — `with_structured_output`、Pydantic、OutputParser
6. [06 · 工具与函数调用](./06-tools-and-function-calling.md) — `@tool`、`bind_tools`、并行 tool calls
7. [07 · RAG 全流程](./07-rag.md) — Loader / Splitter / Embedding / VectorStore / Retriever
8. [08 · 对话记忆](./08-memory-and-history.md) — `ChatMessageHistory`、`RunnableWithMessageHistory`、迁移到 LangGraph
9. [09 · Agent：从 AgentExecutor 到 LangGraph](./09-agents.md) — 经典 Agent、为何转向 LangGraph
10. [10 · 可观测与生产](./10-observability-and-production.md) — LangSmith、缓存、回调、流式、部署

## 与 LangGraph 的关系（速记）

| 关注点 | LangChain | LangGraph |
|---|---|---|
| 抽象层 | 组件 + LCEL（DAG，无环） | 状态机 / 有向图（可循环、并行、暂停） |
| 适合 | RAG、Prompt 工程、无状态链 | Agent、工作流、HITL、多 Agent |
| 状态 | LCEL 链是无状态的；记忆要外挂 | 一等公民的 `State` + `Checkpointer` |
| AgentExecutor | 已不推荐 | 用 `create_react_agent` 等替代 |

详见 [01 · 概览与生态](./01-overview.md) 第 5 节。

## 资源

- 官方文档：https://python.langchain.com/
- GitHub：https://github.com/langchain-ai/langchain
- LangSmith：https://smith.langchain.com/

## 资源目录

图片放在 [`assets/`](./assets/) 下：

```markdown
![LCEL 图示](./assets/lcel.png)
```
