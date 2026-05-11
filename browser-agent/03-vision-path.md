# 03 · Vision 路径：截图 + VLM 直接理解 UI

> 这是 Anthropic Computer Use 和 OpenAI Operator 选的路线——**完全不看 DOM，只看像素**。优势是"人类怎么用页面，模型就怎么用"——Canvas、视频播放器、自定义控件都能识别。代价是慢、贵、对 VLM 的视觉 grounding 能力要求极高。

## 1. 为什么 Vision 路径在 2024 后才可行

GPT-4V（2023.09）之前的 VLM **不会精确指坐标**。问"点哪里"，模型说"屏幕中间的红色按钮"——这没法直接驱动鼠标。

转折点：

- 2023.10 *Set-of-Mark Prompting*（Yang et al.）证明给截图加数字标注能让 GPT-4V 准确指认元素。
- 2024.07 *SeeAct* 提出 grounded action generation——明确把"识别"和"动作"分两步。
- 2024.10 Anthropic 发 **Computer Use**——首个端到端给坐标的官方模型。
- 2025.01 OpenAI **Operator / CUA** 跟进。
- 2025-2026 开源 VLM（Qwen2-VL、UI-TARS、SeeClick、Aria-UI）的视觉 grounding 能力快速追平。

## 2. Vision 路径的工具调用面

Anthropic Computer Use 工具的完整 action 列表（2025.01 版）：

| Action | 参数 | 说明 |
| ------ | ---- | ---- |
| `screenshot` | — | 返回当前屏幕截图 |
| `mouse_move` | `coordinate: [x, y]` | 移动鼠标到坐标 |
| `left_click` | `coordinate: [x, y]` | 左键单击 |
| `left_click_drag` | `coordinate: [x, y]` | 从当前位置拖到目标 |
| `right_click` | `coordinate: [x, y]` | 右键 |
| `middle_click` | `coordinate` | 中键 |
| `double_click` | `coordinate` | 双击 |
| `triple_click` | `coordinate` | 三击 |
| `key` | `text: "Return"` | 键盘按键（xdotool 语法） |
| `type` | `text: "..."` | 输入文本 |
| `scroll` | `coordinate`, `direction`, `amount` | 滚动 |
| `wait` | `duration: 2` | 等待秒数 |
| `cursor_position` | — | 当前鼠标位置 |

工具声明（Python）：

```python
COMPUTER_TOOL = {
    "type": "computer_20250124",
    "name": "computer",
    "display_width_px": 1280,
    "display_height_px": 800,
    "display_number": 1,
}
```

OpenAI CUA 的 action 接近但**不完全兼容**——`computer_use_preview` 工具有 `click`、`type`、`scroll`、`keypress`、`drag`、`wait` 等，参数语义略不同。跨厂商要做适配层。

## 3. 坐标系：最容易翻车的一环

VLM 看到的截图是**多大**？工具声明的 `display_width_px` / `display_height_px` 是**多少**？Playwright 视口是**多少**？三者必须一致。

```python
VIEWPORT = {"width": 1280, "height": 800}

# Playwright 启动
ctx = await browser.new_context(viewport=VIEWPORT, device_scale_factor=1)

# 截图（必须 scale="css" 保证 1:1）
png = await page.screenshot(scale="css")

# 工具声明
TOOLS = [{"type": "computer_20250124", "name": "computer",
          "display_width_px": VIEWPORT["width"],
          "display_height_px": VIEWPORT["height"],
          "display_number": 1}]
```

模型给出 `coordinate: [640, 400]` → Playwright `page.mouse.click(640, 400)` 直接调即可——**前提是上面三件事一致**。

Retina / 高 DPI 屏的坑：

| 设置 | 截图像素 | 鼠标坐标系 | 风险 |
| ---- | -------- | ---------- | ---- |
| `device_scale_factor=1` | 与 viewport 同 | 与 viewport 同 | ✓ 推荐 |
| `device_scale_factor=2` | 视口×2 | 视口 | 模型按图给 `[1280, 800]`，但点击坐标系是 `[640, 400]` |

**永远 `device_scale_factor=1`**，除非你愿意做坐标除法。

## 4. Vision 路径的 prompt 模板

让模型显式"先描述、再动作"，幻觉显著下降：

```
你正在通过截图与浏览器交互。每轮你会看到当前截图。

每轮按以下结构思考：
OBSERVE: 描述你看到的关键 UI 元素（按钮位置、当前页面状态、是否有错误/弹窗）
PLAN:    下一步是什么？为什么？
ACTION:  调用一个工具。坐标以截图左上角为 (0,0)。

规则：
- 不确定就先 screenshot 重新看
- 任何危险操作（付款、删除、发送）前必须停下来等用户确认
- 如果连续 3 次 action 后页面没变化，怀疑卡住了，截图后描述异常
- 最多 30 步，超过就告诉用户失败
```

经验：把 OBSERVE 写得**越死板越好**——"我看到顶部有蓝色 'Sign in' 按钮位于约 (1140, 60)"。模型一旦开始抽象（"看起来是登录页"）就开始幻觉坐标。

## 5. 截图策略：成本控制的关键

**默认每步全屏截图**会导致：

- 单图 50-200 KB → 在 Claude / GPT-4o 是 ~1500-3000 image token
- 50 步任务 = 7.5-15 万 image token = **\$0.5-\$2 单任务**

优化策略：

| 策略 | 节省 | 代价 |
| ---- | ---- | ---- |
| 仅在状态变化后截图 | 30%+ | 复杂度 |
| 视口而非 full_page | 50%+ | 多个 scroll 步骤 |
| 自动 crop 到当前焦点 | 70%+ | 实现复杂 |
| 降低分辨率（1280→800） | 50% | grounding 精度下降 |
| 把历史截图压缩为 thumbnail | 40%+ | 上下文压缩 |

**焦点 crop** 示例：

```python
async def crop_around(page, x: int, y: int, w: int = 600, h: int = 400) -> bytes:
    """以 (x, y) 为中心 crop。"""
    viewport = page.viewport_size
    left = max(0, x - w // 2)
    top = max(0, y - h // 2)
    right = min(viewport["width"], left + w)
    bottom = min(viewport["height"], top + h)
    return await page.screenshot(
        clip={"x": left, "y": top, "width": right - left, "height": bottom - top}
    )
```

⚠️ crop 改变了坐标原点——必须告诉模型 crop 的 offset，或者**把 crop 坐标转换回全屏坐标后再调工具**。后者更简单。

## 6. Vision 路径的完整 mini-Agent

```python
import asyncio, base64, anthropic
from playwright.async_api import async_playwright

client = anthropic.Anthropic()

SYSTEM = """你是一个浏览器 Agent，通过截图驱动 Playwright。
每轮先 screenshot 看清楚，再决定动作。
危险操作前 stop_for_confirmation。
最多 25 步。"""

TOOLS = [{
    "type": "computer_20250124", "name": "computer",
    "display_width_px": 1280, "display_height_px": 800, "display_number": 1,
}]

async def shot(page) -> str:
    png = await page.screenshot(scale="css")
    return base64.b64encode(png).decode()

async def run(task: str, start_url: str):
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)
        ctx = await browser.new_context(viewport={"width": 1280, "height": 800},
                                         device_scale_factor=1)
        page = await ctx.new_page()
        await page.goto(start_url)

        first_shot = await shot(page)
        messages = [{"role": "user", "content": [
            {"type": "text", "text": task},
            {"type": "image", "source": {"type": "base64",
             "media_type": "image/png", "data": first_shot}},
        ]}]

        for step in range(25):
            resp = client.beta.messages.create(
                model="claude-sonnet-4-5", max_tokens=1024,
                system=SYSTEM, tools=TOOLS, messages=messages,
                betas=["computer-use-2025-01-24"],
            )
            messages.append({"role": "assistant", "content": resp.content})

            tool_results = []
            for block in resp.content:
                if block.type != "tool_use":
                    continue
                a = block.input
                act = a.get("action")
                try:
                    if act == "screenshot":
                        img = await shot(page)
                        tool_results.append({"type": "tool_result",
                            "tool_use_id": block.id,
                            "content": [{"type": "image", "source": {
                                "type": "base64", "media_type": "image/png", "data": img}}]})
                    elif act == "left_click":
                        x, y = a["coordinate"]
                        await page.mouse.click(x, y)
                        await page.wait_for_timeout(500)
                        img = await shot(page)
                        tool_results.append({"type": "tool_result",
                            "tool_use_id": block.id,
                            "content": [{"type": "image", "source": {
                                "type": "base64", "media_type": "image/png", "data": img}}]})
                    elif act == "type":
                        await page.keyboard.type(a["text"], delay=20)
                        tool_results.append({"type": "tool_result",
                            "tool_use_id": block.id, "content": "typed"})
                    elif act == "key":
                        await page.keyboard.press(a["text"].replace("Return", "Enter"))
                        tool_results.append({"type": "tool_result",
                            "tool_use_id": block.id, "content": "key pressed"})
                    elif act == "scroll":
                        dx, dy = 0, a.get("amount", 3) * 100
                        if a.get("direction") == "up": dy = -dy
                        await page.mouse.wheel(dx, dy)
                        tool_results.append({"type": "tool_result",
                            "tool_use_id": block.id, "content": "scrolled"})
                    elif act == "wait":
                        await asyncio.sleep(a.get("duration", 1))
                        tool_results.append({"type": "tool_result",
                            "tool_use_id": block.id, "content": "waited"})
                except Exception as e:
                    tool_results.append({"type": "tool_result",
                        "tool_use_id": block.id,
                        "content": f"Error: {e}", "is_error": True})

            if not tool_results:
                # 模型结束了
                final = "".join(b.text for b in resp.content if b.type == "text")
                print("DONE:", final)
                break
            messages.append({"role": "user", "content": tool_results})
        await browser.close()
```

**典型问题**（按出现频率）：

| 问题 | 表现 | 缓解 |
| ---- | ---- | ---- |
| 模型在登录页前不停截图 | 不知道下一步是 type | system prompt 写明"看到 input field 直接 click 再 type" |
| 点击坐标偏 10-20 px | 点到旁边元素 | 用 hover 后再 click，或 crop 后放大 |
| 上下文超长 | token 爆 | 每 5 步压缩历史截图为缩略 |
| 死循环点同一处 | 卡住 | 检测连续相同 action，强制变招 |

## 7. VLM grounding 能力对比（2026 初）

| 模型 | 像素 grounding 精度 | 代价 | 工具调用集成 |
| ---- | ------------------ | ---- | ----------- |
| Claude Sonnet 4 / 4.5 (Computer Use) | 高 | 高 | 原生 |
| GPT-4o + CUA | 中-高 | 高 | 原生 |
| Gemini 2.5 Pro | 中 | 中 | 间接（function call + 坐标） |
| Qwen2.5-VL 72B | 中 | 低（自托管） | 间接 |
| **UI-TARS-72B**（字节，2025） | 高（专门训练） | 低 | 专为 GUI |
| **SeeClick** | 中 | 低 | 专为 GUI |

UI-TARS 等"专门训练的 GUI 模型"在 ScreenSpot / Mind2Web 等 grounding 基准上接近甚至超过 GPT-4o，单步成本可低一个数量级——**国产开源在这条线追得很猛**。

## 8. Vision 路径的局限

| 局限 | 例子 |
| ---- | ---- |
| 无限滚动 | 永远看不完，模型容易迷失"在第几屏" |
| 复杂 Canvas（Figma） | 元素没有像素特征，模型乱猜 |
| 抗锯齿、深色模式差异 | 同一按钮训练集没见过样式 |
| 弹窗遮挡 | 模型只描述底层按钮，去点击被遮挡 |
| 多窗口 | 截图只能截一个 |
| 不可见但可交互 | 隐藏在 hover 后的 menu |

**经验**：Vision 是兜底，不是首选。下面 [04](./04-accessibility-path.md) 介绍 DOM 路径，[05](./05-hybrid-strategy.md) 给出 set-of-mark 混合。

## 常见坑

- **viewport / display / 截图缩放不一致**——坐标永远偏。三处必须对齐，且 `device_scale_factor=1`。
- **每轮都让模型看历史所有截图**——token 爆且对决策无帮助。只保留最近 1-3 张 + 文本摘要。
- **盲信 VLM 给的坐标**。先 hover 再 click，或在 crop 后 zoom 确认元素——成功率 +10%。
- **不做循环检测**。Vision Agent 死循环最常见——动作签名连续相同时强制让它输出"我为什么觉得这次会不同"。
- **不打 grounding 指标**。把模型给的坐标记录下来，离线评测"点准率"——这是 Vision Agent 调优最直接的反馈信号。

## 下一步

- [04 · Accessibility 路径](./04-accessibility-path.md) — 不靠像素的另一条路。
- [05 · 混合策略](./05-hybrid-strategy.md) — set-of-mark 把两条路结合。
- [06 · 元素定位与点击](./06-element-targeting.md) — 坐标 / selector / OCR 三种 grounding。
- [09 · 错误恢复](./09-error-recovery.md) — 循环检测、超时、卡死的处理。
- [`../multimodal/08-multimodal-agent.md`](../multimodal/08-multimodal-agent.md) — 视觉 Agent 通用模式。
