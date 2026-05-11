# 04 · 代码生成（diff / 增量编辑）

让 LLM "写代码"很容易，**让 LLM 在已有大文件上精准改一处而不破坏其它地方**——是整个 Coding Agent 工程**最难的环节**，没有之一。本章把三种主流策略（全量重写 / SEARCH/REPLACE / fast apply）讲透，并给出工程级 diff 应用流程。

## 1. 三种策略对比

| 策略 | LLM 输出 | 文件大小上限 | 出错率 | 代表 |
| --- | --- | --- | --- | --- |
| 全量重写 | 整个新文件 | ~500 行（受 token 上限制约） | 低（结构完整）| Cursor `Cmd+K` 早期 |
| SEARCH/REPLACE 块 | 老片段 → 新片段 | 任意 | 中（fuzzy match 失败）| Aider 默认模式 |
| Unified diff | 标准 diff | 任意 | 高（行号易错）| 早期 GPT-4 实验 |
| Fast Apply（重写 + 小模型应用）| 注释式 diff | 任意 | 低 | Cursor / Claude Code 当前模式 |
| Tool-call 编辑 | `edit_file(path, old, new)` 或 `str_replace` | 任意 | 中 | Claude Computer Use、Anthropic str_replace_editor |

**结论**：

- 文件 <300 行 → **全量重写**，最稳。
- 文件 300–2000 行 → **SEARCH/REPLACE** 或 **str_replace** 工具调用。
- 大文件多处编辑 → **Fast Apply 模式**（大模型出"草稿 diff"，小快模型应用）。
- 不要让 LLM 直接写 unified diff 行号——**100% 翻车**。

## 2. SEARCH/REPLACE 块（Aider 风格）

最稳的工业方案，Aider 把它打磨到极致。LLM 输出格式：

```text
src/auth/login.py
<<<<<<< SEARCH
def login(email, password):
    user = User.find(email)
    if user.password == password:
        return user
=======
def login(email: str, password: str) -> User | None:
    user = User.find(email)
    if user and bcrypt.checkpw(password.encode(), user.password):
        return user
    return None
>>>>>>> REPLACE
```

**应用器伪代码**：

```python
def apply_search_replace(path: str, search: str, replace: str) -> bool:
    src = Path(path).read_text()
    if src.count(search) == 1:
        Path(path).write_text(src.replace(search, replace))
        return True
    if src.count(search) == 0:
        # fuzzy match：去掉首尾空白、忽略行内空白
        return fuzzy_apply(path, search, replace)
    raise ValueError(f"ambiguous: {search!r} appears multiple times")
```

**为什么有效**：

- LLM 不需要数行号。
- "唯一匹配"是天然的安全网（多匹配 = 拒绝 = 让 LLM 加更多上下文）。
- 失败可恢复（让 LLM 重写更长的 SEARCH 段）。

**Anthropic `str_replace_editor` 工具** 用了同款思路，已经是 Computer Use API 一部分。

## 3. Prompt 设计：让 LLM 输出可靠 diff

经验法则（顺序按重要性）：

| 规则 | 原因 |
| --- | --- |
| 给文件路径 + 完整内容（带行号） | 模型才知道改哪里 |
| 明确格式（"输出 SEARCH/REPLACE 块"）| 不然会输出 markdown 注释 |
| 强调 "SEARCH 必须**逐字符**匹配现有代码" | 否则 LLM 会简化 |
| 限制单次最多 3 个块 | 多了 LLM 会出错 |
| 输出后立刻 dry-run 应用，失败回写 LLM | 自我修复 |
| 改完跑测试 | 验证语义 |

最小可运行的 SEARCH/REPLACE 应用器：

```python
"""
最小 SEARCH/REPLACE 应用器：从 LLM 输出里解析块并应用到文件。
"""
import re
from pathlib import Path

BLOCK_RE = re.compile(
    r"^(?P<path>[^\n<]+)\n"
    r"<<<<<<< SEARCH\n(?P<search>.*?)\n"
    r"=======\n(?P<replace>.*?)\n"
    r">>>>>>> REPLACE",
    re.DOTALL | re.MULTILINE,
)

def parse_blocks(text: str) -> list[dict]:
    return [m.groupdict() for m in BLOCK_RE.finditer(text)]

def apply_block(blk: dict) -> tuple[bool, str]:
    p = Path(blk["path"].strip())
    if not p.exists():
        # 新建文件：SEARCH 必须为空
        if blk["search"].strip() == "":
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(blk["replace"])
            return True, f"created {p}"
        return False, f"missing file {p}"
    src = p.read_text()
    n = src.count(blk["search"])
    if n == 1:
        p.write_text(src.replace(blk["search"], blk["replace"]))
        return True, f"applied to {p}"
    return False, f"{n} matches in {p}"

def apply_all(llm_output: str) -> list[str]:
    logs = []
    for blk in parse_blocks(llm_output):
        ok, msg = apply_block(blk)
        logs.append(("OK" if ok else "FAIL") + ": " + msg)
    return logs

if __name__ == "__main__":
    sample = """src/example.py
<<<<<<< SEARCH
def hi():
    print("hi")
=======
def hi() -> None:
    \"\"\"Say hi.\"\"\"
    print("hi")
>>>>>>> REPLACE"""
    print("\n".join(apply_all(sample)))
```

加一层 **fuzzy match**：失败时去掉空白 / 注释再尝试一次；再失败让 LLM 重写更长的 SEARCH 段。Aider 的 `coders/editblock_coder.py` 是参考标准。

## 4. Fast Apply：大模型出意图，小模型落地

2024 年 Cursor 引入的优化模式，直接拉低成本和延迟一个数量级。

| 步骤 | 模型 | 输出 |
| --- | --- | --- |
| 1. 规划改动 | 大模型（Sonnet / GPT-4o） | 注释式 diff（含 `// ... existing code ...`）|
| 2. 应用到文件 | 小模型（Llama-3-70B-Speculative、Cursor 自训）| 完整新文件 |

**注释式 diff** 例：

```python
class LoginService:
    # ... existing code ...

    def login(self, email: str, password: str) -> User | None:
        user = User.find(email)
        if user and bcrypt.checkpw(password.encode(), user.password):
            return user
        return None

    # ... existing code ...
```

**优势**：

- 大模型只需输出"改什么、长啥样"，不操心其它代码。
- 小快模型擅长"把这段意图融进现有文件"，**速度快 5–10 倍**，**成本降 20 倍**。
- 用户体验：编辑像本地 IDE 一样秒级响应。

**前提**：需要一个调过的"applier"小模型；Cursor 自家训了一个，开源选项有 [FastApply](https://github.com/kortix-ai/fast-apply)。

## 5. 多文件编辑：Plan-Execute

单文件改完很简单，**多文件协调改动**——这是 Coding Agent 真正的 Hard Mode。

**反例**：让 LLM 一次性输出 5 个文件的 diff——上下文爆炸 + 出错率累乘。

**推荐流程**（与 [../agents/05-planning.md](../agents/05-planning.md) 衔接）：

```text
1. PLAN：LLM 列出"我打算改这 5 个文件，每个文件干什么"
2. CONFIRM（可选）：人类 review plan
3. EXECUTE：循环每个文件 → SEARCH/REPLACE → 应用 → 跑 lint
4. VERIFY：跑测试，全绿才 commit
5. REPAIR：失败 → LLM 看错误重新规划
```

LangGraph 实现这个状态机自然顺手——看 [../langgraph/04-control-flow.md](../langgraph/04-control-flow.md) 的循环模式。

| 阶段 | 模型选择 | 上下文 |
| --- | --- | --- |
| Plan | 大模型（推理强）| repo 摘要 + 用户 query |
| Execute（每文件）| 中等模型 | 当前文件 + plan 该文件 stub |
| Verify | 不调模型 | pytest / tsc / eslint |
| Repair | 大模型 | 错误 + 已改文件 |

## 6. 长文件的"上下文窗口"挑战

文件 5000+ 行时 token 吃紧，几招：

| 招式 | 说明 | 副作用 |
| --- | --- | --- |
| 只塞**与改动相关的函数**（用 [02 章](./02-code-understanding.md) AST）| 上下文压到 1/10 | 失去全文背景 |
| 文件 outline + 展开（双阶段）| 第一步给 outline，第二步展开需要的部分 | 多一次 LLM 调用 |
| Sliding window 编辑 | 只对窗口内做 SEARCH/REPLACE | 跨窗口改动需要协调 |
| Prompt caching | 长文件缓存，多次 query 摊薄成本 | 仅适用于 Anthropic / OpenAI |
| Fast Apply | 小模型才看全文 | 见 §4 |

**实战**：Cursor 在长文件上同时用 outline + Fast Apply。Claude Code 用 prompt caching + 工具调用让 LLM 自主 `Read(start, end)`。

## 7. 增量保存与回滚

LLM 改错代价高，**必须有快照机制**：

| 机制 | 实现 | 用户感知 |
| --- | --- | --- |
| 内存快照 | 改前存 `{path: original}` | 一键 undo |
| Git 自动 commit | 每轮 agent 改动一个 commit | `git reset --hard HEAD~1` |
| Stash 模式 | 改前 `git stash`，确认后 pop | 适合多文件改 |
| Checkpoint 分支 | 单独分支跑 agent，merge 时 review | Devin 风格 |

**Aider 默认模式**：每次 agent 编辑 → 自动 git commit，commit message 带 LLM 生成的描述。这是最优雅的做法——**让 git 成为 agent 的 undo 栈**。

## 8. 工具调用 vs 文本输出 diff

近年趋势：**让 LLM 用工具调用编辑文件**，而非输出文本 diff。

| 方式 | 例 | 优点 | 缺点 |
| --- | --- | --- | --- |
| 文本 SEARCH/REPLACE | Aider | 模型熟、易排错 | 需要后端 parser |
| Tool: `str_replace(path, old, new)` | Claude `str_replace_editor` | 结构化、易统计 | 单次只改一处 |
| Tool: `write_file(path, content)` | Claude / OpenAI | 简单 | 长文件不可用 |
| Tool: `apply_patch(diff)` | OpenHands | 标准化 | LLM 写 unified diff 仍易错 |

工具调用更好集成到 [../agents/04-tool-use.md](../agents/04-tool-use.md) 框架里，结构化日志也好做。

## 常见坑

1. **让 LLM 输出 unified diff（带 `@@ -10,5 +10,5 @@`）**：行号永远算错。**禁用**。
2. **SEARCH 段太短**：`def foo()` 在文件里出现 3 次 → 多匹配失败。规则：SEARCH 至少包含一行**唯一**上下文。
3. **不带文件路径**：LLM 输出多个块时混淆了文件归属。**每块前置路径**。
4. **改完不跑测试**：syntactically OK 不代表 semantically OK。**至少跑 lint + tsc/pylint**，最好跑测试（[07 章](./07-debug.md)）。
5. **多文件改动一把梭**：5 个文件并行让 LLM 改，错误叠乘。**串行 + 每步验证**。
6. **没快照**：改坏后用户找不到 undo。**git auto-commit 是底线**。
7. **CRLF / 末尾换行差异**：Windows 用户提交带 CRLF 的代码，LLM 输出 LF，SEARCH 永远匹配不上。**先标准化换行**。
8. **没限制 LLM 改 lock 文件 / 生成代码**：`package-lock.json` 几万行，LLM 一改就乱。**.aiderignore 或工具白名单**。

## 下一步

- 改完代码要执行验证 → [05 · 代码执行沙箱](./05-sandbox.md)。
- 多文件 plan 怎么写 → [../agents/05-planning.md](../agents/05-planning.md)。
- 改错怎么自我修复 → [07 · 调试 Agent](./07-debug.md)。
- 工具调用规范 → [../agents/04-tool-use.md](../agents/04-tool-use.md)。
- Aider 源码：<https://github.com/Aider-AI/aider/tree/main/aider/coders> 的 `editblock_coder.py` 是 SEARCH/REPLACE 的工业级实现。
