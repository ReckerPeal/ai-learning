# 07 · 缓存设计

[第 4 章](./04-prompt-cache.md) 讲的是**厂商提供的 prompt cache**——你只需调整 prompt 结构就能拿到 50-90% 折扣。本章讲**自建缓存**：精确缓存（exact match）、语义缓存（semantic）、上下文缓存、负缓存，以及它们的命中策略与失效设计。这是 prompt cache 之外**再砍一刀**的工程手段。

## 1. 缓存层次：四种类型一张表

| 类型              | 匹配条件                | 命中率（典型） | 成本影响      | 一致性风险 |
| --------------- | ------------------- | ------- | --------- | ----- |
| Exact match     | hash(prompt) == hit | 5-20%   | 100% 砍掉 LLM | 低     |
| Semantic        | embedding 相似度 ≥ 阈值 | 20-40%  | 100% 砍掉 LLM | 中     |
| Prefix cache（自部署） | 共享前缀 prefill 复用 | 50-80%  | 砍 prefill 部分 | 低 |
| 厂商 prompt cache  | prefix 字符匹配         | 50-90%  | 砍 50-90% 折扣 | 低     |

四种**可以叠加**——一次请求依次走 exact → semantic → prompt cache → LLM。

## 2. Exact-match cache：最简单也最稳

适合**deterministic** 场景（同样 prompt 永远同答案，比如分类、抽取）：

```python
# exact_cache.py
import hashlib, json, redis

r = redis.Redis()

def cache_key(model: str, prompt: str, params: dict) -> str:
    payload = json.dumps({"m": model, "p": prompt, **params}, sort_keys=True)
    return "llm:exact:" + hashlib.sha256(payload.encode()).hexdigest()

def get_or_call(model, prompt, params, ttl=86400):
    key = cache_key(model, prompt, params)
    cached = r.get(key)
    if cached:
        return json.loads(cached), True   # hit
    # miss → 调 LLM
    resp = llm_call(model, prompt, **params)
    r.setex(key, ttl, json.dumps(resp))
    return resp, False
```

**适合 / 不适合**：

- ✅ 分类任务、结构化抽取、固定问答 FAQ。
- ✅ Temperature = 0、deterministic 工具调用。
- ❌ 创意写作、对话上下文长（一字之差就 miss）。

**命中率经验值**：

- FAQ / 客服 deterministic 部分：15-25%。
- 实时聊天：< 5%。
- 内部工具（如 SQL 生成、代码 lint）：30-50%。

## 3. Semantic cache：用 embedding 找近似 hit

```python
# semantic_cache.py
import numpy as np
from typing import Optional
from openai import OpenAI

oai = OpenAI()
EMB_MODEL = "text-embedding-3-small"     # $0.02 / M token，便宜

class SemanticCache:
    def __init__(self, threshold: float = 0.93, ttl: int = 3600):
        self.threshold = threshold
        self.ttl = ttl
        # 用 Redis Stack（RediSearch + HNSW）做向量索引

    def get(self, query: str, namespace: str = "default") -> Optional[str]:
        q_vec = self._embed(query)
        # KNN 查询
        results = r.execute_command(
            "FT.SEARCH", f"idx:{namespace}",
            "*=>[KNN 1 @vec $vec AS score]",
            "PARAMS", "2", "vec", q_vec.tobytes(),
            "RETURN", "2", "response", "score",
            "DIALECT", "2",
        )
        if results[0] >= 1:
            score = 1 - float(results[2][3])   # cosine distance → similarity
            if score >= self.threshold:
                return results[2][1].decode()
        return None

    def put(self, query: str, response: str, namespace: str = "default"):
        q_vec = self._embed(query)
        key = f"sem:{namespace}:{hashlib.sha256(query.encode()).hexdigest()[:16]}"
        r.hset(key, mapping={
            "query":    query,
            "response": response,
            "vec":      q_vec.tobytes(),
        })
        r.expire(key, self.ttl)

    def _embed(self, text: str) -> np.ndarray:
        e = oai.embeddings.create(model=EMB_MODEL, input=text).data[0].embedding
        return np.array(e, dtype=np.float32)
```

**Redis 索引创建**：

```
FT.CREATE idx:default ON HASH PREFIX 1 sem:default: SCHEMA
  query    TEXT
  response TEXT
  vec      VECTOR HNSW 6
    TYPE FLOAT32
    DIM 1536
    DISTANCE_METRIC COSINE
```

**阈值的选择**：

| threshold | 命中率 | 错命中风险          | 适用场景              |
| --------- | --- | -------------- | ----------------- |
| 0.99      | 极低  | 几乎为 0          | 接近 exact，不实用      |
| 0.95-0.97 | 中   | 低              | 客服 FAQ 谨慎场景       |
| 0.92-0.94 | 中高  | 中               | 一般 FAQ、知识问答      |
| 0.85-0.90 | 高   | 高（可能答非所问）      | 不建议生产用            |

**用 eval 调阈值**：拿 100 对（query → expected_response）做矩阵，看不同阈值下的精度 / 召回。

## 4. 缓存键的设计：namespace 与版本

缓存数据耦合业务维度，**key 设计决定可维护性**：

```python
def build_namespace(tenant_id: str, feature: str, kb_version: str, model: str):
    return f"{tenant_id}:{feature}:{kb_version}:{model}"

# 例：
# "tenant_acme:faq:kb_v123:claude-sonnet-4-5"
# 知识库更新 → bump kb_version → 整个 namespace 自动失效（不必显式删）
```

**namespace 维度建议**：

- 必带：`tenant_id`（不同租户不能共享 cache）、`model`（不同模型回答风格不同）。
- 强烈建议：`kb_version` / `prompt_version`（业务版本变化触发失效）。
- 可选：`feature`（按业务功能拆分，便于命中率分析）。
- 不要带：用户 ID（粒度太细，命中率几乎为零）。

## 5. 失效策略：TTL + 主动 invalidate

```python
# invalidator.py
def on_knowledge_base_update(tenant_id: str, new_version: str):
    # 不删旧 cache，让 TTL 自然过期（节省 Redis 写入）
    # 只更新 namespace 版本号，新请求走新 namespace
    r.set(f"meta:{tenant_id}:kb_version", new_version)

def on_prompt_template_update(feature: str):
    # 类似处理
    r.set(f"meta:{feature}:prompt_version", new_version)

# 强一致场景（如政策回答更新）：显式 SCAN + DEL
def hard_invalidate(namespace: str):
    cursor = 0
    while True:
        cursor, keys = r.scan(cursor, match=f"sem:{namespace}:*", count=1000)
        if keys:
            r.delete(*keys)
        if cursor == 0:
            break
```

**TTL 默认值参考**：

| 场景         | TTL                        |
| ---------- | -------------------------- |
| 静态 FAQ      | 7-30 天                    |
| 知识库问答      | 1-7 天（看更新频率）              |
| 个性化内容      | 1-6 小时                    |
| 多轮对话上下文    | 1-24 小时（看会话生命周期）          |
| Agent 工具结果 | 不缓存（结果一变就错），或 < 5 分钟    |

## 6. GPTCache：开源全家桶

不想自己造轮子用 GPTCache，自带 exact + semantic + 多 backend：

```python
# gptcache_example.py
from gptcache import cache
from gptcache.adapter import openai
from gptcache.embedding import OpenAI as EmbOpenAI
from gptcache.manager import CacheBase, VectorBase, get_data_manager
from gptcache.similarity_evaluation.distance import SearchDistanceEvaluation

embedding = EmbOpenAI()
data_manager = get_data_manager(
    CacheBase("redis", url="redis://localhost:6379/0"),
    VectorBase("milvus", host="localhost", dimension=embedding.dimension),
    max_size=1_000_000,
)

cache.init(
    embedding_func=embedding.to_embeddings,
    data_manager=data_manager,
    similarity_evaluation=SearchDistanceEvaluation(),
)
cache.set_openai_key()

# 用法：完全兼容 openai SDK
response = openai.ChatCompletion.create(
    model="gpt-5-mini",
    messages=[{"role": "user", "content": "解释 transformer"}],
)
```

**GPTCache 优势**：

- 多种 cache backend（Redis / SQLite / MySQL）+ 多种 vector store（Milvus / Faiss / Pinecone）。
- 内置相似度评估、命中率统计。
- 与 OpenAI / LangChain SDK 无缝。

**生产 caveat**：

- 不直接支持 Anthropic / Gemini，要写 adapter。
- 默认 threshold 偏松，必须自己调。

## 7. 缓存命中率监控

```sql
-- 每天每特征命中率
SELECT
  date_trunc('day', ts) AS day,
  feature,
  COUNT(*) FILTER (WHERE cache_hit_type = 'exact')    AS exact_hits,
  COUNT(*) FILTER (WHERE cache_hit_type = 'semantic') AS semantic_hits,
  COUNT(*) FILTER (WHERE cache_hit_type = 'prompt')   AS prompt_hits,
  COUNT(*) FILTER (WHERE cache_hit_type IS NULL)      AS misses,
  COUNT(*)                                             AS total,
  ROUND(100.0 * COUNT(*) FILTER (WHERE cache_hit_type IS NOT NULL) / COUNT(*), 2)
                                                       AS hit_rate_pct,
  SUM(total_cost_usd)                                   AS cost
FROM llm_usage_log
WHERE ts >= now() - interval '7 days'
GROUP BY 1, 2
ORDER BY 1 DESC, 2;
```

**告警阈值**：

- 命中率突降 > 30%：可能是 prompt 改了 / cache key 改了 / Redis 故障。
- 命中率持续 < 期望值的一半：阈值太严 or namespace 太细。

## 8. 负缓存（negative caching）：错误也要 cache

LLM 调用失败 / 超时也要 cache 短 TTL，避免雪崩：

```python
class CallResult:
    success: bool
    response: Optional[str]
    error: Optional[str]

def get_or_call_safe(prompt: str):
    key = cache_key(...)
    cached = r.get(key)
    if cached:
        return CallResult(**json.loads(cached))
    try:
        resp = llm_call(prompt, timeout=30)
        r.setex(key, 3600, json.dumps({"success": True, "response": resp}))
        return CallResult(True, resp, None)
    except (TimeoutError, RateLimitError) as e:
        # 短 TTL 负缓存：30 秒内不再重试同 prompt
        r.setex(key + ":err", 30, str(e))
        raise
```

**好处**：上游故障时一个用户狂刷不会把整个 backend 打挂。

## 9. 上下文 cache：长对话的特例

多轮对话的 cache 难做（上下文每轮都在变），常见做法：

| 策略              | 实现                          | 收益               |
| --------------- | --------------------------- | ---------------- |
| 系统消息 + 知识库 cache | 用 prompt cache 命中前 N token | 5-10K token 砍 90% |
| Conversation summary | 多轮压缩到摘要，摘要做 cache key  | 砍 input token 量  |
| 按 turn 切片        | 每轮单独 cache，组合时合并          | 命中率高但复杂          |

**实操**：80% 团队只做前两层就够；turn-level cache 设计复杂度高，收益边际。

## 10. 真实案例：B2B 知识库 SaaS 的缓存策略

```
请求流入
   ↓
[L0：URL / API 层 cache]  HTTP 304 等场景，几乎零成本
   ↓
[L1：Exact match cache]   Redis hash，TTL 1h
   命中：直接返回
   ↓
[L2：Semantic cache]      embedding + KNN，threshold 0.94
   命中：直接返回
   ↓
[L3：调 LLM（带 prompt cache）]
   Anthropic prompt cache 命中部分 1 折
   ↓
[L4：异步写入 L1 + L2]
   ↓
返回
```

**实测命中分布**（每月 500 万次请求）：

| 层               | 命中率  | 每次节省成本   | 月节省      |
| --------------- | ---- | -------- | -------- |
| L1 exact         | 12%   | $0.012   | $7,200   |
| L2 semantic      | 22%   | $0.012   | $13,200  |
| L3 prompt cache  | 50%（剩下 66% 流量中命中）   | $0.008  | $13,200  |
| 未命中（实际调 LLM）   | 16%   | -        | $9,600（成本） |
| **总成本**          | -    | -        | $9,600   |
| **如果无 cache**     | -    | -        | $60K     |

整体降本 84%。

## 常见坑

1. **threshold 太低导致错命中**——用户问「订单怎么取消」命中「订单怎么修改」的答案，客诉激增。从 0.95 起步谨慎调。
2. **没按 tenant 隔离**——A 公司的私有数据被 cache 给 B 公司，安全事故。namespace 必带 tenant_id。
3. **cache 没限大小**——Redis 撑爆 OOM，业务全挂。设 max-memory + LRU 淘汰。
4. **embedding 模型升级没刷 cache**——新老 embedding 向量空间不同，命中率掉到 0。embedding 模型变化等同知识库版本变化。
5. **不监控命中率**——上线后从来没人看，半年发现根本没在命中。
6. **同步写 cache 影响首字延迟**——写 cache 用异步队列，主链路不等。
7. **cache key 包含时间戳**——昨天的 cache 今天 miss，命中率永远 0。key 里不要含变化项。
8. **Cache 内容把 PII 写进 Redis**——审计 / 合规问题。要么 PII 脱敏，要么 cache 加密 + 限制访问。

## 下一步

- 把 cache 配套限流避免被刷穿 → [08 · 限流与配额](./08-rate-limiting.md)
- 命中率上 dashboard → [09 · 成本监控](./09-cost-monitoring.md)
- 厂商 prompt cache 与本章 cache 联动 → [04 · Prompt cache 系统设计](./04-prompt-cache.md)
- 真实规模案例 → [10 · 规模化案例](./10-scaling-case.md)
- 评估 cache 是否影响效果 → [../eval/](../eval/)
- GPTCache 项目 → <https://github.com/zilliztech/GPTCache>
- Redis Vector Search 文档 → <https://redis.io/docs/stack/search/reference/vectors/>
