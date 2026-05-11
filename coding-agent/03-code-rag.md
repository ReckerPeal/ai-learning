# 03 · Code RAG

通用 RAG 在 [../rag-advanced/](../rag-advanced/) 里讲透了——**这一章只讲代码 RAG 跟文本 RAG 哪里不一样、不一样的地方该怎么做**。直接给结论：

> 代码 RAG ≠ 把代码当文本切了塞向量库。**切分单位、embedding 选型、检索源、增量索引**四个维度都得特化，否则效果只比 grep 好一点。

## 1. 跟文本 RAG 的差异速查

| 维度 | 文本 RAG | 代码 RAG |
| --- | --- | --- |
| 切分单位 | 段落 / 句子 / 固定 token | 函数 / 类 / 文件 / 符号块 |
| 切分工具 | LangChain TextSplitter | tree-sitter（[02 章](./02-code-understanding.md)） |
| Embedding | 通用模型（text-embedding-3） | code-specific 或多语言 code 模型 |
| 检索源 | 单一向量库 | 向量 + 符号 + 文件名 + git 历史 |
| 元数据 | 文档名、章节、时间 | 路径、语言、类型、git blame、tag |
| 更新频率 | 周/月 | 每次 commit |
| 索引规模 | 千–百万 chunk | 万–千万 chunk（每函数一条） |
| 评测 | 答案正确性 | 检索召回 + 下游编译/测试通过率 |

如果你 RAG 的概念还不熟，先看 [../rag-advanced/02-chunking.md](../rag-advanced/02-chunking.md)、[../rag-advanced/03-embeddings-and-stores.md](../rag-advanced/03-embeddings-and-stores.md)。

## 2. 切分：函数级 + 文件级 + 滑窗

**反例**：拿 1000 token 固定窗口切代码——会从函数中间切断，embedding 学到一半的逻辑，**毫无用处**。

**推荐方案**：三层切分，**全部入库**：

| 单位 | 来源 | token 量级 | 作用 |
| --- | --- | --- | --- |
| 函数 / 方法 | tree-sitter `function_definition` | 50–500 | 主力检索单元 |
| 类 | `class_definition` | 200–2000 | 想要类整体语义时召回 |
| 文件级摘要 | LLM 预生成的 3 行摘要 | 50–200 | 模糊查询、文件名查询 |

超长函数（>2K token）再用滑窗切一次，标记"这是 `foo()` 第 2/3 部分"。

**带上下文的 chunk**：每个 chunk 不仅是函数体，**头部加这几行元数据**：

```
# FILE: src/auth/login.py
# CLASS: LoginService
# IMPORTS: bcrypt, sqlalchemy, .models.User
# DOCSTRING: Handle email/password login with bcrypt.
def login(email: str, password: str) -> User | None:
    ...
```

这样 embedding 既学到代码本身，也学到上下文，**显著提升语义检索召回**（Aider 和 Cursor 都用类似做法）。

## 3. Embedding 模型选型

| 模型 | 维度 | 是否 code-specific | 备注 |
| --- | --- | --- | --- |
| OpenAI `text-embedding-3-large` | 3072 | 通用 | 代码够用，多语言 OK |
| Voyage `voyage-code-3` | 1024 | 是 | code 上 SOTA，企业用得多 |
| Jina `jina-embeddings-v2-code` | 768 | 是 | 开源、可自部署 |
| Cohere `embed-multilingual-v3` | 1024 | 通用 | 自然语言查询 → 代码效果好 |
| `bge-code-v1` / `nomic-embed-code` | 768/1024 | 是 | 开源 SOTA，可本地跑 |
| `microsoft/CodeBERT` | 768 | 是（旧） | 不推荐，2020 年模型已落后 |

**选型决策**：

- 有预算 + 多语言 → Voyage code 或 OpenAI 3-large。
- 必须自部署 → bge-code 或 nomic-embed-code。
- 大代码库（>百万 chunk）→ 注意 1024 维 vs 3072 维，存储和检索成本 3 倍差。

下面是一段可运行的 ingest 代码，把仓库切成函数级 chunk + embedding：

```python
"""
最小 Code RAG ingest：tree-sitter 切函数 → OpenAI embedding → SQLite。
依赖：pip install tree_sitter tree_sitter_python openai numpy
"""
import os, sqlite3, json, numpy as np
from pathlib import Path
import tree_sitter_python as tspython
from tree_sitter import Language, Parser
from openai import OpenAI

PY = Language(tspython.language())
parser = Parser(PY)
Q = PY.query("(function_definition name: (identifier) @n) @def")
client = OpenAI()

def chunks_from(path: Path):
    src = path.read_bytes()
    tree = parser.parse(src)
    caps = Q.captures(tree.root_node)
    for d in caps.get("def", []):
        code = src[d.start_byte:d.end_byte].decode("utf-8", errors="ignore")
        yield {
            "path": str(path),
            "start": d.start_point[0] + 1,
            "end":   d.end_point[0] + 1,
            "code":  code,
        }

def embed(text: str) -> list[float]:
    r = client.embeddings.create(model="text-embedding-3-small", input=text)
    return r.data[0].embedding

def build_index(repo: str, db_path: str = "code.db"):
    con = sqlite3.connect(db_path)
    con.execute(
        "CREATE TABLE IF NOT EXISTS chunks "
        "(path TEXT, start INT, end INT, code TEXT, vec BLOB)"
    )
    for f in Path(repo).rglob("*.py"):
        for ch in chunks_from(f):
            v = np.array(embed(ch["code"]), dtype="float32").tobytes()
            con.execute(
                "INSERT INTO chunks VALUES (?,?,?,?,?)",
                (ch["path"], ch["start"], ch["end"], ch["code"], v),
            )
    con.commit()

def search(query: str, db_path: str = "code.db", k: int = 5):
    q = np.array(embed(query), dtype="float32")
    con = sqlite3.connect(db_path)
    rows = con.execute("SELECT path,start,end,code,vec FROM chunks").fetchall()
    scored = []
    for path, s, e, code, vec in rows:
        v = np.frombuffer(vec, dtype="float32")
        sim = float(q @ v / (np.linalg.norm(q) * np.linalg.norm(v) + 1e-9))
        scored.append((sim, path, s, e, code))
    scored.sort(reverse=True)
    return scored[:k]

if __name__ == "__main__":
    build_index(".")
    for sim, path, s, e, code in search("how does login work"):
        print(f"{sim:.3f} {path}:{s}-{e}")
```

生产建议：用 [LanceDB](https://lancedb.com/) / Qdrant / pgvector 替换 SQLite + numpy 暴搜。

## 4. 元数据：让检索"分层"

代码 chunk 必带元数据：

| 字段 | 用途 |
| --- | --- |
| `path` | 路径过滤（"只在 `frontend/` 找"） |
| `language` | 语言过滤 |
| `kind` | function / class / module-summary |
| `signature` | 函数签名，常用作精确匹配 fallback |
| `imports` | 当前文件的 import 列表 |
| `git_blame_author` | 找"这块代码谁写的" |
| `last_commit_at` | 时间过滤、热度排序 |
| `test_file` | 关联测试路径（生成测试时用） |

元数据**不仅用于过滤，还用于排序**——同样语义匹配下，最近改的、被频繁引用的 chunk 优先。

## 5. 多检索源融合

单一向量检索召回率往往只有 60–70%，**融合多个信号**能拉到 85%+：

| 信号 | 实现 | 强项 |
| --- | --- | --- |
| 语义嵌入 | 向量库 | 模糊语义 |
| BM25 / 倒排 | Elasticsearch / Tantivy | 关键词、变量名 |
| 符号索引 | ctags / LSP `workspace/symbol` | 精确符号 |
| 文件名匹配 | fzf-style fuzzy match | "auth" → `auth.py` |
| Recent edits | git log | 用户最近改过的 |
| Open files | IDE 打开的 tab | 当前注意力 |

**融合方法**（按可靠性）：

| 方法 | 说明 |
| --- | --- |
| RRF（Reciprocal Rank Fusion）| 各路 rank 倒数求和，最朴素也最稳。看 [../rag-advanced/04-hybrid-retrieval.md](../rag-advanced/04-hybrid-retrieval.md) |
| LLM rerank | top-30 给 LLM 重排前 5。看 [../rag-advanced/06-reranking.md](../rag-advanced/06-reranking.md) |
| 学习排序（LTR）| 有标注数据时用，少见 |

**Cursor 的实战**：语义 + 文件名 + 最近编辑 + 打开 tab 四路融合，最后 LLM rerank。**Claude Code 的实战**：让 LLM 自己用 `Grep` + `Glob` + `Read` 工具迭代搜索（agentic retrieval，看 [../rag-advanced/07-agentic-rag.md](../rag-advanced/07-agentic-rag.md)）。

## 6. 增量索引：git diff 触发

代码每天都在变，**全量重新索引不可接受**。增量做法：

| 触发点 | 实现 |
| --- | --- |
| 文件保存（IDE） | 监听 `onDidSaveTextDocument`，单文件重算 |
| git commit | post-commit hook，diff 影响的文件重算 |
| CI 流水线 | merge 后自动重算并上传索引 |
| 用户主动 reindex | 兜底命令 |

**实操**：用 `git diff --name-only HEAD~1 HEAD` 拿到变化文件，只重算这些文件的 chunk。删除文件触发 chunk 删除。**索引带 commit hash** 作为版本，回滚时整体切回老索引。

## 7. 与 `../rag-advanced/` 的边界

| 通用 RAG（看 `../rag-advanced/`） | 代码 RAG 特化 |
| --- | --- |
| Chunking 通用策略 | tree-sitter 函数级切分 |
| Embedding 选型 | code-specific 模型 |
| Hybrid retrieval（向量 + BM25） | 加上 ctags / LSP 符号检索 |
| Reranking | 同样适用 |
| Multimodal | 代码 RAG 一般用不上（除非含截图 issue） |
| 评测 | 不仅看检索召回，还要看 **下游编译/测试通过率** |

如果你只想做"通用文档 + API 文档 + 代码 snippet"的混合 RAG，看 [../rag-advanced/08-multimodal-and-structured.md](../rag-advanced/08-multimodal-and-structured.md)。

## 8. 什么时候**不需要** Code RAG

不是所有 Coding Agent 都要 RAG。下面这些场景**用 RAG 反而拖慢且更差**：

| 场景 | 推荐手段 |
| --- | --- |
| 项目 <5 万行 | 直接把目录树和 `repo map` (ctags) 塞进 prompt（Aider 模式） |
| 单文件 inline edit | 当前文件 + open tabs 就够 |
| 用户给了明确路径 | 直接 read，跳过检索 |
| 改正报错 | 用 stack trace 精确定位（[07 章](./07-debug.md)） |

**结论**：RAG 是 **大库 + 模糊查询** 才有 ROI 的方案。小库直接上下文塞，明确目标直接 read，**RAG 是兜底而非默认**。

## 9. 评测

代码 RAG 的评测必须**两层**：

| 层 | 指标 | 怎么测 |
| --- | --- | --- |
| 检索层 | recall@k、MRR | 标注"这个 query 应该检索到这些 chunk" |
| 下游层 | 编译/测试通过率 | 完整跑 SWE-bench 或自家修复任务 |

只看 recall@k 容易**自欺**（召回了相关 chunk，但 LLM 没用上 → 修不出 bug）。具体看 [../eval/07-evaluation.md](../eval/) 系列（看 eval 主题对应章节）和 SWE-bench 的"oracle retrieval"对照实验。

## 常见坑

1. **固定 token 切分**：把函数切两半。一定用 tree-sitter 函数级切分。
2. **embedding 模型选错**：通用模型在变量名/语法关键字上召回差。换 code-specific 立刻提 5–10 个百分点。
3. **不带元数据**：检索结果出了一堆 `utils.py`，没法过滤。
4. **不更新索引**：用户改完代码，RAG 还在引用老版本——最让用户失望的体验。
5. **只用一种检索源**：纯向量漏关键词，纯关键词漏语义。**hybrid 是底线**。
6. **不评测下游**：检索分数高，agent 还是修不对 bug。一定加端到端 SWE-bench 风格评测（[07 章](./07-debug.md) §7）。
7. **巨大文件被全部跳过**：tree-sitter 解析失败的代码（语法错误、生成代码）会被静默跳过，要日志告警。

## 下一步

- 进入 [04 · 代码生成](./04-code-generation.md) 看检索到的 chunk 怎么变成 diff。
- 看 RAG 通用方法论：[../rag-advanced/02-chunking.md](../rag-advanced/02-chunking.md)、[../rag-advanced/04-hybrid-retrieval.md](../rag-advanced/04-hybrid-retrieval.md)、[../rag-advanced/07-agentic-rag.md](../rag-advanced/07-agentic-rag.md)。
- 把 RAG 接进 Agent 工具：[../agents/04-tool-use.md](../agents/04-tool-use.md)。
- 评测细节：[../eval/](../eval/) 主题 + [SWE-bench 论文](https://arxiv.org/abs/2310.06770)。
