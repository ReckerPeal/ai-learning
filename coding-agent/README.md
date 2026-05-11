# Coding Agent

> 写代码是 LLM Agent 的**垂直领域第一应用方向**——市场最大、反馈最强、评测最成熟。把这条赛道吃透，就能把 Agent 工程的全部抽象（规划、工具、记忆、评测、沙箱）跑通一遍。

## 章节索引

1. [01 · 演化：Copilot → Cursor → Devin](./01-overview.md) — 形态分类、产品脉络、商业模式、与 browser-agent 的边界。
2. [02 · 代码理解](./02-code-understanding.md) — 文本 / 符号 / 图三重视角，AST、LSP、tree-sitter 的协同。
3. [03 · Code RAG](./03-code-rag.md) — 切分、code-specific embedding、symbol+semantic 多源融合、增量索引。
4. [04 · 代码生成（diff / 增量编辑）](./04-code-generation.md) — 全量重写 vs SEARCH/REPLACE vs fast apply，多文件 plan-execute。
5. [05 · 代码执行沙箱](./05-sandbox.md) — E2B / Modal / Docker / Firecracker 选型，FS 隔离与流式 stdout。
6. [06 · 代码审查 Agent](./06-code-review.md) — 分级评论、避免 nit 噪音、与 GitHub/GitLab 集成、CodeRabbit/PR-Agent 案例。
7. [07 · 调试 Agent](./07-debug.md) — stack trace 推理、patch→test→再 patch、SWE-bench 风格评测。
8. [08 · 测试生成 Agent](./08-test-gen.md) — Spec→Test 与 Code→Test 双路径、覆盖率引导、mutation testing。
9. [09 · Refactor Agent](./09-refactor.md) — 静态工具 vs LLM 取舍、批量迁移、API 升级（如 LangChain 0.0→0.3）。
10. [10 · 案例剖析（Cursor / Claude Code / Devin / Aider）](./10-case-study.md) — 共同设计教训与"自家做 coding agent"清单。

## 与其他主题的关系

| 主题                   | 关系                                                  |
| -------------------- | --------------------------------------------------- |
| `../agents/`         | Coding Agent 是 Agent 设计模式（[02-paradigms](../agents/02-paradigms.md)、[04-tool-use](../agents/04-tool-use.md)、[05-planning](../agents/05-planning.md)）的最大落地场景。 |
| `../rag-advanced/`   | 第 [03 章](./03-code-rag.md) 是 RAG 的代码特化——切分单位、embedding、检索源都不一样。 |
| `../langgraph/`      | 多步迭代（debug、refactor）的状态机用 LangGraph 编排最自然。          |
| `../langchain/`      | 工具封装、Prompt template 在轻量 coding agent 仍然适用。         |
| `../eval/`           | SWE-bench、HumanEval、PR review 一致率等评测方法在第 [07](./07-debug.md)、[08](./08-test-gen.md) 章引用。 |

## 资源

**评测基准**

- SWE-bench / SWE-bench Verified — <https://www.swebench.com/> — 代码 agent 事实标准
- HumanEval / MBPP — 函数级生成基准
- LiveCodeBench — <https://livecodebench.github.io/> — 防污染的实时基准
- BIRD-SQL — <https://bird-bench.github.io/> — 跨库 SQL 生成

**开源参考实现**

- Aider — <https://aider.chat/> — diff 工程工业级参考
- OpenHands（前 OpenDevin）— <https://github.com/All-Hands-AI/OpenHands>
- Continue — <https://github.com/continuedev/continue> — 开源 IDE 助手
- Cline — <https://github.com/cline/cline> — VS Code agent
- AutoCodeRover — <https://github.com/AutoCodeRoverSG/auto-code-rover>

**代码理解三件套**

- tree-sitter — <https://tree-sitter.github.io/>
- ast-grep — <https://ast-grep.github.io/>
- LSP（Language Server Protocol）— <https://microsoft.github.io/language-server-protocol/>

**沙箱**

- E2B — <https://e2b.dev/>
- Modal — <https://modal.com/>
- Daytona — <https://www.daytona.io/>

**官方博客 / 系统报告**

- Cursor changelog — <https://www.cursor.com/changelog>
- Claude Code 官方文档 — <https://docs.claude.com/en/docs/claude-code>
- Cognition Devin 技术博客 — <https://www.cognition.ai/blog>

**论文**

- *SWE-agent* (Yang et al., 2024)
- *AutoCodeRover* (Zhang et al., 2024)
- *CodePlan* (Bairi et al., 2023) — 仓库级编辑
- *Reflexion* (Shinn et al., 2023) — 自我反思（§07 调试 agent 应用）

## 阅读顺序建议

- **完整路径**：§01 → §02 → §03 → §04 → §05 → §06–§09 任选 → §10
- **快速做 PoC**：§01 → §03 → §04 → §05（核心闭环）
- **做 PR 机器人**：§02 → §03 → §06
- **做 SWE-bench 风格 Agent**：§02 → §05 → §07 → §08
- **看完整产品架构**：§01 → §10（直接读案例剖析）
