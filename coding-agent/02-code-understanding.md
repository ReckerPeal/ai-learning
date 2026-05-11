# 02 · 代码理解

LLM 能"看懂"代码，但只看懂一个文件——一旦跨文件、跨包、跨语言，**纯文本视角立刻爆炸**。Coding Agent 的第一道分水岭就是：**你怎么把代码喂给 LLM**。本章把代码理解的三种视角——文本 / 符号 / 图——讲清楚，给出工具选型和工程做法。

## 1. 三种视角

| 视角 | 单位 | 表达 | 工具 | 适合场景 |
| --- | --- | --- | --- | --- |
| 文本视角 | 字符 / 行 | 原始字符串 | grep、ripgrep | 最快、最不准 |
| 符号视角 | 函数 / 类 / 变量 | AST、tag | tree-sitter、ctags、ast-grep | 结构化检索、代码改写 |
| 图视角 | 调用 / 引用 / 类型关系 | call graph | LSP、language server、Sourcegraph | 影响分析、跨文件理解 |

**Coding Agent 实战配方**：三种叠加用，**不是选一个**。

- 用户问"这个函数哪里用到了" → 图视角（LSP `references`）。
- 用户问"找一下处理 token 的代码" → 文本 + 符号 + 嵌入（[03 章](./03-code-rag.md)）。
- 用户让"改 rename 这个变量" → 符号视角（AST 改写）+ 图视角（找所有引用）。

## 2. 文本视角：grep / ripgrep

最朴素，但**所有 Coding Agent 都离不开**。Cursor、Claude Code、Aider 内部都内置了 grep 工具。

| 工具 | 语言 | 速度 | 杀手锏 |
| --- | --- | --- | --- |
| `grep` | 任意 | 慢 | 系统自带 |
| `ripgrep` (rg) | 任意 | 极快 | gitignore 感知、并行 |
| `ast-grep` | 任意 | 中 | 语法感知（"找所有调用 foo() 的地方"） |
| `comby` | 任意 | 中 | 结构化模板替换 |

**为什么 grep 还活着**：LLM 写正则比写 AST 查询熟练得多，结果送回 LLM 二次过滤即可。**取舍**：

- 模糊语义（"找处理 auth 的逻辑"）→ 嵌入 / RAG。
- 精确字符串（"找所有 `from langchain.foo`"）→ ripgrep。
- 结构化模式（"所有 `if x is None: return`"）→ ast-grep。

## 3. AST 与 tree-sitter

[tree-sitter](https://tree-sitter.github.io/tree-sitter/) 是当前 Coding Agent **事实标准的解析器**。理由：

- 一套 API 解析 200+ 语言（Python、TS、Rust、Go、Java、C/C++、Lua…）。
- 增量解析（编辑一行不需要重新 parse 整个文件）。
- 容错（半成品代码也能 parse 出 AST）。
- C 实现，绑定齐全（Python、JS、Rust、Neovim 内置）。

下面是一个能跑的 Python 例子：用 tree-sitter 提取一个文件里**所有函数定义**，作为 RAG 的切分单位。

```python
"""
tree-sitter 提取 Python 文件的所有函数。
依赖：pip install tree_sitter tree_sitter_python
"""
import tree_sitter_python as tspython
from tree_sitter import Language, Parser

PY_LANGUAGE = Language(tspython.language())
parser = Parser(PY_LANGUAGE)

QUERY = PY_LANGUAGE.query(
    """
    (function_definition
      name: (identifier) @name
      body: (block) @body) @def
    """
)

def extract_functions(path: str) -> list[dict]:
    src = open(path, "rb").read()
    tree = parser.parse(src)
    out = []
    for node, cap in QUERY.captures(tree.root_node).items() if False else []:
        pass
    # tree-sitter 0.22+ API：返回 dict[name, list[Node]]
    caps = QUERY.captures(tree.root_node)
    for def_node in caps.get("def", []):
        name_node = next(
            (c for c in def_node.children if c.type == "identifier"), None
        )
        out.append({
            "name": src[name_node.start_byte:name_node.end_byte].decode() if name_node else "?",
            "start_line": def_node.start_point[0] + 1,
            "end_line":   def_node.end_point[0] + 1,
            "code":       src[def_node.start_byte:def_node.end_byte].decode(),
        })
    return out

if __name__ == "__main__":
    for fn in extract_functions(__file__):
        print(f"{fn['name']:20s} L{fn['start_line']}-L{fn['end_line']}")
```

**用得最多的查询**：

| 目的 | 节点类型（Python） |
| --- | --- |
| 函数定义 | `function_definition` |
| 类定义 | `class_definition` |
| import | `import_statement`、`import_from_statement` |
| 装饰器 | `decorator` |
| 调用 | `call` |
| docstring | 函数 body 的第一个 `expression_statement` 子节点 `string` |

每种语言节点名稍有差异，去 [tree-sitter playground](https://tree-sitter.github.io/tree-sitter/playground) 现查现用。

## 4. LSP：调用图与类型推断

tree-sitter 只看一个文件，**跨文件靠 LSP**（Language Server Protocol）。LSP 是 IDE 共用协议，每个语言一个 server：

| 语言 | 主流 server |
| --- | --- |
| Python | Pyright、Pylsp、Jedi |
| TS/JS | tsserver |
| Rust | rust-analyzer |
| Go | gopls |
| Java | jdtls |
| C/C++ | clangd |

LSP 的核心方法（Coding Agent 用得最多的几个）：

| 方法 | 作用 | Agent 用法 |
| --- | --- | --- |
| `textDocument/definition` | 跳定义 | 知道这个符号在哪定义 |
| `textDocument/references` | 找引用 | rename / 影响分析 |
| `textDocument/hover` | 类型与文档 | 给 LLM 类型上下文 |
| `textDocument/documentSymbol` | 文件结构 | 切分单位 |
| `workspace/symbol` | 项目级符号搜索 | 替代 ctags |
| `textDocument/diagnostics` | 错误/警告 | 改完代码自检 |

**工程提示**：直接跑 LSP 比较重，可以用 [`multilspy`](https://github.com/microsoft/multilspy) 这类封装，把多语言 LSP 统一到一个 Python API（微软为 SWE-agent 评测用的）。

## 5. ctags / ast-grep：轻量平替

不是每个项目都跑得起 LSP，**ctags + ast-grep 是 80% 用例的轻量替代**：

| 工具 | 安装 | 输出 | 适用 |
| --- | --- | --- | --- |
| Universal Ctags | `brew install universal-ctags` | tags 文件，符号 → 文件:行 | 全语言、毫秒级 |
| ast-grep | `brew install ast-grep` | 模式匹配结果 | 跨语言重构 |
| comby | `brew install comby` | 模板替换 | 大规模 codemod |

ctags 一行命令生成全项目符号索引：

```bash
ctags -R --languages=python,typescript --fields=+ne -f .tags .
```

LLM 只要被告知"`.tags` 里有符号 → 文件:行 的映射"，就能精准定位。Aider 内置了 ctags 索引（叫 *repo map*），这是它在小项目上效果好的关键之一。

## 6. 嵌入 vs 符号：什么时候用哪个

| 检索意图 | 推荐手段 |
| --- | --- |
| "找处理用户登录的代码" | 语义嵌入（[03 章](./03-code-rag.md)） |
| "找 `LoginService` 类" | ctags / LSP `workspace/symbol` |
| "找所有调用 `db.execute` 的地方" | LSP `references` 或 ast-grep |
| "找所有 TODO" | ripgrep |
| "找跟 logging 相关的所有文件" | 文件名 + 嵌入混合 |
| "我刚改了 `Foo`，影响哪些文件" | LSP `references` 递归 |

**结论**：纯嵌入会漏掉精确符号查询，纯符号会漏掉模糊语义。**hybrid 才是工程答案**。

## 7. 跨文件理解：imports 与 references

跨文件是 Coding Agent 出错的重灾区。常见错误：

- LLM 修改了 `utils.py` 的函数签名，没改 5 个调用方 → 编译失败。
- LLM 重命名了 React 组件，没改 import 路径 → 运行时白屏。
- LLM 加了一个新模块，没在 `__init__.py` 导出 → 别人用不到。

**做法**（按可靠性排序）：

| 做法 | 可靠性 | 成本 |
| --- | --- | --- |
| 改完跑测试 | ★★★★★ | 高（要测试覆盖） |
| LSP `references` 全部一并改 | ★★★★ | 中 |
| 给 LLM 看所有 import 这个文件的地方 | ★★★ | 低（grep `from .utils import`） |
| 仅靠 LLM 的"上下文记忆" | ★ | 0（但极易失败） |

**Cursor 的做法**：在 prompt 里塞一段 *repository structure* + *相关文件 outline*，再让模型选择性展开。**Claude Code 的做法**：内置 `Read`、`Grep`、`Glob` 工具，让 LLM 自主搜索。两套思路都 work，但都建立在"能拿到符号关系"这一前提上。

## 8. 大型代码库的"摘要 + 索引"

代码库超过 5 万行后，**"全部塞进 prompt"完全不可能**。常见三层结构：

| 层 | 内容 | 大小 | 何时进 prompt |
| --- | --- | --- | --- |
| 顶层 | repo 总体 README + 目录树（深 2 层） | <5K token | 始终 |
| 文件层 | 每个文件 1–3 行摘要（LLM 预生成） | 100–500K token（不全进） | 通过文件名/语义检索后选 ~10 个 |
| 块层 | 函数 / 类（tree-sitter 切分） + 嵌入 | 1M+ token（不全进） | 检索后只塞 top-k |

**摘要怎么生成**（一次性预处理）：对每个文件跑一次 LLM，生成"这个文件做什么、导出什么、依赖什么"的 3 行摘要。增量索引看 git diff，只重算变化文件。

## 9. 工具清单速查

| 任务 | 工具 |
| --- | --- |
| 通用 parse | tree-sitter |
| 跨文件类型/引用 | LSP（multilspy / pyright / tsserver） |
| 符号索引 | Universal Ctags |
| 模式搜索 | ast-grep、comby |
| 文本搜索 | ripgrep |
| 调用图 | Sourcegraph（商用）、code2flow、pycallgraph |
| 大库语义检索 | 嵌入 + 向量库（[03 章](./03-code-rag.md)） |
| 文件结构可视化 | tokei、cloc |

## 常见坑

1. **只用 grep，不用 AST**：能搜到 `def foo`，搜不到"所有被装饰器装饰的函数"。AST 一行查询就能搞定。
2. **LSP 启动慢被忽略**：rust-analyzer / jdtls 第一次冷启动 30s+，Agent 用户以为卡死。**预热 + 后台保活**。
3. **跨语言 monorepo**：同一个仓库 TS+Python+Rust，需要并行跑多个 LSP。multilspy 是为这个场景设计的。
4. **代码摘要 staleness**：摘要预生成后，开发者 push 了新代码，摘要没更新。**git hook + 增量重算**是必须的。
5. **盲目嵌入整个仓库**：对 100 万行代码，嵌入索引要 GB 级存储，且**不会显著好过 ctags + grep**。先看 [03 章](./03-code-rag.md) 的"什么时候不需要 RAG"。
6. **AST 当成 ground truth**：tree-sitter 在语法错误代码上也能 parse，但**结果可能错**。LLM 改完一定 re-parse + 跑测试。

## 下一步

- 把"理解"接上"检索"——进入 [03 · Code RAG](./03-code-rag.md)。
- 看代码改写如何用上 AST 和 LSP——[04 · 代码生成](./04-code-generation.md) §3 的 SEARCH/REPLACE 块。
- 复习 Agent 怎么把这些"读代码"工具暴露出来——[../agents/04-tool-use.md](../agents/04-tool-use.md)。
- 想看商用大库工具，扫一遍 [Sourcegraph 文档](https://docs.sourcegraph.com/)（已被 Cody 收编）。
