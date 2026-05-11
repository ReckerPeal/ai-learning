# 05 · 评测框架对比

> 工具不重要，方法论重要——但选对工具能省 80% 的工程时间。本章把主流框架横向比较一遍。

## 1. 主流框架速查

| 框架 | 定位 | 核心强项 | 集成 | 部署 |
|---|---|---|---|---|
| **LangSmith** | 端到端 trace + eval 平台 | trace、数据集、版本对比、UI | LangChain/LangGraph 原生 | SaaS（自托管 enterprise） |
| **RAGAS** | RAG 专用指标库 | RAG 三件套指标 | LangChain 友好 | 库 |
| **DeepEval** | 单测风格的 LLM eval | pytest 集成、内置指标多 | 框架无关 | 库 |
| **promptfoo** | CLI / YAML 驱动的 prompt 评测 | 简单、版本对比、CI 友好 | 框架无关 | CLI / 库 |
| **Braintrust** | 类似 LangSmith 的 SaaS | UI 强、多框架支持 | 框架无关 | SaaS |
| **OpenAI Evals** | OpenAI 的开源框架 | 学术 benchmark 风格 | OpenAI 中心 | 库 |
| **TruLens** | 专注 RAG / Agent | 透明可解释 | 框架无关 | 库 |
| **Phoenix（Arize AI）** | 观测 + eval | trace、漂移监控 | 框架无关 | SaaS / 自托管 |

## 2. 选型矩阵

按你的需求选：

```
你的栈 / 需求
├── 用 LangChain / LangGraph
│      → 主选 LangSmith；做 RAG 加 RAGAS
├── 框架无关（自家代码 / 多框架）
│      → 主选 Braintrust 或 Phoenix；CLI 玩家加 promptfoo
├── 想用 pytest 写 eval
│      → DeepEval
├── 离线 batch 评测、不要 SaaS
│      → RAGAS / DeepEval / promptfoo（纯库）
├── 轻量 prompt A/B
│      → promptfoo
├── 学术 benchmark / 大规模 leaderboard
│      → OpenAI Evals / lm-eval-harness
└── 想要 trace + drift 监控
       → Phoenix / LangSmith
```

## 3. LangSmith：本主题默认推荐

LangSmith 的优势：
- LangChain / LangGraph 原生集成（trace 零配置）
- 数据集托管 + 自动版本
- 实验对比 UI 极强
- 内置常用 evaluator
- 也支持框架无关（任何代码可上报）

### 3.1 一个完整例子

```python
from langsmith import Client
from langsmith.evaluation import evaluate, EvaluationResult
from langchain_openai import ChatOpenAI

client = Client()

# 1. 数据集（一次性）
dataset = client.create_dataset("qa-golden-v1")
for sample in golden_samples:
    client.create_example(
        inputs={"question": sample["q"]},
        outputs={"answer": sample["a"]},
        dataset_id=dataset.id,
        metadata={"intent": sample["intent"]},
    )

# 2. 评估器
def correctness(run, example) -> dict:
    pred = run.outputs["answer"]
    ref = example.outputs["answer"]
    verdict = judge_llm.invoke(...)   # 任何打分逻辑
    return {"key": "correctness", "score": verdict}

# 3. 待评测对象
def my_chain(inputs):
    return {"answer": qa_chain.invoke(inputs["question"])}

# 4. 跑评测
results = evaluate(
    my_chain,
    data="qa-golden-v1",
    evaluators=[correctness],
    experiment_prefix="rag-v3.2",
    metadata={"commit": "abc123", "env": "ci"},
)
# UI 上自动出实验结果，可和历史实验对比
```

### 3.2 内置 evaluator

LangSmith 提供常用模板：

```python
from langsmith.evaluation import LangChainStringEvaluator

correctness = LangChainStringEvaluator("qa")           # 基于 reference 的 QA 判断
helpfulness = LangChainStringEvaluator("criteria",
    config={"criteria": "helpfulness"})
custom = LangChainStringEvaluator("criteria",
    config={"criteria": {"my_metric": "答案是否提到了价格？"}})
```

### 3.3 Pairwise

```python
from langsmith.evaluation import evaluate_comparative

evaluate_comparative(
    experiments=["rag-v3.1-...", "rag-v3.2-..."],
    evaluators=[ranked_pairwise_evaluator],
)
```

UI 直接出 win-rate 对比表。

## 4. RAGAS：RAG 专用指标库

如果做 RAG，**几乎一定会用上 RAGAS**——它把那几个核心 RAG 指标实现得很干净。

```python
from datasets import Dataset
from ragas import evaluate
from ragas.metrics import (
    context_precision, context_recall,
    faithfulness, answer_relevancy, answer_correctness,
)

ds = Dataset.from_dict({
    "question":     [...],
    "answer":       [...],
    "contexts":     [[...], ...],
    "ground_truth": [...],
})

result = evaluate(ds, metrics=[context_precision, faithfulness, answer_relevancy])
print(result)
```

特点：
- 指标实现是开源的，**可读可改**
- 支持自家配置 LLM judge / embedding（默认是 OpenAI）
- 与 LangSmith / LangChain 都能集成

详见 [06 · RAG 评测](./06-rag-eval.md)。

## 5. DeepEval：pytest 风格

把评测当单测写：

```python
from deepeval import assert_test
from deepeval.metrics import AnswerRelevancyMetric, FaithfulnessMetric
from deepeval.test_case import LLMTestCase

def test_qa_answer():
    case = LLMTestCase(
        input="LangGraph 是什么？",
        actual_output=my_chain.invoke("LangGraph 是什么？"),
        retrieval_context=["..."],
    )
    relevancy = AnswerRelevancyMetric(threshold=0.7)
    faithfulness = FaithfulnessMetric(threshold=0.8)
    assert_test(case, [relevancy, faithfulness])
```

跑：

```bash
deepeval test run tests/
```

特点：
- pytest 风格，CI 接入零成本
- 内置指标比 RAGAS 更多（毒性、bias、隐私等）
- "测试失败"语义清晰，适合"指标低于阈值就 PR fail"

短板：
- UI 弱（要看可视化得用 Confident AI 平台）
- LangChain 集成不如 LangSmith 自然

## 6. promptfoo：YAML / CLI 工具

最轻量的方案，**做 prompt A/B 特别舒服**：

```yaml
# promptfooconfig.yaml
prompts:
  - "回答用户问题，用中文：{{question}}"
  - "你是专家。简短回答：{{question}}"

providers:
  - openai:gpt-4o-mini
  - openai:gpt-4o
  - anthropic:claude-haiku-4-5

tests:
  - vars:
      question: "RAG 是什么？"
    assert:
      - type: contains
        value: "检索"
      - type: llm-rubric
        value: "答案准确并提到了检索增强生成"
  - vars:
      question: "..."
```

```bash
promptfoo eval
promptfoo view   # 浏览器打开对比表
```

特点：
- 一份 YAML 跑遍 prompt × provider 矩阵
- 输出是 HTML 表格，方便分享
- CI 友好（`--fail-on-error`）

适合：
- prompt 工程师快速 A/B
- 对比模型（同 prompt 在不同模型上）
- 简单的 regression（CI 跑个 YAML）

不适合：
- 复杂 chain / Agent（不是为这设计的）
- 大规模数据集（CLI 处理慢）

## 7. Braintrust：SaaS 替代 LangSmith

类似 LangSmith 的产品，框架无关：

```python
import braintrust

with braintrust.init(project="my-app") as logger:
    eval = braintrust.Eval(
        "qa-eval",
        data=lambda: golden_samples,
        task=lambda input: my_chain.invoke(input),
        scores=[correctness_scorer, faithfulness_scorer],
    )
    eval.run()
```

特点：
- UI 漂亮、版本对比强
- 不绑定 LangChain
- Pairwise / Online 支持好
- 收费

适合：栈不是 LangChain，但想要 LangSmith 那种 UI 体验。

## 8. OpenAI Evals & lm-eval-harness

学术风格 benchmark 工具：
- **OpenAI Evals**（github.com/openai/evals）：注册测试、跑、产出 JSON 报告
- **lm-eval-harness**（EleutherAI）：跑 MMLU / HellaSwag / GSM8K 等 benchmark 标配

适合：模型预训练 / 微调评估、对比公开 benchmark。
不适合：业务级评测（场景不一样）。

## 9. TruLens / Phoenix

| 框架 | 特色 |
|---|---|
| **TruLens** | "Feedback Functions" 概念，链路上挂"反馈钩子"，每步都打分；可解释性强 |
| **Phoenix（Arize AI）** | 强可视化、漂移监控、本地 / 自托管友好 |

都偏向"观测+评测一体化"，体量稍大、学习曲线略陡。

## 10. 实战搭配建议

不必只用一个——**分层组合**最实用：

| 层 | 推荐工具 |
|---|---|
| **trace + 数据集托管** | LangSmith 或 Braintrust |
| **CI 单测** | DeepEval（pytest 集成） |
| **prompt A/B** | promptfoo |
| **RAG 指标实现** | RAGAS |
| **在线漂移** | Phoenix / LangSmith |

一个真实项目可能：
- 开发期 promptfoo 跑 prompt 对比
- LangSmith 收 trace + 主评测平台
- RAGAS 提供 RAG 指标算法
- DeepEval 把"指标 ≥ 阈值"挂进 pytest CI
- Phoenix 监控线上漂移

## 11. 自建 vs 用框架

**自建**（10 行 Python）：
- 起步快
- 完全控制
- 业务定制深

**框架**：
- UI / 可视化好
- 指标实现可靠
- 团队协作强

经验：
- **PoC / 小项目 < 100 评测 / 周** → 自建脚本 + 简单 LLM judge 够
- **正式项目 / 团队 ≥ 2 人** → 上 LangSmith / Braintrust，省工程
- **CI 接入** → DeepEval / promptfoo
- **指标实现** → RAGAS（开源），不要重复造轮子

## 12. 常见坑

| 现象 | 原因 |
|---|---|
| LangSmith trace 数据外发合规问题 | 大企业敏感数据走 LangSmith Enterprise（可自托管）或 Braintrust 私有部署 |
| RAGAS 给的分诡异 | 默认用 OpenAI；公司没 key 或地域不通；显式配 LLM/embedding |
| DeepEval 跑超慢 | 内置指标都要 LLM；选必要的几个，并行跑 |
| promptfoo 多 provider 一致性差 | 不同 provider 默认参数不同；显式 config |
| 多框架数据格式不一致 | 自建一层 adapter，统一中间数据 schema |
| CI 跑评测 timeout | 评测集太大；CI 只跑 mini-set，PR 通过后再跑 full-set |

## 13. 下一步

- [06 · RAG 评测](./06-rag-eval.md)：RAGAS 怎么和你的 chain 接起来
- [09 · CI 与回归](./09-ci-and-regression.md)：把这些工具接进流水线
