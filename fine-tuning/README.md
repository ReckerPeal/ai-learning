# 模型微调

> 微调不是万能药。先问"何时该微调"，再谈"怎么微调"。本主题聚焦工程化落地：数据、框架、评测、部署，全链路给可复现命令。

业界对微调的最大误解是把它当成"给模型灌知识"——99% 的"模型不知道某事"应该用 RAG 解决，而不是微调。微调真正解决的是**风格、格式、领域语气、tool-use 触发模式**这类「过程性」能力。本主题面向已经会用 OpenAI / 开源模型 API、想自己训一个专属模型的工程师。

**本主题不会教你**：

- 从 0 训练一个基础模型（那是 pre-training，本主题只做 post-training）
- 手撸 Transformer 数学推导（去看 [Karpathy nanoGPT](https://github.com/karpathy/nanoGPT)）
- 没有评测就盲调超参（[§07](./07-evaluation.md) 会拒绝这种做法）

**本主题会教你**：

- 怎么判断「该不该微调」——决策树而非感觉
- 数据准备的工程化路径：质量 > 数量
- LoRA / QLoRA / DoRA / 全参的取舍与可复现命令
- 微调评测的正确姿态：benchmark + domain eval + A/B + 灾难性遗忘检测
- 微调→量化→部署的端到端链路

## 章节索引

1. [01 · 概览：何时微调](./01-overview.md) — Prompt / RAG / 微调三选一决策树，微调真正解决什么、不解决什么。
2. [02 · 数据：质量 > 数量](./02-data.md) — 1000 条好数据 > 100K 噪声，数据格式、清洗、多样性、license。
3. [03 · SFT 基础](./03-sft.md) — Cross-entropy on response only、loss masking、关键超参与曲线解读。
4. [04 · PEFT 全家桶（LoRA / QLoRA）](./04-peft.md) — rank/alpha/target_modules、QLoRA 4-bit、DoRA、多 LoRA 服务。
5. [05 · 训练框架](./05-frameworks.md) — TRL / Axolotl / LLaMA-Factory / Unsloth / DeepSpeed 选型矩阵。
6. [06 · 数据合成](./06-synthetic-data.md) — Self-Instruct / Evol-Instruct / Magpie / 蒸馏，license 与多样性。
7. [07 · 评测：不要只看 loss](./07-evaluation.md) — 灾难性遗忘、benchmark + domain eval + A/B 抽样。
8. [08 · 量化](./08-quantization.md) — 训练时 vs 推理时量化，QLoRA / GPTQ / AWQ / GGUF 的边界。
9. [09 · 部署微调模型](./09-deployment.md) — 合并权重、格式转换、vLLM / TGI / Ollama 路径与多 LoRA 共享。
10. [10 · 案例：从 0 微调一个领域 Agent](./10-case-study.md) — 客服意图分类 + tool-use 端到端可复现 demo。

## 与其他主题的关系（速查表）

| 主题 | 关系 | 引用入口 |
| --- | --- | --- |
| [../rag-advanced/](../rag-advanced/README.md) | 解决"最新事实"用 RAG，不要用微调 | §01 决策树 |
| [../prompt-engineering/](../prompt-engineering/README.md) | 微调前先穷尽 prompt 空间 | §01 决策树 |
| [../eval/](../eval/README.md) | 微调必须有评测闭环 | §07 全章 |
| [../agents/](../agents/README.md) | 微调一个 Agent base model | §10 案例 |
| [../agents/10-production.md](../agents/10-production.md) | Agentic RL 是微调高级形态 | §03 衔接 |
| [../llm-inference/04-quantization.md](../llm-inference/04-quantization.md) | 推理时量化与微调时量化的边界 | §08 |
| [../llm-inference/](../llm-inference/README.md) | 微调权重最终要落地到推理引擎 | §09 部署 |
| [../langgraph/](../langgraph/README.md) | 微调后的模型嵌入编排 | §10 部署 |

## 资源

**官方框架与文档**

- HuggingFace TRL — <https://github.com/huggingface/trl>（SFT / DPO / GRPO 全家桶）
- HuggingFace PEFT — <https://github.com/huggingface/peft>（LoRA / QLoRA / DoRA / IA³）
- Axolotl — <https://github.com/axolotl-ai-cloud/axolotl>（YAML 配置驱动）
- LLaMA-Factory — <https://github.com/hiyouga/LLaMA-Factory>（图形化 + 中文友好）
- Unsloth — <https://github.com/unslothai/unsloth>（单卡训练加速 2-5×）
- DeepSpeed — <https://github.com/microsoft/DeepSpeed>（多机多卡 / ZeRO）
- torchtune — <https://github.com/pytorch/torchtune>（PyTorch 官方 post-training）

**数据集（开箱即用）**

- LIMA — 1K 高质量 SFT，证明"质量 > 数量"
- Alpaca / Alpaca-GPT4 — Self-Instruct 经典
- WizardLM / Evol-Instruct — 指令复杂化
- OpenHermes 2.5 — 1M 综合 SFT
- UltraFeedback — DPO/RLHF 偏好数据
- Magpie — 用模型自身生成 SFT 数据
- HuggingFaceH4/no_robots — 人工写作高质量小集

**数据工具**

- Argilla — <https://argilla.io/>（标注 + 反馈循环）
- Distilabel — <https://github.com/argilla-io/distilabel>（合成 pipeline）
- cleanlab — <https://github.com/cleanlab/cleanlab>（标签噪声检测）
- LLM-DataHub — 数据集 license 速查

**评测**

- lm-evaluation-harness — <https://github.com/EleutherAI/lm-evaluation-harness>
- OpenCompass — <https://github.com/open-compass/opencompass>
- AlpacaEval / MT-Bench / Arena-Hard — 指令跟随对比
- 灾难性遗忘检测：MMLU / HellaSwag 前后对比

**论文（必读）**

- *LoRA: Low-Rank Adaptation* (Hu et al., 2021)
- *QLoRA: Efficient Finetuning of Quantized LLMs* (Dettmers et al., 2023)
- *DoRA: Weight-Decomposed Low-Rank Adaptation* (Liu et al., 2024)
- *LIMA: Less Is More for Alignment* (Zhou et al., 2023)
- *Direct Preference Optimization* (Rafailov et al., 2023)
- *Self-Instruct* (Wang et al., 2022)
- *InstructGPT* (Ouyang et al., 2022)

**算力 / 实践参考**

- HuggingFace 训练教程合集 — <https://huggingface.co/learn/cookbook>
- Sebastian Raschka *LLMs from Scratch* — 配套博客系列
- Anyscale fine-tuning playbook — <https://www.anyscale.com/blog>

## 阅读顺序建议

- **第一次微调**：§01 → §02 → §04 → §05 → §07 → §10
- **已经会 LoRA，想吃透**：§03 → §06 → §07 → §08
- **只部署别人的权重**：§08 → §09
- **做领域 Agent**：§01 → §02 → §04 → §07 → §10 → [`../agents/`](../agents/README.md)
- **赶上线**：§01 → §05（Unsloth/LLaMA-Factory）→ §07 → §09
- **想进阶到 DPO / RL**：完成 §03 → §07 后转 [`../agents/10-production.md`](../agents/10-production.md) Agentic RL

**仓库索引**：[../README.md](../README.md)
