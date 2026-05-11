# 01 · 演化：Copilot → Cursor → Devin

Coding Agent 是 LLM 时代**第一个被验证 PMF 的垂直 Agent 方向**。从 2021 年 GitHub Copilot 开始，到 2024 年 Devin 演示长任务自主执行，三年内形态翻了三轮。先把脉络捋清楚，再谈技术细节。

## 1. 三代产品形态

| 代际 | 时间 | 形态 | 代表产品 | 核心创新 |
| --- | --- | --- | --- | --- |
| 第一代：补全 | 2021–2022 | 单光标续写 | Copilot v1、Tabnine | 基于 codex / GPT-3，行内灰字补全 |
| 第二代：Inline Edit / Chat | 2023 | 选中即改 + 侧边对话 | Copilot Chat、Cursor、Continue | LLM 能力提升、IDE 深度集成 |
| 第三代：Agent | 2024–2025 | 多步自主、跨文件、能跑测试 | Cursor Composer、Claude Code、Devin、Cline | 工具调用、规划、沙箱执行 |

**关键转折点**：

- **2022.11 ChatGPT 发布**——开发者第一次把"代码助手"当对话伙伴用。
- **2023.03 GPT-4**——第一个能"理解整个文件"的模型，Cursor 起飞。
- **2024.03 Devin 演示**——第一次把"Agent 长跑数小时完成 issue"摆到台面。
- **2024.10 Claude 3.5 Sonnet (new) + Computer Use**——工具调用质量到达可用线。
- **2025 Claude Code、Cursor Composer**——CLI / IDE Agent 进入主流。

## 2. 形态矩阵

| 形态 | 触发方式 | 上下文 | 持续时间 | 用户介入频率 | 代表 |
| --- | --- | --- | --- | --- | --- |
| 行内补全 | 光标停 | 当前文件 + 少量邻居 | <1s | 每次 tab/esc | Copilot、Cursor Tab |
| Inline Edit | `Cmd+K` | 选中文本 + 文件 | 1–10s | 单次 | Cursor `Cmd+K`、Copilot Edit |
| Chat 侧边栏 | 提问 | 当前文件 + @ 引用 | 5–30s | 多轮对话 | Copilot Chat、Continue |
| Agent（IDE 内） | "做 X" | 整库 RAG + 工具 | 1–10min | 阶段确认 | Cursor Composer、Cline |
| CLI Agent | 命令行 | 工作目录 + git | 10min–小时 | 偶尔确认 | Claude Code、Aider |
| 全自主 SaaS Agent | issue / PR | 完整仓库 + 浏览器 + 终端 | 小时–天 | 完成后 review | Devin、SWE-agent、OpenHands |

**取舍逻辑**：交互越轻 → 模型自主权越小 → 出错代价越低；反之自主权越大、加速越显著、但**幻觉/破坏代价指数增长**。

## 3. 主流产品速览

| 产品 | 厂商 | 形态 | 商业模式 | 一句话定位 |
| --- | --- | --- | --- | --- |
| GitHub Copilot | Microsoft | IDE 全形态 | $10–39/mo SaaS | 第一代王者，企业渗透最深 |
| Cursor | Anysphere | IDE Fork | $20/mo SaaS | 把 VS Code 变成 Agent 工作台 |
| Claude Code | Anthropic | CLI Agent | 计入 API 用量 | 终端原生 + MCP + Skills |
| Devin | Cognition | Web SaaS | $500/mo 起 | 长任务自主执行的故事讲得最大 |
| Aider | 开源 | CLI | 免费（用户自带 API） | git workflow 的 diff 工程标杆 |
| Continue | 开源 | IDE 插件 | 免费 + 企业版 | Copilot 的开源平替 |
| Cline / Roo Code | 开源 | VS Code Agent | 免费 | 把 Cursor Composer 还原到 VS Code |
| Cody | Sourcegraph | IDE 插件 | 企业级 | 大代码库检索 + Agent |
| Tabnine | Tabnine | IDE 插件 | 企业级 | 私有部署、合规友好 |
| Replit Agent | Replit | Web IDE | $20/mo | 一句话起项目 |
| v0 / Bolt / Lovable | Vercel / StackBlitz | Web | $20–50/mo | "需求 → 可部署 web app" |

## 4. 商业模式分类

| 模式 | 收费方式 | 毛利结构 | 代表 | 难点 |
| --- | --- | --- | --- | --- |
| IDE SaaS（订阅） | 月费 | 模型成本 vs 订阅价 | Copilot、Cursor | token 成本控制 |
| CLI / API（按量） | 计入 API | 转嫁给用户 | Claude Code、Aider | 推广靠生态 |
| Agent SaaS（按任务/月） | 高订阅 | 长任务 token 极贵 | Devin、Replit Agent | ROI 证明、可控性 |
| 企业部署 | License + 服务 | 服务费为主 | Tabnine、Cody、Augment | 私有化、合规 |
| 工具 + 模型一体 | 综合订阅 | 自家模型补贴 | Anthropic、OpenAI | 必须有自家模型 |

## 5. 这条赛道为什么"卷"

直接上结论：

1. **市场天花板高**：全球开发者 ~3000 万 × 年付费意愿数百美元 = 数百亿美元盘子。
2. **反馈信号强**：代码可编译、可测试、可 diff——RLHF/评测都好做。
3. **模型能力直接溢出**：每代 LLM 升级，写代码受益最大（vs 文学创作受益最小）。
4. **基础设施模块化**：tree-sitter / LSP / git / 沙箱 / 评测都已经现成，初创不必从零造。
5. **入口多**：IDE、CLI、PR review、issue triage、CI、文档——每个入口都是独立产品。

副作用：**同质化严重**。除了底模和体验细节，大家可调的设计空间越来越窄。这也是为什么 [10 · 案例剖析](./10-case-study.md) 把 Cursor / Claude Code / Devin / Aider 单独拎出来对比——他们的差异在产品哲学，不在技术。

## 6. 这条赛道的玩家结构

把市场参与者按"做模型 vs 做产品 vs 做基础设施"分一下：

| 层 | 玩家 | 例 |
| --- | --- | --- |
| 模型层 | 大厂 LLM 厂 | OpenAI、Anthropic、Google、Meta、DeepSeek、阿里 Qwen |
| 自训应用模型 | 顶尖 coding agent 厂 | Cursor（fast apply）、Cognition、Replit |
| 产品层 | IDE / CLI / Agent SaaS | Cursor、Aider、Cline、Replit、v0、Bolt |
| 平台 / 协议层 | MCP、LSP、tree-sitter | Anthropic（MCP）、Microsoft（LSP）、社区 |
| 基础设施层 | 沙箱、评测、检索 | E2B、Modal、Daytona、SWE-bench、Voyage |
| 集成 / 渠道层 | GitHub、企业内部 | GitHub Copilot、CircleCI Agent、Jira Agent |

**结论**：底模厂下沉做产品（Anthropic 的 Claude Code、OpenAI 的 ChatGPT Agents），产品厂上探训自家小模型（Cursor），**两端互相挤压中间纯封装层**。如果你做封装，必须给 30% 以上的差异化。

## 7. 学习路径

按顺序读这 10 章，每章约 2–4 小时。如果只挑重点：

| 你的角色 | 必读 |
| --- | --- |
| 想做 IDE 内 inline edit | 02、04 |
| 想做 PR review bot | 02、06 |
| 想做长任务 Agent（类 Devin） | 04、05、07、10 |
| 评估自家代码库做 RAG | 02、03 |
| 想理解 Cursor / Claude Code 怎么做的 | 04、05、10 |

## 8. 一段最小代码骨架

把"读文件 → 让 LLM 改 → 写回"串起来，是所有 Coding Agent 的最小内核。下面这段 Python 用 `anthropic` SDK，能跑：

```python
"""
最小 Coding Agent：读 → 改 → 写。
依赖：pip install anthropic
环境：export ANTHROPIC_API_KEY=...
"""
from pathlib import Path
from anthropic import Anthropic

client = Anthropic()
SYSTEM = (
    "You are a coding assistant. The user will give you a file's content "
    "and an instruction. Reply with the FULL new file content, no commentary."
)

def edit_file(path: str, instruction: str) -> None:
    src = Path(path).read_text()
    msg = client.messages.create(
        model="claude-opus-4-5",
        max_tokens=4096,
        system=SYSTEM,
        messages=[{
            "role": "user",
            "content": f"FILE: {path}\n```\n{src}\n```\n\nINSTRUCTION: {instruction}",
        }],
    )
    new_src = msg.content[0].text
    Path(path).write_text(new_src)
    print(f"updated {path} ({len(src)} -> {len(new_src)} chars)")

if __name__ == "__main__":
    edit_file("hello.py", "add a docstring and type hints to every function")
```

这段代码一目了然地暴露了**所有真实工程问题**：

- 全文件重写在大文件上爆 token——见 [04 · 代码生成](./04-code-generation.md)。
- 没有备份、没有 diff、没有 review——见 [04 §6](./04-code-generation.md)。
- 没有跨文件上下文——见 [02 · 代码理解](./02-code-understanding.md) / [03 · Code RAG](./03-code-rag.md)。
- LLM 跑了 `os.system("rm -rf")` 怎么办——见 [05 · 沙箱](./05-sandbox.md)。
- 改完跑测试验证——见 [07 · 调试](./07-debug.md) / [08 · 测试生成](./08-test-gen.md)。

后面 9 章就是把这 5 件事一件件做对。

## 9. 三个不可回避的工程问题

把 Coding Agent 抽象成三个核心问题，**所有产品差异都在怎么回答这三问上**：

| 问题 | 现状 | 关键章节 |
| --- | --- | --- |
| 怎么把代码喂给 LLM？ | RAG + 符号 + 摘要混合 | [02](./02-code-understanding.md)、[03](./03-code-rag.md) |
| 怎么让 LLM 安全改代码？ | SEARCH/REPLACE + 沙箱 + git | [04](./04-code-generation.md)、[05](./05-sandbox.md) |
| 怎么知道 LLM 改对了？ | 跑测试 + 评测体系 | [07](./07-debug.md)、[08](./08-test-gen.md)、[../eval/](../eval/) |

**每个问题都还没"解决"**——SOTA 在快速迭代。但任意一个问题答得好，就能做出有差异化的产品。

## 10. 一张图看懂 Coding Agent 数据流

```text
用户意图
   │
   ▼
[Plan]──────► repo map / RAG（02、03）
   │
   ▼
[Tools] (Read / Grep / Edit / Bash)──────► 沙箱（05）
   │
   ▼
[Edit] (SEARCH/REPLACE / Fast Apply)（04）
   │
   ▼
[Verify] (lint / pytest / tsc)（07、08）
   │  失败
   ├─────► [Reflect] ──► 回 [Plan]
   │
   ▼  通过
[Commit] (git auto-commit)
```

每个箭头对应后面一章，不要跳过。

## 11. 一年 Coding Agent 大事记速查

按时间倒序，方便你判断"现在的状态"：

| 时间 | 事件 | 意义 |
| --- | --- | --- |
| 2025 中 | SWE-bench Verified 突破 70% | Agent 可在真实 issue 上稳定修复 |
| 2025 上 | Claude Code 公开 + Skills | CLI Agent 主流化 |
| 2025 上 | Cursor Background Agent | 长任务从 Devin 扩散到主流 IDE |
| 2024.11 | Anthropic MCP 发布 | Coding Agent 工具协议标准化 |
| 2024.10 | Claude 3.5 Sonnet (new) + Computer Use | 工具调用进入"可生产"阶段 |
| 2024 中 | SWE-agent 论文 + SWE-bench 火爆 | 评测共识形成 |
| 2024.03 | Devin 发布 | "全自主长任务"叙事成型 |
| 2023.10 | SWE-bench v1 发布 | 第一个被广泛接受的评测 |
| 2023 上 | Cursor 上线 + GPT-4 | Inline edit / chat 成为标准 |
| 2022.11 | ChatGPT 发布 | Coding Agent 进入大众视野 |
| 2021.06 | GitHub Copilot 公测 | 行业起点 |

**接下来 12 个月会发生什么**（个人判断，仅供参考）：

- 多模态 Coding Agent（看截图、读 figma 直出代码）。
- 长任务的"Background Agent on rails"——比 Devin 更可控的中间形态。
- 自训 fast apply / RAG / planner 的小模型生态。
- Coding Agent 评测从 SWE-bench 扩展到"真实研发流程"指标（PR cycle time、回归率）。
- MCP 生态爆炸，每个内部系统都有 MCP server。

## 12. Coding Agent 的"成熟度模型"

参考 SAE 自动驾驶分级，给 Coding Agent 一个 L0–L5 框架，便于讨论"自家产品到哪一档了"：

| 级别 | 描述 | 用户介入 | 代表 |
| --- | --- | --- | --- |
| L0 | 纯模型 API，无 IDE 集成 | 100% | OpenAI Playground 写代码 |
| L1 | 行内补全 / 单选区改写 | 每次 tab/cmd | Copilot v1 |
| L2 | 多步对话 + 引用 | 每轮 review | Copilot Chat、Continue |
| L3 | 多文件 plan-execute，用户阶段确认 | 每阶段 | Cursor Composer、Cline |
| L4 | 长任务后台跑，用户最后 review | 仅最后 | Cursor BG、Devin checkpoints |
| L5 | 全自主 issue → PR 流程 | 极少 | Devin 演示版 |

**L3 是当前商业化甜蜜点**——用户体验 / 错误代价 / 加速效果 三者最佳平衡。L5 还属于"可演示不可量产"。

## 13. 与 browser-agent 主题的边界

下一个垂直主题是 browser-agent（浏览器操作 agent，类 OpenAI Operator / Claude Computer Use）。两者经常被混为一谈，先划清：

| 维度 | Coding Agent | Browser Agent |
| --- | --- | --- |
| 操作对象 | 文件系统、git、终端、IDE | DOM、点击、表单、截图 |
| 状态表达 | 文本（代码） | 视觉 + 结构化 DOM |
| 反馈信号 | 编译/测试/lint | 截图 diff、网络请求、文本变化 |
| 错误代价 | rm -rf、git push --force | 误下单、误发邮件 |
| 评测基准 | SWE-bench、HumanEval | WebArena、Mind2Web |
| 模型偏好 | 强代码模型（Claude/Sonnet） | 强多模态模型 |

**重叠区**：Devin 这类全自主 Agent 同时做编码 + 浏览器（查文档、提 PR）。如果你只读 Coding Agent 这 10 章，就把"打开浏览器查文档"当成一个工具调用看待，等 browser-agent 主题出来再深入。

## 常见坑

1. **拿"聊天 Demo"当产品**：Demo 里 LLM 总是顺利改对，真实场景是上下文塞不下、跨文件依赖错、改对一处坏三处。Demo 上线 = 客诉来源。
2. **过度信任全自主 Agent**：Devin 演示是精心挑选的 case，**你的真实代码库远更脏**。从 inline edit 起步，逐级放权。
3. **忽视评测**：没有评测的 Coding Agent 等于盲飞。先建一个最小 SWE-bench-Lite（10 个真实 issue，跑通跑挂可重复），再调 prompt 和模型。
4. **没有沙箱就让 Agent 跑命令**：哪怕只是本地原型，也用 docker 或 [E2B](https://e2b.dev/) 包一层。生产事故里 80% 是这里翻车。
5. **追新追到没产品**：每两周出一个 SOTA Agent 论文，但你客户的痛点是"我的 React 项目里加一个表单页"——先把这种**小范围、高频、低自主**的场景做到 90 分，再去追 SWE-bench。

## 下一步

- 进入 [02 · 代码理解](./02-code-understanding.md) 看 Coding Agent 怎么"读懂代码"。
- 跳到 [10 · 案例剖析](./10-case-study.md) 直接看 Cursor / Claude Code / Devin / Aider 的设计差异。
- 回到 [../agents/01-overview.md](../agents/01-overview.md) 复习 Agent 通用形态分类，对照本章的代码垂类形态。
- 参考 [../rag-advanced/01-overview.md](../rag-advanced/01-overview.md) 理解 RAG 通用框架，第 [03 章](./03-code-rag.md) 会做代码特化。
