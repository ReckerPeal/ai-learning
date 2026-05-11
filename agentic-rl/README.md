# Agentic RL 深度

> 别一上来就 RL。先穷尽 prompt、再 SFT、最后才轮到 RLHF / DPO / GRPO。本主题把 post-training 三件套（SFT → 偏好对齐 → 可验证奖励）拆到工程化可复现的颗粒度。

2024 年之前业界还在争 RLHF 是不是必需，2025 年 DeepSeek-R1 把"用 RL 把 base 模型推到 reasoning"这件事拍到桌面，OpenAI o1 / Claude 思考模型让 RL post-training 成为大模型标配。本主题面向已经会 SFT、想搞懂"为什么 ChatGPT 比 base 模型有用"以及"怎么训一个会用工具的 Agent"的工程师。

**本主题不会教你**：

- pre-training（这是 post-training 主题，不训 base 模型）
- 把 RL 当成"魔法"用来灌知识——能 RAG 解决的别 RL（[../rag-advanced/](../rag-advanced/README.md)）
- 没有 reward model / verifier 就盲跑 PPO（[§06](./06-rlvr.md)、[§08](./08-process-vs-outcome.md) 会拒绝这种做法）
- 手撸 PPO 数学推导（去看 Sutton & Barto 第 13 章）

**本主题会教你**：

- 怎么判断「该不该上 RL」——决策树而非感觉
- Agent SFT 的数据形态（ReAct trace / tool-call sequence）与 loss masking 细节
- RLHF 演化简史：PPO → DPO → RLAIF → RLVR → GRPO 的为什么
- DPO / GRPO 真正可跑的 TRL 配置 + 训练曲线解读
- 过程监督 vs 结果监督：PRM / ORM 怎么选
- TRL / verl / OpenRLHF 选型矩阵
- DeepSeek-R1 / o1 / Claude / Llama 3 post-training 案例拆解

## 章节索引

1. [01 · 概览：为什么训 Agent 模型](./01-overview.md) — Post-training 演化简史，什么时候不该训，prompt/RAG/SFT/RL 决策树。
2. [02 · Agent SFT 基础](./02-sft-basics.md) — ReAct / tool-calling trace 数据格式、loss masking、训练曲线解读。
3. [03 · RLHF 简史与 PPO](./03-rlhf-history.md) — InstructGPT → ChatGPT，三阶段管线，PPO 的工程坑。
4. [04 · DPO 直接偏好优化](./04-dpo.md) — DPO 原理、loss 推导、β 超参、UltraFeedback 实战。
5. [05 · RLAIF 与 Constitutional AI](./05-rlaif.md) — 用 AI 当 judge 生成偏好、Anthropic CAI 流程。
6. [06 · RLVR 可验证奖励](./06-rlvr.md) — 数学 / 代码 / 单测做 reward，reward shaping 与 hacking。
7. [07 · GRPO 与推理模型](./07-grpo.md) — DeepSeek-R1 风格、group advantage、reasoning emergent 现象。
8. [08 · 过程监督 vs 结果监督](./08-process-vs-outcome.md) — PRM vs ORM、Let's Verify Step by Step、PRM800K。
9. [09 · 训练工具选型](./09-tools.md) — TRL / verl / OpenRLHF / trlx 选型矩阵 + 命令对照。
10. [10 · 案例拆解](./10-case-study.md) — DeepSeek-R1 / o1 / Claude reasoning / Llama 3 post-training 流程还原。

## 与其他主题的关系（速查表）

| 主题 | 关系 | 引用入口 |
| --- | --- | --- |
| [../fine-tuning/](../fine-tuning/README.md) | SFT 是 RL 的地基，先看 SFT 再回来 | §01 决策树、§02 衔接 |
| [../fine-tuning/03-sft.md](../fine-tuning/03-sft.md) | response-only loss / chat template 复用 | §02 全章 |
| [../agents/](../agents/README.md) | RL 出来的模型最终落到 Agent 编排 | §10 案例 |
| [../agents/10-production.md](../agents/10-production.md) | Agentic RL 在生产侧的落地形态 | §07、§10 |
| [../agents/04-tool-use.md](../agents/04-tool-use.md) | tool-calling trace 数据格式参考 | §02 数据 |
| [../eval/](../eval/README.md) | reward model 本身是 LLM-as-judge | §04、§05、§08 |
| [../eval/04-llm-as-judge.md](../eval/04-llm-as-judge.md) | RLAIF 用 judge 评分生成偏好 | §05 全章 |
| [../eval/07-agent-eval.md](../eval/07-agent-eval.md) | Agent RL 的评测闭环 | §10 |
| [../langgraph/](../langgraph/README.md) | RL 训出的 Agent 用 LangGraph 编排 | §10 部署 |
| [../rag-advanced/](../rag-advanced/README.md) | "缺事实"用 RAG，不要 RL 灌知识 | §01 决策树 |

## 资源

**官方框架**

- HuggingFace TRL — <https://github.com/huggingface/trl>（SFT / DPO / GRPO / PPO 全家桶）
- verl（Volcano Engine RL） — <https://github.com/volcengine/verl>（DeepSeek-R1 同款）
- OpenRLHF — <https://github.com/OpenRLHF/OpenRLHF>（Ray + DeepSpeed，工业级）
- trlx — <https://github.com/CarperAI/trlx>（早期 PPO 库，已不更新但代码教学价值高）
- veRL / Open-Reasoner-Zero — 开源 R1 复现链路
- LLaMA-Factory — <https://github.com/hiyouga/LLaMA-Factory>（包了 DPO/PPO 一键跑）

**论文（必读）**

- *InstructGPT: Training language models to follow instructions with human feedback* (Ouyang et al., 2022)
- *Direct Preference Optimization* (Rafailov et al., 2023)
- *Constitutional AI: Harmlessness from AI Feedback* (Bai et al., 2022)
- *Let's Verify Step by Step* (Lightman et al., 2023) — PRM 奠基
- *DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning* (DeepSeek, 2025)
- *DeepSeekMath: Pushing the Limits of Mathematical Reasoning* (Shao et al., 2024) — GRPO 出处
- *Training language models to self-correct via Reinforcement Learning* (Kumar et al., 2024)
- *Tülu 3: Pushing Frontiers in Open Language Model Post-Training* (Lambert et al., 2024)
- *RLAIF vs RLHF: Scaling Reinforcement Learning from Human Feedback with AI Feedback* (Lee et al., 2024)
- *KTO: Model Alignment as Prospect Theoretic Optimization* (Ethayarajh et al., 2024)
- *SimPO: Simple Preference Optimization with a Reference-Free Reward* (Meng et al., 2024)

**工具 / 平台**

- Argilla — <https://argilla.io/>（偏好标注 UI）
- Distilabel — <https://github.com/argilla-io/distilabel>（合成偏好对 pipeline）
- LMSYS Arena — <https://lmarena.ai/>（人类偏好基准）
- RewardBench — <https://github.com/allenai/reward-bench>（reward model 评测）

**数据集**

- UltraFeedback — 64K 偏好对，DPO 主力（OpenBMB）
- Anthropic HH-RLHF — 早期 helpfulness / harmlessness 偏好
- OpenAI summarize-from-feedback — 人类偏好经典基准
- Nectar — 7-wise 偏好 Berkeley NEST
- PRM800K — OpenAI 过程奖励数据
- MATH / GSM8K / AIME — 数学可验证奖励数据
- HumanEval / MBPP / LiveCodeBench — 代码可验证奖励
- Tülu-3-SFT-Mixture — Allen AI post-training 配方

**博客 / 解读**

- HuggingFace alignment handbook — <https://github.com/huggingface/alignment-handbook>
- Nathan Lambert *Interconnects* — RLHF 资深博主
- Sebastian Raschka *Ahead of AI* — DPO/RLHF 系列博文
- DeepSeek tech reports（R1、V3、Math）

## 阅读顺序建议

- **从 0 上手 post-training**：§01 → §02 → §03 → §04 → §09 → §10
- **已经会 SFT，想加 DPO**：§04 → §05 → §09（TRL DPOTrainer 路径）
- **想训 reasoning 模型（R1 风格）**：§01 → §06 → §07 → §08 → §10
- **不训只用，但想看懂论文**：§03 → §04 → §07 → §08 → §10
- **做 Agent 模型（tool-use）**：[../fine-tuning/](../fine-tuning/README.md) → §02 → §06 → §10 → [`../agents/10-production.md`](../agents/10-production.md)
- **赶上线产品对齐**：§04（DPO 最快）→ §09（TRL）→ §10 案例
- **研究方向**：§05 → §06 → §07 → §08 全读，关注论文复现

**仓库索引**：[../README.md](../README.md)
