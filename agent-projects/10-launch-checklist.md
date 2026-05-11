# 10 · 通用上线 checklist

> "上线"不是把代码部到生产那一刻，是**第一周不出大事故 + 第一月没被业务方下架**的全部过程。这章给一份通用 checklist——从安全、评测、监控、容灾、灰度五个维度——逐项打勾。任何项目上线前都过一遍。

## 1. 上线前 14 天倒计时

| 倒计时 | 关键任务 | 详细 |
| --- | --- | --- |
| **T-14** | Eval baseline 冻结 | golden 集冻结，hard/soft gate 上 CI |
| **T-12** | 安全自检 | red team + tool 权限自查 |
| **T-10** | 监控完备 | trace 全链路 + Grafana 6 张图 + alert |
| **T-7** | 容量 / 限流 | 配额、burst、降级路径都跑通 |
| **T-5** | 灰度 plan | 5% → 25% → 100% 节奏定 |
| **T-3** | 内部 dogfooding | 团队全员用 3 天 + 反馈 |
| **T-1** | Runbook & on-call | 事故响应手册 + 排班 |
| **T-0** | 灰度 5% 上线 | 开始观察 |
| **T+1** | 复盘 D1 | 是否扩量 / 回滚 |
| **T+7** | 扩量 25–100% | 否则继续观察 |

## 2. 安全 checklist

### 2.1 输入安全

- [ ] 所有用户输入走 sanitize（去 control char、限长）
- [ ] Prompt 注入防护：[`../llm-security/02-prompt-injection.md`](../llm-security/02-prompt-injection.md) 的 5 种典型攻击都过测试
- [ ] 敏感词 / 政策红线词触发拒绝（按需）
- [ ] 上传文件类型白名单 + 大小限制
- [ ] 多模态输入（图 / 音）单独走内容审核

### 2.2 工具安全

- [ ] 每个工具有显式 RBAC（user / tenant / admin）
- [ ] 副作用工具（下单 / 退款 / 删除）必经 HITL
- [ ] 工具入参强校验（pydantic schema）
- [ ] 工具入口注入 user_id / tenant_id，**不依赖 LLM 传**
- [ ] 工具调用 idempotency key（防重复执行）
- [ ] 危险动作（DROP/DELETE/rm -rf）AST 阻断
- [ ] 详见 [`../llm-security/06-tool-safety.md`](../llm-security/06-tool-safety.md)

### 2.3 数据安全

- [ ] PII 出 trace 前脱敏（手机/卡号/身份证 etc.）
- [ ] Trace 项目按租户分（避免跨租户串）
- [ ] Vector store 按租户 collection / 强 metadata filter
- [ ] DB 走只读账号（如适用）
- [ ] 敏感字段 view 层 mask
- [ ] 日志保留期与 GDPR / 隐私法对齐
- [ ] 详见 [`../llm-security/04-data-leak.md`](../llm-security/04-data-leak.md)

### 2.4 模型与 prompt

- [ ] 系统 prompt 不含 secrets
- [ ] Prompt 版本化（git 跟踪），改 prompt 走 PR
- [ ] 模型 fallback（主模型挂时自动切备用）
- [ ] 输出格式强 schema（JSON mode / Pydantic）
- [ ] LLM-as-judge 不用同一模型自评关键决策

## 3. 评测 checklist

- [ ] 自动评测集 ≥ 30 条
- [ ] 评测分层：easy / medium / hard / adversarial
- [ ] 至少 1 个 hard gate（红线 100%）
- [ ] 至少 2 个 soft gate（主指标 + 成本）
- [ ] CI PR 上跑（快集）+ nightly 跑全集
- [ ] LLM-as-judge 抽样 10–20%（节省成本）
- [ ] 线上回流采样 → 月度入 golden
- [ ] 评测报告每周发到团队（Slack / 邮件 weekly digest）
- [ ] 详见 [`../eval/`](../eval/) 与 [§09](./09-eval-monitoring.md)

## 4. 监控 checklist

### 4.1 必备图表

- [ ] QPS（按 intent / tenant）
- [ ] 中位 / p95 延迟
- [ ] 成本（按 tenant / 项目，日累计 + 月累计）
- [ ] 任务完成率
- [ ] 工具错误率（按工具拆）
- [ ] HITL 触发率
- [ ] Red flag 计数（安全告警）
- [ ] 评测指标趋势（外部 pipe 推数据）

### 4.2 告警

- [ ] Red flag > 0：P0 立刻通知 + 停服开关 ready
- [ ] p95 > 2× baseline 持续 5 min：P1
- [ ] 任务完成率 < 70% 持续 30 min：P1
- [ ] 日成本 > 预算 80%：P2 通知 + 自动限流
- [ ] HITL 触发率 > 50%：P2，可能模型 / 路由失效
- [ ] 评测主指标周降 > 3pp：P2

### 4.3 Trace

- [ ] 全链路（输入 / 节点 / 工具 / LLM call / 输出）
- [ ] 必含字段（trace_id / tenant / user_hash / cost / latency / red_flag）
- [ ] 详见 [§09 §3](./09-eval-monitoring.md)

## 5. 容灾 checklist

### 5.1 故障注入测试

- [ ] LLM provider 全挂（断网模拟）→ 应走降级
- [ ] LLM 返回非法 JSON → 应能 parse 兜底
- [ ] 工具超时 → 不能挂死，必须超时返回
- [ ] DB 不可用 → 缓存 / 友好错误
- [ ] HITL 用户 30 min 不回包 → 自动暂停 / 邮件
- [ ] Trace 系统挂 → 业务不能挂（trace 异步 + 容错）

### 5.2 降级路径

| 故障 | 降级 |
| --- | --- |
| 主模型挂 | 切备用模型（不同 provider） |
| RAG 挂 | 走 LLM 直答 + 警示"未参考知识库" |
| 工具挂 | 跳过工具 + 告诉用户"无法完成此动作" |
| 全挂 | 静态回复 + 转人工 / 排队 |

### 5.3 数据 & 状态

- [ ] LangGraph checkpointer 持久化（PG/Redis）有备份
- [ ] Vector store 有快照（每日）
- [ ] Prompt 模板有版本回滚
- [ ] 配置（whitelist / rules）走 git + GitOps

### 5.4 回滚

- [ ] 一键回滚到上一个 release（feature flag + 旧镜像热备）
- [ ] 回滚目标 ≤ 5 min
- [ ] 回滚后状态机仍能消费历史 session（checkpointer 兼容）

## 6. 灰度 checklist

### 6.1 灰度维度

| 维度 | 例 |
| --- | --- |
| 用户 | hash(user_id) % 100 < 5 |
| 租户 | 内部租户先开 |
| 流量 | 5% → 25% → 100% |
| 地域 | 单 region 先开 |
| Intent | 简单 intent 先开 |

### 6.2 灰度门控

- [ ] Feature flag（Unleash / LaunchDarkly / 自家）
- [ ] 灰度内的指标独立看
- [ ] A/B 对照（新旧版本同时跑，看相对差异）
- [ ] 详见 [`../eval/08-online-and-ab.md`](../eval/08-online-and-ab.md)

### 6.3 扩量准入条件

下一档扩量前必须满足：

| 指标 | 阈值 |
| --- | --- |
| 主指标 ≥ baseline | 不能比旧版本差 |
| Red flag = 0 | 24 小时累计 |
| 用户 👎 率 ≤ 5% | 24 小时累计 |
| p95 延迟 ≤ 目标 | 24 小时 |
| 成本 / 任务 ≤ 预算 | 24 小时 |

未满足 → 留档 / 回滚。

## 7. 合规与法务 checklist

- [ ] 用户协议 / 隐私政策更新（"AI 处理"明示）
- [ ] 数据出境 / 跨境合规（特别是欧盟 / 中国）
- [ ] 审计日志 ≥ 6 个月可查
- [ ] 用户可申请数据导出 / 删除（GDPR Article 15/17）
- [ ] 高风险决策需可解释（理财 / 医疗 / 招聘）
- [ ] 如果涉及未成年人，单独走 COPPA / 个人信息保护法
- [ ] 详见 [`../llm-security/10-compliance.md`](../llm-security/10-compliance.md)

## 8. 运维 / On-call

### 8.1 Runbook（事故响应手册）

每个项目维护 `docs/runbook.md`，至少含：

```
# Runbook: <project>
## 紧急联系
- On-call: ...
- 二线: ...

## 常见事故 -> 操作
| 现象 | 一键操作 |
| 模型挂 | 切备用模型 flag `model_fallback=true` |
| 成本爆 | 一键限流 flag `rate_limit_emergency=true` |
| ACL leak | 立刻 `kill_switch=true` 停服 |
| HITL 堆积 | 加坐席 / 临时降级到 FAQ-only |

## 一键操作位置
- Feature flag UI: <url>
- Kill switch: <url>
- 回滚 CI: <url>
```

### 8.2 排班

- [ ] 上线后第 1 周 7×24 排 on-call
- [ ] 工作日 P1 响应 ≤ 5 min，P2 ≤ 30 min
- [ ] 周报回顾 incident（一周不少于 1 次）

### 8.3 KPI 与回顾

- [ ] 上线 1 周回顾会
- [ ] 上线 1 个月数据 review
- [ ] 季度复盘：评测、成本、用户满意度

## 9. 项目对照表

将本 checklist 应用到 6 个项目，**特别关注项**：

| 项目 | 必须额外加强 |
| --- | --- |
| [§02 旅行助手](./02-travel-assistant.md) | 下单幂等、HITL 超时、退款流程 |
| [§03 深度调研](./03-deep-research.md) | 长任务超时、引用真实性、成本封顶 |
| [§04 客服](./04-customer-support.md) | PII、政策对齐、升级回路、多租户 |
| [§05 代码审查](./05-code-review.md) | secret 泄漏、误报回流、CI 失败容错 |
| [§06 数据分析](./06-data-assistant.md) | 只读账号、白名单 schema、危险 SQL 拦截 |
| [§07 知识库](./07-kb-agent.md) | ACL leak（红线）、过时文档、跨租户 |

## 10. 与其他主题的最终引用

| 主题 | 在 checklist 中的角色 |
| --- | --- |
| [`../agents/`](../agents/) | 范式、工具、规划设计原则 |
| [`../langgraph/`](../langgraph/) | 状态机 / HITL / checkpointer 实现 |
| [`../langchain/`](../langchain/) | 工具 / 函数调用 / Observability |
| [`../rag-advanced/`](../rag-advanced/) | RAG 核心 + 评测 |
| [`../eval/`](../eval/) | 自动评测 + 在线 A/B + CI |
| [`../coding-agent/`](../coding-agent/) | 代码审查 / 沙箱 / 案例参考 |
| [`../llm-security/`](../llm-security/) | 安全各章节贯穿整个 checklist |

## 11. 一页纸 cheatsheet

> 把这一页贴墙上 / 钉到 Slack：

```
上线前必勾 12 项：
[ ] Eval baseline 上 CI（hard + soft gate）
[ ] Trace 全链路 + PII 脱敏
[ ] 6 张 Grafana 图 + 6 个 alert
[ ] 工具 RBAC + idempotency
[ ] HITL 覆盖所有副作用动作
[ ] Prompt 注入 5 种典型攻击通过
[ ] 降级路径（模型 / RAG / 工具 / 全挂）
[ ] 回滚 ≤ 5 min
[ ] Feature flag + 灰度 5%/25%/100%
[ ] Runbook + on-call 排班
[ ] 隐私 / 合规更新
[ ] 内部 dogfooding 3 天 + 反馈处理

上线第 1 周看 6 个数：
- 主指标 vs baseline
- Red flag 数（必须 0）
- p95 延迟
- 任务完成率
- 成本 / 任务
- 用户 👎 率
```

## 常见坑

1. **上线前一晚才搭 trace**：来不及，回退；trace 必须 T-14 就准备好。
2. **gate 设太松**：fail_under 0.6 实际跑 0.62，CI 永远绿，掩盖问题。
3. **没有 kill switch**：出事故只能改代码发布 → 必须有 feature flag。
4. **monitor 只看技术不看业务**：p95 漂亮但用户投诉 → 业务指标必加（任务完成率、满意度）。
5. **灰度只看错误率**：缓慢退化看不出来 → 看主指标 + 成本 + 满意度组合。
6. **runbook 当 backup 文档**：从不更新；每次 incident 必更新一次。
7. **回滚没测试**：真要回滚时发现旧镜像不见了 → 每月做一次回滚演练。
8. **合规临上线才想起**：法务驳回延期 1 个月 → 项目立项时就拉法务。
9. **on-call 没轮换**：一个人扛全部 → 至少 2 人轮 + 周末交班。
10. **不复盘**：上线后跑得还行就不管了，3 个月后被业务调整打懵；每月 review 一次。

## 下一步

- 项目立项 → 回 [§01 方法论](./01-methodology.md)
- 选具体项目复盘 → §02 / §03 / §04 / §05 / §06 / §07
- 对比 6 个项目骨架 → [§08](./08-comparison.md)
- 评测与监控细节 → [§09](./09-eval-monitoring.md)
- 安全主题 → [`../llm-security/`](../llm-security/)
- 评测主题 → [`../eval/`](../eval/)

---

至此本主题 10 章完结。把"愿望"翻译成"项目"的方法、6 个端到端实战、横向对比、统一评测监控、上线 checklist 都齐了。**下一步是动手做**——选一个项目，按 [§01](./01-methodology.md) 的 PDCA 跑一遍。
