# 03 · 认知架构（Memory / Skills / 持续学习）

> 对应 [hello-agents](https://github.com/datawhalechina/hello-agents) 第 8 章。
> 框架级实现见 [`langgraph/06 · 持久化`](../langgraph/06-persistence.md)；本章关注**"应该有哪些记忆 / 怎么组织"**。

## 1. 为什么 Agent 需要"认知架构"

LLM 本身**无状态**——每次调用是独立的。把它变成 Agent，要解决：

- 记住**这次任务的进度**（短时）
- 记住**用户偏好 / 历史**（长时）
- 记住**自己学过的技能**（程序性记忆）
- 记住**做过的具体事件**（情景记忆）

不分层的话，所有东西都塞 system prompt → 几轮就爆。**认知架构**就是把这些不同性质的记忆合理组织。

## 2. 认知科学背景：人类记忆的分层

工程上常借鉴人类记忆的经典分层（Tulving 1972 / Squire 1992）：

```
                    ┌─── 短时记忆（Working Memory） ───┐
                    │  当前对话上下文、临时变量          │
                    └────────────────────────────────┘
                                  │
                                  ▼ 巩固
                    ┌─── 长时记忆 ───────────────────┐
                    │                                  │
   ┌──── 陈述性 ────┴──── 程序性 ────┐                │
   │                                  │                │
   ├── 情景记忆        语义记忆       技能              │
   │  （事件，"我       （事实，"巴黎   （Skills，"怎么    │
   │   去过巴黎"）      是首都"）      预订机票"）        │
   └────────────────────────────────────────────────┘
```

Agent 工程上对应：

| 类型 | 对应实现 | 例子 |
|---|---|---|
| 工作记忆 | 当前 messages / state | LangGraph state 里的 `messages` |
| 语义记忆 | 向量库 + 检索 | RAG 文档库、用户偏好向量 |
| 情景记忆 | 时间序列日志 + 检索 | "用户上次咨询了 X" |
| 程序性 / 技能 | 工具集 + Skill 文件 | Claude Skills、可调用的 Python 函数 |

## 3. 短时记忆：当前任务的状态

对应 LangGraph 的 `State`。设计要点：

```python
class AgentState(TypedDict):
    # 必有
    messages: Annotated[list[BaseMessage], add_messages]
    # 任务级
    task: str
    plan: list[str]
    past_steps: Annotated[list[tuple], add]
    # 元数据
    user_id: str
    thread_id: str
    # 当前轮临时数据（不写回长时）
    current_search_results: list
```

参考 [`langgraph/03 · State`](../langgraph/03-state-and-reducers.md) 完整设计原则。

短时记忆的关键问题：**多长才合适？**

- 太短：忘掉早期目标
- 太长：token 飙升、注意力被稀释（"middle context lost"）

解决方案见 §04 的"上下文压缩"和 [§08 · 上下文工程](./08-context-engineering.md)。

## 4. 长时记忆：跨会话持久化

短时记忆按 thread 隔离；长时记忆**跨 thread / 跨用户**。三类落地：

### 4.1 用 KV 存储（最简单）

```python
# 用户偏好 / 设置
store.put(("users", user_id), "preferences", {"theme": "dark", "lang": "zh"})
store.get(("users", user_id), "preferences")
```

适合：结构化、字段清晰的数据。LangGraph 的 [Store API](../langgraph/06-persistence.md#6-跨线程共享store-api) 即此模式。

### 4.2 用向量库（语义检索）

```python
# 用户在过往对话中表达过的偏好、事实
vectorstore.add_texts(
    texts=["用户讨厌香菜", "用户家里有两只猫"],
    metadatas=[{"user_id": "u1", "ts": ...}, ...],
)

# 每轮对话开始前
relevant = vectorstore.similarity_search(query, filter={"user_id": "u1"}, k=5)
```

适合：模糊、半结构化"事实"。详见 [`rag-advanced/`](../rag-advanced/)。

### 4.3 用专门的 Memory 服务

| 服务 | 特点 |
|---|---|
| **mem0** | 自动从对话中抽取事实、合并、去重 |
| **Zep** | 时间感知 + 知识图谱 |
| **Letta（旧名 MemGPT）** | OS 风格，memory 分主上下文 / 外部存储 |
| 自家方案 | 结合上面三种 |

工程权衡：**先用 KV + 向量库自建**，规模上来再考虑专门服务——专门服务通常贵、贴合度差。

## 5. 情景记忆：让 Agent 记住"做过什么"

每次完整任务（trace）存档，下次相似任务时检索：

```python
# 任务结束后
episodic_store.add({
    "task": state["task"],
    "trajectory": state["past_steps"],
    "outcome": "success",
    "key_lessons": llm.summarize(state["past_steps"]),
    "ts": now,
    "user_id": user_id,
})

# 新任务开始
similar_episodes = episodic_store.search(new_task, k=3)
context = "你之前处理过类似任务：\n" + format(similar_episodes)
```

价值：
- 用户问"上次我们怎么解决的 X" → 直接拉历史轨迹
- Agent 自己迭代：从过往任务里挖经验

注意：
- **裁剪 trajectory**——完整轨迹很长，保留关键决策点
- **加 TTL**——3 个月前的 trace 通常没价值
- **隐私**：trace 里可能有 PII，落库前过滤

## 6. 程序性记忆：Skills

Skills = **可被 Agent 学习并调用的"程序"**。介于"工具"和"提示"之间。

### 6.1 三种实现思路

| 形式 | 描述 | 例子 |
|---|---|---|
| **代码 Skill** | Python 函数被 Agent 当工具调用 | `@tool` 装饰的函数 |
| **Prompt Skill** | 一段 markdown 描述 + 示例 | Claude Skills（YAML frontmatter + 内容） |
| **流程 Skill** | LangGraph 子图 | 子图作为可调用单元 |

### 6.2 Claude Skills 范式

把 skill 写成 `SKILL.md`：

```markdown
---
name: book-flight
description: 预订机票工作流
---

# Book Flight Skill

## When to use
用户表达"想订机票"、"buy ticket" 等。

## Steps
1. 询问出发地、目的地、日期
2. 调 search_flights 工具
3. 展示候选给用户确认
4. 调 confirm_booking 工具
```

Agent 在 system prompt 中"知道有这些 skill 可用"，触发时按描述执行。**比硬编码工作流灵活，比从零让 LLM 想步骤稳**。

### 6.3 何时用 Skill vs 直接 Tool

| 场景 | 用什么 |
|---|---|
| 单步、参数清晰 | Tool |
| 多步、有顺序、可能要交互 | Skill |
| 多变、需要 Agent 自己设计步骤 | 不要 skill，让 ReAct 自己玩 |

## 7. 记忆的"读"与"写"

设计认知架构时，分清两个时机：

### 7.1 读（Recall）

每轮对话开始前，需要把哪些记忆**召回**到当前上下文？

```python
def assemble_context(state, user_id):
    short_term = state["messages"]   # 自动有

    # 长时召回
    user_facts = vectorstore.search(state["task"], filter={"user_id": user_id}, k=5)
    similar_episodes = episodic_store.search(state["task"], k=3)
    user_prefs = store.get(("users", user_id), "preferences")

    # 拼到 system prompt
    return [SystemMessage(f"""
用户偏好：{user_prefs}
相关事实：{user_facts}
类似的过往任务：{similar_episodes}
"""), *short_term]
```

### 7.2 写（Encode）

什么时机把当前对话**沉淀**到长时？

| 时机 | 写什么 |
|---|---|
| 用户表达事实/偏好时 | 提取出来写入语义记忆 |
| 任务结束时 | trace 写入情景记忆 |
| 工具失败 / 用户更正时 | 写入"避坑"经验（Reflexion 模式） |
| 周期性 | 把短时对话压缩成 summary，写入语义记忆 |

写时机的选择对成本影响大——每轮都写就贵了。

## 8. 一个完整的认知架构示例

参考 MemGPT / Letta 的设计：

```
┌──────── Main Context（送给 LLM）─────────────┐
│  System prompt                                │
│  Persona（Agent 自我定义）                   │
│  Recall（动态召回的记忆）                    │
│    - User facts（语义）                      │
│    - Recent episodes（情景）                 │
│    - Skills available                        │
│  Working memory（当前对话）                  │
└───────────────────────────────────────────────┘
                    ▲ ▼
┌──────── External Memory（可读写）────────────┐
│  Vector store: 语义事实、文档                │
│  Episodic store: 任务轨迹                    │
│  KV store: 偏好、设置                        │
│  Skills DB: 技能定义                         │
└───────────────────────────────────────────────┘
                    ▲
┌──────── Memory Manager（一组工具）────────────┐
│  - recall(query) → 检索                      │
│  - remember(fact) → 写入                     │
│  - forget(id) → 删除                         │
│  - summarize(thread_id) → 压缩历史           │
└───────────────────────────────────────────────┘
```

注意：**Memory Manager 本身是工具**——给 Agent 的工具集里加 `recall` / `remember`，让 LLM 自己决定何时召回 / 沉淀。**比固定流程灵活**。

## 9. 持续学习：让 Agent 长期变好

不调模型权重，靠记忆体系实现"经验积累"：

| 信号 | 怎么用 |
|---|---|
| 用户 👍 | 把整段对话存成"成功 episode" |
| 用户 👎 + 反馈 | 抽取"该避免的模式"存 lesson DB |
| 工具失败 | 记录失败模式 + 修复方案 |
| 用户更正答案 | 把"原答 → 正答"作为对照样本存 |

每条新经验加一条 lesson，时间一长形成"该 Agent 独有的护城河"——竞品同样的模型 + 框架，没你的 lesson DB。

参考 [eval/02 §6 Failure Set](../eval/02-datasets.md#6-failure-set失败案例沉淀) 与 [10 · 进阶 EDD](../eval/10-advanced.md#3-eval-driven-developmentedd)——评测里的 failure set 和这里的 lesson DB 是同一回事的两个视角。

## 10. 反模式

| 反模式 | 后果 | 正解 |
|---|---|---|
| 全塞 system prompt | 上下文爆 / 无关信息干扰 | 分层 + 召回 |
| 长时记忆 = 全部历史聊天 | 无法用、检索差 | 抽取事实 + 摘要 |
| 不限 episode TTL | 库越来越大、检索变慢 | 过期/低相关度的归档 |
| Memory Manager 完全自动 | LLM 滥写 / 漏写 | 让 LLM 通过工具显式调用 |
| 召回时不过滤 user_id | 串账户、隐私事故 | 召回必带 user_id 过滤 |
| 每轮都重新检索全部 | 慢 + 贵 | 缓存最近召回 / 分级触发 |
| 把长时记忆当 source of truth | 可能漂移、过期 | 与外部权威系统（DB / API）对齐 |

## 11. 实战 checklist：上生产前

- [ ] 短时记忆有上限（trim_messages 或自定义压缩）
- [ ] 长时记忆按 user_id 隔离，绝不串
- [ ] 写记忆经过审核（不写 PII / 不写敏感）
- [ ] 召回有相关度阈值，避免拉无关内容
- [ ] 有"清空记忆"的接口（GDPR 合规）
- [ ] Memory 存储可监控（增长率、查询延迟、命中率）
- [ ] 定期人工抽查记忆质量

## 12. 下一步

- [04 · 工具使用](./04-tool-use.md) — Memory Manager 也是一组工具
- [08 · 上下文工程](./08-context-engineering.md) — 短时记忆的精细管理
- [`rag-advanced/`](../rag-advanced/) — 语义记忆的实现细节
- [`langgraph/06`](../langgraph/06-persistence.md) — Checkpoint + Store API
