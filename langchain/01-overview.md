# 01 · 概览与生态

## 1. LangChain 是什么

**LangChain** 是构建 LLM 应用的**组件库 + 编排框架**。它做两件事：

1. **抽象**：把 LLM、Prompt、工具、向量库、文档加载器等，统一成一组可互换的接口（核心是 `Runnable`）
2. **组合**：用 **LCEL（LangChain Expression Language）** 把这些组件像 Unix 管道一样串起来，形成可运行、可流式、可并行、可异步的链

> 一句话：**LangChain ≈ "LLM 应用的标准件 + 装配语言"**。

## 2. 它解决什么问题

不用 LangChain 也能写 LLM 应用——直接调 `openai.ChatCompletion.create(...)` 就够了。但当你要做：

- 同一份代码切换 OpenAI / Anthropic / 通义 / 本地模型
- Prompt 模板化 + 复用
- 把 LLM 输出解析成结构化对象
- 串起 "检索 → Prompt → LLM → 解析 → 工具调用" 这种多步流程
- 流式 / 异步 / 并行 / 重试 / 缓存
- 接入 LangSmith 观测每一步

——自己拼会很啰嗦。LangChain 把这些拉平成统一的 `Runnable` 接口和 LCEL 组合规则。

## 3. 包结构（重要）

LangChain ≥ 0.1 起被拆成了多个包，**用什么装什么**：

| 包 | 装什么 | 何时装 |
|---|---|---|
| `langchain-core` | `Runnable`、消息类型、Prompt、基础抽象 | 永远需要（其他包会自动带） |
| `langchain` | 高层封装、链、Agent、Retriever 模板 | 需要常用模板时 |
| `langchain-community` | 大量第三方集成（向量库、Loader 等） | 用社区集成时 |
| `langchain-openai` / `langchain-anthropic` / `langchain-ollama` ... | 各家厂商的 LLM / Embedding 适配 | 用对应模型时 |
| `langchain-text-splitters` | 文本切分 | RAG 场景 |
| `langgraph` | 有状态图编排（独立项目） | Agent / 工作流 |
| `langsmith` | 观测与评测 SDK | 接入 LangSmith |

最小安装：

```bash
pip install -U langchain langchain-openai
```

> **避坑**：网上很多老教程 `from langchain.chat_models import ChatOpenAI`——这是 0.0.x 时代的写法。现在用 `from langchain_openai import ChatOpenAI`。

## 4. 核心抽象：Runnable

LangChain 里几乎所有东西都是 `Runnable`：LLM、Prompt、Parser、Retriever、自定义函数、整条链……它们都实现了同一组方法：

```python
runnable.invoke(input)        # 同步单次
runnable.batch([i1, i2, ...]) # 批量
runnable.stream(input)        # 流式（迭代 chunk）
await runnable.ainvoke(input) # 异步
await runnable.abatch(...)
async for c in runnable.astream(input):
    ...
```

并且支持用 `|` 组合（这就是 LCEL）：

```python
chain = prompt | llm | parser
chain.invoke({"topic": "猫"})
```

`Runnable` 是这个生态的"USB 接口"——只要实现它，就能插进任何链。详见 [04 · LCEL](./04-lcel.md)。

## 5. LangChain vs LangGraph

两者**互补**而非取代。心智模型：

```
            LangChain  ─────►  LangGraph
            (无状态链)         (有状态图)
            DAG/管道           可循环 + 状态机
            "怎么把组件接起来"   "怎么编排长流程"
```

| 维度 | LangChain | LangGraph |
|---|---|---|
| 编排单位 | `Runnable`（链/管道） | `Node` + `Edge` + `State` |
| 控制流 | 顺序、分支（条件 Runnable）、并行 | 任意图：循环、分支、并行、`Send` |
| 状态 | LCEL 链本身**无状态**；记忆靠外部 | 一等公民的 `State` + `Checkpointer` |
| 适合的事 | RAG、Prompt 工程、无状态推理链 | Agent、工作流、HITL、多 Agent |
| 流式 | 流 token / 流 chunk | 流 token / 节点更新 / 状态变化 / 自定义 |
| 观测 | LangSmith | LangSmith（共享） |

**实际项目中通常一起用**：节点内部跑的是 LCEL 链，节点之间用 LangGraph 编排。

> 老的 `AgentExecutor` 现在已不推荐——官方迁移方向是 LangGraph 的 `create_react_agent`。详见 [09 · Agents](./09-agents.md)。

## 6. 学习路径建议

如果你的目标是：

| 目标 | 重点章节 |
|---|---|
| 先跑通一个 LLM 应用 | 02 → 03 → 04 |
| 做 RAG | 02 → 03 → 04 → 05 → 07 |
| 做 Agent | 02 → 03 → 04 → 06 → 09 → 切到 LangGraph 学习仓 |
| 上生产 | 全部 + 重点 10 |

## 7. 一个心智图

```
   ┌──────────────────── LangChain ────────────────────┐
   │                                                   │
   │  ┌────────┐   ┌─────┐   ┌──────────┐  ┌────────┐  │
   │  │ Prompt │ ► │ LLM │ ► │ Parser   │ ►│ Tool   │  │
   │  └────────┘   └─────┘   └──────────┘  └────────┘  │
   │       │           │            │           │       │
   │       └─── LCEL "|" 组合（同一个 Runnable 接口） ──┘
   │                                                   │
   │  Loader → Splitter → Embedding → VectorStore →    │
   │                                  Retriever        │
   └───────────────────────────────────────────────────┘
                        │
                        ▼ 复杂编排时
                   ┌──────────┐
                   │ LangGraph│  ← 节点里跑 LCEL
                   └──────────┘
```

## 8. 下一步

- [02-quickstart.md](./02-quickstart.md)：装好环境，跑通第一个链
- [04-lcel.md](./04-lcel.md)：理解 LCEL 是怎么把组件拼起来的
