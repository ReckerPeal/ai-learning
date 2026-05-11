# 09 · 训练工具选型

> 2025 年 RL 训练工具仍在快速迭代。**选 TRL 上手快、选 verl 性能强、选 OpenRLHF 工业级、选 LLaMA-Factory 图形化**。本章给一个能照着选的矩阵。

## 1. 主流框架一览

| 框架 | star | 强项 | 弱项 | 主用户 |
| --- | --- | --- | --- | --- |
| **TRL** | 12K+ | 接口稳、HF 生态、文档全 | 大规模性能一般 | 学界、入门 |
| **verl** | 4K+（快涨） | 性能强、DeepSeek-R1 同款 | 上手陡 | DeepSeek、Bytedance |
| **OpenRLHF** | 5K+ | Ray + DeepSpeed 工业级 | 配置繁 | 工业 RLHF 大规模 |
| **trlx** | 4K | 早期 PPO 教学 | 维护停滞 | 历史代码 |
| **LLaMA-Factory** | 35K+ | 图形界面、中文友好、全任务 | 抽象太厚不灵活 | 业务团队 |
| **Axolotl** | 8K+ | YAML 优雅、DPO 一键 | RL 部分相对弱 | 中小团队 |
| **NeMo-Aligner** | 1K+ | NVIDIA 全栈、TensorRT 集成 | 绑 NeMo 生态 | 大企业 |
| **Open-Reasoner-Zero** | 1K+ | R1-Zero 复现 | 单一目标 | 研究复现 |

## 2. 详细选型矩阵

| 选型问题 | 推荐 |
| --- | --- |
| 1-2 GPU 入门跑通 DPO | LLaMA-Factory / Axolotl |
| 8 GPU 单机训 DPO/GRPO 7B | TRL + accelerate / Axolotl |
| 多机 16-128 GPU PPO/GRPO | verl / OpenRLHF |
| 复现 DeepSeek-R1 | verl + Open-Reasoner-Zero |
| 自定义 reward function | TRL（最简单）/ verl |
| 与 vLLM rollout 深度集成 | verl / TRL 0.12+ |
| Ray cluster 部署 | OpenRLHF |
| 中文社区 / 文档 | LLaMA-Factory |
| Production-grade safety RLHF | NeMo-Aligner / OpenRLHF |

## 3. TRL 关键接口速查

```python
from trl import (
    SFTTrainer,         # SFT
    RewardTrainer,      # RM
    DPOTrainer,         # DPO / IPO / KTO_pair / hinge
    KTOTrainer,         # KTO 单条
    ORPOTrainer,        # ORPO 合一
    PPOv2Trainer,       # PPO（新版）
    GRPOTrainer,        # GRPO（0.12+）
    OnlineDPOTrainer,   # online DPO（采 + 标 + 训 闭环）
    RLOOTrainer,        # REINFORCE Leave-One-Out（GRPO 前身）
    CPOTrainer,         # CPO
    NashMDTrainer,      # Nash-MD
)
```

| Trainer | 数据形态 | 模型数 | 显存（7B） |
| --- | --- | --- | --- |
| SFTTrainer | (prompt, response) | 1 | 1× |
| DPOTrainer | (prompt, chosen, rejected) | 2（policy + ref） | 2× |
| GRPOTrainer | (prompt, reward_fn) | 2 + verifier | 2-3× |
| PPOv2Trainer | (prompt, RM) | 4 | 4× |

```bash
# TRL 最小命令行（注意 0.12+ 提供 CLI）
trl dpo --model_name_or_path Qwen/Qwen2.5-7B-Instruct \
        --dataset_name HuggingFaceH4/ultrafeedback_binarized \
        --learning_rate 5e-7 --beta 0.1 \
        --output_dir dpo-out --use_peft --lora_r 16

trl grpo --model_name_or_path Qwen/Qwen2.5-Math-7B \
         --dataset_name HuggingFaceH4/MATH-500 \
         --reward_funcs math_verify format_boxed \
         --num_generations 8 --use_vllm
```

## 4. verl：DeepSeek-R1 同款

verl 的核心是 **hybrid engine**：训练框架（FSDP/Megatron）+ 推理框架（vLLM/SGLang）混合，rollout 用 vLLM 加速 5-10×。

```yaml
# verl 配置（PPO/GRPO 通用，简化）
trainer:
  total_epochs: 1
  project_name: r1-repro
  experiment_name: grpo-qwen-7b-math

algorithm:
  adv_estimator: grpo            # 或 gae（PPO）
  kl_ctrl:
    type: fixed
    kl_coef: 0.001

actor_rollout_ref:
  rollout:
    name: vllm
    tensor_model_parallel_size: 2
    gpu_memory_utilization: 0.5
    n: 8                          # group_size
    max_response_length: 4096
  actor:
    optim:
      lr: 1e-6
    model:
      path: Qwen/Qwen2.5-Math-7B
    fsdp_config:
      param_offload: false

reward_model:
  enable: false                   # GRPO with verifier，不要 RM
  reward_manager: math_verifier

data:
  train_files: ./data/math.parquet
  train_batch_size: 1024
  max_prompt_length: 512
```

```bash
# 启动（8 GPU 单机）
python3 -m verl.trainer.main_ppo \
    --config-path=configs --config-name=ppo_trainer \
    trainer.n_gpus_per_node=8 \
    trainer.nnodes=1
```

| verl 优势 | 数据 |
| --- | --- |
| rollout 速度 | 比 TRL 快 3-5× |
| 多机扩展 | 支持 Megatron + FSDP 混合 |
| 内置 R1 配方 | configs/ 直接抄 |
| 显存效率 | param offload + cpu offload |

## 5. OpenRLHF：Ray + DeepSpeed

OpenRLHF 把 actor / ref / RM / critic 拆成不同 Ray actor，可以分别放不同 GPU 池：

```bash
# 8 GPU 单机 PPO 配置
ray start --head
python -m openrlhf.cli.train_ppo \
    --pretrain meta-llama/Llama-3.1-8B-Instruct \
    --reward_pretrain ./rm-llama3 \
    --save_path ./ppo-llama3 \
    --micro_train_batch_size 1 \
    --train_batch_size 128 \
    --rollout_batch_size 1024 \
    --max_epochs 1 \
    --num_episodes 1 \
    --max_samples 100000 \
    --max_new_tokens 1024 \
    --actor_learning_rate 5e-7 \
    --critic_learning_rate 9e-6 \
    --init_kl_coef 0.01 \
    --zero_stage 3 \
    --bf16 \
    --flash_attn \
    --gradient_checkpointing \
    --advantage_estimator gae   # gae / grpo / rloo
```

| OpenRLHF vs verl | OpenRLHF 优势 |
| --- | --- |
| 多节点配置 | Ray 简单 |
| 异构 GPU 池 | actor/critic 不同卡 |
| 安全场景多 RM | 内置多 RM 加权 |
| 文档 | 比 verl 全 |

## 6. 跑通一个完整 SFT→DPO 流水线

```bash
# 用 alignment-handbook + accelerate
# 1) SFT
ACCELERATE_LOG_LEVEL=info accelerate launch \
  --config_file recipes/accelerate_configs/deepspeed_zero3.yaml \
  scripts/run_sft.py \
  recipes/zephyr-7b-beta/sft/config_full.yaml

# 2) DPO（在 SFT 输出上继续）
ACCELERATE_LOG_LEVEL=info accelerate launch \
  --config_file recipes/accelerate_configs/deepspeed_zero3.yaml \
  scripts/run_dpo.py \
  recipes/zephyr-7b-beta/dpo/config_full.yaml

# 3) 评测
lm-eval --model hf --model_args pretrained=./dpo-out/final \
        --tasks mmlu,arc_easy,hellaswag --batch_size 4
alpaca_eval --model_configs './dpo-out/final' --output_path eval-out/
```

## 7. 性能 / 显存对照（实测，7B + 8×H100）

| 任务 | TRL | verl | OpenRLHF |
| --- | --- | --- | --- |
| DPO 1 epoch UF | 4-6h | 3-4h | 4-5h |
| PPO 1 epoch | 24-36h | 12-18h | 14-20h |
| GRPO 1K step | 12-16h | 5-8h | 6-10h |
| 显存峰值 | 70-75 GB | 60-70 GB | 65-72 GB |
| 多机配置难度 | 中 | 中 | 易 |

> 数字来自 verl GitHub README、OpenRLHF benchmark、TRL examples。具体数字依超参/精度变化。

## 8. 选 LoRA 还是全参

| 因素 | LoRA | 全参 |
| --- | --- | --- |
| 显存 | -50%+ | 全量 |
| 速度 | 快 1.5-2× | 慢 |
| 效果 | DPO 几乎打平 | 略好 0.5-1 pt |
| 部署 | 多 adapter 共享 base | 多份完整 |
| RL 兼容性 | 都支持 | 都支持 |
| 通用能力保留 | 好 | 差 |

> DPO LoRA r=16/32 在 UltraFeedback 上跟全参差 <1 pt。GRPO LoRA 因 advantage 噪声大，全参收敛更稳，**推荐全参或 LoRA r≥64**。

## 9. 监控与可观测

```python
# 必报 metrics（Weights & Biases / TensorBoard）
{
    "train/loss": ...,
    "train/lr": ...,
    "train/grad_norm": ...,         # 0.3-3 健康
    # DPO 特有
    "rewards/chosen": ...,
    "rewards/rejected": ...,
    "rewards/margins": ...,
    "rewards/accuracies": ...,
    # PPO / GRPO 特有
    "reward/mean": ...,
    "reward/std": ...,
    "kl": ...,
    "policy/clip_ratio": ...,
    "policy/entropy": ...,
    "rollout/completion_length_mean": ...,
}
```

```bash
# wandb 集成
pip install wandb
wandb login
# trainer 自动 log（HF Trainer + WANDB_PROJECT 环境变量）
export WANDB_PROJECT=agentic-rl
```

| 必看曲线 | 异常即停 |
| --- | --- |
| reward mean | 不动 / 暴跌 |
| KL | 爆 / 持续 0 |
| completion length | 单调爆涨 |
| grad_norm | > 50 持续 |
| eval accuracy | 连续下降 3 step |

## 10. 一份"团队规模 vs 工具选型"决策表

```text
1 个工程师 + 1-2 GPU
  → LLaMA-Factory / Axolotl + 阅读 TRL examples

3-5 人小团队 + 8 GPU 单机
  → TRL 直接调 API + alignment-handbook 配方
  → SFT → DPO 是基本盘
  → 想加 RLVR：TRL 0.12+ GRPOTrainer

10+ 人 + 多机
  → verl 或 OpenRLHF（看是否复现 R1）
  → 自己写 reward_funcs / verifier
  → 持续评测接 lm-evaluation-harness

研究复现 R1 / o1
  → verl + Open-Reasoner-Zero / Open-R1 / TinyZero
  → 关注 wandb workspace 内的官方/社区 run
```

## 11. 一个常见"工具链组合"参考

```text
数据：
  Argilla（标注 UI）→ Distilabel（合成 pipeline）→ HF Hub

训练：
  alignment-handbook（SFT/DPO 配方）
  + Open-R1（GRPO/R1 配方）
  ↓
  TRL（0.12+）或 verl
  ↓
  DeepSpeed ZeRO-3 / FSDP / Megatron

评测：
  lm-evaluation-harness（通用）
  alpaca_eval（chat）
  RewardBench（RM 评测）
  自建 domain eval

部署：
  权重合并 → vLLM / SGLang / TGI
  → LangGraph / LangChain agent 编排
```

## 常见坑

1. **以为 trlx 还活着**：trlx 自 2023 起基本停更，代码教学价值在，生产用 TRL/verl/OpenRLHF。
2. **TRL 版本与 paper 对不上**：TRL 接口在 0.10 / 0.11 / 0.12 三次大改。看代码先看版本号。
3. **不开 flash-attn / liger-kernel**：训练慢 30-50%。`pip install flash-attn liger-kernel` 必装。
4. **多机 NCCL 没调**：跨机 RL 训练 NCCL 配置不当会卡住或慢 10×。OpenRLHF 文档专门有一节调 NCCL。
5. **wandb / tensorboard 都没开**：RL 训练只看 stdout 等于盲飞。崩了不知道哪 step 崩的。

## 下一步

- 看不同算法的 trainer 用法：[04 · DPO](./04-dpo.md)、[07 · GRPO](./07-grpo.md)
- 跑案例复现：[10 · 案例](./10-case-study.md)
- 工具理论支撑：[03 · RLHF](./03-rlhf-history.md)、[06 · RLVR](./06-rlvr.md)
- 跨主题：训练框架与 SFT 框架对照 [`../fine-tuning/05-frameworks.md`](../fine-tuning/README.md)
- 跨主题：训完模型怎么部署 [`../llm-inference/`](../llm-inference/README.md)
- 跨主题：CI 持续评测 [`../eval/09-ci-and-regression.md`](../eval/README.md)
