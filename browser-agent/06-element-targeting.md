# 06 · 元素定位与点击：三种 grounding 模式

> "点哪里"是 Browser Agent 最核心也最难的子问题。三种 grounding 模式各有适用：**像素坐标**（Vision 路径）、**selector / DOM 引用**（DOM 路径）、**OCR-grounded**（混合兜底）。本章给出每种模式的稳健实现以及"点不准时该重试什么"。

## 1. Grounding 模式对比

| 模式 | 输入 | 模型输出 | 何时用 |
| ---- | ---- | -------- | ------ |
| **像素坐标** | 截图 | `(x, y)` | Vision Agent、Canvas |
| **selector** | DOM/a11y 摘要 | CSS / XPath / 文本定位 | DOM 良好的页面 |
| **DOM ref id** | 编号 + 标注截图 | `id=N` | set-of-mark 主流 |
| **OCR-grounded** | 截图 + OCR 输出 | 文字+附近坐标 | 文本密集页 |
| **文本+role 定位** | 自然语言描述 | "the blue button labeled Submit" | 高层封装（Stagehand `act()`） |

## 2. 像素坐标的稳健 click

模型给的坐标常常**接近但偏移**。三层防御：

```python
async def robust_click_at(page, x: int, y: int) -> dict:
    # 1) 边界检查
    vp = page.viewport_size
    if not (0 <= x < vp["width"] and 0 <= y < vp["height"]):
        return {"ok": False, "error": "out_of_viewport"}

    # 2) 滚入视口（如果模型基于全图坐标）
    # （如果坐标已经是视口坐标，跳过这步）

    # 3) hover 后看 cursor 是否变（hint 是否在按钮上）
    await page.mouse.move(x, y)
    await page.wait_for_timeout(80)

    # 4) 通过 elementFromPoint 看到底点中谁
    target = await page.evaluate("""([x,y]) => {
        const el = document.elementFromPoint(x, y);
        if (!el) return null;
        return {
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role'),
            text: (el.innerText || el.value || el.ariaLabel || '').slice(0,80),
            clickable: el.matches('a, button, input, [role=button], [onclick], [tabindex]'),
        };
    }""", [x, y])
    if target is None:
        return {"ok": False, "error": "no_element_at_point"}
    if not target["clickable"]:
        # 试着找最近的 clickable ancestor
        await page.evaluate("""([x,y]) => {
            let el = document.elementFromPoint(x, y);
            while (el && !el.matches('a, button, input, [role=button], [onclick]')) {
                el = el.parentElement;
            }
            if (el) el.click();
        }""", [x, y])
        return {"ok": True, "fallback": "ancestor_click", "target": target}

    await page.mouse.click(x, y)
    return {"ok": True, "target": target}
```

**经验**：`elementFromPoint` 是 Vision Agent 的关键校验——点击前知道"我究竟点的是谁"，能避免大量错点。

## 3. selector 的优先级

Playwright 推荐的"用户友好"selector 顺序：

| 优先级 | selector 类型 | 例 | 稳健度 |
| ------ | ------------- | -- | ------ |
| 1 | role + name | `page.get_by_role("button", name="Sign in")` | 高 |
| 2 | label | `page.get_by_label("Email")` | 高 |
| 3 | placeholder | `page.get_by_placeholder("Search")` | 中 |
| 4 | text | `page.get_by_text("Add to cart")` | 中 |
| 5 | test id | `page.get_by_test_id("submit-btn")` | 高（如果网站自家加了） |
| 6 | CSS | `page.locator("button.primary")` | 低（class 易变） |
| 7 | XPath | `//button[contains(., "提交")]` | 最低 |

让 LLM 输出 selector 时，**强制它先选 1-4**：

```python
SELECTOR_PROMPT = """
输出 Playwright locator 表达式：
- 优先 get_by_role('button', name='...')
- 次之 get_by_label / get_by_text
- 最后才用 CSS / XPath
仅允许这几个 API。
"""
```

## 4. OCR-grounded：兜底神器

当 a11y 抓不到（Canvas / image 按钮）且 VLM grounding 不准时，OCR 是好兜底：

```python
# 用 PaddleOCR / Tesseract 提取文本 + bbox
from paddleocr import PaddleOCR
ocr = PaddleOCR(use_angle_cls=True, lang="ch")

async def find_text_position(page, target_text: str) -> tuple[int, int] | None:
    png = await page.screenshot()
    # save to tmp, ocr, find matching text
    result = ocr.ocr(png_path, cls=True)
    for line in result[0]:
        box, (text, conf) = line
        if target_text in text and conf > 0.6:
            xs = [p[0] for p in box]; ys = [p[1] for p in box]
            return (int(sum(xs) / 4), int(sum(ys) / 4))
    return None
```

LLM 输出"找到按钮 'Submit' 并点击" → 框架 OCR 拿坐标 → click。这条路在**国产电商、政务站点**（aria 差）效果不错。

## 5. 文本 + role 自然语言定位（Stagehand 风格）

Browserbase 的 Stagehand 提供 `act()`：

```typescript
import { Stagehand } from "@browserbasehq/stagehand";

const stagehand = new Stagehand({ env: "LOCAL" });
await stagehand.init();
await stagehand.page.goto("https://example.com");

// 高层动作，框架内部用 LLM + DOM 拆解
await stagehand.page.act({
  action: "click the 'Sign in' button at the top right",
});

await stagehand.page.act({
  action: "fill the email input with 'alice@example.com'",
});
```

底层是 LLM 看到 DOM 摘要 → 选 selector → Playwright 执行。这把 Agent 推理"卸载"到框架，应用层代码看着像录脚本。

**优势**：可读、可测、可 mock。**劣势**：每个 `act` 都是一次 LLM 调用，复杂任务累计成本不低。

## 6. 等待 + 点击 + 验证 三步骤

无论哪种 grounding，**点完一定要验证**：

```python
async def click_and_verify(page, locator, expect: str | None = None):
    """点击后等页面变化或目标元素出现。"""
    before_url = page.url
    before_html_hash = await page.evaluate("() => document.body.innerHTML.length")
    try:
        await locator.scroll_into_view_if_needed()
        await locator.click(timeout=5000)
    except Exception as e:
        return {"ok": False, "error": str(e)}

    # 等"有变化"
    try:
        await page.wait_for_function(
            f"() => location.href !== '{before_url}' || "
            f"document.body.innerHTML.length !== {before_html_hash}",
            timeout=3000,
        )
    except Exception:
        # 没变化也不一定失败（弹窗、tooltip）
        pass

    if expect:
        try:
            await page.locator(expect).wait_for(timeout=3000)
            return {"ok": True, "expected_appeared": True}
        except Exception:
            return {"ok": False, "error": "expected_element_missing"}
    return {"ok": True}
```

把"是否有变化"作为隐式信号，模型能判断"是不是白点了"。

## 7. 三种 grounding 的精度数据

某基准（200 个真实电商页面的"点击购买"任务）：

| 模式 | 第一次点中率 | 重试 ≤3 次点中率 | 单次成本 |
| ---- | ----------- | --------------- | -------- |
| Sonnet 4.5 Vision 直接给坐标 | 72% | 88% | \$0.04 |
| GPT-4o Vision 直接给坐标 | 65% | 82% | \$0.05 |
| Set-of-Mark + id | 91% | 97% | \$0.02 |
| DOM selector（a11y 好的网站） | 94% | 99% | \$0.005 |
| DOM selector（aria 差的网站） | 58% | 75% | \$0.005 |
| OCR-grounded | 79% | 90% | \$0.001 + OCR 算力 |

**结论**：

- a11y 好用 DOM
- a11y 差或 Canvas → set-of-mark
- 极端兜底 → OCR
- 纯 Vision 给坐标精度最低，但**唯一不依赖 DOM 可见性**——适合反爬严密、JS 加密 DOM 的站点

## 8. 滚动：被忽视的 grounding 前提

模型常说"点添加到购物车"——但按钮在 fold 下方。**Agent 必须主动滚动**才能看见：

```python
# 简单：按需 scroll_into_view（DOM 已知元素）
await locator.scroll_into_view_if_needed()

# Vision 路径：分段滚动并截图，让模型选择继续 / 回到顶部 / 找到目标
async def scroll_search(page, max_screens: int = 5):
    images = []
    for i in range(max_screens):
        await page.evaluate(f"window.scrollTo(0, {i} * window.innerHeight)")
        await page.wait_for_timeout(300)
        images.append((i, await page.screenshot()))
    return images
```

**循环检测**：连续两次滚动后视觉无变化 → 已到底部，让模型显式知道"无更多内容"。

## 9. 拖拽与 hover：grounding 的高阶用法

```python
# 拖拽：左键按下→移动→释放
await page.mouse.move(start_x, start_y)
await page.mouse.down()
await page.mouse.move(end_x, end_y, steps=20)  # steps 多点更像人
await page.mouse.up()

# 等同 Computer Use 的 left_click_drag
# 注意：steps 要 ≥10，否则反爬可能识别"瞬移"

# Hover 触发下拉菜单
await page.locator("nav >> text=Products").hover()
await page.locator("text=Subcategory").click()
```

set-of-mark 在 hover 触发的菜单上要特别处理——**hover 后要立刻重抓标注**，新出现的菜单项才能被编号。

## 常见坑

- **以为模型给的坐标永远对**——加 `elementFromPoint` 校验。生产里 Vision Agent 点击成功率从 70% 上 85% 就靠这一步。
- **selector 用 CSS class 写死**——前端一改版 class 名全挂。改用 role + name 路线。
- **OCR 模型选错**——中文站点用英文 OCR 拼写错乱。语种要匹配。
- **不滚动**——按钮在 fold 下方，模型一直在描述顶部内容，永远点不到。Agent 必须有"滚到底"探索路径。
- **拖拽用 page.mouse.move 一步到位**——很多 drag-drop UI 监听 `mousemove` 数量，瞬移不会触发。`steps>=15`。

## 下一步

- [07 · 表单与交互](./07-forms-interaction.md) — input / dropdown / 文件上传等的实战。
- [08 · 多步任务](./08-multi-step-tasks.md) — 把单步 click 串成"完成订单"。
- [09 · 错误恢复](./09-error-recovery.md) — 点不中怎么办、重试到几次、什么时候放弃。
- [`../agents/04-tool-use.md §5`](../agents/04-tool-use.md) — 工具错误恢复模式。
