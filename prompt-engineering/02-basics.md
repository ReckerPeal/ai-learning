# 02 · 基础：Role / Instruction / Format

> TLDR：一个工业级 prompt 至少包含 4 件套——**角色（Who）/ 任务（What）/ 上下文（Context）/ 格式（Output）**。少一件就有不稳定的地方。先把 4 件套写对，魔法咒语都不需要。

## 1. 4 件套结构

```text
┌──────────────────────────────────────────┐
│ Role        你是什么角色，处理什么领域            │ → 边界
├──────────────────────────────────────────┤
│ Instruction 这次要完成什么任务、按什么步骤            │ → 主体
├──────────────────────────────────────────┤
│ Context     有哪些事实、约束、参考资料             │ → 输入
├──────────────────────────────────────────┤
│ Format      输出长这样，必须满足这些 schema          │ → 输出契约
└──────────────────────────────────────────┘
```

| 组件          | 解决什么问题                          | 写作位置                     |
| ----------- | ------------------------------- | ------------------------ |
| Role        | 模型答非所问、风格漂移、领域知识不激活            | system 开头                |
| Instruction | 模型不做事、遗漏步骤、不按要求行动              | system 中段或 user 顶部       |
| Context     | 模型缺知识、用错知识、过期知识                | user 中段（或 RAG 注入）         |
| Format      | 输出无法解析、字段缺失、引号位置不对              | system 或 instruction 末尾  |

## 2. 一个反例 vs 一个正例

### 反例（80% 人写 prompt 的样子）

```text
帮我分析这段评论是好评还是差评：

"味道还行，但服务态度很差，不会再来。"
```

问题清单：

- 没角色 → 模型可能用日语回（如果训练数据里日语评论多）
- 没格式约束 → 输出 "这是一条差评，因为..." vs "negative" vs "差评(中性偏负)" 都可能
- 没置信度概念 → 边界 case 模型只能"二选一"
- 没"中性"选项 → 强行二分

### 正例

```text
你是一个中文电商评论情感分析助手。

任务：判断给定评论的情感倾向，并给出置信度。

输出 JSON，结构如下：
{
  "sentiment": "positive" | "neutral" | "negative",
  "confidence": 0.0 ~ 1.0,
  "key_phrases": ["影响判断的关键词或短语，至多 3 个"]
}

规则：
- confidence < 0.5 时 sentiment 必须是 neutral
- 不输出任何 JSON 之外的文本

待分析评论：
"味道还行，但服务态度很差，不会再来。"
```

加了 4 件套后：

- Role 限定了语言（中文）和领域（电商）
- Instruction 明确要"判断 + 置信度"
- Format 给了 schema，能直接 `json.loads`
- 边界规则解决"勉强二分"问题

## 3. 角色（Role）：边界比头衔重要

新手最爱的写法是堆头衔："你是世界顶级的、有 30 年经验的 Python 专家..."。**这是空话**，模型并不会因此变强。

有效的 Role prompt 应该说**行为约束**：

| 弱（头衔型）                  | 强（行为型）                                        |
| ----------------------- | --------------------------------------------- |
| 你是世界顶级 Python 专家         | 你审查 Python 代码，**只**指出真实存在的 bug，不评论代码风格 |
| 你是资深医疗顾问                | 你回答健康问题。**永远**附加"以上仅供参考，请咨询医生"                  |
| 你是友好的客服                 | 你是客服。回答精简（≤2 句），无法处理时回答"请联系人工客服"              |

Role 实质是**行为约束 + 领域激活**，§06 会详谈。

## 4. 指令位置：前置 vs 后置

研究和实践都表明：**长 prompt（>2000 token）里，指令位置显著影响跟随度**。

### 4.1 短 prompt：前置即可

```text
请把以下中文翻译成英文：
我喜欢吃苹果。
```

短 prompt 没差异。

### 4.2 长 prompt：指令重复（前 + 后）

```text
你是合同审查助手。任务：标记所有"风险条款"，并给出建议。
输出 JSON {risks: [{clause: ..., reason: ..., suggestion: ...}]}

[此处粘贴 5000 字合同正文]

——再次提醒：只标记真实风险条款，输出 JSON。不要重写合同。
```

**实证规律**：

| 上下文长度    | 指令位置策略         | 效果                  |
| -------- | -------------- | ------------------- |
| < 1k     | 前置             | 无差异                 |
| 1k-10k   | 前置 + 后置        | 后置版指令跟随度提升 ~10-15% |
| > 10k    | 前 + 中段 + 后置    | "夹心"格式效果最稳          |
| > 50k    | 必须 RAG，不要硬塞    | —                   |

## 5. 输出格式约束：5 种主流方式

| 方式             | 适用                | 优点              | 缺点                 |
| -------------- | ----------------- | --------------- | ------------------ |
| 自然语言描述         | 临时性、原型期            | 0 成本            | 极不稳定               |
| Markdown 模板    | 给人看的报告、文档生成        | 可读性好            | 解析麻烦               |
| JSON（含 schema） | 程序消费              | 易解析             | Claude 偏好稍差，需要"prefill" |
| XML 标签         | Claude 推荐         | 结构清晰，多字段时可读     | 解析需 XML parser     |
| Tool calling   | 强约束、需要类型检查        | schema 由模型层强制   | 跨厂商兼容性差            |

### 5.1 Markdown 输出

```text
请按以下格式输出：

## 摘要
（不超过 50 字）

## 关键点
- 第一点
- 第二点
- 第三点

## 行动建议
1. ...
2. ...
```

适合给人看的内容。**不要用于程序消费**——markdown 解析比 JSON 还麻烦。

### 5.2 JSON 输出

```text
输出 JSON，schema 如下（必须严格符合）：
{
  "title": string,
  "tags": string[],
  "score": number (0-10),
  "summary": string (≤100字)
}

不要输出 ```json``` 代码块包裹，直接输出 JSON 对象。
不要输出任何其他文字。
```

**关键技巧**：

1. 明确说"严格符合 schema"
2. 明确禁止 markdown 围栏（否则 Claude / DeepSeek 喜欢套 ```json）
3. 用 OpenAI / Anthropic 的 **structured output** 模式（强制 JSON 不会解析失败）
4. 失败兜底：见 [05 · 指令调优与输出约束](./05-instruction-tuning.md#3-json-mode-与-structured-output)

### 5.3 XML 输出（Claude 友好）

```text
请把答案放进以下 XML 标签：

<analysis>
  <sentiment>positive|negative|neutral</sentiment>
  <confidence>0-1 的小数</confidence>
  <reasoning>50 字以内</reasoning>
</analysis>

只输出这一段 XML，不要其他文字。
```

Claude 训练数据里 XML 大量出现，对 XML 标签的遵守度比 JSON 高一档。详见 [07 · 模型差异](./07-model-differences.md)。

## 6. "魔法咒语"真相

那些满天飞的咒语，到底有没有用？我做了实测分类：

| 咒语                              | 效果                                | 评价        |
| ------------------------------- | --------------------------------- | --------- |
| "Let's think step by step"      | 在弱模型上 +5~15% 数学题正确率，强模型饱和         | **真有用**   |
| "Take a deep breath"            | 早期 PaLM 论文里 +0.3%，强模型几乎无差异        | 玄学        |
| "I'll tip you $200"             | 早期 GPT-3.5 上 +1~3% 长度，强模型无差异      | 玄学        |
| "You are an expert in ..."      | 弱模型 +领域 token 概率，强模型已自带           | 部分有用      |
| "If you don't know, say so"     | 显著降低幻觉，**强烈推荐**                   | **真有用**   |
| "Be concise"                    | 显著降低输出长度（成本下降）                    | **真有用**   |
| "This is very important"        | 强模型上无差异，但能"挽救"被埋没的指令              | 弱有用       |
| "我会哭的"/"会失业"等情绪化威胁              | 已被 RLHF 稀释，部分模型反而触发 refuse         | 别用        |

**总结**：

- 凡是"让模型输出更明确的程序行为"的咒语（step by step / be concise / say I don't know）：有用
- 凡是"试图情感操纵 / 利益诱导"的咒语：在 2024 年之后基本失效
- 真正的杠杆是结构化设计（4 件套 + few-shot + 评测），不是咒语

## 7. 简洁 vs 啰嗦：哪种有效

新手常见两个极端：

| 极端           | 例子                              | 问题             |
| ------------ | ------------------------------- | -------------- |
| 太简           | "总结这篇文章"                        | 长度、格式、重点都不可控   |
| 太啰嗦          | 写 3 页 markdown，包含"请你优雅地处理边界 case"等模糊表述 | 模型抓不住主线，cache miss |

**经验法则**：

```text
prompt 长度 ≈ 任务复杂度 × 输出严格度
```

| 任务                  | 推荐 prompt 长度    |
| ------------------- | --------------- |
| 翻译                  | < 50 token      |
| 分类（带 5 个标签和 few-shot） | 200-500 token   |
| 信息抽取（10 字段 JSON）    | 500-1500 token  |
| Agent system prompt | 1500-3000 token |
| 复杂 reasoning workflow | 3000-8000 token |

超过 8000 token 还搞不定，多半是任务该拆分（参见 [../langgraph/04-control-flow.md](../langgraph/04-control-flow.md)）。

## 8. 一段可运行代码：4 件套对照

```python
import anthropic

client = anthropic.Anthropic()

# === Role ===
ROLE = """你是一个金融新闻分类助手，处理中文财经新闻。
你只做分类，不做投资建议。"""

# === Instruction ===
INSTRUCTION = """对给定新闻判断：
1. 主要话题（macro/equity/crypto/forex/commodity/other）
2. 情绪倾向（bullish/bearish/neutral）
3. 提及的实体（公司 / 人物 / 资产代码）

如果信息不足无法判断，对应字段返回 null。"""

# === Format ===
FORMAT = """输出 JSON：
{
  "topic": "macro" | "equity" | "crypto" | "forex" | "commodity" | "other",
  "sentiment": "bullish" | "bearish" | "neutral",
  "entities": ["实体名"],
  "confidence": 0.0~1.0
}
不要输出 ```json``` 围栏，直接输出对象。"""

SYSTEM = f"{ROLE}\n\n{INSTRUCTION}\n\n{FORMAT}"

# === Context (per-call) ===
def classify(news: str) -> dict:
    import json
    resp = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=512,
        system=SYSTEM,
        messages=[{"role": "user", "content": f"<news>{news}</news>"}],
        temperature=0,
    )
    text = resp.content[0].text.strip()
    # 兜底：如果还是套了围栏，剥掉
    if text.startswith("```"):
        text = text.split("```")[1].lstrip("json\n")
    return json.loads(text)

if __name__ == "__main__":
    sample = "美联储宣布维持利率不变，市场普遍预期 6 月降息，纳指收涨 1.2%。"
    print(classify(sample))
```

这段代码每个区块都对应一件套，便于单独迭代——比如未来要换中文 → 英文新闻，只改 ROLE，其他不动。

## 9. 4 件套自检清单

每写完一个 prompt，过一遍：

- [ ] **Role**：明确说了角色、领域、行为边界？
- [ ] **Instruction**：动词清晰？步骤显式？
- [ ] **Context**：必要的事实 / 约束齐全？变量用占位符标识？
- [ ] **Format**：输出 schema 明确？非法情况怎么返回？
- [ ] **Negative space**：明确说了"不要做什么"？
- [ ] **测试**：至少跑了 5 个 case，包括边界？

不到 6 个全勾，不要交付。

## 常见坑

1. **角色 = 头衔**：堆"世界顶级专家"等空话，不写行为约束。改用"只做 X / 不做 Y / 边界情况返回 Z"的句式。
2. **指令藏在 prompt 中段**：长 prompt 把"输出 JSON"埋在第 30 行。把关键格式约束放开头和结尾各一遍。
3. **Format 描述自然语言化**：写"请用一种合适的结构化方式输出"。模型的"合适"和你的"合适"差三个量级。直接给 schema。
4. **没有 negative space**：只说"做 A"，不说"不要做 B"。模型会发挥它的"创意"——比如多写一段解释，破坏 JSON 解析。
5. **temperature 没锁定就改 prompt**：评测期 temperature=1 跑两次都不一样，根本判断不了 prompt 改了之后是变好还是抽签。评测时永远 temperature=0。

## 下一步

- [03 · Few-shot 设计](./03-few-shot.md) — 4 件套之外，示例是最强杠杆
- [05 · 指令调优与输出约束](./05-instruction-tuning.md) — JSON mode / Pydantic / Tool calling 的硬约束
- [07 · 模型差异](./07-model-differences.md) — 4 件套在不同模型上的偏好
- [10 · Prompt 评测与迭代](./10-evaluation.md) — 怎么验证你的 4 件套真的有效
