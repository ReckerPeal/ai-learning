# 08 · 日志与 Trace

监控（§07）告诉你"出问题了"，**trace + 日志告诉你"问题在哪"**。LLM 应用 trace 比普通 web 难，因为：

- 一次请求里有多次 LLM 调用、多个工具调用、多个 graph 节点
- prompt / completion 文本本身就是"日志"——既要存又要脱敏
- LangChain / LangGraph 内部有自己的 trace（LangSmith），怎么和 OTel 协同

本章给出**结构化日志 + 多源 Trace 关联**的实操方案。

## 1. 日志 / Metrics / Trace 三件套的关系

| 维度 | Metrics | Logs | Traces |
|---|---|---|---|
| 形态 | 时间序列 | 事件流 | 调用树 |
| 检索 | PromQL | 关键字 / Loki LogQL | TraceID |
| 用途 | "多少 / 多快" | "发生了什么" | "为什么慢 / 错" |
| 高基数 | 不行（label 限） | 行（每条独立） | 行（每 trace 独立） |
| 成本 | 低 | 中 | 中–高（采样） |

LLM 场景三者必备，缺一不可。

## 2. 结构化日志：JSON 起步

```python
# app/logging_setup.py
import logging
import structlog
import sys

def setup_logging(level: str = "INFO"):
    timestamper = structlog.processors.TimeStamper(fmt="iso")

    pre_chain = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        timestamper,
    ]

    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=getattr(logging, level.upper()),
    )

    structlog.configure(
        processors=pre_chain + [
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(getattr(logging, level.upper())),
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )

log = structlog.get_logger()
```

使用：

```python
log.info("agent.start", thread_id=tid, user_id=user.id, model="gpt-4o-mini")
log.error("tool.failed", tool="search", error=str(e), exc_info=True)
```

输出：

```json
{
  "event": "agent.start",
  "thread_id": "t-abc123",
  "user_id": "u-42",
  "model": "gpt-4o-mini",
  "timestamp": "2026-05-11T10:30:00.123Z",
  "level": "info",
  "logger": "app.agent"
}
```

## 3. Context Variables：把 traceID 自动带上

```python
# app/middleware.py
import uuid
import structlog
from opentelemetry import trace

@api.middleware("http")
async def request_context(req, call_next):
    req_id = req.headers.get("x-request-id") or uuid.uuid4().hex
    span = trace.get_current_span()
    trace_id = format(span.get_span_context().trace_id, "032x") if span else None

    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(
        request_id=req_id,
        trace_id=trace_id,
        path=req.url.path,
        method=req.method,
        client_ip=req.client.host,
    )
    resp = await call_next(req)
    resp.headers["x-request-id"] = req_id
    if trace_id:
        resp.headers["x-trace-id"] = trace_id
    return resp
```

之后任何 `log.info(...)` 都自动带 `request_id` 和 `trace_id`，**这是 trace ⇄ logs 关联的关键**。

## 4. 集群侧日志采集

K8s 上**写 stdout 就行**，集群侧由 fluent-bit / vector / promtail 采集。最常见三套：

| 方案 | 后端 |
|---|---|
| **Loki + Promtail + Grafana** | OSS、便宜、Grafana 一体 |
| **ELK / OpenSearch** | 老牌，重 |
| **Datadog / Sumo Logic** | SaaS，贵但开箱 |

### 4.1 Loki + Promtail（最常见 OSS）

```yaml
# Helm values 片段
promtail:
  config:
    snippets:
      pipelineStages:
        - cri: {}                       # 解 K8s log 前缀
        - json:
            expressions:
              event: event
              level: level
              trace_id: trace_id
              thread_id: thread_id
        - labels:
            level:                       # 把 level 做成 label
              event:
```

Grafana 中 LogQL 查询：

```
{namespace="agent", app="agent-api"} | json | level="error" | trace_id="abc123..."
```

## 5. OpenTelemetry Trace：基础

```python
# app/otel_setup.py
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor

def setup_tracing(app, service_name="agent-api", environment="prod"):
    provider = TracerProvider(resource=Resource.create({
        "service.name": service_name,
        "deployment.environment": environment,
    }))
    provider.add_span_processor(BatchSpanProcessor(
        OTLPSpanExporter(endpoint="otel-collector:4317", insecure=True)
    ))
    trace.set_tracer_provider(provider)

    FastAPIInstrumentor.instrument_app(app)
    HTTPXClientInstrumentor().instrument()  # OpenAI SDK 用 httpx 时自动追踪
```

任意函数加自定义 span：

```python
tracer = trace.get_tracer("agent")

async def search_tool(query: str):
    with tracer.start_as_current_span("tool.search") as span:
        span.set_attribute("tool.query", query[:200])
        results = await do_search(query)
        span.set_attribute("tool.result_count", len(results))
        return results
```

## 6. LLM 调用打 trace（GenAI semantic conventions）

OTel 1.32+ 有 [GenAI semconv](https://opentelemetry.io/docs/specs/semconv/gen-ai/)，标准化 LLM trace 属性：

```python
async def chat_traced(messages):
    with tracer.start_as_current_span("openai.chat") as span:
        span.set_attribute("gen_ai.system", "openai")
        span.set_attribute("gen_ai.request.model", "gpt-4o-mini")
        span.set_attribute("gen_ai.request.temperature", 0.7)
        span.set_attribute("gen_ai.request.max_tokens", 1024)

        try:
            resp = await client.chat.completions.create(...)
            usage = resp.usage
            span.set_attribute("gen_ai.usage.input_tokens", usage.prompt_tokens)
            span.set_attribute("gen_ai.usage.output_tokens", usage.completion_tokens)
            span.set_attribute("gen_ai.response.id", resp.id)
            span.set_attribute("gen_ai.response.finish_reasons",
                               [c.finish_reason for c in resp.choices])
            return resp
        except Exception as e:
            span.record_exception(e)
            span.set_status(trace.Status(trace.StatusCode.ERROR))
            raise
```

`gen_ai.prompt` / `gen_ai.completion` 在 spec 中可选，**生产慎用**（PII / 成本）。改存独立的脱敏样本。

## 7. OpenLLMetry：自动插桩

不想手写每个 LLM 调用的 span，用 [traceloop/openllmetry](https://github.com/traceloop/openllmetry)：

```python
from traceloop.sdk import Traceloop

Traceloop.init(app_name="agent-api",
               api_endpoint="http://otel-collector:4318")
```

它自动 patch `openai`、`anthropic`、`langchain`、`langgraph`，按 GenAI semconv 出 span。零代码改动。

## 8. LangSmith：LangChain 生态默认 trace

```bash
export LANGCHAIN_TRACING_V2=true
export LANGCHAIN_API_KEY=ls__xxx
export LANGCHAIN_PROJECT=agent-prod
```

每个 `invoke` / `astream` 自动上报。Trace 内容：

- 整张 graph 的执行树
- 每个节点的输入输出
- 每个 LLM 的 prompt / completion / token / cost
- 工具调用入参出参
- 错误堆栈

LangSmith 强在**业务语义**——直接看到"用户问什么、agent 怎么走、为什么走错"。**Prometheus / OTel 看不出语义**。

### 8.1 LangSmith + OTel 同时跑

完全可以。LangChain 内部已经发到 LangSmith；同时 FastAPI 层的 OTel 自动追踪 HTTP / DB。两个 trace 用同一个 `request_id` 关联：

```python
@api.post("/chat")
async def chat(req: Request):
    req_id = req.headers.get("x-request-id", uuid.uuid4().hex)
    cfg = {
        "configurable": {"thread_id": tid},
        "metadata": {"request_id": req_id},     # LangSmith 上能搜
        "tags": [f"req:{req_id}"],
    }
    result = await graph.ainvoke(state, cfg)
```

## 9. Langfuse：OSS 替代 / 补充

[Langfuse](https://langfuse.com/) 是 LangSmith 的 OSS 替代，自托管友好：

```python
from langfuse import Langfuse
from langfuse.openai import openai      # patch 后的 client

# 自动 trace 所有 openai 调用
resp = openai.chat.completions.create(model="gpt-4o-mini", messages=[...])
```

或显式 trace：

```python
langfuse = Langfuse()
trace = langfuse.trace(name="agent-run", user_id="u-42", session_id=tid,
                       metadata={"request_id": req_id})

span = trace.span(name="retrieve")
docs = retrieve(query)
span.end(output={"doc_ids": [d.id for d in docs]})

gen = trace.generation(name="answer", model="gpt-4o-mini",
                       input=messages, output=resp.choices[0].message.content,
                       usage={"input": 230, "output": 87})
```

Langfuse vs LangSmith：

| 维度 | LangSmith | Langfuse |
|---|---|---|
| 代码闭源 | ✅ | ❌（OSS） |
| 自托管 | 企业版 | 默认支持 |
| LangChain 自动接入 | ✅ | 通过 callback handler |
| OpenAI/Anthropic 自动 | ✅ | ✅ |
| Prompt 管理 | ✅ | ✅ |
| Dataset / Eval | ✅ | ✅ |
| 价格 | Per-seat / per-trace | 免费 OSS / Cloud 付费 |

国内合规场景或不想 vendor lock-in，**推荐 Langfuse 自托管**。

## 10. Helicone：作为 gateway 顺便监控

[Helicone](https://helicone.ai/) 走 gateway 路径——把 OpenAI base URL 改成它，自动记录每次调用：

```python
client = OpenAI(
    base_url="https://oai.helicone.ai/v1",
    default_headers={
        "Helicone-Auth": f"Bearer {HELICONE_API_KEY}",
        "Helicone-User-Id": user.id,
        "Helicone-Property-Tenant": tenant,
        "Helicone-Cache-Enabled": "true",
    },
)
```

好处：

- 零代码改动（除 base_url）
- 自带 cache（同 prompt 直接返回）
- 自带限流 / 多 key 路由
- 仪表盘开箱

缺点：所有 LLM 请求多一跳，可能成为单点；自托管需要 ClickHouse。

## 11. 全链路 trace 关联示例

一次用户请求的 trace 实际穿过：

```
[OTel] HTTP request → FastAPI handler
        ↓
[OTel] /chat span (50ms)
        ↓
[LangSmith] graph.invoke 启动 root trace
        ↓
[OTel + LangSmith] llm.chat 节点 → openai 调用（5s, 230 input, 87 output, $0.0003）
        ↓
[OTel] tool.search span（800ms, 5 docs）
        ↓
[OTel + LangSmith] llm.chat 第二轮（4s）
        ↓
[OTel] checkpoint.put 写 postgres（30ms）
```

要把 OTel trace 和 LangSmith trace 关联起来，两边都加 `request_id` 标签即可，UI 互链。

## 12. 日志脱敏

LLM 日志最大风险是 PII / secret 进 logs：

```python
# app/redact.py
import re

PATTERNS = [
    (re.compile(r"\b\d{3}-\d{2}-\d{4}\b"), "[SSN]"),
    (re.compile(r"\b\d{16}\b"), "[CARD]"),
    (re.compile(r"\b[\w\.-]+@[\w\.-]+\.\w+\b"), "[EMAIL]"),
    (re.compile(r"sk-[a-zA-Z0-9]{20,}"), "[API_KEY]"),
    (re.compile(r"Bearer\s+[\w\-\.]+"), "Bearer [TOKEN]"),
]

def redact(text: str) -> str:
    for pat, repl in PATTERNS:
        text = pat.sub(repl, text)
    return text
```

加 structlog processor：

```python
def redact_event(_, __, event):
    for k in ("prompt", "completion", "user_input"):
        if k in event and isinstance(event[k], str):
            event[k] = redact(event[k])
    return event

structlog.configure(processors=[..., redact_event, ...])
```

更严格：**默认不打 prompt / completion，只打 ID 和 token 数**。需要审计时按 `request_id` 单独再 trace。

## 13. 一份 logging + tracing 上线 checklist

```yaml
logging:
  - [ ] JSON 结构化输出到 stdout
  - [ ] request_id / trace_id 自动注入
  - [ ] PII / secret redaction
  - [ ] LogQL / Kibana 能按 trace_id 查
  - [ ] 错误日志带 stack trace + 业务上下文
  - [ ] 日志级别按环境（dev INFO, prod WARNING+错误用 INFO）

tracing:
  - [ ] OTel SDK 配置完成
  - [ ] FastAPI / httpx / asyncpg 自动插桩
  - [ ] LLM 调用按 GenAI semconv 打 span
  - [ ] LangSmith 或 Langfuse 接通
  - [ ] 采样策略（生产 1-10%，错误 100%）
  - [ ] trace 与日志关联（同 trace_id）

privacy:
  - [ ] prompt/completion 默认不入 trace（或脱敏）
  - [ ] 用户 ID 用 hash，避免 PII
  - [ ] 日志保留期合规（GDPR/HIPAA）
```

## 14. 采样：成本 vs 可见性

100% trace 在大流量下很贵。采样策略：

```python
from opentelemetry.sdk.trace.sampling import TraceIdRatioBased, ParentBased

provider = TracerProvider(
    resource=Resource.create({...}),
    sampler=ParentBased(root=TraceIdRatioBased(0.1)),   # 10%
)
```

更好：**错误强制采样**（tail sampling，需要 OTel Collector）：

```yaml
# otel-collector.yaml
processors:
  tail_sampling:
    decision_wait: 30s
    policies:
      - { name: errors, type: status_code, status_code: { status_codes: [ERROR] } }
      - { name: slow, type: latency, latency: { threshold_ms: 5000 } }
      - { name: random, type: probabilistic, probabilistic: { sampling_percentage: 5 } }
```

## 常见坑

1. **logs 没结构化**——`print()` 出来一堆乱七八糟字符串，Loki / ES 查询全靠 grep，效率低。
2. **trace_id 没穿透**——OTel 自动只到 FastAPI 边界，往下进 LangChain / 自家 thread 不带，trace 断头。要用 `contextvars` 或显式传播。
3. **prompt / completion 全量入日志**——一周 TB 级数据 + PII 违规。脱敏 + 采样。
4. **LangSmith 双发**——LangChain 默认 trace 加上自己又手动调一次，每条 trace 重复。看官方文档关掉 auto-trace 或调一种就好。
5. **错误日志没 trace_id**——线上 sentry 收到 100 个 500，分不出哪条对应哪个请求。所有 log 都带 trace_id。
6. **采样后看不到具体业务问题**——采样是统计，单条具体问题搜不到。错误强制采样 + 业务关键路径 100%。
7. **Loki 标签过多**——每条日志当独立 stream，Loki 索引爆。labels 只放低基数（service / level / env）。
8. **httpx instrument 把 OpenAI prompt 整个塞进 span**——超大 span，trace 后端拒收。手动设属性，别让自动插桩抓 body。
9. **多服务 trace 不串**——下游服务没接收 `traceparent` header。OTel 自动注入，但自家协议要手动透传。

## 下一步

- 把日志告警串到 §07 监控告警 → [07 · 监控与指标](./07-monitoring.md)
- 利用 trace 做事故根因分析 → [09 · 容灾与降级](./09-disaster-recovery.md)
- 通过 LangSmith dataset 把生产 trace 喂回 eval → [../eval/](../eval/)
- prompt 与模型版本灰度时用 trace 对照 → [10 · CI/CD 与版本灰度](./10-cicd.md)
- LangGraph 内置 trace 配置 → [../langgraph/10-deployment.md](../langgraph/10-deployment.md)
- OTel GenAI spec → <https://opentelemetry.io/docs/specs/semconv/gen-ai/>
- Langfuse 自托管 → <https://langfuse.com/docs/deployment/self-host>
- OpenLLMetry → <https://github.com/traceloop/openllmetry>
