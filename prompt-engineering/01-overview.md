# 01 · 概览：Prompt 为什么有效

> TLDR：Prompt 是一段**程序**，模型是**解释器**。你写的不是自然语言指令，而是在引导一个高维条件概率分布 `P(next_token | prompt)`。把这件事想清楚，后面 9 章都顺。

## 1. 一句话定义

**Prompt 工程**：通过设计输入文本（含 system / context / 示例 / 任务 / 格式约束），稳定地从 LLM 获取期望输出的方法论。

注意三个关键词：

| 关键词    | 含义                                                  |
| ------ | --------------------------------------------------- |
| **设计** | 不是"想到什么写什么"，是有结构、有版本、可回归                             |
| **稳定** | 一次跑成不算数，要 100 次有 95 次以上达标                            |
| **方法论** | 不是技巧合集，是可教可传承的工程规范                                  |

## 2. 为什么 Prompt 不会被"消亡"

每隔半年都有"Prompt 工程要死了"的论调。事实正相反：

| 场景             | Prompt 重要性                                        |
| -------------- | ------------------------------------------------- |
| 模型变强（GPT-5）    | **更重要**——能力越强，输出空间越大，需要更精细的引导                    |
| Reasoning 模型（o1 / R1） | **形式变化**——少写"step by step"，多写约束和评分标准              |
| Agent 化        | **更重要**——agent 的每个节点都是 prompt，控制流稳定性 = prompt 稳定性 |
| 微调 / RLHF 普及   | **互补**——微调改分布，prompt 改采样轨迹                       |
| 多模态            | **维度增加**——文本 prompt + 图像 placeholder + 视频 anchor |

**核心论点**：只要还需要把"我想要什么"用语言描述给模型，prompt 工程就存在。形式会变（XML / JSON Schema / 函数签名），方法论不变。

## 3. LLM "看" prompt 的直觉

不需要懂 transformer 内部，但要建立四个直觉：

### 3.1 Attention：每个 token 都在"看"上下文

模型生成下一个 token 时，对**整个 prompt 的每个 token 都赋予权重**。这意味着：

- prompt 里加一句"务必使用 JSON 格式"，这句话会被反复 attend
- 但 prompt 太长时，远端信息权重被稀释（"lost in the middle"）

### 3.2 Next-token：贪婪逼近 vs 概率采样

| 解码策略           | 行为                            | Prompt 含义              |
| -------------- | ----------------------------- | ---------------------- |
| `temperature=0` | 选概率最高的 token                 | Prompt 决定一切，复现性高       |
| `temperature=1` | 按 softmax 分布采样                | Prompt 引导分布，但仍有随机性     |
| `top_p=0.9`    | 只在累计概率 90% 的 token 里采样        | 折中                     |

**结论**：prompt 决定的是"概率分布的形状"，不是"具体输出"。所以同一个 prompt 跑多次会有差异——这是常识，不是 bug。

### 3.3 上下文窗口：有限的工作记忆

| 模型                  | 上下文窗口（截至 2026 早期）     |
| ------------------- | -------------------- |
| Claude 4 / 4.5 / 4.7 | 200K                 |
| GPT-4o / 5          | 128K / 256K          |
| Gemini 2.5 Pro      | 1M-2M                |
| DeepSeek-V3 / R1    | 128K                 |
| Qwen 2.5            | 32K-128K             |

**误区**：长上下文 ≠ 能用满。实测在 50K 之后，模型对 prompt 中段的信息检索能力显著下降。

### 3.4 Prompt = Cache 单元

主流模型都支持 prompt caching：把高频出现的前缀（system prompt、few-shot）缓存起来，命中后费用降 80%+、首 token 延迟降 50%。

**工程含义**：高频部分要放在 prompt **最前面**，且**字节级稳定**——一个空格变化就 cache miss。

## 4. Prompt 工程 vs 微调 vs RAG 决策树

新手最容易问错："这个问题该 fine-tune 吗？" 90% 的情况答案是先用 prompt 工程。

```text
你的需求是 ——
│
├─ 模型不会某项 [新知识]（公司内部数据 / 实时数据）
│   └─→ RAG（参见 ../rag-advanced/）
│       不要硬塞进 prompt，更不要 fine-tune
│
├─ 模型偶尔不听话（输出格式不稳 / 步骤遗漏）
│   └─→ Prompt 工程（本主题 §02 §05）
│       先用 few-shot 和约束，能解决 80%
│
├─ 模型完全不懂某种 [行为模式]（医疗诊断流程 / 公司专属客服话术）
│   └─→ 评估：
│       ├─ 样本 < 1000 条 → 还是 prompt 工程 + few-shot
│       ├─ 样本 > 10000 条 + 行为高度结构化 → 微调
│       └─ 样本 > 100000 条 + 改变模型分布 → 微调或 RLHF
│
├─ 需要降低延迟 / 成本，但已经能用大模型实现
│   └─→ 蒸馏（用大模型生成数据，微调小模型）
│       不是 prompt 工程范畴
│
└─ 复杂多步任务，单 prompt 搞不定
    └─→ Agent / Workflow（参见 ../langgraph/ ../agents/）
        每步仍然是一个 prompt
```

**关键判断**：

| 维度           | Prompt | RAG  | 微调   |
| ------------ | ------ | ---- | ---- |
| 改变模型知识       | 否      | 是    | 是    |
| 改变模型行为       | 是      | 否    | 是    |
| 启动成本         | 低      | 中    | 高    |
| 迭代周期         | 分钟     | 小时   | 天到周  |
| 可解释 / 可调试    | 高      | 中    | 低    |
| 跨模型可移植       | 中      | 高    | 否    |

## 5. Prompt 的"层次"结构

把一个完整 prompt 拆成 5 层，后续章节会逐层展开：

```text
┌─────────────────────────────────────────────┐
│ Layer 1: System Prompt                      │  → §02 §05 §06 §09
│   角色 / 边界 / 总体规范                          │
├─────────────────────────────────────────────┤
│ Layer 2: Task Instruction                   │  → §02 §05
│   本次具体任务、输入输出契约                          │
├─────────────────────────────────────────────┤
│ Layer 3: Few-shot Examples                  │  → §03
│   1-N 个示例，演示而非描述                          │
├─────────────────────────────────────────────┤
│ Layer 4: Context / RAG Snippets             │  → ../rag-advanced/
│   动态注入的资料                                │
├─────────────────────────────────────────────┤
│ Layer 5: User Input                         │
│   实际用户输入（最不可信，§09 重点防御层）                  │
└─────────────────────────────────────────────┘
```

**重要原则**：

- Layer 1-3 是"程序"——可版本管理、可评测
- Layer 4-5 是"运行时输入"——必须假定可能是恶意的
- 多数注入攻击的本质是 Layer 5 篡夺 Layer 1 的权限

## 6. 心智模型："Prompt 是程序"

这不是比喻。Prompt 工程师该用工程师视角看待 prompt：

| 编程概念       | Prompt 对应                    | 章节         |
| ---------- | ---------------------------- | ---------- |
| 函数签名       | 任务描述 + 输入输出 schema           | §02 §05    |
| 类型约束       | "返回 JSON，包含 fields x, y"     | §05        |
| 单测         | Prompt 评测集                   | §10        |
| Code review | Prompt review（PR 流程）         | §08        |
| 版本号        | `prompt-extract-v3.2.yaml`   | §08        |
| 灰度 / 回滚    | A/B + Prompt registry        | §08        |
| 异常处理       | "若信息不足，返回 `{error: ...}`"   | §05        |
| Linter     | Promptfoo / 自家校验器             | §10        |

如果你现在写 prompt 还是直接在 ChatGPT 网页框里改，那就像在生产环境直接 vim 改 Python——能跑，但等于没有工程。

## 7. 一段可运行的代码：把上面所有东西串起来

```python
# pip install anthropic
import anthropic

client = anthropic.Anthropic()

# Layer 1: System
SYSTEM = """你是一个谨慎的中文情感分析助手。
- 只输出 JSON：{"sentiment": "positive|negative|neutral", "confidence": 0.0-1.0}
- 不要解释、不要寒暄
- 信心 < 0.5 时 sentiment 必须是 "neutral"
"""

# Layer 3: Few-shot
EXAMPLES = [
    ("这家餐厅服务很差，再也不来了。",
     '{"sentiment": "negative", "confidence": 0.95}'),
    ("还行吧，没什么特别的。",
     '{"sentiment": "neutral", "confidence": 0.7}'),
    ("超出预期！强烈推荐！",
     '{"sentiment": "positive", "confidence": 0.95}'),
]

def build_messages(user_text: str):
    msgs = []
    for ex_in, ex_out in EXAMPLES:
        msgs.append({"role": "user", "content": ex_in})
        msgs.append({"role": "assistant", "content": ex_out})
    msgs.append({"role": "user", "content": user_text})
    return msgs

def analyze(text: str) -> dict:
    resp = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=128,
        system=SYSTEM,
        messages=build_messages(text),
        temperature=0,  # 评测期间用 0 锁定输出
    )
    import json
    return json.loads(resp.content[0].text)

if __name__ == "__main__":
    print(analyze("味道一般，但价格还能接受。"))
```

这段 30 行的代码就用上了：

- Layer 1 system prompt 定义角色和输出契约
- Layer 3 few-shot 示例
- Layer 5 用户输入隔离在 messages 里
- Temperature=0 让评测可复现
- JSON 解析失败会抛异常 → 在 §05 教怎么处理

## 8. 学习路径

| 你的状态                                | 推荐路径                                          |
| ----------------------------------- | --------------------------------------------- |
| 完全新手，连 system / user 都没分清            | §02 → §03 → §05 → §08，跳过 §04 §07              |
| 会写 prompt 但效果不稳定                    | §05 → §10 → §03，重点是评测                          |
| 在做 agent / workflow                 | §02 → §05 → §06 → §09，结合 [../agents/](../agents/README.md) |
| 在做多模型 / 跨厂商部署                       | §07 → §08，重点 prompt 移植                         |
| 在做 LLM 安全                           | §09 → §05 → §06，结合即将出的 `../llm-security/`     |
| 想建立团队 prompt 工程规范                   | §08 → §10，外加 [../eval/](../eval/README.md)    |

## 常见坑

1. **把 prompt 当一次性消费品**：每次任务都从零写，没有沉淀、没有版本。一年后回看自己半年前的 prompt，连为什么那样写都说不清。
2. **沉迷"魔法咒语"**：相信 "take a deep breath"、"I'll tip $200"、"think very carefully" 这种来路不明的咒语。它们偶尔在弱模型上有效，但**不是 prompt 工程的核心**——结构化设计才是。
3. **混淆 prompt 工程和微调的边界**：遇到模型答错就想"是不是要微调"。99% 的情况是 prompt 没写对。先用 §10 的方法证明 prompt 已经达到天花板，再考虑微调。
4. **不做评测就改 prompt**：手动测两条用例就上线，三天后用户报错才发现旧 case 也回归了。Prompt 改一行就能上线 = 玄学，必须配回归集。
5. **忽视模型差异**：照搬 GPT 的 prompt 给 Claude 用，效果差 20% 还以为是 Claude 弱。每家模型有 prompt 偏好，§07 详述。

## 下一步

- [02 · 基础：Role / Instruction / Format](./02-basics.md) — 拆解一个标准 prompt 的 4 个组件
- [10 · Prompt 评测与迭代](./10-evaluation.md) — 在写更多 prompt 之前，先建立评测能力
- [../agents/01-overview.md](../agents/01-overview.md) — Agent 视角下 prompt 的位置
- [../README.md](../README.md) — 仓库总目录
