# 02 · Token 经济

「为什么这个对话花了 8 分钱」「100 万 DAU 估算月成本是多少」——回答这些问题不靠拍脑袋，靠**单位经济模型**。本章把 token 价格、token 量、单位经济这三件事讲清，给一套可以套到任何场景的计算器。

## 1. 2026 跨模型价格对照表

价格变得很快（厂商之间几乎每季度互砍一次），下表为 2026 上半年的 list price 量级参考。决策时务必去官方页核对。

| 模型                       | $/1M input | $/1M cached input | $/1M output | 上下文窗口 | 备注              |
| ------------------------ | ---------- | ----------------- | ----------- | ----- | --------------- |
| **OpenAI**               |            |                   |             |       |                 |
| GPT-5                    | $2.50      | $1.25 (auto)       | $10.00      | 400K  | 旗舰             |
| GPT-5 mini               | $0.25      | $0.13              | $1.00       | 400K  | 性价比之王          |
| GPT-5 nano               | $0.05      | $0.025             | $0.40       | 400K  | 极便宜             |
| o3 (reasoning)           | $2.00      | $1.00              | $8.00       | 200K  | thinking 计 output |
| **Anthropic**            |            |                   |             |       |                 |
| Claude Opus 4.5          | $15.00     | $1.50              | $75.00      | 200K  | 顶配，最贵          |
| Claude Sonnet 4.5        | $3.00      | $0.30              | $15.00      | 200K  | 默认主力           |
| Claude Haiku 4.5         | $0.80      | $0.08              | $4.00       | 200K  | 快与便宜           |
| **Google**               |            |                   |             |       |                 |
| Gemini 2.5 Pro           | $1.25      | $0.31              | $10.00      | 2M    | 长上下文之王        |
| Gemini 2.5 Flash         | $0.10      | $0.025             | $0.40       | 1M    | 便宜 + 多模态       |
| Gemini 2.5 Flash-Lite    | $0.04      | $0.01              | $0.30       | 1M    | 极便宜             |
| **国产 / 开源**              |            |                   |             |       |                 |
| DeepSeek V3.2 API        | $0.27      | $0.027             | $1.10       | 128K  | 中文之选           |
| Qwen 3 Max API           | $1.20      | $0.30              | $5.00       | 200K  | 阿里             |
| Llama 3.3 70B (Together) | $0.88      | -                  | $0.88       | 128K  | 自托管开源         |

> 行情快变，本表为 2026 量级参考，不是采购价。

**常见误解：**

- 「贵的一定好」——不是。GPT-5 mini 在很多简单任务上效果接近 GPT-5，但便宜 10 倍。
- 「reasoning 模型贵」——thinking token 全计 output，一次回答 1-3K thinking token 是常态，月度成本可能翻 2-4 倍。
- 「cache 都一样」——OpenAI 自动开 5 折，Anthropic 要显式声明给 1 折，差距巨大。

## 2. 单位经济模型公式

任何 LLM 应用都能套这个公式：

```
月度 LLM 成本
= DAU × QPD × [
      avg_fresh_input  × P_input
    + avg_cached_input × P_cached
    + avg_output       × P_output
    + avg_reasoning    × P_output
  ] × 30 / 1e6
```

其中：

- DAU：日活
- QPD：每用户每日请求数
- P_*：对应的 $/1M token 单价
- avg_*：每次请求平均 token 数（按 token 类型拆开）

**实算示例** —— Sonnet 4.5、70% cache 命中：

```python
def monthly_cost(
    dau: int,
    qpd: int,
    fresh_input: int,
    cached_input: int,
    output: int,
    reasoning: int = 0,
    p_input: float = 3.0,
    p_cached: float = 0.30,
    p_output: float = 15.0,
    days: int = 30,
) -> float:
    """月度 LLM API 成本估算（美元）。"""
    per_req = (
        fresh_input  * p_input  / 1e6
      + cached_input * p_cached / 1e6
      + (output + reasoning) * p_output / 1e6
    )
    return dau * qpd * per_req * days

# 1 万 DAU，5 次 / 天，cache 命中 70%
cost = monthly_cost(
    dau=10_000, qpd=5,
    fresh_input=1200, cached_input=2800, output=400,
)
print(f"${cost:,.0f}/month")   # → ~$13,800/month
```

跑遍不同假设：

| 场景                            | 月成本     |
| ----------------------------- | ------- |
| 不开 cache（4000 全计 fresh）       | $24,000 |
| 开 cache（70% 命中）               | $13,800 |
| 开 cache + 路由 30% 到 Haiku       | ~$9,200 |
| 上面 + batch 50% 折扣              | ~$5,500 |

层层优化下来能省 4-5 倍。

## 3. 什么贵什么省（按业务模式）

| 业务模式             | 主要成本源           | 优化重点              |
| ---------------- | --------------- | ----------------- |
| 客服 / 知识库 chatbot | 长系统消息 + 知识库 input | Prompt cache（命中 80%+） |
| 长文档摘要 / 翻译       | 大 input + 长 output | 切片 + batch         |
| 代码助手             | input 多变 + output 多 | 路由到 code-specialized 模型 |
| Agent 多步工具调用     | 多轮累计 input + 反思 token | 工具调用收敛 + 限步数 |
| RAG QA           | 检索 chunks 拼成 input | Re-rank 砍 chunks 数 |
| 创意写作             | 短 input + 长 output | 已经最贵，让用户自选模型      |
| 实时流式对话           | 短 input + 短 output | 路由到 Flash / Haiku  |
| 多模态分析            | 图片 / 音频 token   | 压缩分辨率，选便宜多模态模型      |

**反直觉一例**：长系统消息 + 短问答（典型客服）总成本，cache 不开 ≈ 80% 都在 input；cache 全开后 ≈ 70% 都在 output。优化重点也要换。

## 4. Token 计数：别用估算，用 tokenizer

Token 数不是字符数 / 4。中文、emoji、代码各有不同膨胀率：

| 内容              | 100 字符 ≈ 多少 token（GPT-4 系列） | Claude 系列 |
| --------------- | ------------------------- | --------- |
| 英文散文            | 20-25 token                | 25-30     |
| 中文              | 60-100 token               | 80-110    |
| 代码（Python）      | 30-40 token                | 35-45     |
| URL / JSON 结构    | 40-60 token                | 50-70     |
| Emoji / 罕用 unicode | 80-150 token             | 80-150    |

**计数代码（生产用）：**

```python
# OpenAI
import tiktoken
enc = tiktoken.encoding_for_model("gpt-5")
n = len(enc.encode(text))

# Anthropic（精确）
from anthropic import Anthropic
client = Anthropic()
n = client.messages.count_tokens(
    model="claude-sonnet-4-5",
    messages=[{"role": "user", "content": text}],
).input_tokens

# Gemini
import google.generativeai as genai
n = genai.GenerativeModel("gemini-2.5-flash").count_tokens(text).total_tokens
```

生产里**不要**用 `len(text) / 4` 这种估算决定限流或预算——中文场景会偏 3 倍以上。

## 5. 价格弹性：选模型的工程方法

不要凭感觉选模型。做一个**性价比矩阵**：

```python
# evaluate.py
import csv
from your_evaluator import score   # 你的 eval（见 ../eval/）

MODELS = [
    ("gpt-5",          2.50, 10.00),
    ("gpt-5-mini",     0.25,  1.00),
    ("claude-sonnet",  3.00, 15.00),
    ("claude-haiku",   0.80,  4.00),
    ("gemini-flash",   0.10,  0.40),
    ("deepseek-v3.2",  0.27,  1.10),
]

results = []
for name, p_in, p_out in MODELS:
    s = score(model=name, dataset="prod_sample_500.jsonl")
    avg_in, avg_out = s.avg_input_tokens, s.avg_output_tokens
    cost = avg_in * p_in / 1e6 + avg_out * p_out / 1e6
    results.append({
        "model": name,
        "quality": s.quality_score,         # 0-1
        "cost_per_req": cost,
        "quality_per_dollar": s.quality_score / cost,
    })

# 排序看「每美元拿到多少效果」
results.sort(key=lambda r: -r["quality_per_dollar"])
csv.DictWriter(open("model_matrix.csv","w"), results[0].keys()).writerows(results)
```

经验：

- 90% 应用场景里，「quality_per_dollar」最高的是 Gemini Flash 或 Claude Haiku。
- 旗舰模型只在「Haiku 做不到 + 多 5% 准确率值这个钱」时再上。

## 6. Prompt 长度的「税」

每多 1000 个固定 input token，月度成本就以可预测的方式上涨：

| DAU × QPD（百万 req / 月） | 多 1K input × Sonnet 4.5（fresh） | 多 1K input × Sonnet 4.5（cached） | 多 1K input × Flash |
| --------------------- | ------------------------------- | -------------------------------- | ------------------ |
| 1M req                | $3,000                          | $300                              | $100                |
| 10M req               | $30,000                         | $3,000                            | $1,000              |
| 100M req              | $300,000                        | $30,000                           | $10,000             |

**结论**：在 10M+ req 规模下，省 1K 系统 prompt 等于一个工程师一年工资。

实操办法：

1. 把固定 system message 全放进 cache（详见 §04）。
2. RAG chunk 数从 8 砍到 4 + 用 re-rank，效果常常不掉。
3. Few-shot examples 改成 fine-tune（input 短了，但增加训练成本，要算账）。
4. Tool definition 大头：把 description 压缩、unused tool 不下发。

## 7. ARPU vs 单位成本：什么时候开始亏

任何 LLM 应用上线前都该算这张表：

| ARPU / 月 | 允许 LLM 成本 / DAU / 月（毛利 60%） | 折算允许 token 量 / DAU / 月 |
| -------- | ------------------------ | ------------------- |
| $5       | $2.00                    | ~600K Sonnet 或 ~5M Haiku |
| $10      | $4.00                    | ~1.3M Sonnet 或 ~10M Haiku |
| $30      | $12.00                   | ~4M Sonnet 或 ~30M Haiku |
| $99      | $40.00                   | ~13M Sonnet         |

如果发现「为了交付价值，每个用户每月得烧 1500K Sonnet token」，定价就得 $10+；继续 $5 定价就在烧 VC 钱。

## 8. 实战：从需求到成本估算

一个真实流程：PM 说「我要做一个 AI 简历筛选 SaaS，B 端按用户次数收费 $0.5/筛选」。

```python
# step 1：拆任务
# - 输入：JD + 简历（PDF 转文本，平均 2500 token）
# - 输出：分数 + 理由（平均 300 token）
# - 模型：先试 Sonnet 4.5

# step 2：估单次成本（不开 cache）
cost_per = 2500 * 3.0 / 1e6 + 300 * 15.0 / 1e6
# = 0.0075 + 0.0045 = $0.012/次

# step 3：毛利
gross_per = 0.5 - 0.012
# = $0.488/次，毛利率 97.6%

# step 4：开 cache（JD 在批量筛选时复用）
# 假设 1 个 JD 对应 100 份简历，JD 占 1500 input token，命中 99 次
cached_per = (
    (1500 * 0.30 + 1000 * 3.0) / 1e6   # 1500 cached + 1000 fresh
  + 300 * 15.0 / 1e6
) / 100                                # 平均到每次
# 实际单次：cached_input 1500 * 0.30 / 1e6 + fresh 1000 * 3.0 / 1e6 + 300 * 15/1e6
# ≈ $0.0079

# step 5：路由
# 简单筛选用 Haiku，复杂的（高级岗）才上 Sonnet
# 70% 走 Haiku：
#   2500 * 0.8 / 1e6 + 300 * 4.0 / 1e6 = 0.002 + 0.0012 = $0.0032
# 30% 走 Sonnet：$0.012
mixed = 0.7 * 0.0032 + 0.3 * 0.012  # = $0.0058

# step 6：单位经济
gross_per_mixed = 0.5 - 0.0058  # = $0.494/次，毛利率 98.8%
# 100 万次/月 → 收入 $500K，成本 $5800
```

这种 LLM cost 占收入 < 5% 的业务模式，几乎不需要再优化 LLM 成本；优化重心放在销售获客、留存。**反过来**，如果 LLM cost 占收入 > 50%，规模化前必须先做路由和缓存。

## 常见坑

1. **拿 list price 算账**——企业合同、batch 折扣、PTU 预购都能把价格砍 30-70%，估算用 list 偏保守、对外报价用就太贵。
2. **忘记 reasoning token**——o3、DeepSeek R1、Gemini Thinking 全按 output 计价，一次回答经常 2-5K thinking，月成本翻倍。
3. **不区分 cached / fresh input**——按统一 $/1M input 算账，缓存收益看不见，老板觉得「上了 cache 怎么账单没下来」。
4. **按 character / 4 估 token**——中文场景偏低 3 倍，被惊喜账单教做人。
5. **把多模态 token 当文本算**——一张高分辨率图 1500-4000 input token，估错 10 倍量级。
6. **只看月账单不看单位经济**——账单涨 10% 但 DAU 涨 30% 是好事；DAU 没涨账单涨 10% 才该报警。

## 下一步

- 模型选好了，按任务路由 → [03 · 模型路由](./03-model-routing.md)
- 大 input 上 cache → [04 · Prompt cache 系统设计](./04-prompt-cache.md)
- 离线任务上 batch 拿 50% 折扣 → [05 · 批处理](./05-batching.md)
- 跨租户拆账，看清谁烧得多 → [09 · 成本监控](./09-cost-monitoring.md)
- 评估降本对效果的影响 → [../eval/](../eval/)
- 价格变了第一时间知道 → <https://artificialanalysis.ai/>
