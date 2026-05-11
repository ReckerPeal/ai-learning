# 01 · 威胁模型与 OWASP LLM Top 10

> 你做的不是"加一层 ChatGPT"，是把一个**会被自然语言操控的执行引擎**接上了你的数据库、邮箱和支付系统。先把威胁模型理清楚，再谈具体防御。

## 1. 为什么 LLM 安全独立成主题

传统 Web 安全的核心假设：**代码是确定的，输入是不可信的**。所以你做参数校验、做转义、做 RBAC——边界清晰。

LLM 把这个假设打破了：

| 维度 | 传统 Web | LLM 应用 |
| --- | --- | --- |
| 信任边界 | 代码可信 / 输入不可信 | 代码 + prompt + 工具结果 + RAG 文档全部混在一起 |
| 输入解析 | 编译器 / parser，确定 | 自然语言，概率性 |
| 控制流劫持 | 需要 RCE / SQLi 等漏洞 | 一句"忽略上面所有指令"就够 |
| 攻击成本 | 需要技术门槛 | 任何会写中文的人都能尝试 |
| 漏洞修复 | patch 代码 | 改 prompt + 加防御层 + 也许换模型 |
| 可重现性 | 输入相同结果相同 | temperature > 0 时同输入不同输出 |

> 关键认识：**prompt 不是输入，是代码**。一旦攻击者能影响进入模型的 prompt（任何位置），他就能影响模型的行为。

## 2. OWASP LLM Top 10 (2025 版) 速览

| 编号 | 名称 | 一句话 | 本主题对应章节 |
| --- | --- | --- | --- |
| LLM01 | Prompt Injection | 通过输入操纵 LLM 行为 | [02](./02-prompt-injection.md) |
| LLM02 | Sensitive Information Disclosure | 系统泄漏敏感信息 | [04](./04-data-leak.md) |
| LLM03 | Supply Chain | 模型 / 数据 / 插件供应链投毒 | [09](./09-defense-tools.md) |
| LLM04 | Data and Model Poisoning | 训练 / 微调数据被污染 | [04](./04-data-leak.md) |
| LLM05 | Improper Output Handling | 输出未过滤直接执行 / 渲染 | [02](./02-prompt-injection.md) |
| LLM06 | Excessive Agency | 给 Agent 太多权限 | [06](./06-tool-safety.md) |
| LLM07 | System Prompt Leakage | system prompt 被读出 | [04](./04-data-leak.md) |
| LLM08 | Vector and Embedding Weaknesses | RAG 索引被污染 | [02](./02-prompt-injection.md) |
| LLM09 | Misinformation | 幻觉与错误信息 | [08](./08-red-team.md) |
| LLM10 | Unbounded Consumption | DoS / 成本爆炸 | [05](./05-abuse.md) |

> 与 2023 版的差异：把 "Insecure Plugin Design" 换成了更宽的 "Excessive Agency"，新增 "Unbounded Consumption"——说明业内已经被成本攻击教育过一轮了。

## 3. 攻击面全景

```
┌─────────────────────────────────────────────────────────────┐
│                      攻击面分布                              │
├─────────────────────────────────────────────────────────────┤
│  [用户输入]      → 直接 prompt injection / jailbreak (§02 §03) │
│       ↓                                                      │
│  [系统 prompt]   → leakage / override (§02 §04)             │
│       ↓                                                      │
│  [RAG 检索]      → 间接注入：恶意文档进入上下文 (§02)        │
│       ↓                                                      │
│  [工具调用]      → excessive agency / 副作用滥用 (§06)       │
│       ↓                                                      │
│  [工具结果]      → 间接注入第二跳 (§02 §06)                  │
│       ↓                                                      │
│  [LLM 输出]      → unsafe rendering、XSS、数据外泄 (§04)    │
│       ↓                                                      │
│  [下游系统]      → SQL / shell / API 注入 (§06)             │
└─────────────────────────────────────────────────────────────┘
```

每一层都需要独立防御。**只在用户输入处做过滤是无效的**——攻击者会从 RAG 文档、邮件、网页等"间接通道"打进来。

## 4. STRIDE 模型套用 LLM

| STRIDE | 在 LLM 中的形态 | 例子 |
| --- | --- | --- |
| **S**poofing | 伪造身份 / 越权 | jailbreak 让模型扮演"管理员" |
| **T**ampering | 篡改 prompt / 上下文 | 间接注入修改工具结果再喂回 |
| **R**epudiation | 否认行为 | 没记 trace，无法追责 |
| **I**nfo Disclosure | 信息泄漏 | 训练数据 / 系统 prompt / 他人会话 |
| **D**oS | 拒绝服务 | token bombing、长上下文耗尽 |
| **E**oP | 提权 | 通过工具链横向移动到内部系统 |

实操：**对每个 LLM 应用做 STRIDE 表格**，在设计阶段就把每个威胁的缓解措施写进文档。

## 5. 责任分担模型

| 层 | 谁负责 | 你能做什么 |
| --- | --- | --- |
| 模型权重 | 模型厂商（OpenAI / Anthropic） | 选择厂商；签 DPA |
| 模型对齐（RLHF） | 模型厂商 | 不可控；预期会被绕过 |
| API 层（rate limit、moderation） | 模型厂商 | 启用厂商提供的 safety endpoint |
| 应用 prompt 设计 | **你** | system prompt、上下文边界 |
| 工具与权限 | **你** | 最小权限、HITL、审计 |
| 输入 / 输出过滤 | **你** | guardrails、PII 过滤、内容审核 |
| 用户身份与多租户 | **你** | 鉴权、隔离 |
| 数据驻留与合规 | **你** | 加密、脱敏、合同 |

> 不要假设"OpenAI 已经处理了"。模型厂商只对**模型本身**负责，不对你的应用上下文负责。把责任清单写进 RACI。

## 6. 一份最小可用威胁模型示例

针对一个"客服 Agent"（接邮件、查订单、退款）：

| 资产 | 威胁 | 攻击者 | 现有缓解 | 残余风险 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| 客户 PII | 跨用户泄漏 | 普通用户 | userId 强制注入 prompt | 中（间接注入风险） | P0 |
| 退款资金 | 越权退款 | 恶意客户 | 单笔上限 + HITL | 低 | P0 |
| 系统 prompt | 泄漏 | 任意用户 | 输出过滤 | 中 | P1 |
| LLM token 配额 | 耗尽 | 自动化脚本 | 用户级 rate limit | 低 | P1 |
| 工具执行 | 任意 SQL | 高级攻击者 | SQL 走只读账号 + 白名单表 | 低 | P0 |
| 邮件外泄 | 工具被诱导发邮件 | 间接注入 | 邮件工具仅发到客户绑定地址 | 中 | P0 |

## 7. 一段 Python：用 LLM 自动生成威胁模型草稿

```python
"""
给定一个应用描述，让 LLM 套 STRIDE 输出威胁模型 markdown。
适合作为安全评审的起点，不能替代人工审查。
"""
from anthropic import Anthropic

client = Anthropic()

THREAT_PROMPT = """\
你是 LLM 安全评审专家。给定应用描述，输出 markdown 表格，列：
| 资产 | STRIDE 类别 | 攻击场景 | 缓解 | 优先级 |

要求：
- 至少覆盖 8 行
- 每个 STRIDE 类别至少出现 1 次
- 缓解措施要具体（如"在邮件工具加 to_whitelist"），不能写"加强校验"
- 优先级用 P0/P1/P2

应用描述:
{description}
"""


def draft_threat_model(description: str) -> str:
    msg = client.messages.create(
        model="claude-opus-4-5",
        max_tokens=2000,
        messages=[{"role": "user", "content": THREAT_PROMPT.format(description=description)}],
    )
    return msg.content[0].text


if __name__ == "__main__":
    desc = """
    一个客服 Agent，使用 LangGraph 编排：
    - 接入用户邮件作为输入
    - RAG 检索内部 KB（Confluence 同步）
    - 工具：query_order(order_id)、issue_refund(order_id, amount)、send_email(to, body)
    - 模型：Claude Opus 4.5
    - 部署：AWS us-east-1，多租户 SaaS
    """
    print(draft_threat_model(desc))
```

> 用 LLM 起草威胁模型 OK，但**最终签字必须是人**。LLM 容易漏掉"业务专属威胁"（比如你这个行业特有的合规要求）。

## 8. 本主题导航

| 你的关切 | 看哪几章 |
| --- | --- |
| 我刚开始做 LLM 应用 | 01 → 02 → 06 → 09 |
| 我已经被注入打过 | 02 → 03 → 09 |
| 我要上生产 | 04 → 05 → 06 → 10 |
| 我做 Agent / 多 Agent | 06 → 07 → 03 |
| 我要过 SOC2 / GDPR | 04 → 10 |
| 我要建红队流程 | 03 → 08 → 09 |

## 9. 与传统安全的协作

| 团队 | 已经在做 | LLM 安全新增 |
| --- | --- | --- |
| AppSec | OWASP Top 10、SAST | LLM Top 10、prompt 评审 |
| 红队 | 渗透测试 | 越狱测试、对抗 prompt |
| 隐私 / 合规 | GDPR、SOC2 | 训练数据审计、模型卡 |
| SRE | rate limit、WAF | token guard、cost cap |
| 数据 | DLP | 上下文 PII 过滤、trace 脱敏 |

把 LLM 安全嵌进现有流程，而不是另起炉灶——否则没人 own。

## 常见坑

1. **只防直接注入**：忽略 RAG / 工具结果 / 邮件这些间接通道，攻击者从二跳进来。详见 [02 · Prompt 注入](./02-prompt-injection.md)。
2. **依赖模型对齐**：以为"Claude / GPT 已经很安全了，不会被越狱"。实际上每个新模型都被 jailbreak 过，应用层必须有独立防御。
3. **trace 默认全量记录**：LangSmith / 自建 trace 把用户输入原样保存，里面包含 PII / 敏感数据，泄漏时一锅端。
4. **没有 cost guard**：测试时 token 用得不多，上线后被恶意构造长 prompt 一夜烧光月度预算。
5. **威胁模型只做一次**：上线时做了，加了新工具就不更新——新工具就是新攻击面。每个 PR 都要回看威胁模型。
6. **混淆 jailbreak 和 injection**：以为同一招能防两个。其实目标不同（[03 · Jailbreak](./03-jailbreak.md)），防御也不同。

## 下一步

- [02 · Prompt 注入](./02-prompt-injection.md) — Top 10 第一名，先打这个
- [06 · 工具调用安全](./06-tool-safety.md) — Excessive Agency 的细节
- [10 · 合规](./10-compliance.md) — 把威胁模型对齐到 GDPR / EU AI Act
- [../agents/10-production.md](../agents/10-production.md) — 生产关卡总览
