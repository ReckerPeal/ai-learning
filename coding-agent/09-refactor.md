# 09 · Refactor Agent

Refactor 是 Coding Agent 里**最容易被低估**的子方向——表面上只是"换个名字"，实际上跨文件依赖、API 兼容、行为不变性、回归测试每一项都比新功能还难。本章把 refactor 类型、静态工具 vs LLM 取舍、批量迁移流程、测试驱动 refactor、API migration 案例（LangChain 0.0.x → 0.3.x）一次讲透。

## 1. Refactor 类型分级

| 类型 | 难度 | 推荐手段 |
| --- | --- | --- |
| Rename 变量 / 函数 / 类 | ★ | LSP / IDE 重构（**不要**用 LLM）|
| 提取函数 / 内联 | ★★ | LSP + 测试 |
| 移动模块 | ★★ | 静态工具 + 修 imports |
| 提取接口 / 抽象 | ★★★ | LLM + 人审 |
| API 升级（破坏性）| ★★★★ | LLM + codemod + 全量测试 |
| 跨语言迁移（Python → TS）| ★★★★★ | LLM + 详尽对照测试 |
| 架构级重构（拆 service） | ★★★★★ | 多 PR、人主导、LLM 辅助 |

**核心法则**：**确定性能搞定的事不让 LLM 干**。LSP 的 rename 100% 准，LLM 的 rename 偶尔漏一处，**任何 1% 的漏洞都比 100% 的成本贵**。

## 2. 静态工具 vs LLM 选型

| 任务 | 静态工具 | LLM | 推荐 |
| --- | --- | --- | --- |
| Rename 跨文件 | LSP `prepareRename` | 文本替换 | LSP |
| 改函数签名 | LSP + 调用方修补 | 多文件改写 | LSP（rust-analyzer / pyright 都做得很好）|
| codemod 模板替换 | jscodeshift / comby / ast-grep | LLM | 静态工具 |
| 改语义（"用 generator 替代 list"）| 不擅长 | LLM | LLM |
| API 升级（参数顺序变）| 静态工具不会处理边界 | LLM | LLM + codemod 混合 |
| 拆模块（按职责分类）| 不能做 | LLM 可推理 | LLM |
| 改注释 / docstring 风格 | 不能做 | LLM | LLM |

**实战配方**：先用静态工具搞掉 80% 机械工作（rename、移动、import 修复），剩下 20% 真正需要"理解语义"的让 LLM 做。这是 Cursor / Cline / Aider 做大型 refactor 时的隐式策略。

## 3. 批量 Refactor 流程

针对几十、几百个文件的 refactor（API 升级、大重命名、拆包），**单次 prompt 完全不可能**。流程：

```text
1. INVENTORY     列出所有受影响文件
2. PLAN          每个文件一句"该怎么改"
3. PER-FILE LOOP  for f in files:
                     READ f
                     LLM 出 SEARCH/REPLACE
                     APPLY
                     RUN_LINT
                     fail → repair
4. CROSS-CHECK    跑全量测试
5. ROLLBACK_OR_COMMIT
```

| 阶段 | 主要动作 | 模型 |
| --- | --- | --- |
| Inventory | grep / ast-grep 搜索 pattern | 不需 LLM |
| Plan | LLM 列每文件改动 | 大模型 |
| Per-file | SEARCH/REPLACE | 中等 / 小 |
| Cross-check | 跑测试 | 不需 LLM |
| Repair | 修补 | 大模型 |

**并行化**：Per-file loop 内，**独立文件可以并行**（互不引用的两个文件 LLM 可以同时改）。Cursor、Cline 都做了文件级并行。

## 4. 测试驱动 Refactor

行为不变是 refactor 的**第一律**。最稳的做法：

```text
1. 现状测试通过吗？  不通过 → 先修
2. 测试覆盖足够吗？  不够 → 让 [08 章](./08-test-gen.md) Agent 先补测
3. 跑一次测试，记录结果（baseline）
4. Refactor
5. 再跑测试，必须和 baseline 一致
6. 不一致 → 回滚或修复
```

**关键工具**：

| 工具 | 用途 |
| --- | --- |
| Approval testing / characterization tests | 锁定老行为 |
| Snapshot testing | 输出 diff 比对 |
| Property-based testing | 不变式不变 |
| Mutation testing | 看测试是否真覆盖（[08 章](./08-test-gen.md) §6）|
| Coverage diff | refactor 前后覆盖不能降 |

## 5. 跨文件依赖处理

Refactor 的爆雷区是**忘了改 import / 调用方 / 注释**。检查清单：

| 检查项 | 工具 |
| --- | --- |
| 所有 import 改了 | grep `from old_path` / LSP |
| 所有调用方改了 | LSP `references` |
| docstring / 注释更新 | LLM |
| README / 文档更新 | LLM |
| changelog / migration guide | LLM |
| `__all__` / index export 更新 | grep |
| 字符串里的反射调用（`getattr` / 动态 import）| grep "old_name" |
| 配置文件（YAML、JSON）含路径 | grep |
| 测试 fixture 路径 | grep |

**反射调用**是最阴的——LLM 看不到，LSP 也看不到。**全文 grep 兜底**。

## 6. API Migration 案例：LangChain 0.0 → 0.3

LangChain 几次破坏性 API 升级是 refactor agent 的**真实压力测试**：

| 升级 | 涉及变化 | 难点 |
| --- | --- | --- |
| 0.0.x → 0.1 | 模块拆分（langchain → langchain-core / -community / -openai）| import 路径全变 |
| 0.1 → 0.2 | LCEL 普及，旧 chain 类弃用 | 编程范式变 |
| 0.2 → 0.3 | Pydantic v1 → v2 | 第三方依赖联动 |

**做法对比**：

| 做法 | 结果 |
| --- | --- |
| 纯文本替换 `langchain.chat_models` → `langchain_openai` | 60% 文件 OK，剩下因 reorganization 失败 |
| LangChain 官方 codemod（基于 libcst）| 90% 自动，剩下手工 |
| LLM 一把梭 | 25% 通过，幻觉 import |
| **LLM + codemod 混合**：codemod 跑机械替换，LLM 跑语义改造 | 95%+ 自动 |

**模板**（LangChain 官方 `langchain-cli` 的思路）：

```bash
# 1. 跑 codemod 处理 90% import 重排
langchain-cli migrate --diff path/to/repo
langchain-cli migrate path/to/repo

# 2. LLM 处理 LCEL 改造（chain → runnable）
agent rewrite-chains --target lcel path/to/repo

# 3. 跑测试
pytest tests/

# 4. 失败的让 agent debug-loop（[07 章](./07-debug.md)）
```

更多 LangChain 细节看 [../langchain/](../langchain/)。

## 7. 一段可运行：批量改 import

最朴素的批量 import migration（生产用 jscodeshift / libcst 写得更稳，这里给 LLM 控制流的雏形）：

```python
"""
批量 import 升级 agent 的最小骨架：
- 静态工具找出所有需要改的文件
- 简单 pattern 直接替换
- 复杂 case 调 LLM
"""
import subprocess, re
from pathlib import Path

OLD = "from langchain.chat_models import ChatOpenAI"
NEW = "from langchain_openai import ChatOpenAI"

def files_with(pattern: str) -> list[Path]:
    out = subprocess.check_output(
        ["rg", "-l", pattern, "--type", "py"], text=True,
    )
    return [Path(p) for p in out.splitlines() if p.strip()]

def simple_replace(p: Path) -> bool:
    src = p.read_text()
    if OLD in src:
        p.write_text(src.replace(OLD, NEW))
        return True
    return False

def main():
    targets = files_with(re.escape(OLD))
    print(f"found {len(targets)} files")
    for f in targets:
        if simple_replace(f):
            print(f"  patched {f}")
    # 检查 lint / mypy
    r = subprocess.run(["python", "-m", "ruff", "check"], capture_output=True, text=True)
    print(r.stdout[-2000:])
    # 失败的 → 这里接调 LLM 修

if __name__ == "__main__":
    main()
```

工业级版本要：commit 每文件一笔、跑测试、失败回滚、LLM 接管复杂 case。

## 8. 与其它主题衔接

| 衔接点 | 章节 |
| --- | --- |
| Plan-Execute 多文件 | [04 · 代码生成](./04-code-generation.md) §5、[../agents/05-planning.md](../agents/05-planning.md) |
| Reflexion 失败重试 | [07 · 调试](./07-debug.md)、[../agents/02-paradigms.md](../agents/02-paradigms.md) |
| 跨文件理解 | [02 · 代码理解](./02-code-understanding.md) §7 |
| 测试驱动 | [08 · 测试生成](./08-test-gen.md) |
| Sandbox 跑大批量 | [05 · 沙箱](./05-sandbox.md) |
| LangChain 升级背景 | [../langchain/](../langchain/) |

## 9. 何时**不**用 Refactor Agent

| 场景 | 理由 |
| --- | --- |
| 简单 rename 单仓库 | IDE 重构 5 秒搞定 |
| 没测试覆盖 | 风险高，先补测（[08 章](./08-test-gen.md)）|
| 涉及生产实时数据迁移 | 需要 DBA 流程，不是代码 refactor |
| 团队有强烈风格分歧 | 先达成 review checklist，不是写 agent |
| 改动量 <10 行 | 手工更快 |

## 常见坑

1. **没测试就 refactor**：行为变了都不知道。**先补测**。
2. **rename 用 LLM**：99% 行漏 1% 行就是事故。**用 LSP**。
3. **一次性几百个文件改动**：context 爆、错误叠乘。**串行 + 每文件验证**。
4. **忘了反射调用**：`getattr(module, "old_name")` LSP 看不见。**全文 grep**。
5. **不更新 docstring / 文档**：用户照着旧文档调，全错。**把 docs 也作为 refactor scope**。
6. **没 migration guide**：库的用户没法升级。**LLM 自动生成 release notes + migration steps**。
7. **改了 public API 没标 deprecation**：用户灰头土脸。**先 deprecate 一版，再删**。
8. **盲目跟 lint / formatter**：autofix 改风格但破坏行为（罕见但有）。**lint 改动也跑测试**。

## 下一步

- 把改动验证全自动 → [05 · 沙箱](./05-sandbox.md) + [08 · 测试生成](./08-test-gen.md)。
- 失败重试 → [07 · 调试](./07-debug.md) §4。
- 案例总结 → [10 · 案例剖析](./10-case-study.md)。
- 工具：jscodeshift、libcst、ast-grep、comby、langchain-cli migrate、`pyupgrade`。
