# 06 · 代码审查 Agent

PR review 是 Coding Agent **最容易商业化、最有 ROI、出错代价最低**的子方向。每个 PR 都是天然的输入输出契约，且评论错了顶多被忽略，不会 `rm -rf`。本章把 review Agent 的输入输出、分级评论、产品化要点、与 GitHub/GitLab 集成、评测方法讲透，并对比 CodeRabbit / PR-Agent。

## 1. Review Agent 的核心任务

| 任务 | 输入 | 输出 |
| --- | --- | --- |
| 错误检测 | diff + 上下文 | "这里会 NPE" |
| 风格审查 | diff | "命名不一致" |
| 安全审查 | diff | "SQL 注入风险" |
| 性能审查 | diff | "N+1 查询" |
| 设计审查 | diff + design doc | "应该抽出接口" |
| 测试覆盖 | diff + 测试文件 | "缺单测" |
| 自动 summary | PR 全部 | 摘要 + 风险标签 |
| 自动批准 | 简单 PR | LGTM / Request changes |

**最小可用产品** = 错误检测 + 摘要。其它逐步加。

## 2. 输入：远不止 diff

只看 diff 的 review 等于"盲人摸象"。完整输入应当是：

| 输入 | 必要性 | 说明 |
| --- | --- | --- |
| diff | ★★★★★ | 改了什么 |
| 改动文件的完整内容 | ★★★★ | LLM 需要看上下文 |
| PR 标题 + 描述 | ★★★★ | 改的目的 |
| 关联 issue | ★★★ | 需求 |
| 历史评论 | ★★★ | 已讨论过的别再说 |
| 设计文档 / RFC | ★★ | 项目特定约束 |
| 测试文件 | ★★★★ | 看是否补了测 |
| CI 状态 | ★★★ | 已经红了别再分析 |
| 前一次 review 反馈 | ★★ | 增量审查不要重复 |
| repo 风格指南 | ★★ | `.cursor/rules`、CLAUDE.md |

**工程做法**：先把上述串成一段 prompt，再加一个**反思阶段**——"上面这些信息够吗？需要看哪些文件？"，让 LLM 主动 `read_file()` 拉更多上下文。这就是 [../rag-advanced/07-agentic-rag.md](../rag-advanced/07-agentic-rag.md) 在 review 场景的应用。

## 3. 输出：分级评论

**这是工程化关键。**评论必须分级，否则 nit 噪音会淹没真问题。

| 级别 | 阈值 | 例子 | 行动 |
| --- | --- | --- | --- |
| `critical` | 一定有 bug 或安全问题 | "NPE on line 42" | 阻塞合并 |
| `suggestion` | 高概率改进 | "用 enum 替代 string literal" | 建议 |
| `nit` | 风格 / 命名 | "拼写错误" | 可忽略 |
| `praise` | 正面反馈 | "good test coverage" | 0–1 条即可 |
| `question` | 不确定 | "为什么这里改成 sync？" | 不阻塞 |

**Cursor Bugbot / CodeRabbit 的策略**：默认只显示 critical + suggestion，nit 折叠。**用户可调阈值**。

## 4. 不要无意义评论（生死线）

工程界对 review bot 最大抱怨：**评论太多、太水、说废话**。比如：

| 反例 | 为什么烦 |
| --- | --- |
| "Consider adding a comment here" | 没有具体建议 |
| "This function is quite long, consider refactoring" | 笼统、没行动力 |
| "Please add tests" | 用户已经知道 |
| "Variable name could be more descriptive" | 不给替代名 |
| "Make sure to handle edge cases" | 没说哪个 edge case |

**对策**（真的有用）：

1. **Prompt 强约束**："不要给笼统建议；如果不能给出具体替代代码，就不要发评论。"
2. **后处理过滤**：长度 <40 字 + 不含代码块的评论自动丢弃。
3. **去重**：和历史评论 fuzzy match，重复的不发。
4. **Rate limit**：每个文件最多 3 条 critical + 5 条 suggestion。
5. **置信度阈值**：让 LLM 给每条评论打 1–5 confidence，<3 不发。

CodeRabbit / PR-Agent 都内置类似过滤层。**没有过滤层的 review bot 一周就被开发者关掉**。

## 5. 与 GitHub / GitLab 集成

最小集成路径（GitHub）：

| 方式 | 部署 | 触发 |
| --- | --- | --- |
| GitHub Action | YAML in repo | PR opened / synchronize |
| GitHub App | 平台级 | webhook |
| Bot account | GH user + token | webhook 或定时 |
| 内嵌 IDE（Cursor Bugbot）| IDE 插件 | 写代码时即时 review |

GitHub Action 最快上手，下面是个最小配置：

```yaml
# .github/workflows/review.yml
on:
  pull_request:
    types: [opened, synchronize]
jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install anthropic
      - run: python .github/scripts/review.py
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
```

`review.py` 最小骨架：

```python
"""
最小 PR review：拉 diff → LLM → 发评论。
"""
import os, json, subprocess, sys
from anthropic import Anthropic
import urllib.request

REPO = os.environ["GITHUB_REPOSITORY"]
PR = os.environ["PR_NUMBER"]
GH = os.environ["GH_TOKEN"]
client = Anthropic()

def gh(method: str, path: str, body=None):
    req = urllib.request.Request(
        f"https://api.github.com{path}",
        method=method,
        headers={
            "Authorization": f"Bearer {GH}",
            "Accept": "application/vnd.github+json",
        },
        data=json.dumps(body).encode() if body else None,
    )
    return json.loads(urllib.request.urlopen(req).read())

diff = subprocess.check_output(
    ["git", "diff", "origin/main...HEAD", "--unified=5"],
).decode()[:60_000]  # 截断

msg = client.messages.create(
    model="claude-opus-4-5",
    max_tokens=2048,
    system=(
        "You are a strict code reviewer. Output JSON list of comments. "
        "Each: {severity: critical|suggestion|nit, body: str, path: str, line: int}. "
        "Skip vague comments. If nothing serious, return []."
    ),
    messages=[{"role": "user", "content": f"DIFF:\n{diff}"}],
)
comments = json.loads(msg.content[0].text)

for c in comments:
    if c["severity"] == "nit":
        continue  # 过滤
    gh("POST", f"/repos/{REPO}/issues/{PR}/comments",
       {"body": f"**[{c['severity']}]** `{c['path']}:{c['line']}`\n\n{c['body']}"})
```

**生产改进项**：commit SHA hash 做幂等、增量 review（只看新 commit）、line-level 评论（用 `/pulls/:id/comments` API + commit_id + position）。

## 6. 复杂规则：硬编码 vs LLM

| 类型 | 推荐手段 |
| --- | --- |
| 风格（缩进、命名）| Linter（ESLint / Ruff），**不要让 LLM 做** |
| 已知反模式（`==` 比较 string）| Linter / Semgrep |
| SQL 注入、Path traversal | Semgrep / CodeQL |
| 业务规则（"调用 X 必须先调 Y"）| LLM（很难写规则） |
| 设计审查（"应抽接口"）| LLM |
| 文档同步 | LLM |
| 性能（N+1）| LLM + 数据库慢查询日志 |

**结论**：**Linter 能干的事不让 LLM 干**——便宜、确定、不会幻觉。LLM 只做规则写不出的判断。CodeRabbit 内部其实是"Semgrep + LLM"双层架构。

## 7. 评测：和人工 reviewer 的一致率

Review Agent 的评测和文本生成评测完全不同，看：

| 指标 | 怎么算 |
| --- | --- |
| Precision | LLM 提的评论里多少是有效的（人工 review）|
| Recall | 人工提的问题里 LLM 提到了多少 |
| Annoyance Rate | 用户标记 "not helpful" 的比例 |
| Merge Time Δ | 接入前后 PR 合并时间变化 |
| 回归率 | 接入后线上 bug 率变化 |

**实操**：积累 ~200 个历史 PR，每个 PR 把人工评论作为 ground truth。Agent 跑同样 PR，比对。**Precision 应该 >70%、annoyance <10%** 是上线门槛。

业界少有公开 benchmark，但有几个可参考：

- **CodeReviewer** dataset（微软）：~150 万 PR 评论。
- **SWE-bench review**：从 SWE-bench 提取的 review 任务（社区还在 wip）。
- 自家积累 dataset 永远是最有价值的。

## 8. 案例对比：CodeRabbit vs PR-Agent vs Cursor Bugbot

| 维度 | CodeRabbit | PR-Agent (Codium) | Cursor Bugbot |
| --- | --- | --- | --- |
| 部署形态 | GitHub App SaaS | 自托管 / SaaS | IDE 内 + GitHub |
| 触发 | PR 打开 / 推送 | 命令（`/review`、`/improve`、`/ask`）| 编辑时即时 |
| 评论粒度 | line-level + summary | line-level + 命令式 | 内联 + bug 标签 |
| 摘要 | 是 + 改动图 | 是（walkthrough）| 简短 |
| 学习项目风格 | 是（CLAUDE.md / .coderabbit.yaml）| 是（PR-Agent rules）| 是（.cursor/rules）|
| 价格 | $15/dev/月 | 开源 + 企业版 | 含在 Cursor Pro |
| 模型 | 多模型（GPT-4o / Claude 等）| 同上 | Anthropic 主 |
| 强项 | 审查质量稳定、运营成熟 | 命令式灵活、可自部署 | IDE 内即时 |
| 弱项 | nit 偏多（默认设置）| 需要团队学习命令 | 仅适合 Cursor 用户 |

## 9. 高阶能力（差异化）

| 能力 | 说明 |
| --- | --- |
| 自动修复（一键 commit fix）| 评论旁附 patch，点击采纳 |
| 多轮对话 review | 用户 reply → bot 跟进 |
| 跨 PR 知识 | 学这个 repo 的历史决策 |
| 安全规则定制 | `.coderabbit.yaml` / `.cursor/rules` |
| 多语言 review | 评论自动翻译（团队跨国）|
| Agent 模式 | 不是发评论，而是直接发 commit |

**警惕**：自动修复要保守——上来就 commit 容易破坏 PR 作者的 mental state。**默认 suggestion，确认后 apply**。

## 常见坑

1. **评论太多没人看**：上线一周就被 mute。**严格分级 + 默认折叠 nit**。
2. **没看 PR 描述就开喷**：作者写了"WIP, ignore tests"，bot 还在喊 "missing tests"。**先 parse 描述**。
3. **重复发评论**：每次推 commit 都重新 review，老评论原地复读。**diff 增量 + dedupe**。
4. **不看 CI 状态**：CI 已经标了 lint 错误，bot 又复述一遍。**先读 CI**。
5. **泄露代码 / 密钥**：内部仓库 review 调外部 LLM API → 合规事故。**自托管 LLM 或合规 API**。
6. **评论位置错**：发到错误行号让作者困惑。**用 GitHub API 的 line+side+commit_id 三元组**。
7. **不区分新代码 vs 老代码**：在作者没改的行上喊问题，作者很烦。**严格只 review diff 行**。
8. **批准过度宽松**："LGTM" 给一切 PR → bot 被嫌"没用"；过度严格 → bot 被嫌"卡流程"。**两档可调**。

## 下一步

- 看 review agent 怎么调试 / 修自家 bug → [07 · 调试 Agent](./07-debug.md)。
- 评测方法体系 → [../eval/](../eval/) 主题。
- Agentic 检索（拉更多上下文）→ [../rag-advanced/07-agentic-rag.md](../rag-advanced/07-agentic-rag.md)。
- 案例：CodeRabbit blog <https://www.coderabbit.ai/blog>、PR-Agent repo <https://github.com/Codium-ai/pr-agent>。
