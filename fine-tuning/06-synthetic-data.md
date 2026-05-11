# 06 · 数据合成

> 真数据贵且难。用强模型造数据是工业级捷径——但风险也最大：license、多样性、错误传播。本章把"安全合成数据"的方法论说清。

## 1. 为什么要合成

| 原因 | 说明 |
| --- | --- |
| 真数据稀缺 | 内部数据 200 条，扩到 5k 才训得动 |
| 标注成本高 | 1 条专业标注 ¥10-50，1 万条就是十万级 |
| 形态特殊 | 工具调用、CoT、复杂格式人工标贵 |
| 多语言 | 用强模型自动翻译扩展 |
| 隐私 | 真数据脱敏麻烦，合成可控 |

## 2. 主流合成方法

| 方法 | 思路 | 多样性 | 难度梯度 | 代表 |
| --- | --- | --- | --- | --- |
| **Self-Instruct** | 种子 + LLM 生成新指令 | 中 | 弱 | Alpaca |
| **Evol-Instruct** | 把简单指令进化得更难 | 中 | 强 | WizardLM |
| **Magpie** | 直接 sample LLM 生成 prompt+answer | 高 | 中 | Magpie-Pro |
| **蒸馏（Distillation）** | 强模型教弱模型 | 取决于教师 | 中 | Phi、Orca |
| **Persona-Chat** | 给不同人设，发散视角 | 高 | 中 | PersonaHub |
| **可验证奖励** | 数学/代码自动判对错 | 不论 | 高 | NuminaMath、CodeAlpaca |
| **Back-Translation** | 答案 → 反推问题 | 中 | 弱 | LongForm |

## 3. Self-Instruct（最简单）

```python
# 用 GPT/Claude 从种子扩展指令-回答对
import json
import anthropic

client = anthropic.Anthropic()

SEEDS = [
    {"instruction": "把这段话翻译成英文", "input": "今天天气真好", "output": "..."},
    {"instruction": "总结要点", "input": "...", "output": "..."},
]

PROMPT = """你是数据合成专家。基于下面的种子样例，生成 5 条新的"指令-输入-输出"样例。
要求：
- 任务类型多样（不要全是翻译）
- 难度有变化（简单/中等/困难）
- 中文输出
- 严格 JSON 数组格式

种子：
{seeds}
"""

def gen_batch(seeds, n=5):
    msg = client.messages.create(
        model="claude-opus-4-5", max_tokens=2000,
        messages=[{"role": "user",
                   "content": PROMPT.format(seeds=json.dumps(seeds[:3], ensure_ascii=False))}],
    )
    text = msg.content[0].text
    start, end = text.find("["), text.rfind("]")
    return json.loads(text[start:end+1])

new_data = []
for _ in range(20):
    new_data.extend(gen_batch(SEEDS))
    if len(new_data) >= 100:
        break

with open("synthetic.jsonl", "w") as f:
    for d in new_data:
        f.write(json.dumps(d, ensure_ascii=False) + "\n")
```

| 步骤 | 必做 |
| --- | --- |
| 种子库 ≥ 50 条精品 | 是 |
| 每批生成 5-10 条（避免重复） | 是 |
| 去重（hash + embedding 相似度） | 是 |
| 人工抽检 5-10% | 是 |
| 用强一档模型（GPT-4 / Opus / DeepSeek） | 是 |

## 4. Evol-Instruct（进化难度）

WizardLM 的核心：把简单指令通过五种"进化算子"变难。

| 算子 | 例子 |
| --- | --- |
| **Add Constraints** | "翻译" → "翻译并保留专有名词不译" |
| **Deepening** | "讲讲机器学习" → "对比监督和半监督学习的具体场景" |
| **Concretizing** | "写代码" → "用 Python 写一个 LRU Cache 类" |
| **Increase Reasoning** | "1+1=?" → "三个连续奇数之和为 27，最大数是？" |
| **Complicate Input** | 加更长上下文 / 多文档 |

```python
EVOL_PROMPT = """请把下面的指令进化得更复杂、更具挑战性。
进化方式：从【加约束、深化、具体化、增推理、复杂输入】中随机选一种。
原指令：{instr}

输出格式：
进化方式：xxx
新指令：xxx
"""
```

经验：进化 1-2 轮足够。≥ 3 轮容易脱离实际。

## 5. Magpie（最省事）

Magpie 不需要种子。直接给 LLM 喂 chat template 的 user 起始 token，让它自己续写出 prompt + answer：

```python
# 伪代码：原理演示
# 用 base + chat template 的开头让模型"续写"用户提问
prefix = "<|im_start|>user\n"
resp = llm.complete(prefix, stop=["<|im_end|>"])    # 拿到一条 user prompt
answer = llm.chat([{"role": "user", "content": resp}])
record = {"messages": [{"role": "user", "content": resp},
                       {"role": "assistant", "content": answer}]}
```

| 优 | 劣 |
| --- | --- |
| 0 种子，0 设计 | 需要有 base+instruct 同源模型 |
| 多样性极高 | 质量参差，必须强力过滤 |
| 规模化容易 | 长尾低质量样本多 |

Magpie 数据集（千万级）已开源，可直接用。

## 6. 蒸馏：强模型 → 弱模型

| 蒸馏对象 | 怎么做 |
| --- | --- |
| **Hard label**（最常见） | 用强模型生成回答，弱模型 SFT |
| **Soft label**（KD） | 弱模型对齐强模型的 logits 分布 |
| **CoT 蒸馏** | 让强模型给中间推理过程（Orca 风格） |
| **Tool-use 蒸馏** | 强模型生成 tool_call 轨迹 |

```python
# 最常见：hard label 蒸馏 pipeline
import json, anthropic
client = anthropic.Anthropic()

def teach(prompts: list, model="claude-opus-4-5") -> list:
    out = []
    for p in prompts:
        msg = client.messages.create(model=model, max_tokens=1024,
            messages=[{"role": "user", "content": p}])
        out.append({"messages": [
            {"role": "user", "content": p},
            {"role": "assistant", "content": msg.content[0].text},
        ]})
    return out

prompts = [json.loads(l)["prompt"] for l in open("user_logs.jsonl")]
teacher_data = teach(prompts[:5000])
with open("distill.jsonl", "w") as f:
    for d in teacher_data:
        f.write(json.dumps(d, ensure_ascii=False) + "\n")
```

| 案例 | 教师 | 学生 | 结论 |
| --- | --- | --- | --- |
| Phi-1 / Phi-2 | GPT-3.5/4 | 1.3B-2.7B | 小模型可达大模型水平 |
| Orca / Orca-2 | GPT-4 | 13B | CoT 蒸馏极有效 |
| WizardCoder | GPT-4 | 7-15B | 代码任务 |
| 各种 distill-DeepSeek-R1 | DeepSeek-R1 | 7B-70B | reasoning 蒸馏 |

## 7. 数据合成 + 人工 review 流水线

合成 ≠ 不审。"合成 → 自动过滤 → 人工抽检"是工业最佳实践。

```text
LLM 合成 1 万条
  ↓
规则过滤（长度 / 关键词 / 格式）→ 剩 8000
  ↓
LLM 自评分（1-5 分）→ 取 ≥ 4 分 → 剩 5000
  ↓
embedding 去重 → 剩 4500
  ↓
人工抽检 5%（225 条）→ 错误率 < 5% 通过
  ↓
入训练
```

```python
# LLM 自评分（评委用更强模型，或同模型多次投票）
JUDGE = """你是数据质量评委。请给以下"指令-输入-输出"样例打 1-5 分。
评分标准：
5 - 完美：指令清晰，输出准确、无幻觉
4 - 好：小瑕疵不影响
3 - 一般：有明显问题但可用
2 - 差：错误较多
1 - 不可用

只输出一个数字。

{sample}
"""

def judge(s, client):
    msg = client.messages.create(model="claude-opus-4-5", max_tokens=10,
        messages=[{"role": "user", "content": JUDGE.format(sample=json.dumps(s, ensure_ascii=False))}])
    try: return int(msg.content[0].text.strip()[0])
    except: return 0
```

## 8. 多样性保证

合成数据最大问题：**模式坍塌**——LLM 反复生成同一类。

| 多样性维度 | 干预方法 |
| --- | --- |
| Topic | persona + 主题清单（金融/医疗/科技/…）显式分桶 |
| 难度 | Evol-Instruct 多轮进化分桶（简单 / 中 / 难） |
| 长度 | 显式要求"短回答 / 中等 / 长篇"3 桶 |
| 风格 | 角色化（专家 / 小白 / 段子手） |
| 任务类型 | 分类、生成、改写、QA、总结、代码、翻译 … |

经验：**先列任务清单 → 每类配额 → 按配额生成**。比"放养"质量高一个档次。

## 9. license / 版权

| 教师模型 | 输出能否商用训练 |
| --- | --- |
| OpenAI（GPT-4 / o-series） | ToS 禁止训练竞品；国内灰色 |
| Anthropic（Claude） | 同上 |
| Google Gemini | 同上 |
| Meta Llama | 看许可证（Llama 3 允许，但条款多） |
| DeepSeek | 通常允许（看版本 license） |
| Qwen | 允许（apache-2.0） |
| 自家模型 | 完全自由 |

> 在敏感行业（金融 / 医疗 / 政府 / 出海）必走开源系蒸馏。商业项目上线前过法务。

## 10. 真实案例

| 项目 | 数据合成做法 | 启示 |
| --- | --- | --- |
| **Phi 系列**（微软） | "Textbooks Are All You Need"，全合成 + 精挑 | 质量决定一切 |
| **Orca / Orca-2** | GPT-4 生成详细 CoT 解题过程 | CoT 蒸馏强 |
| **WizardLM** | Evol-Instruct 进化指令 | 难度梯度有用 |
| **Tulu-3** | 大量真+合成混合，强评测驱动 | 配比是科学 |
| **Self-Rewarding LM** | 模型自评分自训练 | 闭环潜力大 |
| **Magpie-Pro** | 千万级零种子合成 | 规模化路径 |

## 11. 工具链

| 工具 | 用途 |
| --- | --- |
| **Distilabel**（Argilla） | pipeline 化合成 + 评分 |
| **DataDreamer** | 学术友好合成框架 |
| **Augmentoolkit** | 文档 → QA 对自动化 |
| **NeMo Curator** | NVIDIA 工业级清洗 + 合成 |
| **Synthetic-Data-Kit**（Meta） | 文档 → 训练样本 |

## 常见坑

1. **不去重直接训**：Self-Instruct 重复率可达 30%，不去重等于 1k 当 700 用 + 过拟合。embedding 相似度 > 0.9 的全砍。
2. **教师模型偏见放大**：教师有"as a helpful AI"等口癖，蒸出来的学生全这样。后处理过滤口癖词。
3. **license 翻车**：用 GPT-4 蒸到自家模型，海外发布被下架。提前法务。
4. **没人工抽检**：合成数据看起来"很美"，但抽 50 条人工看，常发现事实错误率 10-30%。
5. **合成数据淹没真数据**：合成 9：真 1，真数据信号被稀释。建议保持 真:合 ≥ 1:5，并在评测集上仅用真数据。

## 下一步

- 数据基础（清洗 / 多样性）：[02 · 数据](./02-data.md)
- 训练流程：[03 · SFT](./03-sft.md) + [05 · 框架](./05-frameworks.md)
- 评测合成数据效果：[07 · 评测](./07-evaluation.md)
- 用合成数据走完一个案例：[10 · 案例](./10-case-study.md)
