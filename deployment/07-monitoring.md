# 07 · 监控与指标

LLM 服务的监控比普通 web 多两层：**通用 RED 指标**（Rate / Error / Duration）+ **LLM 特化指标**（TTFT / tokens/s / cost / KV usage）。本章给 Prometheus + Grafana + OpenTelemetry 的接法和必须有的 dashboard。

## 1. 监控分层

```
业务指标      → 任务完成率、用户满意度        ← eval 主题
应用层指标    → API RPS / 错误 / TTFT        ← 本章
LLM 调用指标  → token / cost / 模型分布      ← 本章
基础设施指标  → CPU/RAM/Disk/Net             ← k8s 默认
模型层指标    → vLLM queue / KV usage        ← ../llm-inference/
```

应用层监控**先从 RED + LLM 特化的"三张图"开始**，别一上来就铺 50 个 panel。

## 2. 必须有的指标清单

### 2.1 RED（任何服务）

| 指标 | Prometheus 类型 | 标签 |
|---|---|---|
| `http_requests_total` | Counter | status, method, path |
| `http_request_duration_seconds` | Histogram | path |
| `inflight_requests` | Gauge | - |

### 2.2 LLM 特化

| 指标 | 意义 |
|---|---|
| `llm_request_total{model,provider,status}` | LLM API 调用次数 |
| `llm_ttft_seconds{model}` | Time to first token |
| `llm_tokens_total{model,kind}` | input / output token 用量 |
| `llm_cost_usd_total{model,tenant}` | 累计成本（自己算） |
| `llm_tool_total{name,status}` | 工具调用次数 / 失败 |
| `llm_cache_hits_total{kind}` | prompt cache / response cache 命中 |
| `agent_steps_total{graph,node}` | graph 节点执行次数 |
| `agent_run_duration_seconds{graph,outcome}` | 整段 agent run 时长 |
| `stream_disconnects_total{reason}` | 流式断线（client / timeout） |

### 2.3 资源 / 容量

| 指标 | 用途 |
|---|---|
| `process_resident_memory_bytes` | 内存监控 |
| `process_open_fds` | 文件描述符（流式多会涨） |
| `python_gc_objects_collected_total` | GC 压力 |

## 3. Python 侧暴露指标

```python
# app/metrics.py
from prometheus_client import Counter, Histogram, Gauge, generate_latest
from prometheus_client import CONTENT_TYPE_LATEST
from fastapi import Response

REQUESTS = Counter(
    "http_requests_total", "HTTP requests",
    ["method", "path", "status"],
)
LATENCY = Histogram(
    "http_request_duration_seconds", "HTTP latency",
    ["path"],
    buckets=(0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300),
)
INFLIGHT = Gauge("inflight_requests", "Currently processing")

LLM_REQS = Counter(
    "llm_request_total", "LLM API calls",
    ["model", "provider", "status"],
)
LLM_TTFT = Histogram(
    "llm_ttft_seconds", "Time to first token",
    ["model"],
    buckets=(0.1, 0.25, 0.5, 1, 2, 5, 10),
)
LLM_TOKENS = Counter(
    "llm_tokens_total", "Tokens",
    ["model", "kind"],   # kind: input / output / cached
)
LLM_COST = Counter(
    "llm_cost_usd_total", "USD cost",
    ["model", "tenant"],
)
TOOL_CALLS = Counter("llm_tool_total", "Tool calls", ["name", "status"])
STREAM_DISC = Counter("stream_disconnects_total", "Stream disconnects", ["reason"])

@api.get("/metrics")
async def metrics():
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)
```

### 3.1 中间件自动采

```python
@api.middleware("http")
async def metrics_mw(req, call_next):
    INFLIGHT.inc()
    start = time.monotonic()
    try:
        resp = await call_next(req)
        REQUESTS.labels(req.method, req.url.path, resp.status_code).inc()
        return resp
    finally:
        LATENCY.labels(req.url.path).observe(time.monotonic() - start)
        INFLIGHT.dec()
```

### 3.2 LLM 调用埋点

```python
# 包一层 OpenAI client
class InstrumentedClient:
    def __init__(self, client, model: str, provider: str):
        self.c = client; self.model = model; self.provider = provider

    async def chat(self, **kw):
        t0 = time.monotonic()
        ttft = None
        try:
            stream = await self.c.chat.completions.create(stream=True, **kw)
            input_tokens = 0; output_tokens = 0
            async for chunk in stream:
                if ttft is None:
                    ttft = time.monotonic() - t0
                    LLM_TTFT.labels(self.model).observe(ttft)
                if chunk.choices[0].delta.content:
                    output_tokens += 1   # 粗略，精确要 tiktoken 编码
                yield chunk
            LLM_TOKENS.labels(self.model, "input").inc(kw.get("usage_input", 0))
            LLM_TOKENS.labels(self.model, "output").inc(output_tokens)
            LLM_COST.labels(self.model, kw.get("tenant", "default")).inc(
                _price(self.model, input_tokens, output_tokens)
            )
            LLM_REQS.labels(self.model, self.provider, "ok").inc()
        except Exception:
            LLM_REQS.labels(self.model, self.provider, "error").inc()
            raise
```

精确 token 用 [tiktoken](https://github.com/openai/tiktoken)；价格表可外置 `prices.yaml` 周期更新。

## 4. Prometheus 抓取配置

K8s 内可以靠 ServiceMonitor（Prometheus Operator）或简单的 annotation 自动发现：

```yaml
# Pod annotation
prometheus.io/scrape: "true"
prometheus.io/port: "8000"
prometheus.io/path: "/metrics"
```

对应 Prometheus scrape config（kube-prometheus 默认抓 Pod annotations）：

```yaml
scrape_configs:
  - job_name: kubernetes-pods
    kubernetes_sd_configs:
      - role: pod
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
        action: keep
        regex: true
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_port]
        action: replace
        target_label: __address__
        regex: (.+)
        replacement: $1
        source_labels: [__meta_kubernetes_pod_ip, __meta_kubernetes_pod_annotation_prometheus_io_port]
        separator: ":"
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
        action: replace
        target_label: __metrics_path__
        regex: (.+)
```

### 4.1 ServiceMonitor（推荐）

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata: { name: agent-api }
spec:
  selector: { matchLabels: { app: agent-api } }
  endpoints:
    - port: http            # Service port name
      path: /metrics
      interval: 15s
      scrapeTimeout: 10s
```

抓 vLLM 也类似（不同的 port name 和 path），见 [../llm-inference/](../llm-inference/)。

## 5. Grafana：三张核心图

不要一上来 30 个 panel。先有这三张，已经能解 80% 的事故：

### 5.1 服务健康（RED + 流式）

```
Row 1: 请求速率 / 错误率 / 延迟分位
  - rate(http_requests_total[5m]) by (status)
  - sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))
  - histogram_quantile(0.95, sum by(le, path)(rate(http_request_duration_seconds_bucket[5m])))

Row 2: 当前 inflight / 内存 / 文件描述符
  - inflight_requests
  - process_resident_memory_bytes
  - process_open_fds
```

### 5.2 LLM 用量

```
Row 1: LLM 调用速率 / 错误率 / TTFT
  - sum by(model)(rate(llm_request_total[5m]))
  - sum by(model)(rate(llm_request_total{status="error"}[5m])) / sum by(model)(rate(llm_request_total[5m]))
  - histogram_quantile(0.9, sum by(le, model)(rate(llm_ttft_seconds_bucket[5m])))

Row 2: token 速率 / 成本
  - sum by(model, kind)(rate(llm_tokens_total[5m]))
  - sum by(model)(rate(llm_cost_usd_total[1h]) * 3600)  # USD/h
```

### 5.3 业务 / Agent

```
Row 1: agent 完成率、平均节点数
  - sum by(graph, outcome)(rate(agent_run_duration_seconds_count[5m]))
  - histogram_quantile(0.5, sum by(le, graph)(rate(agent_run_duration_seconds_bucket[5m])))

Row 2: 工具调用、流式断线
  - sum by(name, status)(rate(llm_tool_total[5m]))
  - sum by(reason)(rate(stream_disconnects_total[5m]))
```

## 6. 告警规则

不是越多越好，**先有 7-8 条核心告警**：

```yaml
groups:
  - name: agent-api
    rules:
      - alert: HighErrorRate
        expr: |
          sum(rate(http_requests_total{status=~"5..", app="agent-api"}[5m]))
          /
          sum(rate(http_requests_total{app="agent-api"}[5m])) > 0.02
        for: 5m
        labels: { severity: critical }
        annotations:
          summary: "agent-api 5xx > 2%"

      - alert: HighLatencyP95
        expr: |
          histogram_quantile(0.95, sum by(le)(rate(http_request_duration_seconds_bucket[5m]))) > 10
        for: 10m
        labels: { severity: warning }

      - alert: LLMTTFTHigh
        expr: |
          histogram_quantile(0.9, sum by(le, model)(rate(llm_ttft_seconds_bucket[5m]))) > 5
        for: 10m
        labels: { severity: warning }

      - alert: LLMErrorBurst
        expr: sum by(provider)(rate(llm_request_total{status="error"}[5m])) > 5
        for: 5m
        labels: { severity: critical }

      - alert: CostSpike
        expr: rate(llm_cost_usd_total[15m]) * 3600 > 50    # > $50/h
        for: 30m
        labels: { severity: warning }

      - alert: InflightSaturated
        expr: avg_over_time(inflight_requests[5m]) / 32 > 0.9   # MAX_INFLIGHT=32
        for: 5m
        labels: { severity: warning }

      - alert: PodCrashLoop
        expr: rate(kube_pod_container_status_restarts_total{namespace="agent"}[15m]) > 0
        for: 5m
        labels: { severity: critical }

      - alert: NoTraffic
        expr: sum(rate(http_requests_total[5m])) == 0
        for: 5m
        labels: { severity: critical }
        annotations: { summary: "服务有响应但无流量，可能 ingress 挂了" }
```

## 7. OpenTelemetry：trace + metrics 一体化

OTel 是未来的方向（trace 见 §08）。指标导出走 OTLP：

```python
from opentelemetry.metrics import get_meter_provider, set_meter_provider
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter

reader = PeriodicExportingMetricReader(
    OTLPMetricExporter(endpoint="otel-collector.observability:4317", insecure=True),
    export_interval_millis=15_000,
)
set_meter_provider(MeterProvider(metric_readers=[reader]))

meter = get_meter_provider().get_meter("agent")
ttft = meter.create_histogram("llm.ttft", unit="s")
ttft.record(0.45, {"model": "gpt-4o-mini"})
```

后端可以是 Prometheus（OTel Collector 转换）、Grafana Tempo、Honeycomb、Datadog。OTel **语义约定** 已经覆盖 LLM：[GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)。

### 7.1 OTel Collector 配置（K8s sidecar 或 DaemonSet）

```yaml
receivers:
  otlp:
    protocols:
      grpc: { endpoint: 0.0.0.0:4317 }
      http: { endpoint: 0.0.0.0:4318 }
processors:
  batch: {}
  resource:
    attributes:
      - { key: deployment.environment, value: prod, action: upsert }
exporters:
  prometheusremotewrite:
    endpoint: http://prometheus:9090/api/v1/write
  otlp/tempo:
    endpoint: tempo:4317
    tls: { insecure: true }
service:
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [batch, resource]
      exporters: [prometheusremotewrite]
    traces:
      receivers: [otlp]
      processors: [batch, resource]
      exporters: [otlp/tempo]
```

## 8. LLM 特化可观测平台

非传统 Prometheus 路径的"LLM 专用"工具：

| 工具 | 重点 | 价位 |
|---|---|---|
| **LangSmith** | LangChain 生态默认 trace + dataset + eval | SaaS 付费 |
| **Langfuse** | OSS LLM observability，trace + prompt 管理 | 自托管 / Cloud |
| **Helicone** | LLM gateway + 监控 + cache | SaaS 付费 |
| **OpenLLMetry** | OTel SDK 给 LangChain/OpenAI 自动插桩 | 免费 OSS |
| **Phoenix（Arize）** | LLM trace + eval | OSS / Cloud |

它们都不是替代 Prometheus，**是补充**：traceability + prompt 级别细节。生产建议：

- 应用 / 基础设施监控 → Prometheus + Grafana
- LLM 调用 trace + prompt 调试 → LangSmith 或 Langfuse
- 全链路 trace 统一 → OpenTelemetry + Tempo / Datadog

详见 §08。

## 9. 成本监控（cost/req）

实时算成本要价格表 + 实时 token 数：

```python
# app/pricing.py
PRICES = {
    "gpt-4o":          { "input": 2.50, "output": 10.00 },     # /1M tokens
    "gpt-4o-mini":     { "input": 0.15, "output": 0.60 },
    "claude-3-5-sonnet": { "input": 3.00, "output": 15.00 },
    "claude-3-5-haiku":  { "input": 0.80, "output": 4.00 },
    # 自部署模型：按 GPU 小时 / token 估算
}

def cost_usd(model: str, input_tok: int, output_tok: int) -> float:
    p = PRICES[model]
    return (input_tok * p["input"] + output_tok * p["output"]) / 1_000_000
```

Grafana 加一张「日成本 / 每千请求成本」：

```
sum by(tenant)(increase(llm_cost_usd_total[24h]))
sum(rate(llm_cost_usd_total[5m])) / sum(rate(http_requests_total{path="/chat"}[5m])) * 1000
```

预算告警：

```yaml
- alert: DailyBudgetExceeded
  expr: sum(increase(llm_cost_usd_total[24h])) > 500
  for: 1h
  labels: { severity: critical }
```

## 10. 监控自身的监控（meta）

```yaml
- [ ] Prometheus 自己有 federation 或 HA？挂了不能瞎
- [ ] Grafana 有备份（dashboard JSON 进 git）
- [ ] AlertManager 路由到至少两个通道（slack + PagerDuty）
- [ ] 告警有 runbook 链接
- [ ] 每月做一次"消防演习"——故意触发告警，确认值班响应
```

## 11. 一份监控上线 checklist

```yaml
metrics:
  - [ ] RED 三件套
  - [ ] LLM 特化（TTFT / tokens / cost）
  - [ ] inflight / 流式断线 / 工具调用
  - [ ] /metrics endpoint 暴露
  - [ ] Prometheus 抓取确认（Targets 页面 UP）

dashboards:
  - [ ] 服务健康
  - [ ] LLM 用量
  - [ ] 业务 / Agent
  - [ ] 成本

alerts:
  - [ ] 高错误率
  - [ ] 高延迟
  - [ ] LLM TTFT / 错误突增
  - [ ] 成本飙升
  - [ ] inflight 饱和
  - [ ] Pod crash loop / no traffic

observability:
  - [ ] OTel 接通（trace + metrics）
  - [ ] LangSmith / Langfuse 接入
  - [ ] 价格表周期更新

ops:
  - [ ] Grafana 看板 git 管理
  - [ ] 告警有 runbook
  - [ ] PagerDuty / 飞书 / Slack 通道
```

## 常见坑

1. **指标 label 高基数**——把 `user_id` 或 `thread_id` 作为 label，Prometheus 内存爆。ID 类用 trace 而不是 metric。
2. **histogram bucket 没设好**——LLM 延迟跨度大（100ms-300s），默认 bucket 不够。要自己定 `(0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300)`。
3. **`/metrics` 没鉴权且暴露公网**——业务指标外泄。Ingress 上加白名单或只 cluster 内访问。
4. **token 数估算用字符长度**——中文一字多 token，估错离谱。要用 tiktoken 之类的 tokenizer。
5. **价格表过期**——OpenAI 调价 30%，账单告警没动，月底惊喜。CI 周期校验 price 与官方文档一致。
6. **告警太多**——一夜 500 条 alert，值班麻木。先 5-8 条核心告警，调好后逐步加。
7. **看指标不看 trace**——延迟高了不知道是哪步慢。trace 与 metric 关联（traceID 入日志）。
8. **vLLM 指标没接**——模型层卡的瓶颈应用层完全看不到。vLLM 有自己的 `/metrics`，要单独抓（见 [../llm-inference/](../llm-inference/)）。
9. **冷启动指标缺失**——Serverless 冷启动 5s 才响应，但 `http_request_duration` 不区分冷热。加 `cold_start_total` counter。

## 下一步

- 配合 trace 拿到全链路视角 → [08 · 日志与 Trace](./08-logging-tracing.md)
- 监控触发的容灾 / 降级 → [09 · 容灾与降级](./09-disaster-recovery.md)
- 成本监控喂到 CI/CD 门禁 → [10 · CI/CD 与版本灰度](./10-cicd.md)
- 模型层 vLLM 指标 → [../llm-inference/08-benchmarking.md](../llm-inference/08-benchmarking.md)
- eval 指标 vs 监控指标的区分 → [../eval/](../eval/)
- Prometheus 官方 → <https://prometheus.io/docs/>
- OTel GenAI semconv → <https://opentelemetry.io/docs/specs/semconv/gen-ai/>
