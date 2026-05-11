# 02 · 数据：质量 > 数量

> "1000 条好数据 > 100K 噪声"——LIMA 论文给所有人上的一课。微调成败 70% 在数据，剩下 30% 在评测。超参从来不是关键。

## 1. 数据规模的实证

| 任务 | 最少够用 | 收益拐点 | 边际趋零 |
| --- | --- | --- | --- |
| 风格对齐（如客服语气） | 500 | 2k-5k | 10k+ |
| 指令 follow | 1k-3k | 10k | 50k+ |
| 领域 reasoning（医疗/法律） | 3k-10k | 30k | 100k+ |
| 代码补全 | 5k | 50k | 500k+ |
| 数学 reasoning | 10k | 100k+ | 持续受益 |
| 多轮对话 | 1k 段 | 10k 段 | 50k+ |

经验：先标 200 条精品 + 训一版，看 base vs ft 差距。差距明显才继续标。差距不明显，多半是任务设计有问题，再标 10k 也救不回来。

## 2. 数据分类

| 类型 | 形态 | 用途 | 工具 |
| --- | --- | --- | --- |
| 指令-回答 | `{instruction, input, output}` | 通用 SFT | Alpaca 格式 |
| 多轮对话 | `messages: [{role, content}]` | Chat 模型 | ChatML / sharegpt |
| 偏好对 | `{prompt, chosen, rejected}` | DPO / RLHF | UltraFeedback |
| 长文 / 文档 | 单条长文本 | continued pretrain | - |
| 工具调用 | `{messages, tools, tool_calls}` | function calling | OpenAI tools 格式 |
| 思维链 | `{question, reasoning, answer}` | 数学 / 推理 | OpenMathInstruct |

## 3. 数据格式：选一个，别混

### 3.1 ChatML（HuggingFace 默认 / Qwen / Llama-3）

```text
<|im_start|>system
你是一个助手。<|im_end|>
<|im_start|>user
你好<|im_end|>
<|im_start|>assistant
你好，有什么可以帮你？<|im_end|>
```

### 3.2 Alpaca（旧但简单）

```json
{
  "instruction": "翻译成英文",
  "input": "今天天气真好",
  "output": "The weather is nice today."
}
```

### 3.3 sharegpt（多轮通用）

```json
{
  "conversations": [
    {"from": "human", "value": "你好"},
    {"from": "gpt", "value": "你好，有什么可以帮你？"}
  ]
}
```

### 3.4 OpenAI tool-use（工具调用）

```json
{
  "messages": [
    {"role": "user", "content": "北京天气"},
    {"role": "assistant", "tool_calls": [{"id": "1", "type": "function",
      "function": {"name": "get_weather", "arguments": "{\"city\":\"北京\"}"}}]},
    {"role": "tool", "tool_call_id": "1", "content": "{\"temp\":25}"},
    {"role": "assistant", "content": "北京 25 度"}
  ]
}
```

| 格式 | 优 | 劣 | 建议 |
| --- | --- | --- | --- |
| ChatML | 通用、原生支持 | 模板字符易错 | 默认首选 |
| Alpaca | 简单、解析快 | 不支持多轮 | 单轮快速实验 |
| sharegpt | 多轮友好 | 字段名乱（from / value） | 多轮 SFT |
| OpenAI tools | tool-use 标配 | 嵌套深 | function calling |

> **关键**：训练时的 chat template 必须和推理时**完全一致**。模板差一个空格，效果差一截。

## 4. 数据清洗流水线

```python
# 一个能跑的清洗 pipeline，处理 SFT 数据
import json
import hashlib
from pathlib import Path
from collections import Counter

def load(path: str):
    with open(path) as f:
        return [json.loads(l) for l in f]

def hash_text(s: str) -> str:
    return hashlib.md5(s.encode()).hexdigest()

def dedup(items: list, key_fn) -> list:
    seen = set()
    out = []
    for it in items:
        h = hash_text(key_fn(it))
        if h in seen:
            continue
        seen.add(h)
        out.append(it)
    return out

def length_filter(items: list, key_fn,
                  min_chars: int = 10, max_chars: int = 8000) -> list:
    return [it for it in items
            if min_chars <= len(key_fn(it)) <= max_chars]

def lang_filter(items: list, key_fn, target: str = "zh") -> list:
    # 简版：中文占比 > 0.3
    def is_zh(s: str) -> bool:
        zh = sum(1 for c in s if '一' <= c <= '鿿')
        return zh / max(len(s), 1) > 0.3
    return [it for it in items if (target == "zh") == is_zh(key_fn(it))]

def quality_filter(items: list, key_fn, banned: list = None) -> list:
    banned = banned or ["http://", "https://", "<script", "AS AN AI"]
    return [it for it in items
            if not any(b.lower() in key_fn(it).lower() for b in banned)]

def report(items: list, key_fn):
    lens = [len(key_fn(it)) for it in items]
    print(f"count={len(items)} avg_len={sum(lens)/len(lens):.0f} "
          f"min={min(lens)} max={max(lens)}")

# 使用
data = load("raw.jsonl")
key = lambda x: x["output"]
print("raw:"); report(data, key)
data = dedup(data, key)
data = length_filter(data, key, 20, 4000)
data = lang_filter(data, key, "zh")
data = quality_filter(data, key)
print("clean:"); report(data, key)

with open("clean.jsonl", "w") as f:
    for it in data:
        f.write(json.dumps(it, ensure_ascii=False) + "\n")
```

| 清洗步骤 | 必做 | 工具 | 注意 |
| --- | --- | --- | --- |
| 去重（精确） | 是 | hash | output / instruction 都要 |
| 去重（近似） | 推荐 | MinHash / SimHash | 效果差异可达 5% |
| 长度过滤 | 是 | - | 太短无信息，太长截断 |
| 语言识别 | 是 | langdetect / fasttext | 中英文混入是常事 |
| 黑名单关键词 | 是 | - | "as an AI" / 广告 / 隐私 |
| 困惑度过滤 | 推荐 | base model PPL | 反向：保留低 PPL |
| 质量打分 | 推荐 | reward model / GPT-4 评分 | 贵但有效 |
| PII 脱敏 | 必做 | presidio / 正则 | 手机/邮箱/身份证 |

## 5. 数据多样性

光数量大没用。如果 1 万条全是同一类问题，模型只会过拟合到这一类。

| 维度 | 怎么做 |
| --- | --- |
| Task 多样性 | 分类、生成、改写、摘要、QA … 都要有 |
| 难度分布 | 简单 / 中 / 难 大致 3:5:2 |
| 长度分布 | 短中长都覆盖（直方图看一眼） |
| 主题分布 | embedding 聚类，看每类占比 |
| 风格多样 | 正式 / 口语 / 表格 / Markdown |

```python
# embedding 聚类看分布
from sentence_transformers import SentenceTransformer
from sklearn.cluster import MiniBatchKMeans
import numpy as np

m = SentenceTransformer("BAAI/bge-small-zh-v1.5")
texts = [d["instruction"] for d in data]
emb = m.encode(texts, batch_size=64, show_progress_bar=True)
labels = MiniBatchKMeans(n_clusters=20, random_state=0).fit_predict(emb)
for cid, cnt in Counter(labels).most_common():
    print(f"cluster {cid}: {cnt}  例：{texts[np.where(labels==cid)[0][0]][:40]}")
```

## 6. 与著名数据集的对照

| 数据集 | 规模 | 特点 | 启示 |
| --- | --- | --- | --- |
| LIMA | 1k | 精挑细选 | 质量碾压数量 |
| Alpaca | 52k | self-instruct 合成 | 数量但质量参差 |
| WizardLM | 70k+ | Evol-Instruct 进化指令 | 难度梯度 |
| OpenHermes-2.5 | 1M | 混合多源 | 通用 SFT 强基线 |
| UltraChat | 1.5M | 多轮合成 | 多轮训练参考 |
| UltraFeedback | 64k 偏好对 | DPO 标准 | RLHF/DPO 数据 |
| ShareGPT | ~90k | 真实用户对话 | license 注意 |
| Tulu-3 SFT | 939k | 学术 SOTA mix | 配比可借鉴 |

## 7. 数据 license / 版权

| 来源 | 商用 | 风险 |
| --- | --- | --- |
| OpenAI / Anthropic 输出 | 模糊 | ToS 禁止"训练竞争模型"，国内灰色 |
| 公开网页爬取 | 看协议 | robots.txt + 著作权 |
| HuggingFace 数据集 | 看 license | apache / cc-by 较安全 |
| 自家用户对话 | 看用户协议 | 必须脱敏 + 告知 |
| 翻译版（如 Alpaca-zh） | 同原协议 | 衍生作品 |

> **底线**：上线前请法务过一遍。蒸馏 GPT-4 的输出，海外模型公司明令禁止；国内默认睁一只眼，但在敏感行业（金融 / 医疗 / 政府）有合规风险。

## 8. 工具速查

| 工具 | 用途 |
| --- | --- |
| Argilla | 人工标注 / review |
| Distilabel | 合成数据 pipeline |
| cleanlab | 自动找标错 |
| Lilac | 数据集探索 |
| dolma | 大规模预训练数据清洗 |
| nemo-curator | NVIDIA 出品，工业级 |

## 常见坑

1. **训练 / 推理模板不一致**：训练用 `<|im_start|>`，推理时 tokenizer 没用对应 chat template，输出全乱。检查 `tokenizer.apply_chat_template()` 在两侧产物一致。
2. **没去重**：相同 prompt 不同 output 反复出现 → 模型在重复样本上过拟合，泛化崩。
3. **train / eval 泄漏**：清洗时一起去重，但 split 之前要 hold-out 测试集，否则评测虚高。
4. **数据偏题**：标 5k 条都是闲聊，结果模型回答专业问题反而退化。多样性比数量更要看。
5. **PII 没脱敏**：手机号 / 身份证进训练，模型可能原样复述，合规直接出事。

## 下一步

- 训练流程：[03 · SFT 基础](./03-sft.md)
- 用强模型造数据：[06 · 数据合成](./06-synthetic-data.md)
- 评测集和训练集怎么切：[07 · 评测](./07-evaluation.md)
- 案例：实际数据准备：[10 · 案例](./10-case-study.md)
