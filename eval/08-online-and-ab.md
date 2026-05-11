# 08 · 在线评测与 A/B

> 离线评测可以让你**安全迭代**，但**唯一能信的指标来自真实用户**。本章讲怎么把"线上数据 → 评测信号 → 决策"的回路跑起来。

## 1. 为什么要做在线评测

离线评测的根本局限：

- 评测集**不是**真实分布——再用心维护也会漂移
- 评测集**不会**自己更新——新场景 / 新黑话 / 新攻击不在里面
- 评测集**没有**用户上下文——情绪、时段、设备、之前对话都影响

在线评测补这个缺：用真实用户的真实行为去验证、补充、纠偏离线指标。

## 2. 在线评测的三种信号

### 2.1 显式反馈（用户主动）

- 👍/👎、星级、Likert 5 级
- "重新生成"、"换个回答"按钮
- 文本反馈

```python
client.create_feedback(
    run_id=run_id,
    key="user_thumbs",
    score=1.0,    # 或 0
    comment=user_comment,
)
```

特点：信号清晰但**稀疏**——多数用户不会主动反馈（点击率 1-5%）。

### 2.2 隐式行为（用户被动）

- 是否复制答案
- 是否重新提问（"换个说法"= 答得不好）
- 在答案区停留时长
- 是否触发"联系人工"
- 后续 query 是否在追问同一话题（追问多 = 答得不全）

特点：信号弱但**密集**，所有用户都贡献。需要事件埋点配合。

### 2.3 任务完成度

- Agent 任务最终是否完成
- 用户最终是否得到目标产物
- 后续业务 KPI（成单率、客服请求率）

特点：**最贴近业务**，但归因难，延迟长。

## 3. 把线上信号接到 LangSmith

LangSmith 的 Feedback API 是中心化收集点：

```python
# 服务端：每次 LLM 调用拿到 run_id
result = chain.invoke({"question": q}, config={"metadata": {"user_id": uid}})
run_id = ...  # 从 callback 或 LangSmith get_run_id()

return {"answer": result, "run_id": run_id}
```

```python
# 用户点👍：
@app.post("/feedback")
def feedback(run_id: str, score: float, comment: str = ""):
    client.create_feedback(
        run_id=run_id,
        key="user_thumbs",
        score=score,
        comment=comment,
    )
```

LangSmith UI 自动按 feedback 聚合每个版本的表现——看到哪个 prompt 版本得 👎 比例最高。

## 4. 线上信号转化为评测集

最有价值的工作流：**线上失败 case 自动进评测集**。

```python
def auto_collect_to_dataset(run_id, feedback_score, comment):
    if feedback_score < 0.5:   # 👎
        run = client.read_run(run_id)
        client.create_example(
            inputs=run.inputs,
            outputs=None,           # 标准答案待人工补充
            dataset_id=triage_dataset.id,
            metadata={
                "from_run": run_id,
                "user_comment": comment,
                "needs_review": True,
            },
        )
```

形成闭环：

```
用户 👎 → 进 triage 队列 → 人工 review → 加标准答案 → 进 regression set
                                              │
                                              └→ 永远跟踪这类 case
```

## 5. Shadow Mode：影子部署

新版本上线**不**改用户响应——只在后台跑一份，比对结果：

```python
async def serve(request):
    # 主路径：当前线上版本
    response = await prod_chain.ainvoke(request)

    # Shadow：新版本异步跑，不阻塞响应
    asyncio.create_task(shadow_run(request, response, candidate_chain))

    return response

async def shadow_run(request, prod_response, candidate_chain):
    try:
        candidate_response = await candidate_chain.ainvoke(request)
        log_shadow_diff(request, prod_response, candidate_response)
    except Exception as e:
        log_shadow_error(e)
```

收集到大量 (prod, candidate) 对，可以：
- 跑 pairwise judge："candidate 是否优于 prod"
- 算指标差异
- 抽样人工 review 不一致的样本

特点：**零风险**收集对照数据，但需要服务端额外算力（成本翻倍）。

## 6. A/B 测试

把流量分两组，比较真实指标：

### 6.1 分流

按用户 ID 哈希分流（同一个用户始终同一组，避免污染）：

```python
import hashlib

def variant_for(user_id: str, experiment: str) -> str:
    h = hashlib.md5(f"{experiment}:{user_id}".encode()).hexdigest()
    return "B" if int(h, 16) % 100 < 50 else "A"

variant = variant_for(user.id, "rag-v3.2")
chain = chain_v3_2 if variant == "B" else chain_v3_1
result = chain.invoke(...)

# 记录 variant 进 metadata
log.info("rag.serve", user_id=user.id, variant=variant, run_id=run_id)
```

### 6.2 灰度阶梯

不要 0% → 100% 直跳，按阶梯放量：

```
1% → 5% → 25% → 50% → 100%
每阶段观察 24-72 小时，指标稳定再升档
```

每阶段都看：
- 业务 KPI（用户满意度、完成率）
- 守门指标（延迟、错误率）
- 离线指标的"在线版本"（faithfulness 抽样判断）

### 6.3 显著性

A/B 看一两天的差异可能是噪声。基本统计：

```python
from scipy import stats

# 二元指标（成功率）
chi2, p = stats.chi2_contingency([
    [success_a, fail_a],
    [success_b, fail_b],
])[:2]
# p < 0.05 才有统计显著性

# 连续指标（延迟、token）
t_stat, p = stats.ttest_ind(latencies_a, latencies_b)
```

样本量小 → 没显著性 → 不要轻易下结论。500 用户起步，关键决策 5000+。

## 7. Online Pairwise（高阶）

LMArena 风格：让真实用户对比两个版本：

```
用户提问
   ↓
后端同时跑 A 和 B
   ↓
盲测展示两个答案
   ↓
用户选哪个更好（不知道哪个是哪个）
```

特点：
- 信号最强（真实用户偏好）
- 有 friction（用户要做选择）
- 适合"上线哪个候选"的决策

落地一般在内测期 / dogfood 阶段做。

## 8. 实时监控指标（无需 ground truth）

线上没有标准答案，但有些指标**不需要**也能看：

| 指标 | 怎么算 | 信号 |
|---|---|---|
| 答案长度分布 | 实时统计 | 突变 = prompt 出问题 |
| 工具调用频率 | 监控 ToolNode | 飙升 = LLM 进死循环 |
| 拒绝率（"我不知道"占比） | NLP 检测 | 突增 = 检索挂了 / 漂移 |
| Recursion limit 触发率 | LangGraph 自带 | > 1% = Agent 设计问题 |
| Latency p50/p95 | 监控 | p95 飙升 = 某类 query 触发慢路径 |
| Token 消耗 / call | LangSmith usage | 增长 = 上下文越来越长 |
| 错误率 | try/except | 任何上升都该告警 |

写个 Grafana / Datadog 看板，每个指标 24 小时趋势 + 7 天对比。

## 9. Drift 检测

模型行为可能慢慢漂移（外部因素：流量分布变化、模型版本升级、文档库变化）。三种检测：

### 9.1 输入分布漂移

```python
# 把今天的 query embeddings 和上周的比，KL 散度或 max distance
weekly_centroid = mean(query_embeddings_last_week)
today_distance = mean([cos_dist(q, weekly_centroid) for q in today_queries])
# 突变 = 用户在问新东西
```

### 9.2 输出分布漂移

```python
# 答案长度、关键短语、拒绝率的周对比
# 任何明显偏离 → 告警
```

### 9.3 评测漂移

每天对线上随机抽 50 个 trace 跑 LLM judge，看 faithfulness、relevancy 趋势：

```python
sampled = sample_recent_traces(n=50)
scores = [judge(t) for t in sampled]
record_metric("online_faithfulness", mean(scores))
```

7 日均线连续下降 → 排查（数据库变了？文档过期？）。

## 10. 在线 + 离线的协同回路

```
┌──────── 离线 ────────┐         ┌──────── 在线 ────────┐
│  Golden Set          │         │  Production traces   │
│  Regression          │         │  User feedback       │
│  CI / Pairwise       │         │  Behavior signals    │
└──────────┬───────────┘         └──────────┬───────────┘
           │                                │
           │       新版本通过离线验证          │
           └──────────────┬─────────────────┘
                          │
                          ▼
                  Shadow / 灰度上线
                          │
                          ▼
                  在线 metrics + 用户反馈
                          │
        ┌─────────────────┼──────────────────┐
        ▼                 ▼                  ▼
   离线集补充失败 case   告警/回滚      A/B 决策合并
```

把这个回路跑起来——团队的 LLM 应用迭代速度会比"只做离线"的快 3 倍以上。

## 11. 上线评测 checklist

新版本上线前确认：

- [ ] 离线评测主指标涨了，守门指标没退
- [ ] Pairwise vs 当前线上 ≥ 50% 胜率
- [ ] 有可分流的灰度方案（按 user_id hash）
- [ ] 监控埋点齐：feedback、延迟、错误、token、工具调用
- [ ] 告警阈值设了：核心指标的 7 日均线偏离自动告警
- [ ] 回滚预案：能在 5 分钟内切回
- [ ] 失败 case 自动进 triage 队列
- [ ] 抽样人工 review 通道（每天 20 条）

## 12. 常见坑

| 现象 | 原因 |
|---|---|
| 用户反馈极少（< 1%） | 没有显眼的反馈 UI；加按钮、加热门话题询问 |
| 反馈集中负面 | 满意用户不会主动反馈；要看隐式信号 + 抽样 |
| A/B 涨幅看着大但 p > 0.05 | 样本量不够；继续跑 |
| 离线涨在线跌 | 离线集偏离真实分布；用真实日志重建 |
| Shadow 跑挂主服务 | 没用 async / fire-and-forget；用 task queue（Celery / Redis） |
| 灰度后 cost 飙升 | 新版本 token 消耗高没监控；加 cost 守门 |
| 漂移检测频繁误报 | 阈值太敏感；用周环比而不是日环比，同时看绝对水平 |
| 不同时区 / 时段差异大 | 看 fairness：分时段 / 分人群报指标 |

## 13. 下一步

- [09 · CI 与回归](./09-ci-and-regression.md)：把上线决策接到自动化里
- [10 · 进阶](./10-advanced.md)：用线上失败合成对抗测试集
