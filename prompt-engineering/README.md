# Prompt 工程进阶

> Prompt 不是"魔法咒语"，是程序——模型是解释器。本主题不教你拼贴 AI 大师的提示词，而是把 prompt 当成可版本管理、可评测、可回归的工程产物。

模型从 GPT-3 到现在的 Claude / GPT-5 / DeepSeek-R1，"Prompt 工程要消亡"已经被预言过四五轮。事实是：模型越强，prompt 的杠杆越大——一行措辞差异 10 美金 vs 1 美金，一段 system prompt 决定 agent 是否会越权调工具。这套笔记面向已经会用 LLM、想把 prompt 当工程对象来对待的读者。

**本主题不会教你**：

- 网上抄来的"100 个万能 prompt"
- "你是世界顶级专家" 这类玄学开场（§6 会拆穿）
- 与具体框架强绑的 API 细节（这些去看 [../langchain/](../langchain/README.md) / [../langgraph/](../langgraph/README.md)）

**本主题会教你**：

- 如何设计 prompt 让它在不同模型之间可移植
- 如何把 prompt 当代码——版本、A/B、回归测试
- 如何用评测驱动 prompt 迭代（EDD：Eval-Driven Development）
- 如何写防注入的 system prompt

## 章节索引

1. [01 · 概览：Prompt 为什么有效](./01-overview.md) — 心智模型 + Prompt vs 微调 vs RAG 的决策树
2. [02 · 基础：Role / Instruction / Format](./02-basics.md) — 4 件套结构 + 输出格式约束
3. [03 · Few-shot 设计](./03-few-shot.md) — 数量、顺序、多样性、动态选择
4. [04 · Chain-of-Thought 与 Self-Consistency](./04-cot.md) — CoT 简史与 reasoning 模型时代的取舍
5. [05 · 指令调优与输出约束](./05-instruction-tuning.md) — system vs user / JSON mode / 禁区设计
6. [06 · 角色与 Persona](./06-persona.md) — 角色对输出的真实影响 + 反过度沉浸
7. [07 · 模型差异：GPT / Claude / DeepSeek / Qwen](./07-model-differences.md) — 跨家族 prompt 移植清单
8. [08 · Prompt 模板化与版本管理](./08-templates.md) — Prompt-as-Code + A/B 灰度
9. [09 · 对抗 Prompt（防御视角）](./09-adversarial.md) — 注入 / 越狱 / 间接注入与防御 system prompt
10. [10 · Prompt 评测与迭代](./10-evaluation.md) — EDD：评测集 / Pairwise / 回归

## 与其他主题的关系（速查表）

| 主题                                       | 关系                                                              |
| ---------------------------------------- | --------------------------------------------------------------- |
| [../langchain/](../langchain/README.md)  | LangChain 提供 `PromptTemplate` / `FewShotPromptTemplate` / output parser；本主题讲设计与方法论，不复述 API |
| [../langgraph/](../langgraph/README.md)  | Graph 节点里跑的就是 prompt；§5 §6 的指令稳定性直接影响 agent 控制流可靠性             |
| [../rag-advanced/](../rag-advanced/README.md) | RAG 的"prompt 拼接"是本主题 §5 输出约束的一个特例                              |
| [../eval/](../eval/README.md)            | §10 的评测方法论与 eval 主题完全对齐——prompt 评测是 LLM 评测的一个前置层               |
| [../agents/](../agents/README.md)        | Agent 的工具描述、planner prompt 都是本主题的应用场景；§9 防注入与 agent 工具安全直接相关  |

## 资源

**官方文档**

- [Anthropic Prompt Engineering Guide](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/overview) — Claude 官方，特别推荐 XML 标签、prompt chaining 章节
- [OpenAI Prompt Engineering Guide](https://platform.openai.com/docs/guides/prompt-engineering)
- [Google Gemini Prompt Design](https://ai.google.dev/docs/prompting_intro)

**学术**

- [Chain-of-Thought Prompting (Wei et al., 2022)](https://arxiv.org/abs/2201.11903)
- [Self-Consistency Improves CoT (Wang et al., 2022)](https://arxiv.org/abs/2203.11171)
- [Tree of Thoughts (Yao et al., 2023)](https://arxiv.org/abs/2305.10601)
- [The Prompt Report: Systematic Survey (Schulhoff et al., 2024)](https://arxiv.org/abs/2406.06608)

**实战参考**

- [Anthropic Prompt Library](https://docs.anthropic.com/en/prompt-library/library)
- [OpenAI Cookbook](https://cookbook.openai.com/)
- [Promptfoo](https://www.promptfoo.dev/) — Prompt 评测开源工具
- [LangSmith Prompt Hub](https://smith.langchain.com/hub) — Prompt 仓库
- [DSPy](https://github.com/stanfordnlp/dspy) — Prompt 自动优化框架
- [Prompt Engineering Guide](https://www.promptingguide.ai/) — 综合教程站

**进阶**

- [Lilian Weng: Prompt Engineering (2023)](https://lilianweng.github.io/posts/2023-03-15-prompt-engineering/) — 经典综述
- [Anthropic: Building Effective Agents (2024-12)](https://www.anthropic.com/research/building-effective-agents) — Agent prompt 实战
- [InstructGPT 论文](https://arxiv.org/abs/2203.02155) — 理解指令调优为什么有效

## 阅读顺序建议

- **完整路径**：§01 → §02 → §03 → §04 → §05 → §06 → §07 → §08 → §09 → §10
- **赶上线**：§01 → §02 → §05 → §10（先跑通评测闭环）
- **跨厂商移植**：§01 → §02 → §07
- **写 Agent prompt**：§01 → §05 → §06 → §09（对抗防御）
- **想做 EDD**：§01 → §08 → §10 → 接 [`../eval/`](../eval/README.md)

**仓库索引**：[../README.md](../README.md)
