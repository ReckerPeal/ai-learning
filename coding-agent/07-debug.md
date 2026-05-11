# 07 · 调试 Agent

调试是 Coding Agent 的**深水区**。代码生成可以"差不多就行"，调试要求**真定位 + 真修复 + 真验证**。本章给出输入提取、根因推理、工具协作、迭代策略、SWE-bench 风格评测、和"反例：硬改 / 隐藏问题"的清单。

## 1. 调试 Agent 的输入

| 输入 | 必要性 | 来源 |
| --- | --- | --- |
| 错误信息 / stack trace | ★★★★★ | 用户粘贴 / CI 日志 |
| 复现步骤 | ★★★★ | issue / 用户描述 |
| 失败的测试代码 | ★★★★ | pytest 输出 |
| 相关代码上下文 | ★★★★ | RAG / LSP / 跳定义 |
| 最近的 git diff | ★★★ | "上次能跑、这次坏了" |
| 运行时环境 | ★★★ | OS、版本、依赖 |
| 日志 | ★★ | 应用日志 |
| 性能 profile | ★★ | 性能 bug |

**第一步永远是把这些塞齐**——50% 的 debug 失败都是因为输入不全。

## 2. 推理：从错误链到根因

LLM 看 stack trace 比人快，但**LLM 容易抓表象不抓根因**。一个稳定的推理框架：

| 阶段 | LLM 任务 | 工具 |
| --- | --- | --- |
| 1. 解析 trace | 抽出报错文件、行、异常类型、链 | 文本处理 |
| 2. 定位入口 | 找最深 user code（去掉框架栈） | grep / read |
| 3. 形成假设 | 列 2–3 个可能根因 | 推理 |
| 4. 验证假设 | 读相关代码、跑小实验 | read / bash |
| 5. 修复 | 选最可能的，写 patch | edit |
| 6. 再跑测试 | 验证修复 | bash |
| 7. 迭代 | 失败 → 回 3 | 状态机 |

**关键差异点**：好的 debug agent 在 **3、4、6** 上花功夫；差的 debug agent 直接 1→5→提交。

## 3. 工具协作清单

| 工具 | 用途 |
| --- | --- |
| `read_file(path, line_range)` | 看 stack trace 涉及的代码 |
| `grep(pattern)` | 找其它调用方、相似 pattern |
| `git_blame(path, line)` | 这行谁/什么时候改的 |
| `git_log(path)` | 文件历史 |
| `bash(cmd)` | 跑测试、跑命令 |
| `bash(`pytest -x failed_test`)` | 单测复现 |
| `lsp_definition(symbol)` | 跳定义 |
| `lsp_references(symbol)` | 找所有调用 |
| `get_diagnostics(path)` | 编辑器报错 |
| `apply_patch(diff)` | 改代码 |

**Reflexion 模式**（看 [../agents/02-paradigms.md](../agents/02-paradigms.md)）：每次试错后让 LLM 写一段"failure note"，下次推理参考。在调试场景**显著提高成功率**。

## 4. 迭代策略：patch → test → 再 patch

调试是天然的 ReAct 循环：

```text
LOOP:
  ANALYZE → PATCH → RUN_TEST
  if PASS: COMMIT, exit
  if FAIL with new error: ANALYZE → PATCH
  if FAIL with same error: REFLECT (上次 hypothesis 错了, 换思路)
```

**用 LangGraph 实现**（看 [../langgraph/04-control-flow.md](../langgraph/04-control-flow.md) 循环模式）：

```python
"""
最小调试 Agent 状态机骨架。
"""
from langgraph.graph import StateGraph, END
from typing import TypedDict
import subprocess

class S(TypedDict):
    error: str
    attempts: int
    patches: list[str]
    last_test_output: str
    done: bool

def analyze(state: S) -> S:
    # 调 LLM 分析 error，返回假设
    print(f"[analyze] attempt {state['attempts']}: {state['error'][:80]}")
    return state

def patch(state: S) -> S:
    # 调 LLM 写 SEARCH/REPLACE 块并应用
    state["patches"].append("...")
    return state

def run_tests(state: S) -> S:
    out = subprocess.run(
        ["pytest", "-x", "--tb=short"],
        capture_output=True, text=True, timeout=120,
    )
    state["last_test_output"] = out.stdout + out.stderr
    state["done"] = (out.returncode == 0)
    state["attempts"] += 1
    return state

def route(state: S) -> str:
    if state["done"]:
        return "end"
    if state["attempts"] >= 5:
        return "give_up"
    return "analyze"

g = StateGraph(S)
g.add_node("analyze", analyze)
g.add_node("patch", patch)
g.add_node("test", run_tests)
g.add_edge("analyze", "patch")
g.add_edge("patch", "test")
g.add_conditional_edges("test", route,
    {"analyze": "analyze", "end": END, "give_up": END})
g.set_entry_point("analyze")
app = g.compile()

if __name__ == "__main__":
    final = app.invoke({
        "error": "AssertionError in test_login",
        "attempts": 0,
        "patches": [],
        "last_test_output": "",
        "done": False,
    })
    print("done?", final["done"], "attempts:", final["attempts"])
```

**步数上限**很重要——失败 5 次还没过应当兜底（提示用户、回滚、退出）。SWE-agent 默认 ~50 步硬上限。

## 5. 长任务：让 Agent 自动跑测试验证

调试 agent 不是写完 patch 就交差，**必须自验证**。验证层级：

| 层 | 命令 | 速度 | 信号强度 |
| --- | --- | --- | --- |
| 语法 | `python -c "import x"` | <1s | 弱 |
| Lint | `ruff check`、`tsc --noEmit` | 1–5s | 中 |
| 单测（仅相关）| `pytest tests/test_foo.py` | 5–30s | 强 |
| 全量测试 | `pytest` | 1–10min | 最强 |
| Smoke / E2E | `playwright test` | 数分钟 | 最强 |

**策略**：先跑快的（lint），失败立刻 fix；快的过了再跑相关单测；都过了再跑全量。**逐级兜底**。

## 6. SWE-bench 风格评测

[SWE-bench](https://www.swebench.com/) 是 Coding Agent 调试能力的事实标准：

| Benchmark | 任务量 | 难度 | 备注 |
| --- | --- | --- | --- |
| SWE-bench (Full) | 2294 | 高 | 真实 GitHub issue → patch |
| SWE-bench Lite | 300 | 中 | 子集，机器友好 |
| SWE-bench Verified | 500 | 高 | OpenAI 人工筛选 |
| SWE-bench Multimodal | 619 | 高 | 含截图 |
| Multi-SWE-bench | 1632 | 高 | 多语言（Java/Go/Rust 等）|

**任务格式**：

```text
输入：repo + commit hash + issue 描述
输出：patch（unified diff）
评估：apply patch → 跑 hidden tests → 通过率
```

**SOTA 状态（2025 中）**：

- SWE-bench Verified pass rate ~70%（顶尖 agent + 强模型）。
- SWE-bench Lite ~55%。
- 一年前同样模型只有 30–40%——**进步飞快**。

**自家评测怎么搭**：

1. 从自家代码库选 30 个真实历史 bug fix PR。
2. 把"修复前的 commit"作为输入，"PR 描述"作为指令，"测试"作为 ground truth。
3. Agent 跑 → 看测试通过率。
4. 用同一个测试集对比不同 prompt / 模型 / 工具组合。

**Oracle 实验**：把"正确答案文件路径"直接塞 prompt（去掉检索难度），看 patching 能力上限。如果 oracle 也只有 60%，说明问题在生成而非检索；如果 oracle 90%、实测 50%，问题在检索（[03 章](./03-code-rag.md)）。

## 7. 与其它主题衔接

| 衔接点 | 章节 |
| --- | --- |
| Reflexion / ReAct 循环 | [../agents/02-paradigms.md](../agents/02-paradigms.md) |
| 任务分解 | [../agents/05-planning.md](../agents/05-planning.md) |
| 工具系统 | [../agents/04-tool-use.md](../agents/04-tool-use.md) |
| 状态机 | [../langgraph/04-control-flow.md](../langgraph/04-control-flow.md) |
| 检索影响修复正确率 | [03 · Code RAG](./03-code-rag.md) §9 |
| Diff 应用 | [04 · 代码生成](./04-code-generation.md) |
| 沙箱跑测试 | [05 · 沙箱](./05-sandbox.md) |
| 测试不存在 → 先生成 | [08 · 测试生成](./08-test-gen.md) |

## 8. "不要硬改 / 不要隐藏问题" 清单

LLM 的"作弊"倾向（**所有**做过 SWE-bench 的人都见过）：

| 反模式 | 例 | 怎么防 |
| --- | --- | --- |
| 注释掉失败测试 | `# def test_foo(): ...` | 禁用对测试目录的写权限 / diff review |
| 改测试断言以匹配 bug 行为 | `assert result == 5` 改成 `== 4` | 测试文件白名单 / 评估器对比测试改动 |
| `try: ... except: pass` 吞异常 | 错误改"不抛"了 | grep `except: pass` 拒绝合并 |
| 给函数 `return None` 把它废了 | 函数名还在但啥都不做 | code review + 跑下游测试 |
| 改环境变量绕过 | `if os.getenv("BUG"): skip` | review，禁条件分支引入 |
| 改 mock 让测试通过 | mock 数据撒谎 | mock 用例评测器单独检查 |
| 删掉问题代码而不修 | "这功能不需要" | diff review，删除超过 20 行触发人审 |

**核心防御**：**测试文件 read-only**（除非用户允许 agent 写新测试），diff 审计对**测试改动**特殊标红。SWE-bench 评估器明确禁止改测试目录。

## 9. 真实数据：什么样的 bug Agent 还修不好

按 SWE-bench Verified 失败案例统计（粗略）：

| 类别 | 占失败比 | 原因 |
| --- | --- | --- |
| 跨多文件 + 复杂依赖 | ~25% | 上下文窗口不够 / 检索失败 |
| 需要长链推理（>10 跳）| ~20% | 推理深度不足 |
| 隐式 spec（注释含糊）| ~15% | LLM 误解需求 |
| 性能 / 并发 bug | ~15% | LLM 没法跑 profile |
| 环境特定（特定 lib 版本）| ~10% | 沙箱环境不一致 |
| 测试本身有问题 | ~10% | 数据集噪声 |
| 其它 | ~5% | |

**对策方向**：增加上下文检索质量（[03](./03-code-rag.md)）、加 reasoning 步数、给 agent 跑 profile 工具、统一沙箱（[05](./05-sandbox.md)）。

## 常见坑

1. **不跑测试就提交 patch**：50% 的"修复"是错的。**跑测试是底线**。
2. **stack trace 截太短**：只看 5 行错过关键栈帧。**全部塞 LLM**。
3. **没 reflexion**：第二次第三次还在试同一思路。**显式 failure log**。
4. **步数无上限**：循环 50 步烧 $20 还没修对，应该早停。
5. **agent 改了测试**：最常见的"作弊"。**测试 read-only**。
6. **不看 git history**："上次能跑"是最大线索。`git log -p` / `git bisect` 的工具应该暴露。
7. **不分级日志**：所有 stdout 全塞 LLM，token 爆。**关键错误高亮、其余 tail**。
8. **过早 commit**：失败案例还推到分支造成混乱。**全程在临时分支 / stash，成功才 merge**。

## 下一步

- 没有测试 → 先生成测试 → [08 · 测试生成](./08-test-gen.md)。
- Refactor 后回归 → [09 · Refactor](./09-refactor.md)。
- 反思机制深读 → [../agents/02-paradigms.md](../agents/02-paradigms.md)（Reflexion 一节）。
- 多步规划 → [../agents/05-planning.md](../agents/05-planning.md)。
- SWE-bench 论文：<https://arxiv.org/abs/2310.06770>；SWE-agent：<https://arxiv.org/abs/2405.15793>。
