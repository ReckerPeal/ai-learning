# 07 · 评测：不要只看 loss

> 你 loss 0.3，老板问"比 base 强多少"。你说不出来——这次微调白做了。**没评测的微调，等于没微调。**

## 1. 为什么 loss 不够

| 现象 | 解释 |
| --- | --- |
| Loss 漂亮，输出难用 | 模型学会了"记住答案"而非泛化 |
| Loss 不降，模型反而更稳 | response 短的样本 loss 自然低 |
| 训完域内强，域外崩 | 灾难性遗忘（[§03](./03-sft.md)） |
| 训完拒答 / 复读 / 安全失效 | 数据偏 + 模板错 |
| Eval loss 比 base 还低，但 benchmark 跌 | overfit 验证集分布 |

> 评测 = 知识地基。和 [../eval/](../eval/README.md) 主题深度衔接。

## 2. 评测维度（必须四面看）

| 维度 | 关注 | 工具 |
| --- | --- | --- |
| **Domain 任务能力** | 训练目标本身做得多好 | 自家 eval set |
| **通用能力衰减** | 中文 / 数学 / 代码 / 多语 是否退步 | MMLU、CMMLU、GSM8K、HumanEval |
| **Instruction following** | 是否还会听指令 | IFEval |
| **安全与对齐** | 是否更容易输出有害内容 | ToxiGen、SafetyBench |
| **格式稳定性** | JSON / XML / tool call 格式 | 自动校验 |
| **延迟 / 吞吐** | 推理性能 | benchmarks |
| **人类偏好** | 真人盲测 A/B | 人工评审 |

**铁律**：缺通用能力评测的微调，几乎一定在某些方面退步而你不知道。

## 3. 标准 benchmark 速查

| Benchmark | 测什么 | 中文版 | 备注 |
| --- | --- | --- | --- |
| MMLU | 通识 57 学科 5-shot | CMMLU / C-Eval | 必跑 |
| GSM8K | 小学数学 | CMath | 必跑（reasoning） |
| MATH | 高中竞赛数学 | - | 难 |
| HumanEval / MBPP | Python 代码 | HumanEval-CN | 代码必跑 |
| IFEval | 严格指令 follow | - | 指令模型必跑 |
| BBH（Big-Bench Hard） | 23 项硬任务 | - | 综合 reasoning |
| TruthfulQA | 真实性 | - | 抗幻觉 |
| AlignBench / MT-Bench | LLM-as-judge 多轮 | AlignBench 中文 | 主观对话 |
| Arena-Hard | LLM-as-judge 难题 | - | 接近 chatbot arena |

```bash
# 一键评测：opencompass / lm-evaluation-harness
pip install lm-eval
lm-eval --model hf --model_args pretrained=./merged-model,dtype=bfloat16 \
        --tasks mmlu,gsm8k,humaneval --batch_size 8 --output_path ./eval-out
```

## 4. 自家 domain eval（最重要）

跑 benchmark 看通用，但**自家 domain eval 才能衡量你这次微调值不值**。

```python
# 一个能跑的最小 domain eval
import json
from transformers import pipeline

# 你的领域评测集（人工精选 ≥ 100 条）
testset = [json.loads(l) for l in open("domain_eval.jsonl")]
# 每条形如 {"input": "...", "expected_intent": "refund"}

pipe = pipeline("text-generation", model="./merged-model",
                torch_dtype="bfloat16", device_map="auto")

def predict(x):
    out = pipe([{"role": "user", "content": x}],
               max_new_tokens=64, do_sample=False)[0]["generated_text"][-1]["content"]
    # 简单解析（实际按你自己的输出格式）
    for k in ["refund","question","booking","other"]:
        if k in out.lower(): return k
    return "other"

correct = sum(1 for s in testset if predict(s["input"]) == s["expected_intent"])
print(f"acc = {correct/len(testset):.3f}")
```

### Domain eval 怎么建

| 步骤 | 做法 |
| --- | --- |
| 选样本 | 真实业务样本（不是合成的！）≥ 100，有覆盖度 |
| 标准答案 | 人工标 / 业务专家审 |
| 难度分桶 | 简单 / 中 / 难 各占比，分桶看准确率 |
| 防止泄漏 | 评测集**绝不进训练集**，hash 比对 |
| 版本控制 | eval set 一旦定了，长期固定（除非重大业务变化） |
| 加入边界 case | 模糊 / 长尾 / 对抗样本 |

## 5. LLM-as-judge

主观任务（写作 / 对话 / 风格）没标准答案，用 LLM 当评委。

```python
JUDGE_PROMPT = """你是评委。请对比两个模型对同一个问题的回答，选出更好的。
问题：{q}

模型 A：
{a}

模型 B：
{b}

请只输出 A、B 或 TIE。判断标准：准确性、有用性、风格契合度、安全。"""

def judge_pair(q, a, b, client):
    # 注意：A/B 顺序要随机化（消除 position bias）
    import random
    if random.random() < 0.5: a, b, swap = b, a, True
    else: swap = False
    msg = client.messages.create(model="claude-opus-4-5", max_tokens=10,
        messages=[{"role": "user",
                   "content": JUDGE_PROMPT.format(q=q, a=a, b=b)}])
    res = msg.content[0].text.strip()
    if swap: res = {"A":"B","B":"A","TIE":"TIE"}.get(res, res)
    return res

# 多次投票（3-5 次）+ 多评委（不同模型）减少偏差
```

| 偏差 | 缓解 |
| --- | --- |
| Position bias（偏 A） | 随机交换 A/B |
| Length bias（偏长答案） | 在 prompt 里强调 |
| Self-preference | 用不同家族模型当评委 |
| 单评委噪声 | 3-5 次投票 |

LLM-as-judge 与人工的相关性：在多数任务 0.7-0.85，比 BLEU/ROUGE 强很多，但**关键决策**仍要人工抽样。

## 6. 必做：base vs ft 对照

```text
对每个任务，跑两版：
  - base 模型（不微调）
  - 你的 ft 模型
看 delta（不是绝对值）
```

| 任务 | base | ft | Δ | 解读 |
| --- | --- | --- | --- | --- |
| Domain acc | 62% | 88% | **+26** | 微调有效 |
| MMLU | 71% | 67% | -4 | 通用退步，警告 |
| GSM8K | 68% | 60% | -8 | 数学退化，严重警告 |
| HumanEval | 55% | 50% | -5 | 代码退化 |
| IFEval | 70% | 72% | +2 | 指令 follow OK |

只看 ft 的 88% 不够。base 上去多少、什么退步了，才是真账。

## 7. 模型回归测试（防新版本变差）

每次迭代都做：

| 测试 | 目的 |
| --- | --- |
| 跑同一套 eval（domain + 通用） | 防止退步 |
| 关键场景固定 prompt 集（50-200 条） | 人工每次都看 |
| Diff 分析（输出对比 v1 vs v2） | 发现行为漂移 |
| 安全红队 | 防新版本"越狱"变弱 |

```python
# 一个最简回归对比
import difflib, json
v1 = json.load(open("v1.json"))   # {prompt: output}
v2 = json.load(open("v2.json"))
for p in v1:
    if v1[p] != v2.get(p, ""):
        print("---", p[:50])
        for line in difflib.unified_diff(v1[p].split(), v2[p].split(), lineterm=""):
            print(line)
```

## 8. 训练-评测自动化流水线

```yaml
# 一个 CI 风格的训练流水线
- name: data_prep
  run: python clean.py
- name: train
  run: accelerate launch -m axolotl.cli.train cfg.yaml
- name: merge
  run: python merge_lora.py
- name: domain_eval
  run: python domain_eval.py --model ./merged --out reports/domain.json
- name: general_eval
  run: lm-eval --model hf --model_args pretrained=./merged --tasks mmlu,gsm8k,ifeval --output_path reports/
- name: regression_diff
  run: python diff.py --base v_prev --new ./merged
- name: gate
  run: python gate.py --rules domain_acc>0.85,mmlu>0.65,gsm8k_drop<0.05
```

每次跑完出一份 report，不达标自动 reject。

## 9. 与 ../eval/ 主题的衔接

| 内容 | 本章 | [../eval/](../eval/README.md) |
| --- | --- | --- |
| 微调专属评测策略 | 重点 | 提及 |
| 通用 eval 框架 / 工具 | 简介 | 重点 |
| LLM-as-judge 设计 | 简介 | 重点 |
| Online eval / 监控 | 简介 | 重点 |

> 两章配合食用。微调上线后的运维监控全在 [../eval/](../eval/README.md)。

## 常见坑

1. **训练集和评测集泄漏**：合成数据时把评测集的 prompt 也拿去合成。结果 acc 99%——其实是死记硬背。建评测集第一天就 hash 隔离。
2. **只看通用 benchmark**：MMLU 没掉就觉得没事。但你的 domain 任务可能根本没提升。**业务指标永远第一。**
3. **LLM judge 有 position bias**：A 永远是你新模型 → 永远偏 A → 自己骗自己。必须随机化。
4. **没看通用能力衰减**：domain 涨 30%，数学跌 15%，老板用模型解他的 Excel 公式题，发现"还不如以前"。
5. **评测集太小（< 50 条）**：方差大，acc 70% 和 75% 没显著差异，瞎判断。≥ 200 条起步。

## 下一步

- 通用 eval 体系：[../eval/](../eval/README.md)
- SFT 时怎么早停：[03 · SFT 基础](./03-sft.md)
- 量化后再评测：[08 · 量化](./08-quantization.md)
- 上线后监控：[09 · 部署](./09-deployment.md)
- 数据飞轮：[10 · 案例](./10-case-study.md)
