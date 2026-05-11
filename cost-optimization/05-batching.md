# 05 · 批处理

如果你的任务**不要求秒级返回**——比如夜间报表、内容生成预热、文档总结、数据清洗、离线分类——Batch API 给你 50% 现成的折扣，加上 prompt cache，单价能压到 list 的 1/4。本章讲 OpenAI / Anthropic 的 Batch API 用法、何时换 async batching、micro-batching 在线场景，以及把 batch 做成生产管线的工程。

## 1. Batch API 是什么、为什么便宜一半

**Batch API**：你提交一批请求（最大 50K 行 / 100MB），厂商 24 小时内（通常 < 1 小时）跑完返回结果，**单价 5 折**。

| 厂商                  | 单价折扣  | 最大批大小              | 完成 SLA   | 备注                    |
| ------------------- | ----- | ------------------ | -------- | --------------------- |
| OpenAI Batch        | 50% off | 50K req / 100MB    | 24h（通常更快） | input + output 都打 5 折 |
| Anthropic Batch     | 50% off | 100K req / 256MB   | 24h       | 与 prompt cache 可叠加     |
| Gemini Batch        | 50% off | 不公开                | 24h       | Vertex AI 提供          |
| DeepSeek（峰谷折扣）      | 75% off | -                  | 自然时段     | 北京时间 00:30-08:30 自动便宜 |

**便宜的原理**：厂商可以把这些请求塞进低峰 GPU 时段，提高利用率；用户用延迟换价格。

## 2. OpenAI Batch API 实操

```python
# batch_openai.py
from openai import OpenAI
import json, time

client = OpenAI()

# 1. 准备 batch input（JSONL）
with open("batch_input.jsonl", "w") as f:
    for i, item in enumerate(items):
        f.write(json.dumps({
            "custom_id":  f"req-{i}",
            "method":     "POST",
            "url":        "/v1/chat/completions",
            "body": {
                "model":     "gpt-5-mini",
                "messages":  [{"role": "user", "content": item["prompt"]}],
                "max_tokens": 500,
            }
        }) + "\n")

# 2. 上传文件
file = client.files.create(
    file=open("batch_input.jsonl", "rb"),
    purpose="batch",
)

# 3. 创建 batch job
batch = client.batches.create(
    input_file_id=file.id,
    endpoint="/v1/chat/completions",
    completion_window="24h",
    metadata={"job": "nightly-summary-2026-05-11"},
)
print("Batch:", batch.id)

# 4. 轮询状态
while True:
    b = client.batches.retrieve(batch.id)
    print(b.status, b.request_counts)
    if b.status in ("completed", "failed", "expired", "cancelled"):
        break
    time.sleep(60)

# 5. 下载结果
out = client.files.content(b.output_file_id)
for line in out.text.splitlines():
    rec = json.loads(line)
    custom_id = rec["custom_id"]
    response  = rec["response"]["body"]["choices"][0]["message"]["content"]
    # 写回业务库
```

**生产 tips：**

- `custom_id` 用业务主键（如 `doc_id`），方便回写。
- 一次别塞太多——单 batch 5K-10K 条最易管理，失败重试容易。
- 跑前先用 100 条样本试跑，确认 schema、output 长度上限。
- 失败行单独在 `error_file_id` 文件里——一定要处理，不然丢数据。

## 3. Anthropic Batch + prompt cache 叠加

Anthropic 的 batch 5 折和 prompt cache 可以**同时生效**——单价能压到 list 的 5-10%：

```python
import anthropic

client = anthropic.Anthropic()

requests = []
for doc in documents:
    requests.append({
        "custom_id": f"doc-{doc.id}",
        "params": {
            "model": "claude-sonnet-4-5",
            "max_tokens": 1000,
            "system": [
                {
                    "type": "text",
                    "text": SHARED_INSTRUCTIONS,    # 在 batch 内复用
                    "cache_control": {"type": "ephemeral"}
                }
            ],
            "messages": [{"role": "user", "content": doc.text}],
        },
    })

batch = client.messages.batches.create(requests=requests)

# 轮询、下载（API 类似）
```

**算账**（处理 1M 篇文档，每篇 input 2000 / output 300，Sonnet 4.5）：

```
不开 batch、不开 cache：
  input: 1M × 2000 × $3 / 1e6 = $6,000
  output: 1M × 300 × $15 / 1e6 = $4,500
  合计 $10,500

开 batch（5 折）：
  $10,500 × 0.5 = $5,250

开 batch + cache（system 200 token cache hit 80%）：
  shared system 200 token：第一次写入贵 1.25x
  之后命中按 0.1x
  effective cost ≈ $5,250 × (1 - 0.2 × 0.9) = ~$4,300
```

省了 60%。

## 4. DeepSeek 时段折扣（自然 batch）

DeepSeek 的玩法不同：不需要 batch API，**夜间自动 5-75% 折扣**：

| 时段（北京时间）         | 折扣                  |
| ---------------- | ------------------- |
| 00:30 - 08:30    | input/output 各 25-75% off |
| 08:30 - 00:30    | 标准价                  |

**业务做法**：

- 夜间跑离线任务（数据预处理、内容预生成、报告生成）。
- 队列累积 + cron 触发：

```python
# nightly_worker.py
import asyncio, datetime as dt

async def nightly_pump():
    now = dt.datetime.now(dt.timezone(dt.timedelta(hours=8)))
    if not (dt.time(0, 30) <= now.time() <= dt.time(8, 30)):
        return
    # 从队列取 pending 任务，并发跑
    tasks = await fetch_pending(limit=10_000)
    await asyncio.gather(*(process(t) for t in tasks))
```

## 5. Async batching（在线请求的伪 batch）

在线请求要秒级返回，但**多个用户在同一秒内的请求可以拼 batch**——通过等待 50-200ms 把队列里的请求打包成一次调用。

适合：embedding 批量、rerank 批量、自部署模型推理（vLLM 自带 continuous batching）。

**API 场景不适用**——商业 API 一次 chat completion 就是单个对话，没有 batch 接口（batch API 是离线的）。但 embedding 接口支持一次多条：

```python
# embedding 在线 micro-batch
import asyncio
from openai import AsyncOpenAI

oai = AsyncOpenAI()
queue: asyncio.Queue = asyncio.Queue()

async def collector():
    while True:
        batch = []
        try:
            item = await asyncio.wait_for(queue.get(), timeout=0.05)  # 等 50ms
            batch.append(item)
            while len(batch) < 100:
                try:
                    batch.append(queue.get_nowait())
                except asyncio.QueueEmpty:
                    break
        except asyncio.TimeoutError:
            continue
        if not batch:
            continue
        # 批量 embed
        resp = await oai.embeddings.create(
            model="text-embedding-3-small",
            input=[b.text for b in batch],
        )
        for b, e in zip(batch, resp.data):
            b.future.set_result(e.embedding)

async def embed_one(text: str) -> list[float]:
    fut = asyncio.get_event_loop().create_future()
    await queue.put(type("Item", (), {"text": text, "future": fut})())
    return await fut
```

**收益**：embedding 一次调 100 条比调 100 次少 3-5x 网络 RTT + 厂商 RPS 限速宽松。

## 6. 何时不该用 batch

不是所有任务都该 batch：

| 场景               | 用 batch？ | 理由                |
| ---------------- | ------- | ----------------- |
| 用户实时聊天           | ✗       | 24h 等不了           |
| 夜间报表             | ✓       | 24h 内够用，省一半       |
| Agent 多步思考       | ✗       | 步骤间强依赖            |
| 全量文档 embedding   | ✓       | 离线，一次性            |
| 增量文档 embedding   | △       | 看延迟需求，可 micro-batch |
| 内容审核（实时上传时）      | ✗       | 用户等结果             |
| 离线视频字幕生成         | ✓       | 完美场景              |
| A/B 评估批量 inference | ✓       | 评估不要实时            |

## 7. Batch + 工作队列：生产化设计

把 batch 变成可运行的管线：

```
Pending Task（DB / Kafka）
   ↓
Aggregator（每 5 分钟 / 1 小时拉一波）
   ↓
Chunker（拆成每批 5K-10K）
   ↓
Submit Batch API
   ↓
Webhook / Poller 监控 batch.status
   ↓
Result Fetcher（下载 output_file）
   ↓
Writeback（按 custom_id 写回业务表）
   ↓
Dead-letter（错误行单独处理）
```

**简化 SQL 表结构：**

```sql
CREATE TABLE batch_job (
  job_id         UUID PRIMARY KEY,
  provider       VARCHAR(32),
  external_id    VARCHAR(128),         -- 厂商 batch_id
  status         VARCHAR(32),          -- 'pending' | 'submitted' | 'completed' | 'failed'
  task_count     INT,
  submitted_at   TIMESTAMP,
  completed_at   TIMESTAMP,
  cost_usd       DECIMAL(12,4),
  meta           JSONB
);

CREATE TABLE batch_task (
  task_id        UUID PRIMARY KEY,
  job_id         UUID REFERENCES batch_job,
  custom_id      VARCHAR(128),
  status         VARCHAR(32),
  input          JSONB,
  output         JSONB,
  error          JSONB,
  retry_count    INT DEFAULT 0
);

CREATE INDEX idx_task_status_job ON batch_task(status, job_id);
```

## 8. 算账：什么场景节省最大

| 场景                                | 月调用量    | 不优化   | + batch | + batch + cache | 节省      |
| --------------------------------- | ------- | ----- | ------- | --------------- | ------- |
| 夜间 1000 份长文档总结（input 5K / out 800） | ~30K    | $5K   | $2.5K   | $1.8K           | 64%     |
| 全库 embedding（一次性）                  | 100M doc | $2K   | $1K     | -               | 50%     |
| 历史数据回流分类                          | 10M req | $80K  | $40K    | $28K            | 65%     |
| 内容审核（实时）                          | 10M req | $80K  | -       | -               | 0（不能 batch） |

## 9. Batch 的失败处理

Batch 失败有两种：

1. **整批失败**（quota / file 格式 / API key 失效）：重新提交。
2. **行级失败**（个别 prompt 太长 / 内容违规）：只重跑失败行。

```python
# 失败处理
result_file = client.files.content(batch.output_file_id)
error_file  = client.files.content(batch.error_file_id) if batch.error_file_id else None

successes, retries = [], []
for line in result_file.text.splitlines():
    rec = json.loads(line)
    if rec["response"]["status_code"] == 200:
        successes.append(rec)
    elif rec["error"]["code"] in ("rate_limit_exceeded", "server_error"):
        retries.append(rec["custom_id"])    # 可重试
    else:
        # 业务 / 内容错误，丢 DLQ
        dlq.put(rec)

if retries:
    resubmit(retries)
```

## 10. 真实案例：把 batch 从 0 用到承担 60% 流量

某内容生成 SaaS，2026 Q2 改造前后：

| 阶段        | 流量构成                                  | 月成本    |
| --------- | ------------------------------------- | ------ |
| 改造前        | 100% 实时（Sonnet）                       | $42K   |
| 改造后        | 40% 实时（Sonnet）+ 60% batch（Sonnet）      | $25K   |
| 二期        | 40% 实时 + 60% batch + 高频 prefix cache | $18K   |

**关键产品决策**：把「立即生成」改成「24 小时内交付」（用户提交时显示进度条），用户接受率 85%。这一改产品形态的小改动让 batch 比例上去。

## 常见坑

1. **batch 跑得早不一定快**——24h SLA 是上限，多数 < 1h 完成；但峰值时间 batch 可能排队 > 6h，关键任务别压线提交。
2. **output_file 不下载就过期**——多数厂商 30 天清理 batch 结果文件，长留要自己拷走。
3. **custom_id 没设业务键**——下载结果用顺序匹配，错位一行整批失序。永远用业务键。
4. **prompt cache 没在 batch 里复用**——以为 batch 内 cache 不生效；其实多数厂商支持，要测一下。
5. **batch 失败不监控**——以为提交完就万事大吉，过两天发现整批 expired，数据没回流。要有 webhook 或定时巡检。
6. **把实时业务硬塞 batch**——为了省钱让用户等 6 小时，留存暴跌。先算清产品形态成本。
7. **batch 大小不分块**——一次 50K 行，失败重跑代价大；分块后单块失败影响小。
8. **没限制 batch 并发**——一次提交 20 个 50K batch，触发账户级并发限制，全部失败。

## 下一步

- 自部署模型对 batch 不敏感（continuous batching 自动） → [06 · 量化与自部署经济性](./06-quantization-economics.md)
- batch 出来的结果存哪、监控状态 → [09 · 成本监控](./09-cost-monitoring.md)
- 离线 batch 评估 → [../eval/](../eval/)
- vLLM 自带 batching → [../llm-inference/02-key-concepts.md](../llm-inference/02-key-concepts.md)
- OpenAI Batch 官方文档 → <https://platform.openai.com/docs/guides/batch>
- Anthropic Batch 官方文档 → <https://docs.anthropic.com/claude/docs/batch-api>
