# 02 · 项目1：智能旅行助手

> **第一站选旅行助手**，因为它把 Agent 的四大要素一次性逼出来：多工具协作（机票/酒店/景点）、规划（多天行程）、HITL（下单前确认）、记忆（用户偏好）。规模刚刚好——不会像"全能助手"那样发散，也不会像"单工具问答"那样平庸。

## 1. 业务背景与目标

| 维度 | 内容 |
| --- | --- |
| **业务价值** | 旅行规划师人均 30 分钟产出一份行程草稿；Agent 5 分钟产出 + 用户微调 |
| **用户** | C 端用户、OTA（携程/Booking）客服 |
| **输入** | 自然语言："5 天日本东京+大阪，2 大人 1 小孩，预算 2 万，要亲子向" |
| **输出** | 结构化行程单 JSON + 自然语言摘要 + 可下单链接 |
| **失败成本** | 错下单 = 退款 + 用户流失，**下单前必须 HITL** |
| **关键 SLA** | 首份 plan ≤ 8s，端到端含 HITL 中位数 5 min |

**前 3 风险**：

1. 工具返回不存在的航班 → schema 校验 + 二次确认
2. 长行程超出预算 → plan 阶段就带预算约束 prompt
3. HITL 用户不操作 → 30 min 自动暂停 + 邮件提醒

## 2. 架构图

```
                  ┌──────────────┐
                  │ User Input   │
                  └──────┬───────┘
                         ▼
                  ┌──────────────┐
                  │ Intent Parse │  ◀─ 解析日期/城市/预算/偏好
                  └──────┬───────┘
                         ▼
                  ┌──────────────┐
                  │ Plan         │  ◀─ Plan-and-Execute（[../agents/05-planning.md](../agents/05-planning.md)）
                  └──────┬───────┘
                         ▼
                  ┌──────────────┐
                  │ HITL #1      │  ◀─ 用户确认 plan 框架
                  │  approve?    │
                  └──────┬───────┘
                         ▼ approved
              ┌──────────┴──────────┐
              ▼          ▼          ▼
       ┌──────────┐┌──────────┐┌──────────┐
       │ Flight   ││ Hotel    ││ POI      │
       │ Search   ││ Search   ││ Suggest  │  并发
       └────┬─────┘└────┬─────┘└────┬─────┘
            └──────┬────┴───────────┘
                   ▼
            ┌──────────────┐
            │ Compose      │  ◀─ 拼装行程单
            └──────┬───────┘
                   ▼
            ┌──────────────┐
            │ HITL #2      │  ◀─ 下单前确认（金额/航班号）
            └──────┬───────┘
                   ▼ confirmed
            ┌──────────────┐
            │ Book / Email │
            └──────────────┘
```

## 3. 关键模块

### 3.1 目录结构

```
travel-assistant/
├── src/
│   ├── graph/
│   │   ├── state.py          # TripState
│   │   ├── nodes/
│   │   │   ├── intent.py
│   │   │   ├── planner.py
│   │   │   ├── searcher.py   # flight/hotel/poi 并发
│   │   │   ├── composer.py
│   │   │   ├── hitl.py
│   │   │   └── booker.py
│   │   └── graph.py
│   ├── tools/
│   │   ├── flight.py         # 走 Amadeus / 自家航班 API
│   │   ├── hotel.py
│   │   └── poi.py            # 高德/Google Places
│   ├── memory/
│   │   └── profile.py        # 用户偏好长时记忆
│   └── api/
│       └── routes.py         # FastAPI
└── tests/eval/data/trips.json
```

### 3.2 工具集

| 工具 | 输入 | 输出 | 备注 |
| --- | --- | --- | --- |
| `search_flights` | origin, dest, date, pax | List[Flight] | 支持往返、中转 |
| `search_hotels` | city, checkin, checkout, pax, budget | List[Hotel] | 按价格 / 评分排序 |
| `suggest_pois` | city, themes, days | List[POI] | 亲子 / 美食 / 文化 |
| `compute_route` | List[POI], date | DailyRoute | 调用地图 API |
| `currency_convert` | amount, from, to | float | 缓存 1h |
| `send_email` | to, subject, body | bool | 用户确认链接 |

工具设计参考 [`../agents/04-tool-use.md`](../agents/04-tool-use.md) 和 [`../langchain/06-tools-and-function-calling.md`](../langchain/06-tools-and-function-calling.md)。

### 3.3 HITL 节点位置

| 节点 | 在哪 | 为什么 |
| --- | --- | --- |
| HITL #1 | Plan 之后、并发搜索之前 | 改 plan 比改结果便宜（搜索耗钱） |
| HITL #2 | Compose 之后、下单之前 | 钱要花了，必须用户拍板 |

实现走 LangGraph `interrupt_before`，见 [`../langgraph/07-human-in-the-loop.md`](../langgraph/07-human-in-the-loop.md)。

## 4. 关键代码片段

### 4.1 状态定义

```python
# src/graph/state.py
from typing import Annotated, TypedDict, Literal
from langgraph.graph.message import add_messages
from langchain_core.messages import AnyMessage

class Flight(TypedDict):
    flight_no: str
    dep_time: str
    price: float

class TripState(TypedDict):
    user_input: str
    user_id: str
    # 解析后的意图
    cities: list[str]
    dates: tuple[str, str]
    pax: dict          # {"adult": 2, "child": 1}
    budget: float
    themes: list[str]  # ["亲子", "美食"]
    # 规划
    plan: list[dict]   # [{"day": 1, "city": "Tokyo", "activities": [...]}, ...]
    plan_approved: bool
    # 并发搜索结果
    flights: list[Flight]
    hotels: list[dict]
    pois: list[dict]
    # 最终行程
    itinerary: dict | None
    booking_confirmed: bool
    # 通用
    messages: Annotated[list[AnyMessage], add_messages]
    cost_usd: float
```

### 4.2 LangGraph 节点定义（核心节点）

```python
# src/graph/nodes/planner.py
import json
from langchain_openai import ChatOpenAI
from src.graph.state import TripState

PLANNER = ChatOpenAI(model="gpt-4o", temperature=0)

PLAN_PROMPT = """你是旅行规划师。基于以下信息生成一份按日划分的行程框架（只给主题，不给具体航班/酒店）。

约束：
- 总预算 {budget} 元
- 行程 {days} 天，城市 {cities}
- 偏好：{themes}
- 不要超出预算，不要排过密

输出 JSON：[{{"day": 1, "city": "Tokyo", "theme": "...", "activities": ["..."]}}]
"""

def plan_node(state: TripState) -> dict:
    days = (
        _date_diff(state["dates"][0], state["dates"][1])
    )
    prompt = PLAN_PROMPT.format(
        budget=state["budget"],
        days=days,
        cities=", ".join(state["cities"]),
        themes=", ".join(state["themes"]),
    )
    resp = PLANNER.invoke(prompt)
    plan = json.loads(resp.content)
    return {"plan": plan, "plan_approved": False}


# src/graph/nodes/searcher.py
import asyncio
from src.tools.flight import search_flights
from src.tools.hotel import search_hotels
from src.tools.poi import suggest_pois

async def search_node(state: TripState) -> dict:
    """三类工具并发。"""
    flights_t = search_flights(
        origin="PEK",
        dest=state["cities"][0],
        date=state["dates"][0],
        pax=state["pax"],
    )
    hotels_t = search_hotels(
        cities=state["cities"],
        checkin=state["dates"][0],
        checkout=state["dates"][1],
        pax=state["pax"],
        budget=state["budget"] * 0.4,  # 酒店上限 40% 预算
    )
    pois_t = suggest_pois(
        cities=state["cities"],
        themes=state["themes"],
        days=len(state["plan"]),
    )
    flights, hotels, pois = await asyncio.gather(flights_t, hotels_t, pois_t)
    return {"flights": flights, "hotels": hotels, "pois": pois}


# src/graph/nodes/hitl.py
from langgraph.types import interrupt

def hitl_plan(state: TripState) -> dict:
    """interrupt 暂停图，等用户回包。"""
    decision = interrupt({
        "type": "plan_review",
        "plan": state["plan"],
        "message": "请确认这份行程框架是否需要调整",
    })
    return {"plan_approved": decision["approved"], "plan": decision.get("revised_plan", state["plan"])}
```

### 4.3 图编排

```python
# src/graph/graph.py
from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.postgres import PostgresSaver
from src.graph.state import TripState
from src.graph.nodes import (
    intent_node, plan_node, hitl_plan, search_node,
    compose_node, hitl_book, book_node,
)

def build_graph(checkpointer: PostgresSaver):
    g = StateGraph(TripState)
    g.add_node("intent", intent_node)
    g.add_node("plan", plan_node)
    g.add_node("hitl_plan", hitl_plan)
    g.add_node("search", search_node)
    g.add_node("compose", compose_node)
    g.add_node("hitl_book", hitl_book)
    g.add_node("book", book_node)

    g.add_edge(START, "intent")
    g.add_edge("intent", "plan")
    g.add_edge("plan", "hitl_plan")
    # 条件边：用户改 plan 则回 plan，否则前进
    g.add_conditional_edges(
        "hitl_plan",
        lambda s: "search" if s["plan_approved"] else "plan",
    )
    g.add_edge("search", "compose")
    g.add_edge("compose", "hitl_book")
    g.add_conditional_edges(
        "hitl_book",
        lambda s: "book" if s["booking_confirmed"] else END,
    )
    g.add_edge("book", END)

    return g.compile(
        checkpointer=checkpointer,
        interrupt_before=["hitl_plan", "hitl_book"],
    )
```

### 4.4 评测配置（YAML）

```yaml
# tests/eval/config.yaml
dataset: tests/eval/data/trips.json
metrics:
  - id: completion_rate
    type: llm_as_judge
    prompt_id: trip_judge_v1
  - id: plan_validity
    type: schema_check
    schema: schemas/itinerary.json
  - id: budget_adherence
    type: code
    func: tests.eval.checks.budget_ok
  - id: tool_call_count
    type: trace_aggregate
runners:
  parallel: 8
  retries: 1
ci:
  fail_under:
    completion_rate: 0.80
    plan_validity: 0.95
    budget_adherence: 0.90
```

## 5. 评测设计

### 5.1 数据集（30 条起步）

| 类别 | 数量 | 例子 |
| --- | --- | --- |
| Easy（单城市 + 短期） | 10 | "周末上海 2 天，1 万预算" |
| Medium（多城市 + 偏好） | 10 | "5 天日本东京+大阪，亲子" |
| Hard（多约束 + 改 plan） | 5 | "10 天欧洲 3 国，老人，无走路，预算 5 万" |
| Adversarial（脏输入） | 5 | "明天出发去火星" / SQL 注入式 prompt |

### 5.2 指标

| 指标 | 通过线 | 测量方法 |
| --- | --- | --- |
| Plan JSON 合规率 | ≥ 95% | JSON schema 校验 |
| 预算遵守率 | ≥ 90% | 总价 ≤ budget × 1.05 |
| 工具调用错误率 | ≤ 5% | trace 检查 status |
| HITL 节点通过率 | ≥ 80% | 模拟"approve" 跑全流程 |
| 端到端任务完成率 | ≥ 80% | LLM-as-judge |
| 中位 token 消耗 | ≤ 8k | LangSmith usage |

### 5.3 与 τ-bench 对照

τ-bench 提供了 airline 子集，可以直接套用工具调用准确率指标作为参考基线，参考 [`../eval/07-agent-eval.md`](../eval/07-agent-eval.md)。

## 6. 上线考虑

### 6.1 容量与成本

| 指标 | 目标 |
| --- | --- |
| QPS | 10（PoC） → 100（GA） |
| 每 session 成本 | ≤ $0.20 |
| HITL 等待 | 30 min 超时 → 自动暂停 |

降本手段：

- Plan 用 gpt-4o，搜索 / 摘要用 gpt-4o-mini
- Hotel/POI 工具结果缓存 1h（同城市 + 同日期）
- 历史用户偏好走长时记忆，prompt 少塞 30%

### 6.2 安全

- 工具白名单（不允许通用 `requests`）
- 用户 ID 强制注入，搜索结果按用户隔离
- 下单走 idempotency key，避免重复扣款

参考 [`../llm-security/06-tool-safety.md`](../llm-security/06-tool-safety.md)。

### 6.3 监控

- LangSmith 全链路 trace
- Grafana 看板：QPS、p95 延迟、HITL 等待时长、错误率
- 告警：连续 5 min plan_validity < 90% → on-call

详见 [§09](./09-eval-monitoring.md)。

## 7. Trade-off 讨论：ReAct vs Plan-and-Execute

| 维度 | ReAct | Plan-and-Execute（选） |
| --- | --- | --- |
| 步数 | 不可控 | 一次出 plan，可控 |
| 错误恢复 | 边走边纠 | replan 节点 |
| 长任务漂移 | 容易（>6 步）| 不容易 |
| HITL 难度 | 难（要在循环中断）| 容易（plan 之后） |
| 首 token 延迟 | 低 | 中（plan 需要先生成）|
| 适合复杂度 | 简单 | 中–复杂 |

旅行助手属于"中复杂度多步任务 + 强 HITL 需求"，Plan-Execute 完胜。
但对话式微调（"再便宜点的"）走轻量 ReAct 子图——这是混合架构。

## 常见坑

1. **Plan 长度爆炸**：用户说"环球旅行"，plan 输出 40 天 → 截断到 14 天 + 提示"长行程请分阶段规划"。
2. **航班价格漂移**：搜索完到下单中间航班涨价 → 下单前重新调用一次 `search_flights` 比对。
3. **POI 重复**：同一景点出现两天 → 在 compose 节点做去重 + 时间冲突检查。
4. **多币种混淆**：日元数字 × 元单价 → 强制工具返回带 currency 字段 + compose 时统一换算。
5. **HITL 永远不回包**：30 min 超时关闭 + 邮件通知用户后续可点链接恢复（用 `session_id` 走 checkpointer 恢复）。
6. **trace 里漏 PII**：用户姓名 / 电话被 LangSmith 记录 → 在工具入口做脱敏 hook。

## 下一步

- 下一个项目：[§03 深度调研](./03-deep-research.md)（也是 Plan-Execute，但任务更长、无 HITL）
- 复习规划：[`../agents/05-planning.md`](../agents/05-planning.md)
- HITL 实现细节：[`../langgraph/07-human-in-the-loop.md`](../langgraph/07-human-in-the-loop.md)
- 工具安全：[`../llm-security/06-tool-safety.md`](../llm-security/06-tool-safety.md)
- 项目对比：[§08 横向对比](./08-comparison.md)
