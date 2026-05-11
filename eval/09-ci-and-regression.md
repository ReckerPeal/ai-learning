# 09 · CI 与回归

> 评测不进 CI 就只是"想起来才跑一次"——**进了 CI 才能真正防住回退**。本章讲怎么把评测变成 PR 流程的强制环节。

## 1. 三层评测的不同节奏

不是所有评测都该跑在 CI 上——按耗时分层：

| 层 | 跑哪 | 跑多久 | 包含什么 |
|---|---|---|---|
| **Smoke / Mini** | 每次本地保存、PR 触发 | < 30 秒 | 20-50 条核心 case |
| **PR Gate** | PR 合并前 | < 5 分钟 | 100-300 条 + 关键守门指标 |
| **Nightly / Full** | 每晚 / 手动触发 | < 1 小时 | 全 golden + regression + stress |
| **Pre-release** | 上线前 | < 几小时 | 全套 + pairwise + adversarial |

每层都该有自己的"通过 / 不通过"标准。

## 2. PR Gate：核心环节

### 2.1 GitHub Actions 例子

```yaml
# .github/workflows/eval.yml
name: LLM Evaluation

on:
  pull_request:
    paths:
      - 'src/**'
      - 'prompts/**'
      - 'evals/**'

jobs:
  eval:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }

      - name: Install
        run: pip install -e . && pip install -r evals/requirements.txt

      - name: Run mini eval
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          LANGCHAIN_API_KEY: ${{ secrets.LANGCHAIN_API_KEY }}
          LANGCHAIN_TRACING_V2: "true"
          LANGCHAIN_PROJECT: "ci-eval-${{ github.event.pull_request.number }}"
        run: python evals/run.py --suite mini --commit ${{ github.sha }}

      - name: Compare with main
        run: python evals/compare.py \
              --base main \
              --candidate ${{ github.sha }} \
              --threshold-correctness 0.02 \
              --threshold-faithfulness 0.0
        # threshold-faithfulness 0.0 = 不允许下降

      - name: Comment on PR
        if: always()
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const report = fs.readFileSync('evals/report.md', 'utf8');
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: report,
            });
```

### 2.2 PR 上的报告

CI 自动在 PR 评论：

```markdown
## Eval Report (commit abc1234)

Compared with main (commit def5678)

|              | base  | candidate | diff   |
|--------------|-------|-----------|--------|
| correctness  | 0.78  | 0.83      | +0.05 ✅ |
| faithfulness | 0.91  | 0.91      | +0.00 ✅ |
| relevancy    | 0.85  | 0.87      | +0.02 ✅ |
| latency_p95  | 4.2s  | 4.5s      | +0.3s ⚠️ |
| cost / call  | $0.012| $0.014    | +$0.002 ⚠️ |

✅ Pass: all thresholds met.

[View detailed traces in LangSmith](https://smith.langchain.com/...)

### Top regressed cases (3)
1. "..." — fail (was pass)
2. "..." — score 0.4 (was 0.7)
...
```

——开发者一眼就知道这个 PR 该不该合。

## 3. DeepEval：最简单的 CI 接入

DeepEval 的 pytest 风格让 CI 配置极简：

```python
# tests/test_qa.py
import pytest
from deepeval import assert_test
from deepeval.metrics import AnswerRelevancyMetric, FaithfulnessMetric
from deepeval.test_case import LLMTestCase

@pytest.mark.parametrize("sample", load_golden_set())
def test_qa(sample):
    actual = my_chain.invoke(sample["question"])
    case = LLMTestCase(
        input=sample["question"],
        actual_output=actual["answer"],
        expected_output=sample["expected"],
        retrieval_context=actual["contexts"],
    )
    assert_test(case, [
        AnswerRelevancyMetric(threshold=0.7),
        FaithfulnessMetric(threshold=0.85),
    ])
```

CI 直接：

```yaml
- run: pytest tests/ --tb=short
```

DeepEval 失败时，pytest 报告里直接显示"是哪条 case 哪个指标没过"。

## 4. 测试分类与并行

200 条评测顺序跑要 5-10 分钟，**并行**降到 1-2 分钟：

```python
# pytest-xdist
pytest tests/ -n 8 --dist=loadfile
```

或者评测内部用 async：

```python
async def run_all():
    return await asyncio.gather(*[run_one(s) for s in samples])
```

注意 LLM API 速率限制——配 `asyncio.Semaphore(10)` 控并发。

## 5. 阈值策略

### 5.1 绝对阈值

```yaml
correctness:    >= 0.75
faithfulness:   >= 0.85
latency_p95:    <  10s
```

简单粗暴，但**新项目 baseline 都凑不到阈值**——只能持续放宽，没意义。

### 5.2 相对阈值（推荐）

不退步就行：

```python
# 与 main 比
def gate(base, candidate):
    return all([
        candidate["correctness"]  >= base["correctness"]  - 0.02,  # 允许 2% 抖动
        candidate["faithfulness"] >= base["faithfulness"] - 0.0,    # 不允许跌
        candidate["latency_p95"]  <= base["latency_p95"]  * 1.2,    # 不超 20%
    ])
```

### 5.3 守门 vs 主指标

```
主指标：要求**涨**才合并（或至少不退）
守门指标：要求**不退**（即使主指标涨也不能放）
```

主指标可以"统计偶尔抖动一下"宽容，守门必须严。

## 6. Flaky test 怎么办

LLM 评测**天生有抖动**。解法：

### 6.1 多次运行平均

```python
def stable_score(sample, n=3):
    return mean([run_eval(sample) for _ in range(n)])
```

成本翻 N 倍，但稳。

### 6.2 提高样本量

样本量大，单条抖动被平均掉：30 条 → 200 条，方差降到 1/√7 ≈ 1/2.6。

### 6.3 固定 random seed

```python
ChatOpenAI(model="gpt-4o", temperature=0, seed=42)
```

`seed` 让 OpenAI 给"近似确定"输出（不保证 100%，但大幅降抖）。Anthropic 没有 seed 但 t=0 已经够稳。

### 6.4 quarantine

明显 flaky 的 case **隔离**到单独 set，不计入 PR gate，只在 nightly 跑。每周 review，要么修要么删。

## 7. Nightly Full Eval

每晚跑一次完整评测，结果上报到 dashboard：

```yaml
# .github/workflows/nightly-eval.yml
on:
  schedule:
    - cron: '0 2 * * *'   # 每天凌晨 2 点

jobs:
  full-eval:
    timeout-minutes: 60
    steps:
      ...
      - run: python evals/run.py --suite full --commit ${{ github.sha }}
      - run: python evals/upload_to_dashboard.py
      - name: Slack notify on regression
        if: failure()
        run: ./scripts/notify-slack.sh
```

Dashboard（Grafana / 自建 / LangSmith）给团队看趋势：

```
correctness ━━━━━━━━━━━━━━━━━━━━━━━ 0.83 (+0.05 from last week)
faithfulness ━━━━━━━━━━━━━━━━━━━━━ 0.91
latency_p95  ━━━━━━━━━━━━━━━━━━━━━ 4.5s (+0.3s ⚠️)
```

主指标连续 3 天下跌 → 自动开 issue。

## 8. Regression Set 的特殊处理

Regression set 是历史失败案例的合集——理论上每条都该过：

```python
def regression_gate(scores):
    failed = [c for c in scores if c["score"] < 0.5]
    if failed:
        # 强制 fail 整个 CI；不能合并
        raise SystemExit(f"Regression: {len(failed)} historic bugs failed again")
```

不允许 regression 通过比"主指标涨 0.1"重要得多——**不让旧 bug 复发**是对用户最实在的承诺。

## 9. 多 Commit / 多分支对比

LangSmith 实验列表自动对每个 commit 留一份：

```python
evaluate(
    runner,
    data="golden-v1",
    experiment_prefix="rag",
    metadata={
        "commit": os.environ["GITHUB_SHA"],
        "pr": os.environ.get("PR_NUMBER"),
        "branch": os.environ["GITHUB_REF_NAME"],
    },
)
```

UI 直接出"PR 123 vs main vs 上周 release"对比表。Pairwise UI 也能 (commit_a, commit_b) 对比。

## 10. 评测速度优化

CI 加速 = 钱省 + 反馈快。常见招：

### 10.1 缓存

```python
import hashlib, json

def cache_key(sample, commit):
    return hashlib.sha256(f"{commit}:{json.dumps(sample, sort_keys=True)}".encode()).hexdigest()

cached = redis.get(cache_key(sample, prompt_commit))
if cached:
    return json.loads(cached)
```

只有 prompt / 链没改的部分能缓存——所以 key 要带 commit。

### 10.2 增量评测

只跑被影响到的样本：

```python
# 改了 retriever → 只跑 retrieval-related cases
changed_files = subprocess.check_output(["git", "diff", "--name-only", "main"]).decode().split()
if "src/retriever.py" in changed_files:
    suite = "retrieval"
```

### 10.3 跳过常通过 case

90 天内一直通过、没改过相关代码的 case → 移到 nightly 而非 PR：

```python
case.get("metadata", {}).get("last_failure")  # 距今 > 90 天 → mini set 跳过
```

## 11. 评测代码自身的版本

评测代码、数据集、评判 prompt 都是"代码"——必须 git 化：

```
project/
├── src/                  # 应用代码
├── evals/
│   ├── run.py            # 跑评测
│   ├── compare.py        # 对比
│   ├── datasets/
│   │   ├── golden-v1.jsonl
│   │   ├── regression.jsonl
│   │   └── stress.jsonl
│   ├── evaluators/
│   │   ├── correctness.py
│   │   └── faithfulness.py
│   └── CHANGELOG.md
```

每次评测代码变更也走 PR review——**评测自身要被信任**，否则 CI 数据不可信。

## 12. 一份完整 `evals/run.py` 样例

```python
import argparse, asyncio, json, os
from pathlib import Path
from datetime import datetime
from langsmith import Client
from langsmith.evaluation import evaluate, RunEvaluator

from src.chain import build_chain
from evals.evaluators import correctness, faithfulness, relevancy

SUITES = {
    "mini": "evals/datasets/golden-mini.jsonl",
    "full": "evals/datasets/golden-v1.jsonl",
    "regression": "evals/datasets/regression.jsonl",
}

def load(path):
    with open(path) as f:
        return [json.loads(line) for line in f]

async def main(suite: str, commit: str):
    samples = load(SUITES[suite])
    client = Client()

    chain = build_chain()

    def runner(inputs):
        return chain.invoke(inputs)

    results = evaluate(
        runner,
        data=lambda: ({"inputs": s["input"], "outputs": s["expected"]} for s in samples),
        evaluators=[correctness, faithfulness, relevancy],
        experiment_prefix=f"{suite}-{commit[:7]}",
        metadata={"commit": commit, "suite": suite, "ts": datetime.now().isoformat()},
        max_concurrency=10,
    )

    summary = {
        "suite": suite,
        "commit": commit,
        "scores": {m: results.aggregate_score(m) for m in ["correctness", "faithfulness", "relevancy"]},
    }

    Path("evals/last_run.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--suite", choices=SUITES, required=True)
    parser.add_argument("--commit", required=True)
    args = parser.parse_args()
    asyncio.run(main(args.suite, args.commit))
```

## 13. 常见坑

| 现象 | 原因 |
|---|---|
| CI 经常 timeout | 评测集太大；分 mini / full，PR 只跑 mini |
| 同样 PR 跑两次结果不同 | LLM 抖动；提高 N 次平均、固定 seed |
| OPENAI_API_KEY 频繁泄漏到 log | LangSmith 默认会记 prompt 和 outputs；敏感数据 hash 后传 |
| 速率限制（429） | 并发太高；加 `Semaphore` 限流；用专门 quota 的 key |
| Cost 飙升 | 每次 PR 都跑全集 + judge；用 mini set + 缓存 |
| 主分支 baseline 缺失 | 没有定期跑 main；nightly 必须保 main 的最新分数 |
| 评测代码改了但没体现到 metric | 没把 evaluator 版本号放进 metadata；改了认不出 |

## 14. 下一步

- [10 · 进阶](./10-advanced.md)：合成数据、对抗测试、EDD
- [08 · 在线评测](./08-online-and-ab.md)：CI 通过之后的事
