# 01 · 项目方法论

> **"我想做一个 Agent" 不是需求**——是愿望。把愿望翻译成可被工程化交付的项目，需要一套节奏。本章给一份**PDCA + 架构决策记录 (ADR) + 风险矩阵** 的最小模板，后续 6 个项目章节都按这个节奏走。

## 1. PDCA：Agent 项目的最小循环

Agent 项目比传统软件迭代更快、不确定性更大，建议把 PDCA（Plan-Do-Check-Act）循环周期压到**1 周以内**。

```
┌────────────────────────────────────────────────────────┐
│   ┌─────────┐    ┌─────────┐    ┌──────────┐          │
│   │ Plan    │───▶│ Do      │───▶│ Check    │──┐       │
│   │ 需求拆解 │    │ 实现 PoC │    │ 跑评测   │   │       │
│   └─────────┘    └─────────┘    └──────────┘   │       │
│        ▲                                       │       │
│        │           ┌──────────┐                │       │
│        └───────────│ Act       │◀──────────────┘       │
│                    │ 决策 / 迭代│                       │
│                    └──────────┘                        │
└────────────────────────────────────────────────────────┘
```

### 1.1 Plan：需求拆解的四个问题

每个项目开工前，写下来回答四个问题（写在 ADR-0001 里）：

| 问题 | 关键判断 |
| --- | --- |
| **业务价值** | 这个 Agent 替代 / 增强了哪个具体岗位的什么动作？省了多少分钟？ |
| **输入边界** | 用户能输入什么、不能输入什么？输入越收敛，PoC 越好做 |
| **输出形态** | 文本 / 表格 / 代码 / 图 / 工单？输出格式决定下游对接和评测方式 |
| **失败可接受度** | 错一次是损失 1 元、1 万元，还是声誉？决定要不要 HITL、要不要灰度 |

举个例子（对应 [§02 旅行助手](./02-travel-assistant.md)）：

> 价值：替代旅行规划师 30 分钟的行程草拟 → 5 分钟生成 + 用户微调；
> 输入：自然语言行程意向（日期 + 城市 + 偏好）；
> 输出：可下单的 JSON 行程单（航班+酒店+景点）；
> 失败：错下单 = 退款 + 用户流失，因此**下单前必须 HITL 确认**。

### 1.2 Do：先骨架后细节

| 优先级 | 任务 |
| --- | --- |
| P0 | 跑通"端到端 happy path"——哪怕 hardcode 一半工具 |
| P0 | 把 trace 接好（LangSmith / LangFuse），不然 debug 是黑盒 |
| P1 | 真实工具替换 mock |
| P1 | 评测集 ≥ 30 条 |
| P2 | UI / 监控 |
| P3 | 多租户、配额、计费 |

### 1.3 Check：评测先于优化

**没有评测就改 prompt 是反模式**。最早期就要搭起最小评测集：

- 30 条真实样本（10 简单 + 10 中等 + 10 复杂）
- 至少 1 个**自动指标**（任务完成率 / 工具调用准确率）
- 至少 1 个**主观指标**（用户满意度 / 评审员打分）

详见 [`../eval/07-agent-eval.md`](../eval/07-agent-eval.md)。

### 1.4 Act：决策与回滚

每次 Check 后，回到 Plan，做出**一个**决策（不要一次改 5 件事）：

1. 模型换档（Haiku → Sonnet）？
2. 架构换型（ReAct → Plan-Execute）？
3. 工具拆分 / 合并？
4. HITL 节点位置调整？
5. 重要：**这一轮不动**——给评测稳定一轮的时间。

## 2. 架构决策记录 (ADR)

每个项目维护一个 `docs/adr/` 目录，每个决策一份 markdown。模板：

```markdown
# ADR-0003: 行程规划采用 Plan-and-Execute 而非 ReAct

- 状态：已采纳（2026-04-12）
- 决策者：@zhangzhongbao
- 相关：ADR-0001 业务背景、ADR-0002 工具集

## 背景
用户输入"5 天日本行"会触发约 12 个工具调用（航班×2、酒店×5、景点×N）。
ReAct 单步循环在 6+ 步后开始"漂移"——重复查同一航班、忘记预算约束。

## 选项
A. ReAct（[../agents/02-paradigms.md](../agents/02-paradigms.md) §1）
B. Plan-and-Execute（[../agents/05-planning.md](../agents/05-planning.md) §3）
C. 静态 DAG（按"日期 → 航班 → 酒店 → 景点"硬编排）

## 决策
选 B。
- 长度可控（plan 一次性给出 10–15 步）
- 单步失败不影响 plan
- 可在 plan 后 HITL 一次让用户改

## 影响
- LangGraph 节点：plan、execute、replan、hitl
- Prompt：plan 阶段必须输出 JSON schema，execute 拒绝重新规划
- 代价：plan 节点首 token 延迟 +2s（可流式补救）
```

每章项目都会引用 1–2 个关键 ADR。

## 3. 风险矩阵

一开工就要识别风险，按"概率 × 影响" 排序：

| 风险类别 | 典型表现 | 缓解手段 |
| --- | --- | --- |
| **幻觉** | 推荐不存在的航班 | 工具强制返回 + 输出 schema 校验 |
| **死循环** | ReAct 反复调用同一工具 | step 上限、重复检测、超时 |
| **越权** | 客服 Agent 读到别家租户工单 | row-level filter + 入参注入 user_id |
| **Prompt 注入** | 用户在评论里"忽略上文" | 输入过滤 + 工具权限白名单（[../llm-security/02-prompt-injection.md](../llm-security/02-prompt-injection.md)） |
| **成本爆炸** | Plan 重生成 20 次 | replan 上限 + 成本预算 |
| **延迟不可控** | 工具串行慢 | 并发 + 缓存 + Haiku 降档 |
| **数据泄漏** | trace 里有 PII | 脱敏 hook + LangFuse 项目隔离 |
| **下游事故** | 错下单 | HITL 强制确认 + idempotency key |

每个项目章节都会列出"该项目的前 3 风险"。

## 4. 通用项目骨架

后续 6 个项目章节共享同一份目录结构：

```
project-name/
├── README.md
├── pyproject.toml
├── .env.example                    # OPENAI_API_KEY / LANGSMITH_API_KEY 等
├── docs/
│   ├── adr/                        # 架构决策记录
│   └── architecture.md
├── src/
│   ├── graph/                      # LangGraph 节点 / 边 / 状态
│   │   ├── state.py
│   │   ├── nodes.py
│   │   ├── edges.py
│   │   └── graph.py                # build_graph()
│   ├── tools/                      # @tool 装饰器封装
│   ├── prompts/                    # *.j2 模板
│   ├── memory/                     # 长短时记忆
│   ├── retrievers/                 # RAG / SQL
│   └── api/                        # FastAPI 路由
├── tests/
│   ├── eval/                       # 评测数据集 + runner
│   ├── unit/
│   └── integration/
├── ops/
│   ├── docker-compose.yml          # Postgres + Redis + Qdrant
│   ├── Dockerfile
│   └── grafana/                    # dashboard json
└── notebooks/                      # 探索用 Jupyter
```

## 5. 关键代码片段：项目骨架

### 5.1 LangGraph 状态定义模板

```python
# src/graph/state.py
from typing import Annotated, TypedDict
from langgraph.graph.message import add_messages
from langchain_core.messages import AnyMessage

class ProjectState(TypedDict):
    # 用户输入
    user_input: str
    user_id: str
    session_id: str

    # 对话历史（reducer 累加）
    messages: Annotated[list[AnyMessage], add_messages]

    # 规划与执行
    plan: list[str]
    step_index: int
    tool_results: list[dict]

    # HITL
    awaiting_human: bool
    human_decision: str | None

    # 成本与遥测
    total_tokens: int
    cost_usd: float
    trace_id: str

    # 输出
    final_output: dict | None
```

### 5.2 节点签名约定

```python
# src/graph/nodes.py
from src.graph.state import ProjectState
from langchain_openai import ChatOpenAI

LLM = ChatOpenAI(model="gpt-4o-mini", temperature=0)

def plan_node(state: ProjectState) -> dict:
    """每个节点返回 dict（部分 state），由 reducer 合并。"""
    response = LLM.invoke(_plan_prompt(state["user_input"]))
    plan = _parse_plan(response.content)
    return {"plan": plan, "step_index": 0}

def execute_node(state: ProjectState) -> dict:
    step = state["plan"][state["step_index"]]
    result = _dispatch_tool(step)
    return {
        "tool_results": state["tool_results"] + [result],
        "step_index": state["step_index"] + 1,
    }
```

### 5.3 评测 runner 模板

```python
# tests/eval/runner.py
import json
from src.graph.graph import build_graph

DATASET = json.load(open("tests/eval/data/golden.json"))

def run_eval():
    graph = build_graph()
    results = []
    for item in DATASET:
        final = graph.invoke({
            "user_input": item["input"],
            "user_id": "eval-user",
            "session_id": item["id"],
            "messages": [],
        })
        results.append({
            "id": item["id"],
            "expected": item["expected"],
            "actual": final["final_output"],
            "pass": _judge(item["expected"], final["final_output"]),
        })
    pass_rate = sum(r["pass"] for r in results) / len(results)
    print(f"pass_rate = {pass_rate:.2%}")
    return results
```

详见 [`../eval/05-frameworks.md`](../eval/05-frameworks.md) 和 [`../eval/09-ci-and-regression.md`](../eval/09-ci-and-regression.md)。

## 6. 评测设计：通用指标

| 指标 | 含义 | 如何采集 |
| --- | --- | --- |
| **任务完成率** | 端到端成功比例 | LLM-as-judge 或人工 |
| **工具调用准确率** | 正确工具 + 正确参数 | trace 与 golden 对照 |
| **步骤数** | 完成任务调用工具次数 | trace 聚合 |
| **token / 成本** | 每任务平均 | provider usage |
| **首 token 延迟** | 用户感知首屏速度 | 客户端打点 |
| **HITL 触发率** | 多少比例需要人介入 | 节点计数 |
| **重试率** | replan / retry 次数 | trace |

详见 [§09 统一评测与监控](./09-eval-monitoring.md)。

## 7. 上线考虑：通用 4 项

1. **配额与计费**：每用户 / 每租户每天上限，超过转人工或限速
2. **降级路径**：模型不可用 → 走规则；工具超时 → 给"我无法完成"的话术
3. **审计日志**：每次 Agent 决策落库，便于复盘（特别是金融 / 客服）
4. **灰度**：feature flag + 5% → 25% → 100% 三档

完整 checklist 见 [§10](./10-launch-checklist.md)。

## 常见坑

1. **没写 ADR**：3 个月后回看 commit 不知道当时为什么选 Plan-Execute → 决策无法复盘 → 跑偏。
2. **PoC 跳过 trace**：第一版觉得"我自己 print 一下就行"，第三周加 trace 时要重写一半节点。
3. **评测集太小或太干净**：30 条全是 happy path，上线被边角输入打爆。**专门加 20% 脏样本**。
4. **一次改 5 件事**：模型 / 架构 / prompt / 工具一起换，没法归因。**单变量改动**。
5. **HITL 位置随手选**：HITL 在最后一步用户已经累了，确认率掉到 30%。**在决策叉口而非动作前**。
6. **没设成本预算**：一周烧光 API 额度。**每 session 设 cost cap**。
7. **追求多 Agent**：单 agent 还没跑通就上 supervisor，调试地狱。**单 agent first**。
8. **不区分"开发评测"和"上线监控"**：评测集只跑 staging，线上没采样回流 → 真实 distribution shift 看不到。

## 下一步

- 选一个项目开做：§02–§07 任意一章
- 复盘理论：[`../agents/05-planning.md`](../agents/05-planning.md)（Plan-Execute）、[`../agents/04-tool-use.md`](../agents/04-tool-use.md)（工具设计）
- 评测先行：[`../eval/07-agent-eval.md`](../eval/07-agent-eval.md)
- 监控落地：[§09](./09-eval-monitoring.md)
