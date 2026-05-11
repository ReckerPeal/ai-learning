# 02 · 经典范式

> 对应 [hello-agents](https://github.com/datawhalechina/hello-agents) 第 4 章。
> 本章纵览 5 种范式，给清楚**每种适合什么、坑在哪、怎么组合**。代码层面的范式实现见 [`langgraph/05`](../langgraph/05-tools-and-agents.md)。

## 1. 范式速查表

| 范式 | 一句话 | 步骤 | 推理可见 | 适合 |
|---|---|---|---|---|
| **ReAct** | 边推理边执行 | Reason → Act → Observe → 循环 | ✅ | 通用，~80% 场景 |
| **Plan-and-Solve** | 先全局规划，再分步执行 | Plan → Step₁ → Step₂ → … | ✅ | 长任务、明确目标 |
| **Reflection** | 做完反思一遍 | Do → Critique → Revise | ✅ | 写作、代码生成 |
| **Reflexion** | 失败时反思下次怎么做 | Do → Eval → Reflect → Retry | ✅ | 多轮试错任务 |
| **Tree of Thoughts (ToT)** | 推理过程并行多分支 + 评分 | Tree search over thoughts | ✅ | 复杂推理 / 数学 |

下面逐一展开。

## 2. ReAct（Reasoning + Acting）

[Yao et al. 2022](https://arxiv.org/abs/2210.03629) 提出，**目前事实上的默认 Agent 范式**。

### 2.1 核心思路

把"思考"和"行动"交织在一个循环里：

```
Thought: 我需要先查天气...
Action:  get_weather(city="北京")
Observation: 北京 25°C 晴
Thought: 用户还问了空气质量...
Action:  get_aqi(city="北京")
Observation: AQI 45 优
Thought: 信息够了，可以回答
Final Answer: 北京天气 25°C 晴，空气质量优。
```

每一步 LLM 同时输出"思考"和"行动"，工具结果作为"观察"喂回。**透明可调试**——日志里每一步思考都看得见。

### 2.2 在现代 LLM 中的实现

早期 ReAct 用 prompt 工程让 LLM 输出固定格式。**现在不用**——直接用 LLM 的原生 **tool calling**：

```python
# LLM 自己判断要不要调工具
while True:
    resp = llm_with_tools.invoke(messages)
    messages.append(resp)
    if not resp.tool_calls:
        return resp.content
    for tc in resp.tool_calls:
        result = run_tool(tc)
        messages.append(ToolMessage(content=result, tool_call_id=tc.id))
```

即 [`langgraph/02`](../langgraph/02-quickstart.md) §3 那张图。

### 2.3 ReAct 的边界

| 不擅长 | 原因 |
|---|---|
| 长程任务（>10 步） | 推理上下文越来越长，token 飙升、模型容易迷路 |
| 需要"先规划再执行"的任务 | 走一步看一步，可能走偏 |
| 有明确依赖关系的子任务 | LLM 难以维持依赖图 |
| 严苛的成本 | 每步都调 LLM，贵 |

### 2.4 ReAct 的常见 anti-pattern

| 现象 | 原因 |
|---|---|
| 反复调同一个工具 | LLM 没看到上一次结果 / 没把 ToolMessage 喂回 |
| 在思考中"演练"工具调用而不真调 | prompt 引导不够、模型偏好直接答 |
| 中途突然给一个错误答案 | 工具失败被忽略；建议用 [eval/07](../eval/07-agent-eval.md) 的 trajectory 评测查 |
| 死循环 | 加 `max_steps` 硬上限 |

## 3. Plan-and-Solve

[Wang et al. 2023](https://arxiv.org/abs/2305.04091) —— **先生成完整计划再执行**。

### 3.1 流程

```
   ┌──── planner ────┐
   │ 1. 查 X 信息    │
   │ 2. 计算 Y       │
   │ 3. 输出报告     │
   └────────┬────────┘
            ▼
   ┌──── executor ───┐
   │ run step 1      │
   │ run step 2      │
   │ run step 3      │
   └────────┬────────┘
            ▼
        最终答案
```

### 3.2 LangGraph 实现骨架

```python
from pydantic import BaseModel

class Plan(BaseModel):
    steps: list[str]

def planner(state):
    plan = llm.with_structured_output(Plan).invoke(
        f"为「{state['task']}」生成执行计划。"
    )
    return {"plan": plan.steps, "past_steps": []}

def executor(state):
    step = state["plan"][0]
    result = sub_agent.invoke({"task": step})
    return {
        "past_steps": [(step, result)],
        "plan": state["plan"][1:],
    }

def should_end(state):
    return END if not state["plan"] else "executor"

# planner → executor → planner（重规划） / END
```

### 3.3 Plan-and-Execute（带重规划）

更鲁棒的变种：每步执行后**根据进展重写计划**：

```python
def replanner(state):
    new_plan = llm.invoke(f"""
原计划：{state['plan']}
已完成：{state['past_steps']}
是否需要调整剩余计划？给出更新后的计划。
""")
    return {"plan": new_plan.steps}
```

适合：环境会变化、子任务可能失败的长任务。

### 3.4 优劣

| 优点 | 缺点 |
|---|---|
| 整体性强，不会"走歪" | 计划阶段对 LLM 要求高 |
| 步数可估算（成本可预测） | 计划僵化，环境变化时失效（需要 replan） |
| 易于人工审核 / HITL | 简单任务用了反而更慢 |
| 适合外部 logging / 进度展示 | 调试难度比 ReAct 高 |

## 4. Reflection

[Madaan et al. 2023 (Self-Refine)](https://arxiv.org/abs/2303.17651) —— **做完之后自己审视一遍，改进**。

### 4.1 流程

```
generate → critique → revise → 满意？─ no ─► generate
                                  │
                                  yes
                                  ▼
                                final
```

```python
def generate(state):
    return {"draft": llm.invoke(state["task"]).content}

def critique(state):
    fb = llm.invoke(f"""
评论这份回答的不足，指出具体问题：
任务：{state['task']}
回答：{state['draft']}
""").content
    return {"feedback": fb}

def revise(state):
    return {"draft": llm.invoke(f"""
按反馈修改：
反馈：{state['feedback']}
原回答：{state['draft']}
""").content}

def is_good_enough(state):
    return END if state.get("iterations", 0) >= 2 else "critique"
```

### 4.2 适合什么

- **写作 / 代码生成**：第一版就想到位很难，迭代式提升明显
- **需要严谨性**的内容（合同、法律分析）
- **需要风格 / 一致性**的长文档

### 4.3 注意

- **2-3 轮就饱和**：再迭代提升微弱、token 浪费
- **反思要有具体指引**：让 LLM 检查"事实/逻辑/风格/简洁性"等具体维度，比泛泛"指出问题"好
- **避免反思套娃**：critic 改不动 generator 的"风格"，这是 prompt 设计问题，不是迭代次数问题

## 5. Reflexion

[Shinn et al. 2023](https://arxiv.org/abs/2303.11366) —— **失败 / 评估后反思，存进 memory，下次试时参考**。

### 5.1 与 Reflection 的区别

| 维度 | Reflection | Reflexion |
|---|---|---|
| 反思对象 | 当前回答 | 一次完整尝试的成败 |
| 反思频率 | 每次生成后 | 每次失败后 |
| 反思储存 | 当前对话 | **跨会话 memory** |
| 适合 | 单次输出质量提升 | 多次试错的任务（编程、博弈） |

### 5.2 流程

```
attempt task → eval → success? ─ yes ─► done
                       │
                       no
                       ▼
                ┌────────────┐
                │ reflect:   │
                │ "为什么失败"│
                │ → memory   │
                └─────┬──────┘
                      ▼
                  retry（看 memory）
```

### 5.3 关键：Reflection Memory 怎么设计

不是把"失败原因"全塞回去——那会爆 token。压缩成**经验条目**：

```python
class Lesson(BaseModel):
    failure_pattern: str   # "我之前在 X 场景下犯了 Y 错误"
    fix_hint: str          # "下次该 Z"
    severity: int          # 1-5

# Lesson 列表作为 system prompt 的一部分塞回去
```

可参考 [eval/02 §6 Failure Set](../eval/02-datasets.md#6-failure-set失败案例沉淀)——这是 Reflexion memory 的工程化版本。

## 6. Tree of Thoughts (ToT)

[Yao et al. 2023](https://arxiv.org/abs/2305.10601) —— **把思考过程展开成树，并行探索多分支，选最优**。

### 6.1 思路

```
                    任务
                   /  |  \
              想法A  想法B  想法C    ← 第一层：3 个候选思路
              /\      |     |\
            ...        ...  ... ...   ← 每个分支继续展开
                |
              评估每个叶子
                |
              选最优路径
```

不再是线性 ReAct，而是**搜索**：BFS / DFS / Beam Search 都可。

### 6.2 落地代码骨架

```python
def expand(state, n=3):
    """展开 n 个候选 thought。"""
    return llm.invoke(f"为下一步给出 {n} 个不同方向的思路：{state}").choices

def evaluate(thoughts):
    """打分。"""
    return llm.invoke(f"评估这些思路 0-10 分：{thoughts}")

def search(initial, depth=3, beam=2):
    frontier = [initial]
    for d in range(depth):
        candidates = []
        for s in frontier:
            candidates.extend(expand(s))
        scored = [(t, evaluate(t)) for t in candidates]
        frontier = [t for t, _ in sorted(scored, key=lambda x: -x[1])[:beam]]
    return frontier[0]
```

### 6.3 适合 / 不适合

| 适合 | 不适合 |
|---|---|
| 数学题、逻辑题 | 简单问答（杀鸡用牛刀） |
| 创意任务（多方案备选） | 工具调用密集型（搜索时不能调工具） |
| 需要回溯的任务 | 实时性要求高的场景 |

代价：**贵**。每个分支都要调 LLM，token / latency 成倍增长。

### 6.4 ToT 的实用变种：Best-of-N

ToT 工程上常用的简化版——**生成 N 个候选，pick 最好的**：

```python
candidates = [llm.invoke(prompt) for _ in range(5)]
best = pick_best(candidates, judge=llm)
```

不展开树，但保留"多路径"的好处。**比完整 ToT 实用得多**。

## 7. 范式选型决策树

```
任务有清晰多步结构？
├── 是 → 任务可能动态变化？
│        ├── 是 → Plan-and-Execute（带 replan）
│        └── 否 → Plan-and-Solve（一次规划）
└── 否 → 任务需要工具调用？
         ├── 是 → ReAct
         └── 否 → 输出质量重要？
                  ├── 是 → Reflection（写作 / 代码）
                  └── 否 → 单次 LLM 调用就行
```

正交考虑：

- **可能失败、能反复试** → 加 Reflexion 层
- **复杂推理** → 加 ToT / Best-of-N
- **多角色协作** → §06 Multi-Agent
- **超长任务** → §05 Planning + §08 Context Engineering

## 8. 范式可以组合

实战中很少只用一种。常见组合：

| 组合 | 例子 |
|---|---|
| **ReAct + Reflection** | 工具调用版本写完，自己 review 一遍 |
| **Plan + ReAct** | planner 出步骤，每步用 ReAct 执行 |
| **Plan + Reflexion** | 失败时 replan + 记录经验 |
| **Multi-Agent + ReAct** | 每个 worker 内部是 ReAct |
| **ToT + Reflexion** | 树搜索失败的分支，反思下次怎么剪枝 |

LangGraph 把"组合"做成显式的图，比早期 LangChain `AgentExecutor`（写死 ReAct）灵活得多。

## 9. 不是范式问题的问题

很多人找范式找错了方向，实际是：

| 表现 | 真正的问题 |
|---|---|
| Agent 总是答错 | **工具描述不清** / 模型能力不够 |
| Agent 跑得慢 | **工具本身慢** / 历史太长 |
| Agent 不稳定 | **Memory 设计**问题（§03） |
| Agent 烧钱 | **没分级**（router 用便宜模型，主推理用强模型） |
| Agent 跑偏 | **Planning** 没做（§05） |

**先问"是不是范式问题"再换范式**。

## 10. 常见坑

| 现象 | 原因 |
|---|---|
| ReAct 思考变成"我应该调 X 工具"但不真调 | LLM 没绑定工具 / 模型不支持 tool calling |
| Plan-and-Solve 计划脱离实际 | planner 没看到工具列表，计划里写了不存在的工具 |
| Reflection 越改越差 | 反思 prompt 太宽泛；让 critic 看具体维度 |
| Reflexion 经验越攒越多、爆 token | memory 没去重 / 分级；定期合并 |
| ToT 分数 noise 大 | 评估也是 LLM，自带抖动；用 reference + judge |
| 范式套娃过深 | 三层以上嵌套调试地狱；保持扁平 |

## 11. 下一步

- [03 · 认知架构](./03-cognitive-architecture.md) — Memory 怎么撑起范式
- [04 · 工具使用](./04-tool-use.md) — 范式之下的工具基础
- [05 · 规划](./05-planning.md) — Plan-and-Solve 深挖
- [`langgraph/05`](../langgraph/05-tools-and-agents.md) — 这些范式的 LangGraph 实现
