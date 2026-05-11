# 01 · Agent 是什么

> 对应 [hello-agents](https://github.com/datawhalechina/hello-agents) 第 1-2 章。

## 1. 一个能跑通的定义

**Agent = LLM + 工具 + 自主决策循环**：

> 给定目标，Agent 自己决定调什么工具、传什么参数、看到结果后下一步做什么，直到目标完成或放弃。

最小拆解：

```
       ┌────────────┐
       │   目标      │
       └──────┬─────┘
              ▼
       ┌────────────┐    ┌────────────┐
       │   思考      │ ◄─►│   记忆      │
       └──────┬─────┘    └────────────┘
              ▼
       ┌────────────┐    ┌────────────┐
       │   行动      │ ◄─►│   工具      │
       └──────┬─────┘    └────────────┘
              ▼
       ┌────────────┐
       │   观察      │
       └──────┬─────┘
              │
              └────► 回到"思考"，直到完成
```

四个模块缺一不可：**目标、思考、行动、观察**。**记忆**和**工具**是两条横切线。

## 2. 与"普通 LLM 应用"的边界

LLM 应用 ≠ Agent。一张表区分：

| 特征 | 普通 LLM 调用 | Workflow / Chain | Agent |
|---|---|---|---|
| 控制流 | 一次推理 | **人**预定义的步骤 | **LLM**决定下一步 |
| 步数 | 1 | 固定 | 不确定，循环 |
| 工具 | 0 / 内置 | 可有 | 必须有 |
| 失败处理 | 重试 | 预设分支 | LLM 看错误自己改方案 |
| 状态 | 无状态 | 有但简单 | 复杂、需要管理 |
| 可预测性 | 高 | 高 | 低 |

> **Anthropic 的实用区分**：[Building Effective Agents](https://www.anthropic.com/research/building-effective-agents) 把上述区分得很犀利——**先用 Workflow 能解决，就别上 Agent**。Agent 灵活但贵、慢、难调。

工程上的判断：

- 任务路径固定 → **Workflow / Chain**（LCEL、固定 LangGraph）
- 任务路径**完全由输入决定** → **Agent**（ReAct 循环 + 工具）
- 中间地带 → **Hybrid**（外层固定流程，内部 sub-task 用 Agent）

## 3. Agent 的演化简史

```
1950s  ─── 符号主义 AI（专家系统、规则推理）
1990s  ─── BDI Agent（Belief-Desire-Intention，多 Agent 系统理论奠基）
2010s  ─── RL Agent（DQN、AlphaGo——但纯 RL）
2022   ─── ReAct（Yao et al.）—— LLM + 工具调用 + 推理循环
2023   ─── AutoGPT / BabyAGI（火爆但不实用）
       ─── Toolformer / Plan-and-Solve / Reflexion（范式演进）
       ─── LangChain AgentExecutor（早期框架）
2024   ─── Multi-Agent 兴起（CrewAI、AutoGen、LangGraph multi-agent）
       ─── 真正落地：Devin、Cursor、Claude Code
       ─── MCP（Model Context Protocol）发布——工具/上下文标准化
2025   ─── Agentic AI 元年：Manus、OpenManus、各类垂直 Agent
       ─── A2A / ANP 等通信协议
       ─── Agentic RL（GRPO 等）训练专用 Agent
```

**关键转折**：2022 年 ReAct 出现前，Agent 是符号 / RL 学派；之后 LLM 把 reasoning 和 acting 统一到自然语言里——这就是当下 Agent 浪潮的起点。

## 4. 现代 Agent 的"层"模型

把一个生产级 Agent 系统拆解，从下往上：

```
┌──────────────────────────────────┐
│  L5  应用层（特定业务，UI / 编排）│
├──────────────────────────────────┤
│  L4  Agent 编排（LangGraph 等）  │
├──────────────────────────────────┤
│  L3  Memory & Context 管理       │
├──────────────────────────────────┤
│  L2  工具协议（MCP / 自定义）     │
├──────────────────────────────────┤
│  L1  LLM 推理（带 tool calling） │
├──────────────────────────────────┤
│  L0  基础设施（GPU / API / 监控）│
└──────────────────────────────────┘
```

| 层 | 谁负责 | 本主题相关章节 |
|---|---|---|
| L0 | 平台 / 云 | 不在范围 |
| L1 | 模型供应商 | [LangChain 03 ChatModel](../langchain/03-prompts-and-models.md) |
| L2 | 标准 + 自家工具 | §07 协议、§04 工具 |
| L3 | 框架 + 自定义 | §03 认知架构、§08 上下文工程 |
| L4 | 框架 | [LangGraph](../langgraph/)、§09 框架对比 |
| L5 | 你 | §10 生产部署 |

## 5. Agent 的"度量"

判断一个 Agent 好不好，至少看四组指标：

| 维度 | 指标 | 详见 |
|---|---|---|
| 效果 | 任务完成率、最终答案正确率 | [eval/07](../eval/07-agent-eval.md) |
| 效率 | 步数、token 消耗、延迟 | 同上 |
| 稳定性 | 重复性、recursion limit 命中率 | [langgraph/04 §3.1](../langgraph/04-control-flow.md) |
| 安全 | 拒绝率、HITL 触发、注入抵抗 | §04 §10 |

**单看"完成率"会被误导**——绕远路 / 烧 token / 偶尔出格的 Agent 也能做完任务。

## 6. 三类 Agent 系统的"难度"

按工程难度递增：

### 6.1 单 Agent + 工具（最简单）

```
user → agent_loop(tools) → answer
```

例：Cursor 的 inline edit、ChatGPT 的代码解释器。

难点：工具设计、错误恢复。本主题 §02-04 解决。

### 6.2 单 Agent + 长任务（中等）

```
user → planner → executor → planner → ... → answer
                     │
              memory / checkpoint
```

例：Devin、Manus。

难点：Planning、Memory、Context Engineering。本主题 §03/05/08 解决。

### 6.3 多 Agent 协作（最复杂）

```
user → supervisor ─┬─► agent_a
                   ├─► agent_b
                   └─► agent_c
       ▲             │
       └─────────────┘
```

例：CrewAI 团队、AutoGen GroupChat、复杂工作流。

难点：拓扑设计、消息路由、共识、调试。本主题 §06-07 解决。

> 经验法则：**单 Agent 能做就别上多 Agent**。多 Agent 调试成本是单 Agent 的 3-10 倍，但能力提升经常只有 20-30%。

## 7. 常见误解

| 误解 | 真相 |
|---|---|
| Agent = 带 RAG 的 ChatBot | RAG 是工具的一种，Agent 远不止于此（要决策循环） |
| Agent 一定要多步循环 | 单步也算（如 OpenAI Function Calling 一次调用） |
| 上 Agent 就比 Chain 智能 | Agent 失控的概率比 Chain 高十倍 |
| Agent 可以"完全自主" | 生产 Agent 几乎都需要 HITL；纯自主只在有限场景成立 |
| Agent 框架越花哨越好 | 越简单越好——LangChain 早期 AgentExecutor 复杂、不可调试，已被 LangGraph 替代 |
| 多 Agent 一定比单 Agent 强 | 多 Agent 通信开销 + 共识难，常常更差 |

## 8. 心智模型：把 Agent 想成"循环 + 状态机"

Agent 本质是带状态的循环。两种视角：

- **循环视角**：`while not done: think → act → observe`
- **状态机视角**：节点（thinking, acting, waiting, error）+ 迁移（条件边）

LangGraph 用的是后者——把循环显式地画成有向图。这种视角下：

- "Agent" 是图的拓扑
- "记忆" 是 state schema
- "重试" 是回边
- "HITL" 是中断（interrupt）

详见 [`langgraph/01`](../langgraph/01-overview.md)。

## 9. 一个最小 Agent（30 行）

不依赖任何 Agent 框架，纯 LLM + 字典维持的 Agent：

```python
from openai import OpenAI
import json

client = OpenAI()
TOOLS = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get weather for a city.",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
    },
}]

def call_tool(name, args):
    if name == "get_weather":
        return f"{args['city']} is 25°C, sunny"
    raise ValueError(name)

def run(user_msg, max_steps=5):
    messages = [{"role": "user", "content": user_msg}]
    for _ in range(max_steps):
        resp = client.chat.completions.create(
            model="gpt-4o-mini", messages=messages, tools=TOOLS,
        ).choices[0].message
        messages.append(resp)
        if not resp.tool_calls:
            return resp.content
        for tc in resp.tool_calls:
            result = call_tool(tc.function.name, json.loads(tc.function.arguments))
            messages.append({"role": "tool", "tool_call_id": tc.id, "content": result})
    return "max steps reached"

print(run("北京今天天气怎么样？"))
```

理解这 30 行，就理解了 Agent 的核心。后面所有章节都是在这之上加东西：

- §02：把 think 步骤设计成 ReAct / Plan / Reflection
- §03：把 messages 替换成"分层记忆"
- §04：把 TOOLS 设计得更聪明
- §06：起多个 Agent 互相调用
- §09：用框架替你写这 30 行（多个细节优化）

## 10. 下一步

- [02 · 经典范式](./02-paradigms.md) — ReAct / Plan-and-Solve / Reflection
- [03 · 认知架构](./03-cognitive-architecture.md) — 记忆怎么设计
- 想直接跑代码 → [`langgraph/02`](../langgraph/02-quickstart.md)
