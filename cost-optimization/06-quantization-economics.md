# 06 · 量化与自部署经济性

「能不能用 Qwen-72B-AWQ 自部署替代 GPT-5 / Sonnet？」答案不在情怀里，在**临界 QPS** 里：超过某个量自部署便宜，没超过纯亏。本章把临界点算清楚，覆盖量化对成本的影响、利用率敏感性、混合架构、和 [../llm-inference/10-cost-latency.md](../llm-inference/10-cost-latency.md) 形成互补（那里聚焦自部署工程参数，这里聚焦应用层经济决策）。

## 1. 自部署成本 vs API：先看公式

**自部署单位 token 成本**：

```
$/token = (GPU 月租 + SRE 工时 + 网络/存储) / (实际产出 token / 月)
```

**实际产出 token**：

```
实际产出 = 理论吞吐 × 利用率 × 30 天 × 86400 秒
```

利用率决定一切。同一张 A100，跑满月成本 $2000 → $0.026 / M token；跑 10% 利用率 → $0.26 / M token，**比商业 API 都贵**。

## 2. 量化与吞吐：单卡能跑多少 token/s

2026 年主流量化方案吞吐参考（单卡 A100 80G，平均 prompt 1K input / 200 output）：

| 模型             | 精度           | 单卡 QPS  | 总吞吐（tok/s） | KV cache GB |
| -------------- | ------------ | ------- | ----------- | ----------- |
| Qwen3-7B       | BF16         | 25-35   | 4000-5000   | ~6          |
| Qwen3-7B       | AWQ INT4     | 40-60   | 5500-7000   | ~6          |
| Qwen3-14B      | BF16         | 12-18   | 2500-3500   | ~12         |
| Qwen3-14B      | AWQ INT4     | 22-32   | 4000-5500   | ~12         |
| Qwen3-32B      | AWQ INT4     | 10-15   | 2200-3000   | ~22         |
| Qwen3-72B      | AWQ INT4     | 5-8     | 1200-1800   | ~45         |
| Llama-3.3-70B  | FP8（H100）    | 8-12    | 1800-2400   | ~40         |
| DeepSeek V3.2  | FP8（H100 × 8） | 整机吞吐 6K-9K req/h | 大型 MoE | -          |

> 数字来源于 vLLM benchmark + 部署经验，具体场景差异显著，自己 benchmark。

**量化的成本含义**：

- 同卡跑更大模型 → 单 token 成本下降。
- 同模型跑更快 → 单 token 成本下降。
- **精度损失 1-3%**：要靠 eval 验证业务能接受。

## 3. 自部署单价计算器（含工时）

```python
# self_host_cost.py
def self_host_cost_per_m_token(
    monthly_gpu_cost: float,      # 单卡或集群月租
    monthly_sre_cost: float,      # SRE 工时分摊
    monthly_misc: float,          # 网络 + 监控 + 存储
    throughput_tok_per_sec: float, # 实测峰值
    utilization: float,            # 0-1，实际利用率
    days: int = 30,
) -> float:
    """返回 $/M token。"""
    total_cost = monthly_gpu_cost + monthly_sre_cost + monthly_misc
    capacity = throughput_tok_per_sec * 86400 * days
    actual = capacity * utilization
    return total_cost / actual * 1e6

# 例：4× A100 集群跑 Qwen3-72B-AWQ
print(self_host_cost_per_m_token(
    monthly_gpu_cost = 4 * 2000,       # $8000
    monthly_sre_cost = 6000,            # 0.5 FTE
    monthly_misc     = 800,
    throughput_tok_per_sec = 4 * 1500,  # 6000 tok/s 峰值
    utilization      = 0.40,
))  # → ~$2.38 / M token

# 利用率 80%
print(self_host_cost_per_m_token(
    monthly_gpu_cost=4*2000, monthly_sre_cost=6000, monthly_misc=800,
    throughput_tok_per_sec=4*1500, utilization=0.80,
))  # → ~$1.19 / M token
```

## 4. 临界 QPS：什么时候该自部署

把上面的式子和 API 价格放在一起，求**临界点**。

```python
# breakeven.py
def breakeven_qps(
    api_blend_price_per_m: float,   # API 加权单价（input + output blend）
    monthly_self_host_cost: float,
    throughput_tok_per_sec_per_q: float = 600,   # 平均每 req 600 token
):
    """求自部署便宜的最小持续 QPS。"""
    # 等价条件：API_cost = self_host_cost
    # qps * 86400 * 30 * tokens_per_q * api_blend / 1e6 = monthly_self_host_cost
    tokens_per_month_per_qps = 86400 * 30 * throughput_tok_per_sec_per_q
    return monthly_self_host_cost / (tokens_per_month_per_qps * api_blend_price_per_m / 1e6)
```

跑几个数：

| 自部署月成本                  | API blend $/M | 临界 QPS  | 备注                |
| ----------------------- | ------------- | ------- | ----------------- |
| $5,000（2× A100 简配）      | $5.00         | ~6.4   | 中小团队，Haiku-blend 价 |
| $5,000                  | $1.00         | ~32    | Flash / mini blend |
| $15,000（4× A100 + SRE 1FTE） | $5.00      | ~19    | 中型部署              |
| $15,000                 | $1.00         | ~96    | 必须很大流量才划算         |
| $40,000（8× H100 + 2 SRE） | $5.00         | ~51    | 大模型托管             |

**翻译成 DAU**：

- 假设每个用户每天 10 次 LLM 调用（QPD = 10）。
- 临界 QPS 6.4 ≈ 6.4 × 86400 / 10 ≈ **55K DAU**。
- 临界 QPS 32 ≈ **276K DAU**。

经验法则：
- **< 30K DAU**：API。
- **30-100K DAU + 通用任务**：可以试自部署小模型（7B-14B 量化）。
- **100K+ DAU + 复杂任务**：自部署 70B 量化 + API fallback。
- **特殊合规 / 极低延迟**：流量再小也可能要自部署。

## 5. 量化方案选型对成本的影响

| 方案          | 显存节省   | 速度提升    | 精度损失           | 适用                  |
| ----------- | ------ | ------- | -------------- | ------------------- |
| FP8         | 50%    | 1.5-2x  | < 1%（H100/Ada） | 旗舰，性价比最佳            |
| AWQ INT4    | 75%    | 1.5-2x  | 1-2%           | 中端 GPU（A100/4090）默认 |
| GPTQ INT4   | 75%    | 1.3-1.8x | 1-3%           | 老但稳                  |
| GGUF Q5_K_M | 60-70% | -       | 1-2%           | Mac / CPU            |
| BF16 不量化   | 0      | 1x      | 0              | 显存够 + 精度敏感         |

**成本翻译**：上 AWQ 量化能在同卡跑下两个 size 的模型，**单 token 成本压降 60-80%**——这是自部署 vs API 拉开差距的关键。

## 6. 混合架构：API + 自部署的最优解

不要二选一。绝大多数生产业务用**混合**：

```yaml
# 流量分布目标
self_host_qwen_14b:  70%   # 通用 chat、RAG、简单工具调用
api_haiku:           15%   # 突发流量、低优 fallback
api_sonnet:           8%   # 复杂多步思考
api_gpt5_or_opus:     2%   # 必须用旗舰的硬骨头
api_flash:            5%   # 多模态请求
```

**真实算账**（10M req/月，70% 自部署 + 30% API mix）：

```
自部署成本：       $15,000 / 月（4× A100 + SRE）
API 成本：
  Haiku (1.5M req × $0.005)   = $7,500
  Sonnet (0.8M × $0.02)        = $16,000
  GPT-5 (0.2M × $0.05)         = $10,000
  Flash (0.5M × $0.002)        = $1,000
合计 API：                     $34,500
混合总成本：                    $49,500

对比全 Sonnet：10M × $0.02 = $200,000
对比全 Haiku：10M × $0.005 = $50,000（效果可能不行）

混合方案省了 75%，且大部分 quality 接近 Sonnet 水平。
```

## 7. 自部署 + Cache 的叠加

自部署不光卡钱便宜，**vLLM 的 prefix cache 是免费的**：

```python
# vLLM 启动参数（关键 cache 开关）
vllm serve qwen3-14b-awq \
  --enable-prefix-caching \
  --max-model-len 32768 \
  --gpu-memory-utilization 0.92 \
  --max-num-seqs 64
```

prefix cache 命中部分**几乎零成本**（只算 attention 的 decode，不重 prefill）：

| 配置           | 平均请求成本 | 备注                |
| ------------ | ------ | ----------------- |
| 自部署 + 无 cache | $0.0012 | 基础                 |
| 自部署 + prefix cache（命中 70%） | $0.0006 | 砍半              |
| 自部署 + 语义 cache（再叠 30%） | $0.0004 | 总成本 1/3        |

**生产经验**：自部署的真实成本通常比 API 的「list price 1/5」还要好——因为 prefix cache + KV cache reuse 是顺带的。

## 8. 多模型一套架构（router + backend）

vLLM 支持多 LoRA + 多模型，配合 LiteLLM 路由层：

```yaml
# litellm-config.yaml
model_list:
  - model_name: chat-fast
    litellm_params:
      model: openai/qwen3-7b-awq
      api_base: http://vllm-7b:8000/v1

  - model_name: chat-default
    litellm_params:
      model: openai/qwen3-14b-awq
      api_base: http://vllm-14b:8000/v1

  - model_name: chat-strong
    litellm_params:
      model: openai/qwen3-72b-awq
      api_base: http://vllm-72b:8000/v1

  # API fallback
  - model_name: chat-strong
    litellm_params:
      model: anthropic/claude-sonnet-4-5
      api_key: os.environ/ANTHROPIC_KEY
      tpm: 200000      # 限速避免 fallback 把账单打爆

router_settings:
  routing_strategy: usage-based-routing-v2
  fallbacks:
    - chat-strong: ["chat-default"]
    - chat-default: ["chat-fast"]
```

业务方调 `chat-default`，底下智能分流。

## 9. 决策矩阵：什么时候上自部署

| 条件                          | 决策建议        |
| --------------------------- | ----------- |
| DAU < 30K                    | 纯 API        |
| 30K-100K DAU + 有 1 SRE       | 试自部署 7B-14B 量化 |
| 100K+ DAU                    | 强烈建议自部署混合架构 |
| 数据合规 / 不出企业                  | 必须自部署       |
| 极低延迟 < 300ms TTFT            | 自部署（API 网络往返就 100-200ms） |
| 突发流量 10x 峰谷                  | API 为主或弹性自部署 |
| 微调 / 私有模型                    | 必须自部署       |
| 需要旗舰智能（GPT-5 / Opus 级）       | 至少这部分流量走 API  |
| 团队没有 SRE / GPU 经验            | API（自部署故障成本高） |

## 10. 真实算例：10 万 DAU 客服 SaaS

> 场景：10 万 DAU，每用户每天 8 次对话，平均 input 3000 / output 300。要求 TTFT p95 < 1.5s。

```
日请求：800K
日 token：800K × 3300 = 2.64B
QPS 峰值：~30
```

**方案 A：全 Anthropic API**

```
input：  2.64B × 0.7 × $3 / 1e6  = $5,544/天
output： 2.64B × 0.1 × $15 / 1e6 = $3,960/天  （output 占比近似 10%）
合计：    ~$9,500/天 = ~$285K/月

加 prompt cache 70% 命中 → 砍 60% → ~$110K/月
加 batch 不适用（实时聊天）
```

**方案 B：混合自部署 Qwen3-14B-AWQ + API fallback**

```
4× A100 80G：$8,000/月
SRE 0.5 FTE：$6,000/月
网络监控：$800/月
self-host 合计：$14,800/月

80% 走自部署（QPS 24 × 3300 token = 79.2K tok/s）
  实测 4 卡 14B-AWQ 总吞吐 ~10K tok/s
  → 远低于需求，需要 8 卡 + KV cache 优化 + chunked prefill
  实际方案：4 卡 Qwen3-14B-AWQ 跑 80% 简单流量
  剩余复杂 / 长上下文流量走 API

调整后：
- 70% 走自部署：约 1.85B token，几乎零边际成本
- 25% 走 Haiku：约 0.66B token × $0.005 blend ≈ $3,300/天
- 5% 走 Sonnet（复杂）：约 0.13B × $0.05 blend ≈ $6,500/天

API 部分：~$300K/月
self-host：$14,800/月
合计：~$315K/月？？？
```

⚠️ 注意：上面例子里如果 25% Haiku + 5% Sonnet 这个组合 API 部分还是大，**说明自部署比例还要再上**（提高到 90%）。这也是为什么很多团队最后选择**纯自部署 + API 仅做 fallback**——当流量到这个量级，API 成本即使是 Haiku 也会让人肉疼。

**完整决策**：

1. 先 API 起家，eval 数据收集。
2. 流量起来后，用蒸馏数据训自家模型。
3. vLLM 上 LoRA + 多模型，承接 90%+ 流量。
4. API 留作 fallback + 旗舰任务。

## 常见坑

1. **只看 GPU 单价不看利用率**——10% 利用率的自部署比 API 还贵。先估实际利用率。
2. **量化没做 eval 就上**——AWQ 在 reasoning / 数学任务上掉得最快，业务上线后客户骂娘。
3. **SRE 工时不算成本**——「自部署不花钱」的错觉来自不算工时。一个 SRE FTE = 几百张 A100 卡钱。
4. **没有 API fallback**——自部署挂了业务全挂，没演练真出事才发现 fallback 不工作。
5. **prefix cache 没开**——vLLM 默认不开 prefix cache，纯 prefill 模式浪费一半算力。
6. **GPU 月租按 list**——所有云厂商都有 reserved / spot 折扣 30-60%。
7. **算账只算推理，不算训练 / 微调**——自部署常配 LoRA 训练，训练 GPU 时也要算进 TCO。
8. **超额采购**——按峰值买卡，平均利用率 < 30%。先 API 抗峰值 + 自部署吃稳态流量。

## 下一步

- 上层缓存设计 → [07 · 缓存设计](./07-semantic-cache.md)
- 限流保护自部署不被打挂 → [08 · 限流与配额](./08-rate-limiting.md)
- 多租户监控按业务拆账 → [09 · 成本监控](./09-cost-monitoring.md)
- 真实规模曲线 → [10 · 规模化案例](./10-scaling-case.md)
- 自部署工程细节深挖 → [../llm-inference/](../llm-inference/)
- 量化方案选型 → [../llm-inference/04-quantization.md](../llm-inference/04-quantization.md)
- 量化效果验证 → [../eval/](../eval/)
