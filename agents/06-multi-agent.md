# 06 · 多 Agent 系统

> 单 Agent 解决不了的复杂任务，能用多 Agent 解决——但代价是**调试难度 3-10 倍**、**通信开销翻倍**、**共识难**。
> 与 [`langgraph/09 · 子图与多 Agent`](../langgraph/09-subgraphs.md) 互补，本章关注**拓扑选型与设计原则**。

## 1. 什么时候上多 Agent

判断信号：

| 信号 | 说明 |
|---|---|
| 单 Agent 工具数 > 30 | LLM 选不准了 |
| 任务有多个独立专长领域 | 法律 + 财务 + 技术，每个需要不同知识 |
| 不同子任务用不同模型最划算 | 路由用 mini，主推理用 Opus |
| 需要"对抗 / 协商"机制 | Generator vs Critic |
| 任务能并行（map-reduce 风格） | 同时调研 N 个候选 |

**警钟**：如果上面都不成立，**不要**上多 Agent。Anthropic 的 [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents) 反复强调：先用单 Agent + 工具组，能做到就别加 Agent。

## 2. 多 Agent 拓扑速查

```
1. Network          — Agent 之间随意通信，最自由
2. Supervisor       — 中央调度，最常见
3. Hierarchical     — 多层 Supervisor
4. Swarm            — Agent 互相 handoff，无中央
5. Pipeline         — 流水线，Agent 串行
```

| 拓扑 | 控制流 | 适合 | 代表 |
|---|---|---|---|
| Network | 全互通 | 探索式、研究类 | AutoGen GroupChat |
| Supervisor | 1 → N | 任务分派明确 | LangGraph Supervisor、CrewAI |
| Hierarchical | N 层树 | 大型组织模拟 | MetaGPT |
| Swarm | 互相 handoff | 客服多技能切换 | OpenAI Swarm、langgraph-swarm |
| Pipeline | 顺序 | 流程固定 | 普通 chain |

## 3. Supervisor 模式（最常见）

中央调度员决定下一步交给哪个 worker：

```
                ┌──► researcher ──┐
user → supervisor──► writer     ──┼──► supervisor ──► END
                └──► reviewer   ──┘
```

```python
from typing import Literal
from pydantic import BaseModel

class Route(BaseModel):
    next: Literal["researcher", "writer", "reviewer", "FINISH"]
    rationale: str

def supervisor(state):
    decision = llm.with_structured_output(Route).invoke([
        SystemMessage("你是调度员。看完已有进展，决定下一步该谁工作。完成时说 FINISH。"),
        *state["messages"],
    ])
    return {"next": decision.next}

def researcher(state):
    out = research_agent.invoke({"messages": state["messages"]})
    return {"messages": [out["messages"][-1]]}

# 类似定义 writer / reviewer

graph.add_edge(START, "supervisor")
graph.add_conditional_edges("supervisor",
    lambda s: END if s["next"] == "FINISH" else s["next"],
    {"researcher": "researcher", "writer": "writer", "reviewer": "reviewer", END: END},
)
for w in ["researcher", "writer", "reviewer"]:
    graph.add_edge(w, "supervisor")
```

完整例子见 [`langgraph/09 §4`](../langgraph/09-subgraphs.md#4-完整示例监督者模式)。

### 3.1 Supervisor 的设计要点

- **Worker 数量** 3-7：太少没必要、太多 supervisor 选不准
- **每个 worker 给清晰职责**：写在 supervisor 的 prompt 里——"researcher 负责……，writer 负责……"
- **Worker 输出回 supervisor 时摘要**：别把整段 worker 内部对话扔回主 state

```python
def wrap_worker(agent):
    def node(state):
        out = agent.invoke({"messages": state["messages"]})
        # 摘要 worker 的输出
        summary = llm.invoke(f"摘要这次工作的产出：{out['messages'][-3:]}")
        return {"messages": [AIMessage(content=f"[{agent.name}] {summary.content}")]}
    return node
```

### 3.2 Supervisor 的死循环陷阱

最常见 bug：supervisor 反复选同一个 worker，后者每次输出"我已经做过了"。原因：

- Worker 输出没显式标记"完成度" → supervisor 不知道进展
- 主 messages 没积累 worker 产物的"摘要"
- supervisor prompt 没强制"必须前进"

修法：

```python
# 在 state 里维护"已完成 worker"集合
class State(TypedDict):
    messages: ...
    completed: Annotated[set, lambda a, b: a | b]

# Supervisor prompt 加：
# "已完成的 worker：{completed}。除非必须，不要选已完成的。"
```

## 4. Swarm 模式

Agent 之间互相 **handoff**，没有中央调度：

```
user → agent_A ──handoff──► agent_B ──handoff──► agent_A → END
```

每个 Agent 有个 `handoff` 工具，调用后控制权转给目标 Agent。

```python
@tool
def handoff_to_billing(reason: str) -> str:
    """把对话转交给 billing Agent，附原因。"""
    return f"HANDOFF:billing:{reason}"

# router 检测到 HANDOFF:* 就切换 active agent
```

OpenAI 在 2024 开源了 [Swarm](https://github.com/openai/swarm)（实验性），LangGraph 有 [`langgraph-swarm`](https://github.com/langchain-ai/langgraph-swarm-py) 包。

### 4.1 Swarm vs Supervisor

| 维度 | Supervisor | Swarm |
|---|---|---|
| 控制位置 | 中央 | 分散（Agent 自己决定） |
| 调试 | 容易（一个 supervisor） | 难（每个 Agent 都能改路径） |
| 灵活度 | 受 supervisor prompt 限制 | 高 |
| 适合 | 任务清晰、流程稳定 | 客服多技能、动态切换 |

**默认推荐 Supervisor**——除非有强烈理由用 Swarm。

## 5. Hierarchical（层次化）

Supervisor 下面再有 Supervisor：

```
top_supervisor
   ├── research_team_supervisor
   │     ├── web_searcher
   │     └── doc_searcher
   └── writing_team_supervisor
         ├── outliner
         └── writer
```

每个 team 是一个**子图**（[`langgraph/09 §1`](../langgraph/09-subgraphs.md)）。team 内部有自己的 state schema 和工作流。

适合：
- 大任务能自然分解成"团队"（research / writing / review）
- 每个 team 内部还要协同 2-4 个 Agent

代表：MetaGPT 的"软件公司"模拟（PM → Architect → Engineer → QA），就是 Hierarchical。

## 6. Network（全互通）

每个 Agent 都能调用其他任何 Agent：

```
agent_A ◄──► agent_B
  ▲           ▲
  │           │
  ▼           ▼
agent_C ◄──► agent_D
```

实现：把每个其他 Agent 当工具暴露：

```python
@tool
def consult_agent_b(question: str) -> str:
    """咨询 Agent B 关于 X 领域的问题。"""
    return agent_b.invoke({"input": question})
```

代表：AutoGen 的 GroupChat。

适合：探索式任务、不确定哪个角色提出问题更合适。
不适合：调试地狱——任意 Agent 都能调出新对话，trace 复杂。

## 7. 通信机制

多 Agent 之间怎么传信息？三种主流：

### 7.1 共享 State（LangGraph 风格）

所有 Agent 读写同一个 state：

```python
class SharedState(TypedDict):
    messages: Annotated[list, add_messages]
    research_results: Annotated[list, add]
    draft: str
```

**优点**：实现最简单；调试时整个进展一目了然。
**缺点**：耦合强，state schema 要兼顾所有 Agent。

### 7.2 消息总线（AutoGen 风格）

每个 Agent 维护自己的 mailbox，按 topic 订阅：

```python
agent_a.send(to=agent_b, message="请帮我做 X")
# agent_b 异步收到、处理、回复
```

**优点**：松耦合；可扩展。
**缺点**：异步、有序性问题、调试复杂。

### 7.3 Handoff（Swarm 风格）

控制权转移即"通信"，没有显式消息：

```python
# agent_a 决定 → 调 handoff_to_b → 主控权切到 agent_b
# agent_b 看到的 context 包含 agent_a 留下的所有信息
```

**优点**：思路自然；用户视角是"还在跟一个 Agent 对话"。
**缺点**：只能 1→1 转移；不适合并行协作。

## 8. 协作模式

### 8.1 Producer-Critic（生产-评审）

```
generator → critic → satisfactory? ── yes ──► output
                ▲                  │
                └─── revise ───────┘
```

例：写代码 + 评审、写文章 + 编辑。两个 Agent 用不同 prompt 形成"对抗"。

### 8.2 Roleplay 协作

每个 Agent 是"角色"：PM、设计师、工程师，按角色发言：

```python
agents = {
    "pm": create_react_agent(llm, tools, system="你是产品经理，关注用户价值..."),
    "designer": create_react_agent(llm, tools, system="你是设计师，关注..."),
    "engineer": create_react_agent(llm, tools, system="你是工程师，关注可行性..."),
}
```

代表：CAMEL、MetaGPT、ChatDev。

**陷阱**：roleplay 容易"过戏"——Agent 沉浸角色忘了完成任务。要在 system prompt 里强约束："你的目标是 X，角色只是表达方式"。

### 8.3 Debate / Consensus

让多个 Agent 独立给方案，再投票或辩论达成共识：

```
question
   │
   ├──► agent_A ──► answer_A
   ├──► agent_B ──► answer_B
   └──► agent_C ──► answer_C
                       │
                       ▼
                 judge / vote
                       │
                       ▼
                  final answer
```

成本高，但**对正确率提升明显**——尤其在数学 / 推理任务（Self-Consistency 思路）。

### 8.4 Map-Reduce

并行子任务 + 聚合：

```python
from langgraph.constants import Send

def fan_out(state):
    return [Send("researcher", {"topic": t}) for t in state["topics"]]

graph.add_node("planner", planner)
graph.add_node("researcher", researcher)   # 并行
graph.add_node("aggregator", aggregator)
graph.add_conditional_edges("planner", fan_out, ["researcher"])
graph.add_edge("researcher", "aggregator")
```

适合：调研 N 个候选、批量分析 N 份文档。详见 [`langgraph/04 §4.2`](../langgraph/04-control-flow.md)。

## 9. 角色设计原则

每个 Agent 给清晰的"职责画像"：

| 字段 | 例 |
|---|---|
| 名字 | researcher |
| 职责 | 通过 web search 收集信息、提炼摘要 |
| 输入 | 调研主题（一句话） |
| 输出 | 5-10 条 bullet point + 引用 |
| 工具 | search_web、read_url |
| 不做什么 | 不写报告（那是 writer 的活）、不评估（那是 reviewer） |

**"不做什么"经常比"做什么"重要**——避免 Agent 越界。

## 10. 多 Agent 的"调试三件套"

多 Agent 调试比单 Agent 难十倍。必备：

### 10.1 全 trace 可视化

LangSmith / 自家 tracer 每个 Agent 调用都要打 tag：

```python
agent_b.with_config({"tags": ["agent:b", "team:research"]})
```

UI 上按 tag 过滤、追踪。

### 10.2 消息 / handoff 日志

```python
log.info("agent.handoff", from_="A", to="B", reason="...")
```

时间轴上看得到"谁把球踢给谁"。

### 10.3 Replay 能力

LangGraph Checkpointer 让你**回到某个节点重跑**——多 Agent 中"为什么 Agent C 决定那样做"经常需要复现。

## 11. 多 Agent 的常见失败

| 现象 | 根因 |
|---|---|
| Supervisor 反复选同一个 worker | worker 输出没积累、或 supervisor 不知道任务进展 |
| 每个 Agent 都能解决问题，但合作时崩 | 角色边界模糊；prompt 加"不做什么" |
| Agent 之间对答如流但任务没推进 | "聊天为聊天"——加硬性步数限制 + outcome 检查 |
| Token 成本爆炸 | 每个 Agent 看完整对话；用摘要传递 |
| Supervisor 死循环 | 加 max_iterations 守门 |
| 一个 Agent 失败拖死全队 | 加 fallback / try-catch；单 Agent 失败不阻塞其他 |
| 输出不一致（Agent A 说 X，B 说 not X） | 共享 state 没设 source of truth；定一个权威字段 |

## 12. 何时回退到单 Agent

如果你正在做多 Agent 但出现下面情况，**回退到单 Agent 更明智**：

- 调试时间超过功能开发时间 50%
- 多 Agent 版本完成率反而低于单 Agent
- 用户反馈"这玩意太慢"
- 团队抱怨"看不懂哪个 Agent 干了啥"

## 13. 反模式

| 反模式 | 后果 |
|---|---|
| 滥用多 Agent（简单任务也分角色） | 慢、贵、调试难 |
| 角色重叠（researcher 也写报告） | 谁都做、谁都不精 |
| Supervisor 没"完成"出口 | 死循环 |
| Worker 把全部历史传回主 state | token 爆炸 |
| 不限步数 | 单一 worker 卡住 → 整个系统瘫 |
| 角色 prompt 过度 roleplay | 沉浸角色忘任务 |
| 多 Agent + 太多 sub-agents | 分形复杂度，调不出 |

## 14. 实战 checklist：多 Agent 上线前

- [ ] 角色 ≤ 7 个，且每个角色"不做什么"明确
- [ ] 总步数有上限（recursion_limit）
- [ ] 每个 Agent 有 fallback 行为（失败 → 上报）
- [ ] Supervisor / Router 有 FINISH 出口
- [ ] 主 state 用摘要，不传整段历史
- [ ] 每个 Agent 调用都有 tag / trace
- [ ] 评测覆盖（[eval/07](../eval/07-agent-eval.md) Agent 评测）

## 15. 下一步

- [07 · 通信协议](./07-protocols.md) — 多 Agent 通信的标准化（A2A、ANP）
- [09 · 框架对比](./09-frameworks.md) — AutoGen / CrewAI / LangGraph 多 Agent 实现
- [`langgraph/09`](../langgraph/09-subgraphs.md) — Subgraph + Supervisor / Swarm
