# 08 · 多模态 Agent

把 VLM 接进 Agent 循环 = **会看的 Agent**。这是 2024-2025 年最有想象力的方向：Computer Use、UI 测试、视障辅助、医疗影像分诊……本章建立工程框架，工具调用基础见 [`../agents/04-tool-use.md`](../agents/04-tool-use.md)。

## 1. 多模态 Agent 三大形态

| 形态 | 输入 | 工具 | 代表 |
| ---- | ---- | ---- | ---- |
| **VLM + 静态工具** | 图 + 文 | 数据库 / API | 发票审核 Bot |
| **Computer Use** | 屏幕截图 | 鼠标 / 键盘 | Claude Computer Use / OpenAI CUA |
| **实时视觉 Agent** | 视频 / 摄像头流 | 多种 | 视障辅助、机器人 |

## 2. VLM + 工具循环：基础模式

经典 ReAct 循环加上"看图"步骤：

```
观察（图） ─→ 思考 ─→ 行动（工具调用） ─→ 工具结果（可能含新图） ─→ 观察 ─→ ...
```

```python
from openai import OpenAI
import json, base64

client = OpenAI()
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "lookup_product",
            "description": "根据商品名查询库存与价格",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string"}, "sku": {"type": "string"}
            }, "required": ["name"]},
        },
    }
]

def run_agent(image_path: str, user_msg: str, max_steps=5):
    img_b64 = base64.b64encode(open(image_path, "rb").read()).decode()
    messages = [{"role": "user", "content": [
        {"type": "text", "text": user_msg},
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img_b64}"}},
    ]}]
    for _ in range(max_steps):
        resp = client.chat.completions.create(
            model="gpt-4o", messages=messages, tools=TOOLS,
        )
        msg = resp.choices[0].message
        messages.append(msg)
        if not msg.tool_calls:
            return msg.content
        for call in msg.tool_calls:
            result = dispatch(call.function.name, json.loads(call.function.arguments))
            messages.append({"role": "tool", "tool_call_id": call.id, "content": str(result)})
    return "max steps reached"
```

**多模态特点**：每轮工具结果**也可能含图**（截图、生成的图表），需要继续作为图片塞回上下文。

## 3. Computer Use：会操作电脑的 Agent

**Anthropic Computer Use**（2024.10）和 **OpenAI CUA**（2025）让模型可以：

```
看屏幕 → 决定点哪里 → 调用 mouse/keyboard 工具 → 看新屏幕 → ...
```

| 厂商 | API / 工具 | 能力 |
| ---- | ---------- | ---- |
| Anthropic | `computer_20241022` 工具 | 截图、点击、键盘、scroll |
| OpenAI | CUA（Responses API） | 同上 |
| 开源 | Open Interpreter / Self-Operating Computer | 拼装方案 |

```python
# Anthropic Computer Use 极简版（只示意）
import anthropic, pyautogui, base64, io
from PIL import Image

ac = anthropic.Anthropic()

def screenshot_b64():
    img = pyautogui.screenshot()
    buf = io.BytesIO(); img.save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()

tools = [{"type": "computer_20241022", "name": "computer",
          "display_width_px": 1920, "display_height_px": 1080, "display_number": 1}]

messages = [{"role": "user", "content": "打开浏览器，搜索今天的天气。"}]
while True:
    resp = ac.beta.messages.create(
        model="claude-3-5-sonnet-latest",
        max_tokens=1024, tools=tools, messages=messages,
        betas=["computer-use-2024-10-22"],
    )
    for block in resp.content:
        if block.type == "tool_use" and block.name == "computer":
            action = block.input["action"]
            if action == "screenshot":
                img = screenshot_b64()
                messages.append({"role": "assistant", "content": resp.content})
                messages.append({"role": "user", "content": [{
                    "type": "tool_result", "tool_use_id": block.id,
                    "content": [{"type": "image", "source": {
                        "type": "base64", "media_type": "image/png", "data": img
                    }}]
                }]})
            elif action == "left_click":
                x, y = block.input["coordinate"]
                pyautogui.click(x, y)
                # ... 同上回写 tool_result
    if resp.stop_reason == "end_turn":
        break
```

**生产经验**：

- **沙箱化**：Computer Use 必须在隔离 VM / 容器里跑（Docker + xvfb）。
- **限制工具**：禁掉 sudo、文件删除等危险操作。
- **超时与失败重试**：UI 卡住会让 Agent 转圈。
- **速度慢且贵**：每步一张截图 + 一次模型调用，**单任务几美元**很常见。

## 4. UI 测试 Agent

把 Computer Use 用在自动化测试：

| 任务 | 传统 | 多模态 Agent |
| ---- | ---- | ------------ |
| 写 selector | 工程师维护 | Agent 看截图自己找 |
| UI 改版 | 测试用例全挂 | Agent 自适应 |
| 视觉回归 | 截图比对 | VLM 描述差异 |
| 异常路径 | 难穷举 | Agent 探索式 |

**典型流程**：

```
读测试用例（自然语言） → Agent 操作 UI → 每步对比期望 → 出报告
```

工具：Playwright + Computer Use / [browser-use](https://github.com/browser-use/browser-use) / [Skyvern](https://github.com/Skyvern-AI/skyvern)。

## 5. 多模态 ReAct 模板

把"看图 + 思考 + 行动"标准化为 prompt 模板：

```text
你是一个多模态 Agent。每轮按以下结构思考：

OBSERVE: 描述图中关键元素（精确，不要总结）
THINK:   基于观察推理下一步要做什么
ACTION:  调用工具或回答用户

可用工具：
- screenshot(): 重新截屏
- click(x, y): 点击坐标
- type(text): 输入文本
- finish(answer): 任务完成

注意：
- 每次只调一个工具
- 不确定就先 screenshot 再判断
- 危险操作（删除、付款）必须先与用户确认
```

**实战经验**：让模型显式写出 `OBSERVE` 极大减少幻觉，否则容易"凭印象点"。

## 6. 与 ../agents/04-tool-use.md 的衔接

参考 [`../agents/04-tool-use.md`](../agents/04-tool-use.md) 中的工具设计原则，多模态扩展点：

| 原则 | 多模态特化 |
| ---- | ---------- |
| 工具描述清晰 | 同 |
| 输入 schema 严格 | 多模态工具的输入往往是坐标 / 区域，要给清坐标系 |
| 错误信息可读 | 工具失败时返回截图作为错误证据 |
| 幂等性 | 多模态 Agent 容易"重复点击"，工具要去重 |
| 限制工具数量 | VLM 工具调用准确率随工具增多下降更快 |

## 7. 案例：Code Copilot + 截图

开发者贴张截图问"为什么这个布局错位？"，Agent 应能：

```
截图 → 检测页面框架（HTML 结构推断） → 找到错位元素 → 给出 CSS 修复建议
```

```python
def debug_ui(screenshot_path: str, user_question: str):
    return run_agent(
        image_path=screenshot_path,
        user_msg=(
            f"用户问：{user_question}\n"
            "请按以下步骤：\n"
            "1. 描述截图中的 UI（结构 + 异常点）\n"
            "2. 推断 HTML/CSS\n"
            "3. 给出修复方案，附最少改动的代码 diff\n"
        ),
        max_steps=3,
    )
```

## 8. 案例：医学影像分诊 Agent

> **免责声明：仅作为辅助，不能替代医生**。

```
影像（CT 切片）→ 专用模型（病灶检测）→ 标注图 → VLM 解读 → 报告草稿 → 医生复核
```

关键设计：

- **专用模型在前**（更高敏感度），VLM 解读和写报告。
- **每条结论附置信度**。
- **任何阳性结果必须标注图像位置**（bbox）。
- **写入审计日志**（合规要求）。

## 9. 即将的 browser-agent 主题预告

后续单独主题会深入：

- 浏览器架构（Playwright / CDP / Chrome DevTools）
- DOM 抽取 vs 视觉抽取的权衡
- 防 bot 检测、人机验证应对
- 任务持久化与失败恢复
- 价格与速度优化

本章只覆盖**视觉 Agent 的通用框架**。

## 10. 失败模式与缓解

| 失败 | 表现 | 缓解 |
| ---- | ---- | ---- |
| 看错坐标 | 点不准 | 先让模型输出 bbox + crop 验证 |
| 死循环 | 重复同一动作 | 历史去重 + max steps |
| "看不到"错误 | 弹窗遮挡未识别 | 强制 screenshot 验证关键状态 |
| 工具描述模糊 | 调用错工具 | 工具数 ≤ 8 + 强 schema |
| 跨步骤忘记 | 上下文超长后 | 每 N 步压缩历史 |
| 截图过大 | 模型抓不住关键 | 自动 crop 到当前焦点区域 |

## 常见坑

- **不做沙箱跑 Computer Use**。Agent 一次手抖能把你硬盘文件删了，必须 VM / 容器隔离。
- **每步都全屏截图**。token 爆 + 关键信息淹没。crop 到当前操作区域更高效。
- **工具数量给太多**。10+ 工具时 VLM 调用准确率明显下降，先做工具分组 + 路由。
- **没设 max_steps**。VLM Agent 进入循环时比纯文本 Agent 更难自救，强制硬上限。
- **忽视成本**。Computer Use 单任务 1-5 美元很常见，上线前算好预算。

## 下一步

- [`../agents/`](../agents/) — Agent 通用设计原则。
- [`../agents/04-tool-use.md`](../agents/04-tool-use.md) — 工具调用基础。
- [`../langgraph/`](../langgraph/) — 用 LangGraph 编排多模态 Agent。
- [10 · 评测与生产化](./10-production.md) — Agent 上线评测。
