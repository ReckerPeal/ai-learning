# 04 · Chain-of-Thought 与 Self-Consistency

> TLDR：CoT 的核心不是"让模型多输出文字"，是**让模型把推理路径展开**，从而把"一次性算对"变成"多步小问题"。在 reasoning 模型时代，显式 CoT 的价值在缩小，但**自洽性（self-consistency）和分解策略**仍是 prompt 工程师的必修。

## 1. CoT 简史（速览）

| 年份   | 工作                          | 贡献                                 |
| ---- | --------------------------- | ---------------------------------- |
| 2022 | Wei et al. CoT prompting    | "Let's think step by step" 横空出世，数学题准确率显著提升 |
| 2022 | Self-Consistency            | 多次采样 + 多数投票，把 CoT 提升一档              |
| 2022 | Zero-shot CoT (Kojima)      | 不用 few-shot，光靠 "step by step" 也能触发 |
| 2023 | Tree of Thoughts            | 树搜索式推理，适合规划 / 博弈                   |
| 2023 | Self-Refine / Reflexion     | 模型自己评审自己的 CoT 并重写                  |
| 2024 | OpenAI o1 (内置 CoT)          | 推理 token 由模型层处理，prompt 端 CoT 价值下降 |
| 2025 | DeepSeek-R1 / Claude thinking | reasoning 普及，prompt 工程重心从"激发推理"转向"约束推理"  |

**当前格局**：

- 普通模型（GPT-4o、Claude Sonnet 非 thinking 模式）→ 仍受益于显式 CoT
- Reasoning 模型（o1 / o3 / R1 / Claude thinking）→ **不要**手写 "step by step"，让模型自己思考

## 2. Zero-shot CoT vs Few-shot CoT

### 2.1 Zero-shot CoT

最便宜的提升：

```text
问题：小明有 3 个苹果，吃掉 1 个，又买了 4 个，现在有几个？

请一步一步思考，最后给出答案。
```

末尾或开头加一句"step by step / 逐步推理"即可。

### 2.2 Few-shot CoT

把推理过程也写进示例：

```text
Q: 小明有 3 个苹果，吃掉 1 个，又买了 4 个。
推理：起始 3 → 吃 1 剩 2 → 买 4 共 6
A: 6

Q: 张三有 5 块糖，分给 2 个小朋友各 2 块，自己又拿了 1 块。
推理：起始 5 → 给出 2×2=4 剩 1 → 自己拿 1 = 0
A: 0

Q: 老王买了 12 个鸡蛋，打碎 3 个，做菜用了 5 个。
推理：?
A: ?
```

模型会模仿示例的推理风格——这是 few-shot CoT 的杠杆。

## 3. 决策：CoT 用还是不用

```text
任务类型 →
│
├─ 数学 / 逻辑 / 多步推理
│   ├─ 用 reasoning 模型（o1 / R1 / Claude thinking）
│   │   └─→ 不写 "step by step"，让模型自动思考
│   └─ 用普通模型
│       └─→ ✅ Zero-shot CoT 起步，复杂时 Few-shot CoT
│
├─ 分类 / 抽取 / 短回答
│   └─→ ❌ 不用 CoT。CoT 反而让模型"过度思考"，输出冗余
│
├─ 创意 / 写作
│   └─→ ❌ 不用 CoT。但可以用 outline → draft 两步
│
├─ 决策 / 评估（要解释）
│   └─→ ✅ 用 CoT。先 reasoning 再 conclusion，可解释性强
│
├─ 实时 / 低延迟
│   └─→ ❌ CoT 让 token 数量翻 5-10 倍，延迟和成本暴涨
│
└─ Agent 工具调用
    └─→ ✅ "thought-action-observation" 模式，见 ../agents/02-paradigms.md
```

## 4. CoT 的两种"语法"

### 4.1 Reasoning-First（推理在前，结论在后）

```text
请按以下格式回答：

<reasoning>
（分析问题、列出步骤、得出中间结果）
</reasoning>

<answer>
最终答案
</answer>
```

**优势**：让模型"想清楚再答"，符合人类阅读习惯。

**劣势**：

- 输出长，延迟高
- 程序消费时要解析两段
- 用户看不到 reasoning 时还是只看 answer

### 4.2 Answer-First（结论在前，可选解释）

```text
请直接回答，然后用一段话解释你的推理。

格式：
答案：...
理由：...
```

**优势**：用户先看到结论，体验好。

**劣势**：等于先猜答案，再"事后合理化"。**不要在数学 / 逻辑题上用这种格式**——会显著降低准确率。

| 格式            | 用途                       |
| ------------- | ------------------------ |
| Reasoning-First | 逻辑、数学、需要正确性的任务           |
| Answer-First    | 客服、咨询，结论比推理更重要的任务         |
| 仅 Reasoning（不要 answer 字段） | Agent 内部 thinking step    |

## 5. Self-Consistency：多次采样投票

CoT 在 temperature > 0 时每次推理路径不同。Self-consistency 利用这点：

```text
1. 同一个 prompt 跑 N 次（temperature=0.7-1.0）
2. 每次得到一个答案
3. 多数投票（majority vote）作为最终答案
```

| N（采样次数） | 经验上的相对增益                 |
| -------- | ------------------------ |
| 1        | baseline（CoT 单次）          |
| 3        | +5-8%                    |
| 5        | +10-12%                  |
| 10       | +13-15%                  |
| 20+      | 饱和                       |

**何时用**：

- 任务正确性极重要（金融计算、代码 review、医疗）
- 单次成本可接受（×N 倍）
- 答案可枚举（投票才有意义；自由文本投票不容易）

**何时不用**：

- 实时场景（×N 倍延迟）
- 答案是长文本（无法投票）
- 已用 reasoning 模型（已经内置类似机制）

## 6. Tree of Thoughts（ToT）极简介绍

ToT = CoT + 树搜索：

```text
初始问题
   │
   ├─ Thought A1 → Thought A2 → Thought A3 → A 解
   ├─ Thought B1 → Thought B2 → 死路（剪枝）
   └─ Thought C1 → ... → C 解

LLM 评估每条路径质量 → 保留 top-K → 展开
```

**适合**：搜索 / 规划 / 博弈类问题（数独、24 点、棋类）。

**不适合**：常规 NLP 任务，性价比不如 self-consistency。

详见 [../agents/02-paradigms.md](../agents/02-paradigms.md) 的 ToT/Plan-Solve 部分（**不在此处复述**）。

## 7. Reasoning 模型时代的变化

o1 / o3 / DeepSeek-R1 / Claude thinking mode 自带"内部 CoT"，对 prompt 工程的影响：

| 旧实践                              | 新实践                                  |
| -------------------------------- | ------------------------------------ |
| "Let's think step by step"       | **省略**（模型已经会做）                       |
| Few-shot CoT 写出推理过程               | 给规则 / 评分标准，**不要**示范推理               |
| Self-consistency × 5             | 通常不需要，模型内部已多路径搜索                     |
| 让模型显式输出 `<reasoning>` 标签         | 模型有专门的 reasoning channel，外部不可见       |
| Prompt 写得越细越好                    | **写得简洁**——过多约束反而干扰内部推理               |

**Reasoning 模型 prompt 新口诀**：

> "告诉它 **要什么**，不要告诉它 **怎么想**。"

```text
旧（针对 GPT-4o）：
你是数学老师，请一步一步推导，先列方程，再代入求解，最后...

新（针对 o1）：
求解：x² + 5x + 6 = 0。
要求：给出所有实数解。
```

## 8. 一段可运行代码：CoT + Self-Consistency

```python
# pip install anthropic
from collections import Counter
import re
import anthropic

client = anthropic.Anthropic()

SYSTEM = """你是数学解题助手。

请按以下格式回答：
<reasoning>
（详细推理，可多步）
</reasoning>
<answer>
（仅一个数字，不带单位、不带其他文字）
</answer>
"""

def solve_once(question: str, temperature: float = 0.8) -> str | None:
    resp = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=2048,
        system=SYSTEM,
        messages=[{"role": "user", "content": question}],
        temperature=temperature,
    )
    text = resp.content[0].text
    m = re.search(r"<answer>\s*(.+?)\s*</answer>", text, re.S)
    return m.group(1).strip() if m else None

def solve_with_consistency(question: str, n: int = 5) -> str:
    """跑 N 次，多数投票。"""
    answers = []
    for _ in range(n):
        a = solve_once(question)
        if a:
            answers.append(a)
    if not answers:
        return "FAILED"
    most_common, count = Counter(answers).most_common(1)[0]
    print(f"votes: {Counter(answers)}, picked: {most_common} ({count}/{len(answers)})")
    return most_common

if __name__ == "__main__":
    q = "一辆车从 A 出发以 60 km/h 行驶，2 小时后另一辆车从 A 以 90 km/h 同向追赶。多少小时后第二辆车追上第一辆？"
    print(solve_with_consistency(q, n=5))
```

**输出示例**：

```text
votes: Counter({'4': 4, '4.0': 1}), picked: 4 (4/5)
4
```

**生产化要点**：

1. 答案规整化（"4" / "4.0" / "4 hours" 应该归一）
2. 并发跑 N 次（用 `asyncio` 或 `concurrent.futures`）
3. 失败的采样要丢弃，不能"无答案"也算一票
4. 监控分歧度——分歧大说明 prompt 不够稳定

## 9. CoT 何时反而拖后腿

| 反 pattern                | 现象                              | 修法                       |
| ----------------------- | ------------------------------- | ------------------------ |
| 简单分类强行加 CoT             | "判断 positive / negative" 输出 200 字推理 | 直接 instruction，不要 CoT     |
| 长文本摘要加 CoT              | 模型先"分析每段"再总结，token 翻倍但质量没提升   | 直接给摘要 schema             |
| Reasoning 模型外加 CoT       | 模型内部 reasoning + 外部 reasoning 重复 | 简化 prompt，让 reasoning 模型自己想 |
| CoT 长度失控                | 回答 5 个字的题花 800 token 推理         | 加约束："推理不超过 100 字"        |
| CoT 之后忘记给 answer        | 模型推理着推理着停了，没出答案                 | XML 模板强制 `<answer>` 段     |

## 10. CoT 与其他范式对比

| 范式               | 适合问题                | 成本（token） | 准确率提升       |
| ---------------- | ------------------- | --------- | ---------- |
| Direct           | 通用                  | 1×        | baseline   |
| Zero-shot CoT    | 多步推理                | 3-5×      | +10-30%    |
| Few-shot CoT     | 领域定制 / 风格统一         | 5-10×     | +15-35%    |
| Self-Consistency | CoT × N 投票          | N×        | 再 +5-15%   |
| Tree of Thoughts | 搜索 / 规划 / 博弈        | 10-100×   | +20-40%（特定任务） |
| Reasoning model  | 数学 / 代码 / 复杂逻辑      | 内置        | +30-50%    |

## 常见坑

1. **机械加 "step by step"**：所有任务都加，包括分类、摘要——结果输出冗余、成本翻倍。CoT 只对**多步推理**有效。
2. **Reasoning 模型还在写 few-shot CoT**：o1 / R1 上写"先想 A 再想 B"会干扰内部推理路径，反而降准确率。Reasoning 模型只给规则和约束。
3. **Self-Consistency 用 temperature=0**：投票需要多样性，temperature 必须 > 0（一般 0.7-1.0）。temperature=0 跑 5 次结果一样，等于没投票。
4. **Answer-First 用在数学题上**：模型先猜答案再"找理由"，正确率显著低于 reasoning-first。逻辑/数学严格用 reasoning-first。
5. **CoT 输出没法解析**：让模型"用自然语言推理"再给答案，结果格式飘忽，正则抓不到。永远用 `<reasoning>` `<answer>` 这种结构化标签。
6. **CoT 用在弱模型上没效果**：< 7B 的小模型 CoT 收益很弱，甚至负收益。CoT 是涌现能力，需要足够大的模型。

## 下一步

- [05 · 指令调优与输出约束](./05-instruction-tuning.md) — 怎么用 schema 强制模型输出 `<answer>`
- [07 · 模型差异](./07-model-differences.md) — Reasoning 模型与普通模型的 prompt 偏好对比
- [10 · Prompt 评测与迭代](./10-evaluation.md) — 怎么测量 CoT 是否真的提升了准确率
- [../agents/02-paradigms.md](../agents/02-paradigms.md) — ReAct / ToT / Plan-Solve 等 agent 范式
