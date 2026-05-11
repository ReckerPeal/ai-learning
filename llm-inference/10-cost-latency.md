# 10 · 成本与延迟权衡

最后一章，把前面 9 章的工程结论收敛到**生意决策**：自部署还是叫 API、什么时候切、延迟优化值不值。

## 1. 自部署 vs API：经济模型

### 1.1 成本结构对比

| 项                | 商业 API                  | 自部署                              |
| ---------------- | ----------------------- | -------------------------------- |
| 直接成本             | $/M tokens（用多少付多少）       | GPU 月租或买卡折旧                      |
| 间接成本             | 0                       | 工程师 / SRE 时间，运维，监控               |
| 起步成本             | ≈ 0                     | GPU 配置、模型下载、调参（人天）              |
| 弹性               | 秒级                      | 分钟级（预热）/ 周级（采购）                  |
| 突发成本             | 跟着用量走                   | 容量上限或排队                          |
| 数据合规             | 数据出企业                   | 数据自留                             |

### 1.2 商业 API 单价（2026 参考，仅作量级）

| API                   | $/M input | $/M output | 备注              |
| --------------------- | --------- | ---------- | --------------- |
| GPT-4o                | ~$2.5     | ~$10       | OpenAI 旗舰       |
| GPT-4o mini           | ~$0.15    | ~$0.60     |                 |
| Claude Sonnet 4.5     | ~$3       | ~$15       | Anthropic       |
| Claude Haiku          | ~$0.80    | ~$4        |                 |
| Gemini 2.0 Flash      | ~$0.10    | ~$0.40     | Google          |
| DeepSeek V3 API       | ~$0.27    | ~$1.10     | 国产，便宜           |

### 1.3 自部署成本（2026 参考）

GPU 云租赁参考价（1 个月）：

| GPU             | 云上租赁 / 月（参考）   | 买断成本（参考）    |
| --------------- | ------------- | ----------- |
| A10 24G         | ~$400-700     | -           |
| RTX 4090        | $300-500（中小云） | $1,500-2,000（消费级） |
| A100 80G        | $1,500-2,500  | $15,000+    |
| H100 80G        | $2,500-5,000  | $25,000-35,000 |
| 8× H100 节点      | $25,000-40,000 | $250,000+   |

### 1.4 等价点测算（粗算）

7B 模型 BF16，单卡 A100 80G，benchmark 出 3000 tok/s 总吞吐（混合 in+out）：

```
A100 80G 月租约 $2000
≈ $2000 / (30 × 24 × 3600 × 3000) ≈ $0.0000257 / token
≈ $0.026 / M tokens（一直跑满的情况下）
```

对比 GPT-4o mini $0.15-0.60 / M tokens，**自部署满载约便宜 5-20 倍**。

但「满载」是关键：

| 利用率 | 等价 $/M token | 比商业 API 便宜？     |
| --- | ----------- | -------------- |
| 100% | $0.026     | 远便宜            |
| 50% | $0.052      | 便宜             |
| 20% | $0.13       | 持平 GPT-4o mini |
| 10% | $0.26       | 比 mini 还贵      |
| 5%  | $0.52       | 比商业贵           |

**结论**：自部署的核心是利用率。

## 2. 决策矩阵

| 场景                            | 推荐                | 理由                       |
| ----------------------------- | ----------------- | ------------------------ |
| 0-10 用户的 PoC                  | 商业 API            | 利用率 1%，自部署亏死             |
| 持续 < 100 万 tokens / 天          | 商业 API            | 月成本 < $50，自部署连卡钱都不够      |
| 100 万 - 1 亿 tokens / 天         | 看任务难度选择            | 计算等价点                    |
| 持续 > 1 亿 tokens / 天            | 自部署               | 规模效应明显                   |
| 突发流量（10 倍峰谷）                  | 商业 API 或混合         | 自部署难以伸缩                  |
| 数据不能出企业（医疗/金融/政务）             | 自部署               | 合规硬要求                    |
| 微调专属模型                        | 自部署 + LoRA        | API 微调贵且不灵活              |
| 极低 TTFT 要求（< 100ms）           | 自部署              | API 网络往返就 50-200ms       |
| 多模型 A/B / 频繁试新模型              | 商业 API            | 自部署切换成本高                 |
| 需要 GPT-4 / Claude 旗舰能力        | 商业 API            | 没有同水平开源                  |
| 用 Qwen / Llama 7B-72B 就够      | 自部署有优势             | 开源能打                     |
| 预算紧、不想招 SRE                   | 商业 API            | 维护成本远高于 token 成本         |

## 3. 延迟构成与优化优先级

一次请求的延迟链：

```
Client request
  ↓ (网络 RTT: 10-200ms)
LB / API Gateway
  ↓ (路由 / 鉴权: 1-10ms)
vLLM queue
  ↓ (排队: 0-∞，看负载)
Prefill
  ↓ (TTFT 主要部分: 50ms-数秒)
Decode (流式开始返回)
  ↓ (TBT × output_len)
Stream return
  ↓ (网络 RTT × N chunks)
Client render
```

### 3.1 各部分典型时间

| 阶段             | 典型时长       | 占比（短任务） | 占比（长生成）    |
| -------------- | ---------- | ------- | ---------- |
| 网络 RTT（同 region） | 10-30 ms   | 5-15%   | < 1%       |
| 网络 RTT（跨大洲）    | 150-300 ms | 30-60%  | 5-10%      |
| LB / GW        | 1-10 ms    | < 5%    | < 1%       |
| 排队             | 0-数秒       | 看负载     | 看负载        |
| Prefill / TTFT | 50ms-数秒    | 30-70%  | 5-30%      |
| Decode         | 10-200ms × N | -      | 60-90%     |

### 3.2 优化哪个最值

按性价比：

| 优化                        | 影响               | 成本     | 性价比 |
| ------------------------- | ---------------- | ------ | --- |
| 流式响应                      | 用户感知 TTFT 大降    | 0     | ⭐⭐⭐⭐⭐ |
| Prefix cache              | 重复 prompt prefill 砍 | 0   | ⭐⭐⭐⭐⭐ |
| 跨 region → 同 region       | 网络砍 100-200ms     | 中     | ⭐⭐⭐⭐  |
| 量化（AWQ / FP8）              | decode 速度 1.5-2x   | 中（精度 1-3%） | ⭐⭐⭐⭐ |
| 限流避免排队                    | 负载高时 TTFT 稳     | 0      | ⭐⭐⭐  |
| Speculative decoding      | decode 2-3x       | 中（草稿模型 / 训练） | ⭐⭐⭐ |
| H100 替换 A100              | 1.5-2x，低延迟        | 高（贵）   | ⭐⭐   |
| EAGLE / Medusa            | decode 3-4x       | 高（训练） | ⭐⭐   |
| 重写整套架构（自研引擎 / TRT-LLM）   | 20-50%           | 极高     | ⭐    |

**经验法则**：先把 0 成本的开关打满（流式 / prefix cache / chunked prefill / 限流），再上需要精度让步的（量化），最后才考虑硬件升级。

## 4. 延迟 SLA vs throughput

二者是**反向**关系。把 batch 调大，throughput 涨、延迟劣化：

| max-num-seqs | 总吞吐（tok/s） | TTFT p95（ms） | TBT p95（ms） |
| ------------ | ----------- | ------------ | ----------- |
| 1            | 130         | 80           | 8           |
| 8            | 900         | 110          | 10          |
| 32           | 2400        | 180          | 18          |
| 128          | 3500        | 380          | 35          |
| 256          | 3800        | 800          | 60          |

业务要 TTFT p95 < 200ms → max-num-seqs 别超 32。要总吞吐最大不管延迟 → 128+。

**生产做法**：把 SLA 当硬约束，反推 max-num-seqs，再算容量。

## 5. 真实案例：DAU 10K → 1M 的临界点

### 5.1 场景假设

- 业务：聊天助手，平均每个用户每天 10 轮对话。
- 平均 prompt 1500 token（含历史 + system），平均 output 200 token。

### 5.2 流量与成本估算

| DAU  | 日总请求    | 日总 token            | API 成本（用 GPT-4o mini） | 自部署成本（A100 利用率） |
| ---- | ------- | ------------------- | --------------------- | -------------- |
| 10K  | 100K    | 170M                | ~$80                  | $2000（利用率 5%）  |
| 100K | 1M      | 1.7B                | ~$800                 | $4000（2 卡，30%） |
| 500K | 5M      | 8.5B                | ~$4000                | $8000（4 卡，70%） |
| 1M   | 10M     | 17B                 | ~$8000                | $12000（6 卡，80%） |

注：表里所有数字都是数量级估算，真实成本会因为 API 折扣、prompt cache 命中、自部署利用率峰谷有显著浮动。

### 5.3 临界点

```
10K DAU：API 远便宜（$80 vs $2000+）
100K DAU：API 仍胜（$800 vs $4000）
500K DAU：自部署接近持平
1M DAU：自部署便宜，但需要 SRE 团队（人力成本要计入）
```

**真实临界点**：你愿意养 1 个全职 LLM 工程师 / SRE 时（年薪 $150-300K，月 $12-25K）。

## 6. 混合架构：最佳工程实践

不是 0/1 选择，而是**混合**：

```
日常流量 → 自部署 vLLM（成本低、延迟稳）
突发 / 超容 → 商业 API fallback
高质量需求（旗舰智能） → Claude / GPT-4
低延迟需求 → 自部署 + 同 region
特定任务（code / 数学） → 专门小模型 LoRA
合规敏感 → 自部署 + 数据隔离
```

### 6.1 LiteLLM 实现

```yaml
model_list:
  - model_name: chat
    litellm_params:
      model: openai/qwen2.5-7b
      api_base: http://vllm-7b:8000/v1
  - model_name: chat
    litellm_params:
      model: openai/qwen2.5-7b-region2
      api_base: http://vllm-7b-region2:8000/v1
  - model_name: chat
    litellm_params:
      model: anthropic/claude-haiku
      api_key: sk-ant-...
      tpm: 100000   # 限速避免暴成本

router_settings:
  routing_strategy: usage-based-routing
  fallbacks:
    - chat: [chat]   # 自部署 -> 商业 API
```

业务方一个 model name，底层智能调度。

## 7. 决策清单：在哪里跑、用什么模型、什么时候量化

```yaml
step_1_choose_deployment:
  - DAU < 10K 且无合规要求？→ API
  - 合规 / 数据不出企业？→ 自部署
  - 自部署预测利用率 > 30%？→ 自部署
  - 否则 → API + 监控用量再决策

step_2_choose_model:
  - 旗舰智能（GPT-4 / Claude）必要？→ 商业 API（暂无开源对手）
  - 通用 chat / RAG / 工具调用？→ Qwen2.5-7B/14B/72B 或 Llama-3.1
  - code 专精？→ DeepSeek-Coder / Qwen-Coder
  - 多语言（中文等）？→ Qwen / Yi
  - 极低成本？→ 1.5B-3B 量化

step_3_choose_hardware:
  - 7B 单实例：A10 / 4090
  - 14B 量化：A10 / 4090
  - 14B BF16：A100 40G
  - 70B 量化：A100 80G
  - 70B BF16：4× A100 NVLink
  - 极低延迟：H100

step_4_choose_quantization:
  - 显存够 + 任务对精度敏感（code/数学）？→ FP16
  - H100 / Ada Lovelace？→ FP8（最佳性价比）
  - 显存紧 + 任务通用？→ AWQ 4-bit
  - Mac / CPU？→ GGUF Q5_K_M

step_5_optimize_stack:
  - 必开：prefix cache, chunked prefill, 流式
  - KV 紧：FP8 KV
  - 单流延迟敏感：speculative decoding
  - JSON / 工具调用：xgrammar guided decoding

step_6_capacity_and_release:
  - benchmark 实测 + 30% headroom
  - 副本 ≥ 2，跨节点
  - 灰度发布双池
  - auto-scale + 降级到 API
```

## 8. 成本监控与控制

### 8.1 关键 metric

| metric                          | 阈值 / 用途                   |
| ------------------------------- | ------------------------- |
| tokens / day（按租户、按模型）           | 看消费分布                     |
| 每个请求的 input / output token 分布   | 异常用户（abuse）发现            |
| GPU 利用率（每个实例）                  | 持续 < 30% 该缩容             |
| KV cache 占用率                    | 持续 > 90% 该扩容             |
| 降级到 API 的请求数                    | 持续高 = 自部署容量不够             |
| 不同模型的成本贡献                       | 是否过度依赖大模型                  |

### 8.2 控制手段

| 手段                          | 作用                               |
| --------------------------- | -------------------------------- |
| Per-tenant TPM/RPM 限制       | 单租户不能拖垮全局                       |
| Per-tenant 月度 budget         | 超了就拒服务 / 降级                     |
| Token 预估 + 拦截               | 1M token 的请求该拦下来                 |
| 提示用户用便宜模型（前端选择）             | 让有意识的用户省钱                      |
| 缓存（语义缓存 / exact-match cache） | 重复 query 不打模型                  |
| 离线 batch 用低峰时间               | 自部署低峰利用率上去，省 API                |

## 9. 一个完整决策示例

> 中型 SaaS 公司，1 万付费用户，每天 50 万次 LLM 调用，平均 input 1000 / output 300 token，要求 TTFT p95 < 1s，无强合规。

### 9.1 流量

```
50 万 req/day = 5.8 req/s 平均，峰值 ~30 req/s
日 token = 500K × 1300 = 6.5 亿 token
```

### 9.2 选项 A：纯 API

```
GPT-4o mini: 6.5 亿 × ($0.15 + 0.6×0.23) ≈ $190/day = $5700/month
TTFT 看 region，p95 ~500ms-1s OK
工程量：≈ 0
```

### 9.3 选项 B：自部署 Qwen2.5-7B

```
Benchmark：A100 单卡 32 并发 3000 tok/s
峰值 30 req/s × 1300 token = 39000 tok/s
需要 ≈ 14 卡满载？太多。

实际：用 4× A100，配速度优化（量化 + prefix cache + spec），
单卡 5000 tok/s 总吞吐，4 卡足够 + headroom。
A100 月租 4× $2000 = $8000
工程：1 个 SRE 50% 投入 ≈ $5000
合计 $13000/month
```

**结论**：选 A（API）。规模和合规都不强迫自部署，API 便宜且省心。如果 DAU 涨到 5 万，再算一次。

## 10. 给老板汇报的一页

```
LLM 推理决策一页纸：

1. 我们用什么？
   - 主要：自部署 Qwen2.5-72B-AWQ（4× A100 NVLink）
   - 备份：Claude Haiku API（fallback / 突发）
   - 旗舰：GPT-4o（少量复杂任务）

2. 月成本：$12,000
   - GPU $9,000 / Gateway $200 / 监控 $300 / 备份 API $2,500

3. SLA：
   - TTFT p95 < 800ms / TBT p95 < 50ms / 可用性 99.5%
   - 自部署故障 → 自动降级到 Claude Haiku（< 30s 切流）

4. 风险：
   - GPU 供应：备用 region 已预留 2× A100
   - 成本爆增：每租户 10K req/day 限速，超限提示
   - 模型升级：每次双池切流 + eval 通过才上

5. 下一步优化：
   - speculative decoding 已测，预计单流延迟再砍 40%
   - 边缘小模型试点（特定区域），网络延迟再砍 100ms
```

## 常见坑

1. **算自部署成本只算 GPU**——忽略了工程师工时。1 个 SRE 全职月成本远超几张 A100。
2. **以为自部署一定比 API 便宜**——利用率 < 20% 时通常贵。先估利用率。
3. **算 API 成本拿 list price**——商业 API 都有 batch 折扣（50% off）、prompt cache 折扣、企业合同折扣。真实价可能砍半。
4. **没把缓存收益算进 API 成本**——OpenAI / Anthropic prompt cache 命中率高时节省 50-90%。
5. **优化延迟优化错地方**——p95 800ms 中 600ms 是网络 RTT，你死磕模型优化省不了多少。先 profile 延迟构成。
6. **盲目上 H100 替换 A100**——价格涨 1.5-2x，性能涨 1.5-2x，不一定划算。看具体模型 benchmark。
7. **降级方案纸上谈兵**——真出事时降级链路根本没演练，业务全挂。月度切流演练。
8. **不监控成本异常**——某租户写了 bug 一晚上发 1M 请求，月底账单出来傻眼。设 per-tenant budget 硬限。
9. **TTFT 优化不看用户感知**——流式开了之后用户感知的"等待"是首字时间，不是 e2e。优化对的指标。

## 下一步

- 上手实操 → [03 · vLLM 实战](./03-vllm.md)
- 选好模型先 benchmark → [08 · 性能基准与调优](./08-benchmarking.md)
- 架构搭起来 → [09 · 推理服务架构](./09-architecture.md)
- 业务层成本控制（语义缓存等） → [../langchain/](../langchain/)
- agent 应用层成本控制 → [../agents/10-production.md](../agents/10-production.md)
- LLM 价格看板 → <https://artificialanalysis.ai/>
- LLM 性能 leaderboard → <https://www.anyscale.com/llm-performance-leaderboard>
