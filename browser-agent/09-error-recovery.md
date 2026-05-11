# 09 · 错误恢复：页面变化、登录失效、CAPTCHA、循环

> 测试脚本失败抛异常，Agent 失败必须**继续推理**——这是 Browser Agent 工程的本质区别。本章把"Agent 在浏览器里能遇到的错误"分类整理，每一类给出探测信号、恢复策略和不可恢复时的升级路径。

## 1. 错误分类

| 类别 | 例子 | 探测信号 | 是否可自动恢复 |
| ---- | ---- | -------- | -------------- |
| **元素找不到** | selector 失效 / 被遮挡 | 超时 | 多数可 |
| **页面卡住** | 加载永不完成 | wait 超时 | 部分可 |
| **登录失效** | 会话过期跳登录页 | URL / 关键元素 | 多数可 |
| **CAPTCHA** | reCAPTCHA / hCaptcha | iframe / class 特征 | 走 HITL |
| **限流 / 反爬** | 429 / 显示"too many requests" | 状态码 / 文案 | 暂停重试 |
| **结果不符预期** | 加购成功但购物车没增 | LLM 判定 | 重做该步 |
| **死循环** | 同 action 重复 | 行为签名 | 强制变招 |
| **跨域 / 跳转失败** | OAuth 回跳失败 | 期望 URL 未到达 | 等待 / 重启 |
| **模型幻觉** | 选了不存在的 id | 校验拒绝 | 重抓 snapshot |

## 2. 元素找不到：阶梯式重试

```python
async def find_with_fallback(page, candidates: list[str]) -> Locator | None:
    """按候选 selector 顺序尝试。"""
    for sel in candidates:
        try:
            loc = page.locator(sel).first
            await loc.wait_for(state="visible", timeout=1500)
            return loc
        except Exception:
            continue
    return None

# 用法
loc = await find_with_fallback(page, [
    'role=button[name="Submit"]',
    'button:has-text("Submit")',
    'text="Submit"',
    '[type=submit]',
])
if not loc:
    # 升级到 Vision 路径
    coord = await ask_vlm_for_coord(page, "the Submit button")
    if coord:
        await page.mouse.click(*coord)
```

阶梯：role > text > CSS > Vision——精度递降但覆盖递增。

## 3. 页面卡住：超时探测

```python
async def safe_navigate(page, url: str, max_wait: int = 15000):
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=max_wait)
    except Exception:
        # 部分加载已完成，能用就用
        pass

    # 看有没有"loading"元素仍在
    still_loading = await page.evaluate("""() => {
        return Array.from(document.querySelectorAll(
            '[role=progressbar], .spinner, .loading, [aria-busy=true]'
        )).filter(e => e.offsetParent !== null).length > 0;
    }""")
    if still_loading:
        # 再等一会
        await page.wait_for_timeout(3000)

    # 兜底：截图给模型决定
    state = await summarize_page_state(page)
    if state == "blank_or_error":
        return {"ok": False, "reason": "page_blank"}
    return {"ok": True}
```

## 4. 登录失效：自动检测 + 重登

模式：会话过期 → 任意操作 → 跳转登录页。Agent 应该**全局监听**：

```python
LOGIN_INDICATORS = [
    'input[type=password]',
    'text="Sign in"',
    'text="Log in"',
    '/login',  # URL 片段
]

async def is_logged_out(page) -> bool:
    url = page.url.lower()
    if any(p in url for p in ['/login', '/signin', '/auth']):
        return True
    for sel in LOGIN_INDICATORS[:-1]:
        if await page.locator(sel).count() > 0:
            return True
    return False

# 主循环每步开头检查
if await is_logged_out(page):
    await relogin(page, storage_state_path="state.json")
```

`relogin` 通常需要 HITL 走 2FA——参考 [`../langgraph/07-human-in-the-loop.md`](../langgraph/07-human-in-the-loop.md)。

## 5. CAPTCHA：检测 + 走人

| CAPTCHA 类型 | 检测 |
| ------------ | ---- |
| reCAPTCHA v2 (复选框) | `iframe[src*="recaptcha"]` |
| reCAPTCHA v3 (隐式) | 几乎不可见，看 401/403 + grecaptcha 全局 |
| hCaptcha | `iframe[src*="hcaptcha"]` |
| Cloudflare Turnstile | `iframe[src*="challenges.cloudflare.com"]` |
| 图片选择 / 拼图 | 视觉检测 |
| 滑块 | DOM 中常含 "slider", "verify" |

```python
async def detect_captcha(page) -> str | None:
    patterns = {
        "recaptcha": 'iframe[src*="recaptcha"]',
        "hcaptcha": 'iframe[src*="hcaptcha"]',
        "turnstile": 'iframe[src*="challenges.cloudflare"]',
    }
    for kind, sel in patterns.items():
        if await page.locator(sel).count() > 0:
            return kind
    # 文本兜底
    body_text = await page.locator("body").inner_text()
    if "verify you are human" in body_text.lower():
        return "generic"
    return None
```

**处理原则（重要！）**：

- **不要**让 Agent 自己"破解" CAPTCHA——这违反多数站点 TOS，详见 [10](./10-safety-compliance.md)。
- 探测到 CAPTCHA → **暂停 + HITL**，把控制权交给用户人工通过。
- 如果是企业内的"友军" CAPTCHA（自家测试环境），可绕过——但**显式声明**。

```python
if (kind := await detect_captcha(page)):
    await interrupt_for_human({
        "type": "captcha",
        "captcha_kind": kind,
        "instructions": "请手动完成验证。完成后回复 continue。",
        "screenshot": await page.screenshot(),
    })
```

## 6. 限流 / 反爬：退避

```python
RATE_LIMIT_INDICATORS = [
    "rate limit", "too many requests", "429",
    "请稍后再试", "访问过于频繁",
]

async def detect_rate_limit(page, response_status: int | None = None) -> bool:
    if response_status == 429:
        return True
    body = (await page.locator("body").inner_text()).lower()
    return any(p in body for p in RATE_LIMIT_INDICATORS)

# 指数退避
async def with_backoff(fn, max_retries=4):
    delay = 5
    for i in range(max_retries):
        result = await fn()
        if not result.get("rate_limited"):
            return result
        await asyncio.sleep(delay)
        delay *= 2
    return {"ok": False, "error": "rate_limited_giveup"}
```

被限频时**不要换 IP 重来**——这是猫鼠游戏的开端，见 [10](./10-safety-compliance.md)。正确做法是降速并尊重站点节奏。

## 7. 死循环检测

最阴险的失败：模型不停尝试同一动作。检测：

```python
def is_in_loop(history: list[dict], window: int = 5) -> bool:
    if len(history) < window:
        return False
    recent = history[-window:]
    sigs = [(h.get("action_type"), h.get("target")) for h in recent]
    # 同样的动作签名出现 ≥3 次
    if max(sigs.count(s) for s in set(sigs)) >= 3:
        return True
    # URL 长时间不变 + 动作多
    urls = [h.get("url") for h in recent]
    if len(set(urls)) == 1 and all(h.get("action_type") != "wait" for h in recent):
        return True
    return False
```

破解：

```python
if is_in_loop(history):
    # 1) 强制重抓 snapshot
    await page.reload()
    # 2) 在 prompt 里告知"你已重复同一操作 N 次，这次必须换思路"
    forced_prompt = (
        "你刚才连续 3 次尝试同一动作均失败。"
        "请考虑：1) 元素是否在当前视口外（试 scroll）"
        "2) 是否需要先关闭弹窗 3) selector 是否过期。"
        "本轮**禁止**重复上次动作。"
    )
```

## 8. 结果验证：每步必做

错误恢复的前提是**知道错了**。每步动作后做轻量验证：

```python
async def verify_step(step: dict, before_state: dict, after_state: dict) -> dict:
    """LLM 判断"这步达成目标了吗"。"""
    prompt = f"""
目标步骤: {step['description']}
执行动作: {step['action']}

执行前页面：URL={before_state['url']}, 关键元素={before_state['summary']}
执行后页面：URL={after_state['url']}, 关键元素={after_state['summary']}

请输出 JSON:
{{
  "ok": true | false,
  "reason": "...",
  "next": "continue" | "retry" | "skip" | "escalate"
}}
"""
    return await llm_json(prompt)
```

便宜模型（Haiku / mini）就够——验证不需要复杂推理。

## 9. 不可恢复时：升级 HITL

四种触发 HITL 的条件：

| 触发 | 例子 | 升级模式 |
| ---- | ---- | -------- |
| 钱 / 不可逆 | 提交订单、删除数据、转账 | 强制人工 |
| 安全 | CAPTCHA、2FA | 让人完成后续 |
| 反复失败 | 同步骤 3 次失败 | 让人看截图给指引 |
| 政策红线 | 检测到 PII 不应提交 | 中止任务 |

```python
async def escalate(state: dict, reason: str):
    user_decision = await interrupt({
        "reason": reason,
        "screenshot": await page.screenshot(),
        "history": state["history"][-5:],
        "options": ["continue", "skip", "abort", "give_instruction"],
    })
    return user_decision
```

详见 [`../langgraph/07-human-in-the-loop.md`](../langgraph/07-human-in-the-loop.md)。

## 10. 完整错误恢复 loop 骨架

```python
async def agent_with_recovery(task: str, max_steps: int = 30):
    history = []
    for step_i in range(max_steps):
        # 全局健康检查
        if await is_logged_out(page):
            await relogin(page)
        if kind := await detect_captcha(page):
            await escalate({"reason": f"captcha:{kind}"})
        if is_in_loop(history):
            await page.reload()
            history.append({"event": "loop_break_reload"})
            continue

        # 决定动作
        snap = await build_snapshot(page)
        action = await llm_decide(task, snap, history)
        before = await summarize_page_state(page)

        # 执行
        try:
            result = await dispatch_action(page, action)
        except Exception as e:
            history.append({"action": action, "error": str(e)})
            continue

        # 验证
        after = await summarize_page_state(page)
        check = await verify_step({"description": task, "action": action},
                                   before, after)
        history.append({"action": action, "result": result, "check": check})

        if check["next"] == "escalate":
            await escalate({"reason": "step_verification_failed",
                           "check": check})
        if check["ok"] and action.get("type") == "finish":
            return {"ok": True, "history": history}
    return {"ok": False, "history": history, "error": "max_steps"}
```

## 11. 错误恢复成功率：经验数字

某内部基准（200 个真实任务，含 30+ 步长任务）：

| 配置 | 端到端成功率 |
| ---- | ----------- |
| 基础 Agent（无恢复） | 35% |
| + 元素阶梯重试 | 52% |
| + 死循环检测 + 强制变招 | 60% |
| + 登录失效自动检测 | 67% |
| + 步骤验证（LLM 判断） | 72% |
| + HITL 升级（CAPTCHA / 钱） | 78% |

每一层恢复都贡献 5-15 个百分点——**这是从 demo 到产品的距离**。

## 常见坑

- **超时设太长**——15s 都没响应基本就是卡住了，再等 30s 也不会回来。短 timeout + 重试比长 timeout 更快。
- **死循环检测太严**——把正常的"连续 type 三个字段"也判成循环。签名要包含 action 参数。
- **CAPTCHA 自己破**——技术上能用 2captcha 之类，但很多场景违反 TOS 和法规（GDPR, CFAA）。**默认走 HITL**。
- **重试不变招**——三次同样动作三次失败是常态。**第二次起必须换 grounding 模式**（DOM → Vision、selector → OCR）。
- **验证用最强模型**——浪费。Haiku / 4o-mini 做"这步成了吗"够用，把推理预算留给主 Agent。

## 下一步

- [10 · 安全与合规](./10-safety-compliance.md) — TOS、PII、反爬伦理边界。
- [`../langgraph/07-human-in-the-loop.md`](../langgraph/07-human-in-the-loop.md) — HITL 实现。
- [`../agents/04-tool-use.md §5`](../agents/04-tool-use.md) — 工具错误恢复模式。
- [`../eval/07-agent-eval.md`](../eval/07-agent-eval.md) — 长任务评测。
