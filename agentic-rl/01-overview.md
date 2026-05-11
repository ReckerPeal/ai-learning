# 01 · 概览：为什么训 Agent 模型

> 一句话：**Post-training 不是给模型灌知识，是给模型灌偏好和决策路径**。能 prompt 解决的别 SFT，能 SFT 解决的别 RL，能 DPO 解决的别 PPO。

本章是 Agentic RL 主题的总览。先理清"为什么大家都在 post-training"，再给一棵"该不该 RL"的决策树，最后把后续 9 章的角色定位讲清楚。

## 1. Post-training 演化简史（2017 → 2025）

| 年份 | 里程碑 | 关键贡献 |
| --- | --- | --- |
| 2017 | PPO 提出 (Schulman et al.) | Policy gradient 的工程稳定版 |
| 2017 | Deep RL from Human Preferences (Christiano) | 第一次把人类偏好接入 RL |
| 2020 | GPT-3 | Few-shot 能打，但还不会"听话" |
| 2022.03 | InstructGPT (Ouyang) | SFT + RM + PPO 三阶段管线奠基 |
| 2022.11 | ChatGPT 发布 | RLHF 出圈 |
| 2022.12 | Constitutional AI (Anthropic) | RLAIF 雏形，AI 反馈替代人类 |
| 2023.05 | DPO (Rafailov) | 一步推导消掉 reward model |
| 2023.10 | Zephyr-7B | 开源 DPO 第一个出圈案例 |
| 2024.02 | DeepSeekMath / GRPO | group advantage，省 critic |
| 2024.05 | Llama 3 post-training | 多轮 SFT + DPO + reject sampling |
| 2024.09 | OpenAI o1 | RL 训 reasoning 模型出圈 |
| 2024.11 | Tülu 3 | 完整开源 post-training 配方 |
| 2025.01 | DeepSeek-R1 | "纯 RL，零 SFT"也能 emerge reasoning |
| 2025+ | Agent 模型涌现 | tool-use / 多步决策成为 RL 主战场 |

记住三条主线：

1. **PPO 系** → InstructGPT、ChatGPT、Llama 2-chat
2. **DPO 系**（直接优化偏好，不要 RM）→ Zephyr、Tülu 2、Llama 3 后期
3. **RLVR / GRPO 系**（可验证奖励 + 纯 RL）→ DeepSeek-R1、o1、Qwen-QwQ

## 2. 何时应该 post-training（决策树）

```text
有具体业务场景吗？
├── 否 → 先别训，定义清楚 task 再说
└── 是 → prompt + few-shot 能稳定 ≥85% 吗？
        ├── 是 → 不要训。prompt 工程 + RAG 解决
        └── 否 → 能写出 ≥1000 条高质量"正确轨迹"吗？
                ├── 是 → SFT（先做 [../fine-tuning/03-sft.md](../fine-tuning/03-sft.md)）
                └── 否 → 能定义"好 vs 坏"偏好对吗？
                        ├── 是（成对偏好）→ DPO（§04）
                        └── 是（可验证答案对/错）→ RLVR / GRPO（§06 / §07）
                        └── 否（只有模糊评分）→ RLAIF（§05）
```

> 关键判据：**SFT 模仿一条正确路径；RL 让模型自己探索更好的路径**。如果只有一条标准答案，SFT 就够。

## 3. 几种 post-training 方法的对比

| 方法 | 数据形态 | 训练成本 | 稳定性 | 典型场景 |
| --- | --- | --- | --- | --- |
| SFT | (prompt, response) | 1× | 很稳 | 风格 / 格式 / tool 触发 |
| RM + PPO | (prompt, chosen, rejected) → RM, 然后 RL | 6-10× | 易崩 | 工业级 chat（OpenAI 早期） |
| DPO | (prompt, chosen, rejected) | 1.5× | 较稳 | 偏好对齐第一选择 |
| KTO / SimPO | 单条样本带 thumbs up/down | 1.2× | 较稳 | 没有 pair 时 |
| RLAIF | AI judge 打分生成偏好 | 2-3× | 中 | 缺人类标注 |
| RLVR | (prompt, verifier 0/1) | 3-5× | 看 reward 设计 | 数学 / 代码 |
| GRPO | group sample + verifier | 3-5× | 较稳 | reasoning 模型 |

> 引用：DPO vs PPO 训练成本约 1:5，但效果在 chat 任务上接近（Rafailov 2023；HuggingFace alignment-handbook 复现）。

## 4. 一个最小的"思路对照"代码

```python
# 用三种范式分别表达：让模型回答"What is 1+1?"
# (a) SFT：直接给标准答案
sft = {"prompt": "What is 1+1?", "response": "1+1=2."}

# (b) DPO：给好坏对
dpo = {
    "prompt": "What is 1+1?",
    "chosen":   "1+1=2.",
    "rejected": "Maybe 3? I'm not sure.",
}

# (c) RLVR：给 verifier
def reward(prompt, response):
    return 1.0 if "2" in response else 0.0  # 可验证奖励
rlvr = {"prompt": "What is 1+1?", "reward_fn": reward}
```

三种数据形态分别对应"模仿 / 排序 / 评分"。**先看你能拿到哪种数据，再选方法**。

### 4.1 数据可获取性的现实

| 你能拿到 | 推荐方法 |
| --- | --- |
| 1K-10K 人写正确答案 | SFT |
| 30K+ 偏好对（chosen/rejected） | DPO |
| 1K 偏好对 + AI judge 可调 | RLAIF + DPO |
| 可程序判别对/错 | RLVR + GRPO |
| 多步任务环境（gym 风格） | PPO / GRPO |
| 只有用户 thumbs up/down | KTO |

> 经验：**问"我能 0/1 自动判别答案对吗"**——能的话直接 RLVR；不能但能"二选一"，DPO/RLAIF；都做不到，先回去 SFT。

## 5. Agent 模型为什么需要 RL

Chat 模型 = 单轮回答好；Agent 模型 = **多步决策好**。多步决策的特点：

| 维度 | Chat | Agent |
| --- | --- | --- |
| 时间步 | 1 | N（含 tool call） |
| 奖励 | 即时 | 稀疏 + 延迟 |
| 错误传播 | 无 | 雪崩（上一步错下一步全错） |
| 数据获取 | 容易 | 难（需要 rollout） |
| 评测 | BLEU / 偏好 | success rate / 子任务通过率 |

SFT 教模型"模仿一条 trace"，但生产环境的 trace 是发散的，靠 SFT 列举所有路径不现实——RL 让模型在交互中找路径。这就是 Llama 3 post-training 里 reject sampling + DPO 反复迭代的动机（Llama 3 paper Table 8）。

### 5.1 Agent RL 的额外难点

```text
普通 chat RLHF：
  user → assistant → reward
  单步，1 个奖励信号

Agent RL：
  user → assistant → tool_call → tool_result
        → assistant → tool_call → tool_result
        → ...
        → final_answer → reward（甚至失败了才有 -1）
  多步、稀疏、需 rollout
```

| 难点 | 普通 RLHF 的应对 | Agent RL 的应对 |
| --- | --- | --- |
| Credit assignment | 末端 reward 反传 | 用 PRM 或子任务奖励（§08） |
| Off-policy 数据 | RM 静态评 | rollout 真实环境 |
| 工具失败 | N/A | reward 包含工具错误处理 |
| 多轮长度爆炸 | max_tokens 截断 | 限制 max turns + 累计 cost |

## 6. 资源估算（粗略）

以 7B 模型为例：

| 阶段 | 显存（每 GPU） | 单 epoch 时间（H100×8） | 数据量 |
| --- | --- | --- | --- |
| SFT（LoRA） | 24-40 GB | 2-6h | 50K-500K |
| SFT（全参） | 80 GB | 8-24h | 50K-500K |
| DPO（LoRA） | 32-48 GB | 4-10h | 30K-100K |
| PPO | 80 GB × 2 模型 | 24-72h | 10K-50K |
| GRPO | 80 GB（省 critic） | 12-48h | 10K-50K |

> 数字来自 TRL examples、Tülu 3 paper Appendix C、DeepSeekMath。具体见 [09 · 工具](./09-tools.md)。

```yaml
# 一份"全栈" post-training 的配方草图（后面章节展开）
sft:
  data: tulu-3-sft-mixture
  lr: 2e-5
  epochs: 2

dpo:
  data: ultrafeedback_binarized
  beta: 0.1
  lr: 5e-7
  epochs: 1

grpo:
  data: MATH + GSM8K
  group_size: 16
  verifier: math_verify
  steps: 2000
```

## 7. 本主题各章的角色

| 章节 | 解决什么 |
| --- | --- |
| §02 SFT 基础 | 模型的"对话礼仪和工具使用"地基 |
| §03 RLHF/PPO 历史 | 为什么有 RM，PPO 都怎么崩的 |
| §04 DPO | 工业首选偏好对齐 |
| §05 RLAIF | 没人类标注怎么办 |
| §06 RLVR | reward 怎么设计才不被 hack |
| §07 GRPO | reasoning 模型新范式 |
| §08 过程 vs 结果 | PRM/ORM 之争 |
| §09 工具 | TRL / verl / OpenRLHF 怎么选 |
| §10 案例 | DeepSeek-R1 / o1 / Llama 3 拆解 |

### 7.1 一份"全链路成本"参考（7B 模型上线）

| 阶段 | 数据 | GPU 时（H100×8） | $（按 $2/GPU-hour） |
| --- | --- | --- | --- |
| 收集 / 清洗 SFT 数据 | 100K | 人工：~$5K | - |
| SFT | 100K, 3 epoch | 8h | $128 |
| 收集 / 合成 DPO pair | 30K | judge ~$200 | $200 |
| DPO | 30K, 1 epoch | 6h | $96 |
| GRPO（reasoning） | 50K problems, 2K step | 24h | $384 |
| 评测（benchmark + 业务） | - | 4h | $64 |
| 总计 | - | ~40 GPU h | **~$5.9K** |

> 真实 R1 / o1 / Llama 3 量级的训练成本在 $1M-$10M+。本表是"小团队复现一个能用的 7B 对齐模型"的最小预算。

## 8. Reward Hacking 警告（先剧透）

```python
# 一个经典 reward hacking 例子
# 想训"输出更礼貌"，reward = 含 "please/thank you" 的次数
# 训练后模型输出：
"Please please please please please thank you thank you 1+1=please 2."
```

reward 设计是后面 §06 / §08 的核心。**只要 reward 不完美，模型一定会找最短路径榨干它**。这是 RL 的天敌也是魅力来源。

## 9. 在哪一步该停？

```text
"什么时候算训完了" 决策序列：

eval 在三个集合上都达到目标 → 停
  ├── 业务集（你自己的）：必须升
  ├── 通用 benchmark（MMLU/IFEval）：不能掉超过 1-2 pt
  └── 安全集（如 BeaverTails / HarmBench）：不能涨 unsafe rate

否则：
  ├── reward 在涨但 eval 不动 → reward hacking，回去改 reward
  ├── eval 在涨但 reward 没涨 → 巧合 / 数据泄露，可疑
  └── 都没涨 → 数据 / lr / 模型选错，回去 §03/§04 检查
```

| 训完检查 | 工具 |
| --- | --- |
| 灾难性遗忘 | MMLU / HellaSwag / ARC 前后对比 |
| Sycophancy | SycophancyBench / Anthropic eval |
| 安全 | BeaverTails / HarmBench / SafetyBench |
| 业务 | 自建 eval set，分布覆盖 |
| 长尾 / 红队 | 人工抽样 100-500 条 |

## 常见坑

1. **业务没定义就想 RL**：连"成功"都不能 0/1 量化，谈何 reward？先回 [../eval/](../eval/README.md) 做评测。
2. **拿 RAG 该解的问题去训 RL**：模型"不知道某事"是知识问题，RL 帮不上。RAG / 检索 优先（[../rag-advanced/](../rag-advanced/README.md)）。
3. **跳过 SFT 直接 RL**：除非你是 R1-Zero 实验，否则没 SFT base 的 RL 基本训不动。Base 模型连 chat template 都不会用。
4. **DPO 也是 RL（不是）**：DPO 数学上是 RL 的解析解，但工程上更像有监督学习。**易混淆但要分清**。
5. **以为开源 = 配方完整**：DeepSeek-R1 开了权重但训练 pipeline 细节没全公开。复现需要自己摸超参（详见 [§10](./10-case-study.md)）。

## 下一步

- 把 SFT 基础打牢：[02 · Agent SFT 基础](./02-sft-basics.md)
- 想看 RLHF 怎么来的：[03 · RLHF 简史与 PPO](./03-rlhf-history.md)
- 直接上手最快的偏好对齐：[04 · DPO](./04-dpo.md)
- 训 reasoning 模型：[07 · GRPO](./07-grpo.md)
- 跨主题：先看 SFT 基础 [`../fine-tuning/03-sft.md`](../fine-tuning/03-sft.md)
- 跨主题：评测闭环 [`../eval/`](../eval/README.md)
