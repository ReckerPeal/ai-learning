# 10 · 合规

> 安全是技术问题，**合规是签字问题**——签字的人要么是你 CISO，要么是法官。本章不是法律咨询，是工程师视角的"上线前必看"清单。

## 1. 法规速查表

| 法规 | 范围 | 与 LLM 直接相关的点 |
| --- | --- | --- |
| **GDPR** | 欧盟 + 处理欧盟个人数据 | 数据主体权利、删除请求、跨境传输、自动化决策 |
| **CCPA / CPRA** | 加州 | 同 GDPR 的子集 + opt-out 销售 |
| **HIPAA** | 美国医疗 | PHI 处理、BAA、最小必要原则 |
| **PCI-DSS** | 处理信用卡 | 卡号不得进 prompt / log |
| **SOC 2** | 美国 SaaS 通行 | 审计、变更管理、可观测 |
| **ISO 27001** | 国际信息安全 | ISMS、风险管理 |
| **EU AI Act** | 欧盟 AI | 风险分级、透明度、文档 |
| **中国生成式 AI 暂行办法** | 中国境内 | 内容审核、备案、训练数据 |
| **NIST AI RMF** | 美国（self-attest） | 风险管理框架 |
| **Bill C-27 / AIDA** | 加拿大 | 类似 EU AI Act |

## 2. GDPR：与 LLM 强相关的 7 件事

| 条款 | 含义 | 工程实现 |
| --- | --- | --- |
| Art.5 数据最小化 | 只收必要数据 | prompt 不放无关 PII |
| Art.6 合法性基础 | 必须有处理依据 | 用户同意 / 合同 / 合法利益 |
| Art.13/14 透明度 | 告知数据如何用 | 隐私政策更新含 LLM 处理 |
| Art.15 访问权 | 用户能拿到自己数据 | 按 userId 导出 trace |
| Art.17 删除权 | "被遗忘权" | trace + 向量 + cache 全删 |
| Art.22 自动化决策 | 重大决策不能纯自动化 | HITL（贷款 / 招聘等） |
| Art.44+ 跨境 | 数据出欧盟需机制 | SCC / DPF / 区域部署 |

> **Art.22 是 Agent 应用的红线**：影响重大的决策（信贷、雇佣、保险、刑事）不能完全由 LLM 自动决定，必须有 HITL 与申诉路径。

## 3. SOC 2 控制（CC 系列与 LLM 应用对应）

| 控制 | LLM 应用对应 |
| --- | --- |
| CC1 控制环境 | 安全 policy 含 LLM 章节 |
| CC2 沟通信息 | 安全事件向用户通报机制 |
| CC3 风险评估 | 威胁模型（[01](./01-threat-model.md)）+ DPIA |
| CC4 监测 | trace + 异常告警（[05 · §8](./05-abuse.md)） |
| CC5 控制活动 | 工具 RBAC、HITL、审计 |
| CC6 逻辑访问 | LLM 调用鉴权、tenant 隔离 |
| CC7 系统运营 | LLM incident playbook |
| CC8 变更管理 | prompt / 模型 / 工具变更评审 |
| CC9 风险缓解 | guardrail + 红队 |

> SOC 2 审计时审计师会看：威胁模型、变更评审记录、red team 报告、incident 记录。**这些都要在票据系统里留痕**。

## 4. HIPAA：医疗 LLM 应用

| 要求 | 实现 |
| --- | --- |
| BAA（业务伙伴协议） | 与模型厂商签（OpenAI Enterprise / Azure OpenAI / Anthropic Enterprise） |
| 最小必要原则 | RAG 不索引全量病历，按角色筛 |
| 加密 | 传输 TLS 1.2+、静态 AES-256 |
| 审计日志 | 访问 PHI 必记录，保留 6 年 |
| 不可记忆 | 不允许 PHI 被用于模型训练（合同明确 zero-retention） |
| 去识别化 | 训练 / 评测前去 PHI（safe harbor 18 项） |

> **不要**用 ChatGPT free / Claude.ai 个人版处理 PHI——它们没 BAA。必须走有 BAA 的企业版。

## 5. PCI-DSS：金融

| 要求 | 实现 |
| --- | --- |
| 卡号永远不进 prompt | 入口 PII filter 拦截 |
| 卡号不进 log | redact 中间件 |
| 处理边界明确 | LLM 不在 CDE 内（Cardholder Data Environment） |
| Tokenize | 用 token 替代真实卡号 |

## 6. EU AI Act：分级与义务

EU AI Act 把 AI 系统分为 4 级风险：

| 等级 | 例子 | 你要做什么 |
| --- | --- | --- |
| **Unacceptable** | 社会评分、实时面部识别（公共空间） | 禁止 |
| **High Risk** | 招聘、信贷、医疗诊断、教育评分、关键基础设施 | 全套：风险管理、数据治理、技术文档、记录、透明度、人监督、稳健性、合格评估、上市后监测 |
| **Limited Risk** | chatbot、deepfake | 透明度（告知是 AI） |
| **Minimal Risk** | 拼写检查、垃圾邮件 | 无强制 |

通用大模型（GPAI）有额外义务（透明度、版权 opt-out 尊重、系统性风险评估如果训练算力 > 10^25 FLOPs）。

> 时间线：2024.08 生效；2025.02 不可接受 AI 禁令生效；2026.08 大部分高风险条款生效。**现在做**。

实操建议：

1. 把 LLM 应用按 EU AI Act 风险分级（写在威胁模型里）
2. 高风险项必须有：DPIA + 模型卡 + 数据卡 + 记录 + 监督机制
3. 透明度：用户能识别"在和 AI 对话"

## 7. 中国生成式 AI 暂行办法（2023.08）

| 要求 | 实现 |
| --- | --- |
| 内容安全 | 输入 + 输出审核（关键词 + 模型） |
| 训练数据 | 来源合法、不含侵权 |
| 备案 | 提供"具有舆论属性或社会动员能力"的服务需备案 |
| 标识 | 生成内容标识（GB 35114 / 标识办法） |
| 真实身份 | 注册时核验 |
| 未成年人保护 | 防沉迷 / 内容分级 |

跨境部署时：**境内服务必须用境内模型 + 本地化部署**，OpenAI / Anthropic 直接调不合规。

## 8. 数据驻留（Data Residency）

| 场景 | 选择 |
| --- | --- |
| 欧盟客户 | Azure OpenAI EU region / 自托管开源 / Anthropic EU |
| 中国客户 | 通义 / 文心 / 智谱 / DeepSeek |
| 美国政府 | Azure Government / AWS GovCloud |
| 高敏（金融 / 医疗） | 自托管 + air-gap |

**LLM 调用 + RAG 索引 + trace + cache + 微调数据**——每一项都要确认 region。

## 9. Model Card（模型卡）

EU AI Act 高风险项要求文档。**Model Card** 是行业惯例，最少含：

| 字段 | 内容 |
| --- | --- |
| Model details | 名称、版本、提供方、license |
| Intended use | 设计用途、不适用场景 |
| Training data | 来源、规模、时间范围、已知偏差 |
| Performance | 各任务、各人群子组的表现 |
| Limitations | 已知局限、典型失败模式 |
| Ethical considerations | 风险、缓解 |
| Caveats | 警告 |

参考：Hugging Face model card template。**自家应用也写一份**——上线评审 / 客户 due diligence 都用得上。

## 10. 上线前合规清单

### 数据 / 隐私

- [ ] 隐私政策已更新（含 LLM 处理、第三方厂商、retention）
- [ ] DPIA / PIA 完成
- [ ] PII 入口检测 + 脱敏
- [ ] Trace 落库前 redact
- [ ] 删除请求路径已实现并测试
- [ ] 数据导出请求路径已实现并测试
- [ ] 跨境数据传输有合法机制（SCC / 区域部署）
- [ ] 与模型厂商签 DPA / BAA（按需）
- [ ] 训练数据来源合法 + 文档化

### 安全

- [ ] 威胁模型完成（[01](./01-threat-model.md)）
- [ ] 红队测试完成（[08](./08-red-team.md)）
- [ ] guardrail 部署（[09](./09-defense-tools.md)）
- [ ] 工具最小权限 + HITL 配置（[06](./06-tool-safety.md)）
- [ ] Rate limit + cost guard（[05](./05-abuse.md)）
- [ ] 多租户隔离已 e2e 测试
- [ ] Incident playbook 写好 + 演练过

### 透明度

- [ ] 用户告知"在和 AI 交互"
- [ ] AI 决策有人工申诉路径（如适用 Art.22）
- [ ] 输出有局限性提示（"AI 生成的内容可能不准确"）
- [ ] 模型 / 训练数据信息可查

### 治理

- [ ] AI 使用 policy
- [ ] Model card / system card
- [ ] 变更评审（prompt / 模型 / 工具）
- [ ] 责任分担表（[01 · §5](./01-threat-model.md)）
- [ ] 法务 / 隐私 / 安全 sign-off
- [ ] 监管备案（如适用）

### 可观测 / 审计

- [ ] Trace 全量（含异常）
- [ ] 审计日志 append-only
- [ ] SOC 2 控制已实施 + 证据
- [ ] 持续监测（异常检测、cost）

## 11. DPIA（数据保护影响评估）模板

GDPR 要求"高风险"处理活动做 DPIA。以下是给 LLM 应用的简版模板：

```markdown
# DPIA: <Project Name>

## 1. 描述
- 目的:
- 数据流:（输入 → prompt → 模型 → 输出 → 落库）
- 数据类型: <PII / 健康 / 金融 / 行为...>
- 涉及主体: <用户 / 员工 / 第三方>
- 处理量级: <每日 / 每用户>

## 2. 必要性 / 比例性
- 为什么必须用 LLM？
- 数据最小化体现在哪？
- 保留期？

## 3. 风险
| 风险 | 影响 | 可能性 | 现有缓解 | 残余风险 |
| --- | --- | --- | --- | --- |
| 跨用户泄漏 | 高 | 低 | tenant filter + canary | 低 |
| ... | ... | ... | ... | ... |

## 4. 缓解措施
（对照威胁模型）

## 5. 数据主体权利保障
- 访问 / 导出: ...
- 删除: ...
- 反对自动化决策: ...

## 6. 第三方
- 模型厂商:
- DPA: 已签 / 链接
- 数据流向: 区域 / 合规

## 7. 结论
- 风险等级:
- 是否需要 DPO sign-off:
- 是否需要监管咨询:
```

## 12. 与监管 / 客户的对话准备

客户尽调（vendor security review）时常被问：

| 问题 | 准备 |
| --- | --- |
| 你们用什么模型？数据会被训练吗？ | 模型 + zero-retention 合同条款 |
| 数据存哪？多久？ | 区域 + retention policy |
| 能否本地部署？ | 自托管选项 |
| 如何防 prompt injection？ | guardrail 列表 + 红队报告 |
| 如何处理 PII？ | redact + 加密 + RBAC |
| 出事怎么办？ | incident playbook + RTO / RPO |
| 有 SOC 2 / ISO 27001 吗？ | 报告 NDA 后给 |
| 子处理者列表 | 维护一份并定期更新 |

## 常见坑

1. **以为模型厂商承担一切**：厂商对**模型本身**负责，对你的**应用 + 上下文 + 工具**不负责。责任分担表（[01 · §5](./01-threat-model.md)）。
2. **trace 全量存却没合规依据**：监管来查就傻眼。**有依据、有 retention、有访问控制**。
3. **删除请求做了主库忘了向量 / cache**：用户被遗忘权要求一致——trace、向量、缓存、备份都得删。
4. **跨境数据没机制**：欧盟客户的数据落到美国服务器没 SCC，监管罚款 4% 全球营收。
5. **EU AI Act 当成"未来的事"**：高风险项 2026 年合规——开发周期就剩一年多，**现在动手**。
6. **Model Card 抄厂商的**：用 GPT-4 但 Model Card 写"我们的模型"。要写**应用的**——含你的 prompt / 工具 / 数据。
7. **合规等上线再做**：架构决定合规可行性。**威胁模型、隔离、retention 在设计阶段就定**。

## 下一步

- [01 · 威胁模型](./01-threat-model.md) — 合规的工程基础
- [04 · 数据泄漏](./04-data-leak.md) — GDPR / HIPAA 的核心场景
- [06 · 工具调用安全](./06-tool-safety.md) — Art.22 自动化决策的工程实现
- [../agents/10-production.md](../agents/10-production.md) — 生产关卡总览
