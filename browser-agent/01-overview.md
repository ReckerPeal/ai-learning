# 01 · 现状综览：浏览器 Agent 的产品形态与技术路线

> 2024 下半年开始，浏览器 Agent 从"科研 demo"走进"商业产品"：Anthropic Computer Use（2024.10）、Manus（2025 初）、OpenAI Operator（2025.01）、Browser Use（开源爆款）连续登场。这一章先讲清楚**这条赛道现在有哪些玩家、哪些技术路线、各自吃哪种市场**，再展开后续章节的工程细节。

## 1. 为什么浏览器是 Agent 落地的"主战场"

软件世界从未真正被"API 化"。SaaS 公司给你的是 GUI 不是 API；银行、政府、企业内网更是。浏览器恰好是**最稳定的兜底接口**：

| 维度 | API | 浏览器 |
| ---- | --- | ------ |
| 覆盖率 | 5%-20%（看行业） | ~100%（凡是有网页的） |
| 稳定性 | 版本化、文档化 | 改版无通知 |
| 鉴权 | OAuth / API Key | Cookie / SSO / 2FA |
| 成本 | 调用计费 | 模型 + 算力 |
| 速度 | 100ms 级 | 秒级（含模型推理） |

"用浏览器代替 API"是**广覆盖**的代价——慢、贵、脆——但它**没替代品**。Browser Agent 的本质是把这层脆替 LLM 兜住。

## 2. 主要玩家速览

### 2.1 商业产品

| 产品 | 时间 | 路线 | 形态 | 备注 |
| ---- | ---- | ---- | ---- | ---- |
| **Anthropic Computer Use** | 2024.10 | Vision + 全屏坐标 | 模型 API + 本地/容器 | `computer_20241022` 工具，beta |
| **Anthropic Computer Use 1.5** | 2025.05 | 同上 + 文本编辑器 / bash 工具 | Claude 3.7 / 4 系列 | 多工具组合 |
| **OpenAI Operator / CUA** | 2025.01 | Vision + 坐标 | 托管 Web 应用 | 仅 Pro 用户，自家浏览器沙箱 |
| **Manus** | 2025.03 | DOM + Vision 混合 | 托管，多任务并行 | 邀请制，黑盒 |
| **Google Project Mariner** | 2024.12 | Chrome 扩展 + Gemini | 浏览器原生 | 实验性 |
| **Microsoft Magentic-One** | 2024.11 | 多 Agent 编排 | 开源框架 | 含 WebSurfer 子 agent |

### 2.2 开源参考实现

| 项目 | 路线 | 特色 |
| ---- | ---- | ---- |
| **Browser Use** | DOM 优先 + Vision 备份 | Python，社区最活跃，Playwright |
| **Skyvern** | Vision 优先 | 工作流定义、回放、企业级 |
| **AgentE** | 分层 planner/executor | 强调任务分解 |
| **WebVoyager** | set-of-mark | 学术参考实现 |
| **LaVague** | 纯 DOM | 轻量、易嵌入 |
| **Open Operator** | CUA 协议复刻 | Browserbase 出品 |
| **Stagehand** | DOM + 自然语言 act() | Browserbase 出品，TypeScript |

## 3. 技术路线分类

按"模型怎么看页面"分三大流派：

```
        ┌─────────────────────┐
        │   浏览器 Agent      │
        └─────────┬───────────┘
                  │
     ┌────────────┼────────────┐
     │            │            │
   Vision      Accessibility  Hybrid
   （只看图）  （只读 DOM）   （图 + DOM）
```

| 路线 | 输入给 LLM | 输出 | 模型要求 | 代表 |
| ---- | --------- | ---- | -------- | ---- |
| **Vision** | 屏幕截图 | 像素坐标 `(x, y)` | 必须 VLM | Computer Use、Operator |
| **Accessibility** | 简化的 DOM / a11y 树 | selector 或 ref id | 普通 LLM 即可 | LaVague、早期 Browser Use |
| **Hybrid（set-of-mark）** | 截图（带数字标注）+ DOM 索引 | 数字 ID | VLM | WebVoyager、当下 Browser Use |

详细对比（精度 / 速度 / 成本）：

| 路线 | UI 改版鲁棒 | 速度 | 单步成本 | 复杂控件（Canvas、自定义） | 跨网站泛化 |
| ---- | ----------- | ---- | -------- | ------------------------- | ---------- |
| Vision | 高（像素稳定） | 慢（截图 + VLM） | 高（图像 token） | 强（人类怎么看就怎么看） | 强 |
| Accessibility | 低（selector 易失效） | 快 | 低 | 弱（Canvas 完全看不到） | 中 |
| Hybrid | 中-高 | 中 | 中 | 中 | 强 |

**经验**：纯 Vision 是**最贵也最通用**的方案；纯 DOM 适合"内部熟悉网站"；混合是当前 SOTA。第 [05 章](./05-hybrid-strategy.md) 展开。

## 4. 一个最小的 Computer Use 调用骨架

为了让后面章节有共同起点，先给 Anthropic 官方 API 的调用结构：

```python
# pip install anthropic playwright pillow
import anthropic, base64, io
from playwright.sync_api import sync_playwright
from PIL import Image

client = anthropic.Anthropic()

TOOLS = [
    {
        "type": "computer_20250124",  # 2025 版本
        "name": "computer",
        "display_width_px": 1280,
        "display_height_px": 800,
        "display_number": 1,
    }
]

def screenshot_b64(page) -> str:
    png = page.screenshot(type="png", full_page=False)
    return base64.b64encode(png).decode()

def run(task: str, url: str, max_steps: int = 25):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page.goto(url)

        messages = [{"role": "user", "content": task}]
        for step in range(max_steps):
            resp = client.beta.messages.create(
                model="claude-sonnet-4-5",
                max_tokens=1024,
                tools=TOOLS,
                messages=messages,
                betas=["computer-use-2025-01-24"],
            )
            messages.append({"role": "assistant", "content": resp.content})
            tool_results = []
            for block in resp.content:
                if block.type != "tool_use":
                    continue
                action = block.input.get("action")
                if action == "screenshot":
                    img = screenshot_b64(page)
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": [{"type": "image", "source": {
                            "type": "base64", "media_type": "image/png", "data": img,
                        }}],
                    })
                elif action == "left_click":
                    x, y = block.input["coordinate"]
                    page.mouse.click(x, y)
                    tool_results.append({"type": "tool_result",
                        "tool_use_id": block.id, "content": "clicked"})
                elif action == "type":
                    page.keyboard.type(block.input["text"])
                    tool_results.append({"type": "tool_result",
                        "tool_use_id": block.id, "content": "typed"})
                # ... 其他 action：key、scroll、wait、mouse_move 等
            if not tool_results:
                break
            messages.append({"role": "user", "content": tool_results})
        browser.close()
```

注意：

- `display_width_px` / `display_height_px` 必须**与实际浏览器视口一致**，否则坐标系错乱。
- 每次 `screenshot` 后都要把图喂回模型——这是循环驱动力。
- 真实项目里要加 `wait` action、超时、循环检测——见第 [09 章](./09-error-recovery.md)。

## 5. 不同形态的"工作单位"

不同产品对 Agent 的封装颗粒度差异很大：

| 颗粒度 | 用户给 Agent 的输入 | 例子 | 适合 |
| ------ | ------------------- | ---- | ---- |
| **单步动作** | "点登录按钮" | Stagehand `act()` | 嵌入到自家应用里 |
| **小任务** | "登录后下载发票" | Browser Use | 个人助理 |
| **长任务** | "调研三家 SaaS 竞品并出对比表" | Manus、Operator | 替代人工小时级工作 |
| **持续运营** | "每天 9 点抓取 X 平台数据存到 Sheet" | 加 cron 的 Browser Agent | 数据采集流水线 |

颗粒度越大，**规划 / 记忆 / 错误恢复**的难度越高——也就越能体现 Agent 与传统 RPA（UiPath、Power Automate）的差距。

## 6. Browser Agent vs 传统 RPA

| 维度 | 传统 RPA（UiPath 等） | Browser Agent |
| ---- | -------------------- | ------------- |
| 流程定义 | 录制 / 拖拉拽 | 自然语言 |
| 改版应对 | 脚本挂掉，人工修 | 模型自适应（一定程度） |
| 处理异常 | 流程图分支 | LLM 推理 |
| 启动成本 | 高（培训 / 顾问） | 低（写几句话） |
| 大规模可重复性 | 高（确定脚本） | 中（模型抖动） |
| 上限 | 设计者预想的所有场景 | 训练数据 + 提示词覆盖的场景 |

**真实部署经验**：很多企业不是用 Agent **替代** RPA，而是**结合**——RPA 跑稳定主流程，Agent 兜底异常场景。第 [10 章](./10-safety-compliance.md) 展开企业落地。

## 7. 评测体系速览

| 基准 | 类型 | 站点 | 任务规模 | 备注 |
| ---- | ---- | ---- | -------- | ---- |
| **WebArena** | 自托管 | Shopping / Reddit / GitLab / Maps | 812 | 沙箱环境、可复现 |
| **VisualWebArena** | 自托管 | 同上 + 视觉版 | 910 | 强调视觉理解 |
| **Mind2Web** | 真实网站 | 137 网站 | 2350 | 测跨域泛化 |
| **WebVoyager** | 真实网站 | 15 大热门站 | 643 | 轻量、好复现 |
| **AssistantBench** | 真实网站 | 长程信息搜集 | 214 | 测"会不会查资料" |

**SOTA 大致水平（2026 年初）**：

- WebArena：前沿系统 ~50% 通过率（人类 ~78%）
- VisualWebArena：~30%（人类 ~88%）
- Mind2Web：跨域元素准确率 ~70%、任务成功率 ~30%

**结论**：远未饱和。哪条路线先稳定到 70%+ 谁就是赢家。

## 商业模式速览

| 模式 | 代表 | 卖点 |
| ---- | ---- | ---- |
| **按订阅** | OpenAI Operator | 月费包用量 |
| **按任务** | Manus、部分企业版 | 复杂任务收高价 |
| **API 调用** | Anthropic Computer Use | 模型 token + tool 调用 |
| **托管浏览器**（PaaS） | Browserbase、Steel | 卖"反检测 + 持久会话" |
| **开源 + 自托管** | Browser Use | 卖支持 / 企业版 |

注：模型 API 商不直接做产品（Anthropic 不做 Operator 类产品），托管浏览器商也不做模型——**分工正在形成**。

## 常见坑

- **把 Computer Use demo 直接当成"开箱即用产品"**。Anthropic 自己也说成功率在 50% 量级。生产环境要加大量重试、HITL、监控。
- **认为"DOM 路径未来会消失"**。错——很多企业内网、政务系统 DOM 还能跑，截图模式反而太贵。要做企业级产品，**双路径都得有**。
- **忽视成本**。一个"调研 3 家公司"的任务，Vision 路线常见 \$0.50-\$5；并发 100 用户就是每月几万美元模型费。
- **拿 E2E 测试经验直接套**。测试场景是"知道哪个 selector"，Agent 是"自己找 selector"——后者难度是几个量级。
- **盲目相信 benchmark 数字**。WebArena 是沙箱、Mind2Web 是离线截图——线上真实网站的反爬、登录、弹窗会让成功率再掉 20-40%。

## 下一步

- [02 · 浏览器自动化基础](./02-automation-basics.md) — 用对 Playwright 是 Agent 的地基。
- [03 · Vision 路径](./03-vision-path.md) — Computer Use 形态的内部机制。
- [04 · Accessibility 路径](./04-accessibility-path.md) — DOM 抽取与序列化。
- [05 · 混合策略](./05-hybrid-strategy.md) — set-of-mark 与决策框架。
- [`../multimodal/08-multimodal-agent.md`](../multimodal/08-multimodal-agent.md) — 视觉 Agent 通用框架（前置阅读）。
