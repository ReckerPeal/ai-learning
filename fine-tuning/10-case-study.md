# 10 · 案例：从 0 微调一个领域 Agent

> 一个端到端、可复现的案例：训练一个"客服意图分类 + tool-use"模型。从 500 条真实工单出发，跑通数据 → 训练 → 评测 → 部署 → 数据飞轮的完整闭环。

## 1. 业务背景与目标

| 项 | 内容 |
| --- | --- |
| 业务 | 电商客服一线 |
| 痛点 | base Qwen2.5-7B 意图识别 acc 70%；tool 调用错误率 30% |
| 目标 | 意图 acc ≥ 90%；tool 参数正确率 ≥ 90%；通用能力衰减 ≤ 3% |
| 预算 | 单卡 4090（24GB） / 1 周时间 |
| 上线方式 | vLLM + 多 LoRA（同 base 还跑别的任务） |

## 2. 选 base model

| 候选 | 优 | 劣 | 选不选 |
| --- | --- | --- | --- |
| Qwen2.5-7B-Instruct | 中文好、tool-use 原生支持、apache | - | **选** |
| Llama-3.1-8B-Instruct | 通用强、生态好 | 中文略弱 | 否 |
| Mistral-7B | 速度快 | 中文弱 | 否 |
| GLM-4-9B | 中文强 | 生态稍弱 | 备选 |
| DeepSeek-V2 lite | reasoning | 较大 | 否 |

> 决策：Qwen2.5-7B-Instruct。中文 + tool-use + 4090 单卡 QLoRA 可训。

## 3. 数据准备

### 3.1 真实数据

500 条来自工单系统，已脱敏：
```json
{"input": "我昨天买的鞋还没到", "intent": "查物流", "args": {"order_id": null}}
{"input": "想退掉订单 A12345", "intent": "退款", "args": {"order_id": "A12345"}}
```

### 3.2 数据增强（合成）

用 Claude 把 500 条扩到 3000 条（[§06](./06-synthetic-data.md)）：

```python
import json, anthropic
client = anthropic.Anthropic()

PROMPT = """基于种子工单，生成 5 条相似但不同的工单。要求：
- 意图分布均衡：[查物流、退款、换货、咨询商品、催单、投诉]
- 表达多样：口语 / 书面 / 错别字 / 长短不一
- 每条带正确意图和参数（订单号若提及）
- 严格 JSON 数组

种子：
{seeds}
"""

def gen(seeds):
    msg = client.messages.create(model="claude-opus-4-5", max_tokens=2000,
        messages=[{"role":"user","content":PROMPT.format(
            seeds=json.dumps(seeds[:3], ensure_ascii=False))}])
    text = msg.content[0].text
    s, e = text.find("["), text.rfind("]")
    return json.loads(text[s:e+1])
```

合成后清洗（[§02](./02-data.md)）：去重 → 长度过滤 → 人工抽检 5%（错误率 8%，回去修 prompt 重跑）→ 最终 2800 条。

### 3.3 转 tool-use 格式

```python
def to_chat(d):
    return {"messages": [
        {"role": "system", "content": "你是客服助手，识别用户意图并调用合适的工具。"},
        {"role": "user", "content": d["input"]},
        {"role": "assistant",
         "tool_calls": [{"id": "1", "type": "function",
            "function": {"name": d["intent"], "arguments": json.dumps(d["args"], ensure_ascii=False)}}]},
    ]}

with open("train.jsonl","w") as f:
    for d in data:
        f.write(json.dumps(to_chat(d), ensure_ascii=False)+"\n")
```

### 3.4 数据切分

| Split | 数量 | 来源 |
| --- | --- | --- |
| Train | 2500 | 真 400 + 合成 2100 |
| Eval（domain） | 200 | 真 200（hash 隔离，绝不进 train） |
| Eval（通用） | - | MMLU / CMMLU / GSM8K / IFEval |

## 4. 训练（QLoRA）

```yaml
# axolotl 配置 case10.yaml
base_model: Qwen/Qwen2.5-7B-Instruct
load_in_4bit: true

datasets:
  - path: ./train.jsonl
    type: chat_template
    chat_template: chatml

val_set_size: 0.05
output_dir: ./case10-out

adapter: qlora
lora_r: 16
lora_alpha: 32
lora_dropout: 0.05
lora_target_modules: all-linear

sequence_len: 1024
sample_packing: true
gradient_accumulation_steps: 8
micro_batch_size: 4
num_epochs: 3
optimizer: paged_adamw_8bit
lr_scheduler: cosine
learning_rate: 0.0002
warmup_ratio: 0.03
bf16: auto
gradient_checkpointing: true
flash_attention: true

logging_steps: 5
saves_per_epoch: 1
evals_per_epoch: 2
```

```bash
accelerate launch -m axolotl.cli.train case10.yaml
# 单卡 4090，约 35 分钟跑完 3 epoch
```

训练曲线（典型）：

| step | train loss | eval loss | grad_norm |
| --- | --- | --- | --- |
| 50 | 1.85 | 1.40 | 1.2 |
| 100 | 0.92 | 0.71 | 0.8 |
| 200 | 0.45 | 0.42 | 0.5 |
| 300 | 0.28 | 0.39 | 0.4 |
| 400 | 0.21 | 0.40 | 0.4 |

> eval loss 在 200 step 后基本不降。最终选 step 250 的 checkpoint。

## 5. 评测

### 5.1 Domain eval

```python
import json
from vllm import LLM, SamplingParams
from vllm.lora.request import LoRARequest

llm = LLM(model="Qwen/Qwen2.5-7B-Instruct", enable_lora=True,
          max_loras=2, max_lora_rank=32)
sp = SamplingParams(temperature=0, max_tokens=128)

testset = [json.loads(l) for l in open("eval_domain.jsonl")]

def predict(text, lora=None):
    msgs = [{"role":"system","content":"你是客服助手..."},
            {"role":"user","content":text}]
    out = llm.chat(msgs, sp, lora_request=lora)
    return out[0].outputs[0].text

base_correct, ft_correct = 0, 0
arg_base_ok, arg_ft_ok = 0, 0
for d in testset:
    a_base = predict(d["input"])
    a_ft   = predict(d["input"],
              LoRARequest("ft", 1, "./case10-out/final"))
    if d["intent"] in a_base: base_correct += 1
    if d["intent"] in a_ft:   ft_correct   += 1
    # 参数正确性（订单号匹配）
    oid = d["args"].get("order_id")
    if oid and oid in a_base: arg_base_ok += 1
    if oid and oid in a_ft:   arg_ft_ok   += 1

print(f"intent acc base={base_correct/200:.3f} ft={ft_correct/200:.3f}")
print(f"arg ok    base={arg_base_ok}/X  ft={arg_ft_ok}/X")
```

结果（实测约值）：

| 指标 | base | ft | Δ |
| --- | --- | --- | --- |
| 意图 acc（200 条） | 0.71 | **0.93** | +0.22 |
| 工具参数正确率 | 0.65 | **0.92** | +0.27 |
| 平均输出 token | 48 | 22 | -54%（更简洁） |

### 5.2 通用能力评测

```bash
# 合并后跑通用 benchmark
python merge_lora.py --base Qwen/Qwen2.5-7B-Instruct \
   --lora ./case10-out/final --out ./merged
lm-eval --model hf --model_args pretrained=./merged,dtype=bfloat16 \
        --tasks cmmlu,gsm8k,ifeval --batch_size 8 --output_path reports/
```

| Benchmark | base | ft | Δ |
| --- | --- | --- | --- |
| CMMLU | 0.756 | 0.741 | -1.5%（OK） |
| GSM8K | 0.802 | 0.788 | -1.4%（OK） |
| IFEval | 0.745 | 0.752 | +0.7% |
| MMLU | 0.706 | 0.694 | -1.7%（OK） |

通用能力衰减全在 3% 以内，目标达成。

### 5.3 人工 A/B 抽样

| 组 | 业务专家盲选偏好 ft（共 100 条） |
| --- | --- |
| 简单意图 | ft 胜 65 / base 胜 12 / 持平 23 |
| 模糊表述 | ft 胜 58 / base 胜 15 / 持平 27 |
| 长尾边界 | ft 胜 41 / base 胜 22 / 持平 37 |

## 6. 与 base model 对比小结

| 维度 | 结论 |
| --- | --- |
| Domain | 强提升（22-27 个百分点） |
| 通用 | 衰减 ≤ 1.7%，可接受 |
| 风格 | 更简洁、tool 输出更稳 |
| 速度 | 输出 token 减半，意味着推理更快 |
| 显存 | LoRA adapter 仅 80MB，多任务部署友好 |

## 7. 部署上线

```bash
# vLLM 同时挂多个 LoRA：意图 + 文案 + 摘要
vllm serve Qwen/Qwen2.5-7B-Instruct \
  --enable-lora --max-loras 4 --max-lora-rank 32 \
  --lora-modules \
     intent=./case10-out/final \
     copy=./copy-lora \
     summary=./summary-lora \
  --max-model-len 4096 \
  --gpu-memory-utilization 0.9 \
  --port 8000
```

调用方（融入业务 Agent 编排，详见 [../langgraph/](../langgraph/README.md)）：

```python
from openai import OpenAI
cli = OpenAI(base_url="http://localhost:8000/v1", api_key="x")
def classify(text):
    r = cli.chat.completions.create(
        model="intent",  # 选 LoRA
        messages=[{"role":"system","content":"你是客服助手..."},
                  {"role":"user","content":text}],
        temperature=0)
    return r.choices[0].message.content
```

### 灰度计划

| 阶段 | 流量 | 监控阈值 |
| --- | --- | --- |
| Day 1 | 5% | 错误率 > 1% 自动回滚 |
| Day 3 | 25% | 客户满意度不掉 |
| Day 7 | 100% | 所有指标 OK |

## 8. 数据飞轮（持续迭代）

```text
线上请求 → 日志（query + 模型输出 + 用户最终采纳/转人工）
   ↓
按"转人工"和"低置信"自动挑出疑难 case → 人工标注（~1 小时/天）
   ↓
每周新增 200-500 条真实样本 → 加入训练集
   ↓
每月重训一次 → 跑回归 eval → 通过则灰度上线
```

| 工程 | 工具 |
| --- | --- |
| 日志采集 | OpenTelemetry / 自家网关 |
| 标注 | Argilla / Label Studio |
| 自动挑难 | 模型置信度 + 人工 review |
| 回归 eval | CI 触发（[§07](./07-evaluation.md)）|

## 9. 复盘：本案例的关键决策

| 决策 | 为什么 | 替代会怎样 |
| --- | --- | --- |
| 用 QLoRA 不全参 | 单卡 4090 + 数据 < 5k | 全参没必要、显存炸 |
| 真+合成混合而不是纯合成 | 真数据保信号 + 合成保规模 | 纯合成会偏 |
| 评测集只用真数据 | 防止评测虚高 | 合成混入会自欺欺人 |
| 多 LoRA 共享 base | 还有别的任务在跑 | 多个完整模型显存翻倍 |
| 通用能力评测必跑 | 防止灾难性遗忘 | 上线后某些功能默默退化 |
| 数据飞轮 | 线上数据是金矿 | 模型上线即衰减 |

## 10. 下次还会改什么

- 把"转人工"的 case 收集后，做一轮 **DPO**（用户采纳 vs 拒绝）进一步对齐风格
- 试 **Qwen2.5-3B** 蒸馏：更便宜的部署
- 把 tool 调用错的 case 当**Agentic RL**的奖励信号训（[../agents/10-production.md](../agents/10-production.md)）

## 常见坑

1. **合成数据淹没真数据**：第一版合成 1:9 真:合，模型偏合成风格，对真实表述（错别字、口语）反而退化。改 1:5，并 oversample 真数据。
2. **评测集泄漏到合成 prompt**：第一次合成时把全量真数据（含 eval set）喂给 Claude → eval 上 99%。立即 hash 隔离重新合成。
3. **Tool template 训推不一致**：训练用 OpenAI tool 格式，vLLM 默认 chat template 不带 tool 段，输出乱。要么对齐 template，要么训练时同步用 vLLM 一致的格式。
4. **没跑 IFEval / 通用 eval 就上线**：客服意图准了，但模型在闲聊场景突然不会用 Markdown。补回 IFEval 后才发现。
5. **多 LoRA 服务时 max_lora_rank 配小了**：训练用 r=32，部署写 max_lora_rank=16 → 加载报错。配置要 ≥ 训练时最大 rank。

## 下一步

- 复习决策：[01 · 概览](./01-overview.md)
- 数据细节：[02 · 数据](./02-data.md) + [06 · 数据合成](./06-synthetic-data.md)
- 训练原理：[03 · SFT](./03-sft.md) + [04 · PEFT](./04-peft.md)
- 评测建设：[07 · 评测](./07-evaluation.md) + [../eval/](../eval/README.md)
- Agent 编排：[../langgraph/](../langgraph/README.md) + [../agents/](../agents/README.md)
- Agentic RL（下一阶段）：[../agents/10-production.md](../agents/10-production.md)
