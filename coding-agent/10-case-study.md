# 10 · 案例剖析（Cursor / Claude Code / Devin / Aider）

前 9 章讲方法，这一章讲产品。把 Coding Agent 赛道**真正跑出量**的四个产品（Cursor、Claude Code、Devin、Aider）的设计哲学、关键决策、共同教训摆在一起对照——再加上 Continue / Cline / Roo 等开源对照组。最后给"自家做 Coding Agent"的清单。

## 1. 总览矩阵

| 产品 | 厂商 | 形态 | 模式 | 模型 | 商业 | 核心赌注 |
| --- | --- | --- | --- | --- | --- | --- |
| **Cursor** | Anysphere | IDE Fork（基于 VS Code）| 补全 + Inline + Composer + BG Agent | 多模型 + 自训 fast apply | $20–40/mo | "重做 IDE，把 Agent 内嵌深处" |
| **Claude Code** | Anthropic | CLI Agent | 终端原生、MCP、Skills | Claude only | API 计费 | "终端是最干净的 Agent 接口" |
| **Devin** | Cognition | Web SaaS | 全自主 / 长任务 | 多模型 | $500/mo 起 | "把 issue 一键变 PR，无人值守" |
| **Aider** | 开源 | CLI | 对话 + git workflow | 自带 API（多模型）| 免费 | "git 是 agent 的 undo 栈，diff 工程优先" |
| Continue | 开源 | IDE 插件 | 补全 + 对话 + Agent | 多模型 | 免费 + 企业 | Copilot 平替 |
| Cline / Roo | 开源 | VS Code Agent | Composer 模式 | 多模型 | 免费 | "Cursor Composer 在 VS Code 里" |

## 2. Cursor

### 2.1 架构关键

| 层 | 设计 |
| --- | --- |
| 编辑器 | VS Code fork（不是插件，原因：要改 UI） |
| 补全（Tab） | 自训快模型 + 上下文（当前文件 + 邻居 + git diff）|
| Inline Edit (`Cmd+K`) | 选中即改，全量重写 |
| Chat | 侧栏对话，`@` 引用文件、符号、代码库 |
| Composer | 多文件 Agent，跨文件 plan-execute |
| Bugbot | PR review 模式 |
| Background Agent | 云端跑长任务，不占本地 |
| Apply | 自训 fast apply 小模型（[04 章](./04-code-generation.md) §4） |
| Index | 仓库语义索引（嵌入 + 文件名 + 最近编辑） |

### 2.2 设计哲学

- **Agent 不是侧栏**：把 Agent 缝进编辑器每一处（Tab、`Cmd+K`、Composer）。
- **小模型负责"应用"**：大模型出意图，自训快模型落地 → 极致延迟。
- **`.cursor/rules`**：项目级规则注入 prompt（仿 OpenAI custom instructions）。
- **YOLO mode**：用户授权后 Agent 可自动跑命令、提交 commit。

### 2.3 教训

- **一致的"接受/拒绝"UX 比新功能重要**：每次 Agent 改动，用户必须能秒级 accept/reject。
- **不要让 Agent 改用户没看的文件**：信任崩塌一次就再也回不来。
- **快比强重要**：Tab 用快模型而非 GPT-4，是 PMF 的关键。

## 3. Claude Code

### 3.1 架构关键

| 层 | 设计 |
| --- | --- |
| 接口 | CLI（不是 IDE / Web）|
| 模型 | Claude（Opus / Sonnet / Haiku 选档）|
| 工具 | Read、Write、Edit、Grep、Glob、Bash、BashOutput、WebFetch、TodoWrite |
| MCP | 任意 MCP server 接入（GitHub、Slack、Linear、Sentry…）|
| Skills | 用户级 skill 系统（`~/.claude/skills/`）|
| Subagents | Task tool dispatch 子 agent，并行任务 |
| Hooks | settings.json 配置，UserPromptSubmit / PreToolUse / Stop 等钩子 |
| 持久化 | 工作目录就是 git 仓库；`/resume` 恢复会话 |

### 3.2 设计哲学

- **CLI 是最干净的 Agent 接口**：终端 = stdout 流式 + Unix 工具 + 用户既有 muscle memory。
- **工具最小集**：Read / Edit / Bash / Grep 四个就能干 80%。
- **MCP / Skills 承接生态**：核心保持小，扩展走标准协议。
- **Plan / Skill 是声明式**：`/plan` 生成步骤、Skill 声明 trigger 条件，把 agent 行为推向 declarative。
- **不抢 IDE**：IDE 集成走插件（VS Code、JetBrains），CLI 是主体。

### 3.3 教训

- **工具数量爆炸是反模式**：早期 SWE-agent 列了 30+ 工具，模型反而蒙；Claude Code 砍到 ~10 个反而更准。
- **stdout 流式 + 后台 bash** 是长任务必需。
- **Skill 系统让 agent 能力可组合 & 共享**——比 prompt template 更有结构。

## 4. Devin

### 4.1 架构关键

| 层 | 设计 |
| --- | --- |
| 接口 | Web SaaS（带浏览器、终端、IDE、Slack 触发）|
| 形态 | 全自主长任务（小时级）|
| 工具 | Shell + Browser + Editor + Planner |
| 状态 | 持久化 workspace + 进度 timeline |
| 协作 | "ACU" 单位计费，可被 Slack 召唤 |

### 4.2 设计哲学

- **长上下文 + 长任务**：把 Agent 推到极致——issue 进、PR 出。
- **Plan + Sub-tasks + 检查点**：长任务分解，可暂停 / 介入。
- **多模态**：浏览器、截图、终端混合操作（同时是 Browser Agent 雏形，看 [01 章](./01-overview.md) §8）。
- **企业入口**：Slack、Jira 触发，而非 IDE。

### 4.3 教训

- **演示 ≠ 真实**：早期演示极度精挑，真实场景在脏代码库上失败率高。
- **长任务的"沉没成本"心理**：用户不愿意付了钱跑 4 小时换来一个失败 patch。**短链 + 早失败 + 早通知** 是用户体验底线。
- **价格锚点高**：$500/mo 倒逼必须有真实 ROI，**不能靠 hype**。

## 5. Aider

### 5.1 架构关键

| 层 | 设计 |
| --- | --- |
| 接口 | CLI |
| 模型 | 用户自带 API（OpenAI / Anthropic / 开源）|
| Diff | SEARCH/REPLACE 块（[04 章](./04-code-generation.md) §2）|
| Repo Map | ctags 生成的项目摘要塞 prompt |
| Git | 每轮 agent 改动 = 一个 commit |
| 模式 | `/architect`（强模型规划）+ `/edit`（弱模型应用）双层 |

### 5.2 设计哲学

- **Diff 工程是核心**：`editblock_coder.py` 是工业级 SEARCH/REPLACE 参考实现。
- **git 是状态**：不需要单独的 history / undo，git log 即 agent log。
- **小项目 first**：Aider 在 <5 万行项目上效果极好；大项目让位 Cursor / Cody。
- **公开 benchmark**：Aider 维护自家 leaderboard（不同模型在 Aider 流程下的修复率），**透明且自我打脸**。

### 5.3 教训

- **诚实 benchmark 是最好的市场策略**：开发者会用 Aider 当模型横评工具。
- **CLI + git 是最稳的"agent harness"**：远比 IDE / Web 更可调试。
- **架构师 + 编辑者** 双模型范式（强模型规划、弱模型落地）领先了 Fast Apply 整整一年。

## 6. 开源对照：Continue / Cline / Roo / OpenHands

| 产品 | 形态 | 卖点 | 缺点 |
| --- | --- | --- | --- |
| Continue | VS Code / JetBrains 插件 | Copilot 平替、可挂任意模型 | UI 不如 Cursor |
| Cline (前 Claude Dev) | VS Code Agent | 把 Composer 还原到 VS Code | 单仓库定位 |
| Roo Code | Cline fork | 多 agent 模式、custom prompts | 社群分裂 |
| OpenHands (前 OpenDevin) | Web Agent | Devin 的开源平替 | 工程复杂、易碎 |
| SWE-agent | 学术 / 评测 | SWE-bench 跑分用 | 不是产品 |
| Sourcegraph Cody | 企业 | 大代码库强 | 价格高、自托管复杂 |

## 7. 共同设计教训（被验证 / 被证伪）

### 7.1 被验证的设计

| 设计 | 出现产品 |
| --- | --- |
| SEARCH/REPLACE 块（不要 LLM 写 unified diff）| Aider、Anthropic str_replace、Cursor |
| 沙箱默认（[05 章](./05-sandbox.md)）| Devin、OpenHands、Cline |
| 工具调用结构化（不要纯文本协议）| Cursor、Claude Code、OpenAI |
| Plan-Execute 拆多文件 | Cursor Composer、Devin、Cline |
| Fast Apply（小模型应用 diff）| Cursor、模仿者满地 |
| Repo map / 摘要塞 prompt | Aider、Cursor |
| Reflexion / 失败重试 | Devin、SWE-agent |
| MCP / Skill 标准化扩展 | Claude Code |
| `.rules` 文件项目级 prompt | Cursor、Claude Code、Continue |
| git auto-commit 作为 undo 栈 | Aider、Cursor BG |

### 7.2 被证伪 / Hype 的设计

| 设计 | 现状 |
| --- | --- |
| 一次性把整个仓库塞 prompt | 只在小项目 work，被 RAG + 摘要替代 |
| 让 LLM 输出 unified diff（行号）| 100% 翻车，被 SEARCH/REPLACE 替代 |
| 30+ 工具大杂烩 | 模型蒙，被精简工具集替代 |
| "完全自主、无人介入"长任务 | Devin 本人也回退到 checkpoints |
| 一个超大 prompt 干所有事 | 被 plan-execute 多步拆解替代 |
| 纯向量 RAG 单源检索 | 被 hybrid 替代（[03 章](./03-code-rag.md)）|
| LLM 自由跑命令 + 无沙箱 | 第一次 `rm -rf` 就毕业 |

## 8. 自家做 Coding Agent 的清单

如果你要从零做一个 Coding Agent，**按这个顺序**最稳：

| 阶段 | 工作 | 章节 |
| --- | --- | --- |
| 0. 定位 | 形态选择（IDE / CLI / Web / SaaS）| [01 章](./01-overview.md) §2 |
| 1. 评测先行 | 搭 30 题自家 benchmark（真实修复任务）| [07 章](./07-debug.md) §6 |
| 2. 工具集 | Read / Edit / Bash / Grep + 沙箱 | [05 章](./05-sandbox.md)、[../agents/04-tool-use.md](../agents/04-tool-use.md) |
| 3. Diff 引擎 | SEARCH/REPLACE 应用器 + fuzzy fallback | [04 章](./04-code-generation.md) §2-3 |
| 4. 上下文 | repo map + 嵌入 hybrid | [02](./02-code-understanding.md)、[03](./03-code-rag.md) |
| 5. 状态机 | Plan → Execute → Verify → Repair | [../langgraph/04-control-flow.md](../langgraph/04-control-flow.md) |
| 6. UI | 接 IDE 或 CLI；流式 stdout；undo（git）| [05](./05-sandbox.md) §6 |
| 7. 评测迭代 | benchmark 驱动 prompt + 模型选型 | [../eval/](../eval/) |
| 8. 子能力 | 按需做 Review / Debug / Test / Refactor | [06](./06-code-review.md)–[09](./09-refactor.md) |

## 9. 最小验证骨架

把所有章节核心串成一段最小可演示的 agent 骨架：

```python
"""
最小 Coding Agent demo：
- bash + read + edit 三个工具
- ReAct 循环
- 跑用户指令，最多 10 步
依赖：pip install anthropic
"""
import subprocess, json
from pathlib import Path
from anthropic import Anthropic

client = Anthropic()
TOOLS = [
    {
        "name": "read_file",
        "description": "Read a file",
        "input_schema": {"type": "object", "properties": {
            "path": {"type": "string"}}, "required": ["path"]},
    },
    {
        "name": "edit_file",
        "description": "Replace OLD with NEW in path. OLD must match exactly once.",
        "input_schema": {"type": "object", "properties": {
            "path": {"type": "string"},
            "old": {"type": "string"},
            "new": {"type": "string"}},
            "required": ["path", "old", "new"]},
    },
    {
        "name": "bash",
        "description": "Run a shell command (10s timeout)",
        "input_schema": {"type": "object", "properties": {
            "cmd": {"type": "string"}}, "required": ["cmd"]},
    },
]

def run_tool(name: str, args: dict) -> str:
    if name == "read_file":
        return Path(args["path"]).read_text()[:8000]
    if name == "edit_file":
        p = Path(args["path"])
        s = p.read_text()
        if s.count(args["old"]) != 1:
            return f"FAIL: {s.count(args['old'])} matches"
        p.write_text(s.replace(args["old"], args["new"]))
        return "OK"
    if name == "bash":
        r = subprocess.run(args["cmd"], shell=True, capture_output=True,
                           text=True, timeout=10)
        return f"exit={r.returncode}\n{r.stdout}\n{r.stderr}"[:4000]
    return f"unknown tool {name}"

def loop(user: str, max_steps: int = 10):
    msgs = [{"role": "user", "content": user}]
    for _ in range(max_steps):
        r = client.messages.create(
            model="claude-opus-4-5", max_tokens=2048,
            tools=TOOLS, messages=msgs,
        )
        msgs.append({"role": "assistant", "content": r.content})
        if r.stop_reason == "end_turn":
            break
        results = []
        for blk in r.content:
            if blk.type == "tool_use":
                out = run_tool(blk.name, blk.input)
                results.append({
                    "type": "tool_result",
                    "tool_use_id": blk.id,
                    "content": out,
                })
        msgs.append({"role": "user", "content": results})
    return msgs

if __name__ == "__main__":
    loop("Add a docstring to every function in hello.py and run pytest")
```

把这段铺开，加上 [05 章](./05-sandbox.md) 沙箱 + [04 章](./04-code-generation.md) SEARCH/REPLACE，就是一个 minimal Aider 替代品。

## 常见坑

1. **抄一个产品的全部细节**：Cursor 抄 Cursor，没有差异化，必死。**先选自己的赌注**（IDE / CLI / Web、自主程度、垂类）。
2. **没有评测就调 prompt**：每次都觉得"好像更好了"。**先搭 benchmark**。
3. **追 SWE-bench 分数而不解决用户痛点**：客户要的是"加个表单页"，不是"修 sympy 历史 bug"。
4. **太早做"全自主"**：从 inline edit 起步，逐级放权。Devin 的高估值并不代表你也能做。
5. **拒绝接 MCP / 标准协议**：用户的 Slack / Linear / Sentry 接不进去 → 没生态。
6. **沙箱是事后补的**：上线后第一周就 `rm -rf` 用户文件。**Day 1 就要沙箱**。
7. **不公开自家 benchmark**：开发者无法验证你的吹嘘 → 信任走低。Aider 公开 benchmark 是 PR 之神。
8. **忽视 IDE / CLI 之外的入口**：PR review、issue triage、CI、Slack 都是真实入口；只盯 IDE 会错过半个市场。

## 下一步

- 回读 [01 · 演化](./01-overview.md) 重新审视赛道。
- 把 RAG 通用知识补齐 → [../rag-advanced/](../rag-advanced/) 全 10 章。
- 把 Agent 通用设计补齐 → [../agents/](../agents/) 全 10 章。
- 关注 SWE-bench Leaderboard 和各家产品 changelog——这条赛道每两周就有新东西。
- 自家做 → 按 §8 清单从评测起步。
