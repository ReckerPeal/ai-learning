# LLM 安全

> 上生产必修。模型再聪明，没有安全层就是裸奔——一条恶意 prompt 能掏空你的数据库、烧光你的 token quota、把客户 PII 发到攻击者邮箱。

## 章节索引

1. [01 · 威胁模型与 OWASP LLM Top 10](./01-threat-model.md) — 攻击面全景、STRIDE 套用、责任分担
2. [02 · Prompt 注入](./02-prompt-injection.md) — 直接 / 间接 / 多步注入与 Spotlighting 防御
3. [03 · Jailbreak 与越狱](./03-jailbreak.md) — DAN / Crescendo / 自动化越狱与防御
4. [04 · 数据泄漏](./04-data-leak.md) — 训练数据 / PII / 上下文 / 多租户隔离
5. [05 · 模型滥用与 DoS](./05-abuse.md) — Token bombing、配额绕过、Cost guard
6. [06 · 工具调用安全](./06-tool-safety.md) — 信任层级、最小权限、HITL、沙箱
7. [07 · 多 Agent 安全](./07-multi-agent-safety.md) — A2A 鉴权、级联劫持、注入传染
8. [08 · 红队测试](./08-red-team.md) — PyRIT / garak、LLM-as-attacker、CI 持续红队
9. [09 · 防御工具](./09-defense-tools.md) — Llama Guard / NeMo / Lakera 选型矩阵
10. [10 · 合规](./10-compliance.md) — GDPR / EU AI Act / SOC2 / 上线清单

## 与其他主题的关系（速查表）

| 主题 | 与本主题的关系 |
| --- | --- |
| [../agents/](../agents/) | Agent 设计；本主题深化其工具与生产关卡 |
| [../agents/04-tool-use.md](../agents/04-tool-use.md) | 工具基础；本主题 §6 在其上深化攻击面 |
| [../agents/10-production.md](../agents/10-production.md) | 生产清单；本主题给安全清单细节 |
| [../langgraph/07-human-in-the-loop.md](../langgraph/07-human-in-the-loop.md) | HITL 机制；§6 强制依赖 |
| [../eval/10-advanced.md](../eval/10-advanced.md) | 对抗测试集；§8 在其上构建系统红队 |
| [../rag-advanced/](../rag-advanced/) | RAG 召回；§2 间接注入主要发生于此 |
| [../langchain/](../langchain/) | 组件层；本主题适用于所有 LangChain 应用 |

## 资源

**标准与框架**

- OWASP LLM Top 10 (2025) — <https://owasp.org/www-project-top-10-for-large-language-model-applications/>
- NIST AI RMF — <https://www.nist.gov/itl/ai-risk-management-framework>
- MITRE ATLAS — <https://atlas.mitre.org/>
- Microsoft AI Red Team — <https://learn.microsoft.com/en-us/security/ai-red-team/>
- EU AI Act 全文 — <https://artificialintelligenceact.eu/>

**研究与博客**

- Anthropic Responsible Scaling Policy — <https://www.anthropic.com/responsible-scaling-policy>
- Simon Willison 的 prompt injection 系列 — <https://simonwillison.net/tags/prompt-injection/>
- LangChain Security 速查 — <https://python.langchain.com/docs/security>
- 论文：*Universal and Transferable Adversarial Attacks on Aligned Language Models* (Zou et al., 2023)
- 论文：*Indirect Prompt Injection via Resource Compromise* (Greshake et al., 2023)

**工具**

- Llama Guard / Purple Llama — <https://github.com/meta-llama/PurpleLlama>
- NVIDIA NeMo Guardrails — <https://github.com/NVIDIA/NeMo-Guardrails>
- garak (LLM vuln scanner) — <https://github.com/leondz/garak>
- Microsoft PyRIT — <https://github.com/Azure/PyRIT>
- Lakera Guard — <https://www.lakera.ai/>
- promptmap (注入扫描) — <https://github.com/utkusen/promptmap>

## 阅读顺序建议

- **赶上线**：§01 → §02 → §06 → §09 → §10 上线 checklist
- **先吃透注入**：§01 → §02 → §03 → §08（红队验证）
- **多租户 / B 端合规**：§01 → §04 → §07 → §10
- **接 Agent / 多 Agent**：§06 → §07 → §08（先验证再部署）
