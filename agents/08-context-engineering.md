# 08 · 上下文工程（Context Engineering）

> 对应 [hello-agents](https://github.com/datawhalechina/hello-agents) 第 9 章。
> "Context engineering" 这个词由 Anthropic / Tobi Lütke 在 2024 推广 —— **把 prompt 工程从"调一句话"扩展到"如何在有限上下文里塞最有用的信息"**。

## 1. 为什么 Context Engineering 是 Agent 的瓶颈

LLM 上下文窗口越来越大（200K → 1M），但**有效注意力**没线性增长：

- **Lost in the middle**：长上下文里，开头和结尾的信息被关注，中间被淡化
- **Token 成本线性增长**：100K token 调用比 10K 贵 10 倍
- **延迟也涨**：长 context 推理慢

Agent 的循环让问题加剧——每轮新增 messages、工具结果、记忆召回，**很快就到瓶颈**。Context Engineering 就是解这个。

> 名言（来自 Anthropic 工程团队）：
> *"Prompt Engineering is the past; Context Engineering is the future."*

## 2. Agent 的上下文结构

一次 LLM 调用看到的上下文，大致这样组成：

```
┌─── System Prompt (固定) ────────┐
│  Agent persona                   │
│  Tool descriptions               │
│  Output format                   │
│  Operational rules               │
└─────────────────────────────────┘
┌─── Static Context ──────────────┐
│  User profile / preferences     │
│  Skills / 当前任务说明          │
└─────────────────────────────────┘
┌─── Retrieved Context (动态) ────┐
│  RAG docs                        │
│  Recalled memories               │
│  Similar episodes                │
└─────────────────────────────────┘
┌─── Working Memory ──────────────┐
│  Conversation messages           │
│  Tool results                    │
│  Past steps                      │
└─────────────────────────────────┘
```

每一块都有"该塞多少"的问题。**Context Engineering 就是分配 token 预算**。

## 3. Token 预算分配

定个总预算（如 32K input），按比例分：

| 区域 | 推荐占比 | 说明 |
|---|---|---|
| System prompt | 5-10% | persona + 关键规则 |
| Tool descriptions | 5-15% | 工具数量决定，控制 ≤30 个 |
| Static context | 5-10% | 用户偏好等 |
| Retrieved context | 20-40% | RAG / memory 召回 |
| Working memory | 30-50% | 对话历史 + tool 结果 |
| **预留 output** | 10-20% | 不算入 input，但要在总长里留 |

固化成代码：

```python
BUDGETS = {
    "system": 4000,
    "tools": 6000,
    "static": 2000,
    "retrieved": 12000,
    "working": 16000,
}

def build_context(state):
    parts = []
    parts.append(trim(SYSTEM_PROMPT, BUDGETS["system"]))
    parts.append(trim(format_tools(tools), BUDGETS["tools"]))
    parts.append(trim(get_user_context(state), BUDGETS["static"]))
    parts.append(trim(retrieve_relevant(state), BUDGETS["retrieved"]))
    parts.append(trim_messages(state["messages"], BUDGETS["working"]))
    return parts
```

实际预算需要测——LLM 不同、任务不同最佳分配差很大。

## 4. Working Memory 压缩

短时记忆（messages）增长最快。三种压缩策略：

### 4.1 Trim：只留最近 N 条

```python
from langchain_core.messages import trim_messages

trimmed = trim_messages(
    messages,
    max_tokens=8000,
    strategy="last",
    token_counter=llm,
    include_system=True,
    start_on="human",
)
```

最简单，最常用。**适合 80% 场景**。

### 4.2 Summary：把老消息总结成一段

```python
def summarize_old(state):
    if len(state["messages"]) > 20:
        old = state["messages"][:-10]
        summary = llm.invoke(f"用 200 字总结：{old}")
        return {"messages": [SystemMessage(f"早期对话摘要：{summary.content}")] + state["messages"][-10:]}
```

适合：**长对话**（>30 轮），用户希望 Agent"记住"早期细节但又不能爆 token。

LangGraph 实现 [`SummarizationNode`](https://langchain-ai.github.io/langgraph/) 可直接用。

### 4.3 Hierarchical：分层摘要

```
Tier 1: 最近 5 轮（原文）
Tier 2: 5-15 轮（每轮 1 句摘要）
Tier 3: 15+ 轮（全段 1 段总结）
```

适合：**超长任务**（编程 Agent 跑几个小时）。Devin / Cursor 都用类似方案。

## 5. Tool Result 截断

工具返回大块内容时——文件、数据库查询、网页——**先截断再喂回**：

```python
@tool
def read_file(path: str, max_chars: int = 4000) -> str:
    """读取文件，超长截断。"""
    content = Path(path).read_text()
    if len(content) <= max_chars:
        return content
    return content[:max_chars] + f"\n\n[truncated, original {len(content)} chars. Use read_file_range for more]"

@tool
def read_file_range(path: str, start: int, end: int) -> str:
    """读取文件指定范围。"""
    return Path(path).read_text()[start:end]
```

让 Agent 自己决定"还要不要看更多"——比一次塞全部好。

更复杂场景：**结果存外部，返 ID + 摘要**：

```python
@tool
def search(query: str) -> str:
    results = vector_search(query)
    artifact_id = artifact_store.put(results)
    return json.dumps({
        "artifact_id": artifact_id,
        "count": len(results),
        "summary": llm.invoke(f"摘要这些结果：{results[:3]}"),
    })

@tool
def read_artifact(artifact_id: str, slice_: str | None = None) -> str:
    return artifact_store.get(artifact_id, slice_)
```

LangGraph 0.2+ 支持原生 `artifact` 概念。

## 6. 上下文召回：RAG / Memory

"检索增强"在 Agent 里有几种 query 来源：

| Query 来源 | 例 |
|---|---|
| 用户当前 query | RAG（标准 RAG） |
| 整段对话上下文 | Long-context retrieval |
| 当前任务描述 | Task-aware retrieval |
| 工具刚返回的内容 | Iterative retrieval |

不同 query 召回的东西不同。Agent 里**优先用"当前任务"+ "最近一轮"组合 query**——比单用最后一句话好得多：

```python
def make_retrieval_query(state):
    task = state.get("task", "")
    last_human = next((m for m in reversed(state["messages"]) if isinstance(m, HumanMessage)), None)
    return f"任务：{task}\n最近问题：{last_human.content if last_human else ''}"
```

## 7. 上下文"切片"

不是所有信息都该出现在每次 LLM 调用里——按需展示：

### 7.1 按节点裁剪

LangGraph 不同节点可以构造不同 context：

```python
def planner_node(state):
    # planner 不需要 tool 结果细节，只看任务和现有计划
    msgs = [SystemMessage(planner_prompt), HumanMessage(state["task"])]
    return {"plan": llm.invoke(msgs)}

def executor_node(state):
    # executor 需要工具列表 + 当前步骤
    msgs = [SystemMessage(executor_prompt + format_tools(tools)),
            HumanMessage(state["plan"][state["current_step"]])]
    return {"result": llm.invoke(msgs)}
```

不要让所有节点都看完整 messages——**给 LLM 的越少，它越专注**。

### 7.2 按工具子集裁剪

工具数量超过 15-20 时，先**用一个 router 选 toolkit，再传只属于该 toolkit 的工具**：

```python
def router(state):
    """决定用哪类工具。"""
    return llm.with_structured_output(Route).invoke(...)
    # → "data_tools" / "communication_tools" / "code_tools"

def executor(state):
    selected_tools = TOOLKITS[state["toolkit"]]
    return llm.bind_tools(selected_tools).invoke(state["messages"])
```

每次 LLM 调用看到 5-8 个工具，比看 30 个准得多。

## 8. Prompt Cache 优化

Anthropic 和 OpenAI 都支持 **prompt caching**——对**长且固定的前缀**，按缓存命中算钱（90% 折扣）。

要点：
- **System prompt + tool definitions** 几乎不变 → 永远命中缓存
- 把变化的部分（user message、retrieved docs）放最后

```python
# Anthropic 用法
messages = [
    SystemMessage(
        content=long_static_system,
        additional_kwargs={"cache_control": {"type": "ephemeral"}},
    ),
    *dynamic_messages,
]
```

Agent 多轮循环时省钱明显——每轮重发整段历史，cache 命中后**输入 token 成本降 90%**。

详见 [`langchain/10`](../langchain/10-observability-and-production.md)。

## 9. 中间消息的"信噪比"提升

Agent 上下文里最杂的是工具调用和 ToolMessage。提升信噪比：

### 9.1 失败的 tool call 简化

```python
def filter_messages(messages):
    result = []
    for m in messages:
        # 失败的工具调用 + 错误结果，只保留一行总结
        if isinstance(m, ToolMessage) and "Error:" in m.content:
            result.append(SystemMessage(f"[skipped failed tool call: {m.content[:100]}]"))
            continue
        result.append(m)
    return result
```

### 9.2 重复 tool call 合并

LLM 可能重复查同样的东西——保留最新一次结果：

```python
def dedupe_tool_calls(messages):
    seen = {}
    for m in messages:
        if isinstance(m, ToolMessage):
            key = (m.tool_call_id, m.name)
            seen[key] = m   # 后面覆盖前面
    return [m for m in messages if not isinstance(m, ToolMessage) or m in seen.values()]
```

### 9.3 分隔符提升注意力

不同来源的内容用清晰分隔符：

```
[USER QUESTION]
{question}

[RETRIEVED CONTEXT]
{docs}

[PAST ACTIONS]
{actions}

[INSTRUCTIONS]
基于上述信息回答……
```

LLM 的"指令跟随"能力对清晰结构敏感——比纯字符串拼接好。

## 10. 长上下文（>100K）的特殊问题

模型支持 200K-1M 上下文，但 Agent 真填到那么多反而出问题：

| 问题 | 解 |
|---|---|
| Lost in the middle | 关键信息放开头/结尾 |
| 注意力稀释 | 用 retrieval 而非"塞全部" |
| 延迟急剧上升（10s+） | 控制实际长度，别用满 |
| 成本（每次都全量） | prompt cache + 增量 |
| Debug 难 | 显式打日志：每次 LLM 调用看到了什么 |

工程经验：**Agent 实际上下文长度的甜蜜点是 8K-32K**——超过就考虑压缩 / 切片。

## 11. Anthropic 的 "Effective Context" 原则

[Building Effective Agents](https://www.anthropic.com/research/building-effective-agents) 总结：

1. **结构 > 长度**：清晰的分节比长篇大论效果好
2. **精简 > 完整**：删掉冗余比加细节有用
3. **关键信息显眼**：重要的东西**重复**或**加分隔符**
4. **指令在最后**：长上下文里把"该做什么"放结尾，模型更容易跟随
5. **Few-shot 用最少**：3 个高质量示例 > 10 个一般的

## 12. 实战：构造一个 Agent 的"完美上下文"

```python
def build_agent_messages(state, user_id):
    # 1. System: persona + 关键规则（cache）
    system = SystemMessage(
        content=PERSONA + OPERATING_RULES,
        additional_kwargs={"cache_control": {"type": "ephemeral"}},
    )

    # 2. Tools: 按当前 toolkit 选择子集
    tools = TOOLKITS.get(state["current_toolkit"], DEFAULT_TOOLKIT)

    # 3. Static context: 用户信息（cache）
    user_ctx = SystemMessage(
        content=f"User: {get_user_summary(user_id)}",
        additional_kwargs={"cache_control": {"type": "ephemeral"}},
    )

    # 4. Retrieved: 任务相关的记忆 / RAG（动态）
    retrieved = retrieve(state["task"], user_id, k=5)
    retrieved_msg = SystemMessage(
        f"Relevant context:\n" + format_docs(retrieved)
    )

    # 5. Working memory: 压缩过的对话
    working = compress_messages(state["messages"], max_tokens=8000)

    # 6. Final instruction（永远在最后）
    instruction = SystemMessage("基于上述信息和工具，逐步完成任务。")

    return [system, user_ctx, retrieved_msg, *working, instruction]
```

每次 LLM 调用前跑这一遍——不要让上下文"自然增长"，主动塑造它。

## 13. 监控指标

线上监控这几个指标：

| 指标 | 阈值参考 |
|---|---|
| Avg input tokens / call | < 16K（多数任务） |
| p95 input tokens / call | < 64K |
| Cache hit rate | > 60% |
| Truncation rate（消息被裁剪的比例） | < 30% |
| Long-context calls (>100K) | 偶发，不能成为常态 |

任何指标飙升 → 排查 Agent 上下文设计。

## 14. 反模式

| 反模式 | 后果 |
|---|---|
| "塞越多越好" | 注意力稀释 + 慢 + 贵 |
| 不限制 messages 增长 | 几轮就爆 |
| Tool 结果不截断 | 一个 read_file 顶半个上下文 |
| System prompt 每次都变 | Cache 失效，成本翻倍 |
| 关键指令在 system prompt 开头 | 长上下文里被淡化 |
| 多个 SystemMessage 散落 | LLM 困惑；合并 |
| Few-shot 用 8+ 个例子 | 注意力被稀释；3 个精选更好 |
| 用 1M context 装不该装的 | 该用 RAG 的硬塞；该 trim 的不 trim |

## 15. 下一步

- [03 · 认知架构](./03-cognitive-architecture.md) — 上下文塞什么的源头
- [`langchain/10`](../langchain/10-observability-and-production.md) — Prompt cache、监控
- [`rag-advanced/04 §Reranking`](../rag-advanced/04-hybrid-retrieval.md) — Retrieved context 的精炼
- [Anthropic: Building Effective Agents](https://www.anthropic.com/research/building-effective-agents) — 工程视角必读
