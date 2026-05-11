# 10 · 规模化案例

前面九章讲了**手段**——本章讲**时序**：在 10K → 100K → 1M DAU 的成长过程中，什么时候上什么。我们把一个虚拟但参数贴近真实的 SaaS 公司（AI 客服 + 知识库 + 摘要功能）放到三个里程碑，每个里程碑算账、画曲线、列优化清单。

## 1. 公司画像

> **AcmeAI**：B2B 客服 SaaS，2026 年初成立。订阅制 $30/seat/月，平均每企业 50 个 seat。功能包括：
> - 智能客服（实时聊天）：每用户 8 次/天，input 3000 / output 300
> - 知识库 QA：每用户 5 次/天，input 5000 / output 400
> - 自动摘要（夜间）：每用户 2 次/天，input 8000 / output 600

## 2. Stage 1：10K DAU（ARR ~$3.6M）

**业务状态**：100 企业客户，5K 付费 seat，DAU 约 10K。技术栈极简：单 region、纯 API、无 cache、无路由。

### 2.1 流量与成本

```
日 LLM 调用：10K × (8+5+2) = 150K req/day
日 token：
  客服：10K × 8 × (3000+300) = 264M token
  知识库：10K × 5 × (5000+400) = 270M token
  摘要：10K × 2 × (8000+600) = 172M token
合计：706M token/day = 21.2B token/month
```

| 项                       | 月成本（list price）   |
| ----------------------- | --------------- |
| Sonnet 4.5 全量（无优化）       | ~$60K           |
| 监控 Helicone Pro          | $500            |
| 向量库（Pinecone Standard）   | $200            |
| 工程师工时（2 FTE × 30% LLM 维护） | ~$10K（分摊）        |
| **合计**                   | ~$71K           |

**单位经济**：

- 收入：$30 × 5000 seat = $150K
- LLM 成本占比：47% ← **太高，毛利率撑不住**
- ARR/cost = 不健康

### 2.2 Stage 1 优化清单（按 ROI 排序）

| 优先级 | 动作                                       | 预期节省      | 工时   |
| --- | ---------------------------------------- | --------- | ---- |
| P0  | 开 Anthropic prompt cache（system + KB 部分） | 50-60%    | 1 周  |
| P0  | 摘要任务切 Batch API（5 折）                     | 50%       | 3 天  |
| P1  | 接 LiteLLM gateway + 路由到 Haiku（简单意图）       | 20-30%    | 2 周  |
| P1  | 上 Helicone / Langfuse 接 dashboard         | 监控前提      | 1 周  |
| P2  | 加 per-tenant TPM 限流                       | 防意外      | 3 天  |

### 2.3 优化后状态

```
Prompt cache 70% 命中 → input fresh 部分 ×0.3
Batch（摘要任务）50% 折扣 → 摘要部分 ×0.5
路由（30% 流量到 Haiku）→ blend 单价 ×0.65
```

| 项               | 月成本     |
| --------------- | ------- |
| 客服（cache + 路由）  | $14K    |
| 知识库（cache + 路由） | $11K    |
| 摘要（cache + batch） | $6K     |
| 监控 + 向量库         | $700    |
| 工程师工时           | $10K    |
| **合计**          | **~$42K** |

LLM 成本占收入降到 28%，毛利舒服多了。

## 3. Stage 2：100K DAU（ARR ~$36M）

**业务状态**：1000 企业客户，50K seat，DAU 100K。开始遇到**单一 provider 限速 + 高峰排队**，决策点：是否上自部署。

### 3.1 流量与成本（不变手段维持）

```
日 LLM 调用：100K × 15 = 1.5M req/day
日 token：7B
月 token：210B
```

只把 Stage 1 的优化按 10x 放大：

| 项              | 月成本（沿用 Stage 1 优化） |
| -------------- | ------------------ |
| API LLM 成本     | ~$380K             |
| 监控 + 向量库（升级）   | ~$3K               |
| 工程师工时（4 FTE × 30%） | $24K            |
| **合计**         | ~$407K             |

LLM 占收入 27% — 还行，但**进一步降本需要新手段**。

### 3.2 Stage 2 优化清单

| 优先级 | 动作                                       | 预期节省     | 工时   |
| --- | ---------------------------------------- | -------- | ---- |
| P0  | 上自部署 Qwen3-14B-AWQ（承接 70% 流量）            | 50-65%   | 6 周  |
| P0  | API fallback 配置 + 演练                      | 可用性      | 2 周  |
| P1  | 加语义 cache（Redis Stack）兜底高频 query         | 10-15%   | 2 周  |
| P1  | A/B 框架 + 路由学习（RouteLLM）                  | 10-20%   | 4 周  |
| P2  | 多 region 部署 + KV cache 优化                | 延迟，间接降本 | 4 周  |
| P2  | 按 tenant 月度预算 + 自动 warning              | 防爆      | 2 周  |

### 3.3 自部署的临界点检验

```python
# 用 §06 的 breakeven 公式
api_blend = 1.5      # 平均 $/M token blend（含 cache）
self_host_monthly = 4*2000 + 8000 + 1500   # 4× A100 + SRE + misc = $17.5K
tokens_per_qps_month = 86400 * 30 * 600    # 600 tok / req

breakeven_qps = self_host_monthly / (tokens_per_qps_month * api_blend / 1e6)
# ≈ 6.7 QPS

# Stage 2 平均 QPS：1.5M / 86400 ≈ 17 QPS，峰值 50+ QPS
# → 远超临界，自部署划算
```

### 3.4 优化后状态

```
70% 流量 self-host Qwen3-14B-AWQ（边际成本接近 0）
20% 流量 Haiku（中等复杂度）
8% 流量 Sonnet（复杂多步）
2% 流量 GPT-5（旗舰任务）
+ 语义 cache 额外砍 12% LLM 调用
```

| 项                  | 月成本     |
| ------------------ | ------- |
| 4× A100 + SRE      | $17.5K  |
| API 部分（30% 流量）     | ~$95K   |
| 监控 + 向量库（升级）       | $5K     |
| 工程师工时（4 FTE × 30%） | $24K    |
| **合计**             | **~$141K** |

LLM 成本占收入降到 9.4%，毛利率明显改善。

## 4. Stage 3：1M DAU（ARR ~$300M+）

**业务状态**：1 万企业客户，500K seat，DAU 1M。多 region、多 SRE 团队、自蒸馏模型。

### 4.1 流量

```
日 LLM 调用：15M req/day
日 token：70B
月 token：2.1T
```

### 4.2 优化全栈到位

| 优先级 | 动作                                       | 预期节省     | 工时    |
| --- | ---------------------------------------- | -------- | ----- |
| P0  | 自蒸馏：用 Sonnet 输出训练 Qwen3-7B / 14B 业务模型  | 30-50%   | 8 周    |
| P0  | 多 region 自部署（成本 + 延迟）                    | 间接降本 + SLA | 12 周  |
| P1  | Prompt 优化：把 system prompt 压缩 30%        | 5-10%    | 4 周    |
| P1  | 多模态低成本 provider（Gemini Flash）替换部分场景    | 多模态 -50% | 4 周    |
| P2  | 按 SKU 拆 tier：Pro 企业用 Sonnet，Free 用 Haiku | 单位经济     | 6 周    |
| P2  | 自建监控 + ClickHouse + 实时拆账                | 运营效率     | 6 周    |

### 4.3 优化后状态

```
80% 流量 self-host（含蒸馏小模型）：8× A100 + 4× H100
10% 流量 Haiku API
8% 流量 Sonnet API
1% 流量 GPT-5（旗舰）
1% 流量 Gemini Flash（多模态）
+ 厂商 prompt cache + 自建语义 cache + 自部署 prefix cache 三层叠加
```

| 项                       | 月成本     |
| ----------------------- | ------- |
| GPU 集群（8× A100 + 4× H100） | $35K    |
| SRE × 3 + LLM platform 工程师 × 4 | $80K |
| API 部分（20% 流量）          | ~$280K  |
| 监控 + ClickHouse + 网络    | $25K    |
| 工程师工时（其他团队 LLM 相关 20%） | $30K    |
| **合计**                  | **~$450K** |

LLM 成本占收入降到 ~5%，单位经济非常健康。

## 5. 三阶段对比

| 维度               | Stage 1（10K）   | Stage 2（100K）  | Stage 3（1M）       |
| ---------------- | -------------- | ---------------- | ----------------- |
| ARR              | $3.6M          | $36M             | $300M+            |
| LLM 月成本           | $42K（优化后）       | $141K            | $450K             |
| LLM / 收入          | 28% → 14%      | 9-10%            | ~5%               |
| 自部署 / API 比      | 0 / 100         | 70 / 30          | 80 / 20           |
| 主要降本手段          | cache + batch + 路由 | + 自部署 + 语义 cache | + 蒸馏 + 多 region   |
| 工程团队            | 1 半 FTE          | 4 半 FTE           | 7+ FTE             |
| 监控栈              | Helicone        | Langfuse self-host | ClickHouse 自建    |

## 6. 关键决策点（时序）

```
DAU < 5K：
  - 全 API，专注 PMF
  - 不上 cache（命中率不够，维护成本超过收益）
  - 监控起码用 Helicone 起步

DAU 5K-50K：
  - 上 prompt cache（厂商）
  - 上 Batch API（离线任务）
  - 上路由（Haiku/Sonnet 分级）
  - 上 LiteLLM gateway
  - 上 per-tenant 月度预算

DAU 50K-300K：
  - 评估自部署（看临界 QPS）
  - 自部署上线后 API 留作 fallback
  - 上语义 cache
  - 多 region（按业务地理分布）

DAU 300K+：
  - 自蒸馏小模型
  - 多卡集群 + 自动 scaling
  - 实时按租户拆账 dashboard
  - 按 tier 差异化 LLM stack
  - 自部署占主流（> 70%）
```

## 7. 三种典型错误时序

**错误一：太早自部署**

- 1K DAU 就上自部署 7B，GPU 利用率 < 10%，单 token 成本是 API 的 5 倍。
- 教训：DAU < 30K 一般别碰自部署，除非合规硬要求。

**错误二：太晚上 cache**

- 100K DAU 才意识到 cache 重要，回头改 prompt 结构。每天浪费 $5K 多花了 6 个月。
- 教训：prompt cache 应在 DAU 5K-10K 就开始用，成本极低。

**错误三：没监控就优化**

- 一上来做了 cache + 路由 + batch，但没 dashboard，半年后发现路由配错了大头还在 Sonnet，cache 命中率 < 20%。
- 教训：先监控（即使简陋）再优化，不然不知道动作有没有效。

## 8. 单位经济曲线（关键看板）

最该跟的一张图：**cost / DAU / month** 随时间下降。

```
$ / DAU / month
   ↑
   $7.0 │ ●
        │  ●
   $5.0 │   ●
        │    ●●
   $3.0 │      ●●●
        │         ●●●●        Stage 2 自部署上线
   $2.0 │             ●●●●●─┐
        │                   ●●●●●●
   $1.0 │                          ●●●●●●  ← Stage 3
        │
   $0.5 ├──────────────────────────────────────→ time
        Q1   Q2   Q3   Q4   Q5   Q6   Q7
```

**好的曲线**应该是阶梯下降：每次大手术（cache、自部署、蒸馏）都带来一个 step down。**平的曲线 = 在烧钱**。

## 9. 决策检查清单

每季度自查一次：

```yaml
监控:
  - [ ] 有按 tenant / feature / model 拆账 dashboard
  - [ ] 月度预算 alert 设置
  - [ ] cost / DAU 曲线跟踪

优化:
  - [ ] Prompt cache 命中率 > 60%
  - [ ] 至少 2 个模型在路由中（按难度）
  - [ ] 离线任务 100% 走 batch
  - [ ] 限流 per-user + per-tenant 都有

自部署:
  - [ ] 算过当前规模的临界 QPS
  - [ ] 当 DAU > 临界值后已经评估自部署
  - [ ] 自部署上线后有 API fallback 演练

业务:
  - [ ] cost / DAU 在下降或稳定
  - [ ] LLM / 收入 < 15%（或上升 < DAU 上升）
  - [ ] 有 eval 验证降本不掉效果
```

## 10. 给老板汇报的一页

```
LLM 成本季度汇报模板：

1. 总成本 vs 预算
   - 本季度 LLM 总成本：$X
   - 预算：$Y（达成 N%）
   - 同比上季度：±N%

2. 单位经济
   - cost / DAU / month：$Z（vs 上季度 $Z'）
   - LLM 占收入：N%（vs 上季度 N'%）

3. 关键优化交付
   - 本季度上线：[cache 重构 / 自部署 7B / 路由 v2]
   - 节省效果：估算每月 $A

4. 风险与下季度计划
   - 风险：[provider X 调价 / 自部署 GPU 缺货 / 业务流量预期 2x]
   - 计划：[自蒸馏 / 多 region / 新 feature 成本预估]

5. 决策需要的支持
   - 需要采购 N 张 GPU
   - 需要招 N 个 SRE
   - 或：申请提升 Anthropic tier
```

## 常见坑

1. **优化无序、缺规划**——一会儿试 cache、一会儿试自部署，没有 cost / DAU 曲线做主线。
2. **过早过度优化**——5K DAU 就上一整套自部署 + RouteLLM + ClickHouse，工程债吃掉所有节省。
3. **没算工时**——只对比 API 账单 vs GPU 账单，忽略 SRE 全职成本。
4. **效果回归**——为了省钱切到 Haiku，客诉激增、流失率上升，省的钱不如丢的收入。必须 eval。
5. **缺 fallback 演练**——自部署挂了业务全停，月度演练能避免。
6. **决策不写在表里**——「我们要不要自部署」讨论 N 次没有数据支撑，靠拍脑袋。每次都套 §06 / §02 的计算器。
7. **追求账单数字，忘单位经济**——业务涨 3x，账单涨 1.5x 是好事；账单不涨但 DAU 跌才是大事。
8. **不与 finance / sales 对齐**——优化报告给工程团队，但 CFO / 销售根本看不懂。报告做两版：技术版 + 业务版。

## 下一步

- 回到第 1 章重新审视成本结构 → [01 · 成本结构拆解](./01-cost-structure.md)
- 单位经济推演 → [02 · Token 经济](./02-token-economics.md)
- 按当前规模选路由策略 → [03 · 模型路由](./03-model-routing.md)
- 自部署详细决策 → [06 · 量化与自部署经济性](./06-quantization-economics.md)
- 监控落地 → [09 · 成本监控](./09-cost-monitoring.md)
- 自部署推理深挖 → [../llm-inference/](../llm-inference/)
- 业务效果回归验证 → [../eval/](../eval/)
- 产业行情看板 → <https://artificialanalysis.ai/>
