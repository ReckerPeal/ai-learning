# 01 · 概览：何时微调

> 微调是工具，不是信仰。九成"我要微调一个模型"的需求，先用 prompt 工程或 RAG 都能解决，而且更便宜更快。

## 1. 三选一决策树：Prompt / RAG / 微调

先看问题类型，再选方案。错把"知识更新"问题做成微调，是新手最常见的浪费。

```text
你的问题是什么？
├─ 输出风格 / 格式不稳定           → Prompt 工程 → 不行再 SFT
├─ 模型缺最新事实 / 私有知识        → RAG（永远先试 RAG）
├─ 模型缺领域 reasoning / 模式      → SFT
├─ 输出有偏好（A 比 B 好）          → DPO / KTO
├─ 多步交互 / 工具调用              → SFT + Agentic RL（高级）
└─ 模型太大太慢                    → 蒸馏到小模型（也是 SFT）
```

| 场景 | 首选 | 次选 | 不要做 |
| --- | --- | --- | --- |
| 客服回复风格统一 | Few-shot prompt | SFT | 全参微调 |
| 公司内部文档问答 | RAG | RAG + SFT 检索 | 只微调 |
| 代码补全（公司私有库 API） | RAG | SFT 1k 样本 | RLHF |
| 法律 / 医疗合规输出 | SFT + 评测 | RAG 兜底 | 只 prompt |
| JSON 结构化输出 | Prompt + schema 校验 | 小规模 SFT | 大规模 SFT |
| 中文角色扮演 | SFT | DPO 调风格 | RAG |
| 数学 reasoning | SFT + RL（GRPO） | Prompt CoT | RAG |
| 蒸馏 GPT-4 到 7B | SFT（蒸馏） | LoRA | Prompt |

> 决策树详见 [../rag-advanced/](../rag-advanced/README.md) 和 [../agents/](../agents/README.md)。

## 2. 微调真正解决什么

| 能力 | 是否适合微调 | 解释 |
| --- | --- | --- |
| 风格 / 语气 | 强适合 | "客服式回答""法律严谨语调" |
| 输出格式（JSON / XML） | 强适合 | 但要先试 prompt + 校验 |
| 领域 reasoning 模式 | 强适合 | 医疗诊断流程、代码 review 模式 |
| 工具调用（tool-use） | 强适合 | 让模型学会"何时调哪个工具" |
| 速度（蒸馏） | 强适合 | 大模型蒸到小模型 |
| 最新事实 / 实时信息 | 不适合 | 用 RAG。微调进去的事实会过时 |
| 海量百科知识 | 不适合 | 模型容量是有限的，会遗忘别的 |
| 一次性的简单任务 | 不适合 | 直接 prompt 就行 |

**核心一句话**：微调改"行为模式"，不改"知识库"。需要新知识 → RAG；需要新行为 → 微调。

## 3. 微调成本结构

很多人只盯 GPU 钱，忽略了真正的大头是**数据 + 评测**。

| 成本项 | 占比（典型） | 说明 |
| --- | --- | --- |
| 数据准备 | 40-60% | 标注、清洗、合成、review |
| 算力（GPU 小时） | 10-25% | LoRA 不贵，全参才贵 |
| 评测体系搭建 | 15-25% | 自动 + 人工，必须要做 |
| 部署 / 监控 | 5-15% | 推理引擎、灰度、回滚 |
| 迭代成本（数据飞轮） | 持续 | 上线后才是开始 |

| 微调档位 | 算力（参考） | 适用 |
| --- | --- | --- |
| 7B LoRA（QLoRA 4-bit） | 单卡 24GB（4090） | 大多数业务 |
| 7B 全参 | 4×A100 80G | 没必要，先试 LoRA |
| 13B LoRA | 单卡 40GB（A100） | 中等规模 |
| 70B QLoRA | 2×A100 80G | 高质量需求 |
| 70B 全参 | 16×H100 起 | 巨头玩 |

## 4. 全参 vs PEFT vs RLHF vs DPO 速览

| 方法 | 简介 | 数据要求 | 算力 | 何时用 |
| --- | --- | --- | --- | --- |
| Full SFT（全参微调） | 训所有参数 | 1k-100k+ 指令对 | 高 | 资源充足、彻底改模型 |
| LoRA / QLoRA | 训低秩 adapter | 同上 | 低（10-30%） | 默认首选 |
| RLHF（PPO） | 用奖励模型反馈 | 偏好对 + RM 数据 | 极高 | 大公司做 alignment |
| DPO | 直接从偏好对优化，省 RM | 几千-几万偏好对 | 中 | 调风格 / 安全 |
| KTO | 二元偏好（好/不好） | 比 DPO 灵活 | 中 | 数据偏好难标对 |
| ORPO | SFT + DPO 合并 | 偏好对 | 中 | 想一步到位 |
| GRPO | 无 critic 的 RL | 可验证奖励 | 高 | 数学/代码 reasoning |

详见后续：[03 · SFT 基础](./03-sft.md)、[04 · PEFT 全家桶](./04-peft.md)。

## 5. 微调 vs 上下文学习（in-context learning）

```python
# 不要先想"我要微调"。先量化 ICL（few-shot）能不能解决。

import anthropic

client = anthropic.Anthropic()

few_shot_examples = """
用户：今天天气怎么样？
助手：{"intent": "weather", "city": null}

用户：北京明天下雨吗？
助手：{"intent": "weather", "city": "北京"}

用户：帮我订票
助手：{"intent": "booking", "city": null}
"""

def classify(user_input: str) -> str:
    msg = client.messages.create(
        model="claude-opus-4-5",
        max_tokens=100,
        system="你是意图分类器，输出 JSON。",
        messages=[
            {"role": "user", "content": few_shot_examples + f"\n用户：{user_input}\n助手："},
        ],
    )
    return msg.content[0].text

print(classify("上海的温度多少"))
```

| 维度 | ICL（few-shot） | 微调 |
| --- | --- | --- |
| 启动成本 | 几乎为 0 | 数据 + 训练 + 评测 |
| 单次推理成本 | 高（context 长） | 低（context 短） |
| 长尾效果 | 差（容易漂移） | 好 |
| 修改成本 | 改 prompt 即可 | 重新训练 |
| 上限 | 受限于 context | 高 |
| 何时合适 | <10k 调用/天 | >10k 调用/天 |

**经验**：QPS 高的稳定任务才划得来微调。短期实验全用 ICL。

## 6. 学习路径建议

| 阶段 | 目标 | 重点章节 |
| --- | --- | --- |
| 入门 | 跑通一个 LoRA | §02 数据 + §04 PEFT + §05 框架 |
| 进阶 | 自己做评测闭环 | §07 评测 + §06 数据合成 |
| 落地 | 上线 + 数据飞轮 | §09 部署 + §10 案例 |
| 高级 | DPO / RL | §03 衔接 + [../agents/10-production.md](../agents/10-production.md) |

## 7. 不要微调的红旗清单

- 还没认真写过 prompt（长度 < 200 字）
- 没有评测集（连"什么叫做对"都说不清）
- 数据 < 100 条
- 业务知识每周都在变
- 团队没人会看 loss 曲线
- 老板说"微调一个 ChatGPT 给我们公司用"

碰到这些，先回去做 prompt + RAG。

## 常见坑

1. **把"模型不知道某事"当成微调问题**：99% 是 RAG 问题。微调进去的事实会和原模型冲突，且过时无法更新。
2. **数据没准备好就开训**：跑通流程不代表效果好。在 100 条上能跑通的代码，在 10k 上的训练曲线、评测全都不一样。
3. **没有 base model 对照**：训完不和 base 比，根本不知道是好了还是坏了，甚至可能在通用能力上倒退（[§07](./07-evaluation.md)）。
4. **盯着 loss 不看实际输出**：loss 0.5 → 0.3 不代表更好用。真实评测才算数。
5. **一上来就全参**：PEFT 90% 场景效果接近全参，成本低一个数量级。

## 下一步

- 数据是命：[02 · 数据：质量 > 数量](./02-data.md)
- 选 LoRA 还是全参：[04 · PEFT 全家桶](./04-peft.md)
- 评测才是真本事：[07 · 评测：不要只看 loss](./07-evaluation.md)
- 端到端案例：[10 · 案例](./10-case-study.md)
- 何时不该微调：[../rag-advanced/README.md](../rag-advanced/README.md)
