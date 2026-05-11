# 04 · Prompt cache 系统设计

Prompt cache 是 2024 年以来商业 API 给出的**最大单点降本红利**——命中部分单价砍 50-90%，TTFT 也跟着掉。但 cache 不是开关一拨就有效：prompt 结构、动态部分位置、TTL 都决定命中率。本章讲三大厂商实现差异、prompt 重构方法、命中率监控、自建语义 cache 的接合点。

## 1. 三大厂商 prompt cache 对照

| 维度          | OpenAI                  | Anthropic                       | DeepSeek                | Gemini                       |
| ----------- | ----------------------- | ------------------------------- | ----------------------- | ---------------------------- |
| 触发方式        | 自动（≥ 1024 token prefix） | 显式 `cache_control` block        | 自动                      | 显式 cached content              |
| 命中折扣        | 50% off                 | 90% off                         | 90% off                 | 75% off                       |
| TTL          | ~5-10 分钟（无 SLA）          | 默认 5 分钟，1 小时档贵 25%               | ~1 小时                  | 显式 TTL，按存储计费                  |
| 最小可缓存       | 1024 token              | 1024 token（Haiku 2048）          | 不公开（实测 ≥ 几百 token）      | 32K token                    |
| 写入成本        | 无                       | 写入贵 25%                          | 无                       | 按 GB-hour                     |
| 查询粒度        | 整 prompt prefix          | 多 cache breakpoint（≤ 4）          | prefix                  | 整段                            |
| 适用模型        | 全系                       | Sonnet 4.5 / Haiku 4.5 / Opus    | V3 / V3.2                | Gemini 2.5 系列                 |

**最关键差异**：

- **OpenAI**：开箱即用，无需改代码；但折扣只有 5 折。
- **Anthropic**：要写 `cache_control`，但 1 折 + 多 breakpoint 灵活度极高，是降本天花板。
- **Gemini**：按存储计费的「显式缓存」适合**长 context 反复用**（如代码库分析），不适合短 TTL 场景。

## 2. Prompt 结构改造：把固定内容前置

cache 都按 **prefix** 匹配，所以**变化内容必须放后面**：

```python
# 错误：tenant 名字在 system 中间，导致整段不能复用
system = f"""你是 {tenant_name} 的客服助手。
以下是知识库：
{knowledge_base_5000_tokens}
请用礼貌的语气回答..."""

# 正确：把可变项放最后或拆 message
system = f"""你是一个客服助手。
以下是知识库：
{knowledge_base_5000_tokens}
请用礼貌的语气回答..."""
extra_context = f"当前服务的客户：{tenant_name}"

messages = [
    {"role": "system", "content": system},     # 这部分可命中 cache
    {"role": "user",   "content": extra_context + "\n\n" + user_question},
]
```

**重构 checklist：**

1. 系统提示、工具定义、knowledge base → 放最前（cacheable）。
2. Few-shot examples → 紧跟系统提示（cacheable）。
3. 长 RAG context → 中段；如果 chunk 顺序稳定就 cacheable，每次变就不行。
4. 用户消息 + 当前 turn 上下文 → 最后（每次不同）。

## 3. Anthropic 显式 cache_control 用法

Anthropic 的 cache 是显式的，但灵活度最高（最多 4 个 breakpoint）：

```python
from anthropic import Anthropic
client = Anthropic()

response = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=1000,
    system=[
        {
            "type": "text",
            "text": SYSTEM_INSTRUCTIONS,        # 较短、几乎不变
        },
        {
            "type": "text",
            "text": KNOWLEDGE_BASE,             # 8K token，少变
            "cache_control": {"type": "ephemeral"}    # breakpoint #1
        },
        {
            "type": "text",
            "text": TOOL_DEFINITIONS,           # 3K token，几乎不变
            "cache_control": {"type": "ephemeral"}    # breakpoint #2
        },
    ],
    messages=[
        {"role": "user", "content": user_question}    # 这部分每次都变
    ],
)

# 看命中率
print(response.usage)
# Usage(input_tokens=200,
#       cache_creation_input_tokens=0,
#       cache_read_input_tokens=11000,
#       output_tokens=300)
```

**3 个细节**：

1. `cache_creation_input_tokens`：第一次写入，按 1.25x 计价。
2. `cache_read_input_tokens`：命中，按 0.1x 计价。
3. TTL 5 分钟从「最后一次命中」起算——只要持续有流量，cache 一直续命。

**1 小时 TTL** 的开关（贵 2x 写入，命中价不变）：

```python
"cache_control": {"type": "ephemeral", "ttl": "1h"}
```

适合「每天访问几次但量大」的场景，例如夜间分析任务。

## 4. 命中率监控

不监控就不知道 cache 在不在工作。关键指标：

```python
# observability.py
from dataclasses import dataclass

@dataclass
class CacheStats:
    fresh_input: int
    cache_creation: int
    cache_read: int
    output: int

    @property
    def hit_rate(self) -> float:
        total = self.fresh_input + self.cache_creation + self.cache_read
        return self.cache_read / total if total else 0.0

    @property
    def cost_usd(self, p_in=3.0, p_create=3.75, p_read=0.30, p_out=15.0):
        return (
            self.fresh_input    * p_in     / 1e6
          + self.cache_creation * p_create / 1e6
          + self.cache_read     * p_read   / 1e6
          + self.output         * p_out    / 1e6
        )
```

```sql
-- 每天看 hit rate 走势
SELECT
  date_trunc('day', ts)                          AS day,
  SUM(cached_input_tokens)                        AS cache_read,
  SUM(input_tokens - cached_input_tokens)         AS fresh,
  SUM(cache_creation_tokens)                      AS cache_write,
  SUM(cached_input_tokens) * 1.0 /
    NULLIF(SUM(input_tokens), 0)                  AS hit_rate,
  SUM(total_cost_usd)                              AS cost
FROM llm_usage_log
WHERE ts >= now() - interval '30 days'
GROUP BY 1
ORDER BY 1 DESC;
```

| 期望命中率（按场景）   |        |
| ------------ | ------ |
| 客服 / FAQ 类   | 70-90% |
| 代码助手          | 50-70% |
| 多轮长对话         | 60-85% |
| 一次性总结          | 0-10%  |
| Agent 工具调用    | 40-60% |

如果某场景命中率持续 < 30%，说明 prompt 结构有问题（动态部分在前 / 上下文变化太频繁）。

## 5. 自建语义 cache：和 prompt cache 互补

Prompt cache 命中条件是「字符级 prefix 匹配」，但用户问「怎么退货」和「我要退东西」是同一个意图，**语义 cache 能命中**：

```python
# semantic_cache.py
import redis, hashlib
import numpy as np
from openai import OpenAI

r = redis.Redis()
oai = OpenAI()

def embed(text: str) -> list[float]:
    return oai.embeddings.create(
        model="text-embedding-3-small",
        input=text,
    ).data[0].embedding

def semantic_get(query: str, threshold: float = 0.93):
    q_vec = np.array(embed(query))
    # 用 Redis Vector Search（RediSearch 模块）
    results = r.execute_command(
        "FT.SEARCH", "idx:cache",
        f"*=>[KNN 1 @vec $vec AS score]",
        "PARAMS", "2", "vec", q_vec.astype(np.float32).tobytes(),
        "DIALECT", "2",
    )
    if results and float(results[2][-1]) >= threshold:
        return results[2][1]   # cached response
    return None

def semantic_put(query: str, response: str, ttl: int = 3600):
    q_vec = np.array(embed(query))
    key = f"cache:{hashlib.sha256(query.encode()).hexdigest()[:16]}"
    r.hset(key, mapping={
        "query":    query,
        "response": response,
        "vec":      q_vec.astype(np.float32).tobytes(),
    })
    r.expire(key, ttl)
```

**threshold 怎么选**：太低（< 0.90）误命中（语义相近但答案该不同），太高（> 0.97）几乎不命中。推荐 0.93-0.95 起步，做 A/B 微调。

## 6. Prompt cache + 语义 cache 联合策略

最佳实践是**两层 cache**：

```
请求来了
  ↓
[L1: 语义 cache 查询]
  ├─ 命中 → 直接返回（成本 ~$0.0001，仅 embedding）
  └─ 未命中
       ↓
     [L2: 调 LLM API（带 prompt cache 命中）]
       ↓
     [L1 写入：把 query → response 存进语义 cache]
       ↓
     返回
```

**实算收益**（客服 chatbot，1M req / 月）：

| 配置                              | 单次平均成本   | 月成本     |
| ------------------------------- | -------- | ------- |
| 无优化                              | $0.029   | $29,000 |
| Prompt cache（命中 70%）             | $0.0085  | $8,500  |
| Prompt cache + 语义 cache（命中 30%） | $0.0061  | $6,100  |

语义 cache 再砍 30% 左右。**注意**：语义 cache 只对「问相似问题答相同回答」的场景有效——agentic / 个性化场景不适用。

## 7. Cache 失效与一致性

**Cache 是双刃剑**：知识库更新了，cache 还在返回旧答案。处理方式：

| 失效策略         | 适用             | 实现复杂度 |
| ------------ | -------------- | ----- |
| TTL 自动过期      | 一般信息（FAQ）      | 低     |
| 显式 invalidate | 知识库更新有事件触发     | 中     |
| 版本号 prefix   | 多版本灰度并存       | 中     |
| 写时清除         | 数据强一致需求       | 高     |

**版本号 prefix 模式**：

```python
KB_VERSION = "kb_v123"  # 知识库每次更新换版本号

system_prompt = f"""[{KB_VERSION}]
你是一个客服助手...
{knowledge_base}"""
```

prefix 一变，prompt cache 自动重新建。语义 cache key 加 `kb_version` namespace 即可。

## 8. Gemini Context Caching：长 context 专用

Gemini 的显式缓存有自己的玩法——按存储 GB-hour 计费，不是按命中折扣：

```python
from google import genai

client = genai.Client()

# 1. 先把大 context 写入 cache
cache = client.caches.create(
    model="gemini-2.5-flash",
    config={
        "contents": [LARGE_CODEBASE_OR_DOC],   # 1M token 都行
        "system_instruction": SYSTEM,
        "ttl": "3600s",
    },
)

# 2. 后续调用引用 cache_name
response = client.models.generate_content(
    model="gemini-2.5-flash",
    contents="Summarize what changed in this codebase.",
    config={"cached_content": cache.name},
)
```

**适合：** 一份 1M token 的代码库 / 长 PDF，1 小时内被反复 query。**不适合：** 多租户、短 prompt 重复——存储费会反过来吃掉收益。

**算账：** Gemini 2.5 Pro context cache 存储 ≈ $1.00 / 1M token / hour。如果一份 100K token 文档 1 小时内被查 < 10 次，自建 prompt cache 更划算。

## 9. 真实案例：客服 SaaS 把命中率从 40% 提到 88%

某 B2B 客服 SaaS，2026 Q1 优化报告（脱敏）：

| 阶段              | 调整                                     | 命中率   | 月成本     |
| --------------- | -------------------------------------- | ----- | ------- |
| 初始              | 没用 cache_control，OpenAI 自动 cache       | 40%   | $48,000 |
| 阶段 1            | 切到 Anthropic + 显式 cache_control       | 65%   | $22,000 |
| 阶段 2            | 重构 prompt：tenant_name 后置，knowledge 前置  | 78%   | $14,500 |
| 阶段 3            | 加 1 小时 TTL（夜间低峰也保 cache 活）              | 85%   | $11,800 |
| 阶段 4            | 加语义 cache 兜底高频 FAQ                      | 88% (含语义命中) | $9,200  |

**关键动作**：

1. 不是「调一下参数」，是 prompt 结构重构。
2. 命中率监控 + dashboard 比节省下来的钱重要——没监控你不知道每一步效果。
3. 上线后做了 1 周 eval 对比，确认效果不掉。

## 常见坑

1. **可变内容放在固定内容前面**——cache prefix 永远从头匹配，可变项在前等于完全失效。
2. **忘了 cache_creation 比 base 还贵**——Anthropic 第一次写入 1.25x，命中率 < 30% 时反而更贵。要么命中率高要么别开。
3. **TTL 不够长导致频繁重建**——业务凌晨低峰 5 分钟没流量，cache 全部过期，早上一波流量 cache 全重建，账单尖刺。1h TTL 或预热 keepalive。
4. **不版本化 cache key**——知识库更新了，cache 还在返回旧答案，用户报 bug 排查到怀疑人生。
5. **语义 cache threshold 太松**——不同意图问题命中同一个答案，效果灾难。从 0.95 起步，配合 eval 微调。
6. **没监控命中率**——「应该有命中吧？」上线半年发现根本没命中，钱全浪费。
7. **多模态 cache 不通用**——图片 / 音频 cache 在不同厂商支持参差，提前查文档。
8. **Cache 同时缓存了 PII**——日志里 dump cache 内容时把用户隐私写出去。Cache 内容也要走脱敏管线。

## 下一步

- 把 cache 命中数据上 dashboard → [09 · 成本监控](./09-cost-monitoring.md)
- 离线任务用 batch 拿额外 50% 折扣 → [05 · 批处理](./05-batching.md)
- 缓存系统设计深度展开 → [07 · 缓存设计](./07-semantic-cache.md)
- 验证 cache 不损害效果 → [../eval/](../eval/)
- Prompt 改写技巧细节 → [../prompt-engineering/](../prompt-engineering/)
- Anthropic 官方 cache 指南 → <https://docs.anthropic.com/claude/docs/prompt-caching>
