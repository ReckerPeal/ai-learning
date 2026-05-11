# 09 · 统一评测与监控方案

> 6 个项目都需要评测 + 监控，但每个项目重写一套是反模式。这章给一份**跨项目复用**的评测 + 监控方案：trace 怎么打、metrics 怎么收、dashboard 怎么搭、CI 回归怎么跑。

## 1. 三层视角

| 层 | 关注 | 工具 | 节奏 |
| --- | --- | --- | --- |
| **Trace** | 单次执行明细 | LangSmith / LangFuse / Phoenix | 实时 |
| **Eval** | 数据集上跑批 | LangSmith Datasets / RAGAS / 自家 runner | CI + 每日 |
| **Monitor** | 线上聚合指标 | Prometheus + Grafana / SigNoz | 实时 + 告警 |

三者**互相支撑**：trace 提供原料 → eval 给出 golden 比对 → monitor 看趋势。

## 2. Trace：3 分钟接好

### 2.1 LangSmith（最快）

```python
# 环境变量即可，不用改代码
import os
os.environ["LANGSMITH_TRACING"] = "true"
os.environ["LANGSMITH_API_KEY"] = "..."
os.environ["LANGSMITH_PROJECT"] = "travel-assistant-prod"
# LangChain / LangGraph 自动上传
```

### 2.2 LangFuse（自托管推荐）

```python
from langfuse.callback import CallbackHandler

handler = CallbackHandler(
    public_key="pk_...",
    secret_key="sk_...",
    host="http://langfuse:3000",
)
result = graph.invoke(state, config={"callbacks": [handler]})
```

### 2.3 自定义 span（关键节点必加）

```python
from langfuse.decorators import observe

@observe(name="search_flights", as_type="tool")
def search_flights(...):
    ...
```

### 2.4 必须脱敏

```python
# 入 trace 前过滤
def redact(text: str) -> str:
    text = re.sub(r"1[3-9]\d{9}", "[PHONE]", text)
    text = re.sub(r"\d{17}[\dXx]", "[ID]", text)
    return text
```

参考 [`../langchain/10-observability-and-production.md`](../langchain/10-observability-and-production.md)。

## 3. 标准化 Trace Schema

跨项目统一以下字段，方便做横向 dashboard：

| 字段 | 类型 | 来源 |
| --- | --- | --- |
| `trace_id` | str | 自动 |
| `project` | str | env |
| `tenant_id` | str | state |
| `user_id` | str（hash） | state，必脱敏 |
| `session_id` | str | state |
| `intent` / `task_type` | str | classifier |
| `node_name` | str | graph 节点名 |
| `model` | str | LLM call |
| `prompt_tokens` / `completion_tokens` | int | usage |
| `cost_usd` | float | 自算或 provider |
| `latency_ms` | int | timer |
| `tool_name` | str | tool span |
| `tool_status` | "ok"/"fail"/"retry" | tool 自报 |
| `hitl_step` | bool | 是否触发 HITL |
| `red_flag` | str? | 安全 hook 命中（pii / acl / forbidden） |

## 4. Eval：评测 runner 模板

### 4.1 通用 runner

```python
# eval/run.py
import json, asyncio, datetime
from src.graph.graph import build_graph
from eval.metrics import METRIC_REGISTRY

async def run_one(item, graph):
    final = await graph.ainvoke({"user_input": item["input"], **item.get("ctx", {})})
    scores = {}
    for m_id, m in METRIC_REGISTRY.items():
        scores[m_id] = m(item, final)
    return {"id": item["id"], "scores": scores, "final": final}

async def main(dataset_path):
    data = json.load(open(dataset_path))
    graph = build_graph()
    sem = asyncio.Semaphore(8)
    async def gated(it):
        async with sem:
            return await run_one(it, graph)
    results = await asyncio.gather(*(gated(it) for it in data))
    _write_report(results)
    _push_to_langsmith(results)

if __name__ == "__main__":
    asyncio.run(main("eval/data/golden.json"))
```

### 4.2 metric 注册器

```python
# eval/metrics.py
METRIC_REGISTRY = {}

def metric(name):
    def deco(fn):
        METRIC_REGISTRY[name] = fn
        return fn
    return deco

@metric("plan_validity")
def _plan_valid(item, final):
    try:
        validate(final["plan"], item["plan_schema"])
        return 1.0
    except Exception:
        return 0.0

@metric("citation_url_ok")
def _url_ok(item, final):
    if not final.get("citations"): return 0.0
    ok = sum(1 for c in final["citations"] if _head_200(c["url"]))
    return ok / len(final["citations"])
```

### 4.3 LLM-as-Judge 抽样

参考 [`../eval/04-llm-as-judge.md`](../eval/04-llm-as-judge.md)。建议：

- 主指标走自动判定
- 抽样 10–20% 走 LLM judge（节省成本 + 校准）
- 月度跑 1 次"人工 vs LLM judge"对齐，防 judge 漂移

## 5. CI 回归

### 5.1 GitHub Action 模板

```yaml
# .github/workflows/eval.yml
name: Eval Regression
on:
  pull_request:
    paths: ["src/**", "eval/data/**", "src/prompts/**"]
  schedule:
    - cron: "0 18 * * *"   # 每日

jobs:
  eval:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install -e .[eval]
      - run: python -m eval.run --dataset eval/data/golden.json
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          LANGSMITH_API_KEY: ${{ secrets.LANGSMITH_API_KEY }}
      - run: python -m eval.gate --config eval/config.yaml
        # 任何 fail_under 不达标则 CI 失败
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: eval-report, path: eval/out/ }
```

参考 [`../eval/09-ci-and-regression.md`](../eval/09-ci-and-regression.md)。

### 5.2 Gate 策略

| 模式 | 触发 | 行为 |
| --- | --- | --- |
| **Hard gate** | red flag（ACL leak / forbidden SQL） | CI fail，不可合 |
| **Soft gate** | 主指标下降 > 3pp | CI warn，要求 reviewer 批准 |
| **Trend gate** | 7 日均值持续下降 | 周会议报告 |
| **Cost gate** | 单次任务 token > 上次 +30% | warn |

## 6. 监控：Grafana / SigNoz 看板

### 6.1 必备图表（每个项目都要）

| 图表 | 数据源 | 用途 |
| --- | --- | --- |
| QPS（按 intent/tenant） | trace count | 流量观察 |
| 中位 / p95 延迟 | trace latency_ms | 用户体验 |
| 模型成本（按 tenant / 项目） | sum(cost_usd) | 预算 |
| 任务完成率 | success span / total | 业务北极星 |
| Tool 错误率（按 tool） | tool_status='fail' | 找慢/坏工具 |
| HITL 触发率 | hitl_step=true | 是否过度依赖人工 |
| Red flag 计数 | red_flag != null | 安全告警 |
| 评测主指标趋势 | eval runner 推送 | 模型质量漂移 |

### 6.2 告警阈值（起步可调）

| 告警 | 条件 | 紧急度 |
| --- | --- | --- |
| ACL/PII leak | red_flag count > 0 | P0：停服 |
| p95 延迟 > 2× baseline 持续 5 min | 慢 | P1 |
| 任务完成率 < 70% 持续 30 min | 业务事故 | P1 |
| 成本 > 日预算 80% | 烧钱 | P2 |
| 评测主指标周降 > 3pp | 模型漂移 | P2 |
| HITL 触发率 > 50% | 模型失效或路由错 | P2 |

### 6.3 OpenTelemetry + LangFuse 桥接

```python
from opentelemetry.sdk.trace import TracerProvider
from langfuse.opentelemetry import LangfuseSpanExporter

provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(LangfuseSpanExporter()))
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))  # 同时给 SigNoz
```

> trace 一处生成、多处导出，避免 LangFuse 和 APM 各打一遍。

## 7. 数据闭环：从线上回流到评测集

```
线上 trace
  │
  ├─ 抽样（按 intent 分层 + 高错误率优先）
  ▼
人工 / LLM judge 打标
  │
  ▼
golden 数据集 v_n+1（加入边角案例）
  │
  ▼
CI 回归 → 新版本上线 → 回到顶端
```

每周 / 双周走一次，**线上 distribution shift** 才能被及时反映到评测里。

参考 [`../eval/08-online-and-ab.md`](../eval/08-online-and-ab.md)。

## 8. 项目间差异：把通用框架做出**最小适配层**

各项目继承同一份 `BaseProject`：

```python
# eval/base.py
class BaseProject:
    project_name: str
    dataset_path: str
    schema_path: str
    metric_ids: list[str]      # 用注册器 id
    hard_gate_metrics: list[str]
    soft_gate_thresholds: dict[str, float]
    cost_budget_usd: float

    def build_graph(self): ...
    def normalize_state(self, item): ...
```

具体项目实现 `build_graph` + 数据集路径，其余复用。

## 9. 评测配置（YAML 大全）

```yaml
# 通用 eval/config.template.yaml
project: travel-assistant
dataset: eval/data/golden.json
runners:
  parallel: 8
  retries: 1
  timeout_s: 60
metrics:
  - id: completion_rate
    type: llm_as_judge
    sample_rate: 0.2
    prompt_id: trip_judge_v1
  - id: plan_validity
    type: schema_check
  - id: tool_error_rate
    type: trace_aggregate
  - id: cost_p95
    type: trace_aggregate
hard_gate:
  - metric: red_flag_count
    op: "=="
    value: 0
soft_gate:
  - metric: completion_rate
    fail_under: 0.80
    warn_under: 0.85
  - metric: cost_p95
    fail_above: 0.30
output:
  langsmith_project: travel-assistant-eval
  artifact_dir: eval/out
```

## 10. 落地路径

| 周次 | 任务 |
| --- | --- |
| 第 1 周 | 接 trace（LangSmith 或 LangFuse）、加 30 条 golden、跑通 eval runner |
| 第 2 周 | 加 CI（PR 触发 + 每日跑）、加 2 张 Grafana 图（QPS + 主指标） |
| 第 3 周 | 加 hard/soft gate、加 alert（红线指标） |
| 第 4 周 | 接线上回流（抽样标注）、第一份评测 baseline 报告给团队 |
| 持续 | 每周 review，月度跑 judge 校准 |

## 常见坑

1. **trace 不全**：只接了 LLM call，没接工具 / DB / HTTP → debug 失败原因找不到。
2. **trace 含 PII**：每个项目都踩过 → 入口加 redact hook，单测覆盖。
3. **eval 集太干净**：全是 happy path，上线一周被脏数据打回原形 → 专门加 20% 脏样本。
4. **judge 用同模型自评**：gpt-4o 评 gpt-4o，分数偏高 → judge 用不同模型 + 校准。
5. **CI 跑太慢**：每次 PR 跑 200 条全集 → 分层：PR 跑 30 条快集 + nightly 跑全集。
6. **dashboard 看不出问题**：图太多眼花 → 只放 6 张核心图，其余进二级 dashboard。
7. **alert 风暴**：一个事故触发 20 条告警 → 分级 + 合并（同一 incident 30 min 内只发 1 次）。
8. **没成本看板**：月底发现烧光预算 → 第一天就装 cost dashboard。
9. **online metric 与 eval metric 不一致**：线上看 latency_p95，eval 不看 → 字段对齐。
10. **没回流路径**：3 个月后评测集还是上线第一天的版本 → 强制每月加 10 条新边角。

## 下一步

- 上线 checklist：[§10](./10-launch-checklist.md)
- Eval 主题完整覆盖：[`../eval/`](../eval/)
- RAG 评测细节：[`../rag-advanced/09-evaluation.md`](../rag-advanced/09-evaluation.md)
- 在线 A/B：[`../eval/08-online-and-ab.md`](../eval/08-online-and-ab.md)
- CI 回归：[`../eval/09-ci-and-regression.md`](../eval/09-ci-and-regression.md)
- Agent 评测方法：[`../eval/07-agent-eval.md`](../eval/07-agent-eval.md)
