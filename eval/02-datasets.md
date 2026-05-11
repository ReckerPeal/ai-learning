# 02 · 评测集设计

> 评测集质量决定了评测体系的上限。**先有数据集，再谈指标和框架**。

## 1. 一个评测样本长什么样

最小结构：

```python
{
    "id": "qa-001",
    "input": {"question": "OAuth 2.0 的四种 grant type 是什么？"},
    "expected_output": {"answer": "Authorization Code、Implicit、..."},
    "metadata": {
        "type": "factual",
        "difficulty": "easy",
        "tags": ["oauth", "api"],
        "source": "user_log_2026-04",
    },
}
```

要素：
- **id**：稳定的唯一标识，用于跟踪、版本对比
- **input**：原样喂给 subject 的输入
- **expected_output**：标准答案（可以是字符串、结构化对象、检索文档列表等）
- **metadata**：分类标签、来源、难度——用于**分组分析**和**failure mode 定位**

## 2. 三类典型评测集

| 类型 | 用途 | 规模建议 |
|---|---|---|
| **Golden Set（标准集）** | 主力评测，所有 PR 都要跑过 | 100-500 |
| **Regression Set（回归集）** | 历史 bug / 失败 case 沉淀 | 持续追加 |
| **Stress Set（压力集）** | 边界、对抗、长尾 | 50-200 |

不要混在一起——跑 regression 的成功率应该接近 100%（不能让旧 bug 复发），而 golden set 通常 60-90%（仍在迭代）。

## 3. Golden Set 怎么从零建

### 3.1 优先级：真实日志 > 专家手写 > LLM 生成

| 来源 | 真实性 | 成本 | 备注 |
|---|---|---|---|
| 生产日志（用户真问的）| ⭐⭐⭐⭐⭐ | 0 | 必须脱敏；分布最准 |
| 客服工单 / 反馈 | ⭐⭐⭐⭐ | 低 | 已经分类过，省事 |
| 专家手写 | ⭐⭐⭐⭐ | 高 | 可控覆盖关键场景 |
| 小白用户访谈 | ⭐⭐⭐⭐⭐ | 高 | 发现想不到的问法 |
| LLM 自动生成 | ⭐⭐ | 低 | **起步用，长期不行** |

> **第一版 Golden Set 必须有真实日志。** 没有日志？看下面 3.4。

### 3.2 从生产日志收集

```python
from langsmith import Client

client = Client()
runs = client.list_runs(
    project_name="my-app-prod",
    start_time=datetime(2026, 4, 1),
    is_root=True,                        # 只看顶层调用
    filter='gte(latency_ms, 100)',       # 简单质量过滤
    limit=1000,
)

# 转成评测样本
candidates = []
for r in runs:
    candidates.append({
        "input": r.inputs,
        "metadata": {"run_id": str(r.id), "trace_url": r.url},
    })
```

然后**人工标注 expected_output**——这一步绕不过去，但每条只要 1-2 分钟。

### 3.3 LLM 自动生成（凑数）

```python
from langchain_core.prompts import ChatPromptTemplate
from pydantic import BaseModel

class QAPair(BaseModel):
    question: str
    answer: str
    difficulty: str  # easy / medium / hard

gen = ChatPromptTemplate.from_template("""
基于下面的文档，提出 1 个用户**真实可能问的**问题，给出基于文档的标准答案，标注难度：

{doc}

要求：
- 不要问"这段话讲了什么"这种元问题
- 模拟新用户的语气，不一定专业
- hard 题应该需要综合两个以上信息点
""") | llm.with_structured_output(QAPair)

dataset = [gen.invoke({"doc": d.page_content}) for d in sample_docs]
```

⚠️ 局限：
- **绕过文档里没答案的问题** → 测不出"幻觉"和"不知道"场景
- **绕过多跳推理** → 都是单跳
- **风格偏向训练数据** → 真实用户更口语、更模糊

合成数据**永远只是补充**，必须有 30% 以上的真实样本兜底。

### 3.4 还没上线，没有日志怎么办

- 找 5-10 个目标用户做半小时访谈，收集 30-50 个问题
- 自己**冷启动**写 30 条覆盖核心场景的（再凑 LLM 生成 70 条）
- 定个时间点（如上线第 1 天），把当天前 100 条真实 query 收回来替换

冷启动评测集**永远是临时的**，规划好替换路径。

## 4. 多大才算"够"

| 评测目标 | 建议规模 |
|---|---|
| 每天本地快速 sanity check | 20-50（mini set） |
| PR 级回归 | 100-300 |
| 版本/架构变更对比 | 300-1000 |
| 模型微调评估 | 500-3000 |
| 学术 benchmark | 1000+ |

经验法则：**指标希望分辨 X% 的差异，至少需要约 100 / X² 条样本**（统计显著性粗略估算）。要分辨 5% 的差异 → 至少 400 条；要分辨 1% → 至少 10000 条（几乎不现实，靠 pairwise 解决）。

## 5. 数据集分组：看分布而不只看 mean

每条样本打**多维标签**，评测时按维度切片看：

```python
metadata = {
    "intent": "factual_qa",            # factual / multi_hop / chitchat / no_answer
    "domain": "api",                   # api / billing / general
    "language": "zh",
    "difficulty": "medium",            # easy / medium / hard
    "expected_action": "retrieve+answer",  # retrieve_only / direct / refuse
}
```

报告这样切：

```
overall:           78%
by intent:
  factual_qa:      85%
  multi_hop:       45%   ← 这里垮了
  chitchat:        92%
by difficulty:
  easy:            95%
  medium:          80%
  hard:            42%
```

**整体分数会骗你，分组分数不会**。看到 multi_hop 拖后腿，下一步就清楚（→ Decomposition / Agentic RAG）。

## 6. Failure Set：失败案例沉淀

每次发现一个 bug，**第一件事是加一条评测**，再修代码。这样：

1. 修完能验证没漏
2. 以后改别的 case 不会回退
3. 长期沉淀变成最有价值的"压力测试集"

```python
def add_failure_case(question, expected, actual_buggy, fix_pr_url):
    client.create_example(
        inputs={"question": question},
        outputs={"answer": expected},
        dataset_id=regression_set.id,
        metadata={
            "buggy_output": actual_buggy,
            "fix_pr": fix_pr_url,
            "added_at": datetime.now().isoformat(),
        },
    )
```

一年下来你会有几百条"曾经失败过"的样本——**这是任何竞品都拿不到的护城河**。

## 7. 数据集版本化

像代码一样，数据集要有版本：

```
dataset/
├── golden-v1.jsonl          # 初版（2026-Q1）
├── golden-v1.1.jsonl        # 加了 50 条 multi-hop
├── golden-v2.jsonl          # 重整结构，加 metadata
├── regression.jsonl         # 持续追加
├── stress-v1.jsonl
└── CHANGELOG.md
```

每次评测记录：

```python
result = {
    "subject_version": "rag-chain-v3.2",
    "dataset_version": "golden-v1.1",
    "metric_version":  "ragas-0.2.5",
    "timestamp": "...",
    "scores": {...},
}
```

否则三个月后看到一份评测报告，根本不知道用的什么数据集——**没法和现在的对比**。

LangSmith 数据集自带版本（每次 update 增加 example 都有版本号），是个好工具。

## 8. 数据集质量检查

新建数据集后，先**自检**：

| 检查 | 怎么做 |
|---|---|
| 重复 | 按 input 去重（编辑距离 / embedding 相似度） |
| 标签一致 | 同类问题打同一个 tag |
| 标准答案对吗？ | 抽样 20% 人工 review |
| 难度分布合理 | easy:medium:hard 不要全 easy |
| 覆盖关键 intent | 每类 ≥ 10 条 |
| 长度分布 | 别全是 1 句话 query |

写个脚本自动跑一遍：

```python
def audit_dataset(samples):
    print(f"total: {len(samples)}")
    print(f"unique inputs: {len(set(s['input'] for s in samples))}")
    print(f"by intent: {Counter(s['metadata']['intent'] for s in samples)}")
    print(f"by difficulty: {Counter(s['metadata']['difficulty'] for s in samples)}")
    print(f"avg input length: {sum(len(s['input']) for s in samples) / len(samples):.0f}")
```

## 9. 数据泄漏防护

最常见的数据泄漏：

1. **评测样本进了 prompt few-shot** → 看着分高，实际作弊
2. **评测样本进了向量索引** → RAG 直接命中"自己的答案"
3. **评测样本和测试用户日志重叠** → 上线后用户问同样的问题命中"训练数据"

预防：
- 评测集 ID 加前缀（`eval-...`），索引时显式排除
- 索引建立时打印"评测集泄漏检测报告"
- 公开评测集（如 MMLU）已经被各家模型见过——不要全信公开 benchmark 分数

## 10. 用户反馈数据怎么进评测集

线上用户给"👎"的 case 是金矿，但要**清洗**：

- 排除有害 / PII / 投诉性质的（送给运营，不进评测）
- 标准答案需要**人工补充**（不能拿原 LLM 输出反过来当答案，那是 self-fulfilling）
- 标记 `from_user_feedback` tag，便于追踪

工作流：

```
线上 trace + 👎 → 待处理队列
                    │
                    ▼
              人工 review（5-10 分钟一条）
                    │
        ┌───────────┼────────────┐
        ▼           ▼            ▼
    丢弃        加入 regression  加入 golden
    （无效）     （bug 修复）    （新场景）
```

## 11. 实操：30 分钟从零建一个 100 条评测集

```python
# 1. 收集（10 min）
from langsmith import Client
client = Client()
runs = client.list_runs(project_name="prod", limit=200, is_root=True)
candidates = [{"id": str(r.id), "input": r.inputs, "actual": r.outputs} for r in runs]

# 2. 过滤（5 min）
import random
random.shuffle(candidates)
candidates = [c for c in candidates if len(str(c["input"])) > 10][:120]   # 去太短的

# 3. 人工标注（15 min, 平均每条 7 秒）
for c in candidates:
    print(c["input"])
    print("Actual:", c["actual"])
    c["expected"] = input("Expected (空 = 跳过)：")
    if c["expected"]:
        c["metadata"] = {"intent": input("intent: "), "difficulty": input("d: ")}

dataset = [c for c in candidates if c.get("expected")]

# 4. 上传到 LangSmith
ds = client.create_dataset("golden-v1")
for c in dataset:
    client.create_example(
        inputs=c["input"],
        outputs={"answer": c["expected"]},
        dataset_id=ds.id,
        metadata=c["metadata"],
    )
```

短短 30 分钟，你就有了**比 80% 公司都更扎实**的起点。

## 12. 常见坑

| 现象 | 原因 |
|---|---|
| 评测集太小，分数抖动 5%+ | < 50 条；至少加到 100 |
| 改一处提升 5%、改一处降 5% | 评测集对那个 case 不敏感；加更多覆盖 |
| 离线高 / 上线低 | 评测集不来自真实分布；用真实日志重建 |
| 同样的样本两次跑分不同 | 没固定 random seed / temperature；评测时 t=0 |
| 数据集和 prompt few-shot 重叠 | 严格分层；few-shot 用单独的 example pool |
| 只看 overall 分数 | 加分组报表 |
| 月度评测，不知道哪次实验是哪个版本 | 没版本化；把 commit + dataset_version 写进结果 |

## 13. 下一步

- [03 · 指标体系](./03-metrics.md)：有了数据集，用什么打分
- [04 · LLM-as-Judge 深度](./04-llm-as-judge.md)：怎么让 LLM judge 稳定打分
- [10 · 进阶](./10-advanced.md)：合成数据、对抗测试集
