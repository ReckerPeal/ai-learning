# 06 · 流式服务部署

LLM 应用 90% 是流式（SSE/WebSocket），但**90% 的部署事故也是流式相关**——本地跑得好好的，上了 Ingress / CDN / Cloudflare / ALB 之后用户看到的不是 token-by-token，而是 30 秒后一坨。这一章把链路上每一层的 buffer / timeout / keep-alive 配置讲清楚。

## 1. SSE vs WebSocket：什么时候选哪个

| 维度 | SSE (Server-Sent Events) | WebSocket |
|---|---|---|
| 方向 | 服务端 → 客户端 | 双向 |
| 协议 | 标准 HTTP（响应不结束） | upgrade 后另起协议 |
| 浏览器原生 | `EventSource` API | `WebSocket` API |
| 代理穿透 | 好（标准 HTTP） | 多数 OK，老旧代理可能拦 |
| 鉴权 | 标准 HTTP header / cookie | 第一帧或 query string |
| 自动重连 | EventSource 内置 | 自己写 |
| 二进制 | 不行（只 UTF-8） | 行 |
| HTTP/2 多路复用 | ✅ | ❌（H2 不支持 WS，要 H3 或独立连接） |
| LangGraph SDK | ✅ 默认 | 部分 |
| **典型 LLM chat 用法** | **推荐 SSE** | 客户端要发持续指令时 |

**结论**：纯输出 token 流，**SSE 足够且更简单**。需要双向（如客户端动态发"暂停"、"插入图片"）或协作（多人同看一个 agent），用 WebSocket。

## 2. SSE 协议骨架

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no            ← 关键：告诉中间代理别 buffer

event: token
data: {"delta": "Hello"}

event: token
data: {"delta": " world"}

event: done
data: {"finish_reason": "stop"}
```

每条事件以 `\n\n` 结尾。客户端 `EventSource` 自动按事件解析。

### 2.1 FastAPI 实现

```python
# app/streaming.py
import json
from typing import AsyncIterator
from fastapi.responses import StreamingResponse

def sse_response(events: AsyncIterator[dict]) -> StreamingResponse:
    async def gen():
        try:
            async for evt in events:
                # 自定义事件类型
                if "event" in evt:
                    yield f"event: {evt['event']}\n"
                # 多行 data 也按 spec 拆
                data = json.dumps(evt.get("data", {}), ensure_ascii=False)
                for line in data.splitlines():
                    yield f"data: {line}\n"
                yield "\n"
            yield "event: done\ndata: {}\n\n"
        except Exception as e:
            yield f"event: error\ndata: {json.dumps({'message': str(e)})}\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "Content-Encoding": "identity",        # 关 gzip
        },
    )
```

注意：

- `Content-Encoding: identity` 关 gzip，否则压缩缓冲会"攒"几 KB 才发。
- `Cache-Control: no-transform` 阻止 CDN（特别是 Cloudflare）做 minify/压缩。

### 2.2 客户端

```javascript
const es = new EventSource("/api/chat?thread_id=t-123");

es.addEventListener("token", (e) => {
  const { delta } = JSON.parse(e.data);
  appendToChat(delta);
});

es.addEventListener("done", () => {
  es.close();
});

es.addEventListener("error", (e) => {
  console.error("stream error", e);
  es.close();
});
```

`EventSource` 不能发 POST，只能 GET。要发 POST：用 `fetch` + `ReadableStream`：

```javascript
const resp = await fetch("/api/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ messages }),
});

const reader = resp.body.getReader();
const decoder = new TextDecoder();
let buf = "";

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  // 按 \n\n 切事件
  let idx;
  while ((idx = buf.indexOf("\n\n")) !== -1) {
    const evt = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    handleEvent(evt);
  }
}
```

## 3. 端到端 buffer 链路

请求要流式真正到达浏览器，**每一层都不能 buffer**：

```
Browser
  ↑
Cloudflare / Akamai / Fastly      ← 1. CDN 层
  ↑
Cloud LB（ALB / GCLB / Cloudflare） ← 2. 入口 LB
  ↑
K8s Ingress (nginx-ingress / Envoy)← 3. 集群 Ingress
  ↑
K8s Service                        ← 4. 集群内 LB
  ↑
Pod (uvicorn)                      ← 5. 应用 server
  ↑
你的 FastAPI 代码                  ← 6. 业务代码
```

任意一层 buffer 都会让流式失效。

### 3.1 各层配置速查

| 层 | 关 buffer 的配置 |
|---|---|
| 业务代码 | `StreamingResponse` + 上面的 headers |
| uvicorn | 默认 OK，但 `--proxy-headers` 要加 |
| nginx-ingress | annotation：`proxy-buffering: "off"`, `proxy-request-buffering: "off"` |
| Envoy/Istio | `route.idle_timeout`、`stream_idle_timeout` 加长；默认不 buffer 但有 timeout |
| AWS ALB | 默认不 buffer；`idle_timeout` 默认 60s，要调到 300+ |
| GCLB（Cloud Run 前面） | 配 `--no-cpu-throttling` 在 Cloud Run；GCLB 自动透传 |
| Cloudflare | Free/Pro：流式 SSE OK；Workers 路径要 `event-stream` mime；**Rocket Loader 关闭** |
| Akamai | 显式启用 streaming，默认全 buffer |
| Vercel | Edge runtime 原生支持 |

### 3.2 一份真正能跑的 nginx-ingress annotation

```yaml
annotations:
  nginx.ingress.kubernetes.io/proxy-buffering: "off"
  nginx.ingress.kubernetes.io/proxy-request-buffering: "off"
  nginx.ingress.kubernetes.io/proxy-read-timeout: "600"
  nginx.ingress.kubernetes.io/proxy-send-timeout: "600"
  nginx.ingress.kubernetes.io/proxy-http-version: "1.1"
  nginx.ingress.kubernetes.io/connection-proxy-header: "keep-alive"
  nginx.ingress.kubernetes.io/server-snippet: |
    chunked_transfer_encoding on;
```

### 3.3 Envoy / Istio VirtualService

```yaml
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata: { name: agent-api }
spec:
  hosts: [api.example.com]
  http:
    - timeout: 600s              # 整体超时
      route:
        - destination: { host: agent-api, port: { number: 80 } }
      headers:
        request: { set: { x-envoy-stream-idle-timeout: "600s" } }
```

Envoy 默认不 buffer，但 `stream_idle_timeout` 默认 5 分钟，长 agent 任务会被切。

## 4. 长连接的 idle timeout 矩阵

某段时间无数据传输就算 idle。LLM 流式平均每 50-300ms 一个 token，正常不会触发 idle。但 agent 节点切换、tool 调用等待时可能几十秒无输出，会踩 idle timeout。

| 层 | 默认 idle | 建议 |
|---|---|---|
| Cloudflare Free | 100s | Enterprise 可调到 600s |
| Cloudflare Pro | 100s | 同上 |
| AWS ALB | 60s | 调到 600s |
| AWS NLB | 350s | 不可调 |
| GCLB | 30s | 默认全局 30s，必调 |
| nginx-ingress | 60s | annotation 调 600s |
| uvicorn | 无 | - |
| OpenAI/Anthropic 出站 | 600s | - |

**经验值**：所有层统一调到 **600 秒**。比单次最长 agent 任务再加点余量。

### 4.1 Keep-alive ping 应对短 idle

如果中间层 idle 不能调长（如 Cloudflare Free 固定 100s），定期发 SSE comment 保活：

```python
import asyncio

async def gen_with_keepalive(inner):
    last_send = time.monotonic()
    async def keepalive_pinger():
        while True:
            await asyncio.sleep(15)
            if time.monotonic() - last_send > 15:
                yield ": keepalive\n\n"      # SSE 注释行，客户端忽略

    # 实战中用 asyncio.Queue 合流两个 generator
    ...
```

## 5. 优雅终止与中途断线

### 5.1 Pod 收到 SIGTERM 时

```
1. Pod 进入 Terminating 状态
2. Service endpoint 摘除该 pod（有 1-2s 延迟）
3. preStop hook 跑（建议 sleep 10）
4. 容器收到 SIGTERM
5. uvicorn 等正在跑的请求完成
6. terminationGracePeriodSeconds 超时则 SIGKILL
```

对应配置（参 §03）：

```yaml
terminationGracePeriodSeconds: 120  # 大于最长流式请求
lifecycle:
  preStop:
    exec: { command: ["sh", "-c", "sleep 10"] }
```

应用代码层加 graceful shutdown：

```python
import signal

class App:
    shutting_down = False

@api.middleware("http")
async def shutdown_guard(req, call_next):
    if App.shutting_down:
        return JSONResponse({"error": "shutting down"}, status_code=503,
                            headers={"Connection": "close"})
    return await call_next(req)

def _shutdown(*_):
    App.shutting_down = True

signal.signal(signal.SIGTERM, _shutdown)
```

### 5.2 客户端断线检测

服务端流到一半客户端关 tab，要立刻停掉下游 LLM 请求（省 token）：

```python
@api.post("/chat")
async def chat(req: Request):
    async def gen():
        async for delta in llm_stream():
            if await req.is_disconnected():
                # 客户端断了，停掉 LLM stream
                break
            yield f"data: {json.dumps({'delta': delta})}\n\n"
    return StreamingResponse(gen(), media_type="text/event-stream")
```

`Request.is_disconnected()` 是 Starlette/FastAPI 的标准 API，背后查 receive 队列。

## 6. WebSocket 部署

需要双向时用 WS。K8s 中：

```yaml
# Ingress
annotations:
  nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
  nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
```

Cloud LB：

| 平台 | 注意 |
|---|---|
| AWS ALB | 自动支持 WS，idle 调 600+ |
| AWS NLB | 透传 TCP，没有协议干预 |
| GCLB | HTTP(S) LB 支持 WS；要勾"WebSocket" |
| Cloudflare | 默认支持，注意 free 100s |

WS 鉴权：

```python
# FastAPI WS
from fastapi import WebSocket, WebSocketException, status

@api.websocket("/ws/chat")
async def ws_chat(ws: WebSocket, token: str):
    user = await verify(token)
    if not user:
        await ws.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    await ws.accept()
    async for msg in ws.iter_json():
        ...
```

**重要**：浏览器 WebSocket 不能自定义 header，鉴权要靠 query string 或第一帧。

## 7. 流式服务的 Pod 设计

```yaml
# 关键差异 vs 普通服务
spec:
  containers:
    - name: app
      resources:
        # 流式时单 pod 同时挂多个长连接，连接数比 CPU 重要
        limits: { cpu: "1", memory: "1Gi" }
      env:
        # 单实例并发上限——避免被打爆
        - { name: MAX_INFLIGHT, value: "32" }
  terminationGracePeriodSeconds: 120     # 长流式
```

并发上限在应用层强制（用 semaphore），HPA 看 inflight 扩缩：

```python
from contextlib import asynccontextmanager
from asyncio import Semaphore

INFLIGHT = Semaphore(int(os.environ.get("MAX_INFLIGHT", "32")))
INFLIGHT_GAUGE = Gauge("inflight_requests", "")

@asynccontextmanager
async def inflight_slot():
    if INFLIGHT.locked() and INFLIGHT._value == 0:
        raise HTTPException(503, "Too busy")
    async with INFLIGHT:
        INFLIGHT_GAUGE.inc()
        try:
            yield
        finally:
            INFLIGHT_GAUGE.dec()

@api.post("/chat")
async def chat(req: Request):
    async with inflight_slot():
        ...
```

## 8. CDN / 边缘场景

### 8.1 Cloudflare 流式

| 配置 | 设置 |
|---|---|
| Rocket Loader | **关**（会改 script，影响 EventSource） |
| Auto Minify | 关 HTML（其他可保留） |
| Cache Rule | `/api/chat*` 设为 Bypass cache |
| Page Rules → Disable Performance | 推荐 |
| WAF Rate limit | 单用户每分钟限请求数 |

### 8.2 Cloudflare Workers Streaming

```typescript
export default {
  async fetch(req: Request) {
    const upstream = await fetch("https://backend.internal/chat", {
      method: "POST",
      body: req.body,
      headers: req.headers,
    });
    // 直接 pipe，Workers 自动流式
    return new Response(upstream.body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    });
  },
};
```

## 9. 一份"流式上线检验"步骤

上线前必跑：

```bash
# 1. curl 直连 pod，看到 token-by-token
kubectl port-forward pod/agent-xxx 8000:8000
curl -N http://localhost:8000/chat -d '{"message":"hi"}' -H 'Content-Type: application/json'
# 看 -N 是关本地 buffer

# 2. curl 通过 Service
curl -N http://agent-api.namespace.svc.cluster.local/chat ...

# 3. curl 通过 Ingress
curl -N https://api.example.com/chat ...

# 4. curl 通过 CDN
curl -N https://api-cdn.example.com/chat ...

# 5. 浏览器 devtools 看 Network → Response 实时出现
```

每一步都要看到 token 实时流出，**任何一步 30s 后才一坨打印就是 buffer 没关**。

## 10. 监控流式

需要监控的特殊指标：

| 指标 | 意义 |
|---|---|
| TTFT (Time To First Token) | 流式体验核心 |
| tokens/s | 流速 |
| 流持续时长 | 知道平均连接占用 |
| 客户端主动断线率 | 用户没耐心？ |
| 中途超时断线率 | 中间层 timeout 偏短？ |
| 当前 inflight 数 | 容量评估 |

实现见 §07。

## 11. 流式服务 checklist

```yaml
client:
  - [ ] 用 EventSource 或 fetch+ReadableStream
  - [ ] 处理 reconnect 与 done / error
  - [ ] 实现 abort（用户取消）

server:
  - [ ] StreamingResponse + 正确 headers
  - [ ] Content-Encoding: identity
  - [ ] X-Accel-Buffering: no
  - [ ] is_disconnected() 检测中断
  - [ ] 并发 semaphore + 503 限流

ingress:
  - [ ] proxy-buffering off
  - [ ] proxy timeout 600s
  - [ ] body size 充足

lb / cdn:
  - [ ] idle timeout >= 600s（或 keepalive ping）
  - [ ] 关压缩 / minify / rocket loader
  - [ ] cache bypass

pod:
  - [ ] terminationGracePeriodSeconds >= 120
  - [ ] preStop sleep
  - [ ] 优雅 shutdown 中间件

verification:
  - [ ] curl 5 层逐层验证
  - [ ] 浏览器 devtools 看流式
  - [ ] 故意客户端断线，server 正确停 LLM
```

## 常见坑

1. **`proxy_buffering off` 加错位置**——Ingress controller 默认 buffer，annotation 要在 Ingress 资源上，不是 Service / Deployment。
2. **gzip / brotli 还开着**——Nginx 默认会压缩 text/event-stream。`gzip_types` 必须排除或用 `Content-Encoding: identity` 强制。
3. **Cloudflare Rocket Loader 没关**——CF 改了 HTML，`new EventSource()` 行为不对，前端拿不到事件。
4. **AWS ALB idle 60s**——长 agent 任务到 60s 被直接 ECONNRESET。必调到 600+。
5. **Vercel Edge Runtime 想跑 LangChain Python**——Edge 是 V8 没 Python。
6. **WS 鉴权用 header**——浏览器 WebSocket API 不能加自定义 header，鉴权要走 query 或第一帧。
7. **没处理客户端断线**——用户关 tab 后服务端继续跑完 LLM，烧 token。`is_disconnected()` 检查每条事件。
8. **SSE 数据带换行没 escape**——`\n` 在 SSE 是字段分隔，要么 JSON 编码，要么按行拆 `data:` 多行。
9. **HPA 只看 RPS**——流式服务一个长连接占一个 slot 几分钟，RPS 低但容量耗尽。要看 inflight。
10. **K8s 滚动升级时正在跑的流被切**——`maxUnavailable: 0` + `terminationGracePeriodSeconds: 120` + `preStop sleep` 三件套保护。

## 下一步

- 整理流式监控指标 → [07 · 监控与指标](./07-monitoring.md)
- trace 流式请求（把每个 token 串成一条 trace） → [08 · 日志与 Trace](./08-logging-tracing.md)
- 流量太大时的容灾 / 降级 → [09 · 容灾与降级](./09-disaster-recovery.md)
- LangGraph 流式 stream_mode 详解 → [05 · LangGraph Server vs FastAPI](./05-langgraph-server.md)
- 模型层 vLLM 流式 → [../llm-inference/03-vllm.md](../llm-inference/03-vllm.md)
- SSE spec → <https://html.spec.whatwg.org/multipage/server-sent-events.html>
- nginx-ingress 流式配置 → <https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/annotations/>
