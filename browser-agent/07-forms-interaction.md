# 07 · 表单与交互：input / dropdown / 文件上传 / 拖拽

> 点 button 是 Browser Agent 的"简单题"，**填表单**才是真考验。各种自定义 dropdown、富文本编辑器、日期选择器、文件上传、拖拽排序——每一种都有自己的反人类 UX。本章给出 Playwright 下的稳健模板和混合策略下的"自然语言→实际操作"的解释器。

## 1. 表单元素分类

| 类型 | 标准 DOM | 常见自定义实现 | Agent 难度 |
| ---- | -------- | -------------- | --------- |
| 文本输入 | `<input>` / `<textarea>` | contenteditable div | 低 |
| 单选 / 复选 | `<input type=radio/checkbox>` | div + 图标 | 中 |
| Dropdown | `<select>` | combobox + ul + role=option | 高 |
| 日期 | `<input type=date>` | 自定义日历组件 | 高 |
| 文件上传 | `<input type=file>` | drop zone | 中-高 |
| 富文本 | — | TinyMCE / Quill / Slate | 极高 |
| 多步表单 | — | tab 切换 / stepper | 高（任务规划） |

**核心规律**：标准 HTML 控件 Playwright 直接好用；自定义控件要走"看见即操作"模式。

## 2. 普通文本输入：清空 + type vs fill

```python
# fill：直接设 value，触发 change 事件
await page.get_by_label("Email").fill("alice@example.com")

# type：逐字符按键，触发完整 keydown/keypress/keyup
await page.get_by_label("Email").type("alice@example.com", delay=30)

# 何时用 type？
# - 受 keydown 监听（搜索建议、自动补全触发）
# - 反爬服务监测"瞬时填值"
# - 富文本编辑器（fill 不工作）
```

清空再输入（避免追加）：

```python
loc = page.get_by_label("Email")
await loc.fill("")        # 清空
await loc.type("...")     # 再输入

# 或一步
await loc.fill("alice@...")  # fill 默认会先清空
```

**经验**：默认 `fill`，遇到"输入后建议不弹"或"反爬识别"再换 `type`。

## 3. Dropdown：原生 vs 自定义

### 3.1 原生 `<select>`

```python
# 按 value
await page.get_by_label("Country").select_option("US")
# 按显示文本
await page.get_by_label("Country").select_option(label="United States")
# 多选
await page.locator("#tags").select_option(["python", "agent"])
```

### 3.2 自定义 combobox（最常见）

模式：

```html
<div role="combobox" aria-expanded="false">
  <input placeholder="Select country" />
</div>
<ul role="listbox" hidden>
  <li role="option">United States</li>
  <li role="option">United Kingdom</li>
</ul>
```

操作流程：

```python
async def pick_combobox(page, label: str, value: str):
    # 1. 点开
    box = page.get_by_role("combobox", name=label)
    await box.click()
    # 2. 等下拉出现（listbox 变可见）
    listbox = page.get_by_role("listbox")
    await listbox.wait_for(state="visible", timeout=3000)
    # 3. 输入过滤（如果支持）
    await box.type(value, delay=20)
    await page.wait_for_timeout(300)
    # 4. 点匹配项
    await page.get_by_role("option", name=value).first.click()
```

如果是 set-of-mark 路径，第 1 步后**必须重抓标注**——新出现的 option 需要新 id。

### 3.3 React-Select / Mantine / shadcn 等 UI 库

这类组件通常 ARIA 完善，按 §3.2 套路就行。问题在于：

- 渲染到 portal（DOM 中位置在 body 末尾，与触发元素脱离父子关系）
- 虚拟滚动（一次只渲染可视项）

```python
# Portal 渲染的 dropdown 用全局 selector，别 chain
await page.click("text=Country dropdown")
await page.locator("[role=listbox] >> text=United States").click()

# 虚拟滚动场景：先 type 过滤再点
await page.locator("input[role=combobox]").type("United")
await page.locator("[role=option]").first.click()
```

## 4. 日期选择器

| 类型 | 处理 |
| ---- | ---- |
| 原生 `<input type="date">` | `await loc.fill("2026-05-11")` |
| 自定义日历 | 多步点击 |
| Range picker | 两次点击：起始 + 结束 |

自定义日历的稳健套路：

```python
async def pick_date(page, label: str, target_iso: str):
    # 1. 打开
    await page.get_by_label(label).click()
    cal = page.locator("[role=dialog] >> [aria-label*=Calendar]")
    await cal.wait_for(state="visible")

    # 2. 导航月份
    target_year, target_month, target_day = map(int, target_iso.split("-"))
    while True:
        title = await cal.locator("[aria-live=polite]").inner_text()
        # 解析 "May 2026"
        # ... 比较，决定 prev / next
        if matches(title, target_year, target_month):
            break
        await cal.get_by_role("button", name="Next month").click()

    # 3. 点日
    await cal.get_by_role("button", name=str(target_day)).click()
```

**Agent 建议**：日历交互让 LLM 用**自然语言推理**："要选 2026-05-11，当前显示 April 2026，应点 'Next month' 一次后再点 '11'。"——比写死循环更鲁棒。

## 5. 文件上传

### 5.1 标准 `<input type=file>`

```python
# Playwright 直接传文件路径
await page.set_input_files("input[type=file]", "/path/to/file.pdf")

# 多文件
await page.set_input_files("input[type=file]", ["/a.png", "/b.png"])

# 清空
await page.set_input_files("input[type=file]", [])
```

### 5.2 自定义 drop zone（无可见 input）

```python
# 触发"file chooser"事件
async with page.expect_file_chooser() as fc_info:
    await page.locator(".upload-zone").click()
fc = await fc_info.value
await fc.set_files("/path/to/file.pdf")
```

### 5.3 Agent 工具封装

```python
@tool
async def upload_file(selector: str, local_path: str) -> str:
    """上传本地文件到表单的 file input。

    selector: 触发 file chooser 的元素 selector（input 或 drop zone）
    local_path: 沙箱内可读的本地文件路径
    """
    try:
        async with page.expect_file_chooser(timeout=5000) as fc_info:
            await page.locator(selector).click()
        fc = await fc_info.value
        await fc.set_files(local_path)
        return f"uploaded {local_path}"
    except Exception:
        # fallback：直接对 input 设
        try:
            await page.set_input_files(selector, local_path)
            return f"uploaded {local_path} (via set_input_files)"
        except Exception as e:
            return f"Error: {e}"
```

**沙箱注意**：Agent 上传的文件路径必须在沙箱可读范围。从远程拉取再上传需要分两步——先 `download_to(...)`、再 `upload(...)`。

## 6. 拖拽：排序 / 看板 / 上传 / 滑块验证

拖拽的细节决定成败：

```python
# 简单拖拽
await page.locator(".card-1").drag_to(page.locator(".column-done"))

# 复杂场景：模拟人类
async def human_drag(page, src_locator, dst_locator):
    src = await src_locator.bounding_box()
    dst = await dst_locator.bounding_box()
    sx, sy = src["x"] + src["width"]/2, src["y"] + src["height"]/2
    dx, dy = dst["x"] + dst["width"]/2, dst["y"] + dst["height"]/2
    await page.mouse.move(sx, sy)
    await page.mouse.down()
    # 多步移动，每步 30ms
    steps = 30
    for i in range(1, steps + 1):
        await page.mouse.move(
            sx + (dx - sx) * i / steps,
            sy + (dy - sy) * i / steps,
        )
        await page.wait_for_timeout(15)
    await page.mouse.up()
```

**滑块 CAPTCHA**：技术上能写出"模拟人类拖动"代码，但属于**绕过反爬措施**——见 [10](./10-safety-compliance.md) 的伦理讨论。

## 7. 富文本编辑器：最难的一类

Quill、Slate、Lexical、TinyMCE、ProseMirror——每个的 DOM 结构都不同，但有共性：

```html
<div contenteditable="true" role="textbox">...</div>
```

操作：

```python
# 找编辑区
editor = page.locator("[contenteditable=true]").first
await editor.click()  # focus

# 输入：必须用 type 不能 fill
await editor.type("Hello, **world**!", delay=20)

# 全选 + 替换
await page.keyboard.press("Control+A")  # mac 是 Meta+A
await page.keyboard.press("Delete")
await editor.type("new content")

# 应用格式：toolbar button + 选区
await editor.dblclick()  # 选词
await page.get_by_role("button", name="Bold").click()
```

**TinyMCE 在 iframe 里**——切 frame：

```python
frame = page.frame_locator("iframe#tinymce-editor_ifr")
body = frame.locator("body[contenteditable]")
await body.click()
await body.type("Hello")
```

Agent 经验：富文本场景**直接用 selector 路径**更可靠——Vision 路径在富文本里很难定位光标。

## 8. 多步表单 / Wizard

| 模式 | Agent 策略 |
| ---- | ---------- |
| 同页 stepper（tab 切换） | 每步填完点 Next，验证下一步出现 |
| 多页 wizard | 每页填完跳转 → 等新页加载 → 重抓 snapshot |
| 验证错误后回退 | 检测错误消息，定位错字段并重填 |

错误检测：

```python
async def detect_form_errors(page) -> list[str]:
    """收集所有可见的错误消息。"""
    return await page.evaluate("""() => {
        const errs = [...document.querySelectorAll(
            '[role=alert], .error, .field-error, [aria-invalid=true] + *'
        )];
        return errs
            .filter(e => e.offsetParent !== null)  // visible
            .map(e => (e.innerText || '').trim())
            .filter(Boolean);
    }""")
```

把错误消息回喂模型：

```
你刚提交了表单，收到以下错误：
- Email is invalid
- Password must be at least 8 characters

请重新填写出错的字段并再次提交。
```

## 9. 表单 Agent 的工具集合

整合本章内容的工具清单（fluent 命名见 [`../agents/04-tool-use.md §2.4`](../agents/04-tool-use.md)）：

```python
TOOLS = [
    "fill_input",         # 标准 input / textarea
    "type_text",          # 逐字按键（富文本、需触发监听）
    "select_option",      # 原生 select
    "pick_dropdown",      # 自定义 combobox
    "pick_date",          # 日历组件
    "upload_file",        # 文件上传
    "drag_to",            # 拖拽
    "check_checkbox",
    "click_radio",
    "press_key",          # Enter / Tab / Esc
    "submit_form",        # 提交并等结果
    "read_form_errors",   # 错误诊断
]
```

10-12 个工具是 Browser Agent 表单子任务的甜蜜点——少了不够用，多了模型挑花眼。

## 常见坑

- **fill vs type 混用**——富文本和受 keydown 监听的搜索框必须 type，普通 input 应该 fill。错用会"输完无反应"。
- **dropdown 点开后没等 listbox 渲染**——直接点 option 找不到。`wait_for(state="visible")` 是基本动作。
- **文件上传等待 input 出现**——很多 SaaS 站点点 "Upload" 才动态注入 input。`expect_file_chooser` 比硬找 selector 稳。
- **拖拽用一步 `move`**——很多 drag-drop UI 监听 mousemove 数量，瞬移不触发。至少 15-30 步。
- **不读错误消息**——表单失败 Agent 茫然重试。`detect_form_errors` 让模型知道"哪里错了"，成功率显著上升。

## 下一步

- [08 · 多步任务](./08-multi-step-tasks.md) — 把表单串成"完成订单"完整流程。
- [09 · 错误恢复](./09-error-recovery.md) — 表单失败、字段消失等的恢复模式。
- [`../agents/05-planning.md`](../agents/05-planning.md) — 多步流程的规划与状态管理。
- [`../agents/04-tool-use.md`](../agents/04-tool-use.md) — 工具设计原则。
