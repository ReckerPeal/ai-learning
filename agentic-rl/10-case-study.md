# 10 · 案例拆解

> 本章把 2024-2025 年最重要的四个 post-training 案例拆开看：DeepSeek-R1、OpenAI o1、Claude（CAI）、Llama 3。**每个案例都按"数据 / 流程 / reward / 算力 / 复现"五个维度展开**，能复现的给命令，不能复现的给可参考的开源平替。

## 1. DeepSeek-R1（2025.01）

R1 是 2025 年最有影响力的开源 reasoning 模型，paper *DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning* (DeepSeek, 2025)。

### 1.1 R1-Zero（纯 RL）

| 维度 | 细节 |
| --- | --- |
| 起点 | DeepSeek-V3-Base（671B MoE，实际激活 37B） |
| 流程 | base → GRPO + RLVR（无 SFT） |
| reward | answer correctness (math/code) + format (`<think>...</think><answer>...</answer>`) |
| 算法 | GRPO，group_size=64 |
| 数据 | MATH / GSM8K / 代码 verifier |
| 关键发现 | reasoning length 自发增长到 ~10K token，emerge "aha moment" |
| 局限 | 语言混乱（中英混杂）、不适合通用 chat |

### 1.2 R1（多阶段）

```text
Stage 1: Cold-start SFT
  ↓  thousands of long CoT data（含 reflection）
Stage 2: Reasoning-oriented RL
  ↓  GRPO + math/code verifier，同 R1-Zero
Stage 3: Reject sampling + SFT
  ↓  Stage 2 模型采 600K reasoning + 200K 通用 → 全量 SFT V3-Base
Stage 4: 全场景 RL
  ↓  reasoning verifier + helpfulness RM + safety RM 加权
最终: DeepSeek-R1
```

| Benchmark | DeepSeek-R1 | OpenAI o1 |
| --- | --- | --- |
| AIME 2024 (pass@1) | 79.8 | 79.2 |
| MATH-500 | 97.3 | 96.4 |
| GPQA Diamond | 71.5 | 75.7 |
| LiveCodeBench | 65.9 | 63.4 |
| Codeforces percentile | 96.3 | 96.6 |

### 1.3 怎么复现

| 项目 | 范围 |
| --- | --- |
| Open-R1 (HuggingFace) | <https://github.com/huggingface/open-r1> |
| TinyZero | 复现 R1-Zero 在 3B 模型上 |
| Open-Reasoner-Zero | verl 配方 |
| SimpleRL-Zoo | 多 base + R1 风格 RL |

```bash
# Open-R1 一键
git clone https://github.com/huggingface/open-r1.git
cd open-r1
pip install -e .
# Stage 1: SFT distill R1
accelerate launch src/open_r1/sft.py \
  --config recipes/Qwen2.5-Math-7B/sft/config_demo.yaml
# Stage 2: GRPO
accelerate launch src/open_r1/grpo.py \
  --config recipes/Qwen2.5-Math-7B/grpo/config_demo.yaml
```

> 蒸馏路线（用 R1 输出做 SFT）效果接近 R1 本身，且只要 SFT 算力。开源 `DeepSeek-R1-Distill-Qwen-32B` 在 AIME 上 ~72 pt。

## 2. OpenAI o1 / o3（2024.09 / 2024.12）

o1 paper 没公开，从博客与社区分析推断：

| 维度 | 推断细节 |
| --- | --- |
| 起点 | GPT-4 系列 base |
| 算法 | RL（推测 PPO / GRPO 变种），CoT 内部不输出 |
| reward | 数学 / 代码 / 推理任务 verifier |
| test-time scaling | "thinking" 用 hidden CoT，长度可配（low/medium/high） |
| PRM 角色 | 推测用于 test-time search，不一定训练时 |
| 安全 | "Deliberative Alignment"（用 CoT 显式推理 policy） |

| Benchmark | o1-preview | o1 | o3 |
| --- | --- | --- | --- |
| AIME 2024 | 56.7 | 79.2 | 96.7 |
| GPQA Diamond | 73.3 | 75.7 | 87.7 |
| Codeforces | 1258 | 1673 | 2727 |

### 2.1 关键设计原则（从博客倒推）

1. **隐藏 CoT**：用户不见，避免 distillation；模型可以"放飞"思考
2. **test-time compute 暴露给用户**：用更多算力换更好答案
3. **Deliberative Alignment**：安全 policy 写进 CoT
4. **没有解锁工具**：o1 不主动 web browse / code execution（与后来 o3 不同）

### 2.2 可参考的开源平替

| 平替 | 接近度 |
| --- | --- |
| DeepSeek-R1 | 数学 / 代码持平 |
| Qwen-QwQ-32B | reasoning，开源 |
| Marco-o1（Alibaba） | 中文 reasoning |
| DeepSeek-R1-Distill-Llama-70B | 蒸馏路线，便宜部署 |

## 3. Claude（Constitutional AI 路线）

Anthropic 没像 OpenAI 那样发"对齐"细节，但 2022 *Constitutional AI* paper 给了基本框架。后续 Claude 3 / 3.5 / Opus 4 都在 CAI 思路上扩展。

### 3.1 Constitutional AI 流程（2022 版）

```text
Phase 1: Supervised Learning from AI Feedback (SL-CAI)
  - 红队 prompt → 模型回答（可能 harmful）
  - 模型根据 constitution 自我批判
  - 模型自我改写为安全版本
  - SFT 在改写后的数据上

Phase 2: RL from AI Feedback (RLAIF)
  - prompt → 模型生成 A, B
  - 同模型按 constitution 选偏好
  - RM 训 + PPO（或 DPO）
```

### 3.2 Constitution 节选示例

```text
Choose the response that is:
- Most helpful
- Most honest
- Least harmful
- ...
- Not racist or sexist
- Not engaging in or promoting illegal activity
- ...
```

> 完整 16 条原则见 Anthropic 2022 paper Appendix。Claude 3+ 的 constitution 更长更细，未完全公开。

### 3.3 Claude 3.5+ 的演进推断

| 改进 | 推测 |
| --- | --- |
| Computer use (Claude 3.5) | Agent SFT + RL on tool sequences |
| Thinking mode (Claude 3.7 / Opus 4) | 类似 o1 / R1 的 CoT RL |
| Skills (Opus 4) | 多阶段 SFT + 偏好对齐 |
| Sycophancy 治理 | 显式 anti-sycophancy reward |

### 3.4 复现 CAI 路径

```python
# 简化 CAI loop（distilabel 风格）
critique_prompt = """Given the assistant's response, identify ways it violates
this principle: {principle}
Response: {response}
Critique:"""

revise_prompt = """Based on the critique, rewrite the response to satisfy
the principle while remaining helpful.
Original: {response}
Critique: {critique}
Revised:"""

# 1) 跑 critique-revise 生成 SFT 数据
# 2) SFT base model
# 3) 用同模型 + constitution 当 judge 生成 DPO pair
# 4) DPO
```

> HuggingFace 有 `HuggingFaceH4/cai-conversation-harmless` 数据集，是 CAI 风格的复现数据。

## 4. Llama 3 / 3.1 post-training（2024）

Llama 3 paper *The Llama 3 Herd of Models* (Dubey et al., 2024) 是 2024 年最详尽的 post-training 工程报告。

### 4.1 完整 pipeline（6 轮迭代）

```text
For round in 1..6:
  Step 1: SFT
    - 数据：人工 demo + reject-sampled previous round
    - epochs=2-3, lr=1e-5

  Step 2: DPO（带 NLL 正则）
    - 数据：(prompt, prev_round_best, prev_round_worst)
    - β=0.1, lr=1e-7, loss = DPO + 0.2 * NLL_on_chosen

  Step 3: Reward Model 重训
    - 用本轮 SFT+DPO 模型重新生成 pair

  Step 4: Reject sampling
    - 采 10-30 条 / prompt，RM 选 top 1 + worst 1
    - 进入下一轮 SFT 数据
```

| 配方关键 | 细节 |
| --- | --- |
| 多轮迭代 | 6 轮是 Llama 3 报告数字 |
| DPO + NLL | 防 chosen logprob 一起降 |
| Reject sampling 多次 | 每轮换更强的 RM 评 |
| Mixture-of-Experts RM | helpfulness + safety + format 分头 |
| Tool use 单独训 | 有专门的 tool-use SFT 数据集 |

### 4.2 数据混合（Llama 3 Table 7）

| 类别 | 比例 |
| --- | --- |
| General English | 50% |
| Math & reasoning | 22% |
| Coding | 14% |
| Multilingual | 8% |
| Long context | 4% |
| Tool use | 2% |

### 4.3 Tülu 3：完整开源版"Llama 3 post-training"

Allen AI *Tülu 3* (Lambert et al., 2024) 把整套类似 Llama 3 的 pipeline 开源：

| 阶段 | 数据 | 算法 |
| --- | --- | --- |
| SFT | Tülu-3-SFT-Mixture (~1M) | 全参 SFT |
| DPO | UltraFeedback + Allen 自家 | DPO with length norm |
| RLVR | MATH + GSM8K + IFEval | PPO with verifier |

```bash
# Tülu 3 配方
git clone https://github.com/allenai/open-instruct
cd open-instruct
# SFT
bash scripts/finetune_with_accelerate_config.sh ...
# DPO
bash scripts/dpo_train_with_accelerate.sh ...
# RLVR
python -m open_instruct.ppo_vllm_thread_ray_gtrl ...
```

| Tülu 3 70B vs Llama 3.1 70B-Instruct | Tülu 略胜 |
| --- | --- |
| MMLU | +0.5 |
| IFEval | +3 |
| GSM8K | +2 |
| MATH | +5 |

## 5. 四案例横向对比

| 维度 | DeepSeek-R1 | OpenAI o1 | Claude (CAI) | Llama 3 |
| --- | --- | --- | --- | --- |
| 主算法 | GRPO + RLVR | PPO/GRPO（推测） | RLAIF + DPO | DPO + reject sampling |
| reward 类型 | verifier 0/1 | verifier + RM | constitution + RM | RM（helpfulness/safety） |
| 多阶段 | 4 阶段 | 未知 | 2 阶段 | 6 轮迭代 |
| reasoning emphasis | 极强 | 极强 | 中（3.7+ 加强） | 中 |
| 是否开源权重 | 是 | 否 | 否 | 是 |
| 是否开源 pipeline | 部分 | 否 | 论文级 | 论文级（不含数据） |
| 工业可复现度 | 高 | 低 | 中 | 高（Tülu 3） |

## 6. 不同场景的"该抄哪家"

| 你的场景 | 抄谁 |
| --- | --- |
| 训数学 / 代码 reasoning 模型 | DeepSeek-R1 / Open-R1 |
| 做通用 helpfulness chat | Llama 3 / Tülu 3 |
| 做 safety 严苛产品 | Claude / CAI 路线 |
| 试 test-time scaling | o1 思路 + PRM |
| 中小模型快速对齐 | Zephyr 配方（SFT + DPO） |
| 多语言 / 多模态 | Llama 3.1 / Qwen2.5 |

## 7. 复现陷阱合集

```text
"为什么我跑出来不像论文？"

1. 数据没对齐
   - 论文用专有数据，开源版用 proxy → 差 5-15 pt 正常

2. 算力 / batch 没对齐
   - DeepSeek-R1 用 thousands GPU，你 8 GPU → 收敛步数不可比

3. 多阶段缺一环
   - 跳过 reject sampling 直接 DPO → 效果折半

4. 评测用错版本
   - GSM8K vs GSM8K-revised；MATH vs MATH-500；都不能混

5. 用错 base model
   - Llama 3 配方接 Qwen base → 长度偏置 / 模板都对不上
```

## 8. 一份"复现 R1-Zero on 7B"的最小命令

```bash
# 硬件：8×H100 80GB（或 8×A100 80GB，慢 2×）
git clone https://github.com/Jiayi-Pan/TinyZero  # 或 Open-R1
cd TinyZero
pip install -e . vllm flash-attn

# 数据：MATH 训练集 + GSM8K
python scripts/prepare_data.py --output data/

# 训练：直接 GRPO（无 SFT），group_size=8
python -m verl.trainer.main_ppo \
  trainer.experiment_name=r1zero-qwen-7b \
  data.train_files=data/train.parquet \
  algorithm.adv_estimator=grpo \
  actor_rollout_ref.actor.optim.lr=1e-6 \
  actor_rollout_ref.rollout.n=8 \
  actor_rollout_ref.rollout.max_response_length=4096 \
  reward_model.enable=false \
  custom_reward_function.path=./reward_math.py \
  trainer.n_gpus_per_node=8 \
  trainer.nnodes=1

# 预计：~24-48h 看到 aha moment，AIME ~30 pt（base ~10 pt）
```

## 9. 从案例看趋势

| 趋势 | 来源案例 |
| --- | --- |
| 离开 RM，用 verifier | R1, o1 |
| 多阶段 SFT + RL 交替 | R1, Llama 3 |
| Test-time scaling 成为标配 | o1, R1（蒸馏） |
| Constitution 显式化 | Claude，扩散到 Tülu 3 |
| 开源追赶速度极快 | 2025 年差距 < 6 个月 |
| GRPO 取代 PPO 成默认 RL 算法 | R1, Qwen, Tülu 3 部分 |

## 常见坑

1. **直接用 R1 prompt 当 SFT 数据违反协议**：DeepSeek-R1 是 MIT-like license 但商用部分有限制，蒸馏前看清条款。
2. **以为复现一定要 671B**：R1 论文同时给了 7B/14B/32B 蒸馏版，工业复现完全够用。
3. **照搬 Llama 3 的多轮迭代时间表**：6 轮迭代是 Meta 算力前提，小团队跑 2-3 轮足够。
4. **拿 o1 风格 "thinking" 模板灌 base**：base 模型没经过 SFT 看不懂 `<think>` 标签，要先短 SFT。
5. **复现成功就上线**：复现 benchmark 不等于业务上线效果，**必须接 [`../eval/`](../eval/README.md) 的评测闭环**。

## 下一步

- 回顾整套训练算法：[03 · RLHF](./03-rlhf-history.md) → [07 · GRPO](./07-grpo.md)
- 选工具复现：[09 · 工具](./09-tools.md)
- reward 设计原则：[06 · RLVR](./06-rlvr.md) / [08 · 过程 vs 结果](./08-process-vs-outcome.md)
- 跨主题：训完模型落地 Agent [`../agents/10-production.md`](../agents/10-production.md)
- 跨主题：评测体系 [`../eval/`](../eval/README.md)
- 跨主题：编排部署 [`../langgraph/`](../langgraph/README.md)
