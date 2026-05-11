# 08 · 多步任务：电商下单、信息收集、复杂表单

> 单步动作好做，**几十步的端到端任务**才是 Browser Agent 真正的价值地带。这一章讲怎么把短动作组合成长任务——任务分解、状态机、记忆、并行、跨域跳转——并用三个真实例子（电商下单、竞品调研、跨域报销）走完。

## 1. 长任务为什么难

| 难点 | 单步 Agent | 长任务 |
| ---- | ---------- | ------ |
| 失败概率累积 | 1 步 90% = 总 90% | 30 步 90% = 总 4.2% |
| 上下文累积 | 一两屏截图 | 几十屏 + 几百动作 |
| 跨页面状态 | 无 | 登录、购物车、tab 切换 |
| 错误诊断 | 局部 | "几步前做错了" |
| 评测 | 单步对错 | 端到端成功率 + 步数效率 |

30 步任务要稳定到 70% 通过率，平均**单步必须 ≥ 99%**——这是工程目标。

## 2. 任务分解：plan-execute 模式

经典两层：

```
Planner（思考型 LLM）
  ├─ 把"在 Amazon 买一双 9 码红色 Nike 跑鞋"分解为：
  │   1. 打开 amazon.com
  │   2. 搜索 "Nike running shoes red size 9"
  │   3. 筛选 size=9 / color=red
  │   4. 选第一个评分 ≥4.5 的
  │   5. 加购
  │   6. 去 checkout
  │   7. 确认地址 + 支付（HITL）
  └─►
Executor（动作型 LLM + 浏览器）
  对每一步执行短闭环，失败回 Planner 调整
```

参见 [`../agents/05-planning.md`](../agents/05-planning.md)。Browser Agent 推荐**轻量 planner**——计划不要太死，留给 executor 调整空间。

## 3. 状态机：用 LangGraph 编排

把"页面状态 → 节点"建模：

```python
from langgraph.graph import StateGraph, END
from typing import TypedDict

class BrowserState(TypedDict):
    task: str
    plan: list[str]
    step_idx: int
    history: list[dict]
    last_observation: str
    error: str | None

graph = StateGraph(BrowserState)

async def plan_node(state):
    plan = await llm_plan(state["task"])
    return {"plan": plan, "step_idx": 0}

async def execute_node(state):
    step = state["plan"][state["step_idx"]]
    result = await execute_one_step(step, page)
    return {
        "history": state["history"] + [result],
        "step_idx": state["step_idx"] + 1,
        "last_observation": result["observation"],
        "error": result.get("error"),
    }

def route(state):
    if state["error"]:
        return "recover"
    if state["step_idx"] >= len(state["plan"]):
        return END
    return "execute"

graph.add_node("plan", plan_node)
graph.add_node("execute", execute_node)
graph.add_node("recover", recover_node)
graph.set_entry_point("plan")
graph.add_edge("plan", "execute")
graph.add_conditional_edges("execute", route)
graph.add_edge("recover", "execute")
```

参考 [`../langgraph/`](../langgraph/)。状态机让"几步前出错可以回退"和"长链路可观测"都自然。

## 4. 记忆：什么要记、记多久

| 信息 | 短期（当前任务） | 长期（跨任务） |
| ---- | --------------- | -------------- |
| 当前 URL / DOM 摘要 | ✓ | ✗ |
| 历史动作 | 全保留 | ✗ |
| 历史截图 | 仅最近 1-3 张 | ✗ |
| 用户偏好（喜欢的品牌） | ✓ | ✓ |
| "登录到某站需要 2FA"等知识 | ✗ | ✓ |
| Selector 缓存 | ✓ | ✓（同站） |

历史截图压缩策略：

```python
def compress_history(history: list[dict], max_screenshots: int = 3) -> list:
    """超出 N 张截图后，把旧的换成文字摘要。"""
    screenshots_kept = 0
    compressed = []
    for item in reversed(history):
        if item.get("screenshot"):
            if screenshots_kept < max_screenshots:
                compressed.append(item)
                screenshots_kept += 1
            else:
                compressed.append({**item, "screenshot": None,
                                   "screenshot_summary": item.get("observation", "")})
        else:
            compressed.append(item)
    return list(reversed(compressed))
```

## 5. 案例一：电商下单（30 步）

任务："在 amazon.com 搜 'Nike Pegasus 41 size 9 red'，选第一个评分≥4.5 的，加入购物车后停在 checkout 页面（不要付款）。"

```python
# 简化的 plan
PLAN = [
    "goto amazon.com",
    "搜索 'Nike Pegasus 41 size 9 red'",
    "在搜索结果中筛选 size=9",
    "在结果中找第一个评分≥4.5 的商品并点击",
    "在商品页面选 color=red, size=9",
    "点击 Add to Cart",
    "处理可能出现的加购弹窗（'Proceed to checkout' / 'Continue shopping'）",
    "点 Cart",
    "点 Proceed to checkout",
    "stop（HITL，等用户确认是否要支付）",
]

async def execute_one(step: str, page, history) -> dict:
    """每步一次小循环：snapshot → LLM → action → verify。"""
    for attempt in range(3):
        snap = await build_snapshot(page)  # set-of-mark
        action = await llm_decide_action(step, snap, history)
        if action["type"] == "skip":  # LLM 判定本步骤已完成
            return {"step": step, "ok": True, "skipped": True}
        result = await dispatch_action(page, action)
        await settle(page)
        # 验证：屏幕状态变化 + LLM 检查"这步达成了吗"
        post = await summarize_state(page)
        ok = await llm_verify_step(step, action, post)
        if ok:
            return {"step": step, "ok": True, "action": action}
        # 不 OK 就重试，把失败信息加入 history
        history.append({"step": step, "attempt": attempt, "failed_action": action})
    return {"step": step, "ok": False, "error": "exhausted_retries"}
```

**关键设计点**：

- 每步 ≤3 次尝试，超过升级到 recover 节点
- 步骤之间**没必要**重新 plan——除非 recover 发生
- 最后一步 `stop` 触发 HITL，**任何涉及钱的步骤强制人工**——见 [10](./10-safety-compliance.md)

实测（虚构数字代表合理量级）：

| 系统 | 任务成功率 | 平均步数 | 平均成本 |
| ---- | ---------- | -------- | -------- |
| Browser Use + GPT-4o | 65% | 22 | \$0.40 |
| Computer Use + Sonnet 4.5 | 75% | 28 | \$1.20 |
| Manus | ~75% | 黑盒 | 按任务计费 |
| 人类 | 95% | 12 | — |

## 6. 案例二：竞品调研（信息收集，60+ 步）

任务："调研 Notion / Coda / Craft 三家产品的定价、协作功能、AI 功能，出对比表。"

这种任务的难点不是动作复杂，而是：

- **信息分散**——每家产品官网 + 定价页 + 帮助文档
- **抽取需要判断**——同一概念叫法不一样（"协作" vs "团队空间"）
- **结果结构化**——最后要出 markdown 表格

设计：

```python
TARGETS = ["notion.so", "coda.io", "craft.do"]
ASPECTS = ["pricing", "collaboration", "ai_features"]

results = {}
for site in TARGETS:
    results[site] = {}
    await page.goto(f"https://{site}")
    for aspect in ASPECTS:
        sub_task = f"在 {site} 上找到 {aspect} 相关的信息，返回结构化 JSON"
        sub_result = await run_sub_agent(page, sub_task)
        results[site][aspect] = sub_result

table = await llm_render_comparison_table(results)
```

**子 Agent 模式**：每个 (site, aspect) 是一个独立子任务，子 Agent 关闭后**只把结构化结果带回主 Agent**——避免主 Agent 上下文累积百屏截图。参考 [`../agents/06-multi-agent.md`](../agents/06-multi-agent.md)。

## 7. 案例三：跨域跳转（OAuth + 报销）

任务："登录公司 Concur 报销系统（用 Google SSO），新建一笔差旅报销，附件已在 /tmp/receipt.pdf。"

复杂在于：

1. concur.com → 点 "Sign in with Google" → 弹新 tab 到 accounts.google.com
2. 输入邮箱 → next → 输入密码 → next → 2FA 等用户 → SSO 回跳 concur
3. 进入 dashboard → 找 "Create Report" → 填表 → 上传 receipt → submit

跨域跳转的关键：

```python
# 监听新 page
async with context.expect_page() as page_info:
    await page.click("text=Sign in with Google")
google_page = await page_info.value
await google_page.wait_for_load_state()

# 在新 page 上操作
await google_page.fill('input[type=email]', user_email)
await google_page.click('text=Next')

# 2FA 走 HITL
await interrupt_for_human({
    "task": "请在手机完成 2FA 确认",
    "watch_url_change": True,
})

# Google → Concur 重定向后，可能 google_page 自动关闭
# 回到原 page 等 URL 变为 concur.com 主页
await page.wait_for_url("**concur.com/home**", timeout=60_000)
```

**经验**：

- 2FA 必须 HITL——任何 Agent 都不该绕 2FA
- 跨域时**保留两个 page 引用**——OAuth 可能在新 tab 完成后关闭
- 关键 URL 变化作为同步信号比"等待元素"靠谱

## 8. 长任务的成本与时延

成本分布（假设 Sonnet 4.5，Vision+set-of-mark）：

| 任务复杂度 | 步数 | 时长 | 成本 |
| ---------- | ---- | ---- | ---- |
| 简单（登录 + 查一项数据） | 5-10 | 30-90s | \$0.10-0.30 |
| 中等（电商下单） | 20-30 | 2-5 min | \$0.50-1.50 |
| 复杂（竞品调研、跨多站点） | 60-150 | 10-30 min | \$2-8 |
| 极端（端到端工作流） | 200+ | 30 min+ | \$10+ |

**优化点**：

- 每步压上下文（§4 的 compress_history）
- DOM 摘要替代截图（[04](./04-accessibility-path.md)）
- 复用 LLM 调用（同步骤多次失败先在 LLM 端"换思路"，而不是重抓页面）
- 子 Agent 隔离（§6）

## 9. 评测：怎么量化"长任务成功率"

WebArena / Mind2Web 的评测设计可借鉴：

| 维度 | 指标 |
| ---- | ---- |
| 完成度 | 0-100%（基于关键节点） |
| 端到端成功 | 完全完成 = 1，否则 0 |
| 步数效率 | 实际步数 / 最优步数 |
| 平均单步成本 | $ / 步 |
| 关键错误率 | 失败 ÷ 总任务（按错误类型分桶：CAPTCHA / 登录 / 找不到元素 / 卡死） |

实践中再加：

- **HITL 介入次数**——多 = Agent 弱
- **副作用**（多创建了草稿、点了多余按钮）

详细评测方法见 [`../eval/07-agent-eval.md`](../eval/07-agent-eval.md)。

## 常见坑

- **plan 写太死**——把 30 步全列在 plan 里，中间一步出错全乱套。计划应分层（高层 5-8 步，每个高层步骤里 executor 自由发挥）。
- **历史不压缩**——50 步以后 context 爆，模型决策质量断崖。每 ≥5 步合并旧历史成摘要。
- **不监听新 page**——OAuth、支付链路 90% 在新 tab，没监听就"卡住等永远不会出现的按钮"。
- **不存 storage_state**——每次任务都走完整登录 + 2FA，HITL 介入太多。第一次登录后 dump，后续 restore。
- **失败重试无变化**——同样的 action 试 3 次都失败还重试，浪费。**变招规则**：第 2 次换 selector、第 3 次换 grounding 模式。

## 下一步

- [09 · 错误恢复](./09-error-recovery.md) — 长任务中各种"卡住"的诊断与恢复。
- [10 · 安全与合规](./10-safety-compliance.md) — 长任务里 HITL 的设计与限速。
- [`../langgraph/`](../langgraph/) — 状态机编排细节。
- [`../agents/05-planning.md`](../agents/05-planning.md) — 规划模式。
- [`../agents/06-multi-agent.md`](../agents/06-multi-agent.md) — 子 Agent 隔离。
- [`../eval/07-agent-eval.md`](../eval/07-agent-eval.md) — Agent 评测。
