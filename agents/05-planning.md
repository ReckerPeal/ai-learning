# 05 · 规划（Planning）

> 当任务超过 3-5 步、依赖关系明显、或需要长程目标时——光靠 ReAct"走一步看一步"会走偏，需要显式 Planning。
> 与 [`02 · 经典范式`](./02-paradigms.md) 中 Plan-and-Solve 的"概念介绍"互补，本章讲**怎么落地**。

## 1. 什么时候需要 Planning

判断信号：

| 信号 | 说明 |
|---|---|
| 任务超过 5 步 | ReAct 上下文累积过快、容易漂移 |
| 子任务有先后依赖 | A 完成后才能开始 B |
| 中间需要等待 | 等用户、等异步 API |
| 用户想看到进度 | "正在做第 2/5 步…" |
| 不同子任务用不同模型/工具 | router 复杂 |
| 整体成本要可估算 | 老板需要预算 |

不需要的信号：
- 任务 1-3 步，单一 chain 搞定
- 任务路径**完全不可预测**（探索式 RL 任务）
- 实时性极高（每步都规划反而慢）

## 2. Planning 的层次

```
Strategic（战略）  ── 整体目标拆成大模块（"先调研，再写报告"）
Tactical（战术）   ── 模块内具体步骤（"先 Google 5 个关键词"）
Operational（操作）── 单步具体动作（"调 web_search 工具"）
```

ReAct 解决的是 Operational；Planning 解决的是 Strategic + Tactical。

## 3. 五种 Planning 模式

### 3.1 Static Plan（一次规划，按计划走）

最简单，最早提出（Plan-and-Solve）：

```python
class Plan(BaseModel):
    steps: list[str]

def planner(state):
    plan = llm.with_structured_output(Plan).invoke(
        f"任务：{state['task']}\n\n生成执行计划，每步用一句话描述。"
    )
    return {"plan": plan.steps, "current_step": 0}

def executor(state):
    step = state["plan"][state["current_step"]]
    result = sub_agent.invoke({"task": step})
    return {
        "past_steps": [(step, result)],
        "current_step": state["current_step"] + 1,
    }

def is_done(state):
    return END if state["current_step"] >= len(state["plan"]) else "executor"
```

适合：任务**确定性高**、环境**不会变**。

### 3.2 ReWOO（先规划 + 占位变量）

[ReWOO（2023）](https://arxiv.org/abs/2305.18323) —— 让 planner 一次规划全部步骤，并用变量引用前序结果：

```
Plan:
1. search("OpenAI CEO") → #E1
2. search(f"{#E1}'s university") → #E2
3. search(f"founding year of {#E2}") → #E3
4. answer(combine #E1, #E2, #E3)
```

执行时按依赖图跑，**一次性 LLM 调用做完整规划**——比 ReAct 省 token（推理阶段不重复发上下文）。

### 3.3 Dynamic Plan / Plan-and-Execute（带 Replan）

每步执行后**根据进展重写剩余计划**——更鲁棒：

```python
def replanner(state):
    new_plan = llm.with_structured_output(Plan).invoke(f"""
原任务：{state['task']}
原计划：{state['plan']}
已完成：{state['past_steps']}
最新观察：{state['last_observation']}

是否调整剩余计划？返回更新后的剩余步骤，或返回空表示完成。
""")
    if not new_plan.steps:
        return {"final_answer": llm.invoke(...)}
    return {"plan": new_plan.steps, "current_step": 0}
```

LangGraph 流程：

```
START → planner → executor → replanner ─┬─► executor（继续）
                                        ├─► END
                                        └─► (任务调整时)
```

适合：环境会变化、子任务可能失败、长任务（>10 步）。

### 3.4 HTN（层次任务网络）

借鉴经典 AI Planning（Hierarchical Task Network）—— **任务分解成子任务，递归到原子动作**：

```
Goal: 写一份关于 X 的报告
  ├── 调研 X
  │     ├── 搜索 X 的最新新闻（原子）
  │     ├── 搜索 X 的学术论文（原子）
  │     └── 整理摘要（原子）
  ├── 编写大纲（原子）
  ├── 撰写章节
  │     ├── 引言（原子）
  │     ├── 正文 × N（原子）
  │     └── 结论（原子）
  └── 审校（原子）
```

LangGraph 实现：每个非原子任务对应一个**子图**（[`langgraph/09`](../langgraph/09-subgraphs.md)），原子任务对应一个工具或一次 LLM 调用。

适合：领域知识丰富、可以预定义"任务 → 子任务"映射的场景。

### 3.5 Tree Search Planning（搜索式规划）

把"可能的计划"展开成搜索空间：

```
                    任务
              /      |      \
        plan_A   plan_B    plan_C    ← 多个候选计划
         /\        |        /\
       ...        ...     ...      ← 每个计划继续展开
                    │
              evaluate（成本 / 风险 / 成功率预估）
                    │
              选最优 plan 执行
```

实质是 [§02 §6 ToT](./02-paradigms.md#6-tree-of-thoughts-tot) 应用到规划层。

适合：决策空间大、**预先评估比执行便宜**的场景（典型：游戏 AI、机器人路径规划）。LLM Agent 里少见——多数任务"想 vs 做"的成本差不多。

## 4. Planner 的 prompt 设计要点

Planner 是规划质量的瓶颈。几个关键点：

### 4.1 给 planner 完整的"工具清单"

```python
planner_prompt = f"""
你是任务规划者。可用工具：

{format_tools(available_tools)}   # 列表 + 描述

任务：{task}

生成步骤，每步：
1. 描述要做什么
2. 预计用哪个工具（或不用工具）
3. 输出会传给下一步什么
"""
```

不给工具清单，planner 会编出**不存在的步骤**。

### 4.2 限制步数

```
约束：
- 步骤数 3-7
- 每步只做一件事
- 步骤之间数据流要清晰
```

不限制，planner 会写出 15 步的"完美计划"——但每步都失误一点点，最后崩盘。

### 4.3 让 planner 给"成功标准"

```
对每步给出"如何判断完成"。如：
- step 2: 完成标志 = 至少拿到 3 篇相关论文
```

下游可以据此判断是否需要 replan。

### 4.4 鼓励"可暂停"的设计

```
如果某步需要用户输入 / 高风险操作 / 不可逆，标记 [HUMAN]，让我手动审核。
```

把 HITL 设计前移到 planner 层。

## 5. Plan 的存储与可视化

Plan 不是 LLM 的"内心活动"——**显式存进 state**：

```python
class State(TypedDict):
    task: str
    plan: list[Step]            # 完整计划
    current_step: int
    past_steps: Annotated[list, add]
    plan_version: int           # replan 次数
```

UI 展示：

```
任务：分析竞品 X 的定价策略

✅ Step 1: 调研 X 当前定价（已完成 - 收集到 5 个价格点）
🔄 Step 2: 对比同类产品的定价分布（执行中...）
⏳ Step 3: 撰写竞品分析报告
⏳ Step 4: 提出建议
```

进度感比"loading..."强 100 倍——产品体验提升明显。

## 6. Replan 的触发时机

不要每步都 replan（贵且不稳定）。**触发条件**：

| 触发 | 场景 |
|---|---|
| 上一步执行失败 | 工具报错 / 结果异常 |
| 上一步发现新信息 | 调研中发现该考虑的新维度 |
| 进度偏离预期 | 实际花的步数远超计划 |
| 用户介入 | HITL 后用户改了目标 |
| 周期性（每 N 步） | 长任务防漂移 |

```python
def need_replan(state) -> bool:
    return any([
        state["last_step_failed"],
        len(state["past_steps"]) > len(state["plan"]) * 1.5,
        state["user_interrupt_received"],
        state["surprising_discovery"],
    ])
```

## 7. Plan-and-Execute 完整骨架（LangGraph）

```python
from typing import TypedDict, Annotated, Literal
from operator import add
from pydantic import BaseModel
from langgraph.graph import StateGraph, START, END
from langchain_openai import ChatOpenAI

class Step(BaseModel):
    description: str
    tool_hint: str | None = None
    success_criteria: str | None = None

class Plan(BaseModel):
    steps: list[Step]

class State(TypedDict):
    task: str
    plan: list[Step]
    past_steps: Annotated[list[tuple], add]
    final_answer: str | None
    iteration: int

llm = ChatOpenAI(model="gpt-4o", temperature=0)

def planner(state):
    plan = llm.with_structured_output(Plan).invoke(...)
    return {"plan": plan.steps, "iteration": 0}

def executor(state):
    if not state["plan"]:
        return {}
    step = state["plan"][0]
    # 用 sub-agent 跑这一步
    result = react_agent.invoke({"messages": [HumanMessage(step.description)]})
    return {
        "past_steps": [(step.description, result)],
        "plan": state["plan"][1:],
        "iteration": state["iteration"] + 1,
    }

def replanner(state):
    if not state["plan"] or state["iteration"] > 15:
        # 任务结束 / 超步数
        final = llm.invoke(f"基于已完成步骤总结答案：{state['past_steps']}")
        return {"final_answer": final.content}
    if state["past_steps"][-1][1].get("error"):
        # 上步失败 → 重新规划剩余
        new_plan = llm.with_structured_output(Plan).invoke(f"""
原计划：{state['plan']}
已完成：{state['past_steps']}
最新失败：{state['past_steps'][-1]}
重新规划剩余步骤。
""")
        return {"plan": new_plan.steps}
    return {}   # 不需要 replan

def route(state) -> Literal["executor", "__end__"]:
    return END if state.get("final_answer") else "executor"

graph = StateGraph(State)
graph.add_node("planner", planner)
graph.add_node("executor", executor)
graph.add_node("replanner", replanner)

graph.add_edge(START, "planner")
graph.add_edge("planner", "executor")
graph.add_edge("executor", "replanner")
graph.add_conditional_edges("replanner", route, {"executor": "executor", END: END})

app = graph.compile()
```

## 8. Planning 的常见失败模式

| 现象 | 根因 |
|---|---|
| 计划"漂亮但不可执行" | planner 不知道工具的真实能力；给完整 tool 清单 |
| 死循环（plan → execute → replan → 同样的 plan） | replanner 没拿到失败信息；要传 last_error |
| 计划步数失控（动辄 20 步） | prompt 没限制；显式约束 step 数上限 |
| 单步太抽象，executor 不会做 | 让 planner 给"成功标准"，executor 才知道边界 |
| Replanner 把好计划改坏 | replan 触发条件太松；只在真正失败时才 replan |
| 长任务忘记初始目标 | task 字段必须留在 state 里，不要让它从 messages 中消失 |

## 9. Planning 与其他范式的组合

| 组合 | 用例 |
|---|---|
| **Plan + ReAct** | planner 出步骤；每步用 ReAct 子 Agent 执行 |
| **Plan + Reflection** | 整个计划做完后 reflect 是否达标 |
| **Plan + Multi-Agent** | planner 把步骤分配给不同专家 Agent |
| **HTN + Tools** | 顶层任务分解；叶子节点对应具体工具 |
| **Plan + HITL** | 高风险步骤标记 `[HUMAN]`，执行前停下让人确认 |

## 10. 实战经验

### 10.1 Plan 落地的"二八法则"

- 80% 的任务用 ReAct 就够，**不要无脑上 Planning**
- 剩下 20% 用 Planning，提升明显（但调试难度也大）

### 10.2 Plan ≠ 控制流

不要把 Plan 写得像伪代码（`if x then ...`）—— 那是 Workflow / Chain 的活，不是 LLM 干的。Plan 应该是**任务级**描述。

### 10.3 把"试探性步骤"作为单独阶段

复杂任务的第一步常常是"先调研"——让 Agent 显式有一个"探查阶段"：

```
Plan:
1. [Probe] 先简单了解 X 的现状  ← 不是最终目标，是为了后续规划
2. [Plan] 基于探查结果，决定下一步策略
3. ...（动态生成）
```

### 10.4 Plan 也是 prompt

Plan 本身会被反复读到 LLM 上下文中——**短**比**详**重要。每步用一行描述，别写段落。

## 11. 反模式

| 反模式 | 后果 |
|---|---|
| Planning 滥用（简单任务也 plan） | 慢、贵、容易出错 |
| Planner 不知道工具能力 | 编出无法执行的计划 |
| 完成标志不明确 | Executor 不知道何时停 |
| 不做 replan，硬执行原计划 | 任务变化时崩盘 |
| Replan 频率过高 | 计划反复变，进度反而慢 |
| Plan 嵌套太深（plan 里还有 plan） | 调试地狱 |
| 把 Plan 作为隐式状态（藏在 messages 里） | 看不到、改不了 |

## 12. 下一步

- [06 · 多 Agent 系统](./06-multi-agent.md) — Planner 把任务分给不同 Agent
- [08 · 上下文工程](./08-context-engineering.md) — 长任务的上下文管理
- [`langgraph/09`](../langgraph/09-subgraphs.md) — HTN 的子图实现
- [eval/07 · Agent 评测](../eval/07-agent-eval.md) — Plan 的轨迹评测
