# 08 · 6 个项目横向对比

> 走完 6 个项目，停下来做一次**横向对比**。表面看 6 个 Agent 长得各不一样，但抽掉业务皮以后，骨架其实只有 4–5 种组合。这章把架构差异、共性、失败模式摆在同一张表上，让下次再做 Agent 时**少走 50% 弯路**。

## 1. 项目一览

| # | 项目 | 章节 | 一句话定位 |
| --- | --- | --- | --- |
| P1 | 旅行助手 | [§02](./02-travel-assistant.md) | 多工具 + HITL 强 + 中等任务长度 |
| P2 | 深度调研 | [§03](./03-deep-research.md) | Plan-Execute + 多 researcher 并发 + 长任务 |
| P3 | 客服 Agent | [§04](./04-customer-support.md) | 状态机 + 强合规 + HITL + 多租户 |
| P4 | 代码审查 | [§05](./05-code-review.md) | CI 触发 + 静态工具混合 + 评论分级 |
| P5 | 数据分析助手 | [§06](./06-data-assistant.md) | Text-to-SQL + 安全执行 + plot |
| P6 | 知识库 Agent | [§07](./07-kb-agent.md) | Agentic RAG + 多租户 + 权限 |

## 2. 架构对比表

| 维度 | P1 旅行 | P2 调研 | P3 客服 | P4 代审 | P5 数据 | P6 知识库 |
| --- | --- | --- | --- | --- | --- | --- |
| **核心范式** | Plan-Execute | Plan + Supervisor | 状态机 + ReAct 子图 | DAG | DAG + repair loop | Agentic RAG |
| **任务长度** | 中（5–10 步） | 长（10–30 步） | 短–中（1–5 步） | 中 | 短–中 | 短–中 |
| **HITL** | 强（2 次）| 无 | 强（升级）| 弱（人审 PR）| 弱 | 弱（反馈）|
| **并发** | 工具并发 | researcher 并发 | 无 | 文件并发 | 无 | 检索并发 |
| **记忆** | 用户偏好 | 无 | 长+短时 | 历史 PR 模式 | 历史问题缓存 | 用户画像 + episodic |
| **核心工具** | 搜索/下单 API | 检索 / fetch | CRM / 工单 | git / lint | DB / plot | 检索 / rerank |
| **沙箱** | 不需要 | 不需要 | 不需要 | E2B 跑 lint | DB 只读账号 | 不需要 |
| **多租户** | 弱（单 OTA） | 无 | **强** | 弱（按 repo） | 强 | **强** |
| **安全核心** | 下单防重 | 引用真实性 | PII + 越权 | 密钥泄漏 | SQL 注入 / 越权 | ACL 隔离 |
| **状态持久化** | Postgres checkpointer | 无（短任务）| Redis | 无 | 无 | Redis 短时 |
| **延迟级别** | 秒（plan）+ 分（end-to-end）| 分钟 | 秒（首响 2s） | 分钟 | 秒（15s） | 秒（5s） |
| **每次成本** | $0.10–0.30 | $0.5–1.5 | $0.01–0.05 | $0.05–0.10 | $0.02–0.05 | $0.01–0.03 |

## 3. 共性骨架

抽掉差异后，6 个项目共享一份"通用 Agent 骨架"：

```
   ┌────────────────┐
   │ Auth / Context │   ← 注入用户 / 租户 / 权限
   └──────┬─────────┘
          ▼
   ┌────────────────┐
   │ Recall         │   ← 记忆 + RAG 召回（可选）
   └──────┬─────────┘
          ▼
   ┌────────────────┐
   │ Plan / Classify│   ← Plan-Execute 或 Classifier 路由
   └──────┬─────────┘
          ▼
   ┌────────────────┐
   │ Execute        │   ← 工具调用 / 检索 / 生成
   │  (loop / fanout)│
   └──────┬─────────┘
          ▼
   ┌────────────────┐
   │ Self-check     │   ← Reflection / Judge / Lint
   └──────┬─────────┘
          ▼
   ┌────────────────┐
   │ Safety Gate    │   ← PII / 政策 / ACL / 危险动作
   └──────┬─────────┘
          ▼
   ┌────────────────┐
   │ Output         │
   └──────┬─────────┘
          ▼
   ┌────────────────┐
   │ Memory Write   │   ← 长时学习（可选）
   └────────────────┘
```

> "Auth → Recall → Plan → Execute → Self-check → Safety → Output → Memory" 八步式，是从这 6 个项目里**蒸馏**出来的最稳骨架。

## 4. 失败模式归类

把 6 个项目"常见坑"汇总，归为 6 类共性失败模式：

| 类别 | 表现 | 出现项目 | 通用解 |
| --- | --- | --- | --- |
| **幻觉** | 编造工具结果 / 引用 / 政策 | P1, P2, P4, P6 | 强 cite + schema 校验 + 工具结果落库 |
| **越权 / ACL 漏** | 看到 / 修改 / 引用了不该的内容 | P3, P5, P6 | 入图前 assert + 工具入参注入 user/tenant + RLS |
| **死循环 / 漂移** | 长任务发散、replan 无终止 | P1, P2, P5（repair）| step 上限 + replan 上限 + 重复检测 |
| **成本爆炸** | 一次任务烧光预算 | P1, P2 | per-session cost cap + 模型降档 + 缓存 |
| **延迟尾部** | p95 远高于中位 | P1, P3, P5 | 并发 + 超时 + 兜底回退 |
| **HITL 假阳/假阴** | 该升级没升 / 不该问的问了 | P1, P3 | 阈值调参 + 反馈闭环 |

## 5. 范式选型决策树

下次接到新需求，按这棵树选范式：

```
新需求
  │
  ├─ 任务步数 ≤ 3？
  │     ├─ 是 → 单 Agent ReAct / 直接 LLM 调用
  │     └─ 否 ↓
  │
  ├─ 步骤是否大致固定？
  │     ├─ 是 → 状态机 / DAG（P3, P4, P5）
  │     └─ 否 ↓
  │
  ├─ 需要中间用户确认？
  │     ├─ 是 → Plan-Execute + HITL（P1）
  │     └─ 否 ↓
  │
  ├─ 可拆成 N 个独立子任务并发？
  │     ├─ 是 → Supervisor + Worker（P2）
  │     └─ 否 → Plan-Execute（带 replan）
  │
  └─ 知识密集？
        ├─ 是 → Agentic RAG（P6）
        └─ 否 → 工具 Agent
```

详见 [`../agents/02-paradigms.md`](../agents/02-paradigms.md)、[`../agents/05-planning.md`](../agents/05-planning.md)、[`../agents/06-multi-agent.md`](../agents/06-multi-agent.md)。

## 6. 工具集设计模式

| 模式 | 例子 | 适用 |
| --- | --- | --- |
| **强 schema 工具** | P1 search_flights | 结构化输入/输出，可校验 |
| **检索类工具** | P2/P6 search、retrieve | 多源、并发 |
| **副作用工具（HITL 必经）** | P1 book、P3 refund | 钱 / 不可逆动作 |
| **静态分析工具** | P4 ruff、bandit | 与 LLM 互补 |
| **数据库工具** | P5 readonly_query | RBAC + lint + dry-run |
| **跨系统 webhook** | P3 工单 | 异步 + idempotency |

工具数量：**所有项目都控制在 10 个以内**——超过 10 个工具，LLM 选择正确率会显著下降（参考 [`../coding-agent/10-case-study.md`](../coding-agent/10-case-study.md) §7）。

## 7. 评测策略对比

| 项目 | 评测主轴 | 关键自动指标 | 关键主观 |
| --- | --- | --- | --- |
| P1 旅行 | 任务完成 + 预算 | plan JSON / 预算超出 | 行程质量人评 |
| P2 调研 | 引用 + 覆盖 | URL 200 / outline 覆盖 | 报告质量人评 |
| P3 客服 | 升级召回 + 合规 | intent / ACL / PII | τ-bench 风格 |
| P4 代审 | precision 与 nit | seeded recall / nit 占比 | 用户 👍/👎 |
| P5 数据 | SQL exec 一致 | first-pass / exec match | 业务方理解度 |
| P6 知识库 | RAG 指标 | RAGAS 三件套 / ACL leak | 答案有用度 |

> 共性：**至少 1 个 0-tolerance 红线**（ACL/PII/危险动作 100%），1 个**质量主指标**，1 个**成本/延迟约束**。

详见 [§09](./09-eval-monitoring.md) 与 [`../eval/`](../eval/)。

## 8. 上线难度对比

| 难度维度 | P1 | P2 | P3 | P4 | P5 | P6 |
| --- | --- | --- | --- | --- | --- | --- |
| 安全合规 | 中 | 低 | **高** | 中 | **高** | **高** |
| 多租户 | 低 | 低 | **高** | 低 | 中 | **高** |
| 数据接入 | 中（API）| 中（搜索 API）| 中（IM/CRM）| 低（GH webhook）| **高**（DB schema）| **高**（多源同步）|
| 长任务 | 中 | **高** | 低 | 中 | 低 | 低 |
| 监控复杂度 | 中 | 中 | 中 | 中 | 中 | 中 |
| 总难度 | 中 | 中–高 | **高** | 中 | **高** | **高** |

> 第一个项目挑 P1 / P4，第二个项目再啃 P3 / P5 / P6。**别第一次就做客服或知识库**，会被合规拖死。

## 9. 共同教训（被这 6 个项目验证）

### 9.1 工程层面

1. **Trace 是 Day 1 必备**：6 个项目都因为没接 trace 在某个阶段 debug 失败过。
2. **评测集先于 prompt**：所有项目里有评测 baseline 的版本，迭代效率高 3×。
3. **HITL 在决策叉口，不在动作前**：用户在最后一步往往已经累了。
4. **多模型分档**：plan/critic 用大模型，execute 用小模型，可省 50% 成本。
5. **重要决策落 ADR**：3 个月后回看决策路径，是项目能否传承的关键。

### 9.2 模式层面

1. **状态机 > 全自由 ReAct**（除非任务很短）
2. **Supervisor + Worker > 单 mega-agent**（任务可拆并发时）
3. **静态工具 + LLM 混合 > LLM-only**（特别是代码 / 数据）
4. **强 schema 工具 > 文本协议工具**
5. **Self-RAG / Reflection 上限 1–2 轮**（再多就发散）

### 9.3 安全层面

1. **ACL filter 必须在 prompt 之外** —— LLM 不可被信任做权限判断
2. **危险操作 100% HITL** —— 钱、删除、跨权限的动作
3. **trace 必须脱敏** —— 上 LangFuse/LangSmith 前过一遍 PII 过滤
4. **prompt 注入要在工具白名单解决** —— 即使被注入也无法越权

详见 [`../llm-security/`](../llm-security/)。

## 10. 何时这套方法**不**适用

| 场景 | 替代方案 |
| --- | --- |
| 单次问答（无工具）| 直接 LLM API + 简单 RAG，不需要 graph |
| 实时游戏 / 高频交易 | 延迟敏感，Agent 不合适 |
| 完全自主、无评测 | 跑不出来；这套方法的前提是有评测 |
| 监管极严（医疗诊断 / 法务出庭） | 主流程仍人主导，Agent 仅辅助 |
| 极简 chatbot | Cloudflare Workers + OpenAI 就够，不需要 LangGraph |

## 常见坑

1. **照抄某项目的全部细节**：每个项目都是基于业务约束设计的，套用要重读 ADR。
2. **追"多 Agent"潮流**：99% 项目单 Agent 状态机够用；非要 multi-agent 反而 debug 困难。
3. **不同项目共用一个评测集**：每项目都得自己的 golden + 红线。
4. **共用一个 trace 项目**：会乱；按项目分 LangSmith/LangFuse 项目。
5. **共用一份 prompt 模板库**：抽公共子模板可以，主 prompt 不要复用——业务约束不同。

## 下一步

- 监控与评测的统一方案：[§09](./09-eval-monitoring.md)
- 上线 checklist：[§10](./10-launch-checklist.md)
- 回去深挖某个项目细节：[§02](./02-travel-assistant.md)–[§07](./07-kb-agent.md)
- Agent 范式综合：[`../agents/02-paradigms.md`](../agents/02-paradigms.md)
- 框架选择：[`../agents/09-frameworks.md`](../agents/09-frameworks.md)
