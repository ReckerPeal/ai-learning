# 02 · 浏览器自动化基础：为 Agent 优化的 Playwright

> Playwright / Selenium / Puppeteer 都是 2018 年前后定型的"测试工具"——它们解决的问题是"测试工程师写脚本"，不是"模型驱动浏览器"。把它们直接用于 Agent，会撞上一堆"测试场景里不存在的痛点"：异步页面、动态弹窗、长会话、反检测。本章给出 Agent 友好的初始化模板和工程模式。

## 1. 选型：Playwright / Selenium / Puppeteer

| 框架 | 主语言 | 浏览器内核 | 协议 | Agent 友好度 |
| ---- | ------ | ---------- | ---- | ----------- |
| **Playwright** | Python / Node / Java / .NET | Chromium / Firefox / WebKit | CDP（Chromium）/ 私有 | ⭐⭐⭐⭐⭐ |
| **Selenium** | 全语言 | 全浏览器 | WebDriver | ⭐⭐⭐ |
| **Puppeteer** | Node | Chromium / Firefox | CDP | ⭐⭐⭐⭐ |
| **CDP 裸调** | 全语言 | Chromium 系 | CDP（websocket） | ⭐⭐（灵活但繁琐） |

**结论**：Python 项目用 Playwright；Node 项目两可（Playwright 略胜）；要"纯 Chrome 极端控制"用 CDP。Selenium 现在主要是企业历史包袱。

下文示例统一用 Playwright Python。

## 2. headless vs headed：Agent 别选错

| 模式 | 反检测 | 速度 | 调试 | 适合 |
| ---- | ------ | ---- | ---- | ---- |
| `headless=False` | 好 | 慢 | 好（看得到） | 开发、托管沙箱 |
| `headless=True`（老版） | 差（特征明显） | 快 | 差 | 已废弃 |
| `headless="new"` / Playwright 默认 | 中 | 快 | 中 | 服务器跑批 |

Playwright 1.39+ 默认是新 headless，反检测显著改善。**但**——很多反爬服务（Cloudflare、Akamai、PerimeterX）能识别。生产里建议：

- 开发阶段：`headless=False`，肉眼看着调
- 部署阶段：用 **Browserbase / Steel** 这类托管服务（带住宅 IP + 真实 fingerprint）

## 3. 为 Agent 准备的浏览器初始化模板

```python
import asyncio
from playwright.async_api import async_playwright, Browser, BrowserContext, Page

DEFAULT_VIEWPORT = {"width": 1280, "height": 800}
DEFAULT_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

async def make_browser(headless: bool = False) -> tuple[Browser, BrowserContext, Page]:
    p = await async_playwright().start()
    browser = await p.chromium.launch(
        headless=headless,
        args=[
            "--disable-blink-features=AutomationControlled",
            "--disable-features=IsolateOrigins,site-per-process",
            "--no-sandbox",  # 容器内需要
        ],
    )
    context = await browser.new_context(
        viewport=DEFAULT_VIEWPORT,
        user_agent=DEFAULT_UA,
        locale="en-US",
        timezone_id="America/New_York",
        # 关键：避免页面通过 navigator.webdriver 识别
        bypass_csp=True,
    )
    # 移除 webdriver 标记（最低限度的反检测）
    await context.add_init_script("""
        Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
    """)
    page = await context.new_page()
    page.set_default_timeout(15_000)  # Agent 场景宜短，配合重试
    return browser, context, page
```

**关键设计点**：

- **viewport 固定**——Vision 路径的坐标系依赖它（见 [03](./03-vision-path.md)）。
- **timeout 短而显式**——Agent 不能等 30s，宁可失败让上层重试。
- **`add_init_script` 反检测**——基础动作，但绝非万能（见 [10](./10-safety-compliance.md)）。
- **`storage_state` 持久化**——长会话必备：

```python
# 首次登录后保存
await context.storage_state(path="state.json")

# 后续会话恢复
context = await browser.new_context(storage_state="state.json")
```

## 4. 三种基本操作的"Agent 安全"封装

测试代码常这样：

```javascript
// ❌ 测试风格：假设元素一定存在
await page.click('#submit');
await page.fill('#email', 'a@b.com');
```

Agent 跑真实网站时会**频繁失败**。建议封装：

```python
from playwright.async_api import Page, Locator, TimeoutError

async def safe_click(page: Page, selector: str, timeout: int = 5000) -> dict:
    """Agent 友好的 click：返回结构化结果而非抛异常。"""
    try:
        loc = page.locator(selector).first
        await loc.wait_for(state="visible", timeout=timeout)
        await loc.scroll_into_view_if_needed()
        await loc.click(timeout=timeout)
        return {"ok": True}
    except TimeoutError:
        return {"ok": False, "error": "timeout", "selector": selector}
    except Exception as e:
        return {"ok": False, "error": str(e), "selector": selector}

async def safe_fill(page: Page, selector: str, value: str) -> dict:
    try:
        loc = page.locator(selector).first
        await loc.wait_for(state="visible", timeout=5000)
        await loc.fill("")
        await loc.type(value, delay=30)  # 模拟人类输入
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}
```

参考 [`../agents/04-tool-use.md §2.5`](../agents/04-tool-use.md)——错误返回字符串不抛异常是 Agent 工具的铁律。

## 5. 等待策略：Agent 最容易踩的坑

测试场景常用 `wait_for_selector("...")`——但 Agent 不知道 selector。可用策略：

| 策略 | 用途 | 风险 |
| ---- | ---- | ---- |
| `page.wait_for_load_state("networkidle")` | 等所有请求停 | SPA 长轮询场景会永远等不到 |
| `page.wait_for_load_state("domcontentloaded")` | 等 DOM 树 | 可能未渲染完 |
| `page.wait_for_timeout(ms)` | 强制等待 | 简单但浪费 |
| `wait_for_selector` | 等特定元素 | 需要知道 selector |
| 视觉等待（截图差异） | Vision 路径用 | 实现复杂 |

**实战建议**：组合使用。Agent 每个动作后：

```python
async def settle(page: Page, max_ms: int = 3000):
    """点击后等页面"稳"。"""
    try:
        await page.wait_for_load_state("domcontentloaded", timeout=max_ms)
    except TimeoutError:
        pass
    # 再给一小段空闲时间让前端渲染
    await page.wait_for_timeout(300)
```

## 6. 多 tab、popup、iframe：现实网页的复杂面

真实场景：

```
用户点"登录" → 弹新 tab 进 OAuth 页 → 输入完毕跳回 → 关 tab
```

Agent 经常**漏看新 tab**或卡在 iframe 里：

```python
# 监听新 page（tab / popup）
context.on("page", lambda p: print("new page:", p.url))

# 显式等待新弹出
async with context.expect_page() as page_info:
    await page.click("text=Sign in with Google")
oauth_page = await page_info.value
await oauth_page.wait_for_load_state()

# iframe 处理（如 Stripe checkout）
frame = page.frame_locator("iframe[name='__privateStripeFrame123']")
await frame.locator("[name='cardnumber']").fill("4242424242424242")
```

**Shadow DOM**：Playwright 的 `locator` 默认能穿透 open shadow DOM，但 closed shadow DOM 拿不到——这是 Vision 路径的强项之一。

## 7. CDP 直连：解锁高级能力

Playwright 在 Chromium 上跑 CDP（Chrome DevTools Protocol）。直接 attach 能做：

```python
# 获取 a11y tree（accessibility 路径基础，见 §04）
client = await page.context.new_cdp_session(page)
tree = await client.send("Accessibility.getFullAXTree")

# 拦截网络（屏蔽广告、追踪器，省 token、加速）
await page.route("**/*", lambda route: (
    route.abort() if route.request.resource_type in ["image", "media", "font"]
                  and "captcha" not in route.request.url
    else route.continue_()
))

# 注入脚本到所有页面
await context.add_init_script(path="stealth.js")
```

**[puppeteer-extra-plugin-stealth](https://github.com/berstend/puppeteer-extra/tree/master/packages/puppeteer-extra-plugin-stealth)** 有针对 Playwright 的移植 `playwright-extra`——补一打反检测特征。重要但**绝非完整解决方案**。

## 8. 浏览器 / context / page 的关系

```
Browser（进程）
  ├── Context A（独立 cookies / storage / UA）
  │     ├── Page 1
  │     └── Page 2（同源共享 storage）
  └── Context B（完全独立账号）
        └── Page 1
```

Agent 设计经验：

- **每个用户 / 每个任务用独立 context**——cookie 不污染
- **Context 复用**——同账号的串行任务共用 context 省登录
- **多账号并行**——多 context，每个并发跑

```python
# 多账号并发模板
async def run_for_account(browser, state_file: str, task: str):
    ctx = await browser.new_context(storage_state=state_file)
    page = await ctx.new_page()
    try:
        await agent_loop(page, task)
    finally:
        await ctx.close()

await asyncio.gather(*[
    run_for_account(browser, f"account_{i}.json", task)
    for i in range(5)
])
```

## 9. 截图：Agent 的"眼睛"

```python
# 整页 / 视口 / 元素三种
full_png  = await page.screenshot(full_page=True)
view_png  = await page.screenshot()  # 默认只截视口
elem_png  = await page.locator("#cart").screenshot()

# 高 DPI 控制
view_png  = await page.screenshot(scale="css")  # 等同 viewport 像素
```

**Vision 路径关键**：

- **scale="css"**：保证坐标和视口像素一致——否则模型给出 `(640, 400)` 但你的页面是 1280×800 缩放 2x，点错位置。
- **full_page=True 慎用**——长页面截图几 MB，VLM token 爆。优先视口截图 + 分步 scroll。

## 10. 一个"裸 Playwright Agent"骨架

整合前面要点，先给个**不接 LLM**的纯结构骨架，下章再加 VLM：

```python
import asyncio

async def agent_loop(page, plan: list[dict]):
    """plan = [{"action": "click", "selector": "..."}, {"action": "fill", ...}]"""
    log = []
    for step in plan:
        action = step["action"]
        if action == "goto":
            await page.goto(step["url"])
            await settle(page)
        elif action == "click":
            r = await safe_click(page, step["selector"])
            log.append({"step": step, "result": r})
            if not r["ok"]:
                break
            await settle(page)
        elif action == "fill":
            r = await safe_fill(page, step["selector"], step["value"])
            log.append({"step": step, "result": r})
        elif action == "screenshot":
            png = await page.screenshot()
            log.append({"step": step, "result": {"bytes": len(png)}})
    return log
```

后续章节会把 `plan` 替换成模型实时生成、`safe_click` 改成"模型给坐标我点"。

## 常见坑

- **直接拿测试脚本改 Agent**——会被改版打回原形。Agent 不应该依赖**写死的 selector**。
- **viewport 不设固定值**——坐标系混乱。`launch` 时**必须**设 viewport，Vision 路径模型工具声明的 `display_width_px` 要一致。
- **每步都 full_page 截图**——token 爆。视口截图 + 滚动驱动覆盖。
- **headless=True 跑生产**——老 headless 太容易被识别；用新 headless 或托管浏览器。
- **不持久化 storage_state**——每次登录走 2FA，Agent 任务永远在登录阶段挣扎。

## 下一步

- [03 · Vision 路径](./03-vision-path.md) — 把截图喂 VLM。
- [04 · Accessibility 路径](./04-accessibility-path.md) — 用 DOM / a11y 树替代截图。
- [06 · 元素定位与点击](./06-element-targeting.md) — 把"模型说点这里"翻译成 Playwright 调用。
- [09 · 错误恢复](./09-error-recovery.md) — `safe_click` 失败后怎么办。
