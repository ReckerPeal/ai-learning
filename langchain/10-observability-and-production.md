# 10 · 可观测与生产

把 LCEL 链 / RAG / Agent 推到生产，主要解决五件事：**观测、缓存、回调、流式、部署**。

## 1. 观测：LangSmith（强烈推荐）

LangChain 团队的官方观测平台。一行环境变量就接好：

```bash
export LANGCHAIN_TRACING_V2=true
export LANGCHAIN_API_KEY=ls__...
export LANGCHAIN_PROJECT=my-app-prod
```

每次链调用都会上报：

- 整条链的执行树（每个 Runnable 的输入输出）
- 每个 LLM 的 prompt / completion / token / 延迟
- 每个 tool / retriever 的输入输出
- 错误堆栈
- 自定义 tag / metadata

调试 RAG 和 Agent 几乎离不开它。

### 1.1 给某次调用打 tag

```python
chain.invoke(input, config={
    "tags": ["prod", "rag"],
    "metadata": {"user_id": "u-123", "experiment": "v2"},
    "run_name": "qa-chain",
})
```

后台按 tag / metadata 筛选 trace，对比版本效果。

### 1.2 数据集与评测

LangSmith 还提供 Datasets：把生产里的真实 trace 收集成评测集，新版本上线前跑一遍。

```python
from langsmith.evaluation import evaluate

evaluate(
    chain,
    data="qa-dataset-v1",      # 数据集名
    evaluators=[my_evaluator], # 自定义/内置评估器
)
```

### 1.3 OpenTelemetry / 自家 APM

不想用 SaaS 的话，LangChain 也支持 OTel：

```python
from langchain_core.tracers.langchain import LangChainTracer
# 或者用 OTel exporter 接到自家 Jaeger / Tempo / Datadog
```

但实测 LangSmith 体验明显更好——它是为 LCEL 量身定制的。

## 2. 回调（Callback）

LangSmith 底层就是基于 callback 实现的。你也可以加自己的：

```python
from langchain_core.callbacks import BaseCallbackHandler

class TokenCounter(BaseCallbackHandler):
    def __init__(self):
        self.total = 0
    def on_llm_end(self, response, **kwargs):
        for gen in response.generations:
            for g in gen:
                self.total += g.message.usage_metadata.get("total_tokens", 0)

counter = TokenCounter()
chain.invoke(input, config={"callbacks": [counter]})
print(counter.total)
```

常见用途：
- 自家计费/配额
- 自家审计日志
- 把每个 LLM 调用同步打到 Slack / 邮件
- 实时检测异常输出（PII / 敏感词）

> 其实大多数场景能用 LangSmith trace 替代——回调适合**链路实时干预**，不只是事后看。

## 3. 缓存

### 3.1 LLM 级缓存

```python
from langchain.globals import set_llm_cache
from langchain_community.cache import SQLiteCache, RedisCache

set_llm_cache(SQLiteCache(database_path=".llm-cache.db"))
# 或 Redis：set_llm_cache(RedisCache(redis_url="redis://localhost"))
```

精确匹配（同 prompt + 同模型 + 同参数）才命中。开发期省钱省时；**生产上要小心**：
- 用户名 / 时间戳 / session_id 进 prompt 就基本不命中
- 模型升级、temperature 略调就全部失效
- 缓存量上去后，键空间膨胀

### 3.2 Embedding 缓存

```python
from langchain.embeddings import CacheBackedEmbeddings
from langchain.storage import LocalFileStore

cache_store = LocalFileStore("./emb-cache/")
cached_emb = CacheBackedEmbeddings.from_bytes_store(
    underlying_embeddings=OpenAIEmbeddings(...),
    document_embedding_cache=cache_store,
)
```

embedding 同样输入完全确定输出——**强烈建议**给文档 embedding 加缓存。重复 embed 几万条文档很贵。

### 3.3 业务级缓存（更实用）

把"语义等价"的 query 归一化成 key 自己缓存：

```python
def cache_key(question: str) -> str:
    return hashlib.sha256(normalize(question).encode()).hexdigest()

cached = redis.get(cache_key(q))
if cached:
    return cached
ans = chain.invoke(q)
redis.setex(cache_key(q), 3600, ans)
```

加 TTL、加版本号（prompt 改了就换 key 前缀），可控性比 LLM 级缓存高得多。

## 4. 流式（生产几乎必开）

不是体验问题——长任务**不流式 = 长 HTTP 连接 / 超时 / 用户感知"卡死"**。

### 4.1 SSE 服务端骨架（FastAPI）

```python
from fastapi import FastAPI
from fastapi.responses import StreamingResponse

api = FastAPI()

@api.post("/chat")
async def chat(question: str):
    async def gen():
        async for chunk in chain.astream({"question": question}):
            yield f"data: {chunk}\n\n"
        yield "data: [DONE]\n\n"
    return StreamingResponse(gen(), media_type="text/event-stream")
```

### 4.2 流式 + 流到中间步骤

LCEL 的 `astream_events` 拿到每个 Runnable 的事件——可以同时给前端推 token 和"正在检索…"提示：

```python
async for ev in chain.astream_events(input, version="v2"):
    if ev["event"] == "on_chat_model_stream":
        yield {"type": "token", "text": ev["data"]["chunk"].content}
    elif ev["event"] == "on_retriever_end":
        yield {"type": "retrieved", "n": len(ev["data"]["output"])}
```

> LangGraph 里这块更强：`stream_mode="updates"` / `"messages"` / `"custom"` 各管各的，详见 [LangGraph 08](../langgraph/08-streaming.md)。

## 5. 错误处理与重试

### 5.1 单步重试

```python
robust_llm = llm.with_retry(
    stop_after_attempt=3,
    wait_exponential_jitter=True,
    retry_if_exception_type=(TimeoutError, ConnectionError),
)
```

### 5.2 Fallback 链

```python
from langchain_anthropic import ChatAnthropic

main = ChatOpenAI(model="gpt-4o").with_retry(stop_after_attempt=2)
backup = ChatAnthropic(model="claude-haiku-4-5")

resilient = main.with_fallbacks([backup])
```

主模型失败 → 自动切备用。`with_fallbacks` 不止用于 LLM，**链级也能用**：

```python
robust_chain = expensive_chain.with_fallbacks([cheap_chain])
```

### 5.3 超时

```python
ChatOpenAI(model="gpt-4o-mini", timeout=30, max_retries=2)
```

链层面也可以用 `asyncio.wait_for` 包：

```python
import asyncio
async def call_with_timeout(input):
    return await asyncio.wait_for(chain.ainvoke(input), timeout=30)
```

## 6. 性能与成本

### 6.1 模型路由

不是所有节点都需要顶级模型。把 supervisor / 简单分类 / 解析 用便宜模型：

```python
small = ChatOpenAI(model="gpt-4o-mini")
big   = ChatOpenAI(model="gpt-4o")

classify = small.with_structured_output(Intent)   # 便宜
reason   = big                                     # 复杂推理
```

实测能把成本砍到 1/5 以下，效果几乎不变。

### 6.2 Prompt caching

OpenAI / Anthropic 都支持。把**长且稳定**的 system prompt + few-shot 放最前面，开 cache：

```python
SystemMessage(
    content=long_system_prompt,
    additional_kwargs={"cache_control": {"type": "ephemeral"}},  # Anthropic
)
```

多轮对话或 Agent 循环里每次重发整段 messages，cache 命中能省 50%+ 输入 token。

### 6.3 批量 + 异步

```python
results = await chain.abatch([{"q": q} for q in questions], max_concurrency=10)
```

`max_concurrency` 控并发，避免被 rate-limit。

### 6.4 Token 预算

长链/Agent 容易爆 token：
- prompt 里加 `trim_messages` 裁历史
- 检索结果加 reranker 降到 top-N
- 大字段不进 prompt（存外部，prompt 只放摘要 + 引用 ID）

## 7. 安全

| 风险 | 对策 |
|---|---|
| Prompt injection | 工具最小权限；高危工具走 HITL（LangGraph）；用户内容明确标注 |
| 数据泄漏 | 不把 secret 进 prompt；不把用户 PII 写到 LangSmith（用 metadata 哈希后传） |
| 输出有害内容 | 加 moderation 节点（OpenAI Moderation API / 自家分类器） |
| 滥用/超额 | 配额 / 速率限制 / 单用户上下文上限 |
| 工具被滥用 | 工具内做参数白名单；`InjectedToolArg` 把敏感参数从 LLM 视野里隐藏 |

## 8. 部署形态

### 8.1 自封 FastAPI（最常见）

把链放在一个 FastAPI 服务里，前后端通过 SSE / WebSocket 通信。

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN pip install uv && uv sync --frozen
COPY app/ ./app/
CMD ["uvicorn", "app.api:api", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
```

要点：
- `--workers N` 多进程
- 链里多用 `async`
- `uvicorn` 配合 `httptools` / `uvloop`

### 8.2 LangServe（OSS）

LangChain 提供的轻量服务化方案：把 Runnable **直接暴露成 REST API**：

```python
from fastapi import FastAPI
from langserve import add_routes

api = FastAPI()
add_routes(api, chain, path="/qa")
# 自动暴露 /qa/invoke、/qa/stream、/qa/batch、/qa/playground
```

适合：内部工具、demo、原型。生产仍建议自封路由，控制粒度更细。

### 8.3 LangGraph Server / Platform

如果用 LangGraph，**优先**用 LangGraph 自己的服务化方案（详见 [LangGraph 10](../langgraph/10-deployment.md)）——它把 thread、HITL、流式协议都标准化了。

## 9. 上线 checklist

- [ ] 接 LangSmith trace（项目分 dev/staging/prod）
- [ ] LLM 配置 timeout + retry + fallback
- [ ] Embedding 加缓存；高频 query 加业务级缓存
- [ ] 流式接口走 SSE / WebSocket
- [ ] `temperature=0`（除非真要随机性）
- [ ] 错误信息**不**直接抛给用户（包一层友好提示）
- [ ] 用户 ID / 会话 ID 服务端派生，不可被前端伪造
- [ ] 高危工具加 HITL（LangGraph）
- [ ] 容量规划：QPS、token / 秒、向量库存储
- [ ] 离线评测集 + 上线前回归
- [ ] Prompt / 模型版本可回滚（如 `configurable_alternatives`）

## 10. 进一步阅读

- LangSmith 文档：https://docs.smith.langchain.com/
- LangServe：https://github.com/langchain-ai/langserve
- LangChain 部署 guide：https://python.langchain.com/docs/concepts/runnables/
- LangGraph 部署：[../langgraph/10-deployment.md](../langgraph/10-deployment.md)

## 11. 学完之后

- 想深入编排能力 → [LangGraph 学习路径](../langgraph/README.md)
- 想做更高级 RAG → 调研 CRAG / Self-RAG / Adaptive-RAG（LangGraph 仓有模板）
- 想做 Eval → 重点学 LangSmith Datasets + `evaluate()`
