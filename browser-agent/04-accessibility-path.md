# 04 · Accessibility 路径：DOM / ARIA / 可达性树

> Vision 路径让模型"用眼睛"，Accessibility 路径让模型"用辅助技术"——读 DOM 和 a11y tree，跟屏幕阅读器（VoiceOver、JAWS）的工作方式一样。优势：快、便宜、对复杂控件天然支持；劣势：依赖网站语义化质量，Canvas / 自定义控件可能完全"看不见"。

## 1. DOM、Accessibility Tree、Render Tree 的区别

```
HTML 源码 ──parse──► DOM Tree
                      │
        ┌─────────────┼──────────────┐
        ▼             ▼              ▼
  Render Tree    Accessibility Tree   ...
  （视觉）          （辅助技术）
```

Browser Agent 关心后两者：

| 树 | 包含 | 用途 |
| -- | ---- | ---- |
| **DOM** | 全部节点（含隐藏） | selector 系统的基础 |
| **A11y Tree** | 对辅助技术暴露的节点 + role / name | 屏幕阅读器、Agent |
| **Render Tree** | 实际渲染的节点 + 位置尺寸 | 视觉路径决策 |

**A11y Tree 是 Agent 的最爱**——它已经被浏览器"剪枝、加语义"过：

```
WebArea "Acme Shop"
  link "Home" ref=1
  link "Products" ref=2
  searchbox "Search" ref=3
  button "Cart (3)" ref=4
  main
    heading "Featured" level=1
    listitem
      img "Red Sneaker"
      link "Red Sneaker" ref=5
      text "$59"
      button "Add to cart" ref=6
```

跟 HTML 比少 90% 噪音、跟截图比可序列化为文本（便宜得多）。

## 2. 用 Playwright 拿 a11y tree

```python
from playwright.async_api import Page

async def get_a11y_tree(page: Page) -> dict:
    """通过 CDP 拿完整 a11y tree。"""
    client = await page.context.new_cdp_session(page)
    res = await client.send("Accessibility.getFullAXTree")
    return res["nodes"]  # 列表，每个节点含 nodeId、role、name、value、children

async def get_a11y_snapshot(page: Page) -> dict:
    """Playwright 内置 a11y snapshot（更高层封装）。"""
    return await page.accessibility.snapshot(interesting_only=True)
```

`interesting_only=True` 会过滤掉装饰节点——**对 Agent 至关重要**，否则一个普通页面 a11y 树几千节点。

输出（节选）：

```json
{
  "role": "WebArea", "name": "Acme Shop",
  "children": [
    {"role": "link", "name": "Home"},
    {"role": "searchbox", "name": "Search"},
    {"role": "button", "name": "Cart (3)"},
    {"role": "heading", "name": "Featured", "level": 1},
    {"role": "button", "name": "Add to cart"}
  ]
}
```

## 3. 把 a11y 树压缩成 LLM 友好的文本

```python
def serialize(node, depth=0, max_depth=8) -> str:
    if depth > max_depth:
        return ""
    role = node.get("role", "")
    name = node.get("name", "")
    indent = "  " * depth
    line = f"{indent}[{node.get('id', '?')}] {role}"
    if name:
        line += f' "{name[:80]}"'
    if node.get("value"):
        line += f" = {node['value'][:60]!r}"
    lines = [line]
    for c in node.get("children", []):
        sub = serialize(c, depth + 1, max_depth)
        if sub:
            lines.append(sub)
    return "\n".join(lines)
```

**关键设计**：每个可交互节点给一个**稳定的 ref id**——模型输出 `click(id=42)`，框架再翻译成实际 selector 或 element handle。

| 序列化策略 | token 量 | 信息完整度 |
| --------- | ------- | --------- |
| 全 HTML | 巨大（10万+） | 完整但充满噪音 |
| 简化 HTML（去 script / style / svg） | 中（1万-3万） | 中 |
| A11y tree（interesting_only） | 小（1千-5千） | 高（语义清晰） |
| A11y tree + 只保留 interactive | 极小（数百） | 仅交互信息 |

实战推荐**最后一种 + 按需展开**：

```python
INTERACTIVE_ROLES = {"button", "link", "textbox", "searchbox", "checkbox",
                     "radio", "combobox", "menuitem", "tab", "switch",
                     "slider", "spinbutton"}

def interactive_only(node, parent_path=""):
    if node.get("role") in INTERACTIVE_ROLES:
        yield {"id": node["id"], "role": node["role"],
               "name": node.get("name", ""), "path": parent_path}
    for c in node.get("children", []):
        yield from interactive_only(c, f"{parent_path}/{node.get('role','')}")
```

## 4. 把 ref id 翻译成 Playwright Locator

a11y 节点本身不能直接 `.click()`——需要回到 DOM 找对应元素：

```python
# 方案 A：通过 CDP nodeId → backendNodeId → DOM
async def click_by_a11y_node(page, node_id: int):
    client = await page.context.new_cdp_session(page)
    res = await client.send("Accessibility.getFullAXTree")
    node = next(n for n in res["nodes"] if n["nodeId"] == node_id)
    backend_id = node["backendDOMNodeId"]
    # 在 page 里通过 backend_id 拿元素
    obj = await client.send("DOM.resolveNode", {"backendNodeId": backend_id})
    # 转 ElementHandle 并 click
    # ...

# 方案 B（更简单）：维护 id → locator 映射
locators_by_id: dict[int, "Locator"] = {}

async def build_index(page):
    locators_by_id.clear()
    # 给每个可交互元素打 attribute，让 selector 能找到它
    await page.evaluate("""() => {
        let i = 0;
        document.querySelectorAll(
            'button, a, input, textarea, select, [role=button], [role=link], [contenteditable]'
        ).forEach(el => { el.setAttribute('data-agent-id', ++i); });
    }""")
    for i in range(1, 200):
        loc = page.locator(f'[data-agent-id="{i}"]')
        if await loc.count() > 0:
            locators_by_id[i] = loc.first
```

方案 B 简单粗暴但**实战最常用**——给元素打 marker 标签，selector 直接用 marker。Browser Use、LaVague 都是这个套路。

## 5. ARIA 不是免费午餐

不是所有网站都规范使用 ARIA：

```html
<!-- ✅ 好网站 -->
<button aria-label="Close dialog">×</button>

<!-- ❌ 普通网站 -->
<div onclick="closeDialog()" class="icon-close">×</div>
```

对后者，a11y 路径会**完全看不到** "Close" 这个语义——模型只能看到 "generic"。处理：

| 情况 | 策略 |
| ---- | ---- |
| 大牌网站（aria 完善） | a11y 路径直接好用 |
| 普通网站（混乱） | a11y + 文本 fallback：除了 role/name，再附近文本节点 |
| 视觉密集（电商图列表） | 切到 Vision 或 set-of-mark |
| 内部企业系统 | 通常 aria 不好，但 selector 稳定——直接学 selector |

文本 fallback 示例：

```python
async def enrich_with_text(page, node_id: int) -> str:
    """对没有 name 的节点，取临近文本作为推断 label。"""
    return await page.evaluate("""(id) => {
        const el = document.querySelector(`[data-agent-id="${id}"]`);
        if (!el) return '';
        return (el.textContent || el.title || el.placeholder || '').slice(0, 80);
    }""", node_id)
```

## 6. Shadow DOM、iframe、跨域

| 复杂结构 | a11y 路径表现 | 备注 |
| -------- | ------------- | ---- |
| Open Shadow DOM | ✓ Playwright a11y 默认穿透 | 一般 |
| Closed Shadow DOM | ✗ 完全看不到 | 切 Vision |
| 同源 iframe | ✓ 各 frame 单独取 a11y | 要遍历 frames |
| 跨域 iframe | ✗ JS 不能跨域取 a11y | 切 Vision 或 CDP |
| Web Components | ✓ 大多支持 | 看作者实现 |

iframe 遍历：

```python
async def all_a11y_snapshots(page):
    snapshots = []
    for frame in page.frames:
        try:
            snap = await frame.accessibility.snapshot(interesting_only=True)
            snapshots.append({"url": frame.url, "tree": snap})
        except Exception:
            continue
    return snapshots
```

## 7. DOM 路径的完整 mini-Agent

```python
import asyncio, json
from openai import AsyncOpenAI
from playwright.async_api import async_playwright

client = AsyncOpenAI()

TOOLS = [
    {"type": "function", "function": {
        "name": "click", "description": "点击 data-agent-id 标记的元素",
        "parameters": {"type": "object", "properties": {
            "id": {"type": "integer"}}, "required": ["id"]}}},
    {"type": "function", "function": {
        "name": "fill", "description": "在 input 元素中填值",
        "parameters": {"type": "object", "properties": {
            "id": {"type": "integer"}, "value": {"type": "string"}},
            "required": ["id", "value"]}}},
    {"type": "function", "function": {
        "name": "goto", "parameters": {"type": "object",
            "properties": {"url": {"type": "string"}}, "required": ["url"]}}},
    {"type": "function", "function": {
        "name": "finish", "parameters": {"type": "object",
            "properties": {"answer": {"type": "string"}}, "required": ["answer"]}}},
]

async def snapshot_for_llm(page) -> str:
    await page.evaluate("""() => {
        let i = 0;
        document.querySelectorAll(
          'button, a, input, textarea, select, [role=button], [contenteditable]'
        ).forEach(el => { el.setAttribute('data-agent-id', ++i); });
    }""")
    snap = await page.accessibility.snapshot(interesting_only=True)
    # 序列化为紧凑文本（伪代码）
    return json.dumps(snap, ensure_ascii=False)[:8000]

async def run(task: str, url: str):
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 1280, "height": 800})
        await page.goto(url)
        messages = [{"role": "system",
            "content": "你是浏览器 Agent，通过 a11y tree 操作页面。"}]
        for step in range(20):
            snap = await snapshot_for_llm(page)
            messages.append({"role": "user",
                "content": f"任务：{task}\n\n当前页面 a11y：\n{snap}"})
            resp = await client.chat.completions.create(
                model="gpt-4o", messages=messages, tools=TOOLS,
            )
            msg = resp.choices[0].message
            messages.append(msg)
            if not msg.tool_calls:
                break
            for tc in msg.tool_calls:
                args = json.loads(tc.function.arguments)
                name = tc.function.name
                try:
                    if name == "goto":
                        await page.goto(args["url"])
                    elif name == "click":
                        await page.locator(f'[data-agent-id="{args["id"]}"]').click()
                    elif name == "fill":
                        await page.locator(f'[data-agent-id="{args["id"]}"]').fill(args["value"])
                    elif name == "finish":
                        print("ANSWER:", args["answer"]); return
                    result = "ok"
                except Exception as e:
                    result = f"Error: {e}"
                messages.append({"role": "tool", "tool_call_id": tc.id, "content": result})
                await page.wait_for_timeout(500)
        await browser.close()
```

## 8. 性能数据：DOM vs Vision

某内部基准（电商加购任务，20 个测试用例）：

| 指标 | Vision (Sonnet 4.5) | DOM (GPT-4o) | DOM (Sonnet 4.5) |
| ---- | ------------------- | ------------ | ---------------- |
| 单步延迟 | 3.5-6s | 1.2-2.5s | 1.5-3s |
| 单任务 token 成本 | \$0.80 | \$0.15 | \$0.25 |
| 任务成功率 | 78% | 70% | 82% |
| Canvas 任务成功率 | 75% | 5% | 5% |

**结论**：DOM 路径**快 3-4 倍、便宜 3-5 倍**，但**遇到非语义化页面（Canvas、复杂 SVG）就崩**。

## 常见坑

- **把整个 DOM 喂给 LLM**——10 万 token，啥都看不准。一定要用 a11y tree 或简化抽取。
- **ref id 跨 snapshot 不稳定**——每次 build index 都重新分配，避免模型记 id 用了再调发现错位。
- **忽视 Shadow DOM**——Stripe Elements、很多 SaaS 控件都用，纯 a11y 失败要切 Vision。
- **不处理 iframe**——OAuth、支付、富文本编辑器都是 iframe，忘了遍历 frames 会"找不到那个按钮"。
- **a11y 抓得太频繁**——每动作都重抓，浪费时间。可以在"页面状态变化"（URL、关键节点存在性）后再重抓。

## 下一步

- [05 · 混合策略](./05-hybrid-strategy.md) — set-of-mark 把 Vision 和 DOM 优势结合。
- [06 · 元素定位与点击](./06-element-targeting.md) — selector / 坐标 / OCR 三种 grounding 模式。
- [07 · 表单与交互](./07-forms-interaction.md) — DOM 路径下表单的实战。
- [`../agents/04-tool-use.md`](../agents/04-tool-use.md) — 工具设计原则。
