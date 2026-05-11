# 03 · 模型路由

不是所有请求都需要旗舰模型。把简单问题路由到 Haiku / Flash / mini，复杂问题保留给 Sonnet / GPT-5 / Opus，是规模化场景下**单点收益最大的优化**——常见 3-5 倍降本，效果损失 < 2%。本章讲三种路由策略、判别器实现、生产 gateway 配置、A/B 验证。

## 1. 路由策略全景

| 策略           | 决策依据              | 收益    | 实现难度 | 适用场景            |
| ------------ | ----------------- | ----- | ---- | --------------- |
| Cheap-first   | 先小模型，置信度不够再升级    | 大     | 中     | 大量简单问题 + 少量难问题  |
| Quality-first | 先大模型，离线蒸馏小模型替换    | 中     | 高     | 数据飞轮型业务         |
| 难度分级（pre-classifier） | 一个轻量 classifier 决定走哪 | 大 | 中 | 任务边界清晰        |
| 关键词 / 规则      | 写死的 if-else        | 小-中   | 低     | 任务非常专一          |
| 学习路由（RouteLLM 等） | preference data 训练 | 大 | 高 | 有 eval 数据 + 工程能力 |
| 用户自选         | 前端给开关             | 取决于用户  | 低     | 让有意识的用户省钱 / 升级  |

实战里 80% 的团队从「难度分级」起步：写一个轻量 classifier 把请求分成 easy / medium / hard，分别打到 nano / mini / 旗舰。

## 2. Cheap-first：先便宜后升级

最经典的模式，FrugalGPT 论文给的就是这个：

```python
# cheap_first.py
from anthropic import Anthropic

client = Anthropic()
CASCADE = [
    ("claude-haiku-4-5",  0.80, 4.0),   # 先打 Haiku
    ("claude-sonnet-4-5", 3.00, 15.0),  # 不行再 Sonnet
    ("claude-opus-4-5",   15.0, 75.0),  # 还不行才 Opus
]

def ask_with_cascade(prompt: str, judge_threshold: float = 0.85):
    """每一级回答完用一个 judge 评估置信度，不够就升级。"""
    total_cost = 0
    for model, p_in, p_out in CASCADE:
        resp = client.messages.create(
            model=model,
            max_tokens=1000,
            messages=[{"role": "user", "content": prompt}],
        )
        total_cost += (
            resp.usage.input_tokens * p_in / 1e6
          + resp.usage.output_tokens * p_out / 1e6
        )
        confidence = judge(prompt, resp.content[0].text)  # 你的 judge 函数
        if confidence >= judge_threshold:
            return resp.content[0].text, model, total_cost
    return resp.content[0].text, model, total_cost
```

**关键问题：judge 怎么写？**

- 简单：用同一个 cheap 模型 self-judge（便宜但有偏）。
- 中：训练一个 reward model（准但需要数据）。
- 实操：**用规则 + 结构化输出**。如果 task 输出是 JSON / classification，可以用 schema validation + 业务规则；如果是写作，用一个 fast embedding similarity 与 reference 对比。

**收益估算：**

```
假设 70% 简单问题（Haiku 一次过），25% 中等（Sonnet），5% 难（Opus）
单次平均成本 = 0.7×Haiku + 0.25×(Haiku + Sonnet) + 0.05×(Haiku + Sonnet + Opus)
```

跑出来比纯 Sonnet 便宜 40-60%，比纯 Opus 便宜 80%+。**但**：cheap-first 有一次「白做工」成本（cheap 模型也跑了再升级），所以 cascade 太长不划算，一般 2-3 层。

## 3. 难度分级：轻量 classifier 路由

更常见的生产做法：**先判后选**，不重复跑：

```python
# pre_classifier.py
from typing import Literal

Tier = Literal["nano", "mini", "flagship"]

# 一个 50-100 token 的 prompt + 便宜模型，做意图 / 难度判别
CLASSIFIER_PROMPT = """\
Classify the following user request into difficulty:
- 'nano': simple lookup, greeting, short fact, single-turn small talk.
- 'mini': clear single-step task, summary < 500 words, basic code snippet, FAQ.
- 'flagship': multi-step reasoning, complex code, long document analysis, ambiguous intent.

Reply ONLY one of: nano / mini / flagship.

Request:
{request}"""

def classify(request: str) -> Tier:
    resp = client.messages.create(
        model="claude-haiku-4-5",     # 用 Haiku 当 classifier
        max_tokens=8,
        messages=[{"role": "user",
                   "content": CLASSIFIER_PROMPT.format(request=request)}],
    )
    return resp.content[0].text.strip().lower()

MODEL_TIER = {
    "nano":     "gpt-5-nano",
    "mini":     "gpt-5-mini",
    "flagship": "gpt-5",
}

def route_and_call(request: str) -> str:
    tier = classify(request)
    return call(model=MODEL_TIER[tier], prompt=request)
```

**classifier 自身成本：** 100 input + 5 output × Haiku ≈ $0.0001 / 次，规模化也只有几十美元 / 百万次，相对可忽略。

**经验数据**（某客服 SaaS，2026 Q1）：

| 分级    | 占比    | 模型          | 单次成本       |
| ----- | ----- | ----------- | ---------- |
| nano  | 35%   | GPT-5 nano   | $0.0005    |
| mini  | 50%   | GPT-5 mini   | $0.003     |
| flagship | 15%   | GPT-5        | $0.025     |
| 平均   | -     | -           | $0.005     |

对比全用 GPT-5（$0.025），便宜 5 倍；效果在内部 eval 上掉 1.2 分（0-100 评分体系）。

## 4. LiteLLM / Portkey gateway 配置

不要在业务代码里写路由逻辑，放到 gateway 层：

```yaml
# litellm-config.yaml
model_list:
  - model_name: chat-nano
    litellm_params:
      model: openai/gpt-5-nano
      api_key: os.environ/OPENAI_KEY

  - model_name: chat-mini
    litellm_params:
      model: openai/gpt-5-mini
      api_key: os.environ/OPENAI_KEY

  - model_name: chat-flagship
    litellm_params:
      model: anthropic/claude-sonnet-4-5
      api_key: os.environ/ANTHROPIC_KEY

  - model_name: chat-flagship  # 同名 = fallback 候选
    litellm_params:
      model: openai/gpt-5
      api_key: os.environ/OPENAI_KEY

router_settings:
  routing_strategy: simple-shuffle   # 同名模型间负载
  num_retries: 2
  timeout: 30
  fallbacks:
    - chat-flagship: ["chat-mini"]   # flagship 全挂时降级
  context_window_fallbacks:
    - chat-mini: ["chat-flagship"]   # 上下文超限自动升级
  cooldown_time: 60                  # 单 provider 出错后冷却
```

业务代码只调用 `chat-nano` / `chat-mini` / `chat-flagship`，**provider 切换、fallback、限速全部 gateway 接管**。

## 5. 学习路由：RouteLLM 等开源方案

不想自己写 classifier？用学好的路由器。

```python
# routellm.py
from routellm.controller import Controller

router = Controller(
    routers=["mf"],                              # matrix factorization router
    strong_model="claude-sonnet-4-5",
    weak_model="claude-haiku-4-5",
)

# 设阈值：50% 走 strong, 50% 走 weak
response = router.completion(
    model="router-mf-0.5",
    messages=[{"role": "user", "content": prompt}],
)
```

`router-mf-0.5` 里的 0.5 是「分给 strong 的比例」。可以扫一遍阈值看 cost-quality 曲线，落在「比纯 strong 便宜 70%，比纯 weak 准 90%」的甜点上。

类似工具：

- **Martian Router**：商业 SaaS，零代码接入。
- **OpenRouter**：多厂商网关 + 自带 fallback。
- **Portkey**：semantic cache + routing 一站式。

## 6. 关键词 / 规则路由（够用且最便宜）

特定业务里规则路由比 ML 还好：

```python
# rules_router.py
import re

def route_by_rule(request: str) -> str:
    # 代码任务 → coder 专门模型
    if re.search(r"```|def |class |function|SELECT |CREATE TABLE", request, re.I):
        return "deepseek-coder"
    # 数学 / 推理 → reasoning 模型
    if re.search(r"prove|证明|integral|derivative|complexity", request, re.I):
        return "o3"
    # 中文长文 → 国产
    if len(request) > 500 and is_chinese(request):
        return "qwen-3-max"
    # 短问题 / 闲聊
    if len(request) < 100:
        return "gemini-2.5-flash"
    # 默认
    return "claude-sonnet-4-5"
```

**优点：** 零延迟、零额外成本、可解释、易调试。
**缺点：** 维护规则的人很快崩溃；推荐用规则做 **20% 高置信度场景**，剩下交给 classifier / 学习路由。

## 7. 路由的 A/B 验证

新路由策略上线前必跑 A/B，否则一上线就是惊喜：

```sql
-- 看 30 天内 control vs variant 的成本与质量
WITH samples AS (
  SELECT
    ab_group,                       -- 'control' | 'variant'
    request_id,
    feature,
    model,
    total_cost_usd,
    eval_score,                     -- 离线 eval 或在线反馈打分
    user_thumbsup
  FROM llm_usage_log
  LEFT JOIN eval_scores USING (request_id)
  WHERE ts BETWEEN now() - interval '30 days' AND now()
    AND ab_group IS NOT NULL
)
SELECT
  ab_group,
  COUNT(*)                              AS n_req,
  AVG(total_cost_usd)                   AS avg_cost,
  SUM(total_cost_usd)                   AS total_cost,
  AVG(eval_score)                       AS avg_quality,
  AVG(CASE WHEN user_thumbsup THEN 1.0 ELSE 0.0 END) AS thumbsup_rate,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY total_cost_usd) AS p95_cost
FROM samples
GROUP BY ab_group;
```

**判定标准**（实践经验）：

- 成本下降 > 20% 且 quality 下降 < 1% → 放量。
- 成本下降 < 10% 或 quality 下降 > 3% → 不上。
- 介于之间 → 看场景，慎重灰度。

## 8. 多模型 fallback 与可用性

路由不只是省钱，也要扛故障。一个稳健的 stack：

```yaml
# 同一个业务模型有多个 provider 候选
chat-flagship:
  - provider: anthropic
    model: claude-sonnet-4-5
    weight: 70
    rpm: 1000
  - provider: openai
    model: gpt-5
    weight: 25
    rpm: 800
  - provider: openrouter
    model: anthropic/claude-sonnet-4-5
    weight: 5
    rpm: 200
    # 备援，主链路全挂时自动放量
```

**真实事故经验**：

- 2024 OpenAI 一次全球 outage 7 小时，没配 fallback 的业务全挂；配了的几乎无感。
- Anthropic Console Region 失败率偶尔会飙到 5%+，单 provider 的应用就跟着抖。

## 9. 路由 cost-quality 曲线（决策图）

把不同路由策略画在同一张图里：

| 策略                          | 月成本（10M req） | 离线 eval（0-100） |
| --------------------------- | -------------- | --------------- |
| 全 Opus                       | $500K          | 92              |
| 全 Sonnet                     | $130K          | 88              |
| 全 Haiku                      | $30K           | 79              |
| 全 GPT-5                      | $200K          | 90              |
| 全 GPT-5 mini                 | $25K           | 81              |
| **难度分级（nano/mini/flagship）** | **$50K**       | **87**          |
| Cheap-first（Haiku → Sonnet） | $70K           | 88              |
| RouteLLM thr=0.5            | $85K           | 89              |

「难度分级」在大多数业务里是 cost-quality Pareto 最优。

## 10. 路由演进路线图

实际团队的演进路径，避免一上来就追求最复杂方案：

```
Stage 0（< 1K DAU）：
  全部走旗舰，关注效果，先把 PMF 拿到。
  
Stage 1（10K DAU 起）：
  加规则路由 + LiteLLM gateway。
  关键词路由 + 一个 cheap classifier。
  上 Helicone / Langfuse 观测。
  
Stage 2（100K DAU 起）：
  上学习路由（RouteLLM 或自训 classifier）。
  做 A/B 框架，每月评估一次模型组合。
  按 tenant 设默认模型策略。
  
Stage 3（1M DAU 起）：
  自蒸馏：用 flagship 输出训自家小模型。
  vLLM 自部署蒸馏模型，承接 80% 流量。
  API 只接旗舰难题 + fallback。
```

## 常见坑

1. **classifier 用旗舰模型**——judge 成本超过被路由模型节省的钱，得不偿失。classifier 永远用最便宜的模型。
2. **路由策略写在业务代码里**——业务、prompt、路由全耦合，改 prompt 影响路由。把路由放 gateway 层。
3. **不做 A/B 直接全量切**——某次切换到 mini 之后客诉飙升，没数据回滚不了。任何路由变更必先灰度 5-10%。
4. **fallback 配了不演练**——真出事时 fallback 因为 API key 过期 / 限速 / schema 不兼容失败。每月做一次混沌演练。
5. **classifier prompt 没版本化**——改了 classifier prompt 没注意到，路由分布大变，账单飞。classifier prompt 也要走代码 review。
6. **忽略冷启动成本**——cheap-first 的「失败再升级」对延迟敏感场景不友好，p95 比 single-shot 高 50-100%。

## 下一步

- 路由好了，再省 input → [04 · Prompt cache 系统设计](./04-prompt-cache.md)
- 离线任务全跑 batch → [05 · 批处理](./05-batching.md)
- 设单租户限速避免被烧穿 → [08 · 限流与配额](./08-rate-limiting.md)
- A/B 数据怎么落库 → [09 · 成本监控](./09-cost-monitoring.md)
- 路由对效果的影响怎么评估 → [../eval/](../eval/)
- RouteLLM 论文与代码 → <https://github.com/lm-sys/RouteLLM>
