# Browser / 自动化 Agent

> Manus 之后，"会上网替我办事"的 Agent 终于从 demo 跑进了主流议程。Anthropic Computer Use、OpenAI Operator、Browser Use 把**浏览器**变成最重要的 Agent 落地面——它是软件世界与现实世界之间最厚也最稳定的 API。本主题专门讲这条赛道的工程：怎么看页面、怎么点准、怎么扛住改版、怎么不踩 TOS 红线。

## 这个主题会教什么 / 不会教什么

**会教**：

- 浏览器自动化基础栈（Playwright / CDP / Puppeteer）在 Agent 场景的"正确姿势"——和传统 E2E 测试**不一样**。
- 三种感知路径——纯 Vision（截图 + VLM）、纯 Accessibility（DOM / ARIA）、Vision+DOM 混合（set-of-mark）——的精度、延迟、成本权衡。
- Anthropic Computer Use / OpenAI CUA 的工具调用形态、坐标系、节流策略。
- 错误恢复：页面改版、登录失效、CAPTCHA、A/B 测试、弹窗 / iframe / Shadow DOM。
- 安全合规：robots.txt、TOS 边界、速率限制、PII、机器人检测对抗的伦理底线。

**不会教**：

- 视觉 Agent 通用框架——见 [`../multimodal/08-multimodal-agent.md`](../multimodal/08-multimodal-agent.md)。
- Agent 通用规划 / 工具设计——见 [`../agents/`](../agents/)。
- 代码 Agent 与浏览器的差异化——见 [`../coding-agent/`](../coding-agent/)。
- 评测体系——见 [`../eval/`](../eval/)。本主题只引用 WebArena / VisualWebArena / Mind2Web 的关键设计。

## 章节索引

1. [01 · 现状综览](./01-overview.md) — Manus / Anthropic Computer Use / OpenAI Operator / Browser Use 的形态对比、技术分类、商业模式。
2. [02 · 浏览器自动化基础](./02-automation-basics.md) — Playwright / Selenium / Puppeteer 选型、CDP、headless vs headed、为 Agent 优化的初始化模板。
3. [03 · Vision 路径](./03-vision-path.md) — 截图 + VLM 直接理解 UI，坐标系、crop 策略、token 成本控制。
4. [04 · Accessibility 路径](./04-accessibility-path.md) — DOM / ARIA / Accessibility Tree 抽取，简化、压缩、序列化为 LLM 输入。
5. [05 · 混合策略](./05-hybrid-strategy.md) — set-of-mark 标注、Vision+DOM 双校验、何时切哪条路径的决策框架。
6. [06 · 元素定位与点击](./06-element-targeting.md) — 坐标 / selector / OCR-grounded 三种 grounding 方式、稳健 click 模式。
7. [07 · 表单与交互](./07-forms-interaction.md) — input / dropdown / 文件上传 / 拖拽 / 富文本编辑器的实战代码。
8. [08 · 多步任务](./08-multi-step-tasks.md) — 电商下单、信息收集、复杂表单、跨域跳转的状态管理与 plan-execute。
9. [09 · 错误恢复](./09-error-recovery.md) — 页面变化、登录失效、CAPTCHA、超时、循环检测、重试策略。
10. [10 · 安全与合规](./10-safety-compliance.md) — robots.txt、TOS、速率限制、PII、CAPTCHA 绕过的伦理边界、企业部署 checklist。

## 与其他主题的关系（速查表）

| 主题 | 关系 |
| ---- | ---- |
| [`../agents/`](../agents/) | Browser Agent 是 [`04-tool-use.md`](../agents/04-tool-use.md)（工具）和 [`05-planning.md`](../agents/05-planning.md)（规划）最复杂的落地场景之一——工具的世界是开放的、不可靠的、对抗性的。 |
| [`../multimodal/`](../multimodal/) | [`08-multimodal-agent.md`](../multimodal/08-multimodal-agent.md) 给出视觉 Agent 通用框架，本主题是它在浏览器垂直域的深化。 |
| [`../coding-agent/`](../coding-agent/) | 同为垂直域 Agent，但 Code Agent 的环境（IDE、shell、git）是**确定性**的；Browser Agent 是**对抗性**的。设计原则可对照阅读。 |
| [`../llm-security/`](../llm-security/) | Prompt 注入在浏览器场景被放大十倍——网页内容本身就是不可信输入；详见第 [10 章](./10-safety-compliance.md)。 |
| [`../eval/`](../eval/) | WebArena / VisualWebArena / Mind2Web / WebVoyager 是评测事实标准，第 [01](./01-overview.md)、[08](./08-multi-step-tasks.md) 章引用。 |
| [`../langgraph/`](../langgraph/) | 浏览器 Agent 的状态机（页面状态、登录状态、步骤指针）用 LangGraph 编排最自然。 |

## 资源

**官方文档与 API**

- Anthropic Computer Use — <https://docs.anthropic.com/en/docs/build-with-claude/computer-use>
- OpenAI Operator / CUA — <https://openai.com/index/introducing-operator/>
- Playwright — <https://playwright.dev/>
- Chrome DevTools Protocol — <https://chromedevtools.github.io/devtools-protocol/>

**开源参考实现**

- Browser Use — <https://github.com/browser-use/browser-use> — 当前最活跃的开源浏览器 Agent
- Skyvern — <https://github.com/Skyvern-AI/skyvern> — Vision-first，专注工作流
- AgentE / Agent-E — <https://github.com/EmergenceAI/Agent-E> — 分层 planner / executor
- WebVoyager — <https://github.com/MinorJerry/WebVoyager> — set-of-mark 学术参考实现
- LaVague — <https://github.com/lavague-ai/LaVague> — DOM-first，轻量
- Open Operator — <https://github.com/browserbase/open-operator> — Browserbase 出品的 CUA 复刻

**评测**

- WebArena — <https://webarena.dev/> — 自托管沙箱、长任务
- VisualWebArena — <https://jykoh.com/vwa> — 视觉密集任务
- Mind2Web — <https://osu-nlp-group.github.io/Mind2Web/> — 真实网站、跨域泛化
- WebVoyager — 基于真实网站的轻量基准
- AssistantBench — <https://assistantbench.github.io/> — 长程信息搜集

**论文 / 报告**

- *WebGPT*（Nakano et al., 2021）— 浏览器 Agent 鼻祖
- *WebArena*（Zhou et al., 2023）
- *SeeAct: Generalist Web Agents with Large Multimodal Models*（Zheng et al., 2024）
- *Set-of-Mark Prompting Unleashes Extraordinary Visual Grounding in GPT-4V*（Yang et al., 2023）
- *Mind2Web*（Deng et al., 2023）
- Anthropic blog: *Introducing computer use* — <https://www.anthropic.com/news/3-5-models-and-computer-use>

**基础设施**

- Browserbase — <https://www.browserbase.com/> — 托管浏览器，反检测
- Steel — <https://steel.dev/> — 同上
- Anchor Browser、Hyperbrowser — 同类竞品

## 阅读顺序建议

- **完整路径**：§01 → §02 → §03 → §04 → §05 → §06 → §07 → §08 → §09 → §10
- **快速做 PoC**：§01 → §02 → §05（混合策略最实用） → §06 → §08
- **从 Computer Use 切入**：§01 → §03 → §06 → §09 → §10
- **从 DOM 自动化切入**（已有 Playwright 经验）：§02 → §04 → §06 → §07 → §09
- **做企业 RPA 替代品**：§02 → §04 → §07 → §08 → §10
- **做研究 / 跑 benchmark**：§01 → §05 → §08 → 直接读 WebArena / Mind2Web 论文

**仓库索引**：[../README.md](../README.md)
