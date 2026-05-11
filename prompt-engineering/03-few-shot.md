# 03 · Few-shot 设计

> TLDR：示范一次胜过描述十次。Few-shot 是 prompt 工程里**最稳定、最可解释、最便宜**的提升手段——但用错了示例数量、顺序、多样性，反而会让模型固执地犯错。

## 1. Few-shot 为什么有效

LLM 在训练时见过大量"输入-输出"配对（QA、对话、代码）。Few-shot 本质是**激活 in-context learning**：让模型在 prompt 内"现学"输入到输出的映射。

```text
[示例输入 1] → [示例输出 1]
[示例输入 2] → [示例输出 2]
[示例输入 3] → [示例输出 3]
[真实输入]   → [???]    ← 模型补全这里
```

模型不是在学"规则"，是在**模仿示例的表面模式**：

| 示例传达的信息          | 模型学到的                              |
| ---------------- | ---------------------------------- |
| 输出格式（JSON / XML） | "这种任务输出长这样"                        |
| 输出长度             | "应该输出 30 字左右"                      |
| 字段命名             | "用 `confidence` 不是 `prob`"        |
| 推理风格             | "先说结论再列依据"                         |
| 边界处理             | "信息不足时返回 null 而非编造"                 |
| 语气 / 风格          | "正式 / 简洁 / 中英混合"                  |

## 2. Zero / One / Few / Many-shot 决策

| 场景                                | 推荐                                |
| --------------------------------- | --------------------------------- |
| 任务在 LLM 训练数据里大量存在（翻译、摘要、常见 NER）   | **Zero-shot**：直接描述任务，加 few-shot 反而增加成本 |
| 输出格式特殊但任务通用（特定 JSON schema）       | **1-3 shot**：示范格式即可                |
| 任务有"领域 idiom"（你公司术语、特殊话术）         | **3-5 shot**：覆盖典型形态                |
| 任务有边界 case 需要明确处理                 | **5-10 shot**：故意把边界放进示例           |
| 任务多样性极高（输入差异大）                    | **动态 few-shot**：按相似度选示例（§5）        |
| 任务是 reasoning（数学、代码 debug）        | **CoT few-shot**：见 [04 · CoT](./04-cot.md) |

**反 pattern**：动不动就堆 20 个 shot。边际收益递减很快，且占满 context、抬高费用。

## 3. 数量：边际收益曲线

| Shot 数 | 经验上的相对收益                              |
| ------ | ------------------------------------- |
| 0      | baseline                              |
| 1      | +30%（仅靠 1 个示例就解决格式问题）                  |
| 3      | +50%                                  |
| 5      | +60%                                  |
| 8-10   | +63% 左右开始**饱和**                      |
| 20+    | 不增反降（"lost in middle"+ context 干扰）   |

> 数字仅供建立直觉，具体随任务变化。但"3-5 是甜点区"几乎放之四海而皆准。

**结论**：

- 默认从 3 shot 起步
- 模型很强（Claude / GPT-4 级）：3 shot 足够
- 模型偏弱（小开源模型 / 量化版）：5-8 shot
- 任务非常规：8-10 shot，再多就该考虑微调

## 4. 顺序：simple-to-complex 还是反过来

学术圈有过争议，工程实践给出的相对一致结论：

| 顺序                  | 何时用                                |
| ------------------- | ---------------------------------- |
| Simple → Complex    | 默认。模型先建立基础映射，再拓展边界                |
| Complex → Simple    | 输出对边界 case 极度敏感时（如安全检测、合同审查）     |
| 随机                  | 只在已经做了消融测试、确认顺序无显著影响时             |
| **Hard case 放最后**   | 通用最佳实践——"近因效应"让模型更重视末位示例           |

**最重要的位置**：**最后一个示例**。它对最终输出的影响最大。永远把"代表性最强"或"最容易被模型搞错的"case 放最后。

## 5. 多样性：覆盖 vs 重复

5 个相似的示例，不如 3 个差异化的示例。

```text
反 pattern（多样性差）：
1. "这家餐厅好棒" → positive
2. "这家餐厅真好" → positive
3. "这家餐厅不错" → positive
   ↑ 模型学到的：所有"餐厅"都是 positive
```

```text
正 pattern（多样性高）：
1. "这家餐厅好棒"           → positive
2. "服务很差，再也不来"        → negative
3. "还行吧，价格能接受"        → neutral
4. "等了 1 小时，但味道值"      → mixed/positive  ← 边界
5. "停车场真大"              → unrelated         ← 离题
```

覆盖维度：

| 维度       | 含义                          |
| -------- | --------------------------- |
| 标签覆盖     | 每个 label 都至少 1 个示例           |
| 极性覆盖     | 弱正 / 强正 / 弱负 / 强负            |
| 边界覆盖     | 模糊、矛盾、混合、离题                  |
| 长度覆盖     | 短 / 中 / 长输入各 1               |
| 结构覆盖     | 含表情、含错别字、纯文本、含代码块            |

## 6. 动态 Few-shot：按输入相似度选示例

固定 few-shot 解决不了"输入分布漂移"。当任务输入多样性极高（比如客服问答），更聪明的做法：

```text
1. 维护一个 [输入, 输出] 示例池（100-1000 条）
2. 用 embedding 检索：输入 → top-K 最相似示例
3. 把这 K 个示例塞进 prompt 作为 few-shot
```

**伪代码**：

```python
import numpy as np
from openai import OpenAI

client = OpenAI()

# 离线：示例池 + embedding
EXAMPLES = [
    {"input": "我的快递到哪了", "output": "请提供订单号"},
    {"input": "怎么退款", "output": "登录账号 → 订单 → 申请退款"},
    # ... 1000 条
]

def embed(texts: list[str]) -> np.ndarray:
    resp = client.embeddings.create(
        model="text-embedding-3-small", input=texts
    )
    return np.array([d.embedding for d in resp.data])

EX_INPUTS = [e["input"] for e in EXAMPLES]
EX_VECS = embed(EX_INPUTS)  # 离线计算一次

def select_shots(query: str, k: int = 3) -> list[dict]:
    qv = embed([query])[0]
    sims = EX_VECS @ qv  # cosine（已归一化情况下）
    top_idx = np.argsort(-sims)[:k]
    return [EXAMPLES[i] for i in top_idx]

def build_prompt(query: str) -> list[dict]:
    shots = select_shots(query, k=3)
    msgs = []
    for s in shots:
        msgs.append({"role": "user", "content": s["input"]})
        msgs.append({"role": "assistant", "content": s["output"]})
    msgs.append({"role": "user", "content": query})
    return msgs
```

**好处**：

- 大池 + 动态选 = 永远 prompt 短，但覆盖广
- 用户报告 bad case → 加进示例池 → 类似输入立刻"修好"

**代价**：

- 每次调用前先做 embedding 检索（额外延迟）
- 与 prompt caching 不兼容（prompt 每次都不一样）

**用 langchain 内置的实现**：

```python
from langchain_core.example_selectors import SemanticSimilarityExampleSelector
from langchain_chroma import Chroma
from langchain_openai import OpenAIEmbeddings

selector = SemanticSimilarityExampleSelector.from_examples(
    EXAMPLES,
    OpenAIEmbeddings(),
    Chroma,
    k=3,
)
```

详见 [../langchain/03-prompts-and-models.md](../langchain/03-prompts-and-models.md)（**不在此处复述 API**）。

## 7. Few-shot vs Instruction：什么时候用哪个

| 想表达的东西              | 用 Instruction        | 用 Few-shot          |
| ------------------- | -------------------- | -------------------- |
| "输出 JSON"           | ✅ 直接说                | 也可，但浪费 token         |
| "JSON 里 score 0-10" | ✅ 写在描述里              | 用 1-2 shot 加固        |
| "拒绝回答的话术"           | ❌ 描述容易跑偏             | ✅ 1-2 个示例最稳          |
| "中文中夹英文术语怎么对齐"      | ❌ 几乎不可能用语言描述清楚       | ✅ few-shot 直接演示       |
| "推理风格 / 思考链长度"       | 一般                   | ✅ 示范 CoT 长度         |
| "处理多种 corner case"  | ❌ 列不完                | ✅ 选典型边界做示例           |

**经验法则**：

> 能用规则描述清楚的 → instruction；
> 描述会冗长且仍模糊的 → few-shot。

## 8. Few-shot 的"污染"陷阱

Few-shot 是双刃剑——**示例本身的偏差会被模型放大**。

| 污染源              | 后果                                     | 防御                                        |
| ---------------- | -------------------------------------- | ----------------------------------------- |
| 示例标签错            | 模型学错映射，永远在错的 case 上输出错答案              | 示例必须经过双人 review                            |
| 示例分布偏            | 5 个示例都是 positive，模型对所有输入都倾向 positive | 标签均匀分布                                     |
| 示例格式不一致          | 有的 JSON 有的纯文本，模型选最近的那个模仿              | 示例格式严格统一                                   |
| 示例里包含真实 PII      | 模型可能把 PII 模式记住、外泄                     | 示例必须脱敏                                     |
| 示例语言混杂           | 模型不确定该输出哪种语言                          | 同一 prompt 同一语言                             |
| Few-shot 和真实输入不像 | 模型会"忽视"few-shot 走通用知识                 | 用动态 few-shot，或定期复审示例池                      |

## 9. 一个完整可运行例子：动态 Few-shot 客服分类

```python
# pip install anthropic numpy openai
import json
import numpy as np
import anthropic
from openai import OpenAI

oa = OpenAI()
ant = anthropic.Anthropic()

EXAMPLES = [
    {"q": "我的订单 12345 还没发货", "category": "logistics"},
    {"q": "可以退款吗", "category": "refund"},
    {"q": "优惠券怎么用", "category": "discount"},
    {"q": "你们卖小米手机吗", "category": "product_inquiry"},
    {"q": "怎么联系人工客服", "category": "human_handoff"},
    # ... 真实场景 100+ 条
]

def embed(texts):
    return np.array([
        d.embedding for d in oa.embeddings.create(
            model="text-embedding-3-small", input=texts
        ).data
    ])

# 归一化以便用点积代替 cosine
EX_VECS = embed([e["q"] for e in EXAMPLES])
EX_VECS /= np.linalg.norm(EX_VECS, axis=1, keepdims=True)

SYSTEM = """你是电商客服分类助手。把用户问题归到下列一类：
- logistics（物流 / 配送 / 发货）
- refund（退款 / 退货）
- discount（优惠 / 价格）
- product_inquiry（咨询商品）
- human_handoff（要人工）
- other（其他）

输出 JSON: {"category": "<label>", "confidence": 0~1}
"""

def classify(query: str, k: int = 3) -> dict:
    qv = embed([query])[0]
    qv /= np.linalg.norm(qv)
    sims = EX_VECS @ qv
    top = np.argsort(-sims)[:k]

    msgs = []
    for i in top:
        e = EXAMPLES[i]
        msgs.append({"role": "user", "content": e["q"]})
        msgs.append({
            "role": "assistant",
            "content": json.dumps({"category": e["category"], "confidence": 0.95})
        })
    msgs.append({"role": "user", "content": query})

    resp = ant.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=128,
        system=SYSTEM,
        messages=msgs,
        temperature=0,
    )
    return json.loads(resp.content[0].text)

if __name__ == "__main__":
    print(classify("我买的鞋码不合适，能换一双吗？"))
    # 期望：{"category": "refund", "confidence": ...}
```

要点：

- 动态选最相似的 3 个示例
- 用 `messages` 数组而非纯文本拼接（Claude 偏好 multi-turn 形式）
- temperature=0 + JSON schema 约束

## 10. 何时不用 Few-shot

| 不用的场景                     | 原因                              |
| ------------------------- | ------------------------------- |
| 翻译 / 摘要 / 通用 QA           | LLM 训练数据已覆盖，加 shot 不增反占 token   |
| 输出极简（如 "yes" / "no"）      | 用 instruction 一句话搞定             |
| 上下文已经吃紧（接近 100K）          | 优先保留真实输入                         |
| 任务每次都极度个性化（完全无相似历史）       | Few-shot 没有可复用的样本，用 instruction |
| 需要严格 schema 输出            | 用 tool calling / JSON mode 更稳    |
| Reasoning models（o1 / R1） | 这些模型 few-shot 收益弱，明确给规则反而好     |

## 常见坑

1. **示例数量盲目加码**：以为越多越好，从 5 加到 15，结果 prompt 长了 3 倍、效果几乎不变。3-5 是甜点区。
2. **示例顺序写反**：把最重要的 case 放第一个、最弱的放最后。模型对末位示例最敏感——把代表性最强的放最后。
3. **Few-shot 当成静态字符串**：示例硬编码进 prompt 模板，遇到 bad case 没法动态修复。改用示例池 + 动态选择。
4. **Few-shot 偷偷泄露真实数据**：把生产数据原样作为示例（含手机号、身份证），模型可能在其他对话里"学到"。所有示例必须脱敏。
5. **Few-shot 和 instruction 矛盾**：instruction 说"输出小写 label"，示例里却是大写。模型会选近的那个（示例），破坏你的预期。
6. **不更新示例池**：上线后用户报错的 case 没回灌进 few-shot 池，三个月后模型还在犯一样的错。建立"bad case → 评测集 → few-shot"的反馈环（见 [10 · 评测](./10-evaluation.md)）。

## 下一步

- [04 · Chain-of-Thought 与 Self-Consistency](./04-cot.md) — Reasoning 任务的 few-shot 升级版
- [08 · Prompt 模板化与版本管理](./08-templates.md) — 怎么把 few-shot 池工程化管理
- [10 · Prompt 评测与迭代](./10-evaluation.md) — 怎么把 bad case 自动转化为 few-shot
- [../langchain/03-prompts-and-models.md](../langchain/03-prompts-and-models.md) — `FewShotPromptTemplate` API
