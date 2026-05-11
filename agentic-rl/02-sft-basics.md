# 02 · Agent SFT 基础

> Agent SFT 不是普通 chat SFT 多一个"工具调用"字段那么简单。**它训的是模型何时停下来调用、调用什么、怎么消费返回值——这是 trace 级监督，不是回答级监督**。

本章假设你已经看过 [`../fine-tuning/03-sft.md`](../fine-tuning/03-sft.md)（response-only loss / chat template）。这里聚焦 Agent 场景特有的：tool-call trace 数据格式、多步 loss masking、训练曲线异常的 Agent 化解读。

## 1. Agent SFT 的数据形态

最常见三种 trace 格式：

| 格式 | 代表 | 适合 |
| --- | --- | --- |
| ReAct（Thought/Action/Observation） | 早期 LangChain、AutoGPT | 单工具、prompt 易写 |
| OpenAI tool-calling JSON | GPT-4 / Claude / Llama 3.1+ | 现代 Agent 主流 |
| Code-act（Python 代码即 action） | CodeAct、TaskWeaver | 复杂组合工具 |

一条典型 OpenAI 格式 tool-call trace：

```json
{
  "messages": [
    {"role": "system", "content": "你是查股价的助手。"},
    {"role": "user", "content": "AAPL 现在多少？"},
    {"role": "assistant", "content": null,
     "tool_calls": [{"id": "c_1", "type": "function",
                     "function": {"name": "get_price", "arguments": "{\"ticker\":\"AAPL\"}"}}]},
    {"role": "tool", "tool_call_id": "c_1", "content": "{\"price\": 187.32}"},
    {"role": "assistant", "content": "AAPL 当前 $187.32。"}
  ],
  "tools": [{"type": "function",
             "function": {"name": "get_price",
                          "parameters": {"type": "object",
                                         "properties": {"ticker": {"type": "string"}}}}}]
}
```

注意：

- `tool_calls` 由模型生成 → **要算 loss**
- `tool` role 是外部返回 → **不算 loss**（关键，详见 §3）
- 最后一条 `assistant` 消费 observation → **要算 loss**

## 2. loss masking 规则（Agent 特化版）

| token 来源 | loss | 原因 |
| --- | --- | --- |
| system / user | 0 | 输入条件，不该让模型预测 |
| assistant（含 tool_calls） | 1 | 模型要学的决策 |
| tool（外部 observation） | 0 | 外部世界返回，不是模型生成的 |
| 最后一条 assistant（总结回答） | 1 | 学习"如何消费 observation" |

> 这跟 chat SFT 的 response-only 思路一致，只是 Agent 里有多段 assistant 块，每段都要算 loss。**漏掉任何一段，模型就少学一种决策**。

## 3. 一个能跑的 collator（多轮 + tool-call mask）

```python
# pip install transformers
from transformers import AutoTokenizer
import json

tok = AutoTokenizer.from_pretrained("meta-llama/Llama-3.1-8B-Instruct")
IGNORE = -100

def encode_agent_trace(example):
    """对 Agent trace 做精细 loss mask。"""
    msgs = example["messages"]
    input_ids, labels = [], []

    for i, m in enumerate(msgs):
        # 把单条消息渲染成 token（apply_chat_template 单条加 add_generation_prompt 控制）
        is_last = (i == len(msgs) - 1)
        chunk = tok.apply_chat_template([m], tokenize=False,
                                        add_generation_prompt=False)
        ids = tok(chunk, add_special_tokens=False).input_ids

        if m["role"] == "assistant":
            # 包括 tool_calls 也属于 assistant 生成 → 算 loss
            input_ids += ids
            labels    += ids       # 全部 unmask
        else:
            # user / system / tool 全部 mask
            input_ids += ids
            labels    += [IGNORE] * len(ids)

    return {"input_ids": input_ids,
            "labels":    labels,
            "attention_mask": [1] * len(input_ids)}

sample = json.load(open("trace_001.json"))
out = encode_agent_trace(sample)
n_train = sum(1 for x in out["labels"] if x != IGNORE)
print(f"total {len(out['input_ids'])} tokens, trainable {n_train} "
      f"({n_train/len(out['input_ids']):.1%})")
```

> 经验：Agent trace 里 trainable token 比例通常在 15-40%。低于 10% 通常是 observation 太长（如检索结果），可以截断或摘要。

## 4. 关键超参（Agent SFT 特化）

```yaml
# axolotl 风格配置（agent-sft.yaml）
base_model: meta-llama/Llama-3.1-8B-Instruct
chat_template: llama3
datasets:
  - path: ./data/agent_traces.jsonl
    type: chat_template
    field_messages: messages
    train_on_inputs: false        # 关键：observation 不算 loss
    roles_to_train: ["assistant"] # 仅 assistant 段
adapter: lora
lora_r: 32
lora_alpha: 64
lora_target_modules: [q_proj, k_proj, v_proj, o_proj]
sequence_len: 8192                # Agent trace 普遍长
sample_packing: true
gradient_accumulation_steps: 8
micro_batch_size: 2
num_epochs: 3
optimizer: adamw_torch
learning_rate: 1.0e-4             # LoRA 起手
warmup_ratio: 0.05
lr_scheduler: cosine
weight_decay: 0.01
bf16: true
flash_attention: true
gradient_checkpointing: true
eval_sample_packing: false        # eval 不打包，便于对齐 metric
```

| 与普通 SFT 的差异 | 原因 |
| --- | --- |
| `sequence_len` 8K+ | tool observation 拖长 |
| `gradient_checkpointing` 必开 | 长序列显存敏感 |
| `train_on_inputs: false` | observation 必须 mask |
| epochs 偏少（2-3） | trace 数据贵，过拟合快 |
| lr 比 chat SFT 略低 | 长 trace + 多 turn 梯度噪声大 |

## 5. 训练曲线的 Agent 化解读

| 信号 | 健康 | 异常诊断（Agent 特化） |
| --- | --- | --- |
| train loss | 平滑下降到 0.4-1.0 | 不动 → tool token 边界 mask 错（很常见） |
| eval loss | 跟随下降 | 早期发散 → trace 长度分布不均，sort_by_length |
| token accuracy | 持续上升 → 0.6+ | 卡 0.3-0.4 → chat_template 里 tool 角色没识别 |
| tool-call format error rate（自建） | 应该 < 1% | 不降 → JSON schema 没在 prompt 里说明 |
| **特殊**：trainable token 比 | 15-40% | < 5% 说明 mask 太多，trace 太短或被 observation 淹没 |

> 经验：训练前**人工 print 一条样本的 tokenized + label**。99% 的 mask bug 在第一条样本就能看出来。

## 6. 数据规模与质量经验

| 场景 | 推荐数据量 | 来源 |
| --- | --- | --- |
| 单工具客服 | 1K-5K trace | 真实日志清洗 |
| 5-10 工具通用 Agent | 10K-50K trace | 蒸馏 GPT-4 / Claude |
| 复杂多步推理 Agent | 50K-200K trace | 合成 + reject sampling |
| Code-act / 浏览器 | 100K+ | WebArena / SWE-bench 风格 |

> 引用：ToolLLaMA (Qin et al., 2023) 用 16K 工具 + 126K trace；Gorilla 用 1.6K API + 16K trace 就达到不错效果。**工具数和数据量呈次线性关系**。

## 7. SFT 数据合成最小 pipeline

```python
# 用强模型蒸馏 Agent trace
import json, openai
client = openai.OpenAI()

TOOLS = [...]  # 你的工具 schema 列表
QUERIES = open("seed_queries.txt").read().splitlines()

out = open("traces.jsonl", "w")
for q in QUERIES:
    msgs = [{"role":"system","content":"You are a helpful agent."},
            {"role":"user","content":q}]
    # 多轮直到模型不再 tool_call
    for _ in range(8):
        r = client.chat.completions.create(
            model="gpt-4o", messages=msgs, tools=TOOLS, tool_choice="auto")
        m = r.choices[0].message
        msgs.append(m.model_dump(exclude_none=True))
        if not m.tool_calls:
            break
        for tc in m.tool_calls:
            # 实际跑工具（或 mock）
            result = run_tool(tc.function.name,
                              json.loads(tc.function.arguments))
            msgs.append({"role":"tool", "tool_call_id": tc.id,
                         "content": json.dumps(result)})
    out.write(json.dumps({"messages": msgs}, ensure_ascii=False) + "\n")
```

| 合成数据陷阱 | 缓解 |
| --- | --- |
| 老师模型偏好某种调用风格 | 多模型混合（GPT-4 + Claude） |
| 失败 trace 被丢弃 | 保留少量失败 + 修正过的成功对照 |
| 工具 mock 返回值不真实 | 部分 trace 接真实工具 |
| 长尾 query 缺 | 用 Evol-Instruct 扩 query |

## 8. 衔接 RL：SFT 终点 ≠ 训练终点

```text
理想 post-training pipeline：

  base model
     │
     ▼
  SFT (本章) ─── 模型会"调用工具的基本款"
     │
     ▼
  reject sampling SFT (Llama 3 风格)
     │
     ▼
  DPO / GRPO (§04 / §07) ─── 模型学会"什么时候不调用 / 提前停止"
     │
     ▼
  生产 Agent
```

> Llama 3 paper（Dubey et al., 2024）反复迭代 6 轮 reject sampling SFT + DPO。**单次 SFT 通常不够**。

## 9. 评测 Agent SFT 模型

| 评测 | 工具 | 关注 |
| --- | --- | --- |
| Tool call accuracy | 自写 unit test | 函数名 / 参数对不对 |
| Trace success rate | LangSmith / 自建 | 端到端任务完成率 |
| BFCL (Berkeley Function Calling Leaderboard) | <https://gorilla.cs.berkeley.edu/leaderboard.html> | 通用基准 |
| ToolBench / API-Bank | 公开 | 大规模工具 |
| MMLU / HellaSwag | lm-eval-harness | 通用能力遗忘检测 |

跨主题深度评测见 [`../eval/07-agent-eval.md`](../eval/07-agent-eval.md)。

## 常见坑

1. **tool role 没 mask**：模型学到"复述 observation"，推理时把 search 结果当自己说的输出，导致幻觉式复读。
2. **chat template 不支持 tools 字段**：很多老模板（如 ChatML 老版本）没定义 tool role，直接训会把 `<tool>` token 当普通字符。要么换 Llama-3.1 / Qwen2.5 这类原生支持的 template，要么自定义。
3. **trace 长度方差大没排序**：trace 从 200 token 到 8K token 都有，random shuffle 会让一个 batch 显存爆另一个 batch 浪费。用 `group_by_length` 或 sample packing。
4. **只训成功 trace**：模型不会处理 tool 报错。**故意混入 5-10% 工具失败但最终恢复的 trace**。
5. **lr 沿用 chat SFT**：Agent trace 长、loss 分布稀疏（mask 多），lr 一般要降 30-50%。

## 下一步

- 复习普通 SFT 基础：[../fine-tuning/03-sft.md](../fine-tuning/03-sft.md)
- 工具调用数据怎么设计：[../agents/04-tool-use.md](../agents/04-tool-use.md)
- SFT 完了上 DPO：[04 · DPO](./04-dpo.md)
- 直接训 reasoning Agent：[07 · GRPO](./07-grpo.md)
- 评测 SFT 后的 Agent：[../eval/07-agent-eval.md](../eval/07-agent-eval.md)
- 工具框架选型：[09 · 工具](./09-tools.md)
