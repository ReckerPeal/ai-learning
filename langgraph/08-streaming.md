# 08 · 流式输出

LangGraph 的流式不止"流 token"，还能流**节点输出、状态变化、自定义事件**。这章把所有 `stream_mode` 讲清楚，并给出常见前后端协议。

## 1. 五种 `stream_mode`

```python
for chunk in app.stream(state, config, stream_mode="values"):
    ...
```

| mode | 每个 chunk 是什么 | 典型用途 |
|---|---|---|
| `values` | 每超步后的**完整 state** | 调试、实时看 state 演变 |
| `updates` | 每个节点产生的**增量更新** `{node_name: partial_state}` | 通知前端"哪个节点跑完了" |
| `messages` | LLM 的 **token 流** + 元数据 | ChatGPT 式打字机效果 |
| `custom` | 节点里 `get_stream_writer()` 主动推的事件 | 进度条、自定义信号 |
| `debug` | 完整执行细节（task 进入、完成、checkpoint 等） | 深度调试 |

也可以**同时订阅多种**：

```python
for mode, chunk in app.stream(state, config, stream_mode=["updates", "messages"]):
    print(mode, chunk)
```

返回的 `chunk` 会带上 mode 标签。

## 2. `values` 模式

```python
for snapshot in app.stream({"messages": [HumanMessage("hi")]}, stream_mode="values"):
    print(snapshot["messages"][-1])
```

每次拿到的是**最新整个 state**——适合"我想看每一步后的全貌"。代价是 state 大时数据冗余。

## 3. `updates` 模式

```python
for chunk in app.stream(state, stream_mode="updates"):
    # chunk 例：{"agent": {"messages": [AIMessage(...)]}}
    for node, update in chunk.items():
        print(f"[{node}] -> {update}")
```

最适合给前端"管线进度"：每跑完一个节点推一次，告诉用户"正在搜索…正在总结…"。

## 4. `messages` 模式（LLM token 流）

```python
for token, metadata in app.stream(state, stream_mode="messages"):
    # token 是 AIMessageChunk；metadata 含节点名、tags 等
    if metadata["langgraph_node"] == "agent":
        print(token.content, end="", flush=True)
```

要点：
- 自动从图里所有 LLM 调用收集 token，不需要你改 LLM 代码
- `metadata` 里能拿到**哪个节点产生的**、用的什么模型、tags 等
- 多个节点都用 LLM 时，按 `langgraph_node` 过滤

### 4.1 给特定 LLM 调用打 tag

```python
llm = ChatOpenAI(model="gpt-4o-mini").with_config(tags=["main"])

# 流式时按 tag 过滤
for token, meta in app.stream(state, stream_mode="messages"):
    if "main" in meta.get("tags", []):
        yield token.content
```

### 4.2 异步流

```python
async for token, meta in app.astream(state, stream_mode="messages"):
    ...
```

生产服务建议用 `astream`，配 FastAPI / SSE 顺手。

## 5. `custom` 模式：自定义事件

节点里调用 `get_stream_writer()` 主动推数据：

```python
from langgraph.config import get_stream_writer

def long_task(state):
    writer = get_stream_writer()
    for i, item in enumerate(state["items"]):
        result = process(item)
        writer({"progress": (i + 1) / len(state["items"]), "current": item})
    return {"results": [...]}
```

订阅：

```python
for ev in app.stream(state, stream_mode="custom"):
    print(ev)   # {"progress": 0.3, "current": "..."}
```

适合：长任务进度条、节点内部细粒度事件、不想塞进 state 的临时信号。

## 6. `astream_events`：最细的事件流

来自 LangChain 的统一事件接口，能拿到**每个 Runnable**（LLM、tool、retriever、整个图）的开始/结束/流式 chunk：

```python
async for ev in app.astream_events(state, version="v2"):
    kind = ev["event"]
    name = ev["name"]
    if kind == "on_chat_model_stream":
        print(ev["data"]["chunk"].content, end="")
    elif kind == "on_tool_start":
        print(f"[tool start] {name} {ev['data']['input']}")
    elif kind == "on_tool_end":
        print(f"[tool end]   {name}")
```

适合给"全景式可视化界面"用，但事件量大，需要按 `kind` / `name` 过滤。

## 7. 前后端协议示例：SSE

服务端（FastAPI）：

```python
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
import json

api = FastAPI()

@api.post("/chat")
async def chat(thread_id: str, message: str):
    cfg = {"configurable": {"thread_id": thread_id}}

    async def gen():
        async for mode, chunk in app.astream(
            {"messages": [HumanMessage(message)]},
            config=cfg,
            stream_mode=["messages", "updates"],
        ):
            if mode == "messages":
                token, meta = chunk
                yield f"data: {json.dumps({'type': 'token', 'text': token.content})}\n\n"
            elif mode == "updates":
                yield f"data: {json.dumps({'type': 'node', 'data': {k: '…' for k in chunk}})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")
```

前端（浏览器）：

```js
const es = new EventSource("/chat?thread_id=demo&message=hi");
es.onmessage = (e) => {
  if (e.data === "[DONE]") return es.close();
  const ev = JSON.parse(e.data);
  if (ev.type === "token") appendToken(ev.text);
  if (ev.type === "node")  showNodeProgress(ev.data);
};
```

## 8. 流式 + HITL

中断时，`stream` 会**正常结束**那一轮（最后一个 chunk 里出现 `__interrupt__`）。客户端拿到 interrupt → 让用户操作 → 用 `Command(resume=...)` 再 stream 一次。

```python
async def run(thread_id, payload):
    cfg = {"configurable": {"thread_id": thread_id}}
    async for chunk in app.astream(payload, config=cfg, stream_mode="updates"):
        yield chunk
        if "__interrupt__" in chunk:
            return  # 让前端看到 interrupt 后停下
```

## 9. 常见坑

| 现象 | 原因 |
|---|---|
| `messages` 模式没 token 流 | LLM 没启用 streaming（多数 chat model 默认开着，但有些 wrapper 没）；或者 LLM 不在图里被直接 invoke |
| `updates` 拿不到 reducer 处理后的值 | `updates` 给的是节点**返回**的 patch，不是合并后的 state；要看合并后用 `values` |
| 流式很慢、token 卡顿 | 可能在节点里做了同步阻塞 IO；或 LLM 服务端没开 streaming |
| 多 LLM 节点混在一起 | 用 `metadata["langgraph_node"]` 或 `tags` 过滤 |
| `astream_events` 太啰嗦 | 用 `include_names` / `include_tags` 过滤，或按 `kind` 白名单 |

## 10. 下一步

- [09-subgraphs.md](./09-subgraphs.md)：子图的事件如何穿透到外层流
- [10-deployment.md](./10-deployment.md)：把流式服务部署到生产
