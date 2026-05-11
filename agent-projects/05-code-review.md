# 05 · 项目4：代码审查 Agent

> **PR review 是 Coding Agent 商业化最稳的子赛道**（CodeRabbit、PR-Agent、Qodo 都在卷）。这章不重做 Cursor，做"挂在 GitHub Action 里、在 PR 上写评论"的轻量 reviewer——核心是**分级评论 + 避免 nit 噪音 + 误报率 < 5%**。

## 1. 业务背景与目标

| 维度 | 内容 |
| --- | --- |
| **业务价值** | 每个工程师每周节省 1–2 小时 review；新人 PR 通过率 +20% |
| **用户** | 团队 lead / 全员开发者 |
| **触发** | GitHub PR opened / synchronized → Action 调用 |
| **输出** | PR 评论（分 4 级）+ 总结报告 + 可选 suggestion patch |
| **失败成本** | nit 噪音 → 被 mute；漏报严重 bug → 信任崩塌 |
| **关键 SLA** | 中位 90s 内出 review，误报率 ≤ 5% |

**前 3 风险**：

1. nit 噪音淹没真信号 → 评论分级 + 阈值过滤
2. 误报安全漏洞引恐慌 → "high/critical" 评论必须双重确认（LLM-as-judge 二次）
3. 改 main 文件就全文重读 → 增量 diff + 上下文限定

参考 [`../coding-agent/06-code-review.md`](../coding-agent/06-code-review.md) 与 [`../coding-agent/10-case-study.md`](../coding-agent/10-case-study.md) §6。

## 2. 架构图

```
   ┌────────────────────┐
   │ GitHub PR Event    │  ◀─ opened / synchronize
   └─────────┬──────────┘
             ▼
   ┌────────────────────┐
   │ GitHub Action      │
   │  / Webhook handler │
   └─────────┬──────────┘
             ▼
   ┌────────────────────┐
   │ Fetch Diff + Meta  │  ◀─ files, lines, base, head
   └─────────┬──────────┘
             ▼
   ┌────────────────────┐
   │ Triage             │  ◀─ 跳过 lock / generated / vendored
   └─────────┬──────────┘
             ▼
   ┌────────────────────┐
   │ Per-file Reviewer  │  ◀─ 并发（最多 N=6）
   │ ┌────────────────┐ │
   │ │ Static (ruff)  │ │
   │ │ Security (bandit/sg)│
   │ │ LLM Reviewer   │ │
   │ └────────────────┘ │
   └─────────┬──────────┘
             ▼
   ┌────────────────────┐
   │ Aggregate + Grade  │  ◀─ 评论分级 critical/major/minor/nit
   └─────────┬──────────┘
             ▼
   ┌────────────────────┐
   │ Filter / Dedup     │  ◀─ nit 噪音过滤 + 与历史 PR 去重
   └─────────┬──────────┘
             ▼
   ┌────────────────────┐
   │ Self-check (judge) │  ◀─ critical 评论双 LLM 复核
   └─────────┬──────────┘
             ▼
   ┌────────────────────┐
   │ Post to GitHub PR  │  ◀─ inline + summary
   └────────────────────┘
```

## 3. 关键模块

### 3.1 目录结构

```
code-review-agent/
├── .github/workflows/review.yml
├── src/
│   ├── graph/
│   │   ├── state.py
│   │   ├── nodes/
│   │   │   ├── fetch.py
│   │   │   ├── triage.py
│   │   │   ├── static.py
│   │   │   ├── reviewer.py
│   │   │   ├── aggregator.py
│   │   │   ├── filter.py
│   │   │   ├── judge.py
│   │   │   └── poster.py
│   │   └── graph.py
│   ├── tools/
│   │   ├── ruff_runner.py
│   │   ├── bandit_runner.py
│   │   ├── ast_grep.py
│   │   └── gh_api.py
│   ├── prompts/
│   │   ├── reviewer.j2
│   │   └── judge.j2
│   └── config/
│       └── rules.yaml          # 团队定制规则
└── tests/eval/data/prs.json
```

### 3.2 评论分级

| 级别 | 含义 | 示例 | 默认行为 |
| --- | --- | --- | --- |
| **critical** | 安全 / 数据丢失 / 严重 bug | SQL 注入、忘 commit、密钥泄漏 | 必发 + judge 复核 |
| **major** | 逻辑错误 / 性能严重退化 | O(n²) 误用、空指针 | 默认发 |
| **minor** | 设计建议 / 易读性 | 函数太长、命名 | 阈值开关 |
| **nit** | 风格 / 格式 | 多余空行、注释 typo | 默认隐藏（[ruff](https://docs.astral.sh/ruff/) 已经管了）|

借鉴 CodeRabbit / PR-Agent 设计。

### 3.3 静态工具协同

| 工具 | 角色 |
| --- | --- |
| ruff / eslint / golangci-lint | 风格 + 简单 lint，不让 LLM 做这些 |
| bandit / semgrep | 安全规则，结果作为 LLM 的提示输入 |
| ast-grep | 项目级模式匹配（团队规则） |
| LLM | **只做** 高层逻辑 / 命名 / API 滥用 / 上下文相关 bug |

LLM 不要做 lint 干的事，参考 [`../coding-agent/02-code-understanding.md`](../coding-agent/02-code-understanding.md) §3。

## 4. 关键代码片段

### 4.1 状态定义

```python
# src/graph/state.py
from typing import Literal, TypedDict

Severity = Literal["critical", "major", "minor", "nit"]

class Comment(TypedDict):
    path: str
    line: int
    severity: Severity
    body: str
    rule_id: str | None      # 工具产出的规则编号
    source: Literal["static", "llm", "merged"]
    confidence: float

class ReviewState(TypedDict):
    repo: str
    pr_number: int
    base_sha: str
    head_sha: str
    files: list[dict]        # diff per file
    triage_skip: list[str]
    static_issues: list[Comment]
    llm_issues: list[Comment]
    final_comments: list[Comment]
    summary: str
    cost_usd: float
    posted: bool
```

### 4.2 Per-file LLM Reviewer

```python
# src/graph/nodes/reviewer.py
from langchain_openai import ChatOpenAI
from src.tools.gh_api import fetch_context

LLM = ChatOpenAI(model="gpt-4o", temperature=0)

REVIEWER_PROMPT = """你是高级代码审查者。

文件：{path}
DIFF（仅看变更行）：
{diff}

相关上下文（已包含被改函数的全文）：
{context}

团队规则：
{rules}

只指出**真问题**，按以下 schema 输出 JSON 数组：
[{{
  "line": int,
  "severity": "critical|major|minor|nit",
  "body": "...",
  "confidence": 0.0-1.0
}}]

禁止：
- 格式 / 命名风格（ruff 已经做了）
- 把"可以加注释"评为 critical
- 编造不存在的 API 名
- 重复其他文件的相同问题
"""

async def review_file(path: str, diff: str, rules: list[str]) -> list[Comment]:
    context = await fetch_context(path)
    resp = LLM.invoke(REVIEWER_PROMPT.format(
        path=path, diff=diff, context=context, rules="\n".join(rules),
    ))
    raw = json.loads(resp.content)
    return [
        {**c, "path": path, "source": "llm", "rule_id": None}
        for c in raw if c["confidence"] >= 0.6
    ]
```

### 4.3 Judge 节点（critical 复核）

```python
# src/graph/nodes/judge.py
JUDGE_PROMPT = """以下是一条 critical 级评论。请判断是否成立。

文件：{path}
变更 diff：
{diff}

评论：{body}

判断标准：
1. 评论描述的问题在 diff 中真实存在？
2. 严重性确实达到 critical（安全 / 数据丢失 / panic）？
3. 不是其他工具已经覆盖的 lint？

输出 JSON：{{"valid": bool, "reason": "..."}}
"""

def judge_node(state: ReviewState) -> dict:
    final = []
    for c in state["final_comments"]:
        if c["severity"] != "critical":
            final.append(c)
            continue
        ok = _judge_one(c, state["files"])
        if ok:
            final.append(c)
        else:
            # 降级为 major
            c["severity"] = "major"
            c["body"] = "[downgraded by judge] " + c["body"]
            final.append(c)
    return {"final_comments": final}
```

### 4.4 GitHub Action 配置

```yaml
# .github/workflows/review.yml
name: AI Review
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - run: pip install -e .
      - run: python -m src.cli review
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          REPO: ${{ github.repository }}
```

### 4.5 评测配置

```yaml
# tests/eval/config.yaml
dataset: tests/eval/data/prs.json   # 真实 PR 快照
metrics:
  - id: precision_critical
    type: code
    func: tests.eval.checks.precision_at_severity
    args: { severity: critical }
  - id: recall_seeded_bugs
    type: code
    func: tests.eval.checks.recall_seeded
  - id: nit_ratio
    type: code
    func: tests.eval.checks.nit_ratio
  - id: comments_per_pr
    type: trace_aggregate
ci:
  fail_under:
    precision_critical: 0.85
    recall_seeded_bugs: 0.70
    nit_ratio: 0.10              # nit 占比上限 10%
    comments_per_pr: 8           # 平均 < 8 条
```

## 5. 评测设计

### 5.1 数据集构造

| 类别 | 数量 | 来源 |
| --- | --- | --- |
| 真实历史 PR + reviewer 评论 | 30 | 团队历史 |
| Seeded bugs（人工注入）| 20 | 已知 bug 倒回前一版 |
| Clean PRs（无 bug） | 10 | 测试误报率 |
| 大 PR（>500 行） | 5 | 测延迟与上下文 |

### 5.2 指标

| 指标 | 通过线 | 备注 |
| --- | --- | --- |
| critical precision | ≥ 85% | 比 recall 优先 |
| seeded bug recall | ≥ 70% | 越高越好 |
| nit 占比 | ≤ 10% | 信号比噪音 |
| 中位评论数 / PR | ≤ 8 | 用户接受度阈值 |
| 中位时长 | ≤ 90s | DX 阈值 |
| 单 PR 成本 | ≤ $0.10 | |

参考 [`../coding-agent/06-code-review.md`](../coding-agent/06-code-review.md) §5。

## 6. 上线考虑

### 6.1 团队适配

| 维度 | 做法 |
| --- | --- |
| 语言栈 | 按 repo 配 reviewer profile（Python / Go / TS）|
| 团队规则 | `config/rules.yaml` 团队 lead 维护 |
| 严格度调档 | minor 默认隐藏；critical 必发 |
| 静音 | `.ai-reviewignore`（仿 .gitignore）|

### 6.2 与 CI 集成

| 触发 | 行为 |
| --- | --- |
| PR opened | 全量 review |
| synchronize（push 到 PR）| 增量 review（只看新 commit）|
| `/ai review` 评论 | 强制重跑 |
| `/ai resolve <id>` | 标记该评论已解决 |

### 6.3 误报反馈闭环

每条评论附 👍/👎 reaction，每日聚合：

```
nit_ratio_7d, dislikes_7d, regression_tests
```

下降则触发 prompt / 规则微调（CI 上的 [回归评测](../eval/09-ci-and-regression.md)）。

### 6.4 成本控制

- 文件大小 > 1k 行：仅看 diff，不拉全文
- 同一 PR 重跑：缓存 file_diff 的 review 结果（hash）
- gpt-4o-mini 做 nit/minor，gpt-4o 做 critical/major

## 7. Trade-off 讨论：LLM-only vs 静态工具 + LLM 混合

| 维度 | LLM-only | 混合（选） |
| --- | --- | --- |
| 风格 / lint | 易过拟合 | 静态工具稳 |
| 高层逻辑 | LLM 强 | 同 |
| 项目级模式 | 难（需大上下文） | ast-grep 精准 |
| 误报率 | 高 | 静态层兜底 |
| 成本 | 高 | 静态层免费 |
| 维护 | 改 prompt | prompt + 规则两套 |

混合比单 LLM 高出 15–20 pp 的 precision——CodeRabbit/PR-Agent 都是混合架构。

## 常见坑

1. **第一周评论太多被全员 mute**：上线先开"critical only"，逐周放开严格度。
2. **同一类问题刷屏**：30 行 diff 出 12 条相同提醒 → 节点级 dedup（按 rule_id + 文件聚类）。
3. **跨文件依赖看不到**：A 文件函数签名改了，B 文件没改用法 → 把 callers 上下文也拉进来。
4. **改 lockfile / 生成代码全文重读**：triage 节点跳过（`.lock`、`pb.go`、`*.generated.*`）。
5. **泄漏 secrets**：评论里贴出 diff 含密钥 → 评论前再过一遍密钥扫描。
6. **大 PR 直接超时**：>2k 行分批 review + 写"PR 太大，建议拆分"。
7. **建议 patch 不能 apply**：suggestion block 行号偏移 → 实测能 apply 才发。
8. **新人项目反复出现同模式**：每月聚合 → 写成 team rule，主动减少 LLM 重复劳动。

## 下一步

- 下个项目：[§06 数据分析助手](./06-data-assistant.md)（SQL + plot + 报告）
- 复习代码理解：[`../coding-agent/02-code-understanding.md`](../coding-agent/02-code-understanding.md)
- Code RAG：[`../coding-agent/03-code-rag.md`](../coding-agent/03-code-rag.md)
- 案例参考：[`../coding-agent/10-case-study.md`](../coding-agent/10-case-study.md)
- CI 回归：[`../eval/09-ci-and-regression.md`](../eval/09-ci-and-regression.md)
