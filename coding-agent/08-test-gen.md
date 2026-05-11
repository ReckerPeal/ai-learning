# 08 · 测试生成 Agent

测试生成是 Coding Agent 里**最容易做"看起来 work、其实毫无价值"**的子方向。LLM 写测试很容易，但**容易写出"测当前实现"而非"测需求"的测试**——这种测试一改实现就全红，毫无回归保护价值。本章给出 Spec→Test、Code→Test 双路径、覆盖率引导、mutation testing 检验、与 Playwright/Pytest/Jest 集成，并讲清楚什么测试不该让 LLM 写。

## 1. Unit / Integration / E2E 全景

| 类型 | 范围 | 速度 | LLM 适合度 | 代表工具 |
| --- | --- | --- | --- | --- |
| Unit | 单函数/类 | 毫秒 | ★★★★★ | pytest、jest、go test |
| Integration | 跨模块/带 DB | 秒 | ★★★ | pytest + testcontainers、jest |
| E2E | 真实 UI / API | 数十秒 | ★★ | Playwright、Cypress |
| Property-based | 不变式 | 秒 | ★★★ | hypothesis、fast-check |
| Mutation | 测试质量 | 数分钟–小时 | n/a（用来评估）| mutmut、stryker |
| Snapshot | UI / 输出 | 秒 | ★★（易过拟合） | jest snapshot |

LLM 在 **Unit + Integration + Property-based** 上最有 ROI；E2E 模板化生成可以，但维护成本最高。

## 2. 两条生成路径

| 路径 | 输入 | 输出 | 风险 |
| --- | --- | --- | --- |
| Spec → Test（描述驱动）| 自然语言需求 / API doc | 测试 | 测试和实现都没写过——容易跑空 |
| Code → Test（已有代码反推）| 现有函数 | 测试 | LLM 把当前行为当 ground truth |

**生产里两条都用，但要明白差异**：

- **新功能开发**：Spec → Test（先写测，TDD），LLM 帮忙生成框架。
- **遗留代码补测**：Code → Test，但要**人审"这测试是不是测对了需求"**。
- **Bug 修复**：先写复现 bug 的测（让它失败），再修代码（[07 章](./07-debug.md)）。

## 3. Spec → Test 路径

输入是 PRD / API 文档 / 函数签名 + docstring，**注意：不要让 LLM 同时写实现和测试**——会出现"实现和测试互相欺骗"的死锁。

正确流程：

```text
1. 用户给 spec
2. LLM 仅生成测试（implementation 留空 / 抛 NotImplementedError）
3. 用户 / TL review 测试是否覆盖关键场景
4. LLM 写实现，跑测试，迭代
```

**Prompt 要点**：

- 强制 LLM 先列**测试场景表**（happy path / edge / error / boundary），再写代码。
- 强制每个测试给一行注释说"测的是什么"，便于 review。
- 显式禁止"测当前实现内部细节"的措辞。

## 4. Code → Test 路径

输入是已有函数，让 LLM 反推测试。**最容易翻车**的场景，因为：

- 当前实现可能本身有 bug。
- LLM 会照着实现写测试，bug 也被一起"测进去"。
- 实现一改，测试全红，开发者只好删测试。

**对策**：

| 对策 | 说明 |
| --- | --- |
| 让 LLM 先写"语义描述" | 写下"我认为这个函数应该做什么"，再据此写测试 |
| 给 docstring / 类型作为 spec | 没有 docstring 的，要求先补 |
| Mutation testing 验测试质量 | 见 §6 |
| Code review 着重看测试断言 | 而不是 covered 行数 |

最小可运行例：用 LLM 给单个函数生成测试。

```python
"""
Code → Test：把目标函数喂给 LLM，输出 pytest 文件。
依赖：pip install anthropic
"""
import inspect, textwrap
from anthropic import Anthropic
from pathlib import Path

client = Anthropic()

def gen_tests(target_func, out_path: str = "test_generated.py") -> None:
    src = textwrap.dedent(inspect.getsource(target_func))
    sig = inspect.signature(target_func)
    msg = client.messages.create(
        model="claude-opus-4-5",
        max_tokens=2048,
        system=(
            "You are a Python test author. Output ONLY a pytest file. "
            "Steps: (1) write a 1-paragraph spec for the function based on its name, "
            "signature, docstring; (2) list 5 test scenarios; (3) write pytest tests. "
            "Use parametrize. Cover happy path + edge cases + invalid input. "
            "DO NOT test private implementation details."
        ),
        messages=[{
            "role": "user",
            "content": f"FUNCTION:\n```python\n{src}\n```\nSIGNATURE: {sig}",
        }],
    )
    Path(out_path).write_text(msg.content[0].text)
    print(f"wrote {out_path}")

# 示例：
def parse_email(s: str) -> tuple[str, str]:
    """Split 'name@domain' into (name, domain). Raises ValueError on invalid."""
    if s.count("@") != 1:
        raise ValueError("invalid email")
    return tuple(s.split("@"))

if __name__ == "__main__":
    gen_tests(parse_email)
```

跑一下，pytest 文件出来后**人工 review**：检查"是不是真的测了需求语义"，而不是"测了字符串切分细节"。

## 5. 覆盖率引导

让 LLM 知道当前覆盖率不足在哪，**比纯靠 LLM 拍脑袋靠谱得多**：

| 工具 | 语言 | 输出 |
| --- | --- | --- |
| `coverage.py` | Python | 行级 / 分支级 |
| `c8` / `nyc` | JS/TS | 行级 |
| `cargo-llvm-cov` | Rust | 行级 |
| `gcov` | C/C++ | 行级 |
| `jacoco` | Java | 行级 |

**流程**：

```text
1. 跑现有测试 + 覆盖率工具 → 拿到 missing lines
2. 把"function X 第 12-19 行未覆盖"塞 LLM prompt
3. LLM 生成针对性新测试
4. 再跑覆盖率，迭代
```

**警告**：**覆盖率不等于测试质量**。100% 行覆盖也可以全是 `assert True`。**用 mutation testing 配合**。

## 6. Mutation Testing：检验测试质量

工具：`mutmut`（Python）、`stryker`（JS/TS/.NET）、`pitest`（Java）。原理：

```text
对每个语句做小变异（+ → -，> → >=，True → False），
跑测试集；如果变异后测试 *仍然通过*，说明测试没真覆盖到。
```

**Mutation Score** = 被测试杀死的变异数 / 总变异数。一般工业界 70%+ 算合格，**比行覆盖率更可信的指标**。

LLM 接进来：

| 阶段 | LLM 任务 |
| --- | --- |
| 跑 mutmut 拿存活变异 | 工具调用 |
| 给 LLM 看"这个变异没死，原因可能是测试没断言这点" | 推理 |
| LLM 补一条针对该变异的测试 | 生成 |
| 再跑 mutmut | 验证 |

mutation testing 慢（每个变异跑一次测试集），适合**夜间 CI** 而非每次 commit。

## 7. 工具集成

### Pytest（Python）

```python
# conftest.py 给 LLM 生成的测试加约束
import pytest

@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """LLM 生成测试可能误调网络，自动 mock。"""
    import socket
    def deny(*a, **kw): raise RuntimeError("no network in tests")
    monkeypatch.setattr(socket, "socket", deny)
```

### Jest / Vitest（JS/TS）

| 关键 | 说明 |
| --- | --- |
| `describe` + `it` 结构 | LLM 容易乱嵌套，强制 ESLint rule |
| `beforeEach` 重置状态 | 提示 LLM 加 |
| `mock` 模块 | 把外部依赖 mock 掉 |
| Snapshot 谨慎 | LLM 容易过度依赖快照，掩盖真实回归 |

### Playwright（E2E）

LLM 写 E2E 的杀招是**用 Codegen 录制 + LLM 重构成 page object**：

| 步骤 | 命令 / 操作 |
| --- | --- |
| 1. 录制 | `npx playwright codegen url` |
| 2. LLM 重构 | 把生成的脚本拆成 page object + 测试 |
| 3. LLM 加断言 | 录制只有动作，断言要补 |
| 4. 跑、稳定化 | flaky 修复（[../agents/](../agents/) 通用指南）|

## 8. 不让 LLM 写"对当前代码完美"的测试

**核心反模式**：LLM 把当前实现的所有内部状态都断言一遍，比如：

```python
def test_login_internal():
    svc = LoginService()
    user = svc.login("a@b.com", "pw")
    # 反模式：断言私有变量
    assert svc._cache == {"a@b.com": user}
    assert svc._last_attempt_at is not None
    assert svc._counter == 1
```

实现一重构，测试全红，但**实际行为没变**。这样的测试是**负资产**——比没测试更糟。

**防御**：

| 防御 | 实现 |
| --- | --- |
| Prompt 强制 | "Test public behavior only. Do not assert on private attributes (`_xxx`)." |
| Lint | 自定义 rule 禁止 `assert obj._` |
| Code review | 测试评审 checklist 加一条 |
| Mutation score | 价值低的测试 mutation score 也低，会被 surface 出来 |

## 9. 评测：测试生成 agent 怎么打分

| 指标 | 怎么算 |
| --- | --- |
| 编译 / 跑通率 | 生成的测试能否通过 syntax + import |
| 真实通过率（在已知正确实现上）| 跑 ground-truth 实现，看测试是否真的过 |
| 覆盖率提升 | 加上 LLM 测试后，行覆盖 / 分支覆盖增加多少 |
| Mutation kill rate | 杀死多少变异 |
| 误报率 | 在已知正确代码上，测试错误失败的概率 |
| 易读性 | 人工评分 1–5 |

**少有的公开数据集**：CodeContests、HumanEval-Test、TestEval（社区构建中）。自家场景**用历史 PR 里"加了测试的部分"做对照**最务实。

## 常见坑

1. **测试和实现一起生成**：互相欺骗。**先测后码**。
2. **断言私有状态**：实现重构即崩。**只测公共行为**。
3. **过度 mock**：`mock(everything)` 测的是 mock 不是代码。**只 mock 外部边界**。
4. **覆盖率当目标**：100% 行覆盖也可以全 `assert True`。**用 mutation 校正**。
5. **测试调网络 / 依赖外部环境**：CI flaky。**conftest autouse 拦截**。
6. **超长 parametrize 表**：LLM 列 50 个 case 难维护。**控制在 5–10 个有代表性的**。
7. **Snapshot 滥用**：`expect(html).toMatchSnapshot()` 一改就 update，没人 review。**少用、必要时人审 snapshot diff**。
8. **不跑测试就交付**：LLM 写完测试 syntax 错，直接 PR。**生成 → 跑 → 失败重写**循环必须有。

## 下一步

- 测试驱动 refactor → [09 · Refactor Agent](./09-refactor.md)。
- 用测试验证 debug 修复 → [07 · 调试 Agent](./07-debug.md)。
- 评测体系 → [../eval/](../eval/) 主题。
- Anthropic 工具用法 → [../agents/04-tool-use.md](../agents/04-tool-use.md)。
- 工具：pytest、Vitest、Playwright、mutmut、stryker；论文：*TestPilot*、*CodaMosa*。
