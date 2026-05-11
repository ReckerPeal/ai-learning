# 05 · 混合策略：Vision + DOM / set-of-mark

> 纯 Vision 太贵、纯 DOM 太脆——当下 SOTA 是**混合**：用 DOM 找候选元素，用 Vision 帮模型在视觉上对齐 / 排除歧义。Set-of-Mark Prompting（Yang et al., 2023）是这条路线的工程基石——给截图叠加数字标签，让 VLM "通过号码"指认元素。

## 1. 为什么混合是必然

| 问题 | 纯 Vision | 纯 DOM | 混合 |
| ---- | --------- | ------ | ---- |
| 像素稳健 | ✓ | ✗ | ✓ |
| Canvas / 自定义控件 | ✓ | ✗ | ✓（兜底） |
| 速度 | 慢 | 快 | 中 |
| 成本 | 高 | 低 | 中 |
| 视觉歧义（同一文字多按钮） | 偶尔抓错 | 抓错 | ✓ |
| 视觉 grounding 精度 | 偏 ±10-30 px | 不需要 | 选号即可 |
| 元素 vs 周边内容关联 | ✓ | ✗ | ✓ |

混合的核心思路：**让 LLM 选号，不让它指坐标**——把"视觉理解"和"精确坐标"解耦。

## 2. Set-of-Mark：核心算法

```
1. 用 DOM 找出所有"可能可交互"的元素
2. 在截图上为每个元素叠加一个带数字的边框
3. 把"标注后的截图 + id→元素简介"一起喂给 VLM
4. VLM 输出 "click(id=42)"
5. 框架按 id 找回 DOM 元素，执行 click
```

WebVoyager（2024）跑通这条路线，后续 Browser Use、Skyvern 都采纳了类似设计。

```python
async def annotate_screenshot(page, png: bytes) -> tuple[bytes, dict]:
    """在截图上画 bbox + id。"""
    # 找出可交互元素及其 bbox
    elements = await page.evaluate("""() => {
        const sel = 'a, button, input, textarea, select, ' +
                    '[role=button], [role=link], [role=textbox], ' +
                    '[contenteditable=""], [contenteditable="true"]';
        const els = [...document.querySelectorAll(sel)];
        return els.map((el, i) => {
            const r = el.getBoundingClientRect();
            const visible = r.width > 0 && r.height > 0 &&
                            r.bottom >= 0 && r.top <= window.innerHeight;
            if (!visible) return null;
            el.setAttribute('data-agent-id', i + 1);
            return {
                id: i + 1,
                bbox: [r.x, r.y, r.width, r.height],
                tag: el.tagName.toLowerCase(),
                role: el.getAttribute('role') || '',
                text: (el.innerText || el.value || el.placeholder || '')
                       .slice(0, 60).trim(),
            };
        }).filter(Boolean);
    }""")

    # 用 Pillow 画 bbox + id
    from PIL import Image, ImageDraw, ImageFont
    import io
    img = Image.open(io.BytesIO(png)).convert("RGB")
    draw = ImageDraw.Draw(img)
    font = ImageFont.load_default()
    palette = ["red", "blue", "green", "purple", "orange"]
    for el in elements:
        x, y, w, h = el["bbox"]
        color = palette[el["id"] % len(palette)]
        draw.rectangle([x, y, x + w, y + h], outline=color, width=2)
        draw.rectangle([x, y - 14, x + 20, y], fill=color)
        draw.text((x + 2, y - 14), str(el["id"]), fill="white", font=font)
    out = io.BytesIO(); img.save(out, "PNG")
    index = {e["id"]: e for e in elements}
    return out.getvalue(), index
```

实战要点：

- **只标视口内可见元素**——避免编号到 10000+
- **被遮挡的元素去掉**——通过 `elementFromPoint` 验证可见
- **id 编号策略**：从上到下、从左到右——便于人类调试 + 模型形成"位置感"
- **颜色循环**——同色 bbox 难区分时用多色

## 3. 给 LLM 的 prompt

```
你看到一张截图。每个可交互元素被红框标注并编号。
当前页面元素清单：
[1] button "Sign in" (top-right)
[2] searchbox "Search products"
[3] link "Cart (3)"
[4] button "Add to cart" (in product card)
...

任务：{user_task}

每轮输出 JSON：
{
  "observation": "我看到 ...",
  "thought": "我要先 ...",
  "action": {
    "type": "click" | "fill" | "scroll" | "goto" | "finish",
    "id": 4,                  // click / fill 必需
    "value": "..."            // fill 必需
  }
}

规则：
- id 必须是清单里出现的数字
- 若清单里没有合适元素，先 scroll 或 goto 重抓
- 危险操作前 type=confirm，不要直接执行
```

## 4. 决策框架：何时切换路径

不是所有页面都该套同一种策略：

```python
async def route(page) -> str:
    """决定当前页面用哪条路径。"""
    info = await page.evaluate("""() => ({
        url: location.href,
        canvas_count: document.querySelectorAll('canvas').length,
        a11y_button_count: document.querySelectorAll(
            'button[aria-label], a[aria-label], [role=button]'
        ).length,
        total_interactive: document.querySelectorAll(
            'a, button, input, textarea, select, [role=button]'
        ).length,
    })""")

    # 极强视觉（Canvas）→ Vision
    if info["canvas_count"] >= 3:
        return "vision"
    # 良好 ARIA → DOM
    if info["a11y_button_count"] / max(1, info["total_interactive"]) > 0.5:
        return "dom"
    # 默认 → set-of-mark
    return "som"
```

| 场景 | 推荐 |
| ---- | ---- |
| 表单密集（DOM 良好） | DOM |
| 电商列表 / 商品详情 | set-of-mark |
| 视觉编辑器（Figma、Canva） | Vision |
| 已知熟悉网站 | DOM + 缓存的 selector |
| 全新陌生网站 | set-of-mark 探索 |
| 移动端模拟 | Vision（移动控件视觉差异大） |

## 5. 双路径对比表（重要！）

| 维度 | Vision（纯像素） | DOM / A11y | Set-of-Mark | 路径切换 |
| ---- | --------------- | ---------- | ------------ | -------- |
| Grounding 精度 | ±10-30 px | 100%（用 selector） | 100% | — |
| 单步延迟 | 3-6s | 1-2s | 2-4s | — |
| 单步成本（Sonnet 4.5）| \$0.02-0.05 | \$0.005-0.01 | \$0.015-0.03 | — |
| Canvas / 自定义 | ✓ | ✗ | △（看 DOM 覆盖） | ✓ |
| 改版鲁棒 | ✓ | ✗ | △ | — |
| 实现复杂度 | 低 | 中 | 高 | 高 |
| 离线评测难度 | 高 | 低 | 中 | 中 |
| 适合长程任务 | ✗ | ✓ | ✓ | ✓ |

## 6. Browser Use 的混合实现解读

Browser Use（撰写时 v0.x）默认是 **set-of-mark + a11y 摘要 + 历史动作上下文**：

```
每轮发给 LLM：
- 系统 prompt（角色定义、规则）
- 任务描述
- 当前 URL
- 历史 thought / action 列表
- a11y 简化摘要（节点 id + role + text，~100-300 行）
- 当前标注截图
```

它的元素索引算法（简化）：

```python
def is_interactive(node):
    return (node.tag in {"a", "button", "input", "textarea", "select"}
            or node.attrs.get("role") in {"button", "link", "textbox"}
            or node.attrs.get("onclick")
            or node.attrs.get("tabindex"))

def collect_interactive(root):
    nodes = []
    for n in dfs(root):
        if is_interactive(n) and visible(n):
            nodes.append(n)
    return nodes
```

成功率（Browser Use 自报告，2025）：

- WebVoyager：~89%（GPT-4o）
- 真实陌生网站短任务：~70%
- 长任务（10+ 步）：~40-50%

## 7. 工程细节：标注后图像别太花

最初实现常常一张图被标 50+ 个红框，模型反而看不清。优化：

| 技巧 | 效果 |
| ---- | ---- |
| 只标"视觉醒目"的元素（面积 > 阈值） | 减干扰 |
| 标号位置避开按钮文字 | 不挡 |
| 同一行元素用 hint 错开 | 避重叠 |
| 大于 30 个元素时按"焦点区域"分组截图 | 多张小图比一张大图好 |
| 重要元素加放大缩略图（"detail view"） | 高 grounding 精度 |

```python
# 大页面分段标注（每屏只标可见部分）
async def annotate_by_viewport_segment(page):
    height = await page.evaluate("() => document.body.scrollHeight")
    viewport_h = (await page.viewport_size)["height"]
    images = []
    for offset in range(0, height, viewport_h):
        await page.evaluate(f"window.scrollTo(0, {offset})")
        await page.wait_for_timeout(300)
        png = await page.screenshot()
        annotated, index = await annotate_screenshot(page, png)
        images.append((offset, annotated, index))
    return images
```

## 8. set-of-mark 的失败模式

| 失败 | 原因 | 缓解 |
| ---- | ---- | ---- |
| 模型选了不存在的 id | 历史 prompt 残留旧 id | 每轮显式清单"当前可用 id: ..." |
| 同 id 在新 snapshot 指不同元素 | 重建索引顺序变 | 把 id 绑定到稳定的元素特征（hash of (tag, text, parent)） |
| 元素重叠 | bbox 重叠模型困惑 | 用 z-order 顶层元素覆盖底层 |
| 模型直接给坐标 | system prompt 没强约束 | function schema 把 id 设 required，禁掉 coordinate |
| 表单字段全部一样的 placeholder | name 不区分 | enrich：附近的 label 文本 |

## 9. 实战 prompt 片段

```
DOM 元素清单（仅可见可交互）：
[1] textbox "Email"
[2] textbox "Password" (type=password)
[3] checkbox "Remember me"
[4] button "Sign in"
[5] link "Forgot password?"
[6] link "Create account"

历史动作：
- step1: click[6] → 跳转到注册页（错误！）
- step2: goto(/login) → 回到登录

任务：用 alice@example.com / hunter2 登录。

请输出下一步 action（JSON）。
```

注意：**历史动作要带后果**——"click[6] → 跳转到注册页（错误）"比"click[6]"信息丰富得多。

## 常见坑

- **set-of-mark id 跨步骤不稳定**——每抓一次 snapshot，id 顺序变。务必把 id 当**临时引用**，模型每次都要看新清单。
- **标注覆盖元素文字**——号码画在按钮中心反而挡住按钮文字。号码放角上 + 半透明背景。
- **不裁剪不可见元素**——把 fold 下方的元素全部编号，模型常常去"点不存在的按钮"。
- **完全放弃 Vision 的"看图能力"**——模型选号是 grounding，但**理解页面状态**仍需要"看图"。别把截图压缩得太小。
- **跨页面切路径不平滑**——A 页面用 DOM、B 页面用 Vision，历史上下文格式不一致让模型困惑。统一抽象层（如 `Observation` 数据类）很重要。

## 下一步

- [06 · 元素定位与点击](./06-element-targeting.md) — id→实际 click 的稳健实现。
- [07 · 表单与交互](./07-forms-interaction.md) — 混合策略下的复杂控件。
- [08 · 多步任务](./08-multi-step-tasks.md) — 长任务里的状态管理。
- [`../multimodal/08-multimodal-agent.md`](../multimodal/08-multimodal-agent.md) — Vision Agent 通用框架。
