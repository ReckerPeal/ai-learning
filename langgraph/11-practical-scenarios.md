# 11 · 实战练习：从工作流到多 Agent 系统

> 本章不是 API 复述，而是 5 个能落地的 LangGraph 练习。每个案例都给出业务场景、覆盖知识点、图结构、实现任务、测试清单和进阶挑战。建议按顺序做：前一个案例的 state、router、测试手法会在后一个案例复用。

## 1. 练习总览

这 5 个案例覆盖 LangGraph 从入门到生产化的主干能力：

| 案例 | 场景 | 核心能力 | 难度 |
|---|---|---|---|
| 1 | 客服意图路由工作流 | `StateGraph`、条件边、结构化路由、图级测试 | 入门 |
| 2 | 订单售后工具 Agent | `ToolNode`、ReAct 循环、工具错误处理、stub tool 测试 | 初级 |
| 3 | 合同条款审核与人工审批 | `interrupt`、`Command(resume=...)`、checkpoint、人机协作测试 | 中级 |
| 4 | 批量资料研究助手 | `Send` 动态分发、并行 map-reduce、reducer、流式观察 | 中高级 |
| 5 | 多 Agent 内容生产流水线 | 子图、supervisor、worker agent、端到端验收、回归评测 | 高级 |

推荐练习方式：

1. 先用纯规则 / fake LLM 跑通图结构。
2. 再把 fake LLM 换成真实模型。
3. 最后补测试，不要只看一次 demo 输出。

> 测试优先级：router / reducer 单测 > graph invoke 测试 > interrupt / stream / 子图验收测试。

## 2. 通用工程骨架

建议把练习代码放在一个独立目录，便于从文档迁移成真实项目：

```text
langgraph_practice/
├── graphs/
│   ├── support_router.py
│   ├── aftersales_agent.py
│   ├── contract_review.py
│   ├── research_map_reduce.py
│   └── content_pipeline.py
└── tests/
    ├── test_support_router.py
    ├── test_aftersales_agent.py
    ├── test_contract_review.py
    ├── test_research_map_reduce.py
    └── test_content_pipeline.py
```

依赖：

```bash
pip install -U langgraph langchain-core langchain-openai pytest
```

测试原则：

| 测试对象 | 推荐做法 | 不推荐 |
|---|---|---|
| LLM 决策 | fake model / fake structured output | 单测里真实请求模型 |
| 工具调用 | stub tool + 固定返回 | 调真实支付、邮件、数据库 |
| 图路径 | 检查最终 state 与关键中间 update | 只肉眼看 print |
| 中断恢复 | `MemorySaver` + 固定 `thread_id` | 每次 resume 用新线程 |
| 并行聚合 | 检查 reducer 合并结果 | 依赖返回顺序稳定 |

## 3. 案例 1：客服意图路由工作流

### 3.1 业务场景

用户进线后，系统需要把问题分给不同处理链路：

| 意图 | 示例 | 处理节点 |
|---|---|---|
| `refund` | "我要退款" | 退款政策解释 |
| `logistics` | "快递到哪了" | 物流查询 |
| `invoice` | "帮我开票" | 发票流程 |
| `other` | "你们几点下班" | 通用答复 |

这个案例不需要工具和 Agent，重点是把**条件边**练扎实。

### 3.2 覆盖知识点

- `TypedDict` state schema
- 节点返回 partial state
- `add_conditional_edges`
- router 函数返回稳定枚举
- fake classifier 测试图路径

### 3.3 图结构

```text
START → classify → route
                    ├─ refund    → refund_handler    → END
                    ├─ logistics → logistics_handler → END
                    ├─ invoice   → invoice_handler   → END
                    └─ other     → general_handler   → END
```

### 3.4 实现任务

1. 定义 state：

```python
from typing import Literal, TypedDict


Intent = Literal["refund", "logistics", "invoice", "other"]


class SupportState(TypedDict):
    user_text: str
    intent: Intent
    answer: str
    confidence: float
```

2. 实现 `classify` 节点。初版用规则即可：

```python
def classify(state: SupportState) -> dict:
    text = state["user_text"]
    if "退款" in text or "退货" in text:
        return {"intent": "refund", "confidence": 0.9}
    if "快递" in text or "物流" in text:
        return {"intent": "logistics", "confidence": 0.85}
    if "发票" in text or "开票" in text:
        return {"intent": "invoice", "confidence": 0.88}
    return {"intent": "other", "confidence": 0.6}
```

3. 实现 router：

```python
def route_by_intent(state: SupportState) -> Intent:
    return state["intent"]
```

4. 每个 handler 只负责一个意图，不在 handler 里重新判断意图。

### 3.5 测试练习

`tests/test_support_router.py`：

```python
import pytest

from langgraph_practice.graphs.support_router import build_graph


@pytest.mark.parametrize(
    ("text", "expected_intent", "expected_keyword"),
    [
        ("我昨天买的耳机想退款", "refund", "退款"),
        ("帮我查一下快递到哪了", "logistics", "物流"),
        ("这笔订单可以开发票吗", "invoice", "发票"),
        ("你们周末上班吗", "other", "客服"),
    ],
)
def test_support_router_routes_to_expected_handler(text, expected_intent, expected_keyword):
    app = build_graph()

    result = app.invoke({
        "user_text": text,
        "intent": "other",
        "answer": "",
        "confidence": 0.0,
    })

    assert result["intent"] == expected_intent
    assert expected_keyword in result["answer"]
    assert result["confidence"] > 0
```

补充测试：

| 测试名 | 断言 |
|---|---|
| `test_unknown_intent_falls_back_to_other` | 模糊输入进入 `other` |
| `test_router_returns_known_literal` | router 只返回 4 个合法枚举 |
| `test_handler_does_not_mutate_intent` | handler 不覆盖 `intent` |

### 3.6 常见坑

| 现象 | 原因 |
|---|---|
| 图走到错误节点 | classifier 输出和 conditional mapping 的 key 不一致 |
| handler 里又写一堆 if | 路由责任没收敛，后面难测 |
| 测试偶发失败 | 单测直接调真实 LLM 分类 |

## 4. 案例 2：订单售后工具 Agent

### 4.1 业务场景

客服 Agent 能处理订单售后：

- 查询订单状态
- 判断是否可退款
- 创建售后工单
- 工具失败时给用户可执行的下一步

这是标准 ReAct 练习，但要刻意练**工具设计与错误恢复**，不要只做一个天气查询 demo。

### 4.2 覆盖知识点

- `messages: Annotated[list[BaseMessage], add_messages]`
- `bind_tools`
- `ToolNode`
- agent → tools → agent 循环
- 工具异常转成可恢复消息
- fake model 驱动 tool call 测试

### 4.3 图结构

```text
START → agent ── has tool_calls ──► tools
          ▲                         │
          └──────── after tools ◄────┘
          └── no tool_calls ───────► END
```

### 4.4 工具清单

| 工具 | 参数 | 返回 | 设计要点 |
|---|---|---|---|
| `get_order(order_id)` | `order_id: str` | 订单状态 JSON | 只读，适合自动调用 |
| `check_refund_policy(order_id)` | `order_id: str` | 是否可退 + 原因 | 规则解释要给 LLM |
| `create_refund_ticket(order_id, reason)` | 订单号 + 原因 | 工单号 | 有副作用，真实系统应接审批 |

工具错误要对 LLM 友好：

```python
@tool
def get_order(order_id: str) -> str:
    """查询订单状态。order_id 必须是形如 ORD-1001 的订单号。"""
    if not order_id.startswith("ORD-"):
        return "Error: order_id 格式错误，必须类似 ORD-1001。请向用户确认订单号。"
    fake_db = {
        "ORD-1001": {"status": "delivered", "paid": True, "days_since_delivery": 3},
        "ORD-1002": {"status": "shipping", "paid": True, "days_since_delivery": 0},
    }
    return str(fake_db.get(order_id, {"status": "not_found"}))
```

### 4.5 实现任务

1. 手写 ReAct 图，不直接用 `create_react_agent`。
2. `agent_node` 只负责调用模型。
3. `ToolNode` 只负责执行工具。
4. `should_continue` 只看最后一条 AIMessage 是否有 `tool_calls`。
5. 加一个 `max_steps` 或使用 `recursion_limit` 防止死循环。

核心 router：

```python
from langgraph.graph import END


def should_continue(state: AgentState) -> str:
    last = state["messages"][-1]
    return "tools" if getattr(last, "tool_calls", None) else END
```

### 4.6 测试练习

测试不要依赖真实模型。用 fake model 固定输出两轮：

1. 第一轮返回 `AIMessage(tool_calls=[...])`
2. 工具执行后，第二轮返回最终答复

```python
from langchain_core.messages import AIMessage, HumanMessage


class FakeRefundModel:
    def __init__(self):
        self.calls = 0

    def bind_tools(self, tools):
        return self

    def invoke(self, messages):
        self.calls += 1
        if self.calls == 1:
            return AIMessage(
                content="",
                tool_calls=[{
                    "name": "get_order",
                    "args": {"order_id": "ORD-1001"},
                    "id": "call-1",
                }],
            )
        return AIMessage(content="订单 ORD-1001 已签收，可以继续申请售后。")
```

测试用例：

```python
def test_agent_calls_order_tool_then_answers():
    app = build_graph(model=FakeRefundModel(), tools=[get_order])

    result = app.invoke({
        "messages": [HumanMessage(content="帮我查 ORD-1001 能不能退款")]
    })

    contents = [m.content for m in result["messages"]]
    assert any("ORD-1001" in c for c in contents)
    assert "可以继续申请售后" in result["messages"][-1].content
```

补充测试：

| 测试名 | 断言 |
|---|---|
| `test_invalid_order_id_returns_recoverable_error` | 工具返回 `Error:`，图不崩 |
| `test_no_tool_call_ends_immediately` | 无 tool call 时直接 END |
| `test_multiple_tool_calls_are_all_executed` | `ToolNode` 执行多个 tool call |
| `test_recursion_limit_prevents_infinite_loop` | fake model 一直调工具时能被限制 |

### 4.7 进阶挑战

- 把 `create_refund_ticket` 前置到案例 3 的人工审批节点。
- 给工具结果加 `source` 字段，区分订单系统、售后系统、人工输入。
- 对工具异常做分类：用户输入错、系统暂时不可用、权限不足。

## 5. 案例 3：合同条款审核与人工审批

### 5.1 业务场景

法务助手读取合同条款，标出风险项，生成修改建议。若风险分数超过阈值，必须暂停给人工审批；人工可以：

- 通过
- 驳回
- 修改建议后继续

这是生产系统里非常常见的模式：LLM 可以草拟，但关键动作必须有人确认。

### 5.2 覆盖知识点

- `interrupt()` 动态中断
- `Command(resume=...)` 恢复
- `MemorySaver` checkpoint
- `thread_id` 作为恢复游标
- 中断节点的幂等性
- 审批分支测试

### 5.3 图结构

```text
START → extract_clauses → risk_score → needs_review?
                                      ├─ no  → finalize → END
                                      └─ yes → human_review → apply_decision → END
```

`human_review` 内部调用 `interrupt()`，把合同摘要、风险项和建议暴露给外部 UI。

### 5.4 State 设计

```python
from typing import Literal, TypedDict


Decision = Literal["approved", "rejected", "edited"]


class ContractState(TypedDict):
    contract_text: str
    clauses: list[str]
    risks: list[dict]
    risk_score: float
    draft_suggestion: str
    human_decision: Decision | None
    final_suggestion: str
    status: str
```

### 5.5 实现任务

审批节点示意：

```python
from langgraph.types import interrupt


def human_review(state: ContractState) -> dict:
    decision = interrupt({
        "question": "请审核高风险合同修改建议",
        "risk_score": state["risk_score"],
        "risks": state["risks"],
        "draft_suggestion": state["draft_suggestion"],
    })

    if decision["action"] == "approve":
        return {
            "human_decision": "approved",
            "final_suggestion": state["draft_suggestion"],
        }
    if decision["action"] == "edit":
        return {
            "human_decision": "edited",
            "final_suggestion": decision["final_suggestion"],
        }
    return {"human_decision": "rejected", "status": "rejected"}
```

编译时必须带 checkpointer：

```python
from langgraph.checkpoint.memory import MemorySaver


app = graph.compile(checkpointer=MemorySaver())
```

运行和恢复：

```python
from langgraph.types import Command


config = {"configurable": {"thread_id": "contract-001"}}
paused = app.invoke(initial_state, config=config)
print(paused["__interrupt__"])

resumed = app.invoke(
    Command(resume={
        "action": "edit",
        "final_suggestion": "将违约金上限改为合同总额的 10%。",
    }),
    config=config,
)
```

### 5.6 测试练习

```python
from langgraph.types import Command


def test_high_risk_contract_interrupts_for_review():
    app = build_graph()
    config = {"configurable": {"thread_id": "test-contract-1"}}

    result = app.invoke(high_risk_state(), config=config)

    assert "__interrupt__" in result
    payload = result["__interrupt__"][0].value
    assert payload["risk_score"] >= 0.7
    assert "draft_suggestion" in payload


def test_resume_with_edit_updates_final_suggestion():
    app = build_graph()
    config = {"configurable": {"thread_id": "test-contract-2"}}

    app.invoke(high_risk_state(), config=config)
    final = app.invoke(
        Command(resume={
            "action": "edit",
            "final_suggestion": "补充数据处理边界与违约责任上限。",
        }),
        config=config,
    )

    assert final["human_decision"] == "edited"
    assert final["final_suggestion"] == "补充数据处理边界与违约责任上限。"
    assert final["status"] == "completed"
```

补充测试：

| 测试名 | 断言 |
|---|---|
| `test_low_risk_contract_skips_interrupt` | 低风险不出现 `__interrupt__` |
| `test_resume_must_use_same_thread_id` | 换 `thread_id` 无法恢复原中断 |
| `test_reject_sets_status_rejected` | 驳回后不进入完成状态 |
| `test_pre_interrupt_side_effects_are_idempotent` | 中断前重复执行不会重复写外部系统 |

### 5.7 常见坑

| 现象 | 原因 |
|---|---|
| resume 后节点前半段又执行了一次 | `interrupt` 恢复时会从节点开头重跑，前置副作用必须幂等 |
| `interrupt` 没有冒泡到调用方 | 把 `interrupt()` 包在宽泛 `try/except` 里 |
| 恢复失败 | 没有 checkpointer，或 resume 时用了不同 `thread_id` |

## 6. 案例 4：批量资料研究助手

### 6.1 业务场景

输入一个研究主题和一批资料 URL / 文档片段，系统需要：

1. 为每份资料抽取关键事实。
2. 并行处理多份资料。
3. 聚合成一份研究简报。
4. 输出每条结论的来源。

这是 LangGraph 里最值得练的 workflow 场景：动态 fan-out + reducer + 汇总。

### 6.2 覆盖知识点

- `Send` 动态分发
- map-reduce 图结构
- `Annotated[..., operator.add]` 聚合结果
- 并行节点测试
- `stream_mode="updates"` 观察中间步骤

### 6.3 图结构

```text
START → plan_sources → dispatch
                         ├─ Send("extract_one", source A)
                         ├─ Send("extract_one", source B)
                         └─ Send("extract_one", source C)
                                      ↓
                               reduce_brief → END
```

### 6.4 State 设计

```python
from typing import Annotated, TypedDict
import operator


class OverallState(TypedDict):
    topic: str
    sources: list[dict]
    extracted_facts: Annotated[list[dict], operator.add]
    brief: str


class SourceState(TypedDict):
    topic: str
    source: dict
```

`extract_one` 接收的是每个 `Send` 提供的局部 state，但返回会被合并回 `OverallState`：

```python
def dispatch_sources(state: OverallState):
    return [
        Send("extract_one", {"topic": state["topic"], "source": source})
        for source in state["sources"]
    ]
```

### 6.5 实现任务

1. `plan_sources` 校验 sources 非空，并给每份资料补 `source_id`。
2. `dispatch_sources` 返回 `list[Send]`。
3. `extract_one` 返回 `{"extracted_facts": [fact]}`。
4. `reduce_brief` 基于 `extracted_facts` 输出简报。
5. 不要依赖 `extracted_facts` 的顺序，聚合时按 `source_id` 排序。

### 6.6 测试练习

```python
def test_map_reduce_extracts_one_fact_per_source():
    app = build_graph(extractor=fake_extractor)

    result = app.invoke({
        "topic": "LangGraph 在客服系统中的应用",
        "sources": [
            {"source_id": "s1", "text": "LangGraph supports durable execution."},
            {"source_id": "s2", "text": "Human review can pause a graph."},
        ],
        "extracted_facts": [],
        "brief": "",
    })

    assert len(result["extracted_facts"]) == 2
    assert {f["source_id"] for f in result["extracted_facts"]} == {"s1", "s2"}
    assert "来源" in result["brief"]
```

流式测试：

```python
def test_stream_updates_exposes_extract_steps():
    app = build_graph(extractor=fake_extractor)

    updates = list(app.stream(sample_state(), stream_mode="updates"))

    assert any("extract_one" in chunk for chunk in updates)
    assert any("reduce_brief" in chunk for chunk in updates)
```

补充测试：

| 测试名 | 断言 |
|---|---|
| `test_empty_sources_returns_clear_error` | 空资料返回明确错误或进入 fallback |
| `test_reducer_appends_not_overwrites` | 多个 `extract_one` 的结果都保留 |
| `test_reduce_sorts_sources_for_stable_output` | 输出顺序稳定，方便 snapshot 测试 |
| `test_one_source_failure_does_not_drop_all_results` | 单个资料失败时仍聚合其他资料 |

### 6.7 进阶挑战

- 给 `Send` 增加单个 source 的 timeout 策略。
- 让 `extract_one` 同时输出 `confidence`，低置信度事实进入人工复核队列。
- 给 `brief` 做 snapshot 测试，防止提示词改动导致格式漂移。

## 7. 案例 5：多 Agent 内容生产流水线

### 7.1 业务场景

构建一个内容生产系统：输入选题，系统依次或动态调度多个 Agent：

| Agent | 职责 | 输入 | 输出 |
|---|---|---|---|
| `researcher` | 找事实和引用 | topic | research_notes |
| `outliner` | 生成大纲 | topic + notes | outline |
| `writer` | 写初稿 | outline + notes | draft |
| `reviewer` | 质检与修改意见 | draft + rubric | review |
| `editor` | 产出终稿 | draft + review | final_article |

这个案例不是为了堆 Agent 数量，而是练**子图边界、调度策略和验收测试**。

### 7.2 覆盖知识点

- worker 子图封装
- parent graph 调度
- supervisor 路由
- 子图 state 转换
- `subgraphs=True` 流式调试
- 端到端测试与评测 rubrics

### 7.3 推荐图结构

先做固定流水线，再升级 supervisor：

```text
START → researcher → outliner → writer → reviewer → quality_gate
                                                      ├─ pass → editor → END
                                                      └─ fail → writer
```

升级版：

```text
START → supervisor
          ├─ researcher ─┐
          ├─ outliner   ─┤
          ├─ writer     ─┤→ supervisor → END
          ├─ reviewer   ─┤
          └─ editor     ─┘
```

### 7.4 State 设计

```python
from typing import Annotated, Literal, TypedDict
import operator


NextAgent = Literal["researcher", "outliner", "writer", "reviewer", "editor", "FINISH"]


class ContentState(TypedDict):
    topic: str
    research_notes: Annotated[list[dict], operator.add]
    outline: str
    draft: str
    review: dict
    final_article: str
    revision_count: int
    next: NextAgent
```

### 7.5 Worker 子图边界

推荐每个 worker 内部有自己的私有 state，父图通过 wrapper 转换：

```python
def call_researcher(state: ContentState) -> dict:
    sub_input = {"topic": state["topic"], "max_sources": 5}
    sub_output = researcher_app.invoke(sub_input)
    return {"research_notes": sub_output["notes"]}
```

这样做的好处：

| 做法 | 优点 | 代价 |
|---|---|---|
| 共享父图 state | 写起来快 | worker 容易乱改全局字段 |
| wrapper 转换 state | 边界清晰、好测 | 多写一层适配 |

### 7.6 质量门

`reviewer` 输出结构化评审：

```python
class Review(TypedDict):
    score: float
    issues: list[str]
    required_changes: list[str]
```

路由规则：

```python
def quality_gate(state: ContentState) -> str:
    if state["review"]["score"] >= 0.8:
        return "editor"
    if state["revision_count"] >= 2:
        return "editor"  # 避免无限返工
    return "writer"
```

### 7.7 测试练习

固定流水线测试：

```python
def test_content_pipeline_reaches_final_article():
    app = build_graph(workers=fake_workers())

    result = app.invoke({
        "topic": "如何在企业内落地 LangGraph",
        "research_notes": [],
        "outline": "",
        "draft": "",
        "review": {"score": 0, "issues": [], "required_changes": []},
        "final_article": "",
        "revision_count": 0,
        "next": "researcher",
    })

    assert result["final_article"]
    assert result["review"]["score"] >= 0.8
```

返工测试：

```python
def test_low_quality_draft_loops_back_to_writer_once():
    workers = fake_workers(first_review_score=0.5, second_review_score=0.85)
    app = build_graph(workers=workers)

    result = app.invoke(initial_content_state())

    assert result["revision_count"] == 1
    assert result["review"]["score"] == 0.85
    assert result["final_article"]
```

supervisor 测试：

```python
def test_supervisor_stops_when_next_is_finish():
    app = build_supervisor_graph(supervisor=fake_supervisor(["researcher", "writer", "FINISH"]))

    result = app.invoke(initial_content_state())

    assert result["next"] == "FINISH"
```

补充测试：

| 测试名 | 断言 |
|---|---|
| `test_worker_wrapper_returns_only_allowed_fields` | worker 不污染父图 state |
| `test_revision_limit_prevents_infinite_loop` | 低分多次后强制进入 editor |
| `test_subgraph_stream_contains_worker_namespace` | `subgraphs=True` 能看到子图 update |
| `test_final_article_contains_sources` | 终稿保留来源引用 |
| `test_regression_rubric_snapshot` | 评审 JSON 字段稳定 |

### 7.8 进阶挑战

- researcher 内部复用案例 4 的 map-reduce 子图。
- editor 前接案例 3 的人工审核，中断高风险发布。
- 将每个 worker 的输入输出记录到 LangSmith，用于比较不同提示词版本。

## 8. 全套测试 Checklist

做完 5 个案例后，至少应该有下面这些测试。

### 8.1 单元测试

| 模块 | 必测项 |
|---|---|
| router | 每个分支都能到达，未知输入有 fallback |
| reducer | 并行写入不会覆盖结果 |
| tools | 参数校验、错误消息、空结果 |
| quality gate | 分数阈值、返工上限 |
| wrapper | 子图输出只映射允许字段 |

### 8.2 图级测试

| 场景 | 必测项 |
|---|---|
| 正常路径 | `invoke` 返回完整最终 state |
| 错误路径 | 工具失败、资料为空、低质量输出 |
| 循环路径 | 能退出，不死循环 |
| 中断路径 | 出现 `__interrupt__`，恢复后进入正确分支 |
| 并行路径 | 多个 `Send` 结果全部聚合 |

### 8.3 端到端验收

| 案例 | 验收输入 | 验收标准 |
|---|---|---|
| 客服路由 | 4 类用户问题 | 意图正确，答复包含对应业务词 |
| 售后 Agent | 退款咨询 + 订单号 | 至少调用一次订单工具，最终答复可执行 |
| 合同审核 | 高风险合同条款 | 中断给人工，resume 后产出终版建议 |
| 研究助手 | 3 份资料 | 输出含 3 条来源事实和一份简报 |
| 内容流水线 | 一个选题 | 产出含来源、结构、质量分的终稿 |

## 9. 评分 Rubric

用下面的标准给自己的练习打分：

| 维度 | 0 分 | 1 分 | 2 分 |
|---|---|---|---|
| 图结构 | 只能跑线性 demo | 有条件分支 | 有循环 / 并行 / 子图之一 |
| State 设计 | 字段混乱 | 字段可读 | 输入、过程、输出边界清晰 |
| 工具设计 | 工具过粗或过细 | 可用但错误弱 | 参数、错误、幂等性都清楚 |
| 测试 | 只手动运行 | 有少量单测 | 覆盖 router、graph、异常、验收 |
| 生产意识 | 无限制 | 有基本 fallback | 有审批、checkpoint、追踪、回归 |

建议目标：每个案例至少 7 分，总分 40 分以上再进入真实业务项目。

## 10. 下一步

- [03 · 状态与 Reducer](./03-state-and-reducers.md)：案例 4 的并行聚合需要先理解 reducer
- [04 · 控制流](./04-control-flow.md)：案例 1、4、5 的条件边和循环都来自这里
- [05 · 工具与 Agent](./05-tools-and-agents.md)：案例 2 的 ReAct 图和工具设计基础
- [06 · 持久化与 Checkpoint](./06-persistence.md)：案例 3 的中断恢复依赖 checkpoint
- [07 · 人机协作](./07-human-in-the-loop.md)：案例 3 的审批流深入
- [08 · 流式输出](./08-streaming.md)：案例 4、5 的调试体验会明显更好
- [09 · 子图与多 Agent 协作](./09-subgraphs.md)：案例 5 的核心前置知识

## 11. 参考资料

- [LangGraph overview](https://docs.langchain.com/oss/python/langgraph/overview)：定位、安装、持久化、流式、人机协作等核心能力
- [Workflows and agents](https://docs.langchain.com/oss/python/langgraph/workflows-agents)：routing、parallelization、orchestrator-worker、`Send` 与 Agent 模式
- [Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)：`interrupt()`、`Command(resume=...)`、checkpoint、`thread_id` 与中断规则
