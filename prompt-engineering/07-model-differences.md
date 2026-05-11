# 07 · 模型差异：GPT / Claude / DeepSeek / Qwen

> TLDR：同一个 prompt 跑到 5 个模型上，输出风格、格式偏好、安全策略都不一样。生产 prompt 想多家通用，必须知道每家的"口味"——Claude 爱 XML、GPT 爱 markdown、Qwen 中文友好、DeepSeek 性价比、Gemini 长上下文。本章给一份移植清单。

## 1. 模型家族速查表

| 家族                    | 旗舰（截至 2026 早期）                   | 上下文       | 强项               | Prompt 偏好           |
| --------------------- | ------------------------------- | --------- | ---------------- | ------------------- |
| OpenAI GPT            | GPT-5 / 4o / o1 / o3            | 128K-256K | 通用、tool calling 生态 | Markdown、JSON mode |
| Anthropic Claude      | Claude 4 / 4.5 / 4.7            | 200K      | 长文本、安全、写作        | XML 标签、明确结构          |
| DeepSeek              | V3 / R1                         | 128K      | 中文、代码、推理（性价比之王） | 中文友好，无明显偏好          |
| Alibaba Qwen          | Qwen2.5 / Qwen3                 | 32K-128K  | 中文、东亚语言、开源       | 中文母语                |
| Google Gemini         | 2.5 Pro / Flash                 | 1M-2M     | 超长上下文、多模态        | 自然语言指令、Markdown      |
| Meta Llama            | 3.3 / 4                         | 128K      | 开源自部署            | 通用，需要 explicit prompt |
| 国产开源（Yi、智谱、Moonshot） | 各家旗舰                            | 32K-200K  | 国内合规、中文          | 各异                  |

## 2. Prompt 偏好对比

| 维度                 | GPT             | Claude          | DeepSeek    | Qwen        | Gemini       |
| ------------------ | --------------- | --------------- | ----------- | ----------- | ------------ |
| 结构标记偏好             | Markdown / JSON | **XML**         | 无明显偏好       | Markdown    | Markdown      |
| 系统消息支持             | 是               | 是（独立 system 字段） | 是           | 是           | 是             |
| Few-shot 收益        | 高               | 高               | 中           | 高           | 中             |
| 输出 JSON 稳定性        | 高（有 JSON mode）   | 高（XML 更稳）       | 中           | 中           | 中             |
| Tool calling 成熟度   | **最成熟**         | 成熟              | 成熟          | 中           | 成熟            |
| 中文理解               | 中-高             | 高               | **极高**       | **极高**       | 高             |
| 长上下文召回             | 中（128K 后衰减）     | 高（200K 内稳）      | 中           | 中           | **高（1M 内稳）** |
| 拒答倾向               | 中               | **高**（最严格）      | 低           | 中           | 中             |
| 角色扮演（roleplay）支持   | 中               | 严（限制多）          | 宽           | 宽           | 中             |
| Reasoning 内置（thinking） | o1/o3 系列      | Claude thinking | R1          | QwQ         | 2.5 系列       |

## 3. 各家 prompt 偏好深入

### 3.1 Claude：XML 标签是亲妈

Anthropic 官方推荐用 XML 标签组织 prompt：

```text
<context>
用户上传了一份合同。
</context>

<task>
找出所有"风险条款"，并给出修改建议。
</task>

<output_format>
<risks>
  <risk>
    <clause>原文</clause>
    <reason>风险说明</reason>
    <suggestion>建议</suggestion>
  </risk>
  ...
</risks>
</output_format>
```

实测 Claude 对 XML 标签的遵守率比 JSON 高一档。

### 3.2 GPT：Markdown + JSON mode

GPT 系训练数据 markdown 占比大，对 `## Heading` 风格的结构敏感：

```text
## Task
Classify the sentiment of the following text.

## Output Format
JSON with fields:
- `sentiment`: positive | negative | neutral
- `confidence`: 0-1

## Examples
[...]

## Input
{user_text}
```

需要严格 JSON 时使用 `response_format={"type": "json_object"}` 或 structured output（参见 §05）。

### 3.3 DeepSeek：实用主义，无明显偏好

DeepSeek 训练数据中英文都海量，对结构标记不挑食。Prompt 直接陈述任务即可，**不需要**特别堆 XML 或 markdown。

R1 推理模型有专门的 `<think>...</think>` 输出，注意：

- API 默认会返回 thinking 内容，需要在程序侧剥离
- 不要在 prompt 里手写 "step by step"

### 3.4 Qwen：中文母语，对中文系统 prompt 友好

Qwen 在中文 task 上常常超过 GPT-4。**中文 system prompt 比英文 system prompt 效果还好**——其他模型反过来。

```text
[针对 Qwen]
你是金融分析师，输出格式如下：
- 主要观点：...
- 风险提示：...

（用纯中文 prompt 即可，效果比英文翻译版好）
```

### 3.5 Gemini：长上下文 + 自然语言

Gemini 1M-2M 上下文对 RAG / 长文档分析友好。Prompt 风格偏自然语言：

- 不需要太多结构标记
- 在 1M 上下文内 needle-in-haystack 召回率仍高

## 4. 系统消息：位置与数量

| 模型              | system 字段                 | 多 system 消息支持            |
| --------------- | ------------------------- | ----------------------- |
| GPT-4 / 4o / 5  | `messages: [{role:"system"}]` | 支持多条，但建议合并              |
| Claude          | 独立 `system` 参数             | 不支持多 system，一条字符串       |
| DeepSeek        | 同 OpenAI 格式                | 支持，但建议合并                |
| Qwen            | 同 OpenAI 格式                | 支持                      |
| Gemini          | `system_instruction`       | 不支持多条                   |

**最佳实践**：

- 把所有规则合并成 **一条** system，跨家族最兼容
- Claude 用户：把 system 写成 XML 多段 (`<role>` `<task>` `<rules>`)
- 不要把 user 输入塞进 system

## 5. Tool calling schema 差异

主流厂商 tool calling schema 大同小异，但有 corner case：

| 维度          | OpenAI                                | Anthropic                          | Gemini                          |
| ----------- | ------------------------------------- | ---------------------------------- | ------------------------------- |
| 字段名         | `tools`, `tool_choice`                | `tools`, `tool_choice`             | `tools`, `tool_config`          |
| 工具描述位置      | `tools[].function.description`        | `tools[].description`              | `tools[].functionDeclarations[].description` |
| 输入 schema   | `parameters`（JSON Schema）             | `input_schema`（JSON Schema）         | `parameters`（JSON Schema）       |
| 强制调用某工具     | `tool_choice={"type":"function","function":{"name":"x"}}` | `tool_choice={"type":"tool","name":"x"}` | 类似 OpenAI                       |
| 并行调用        | ✅                                     | ✅                                  | ✅                               |
| 工具响应消息格式    | `role:"tool"`                         | `role:"user"` + `tool_result` 块    | `role:"function"`               |

跨厂商写代码建议用 LangChain / LiteLLM 等抽象层，参见 [../langchain/06-tools-and-function-calling.md](../langchain/06-tools-and-function-calling.md)。

## 6. 跨家族 prompt 移植清单

把一个 prompt 从 A 模型移植到 B 模型时，过一遍：

```text
□ 结构标记
   ├─ 从 GPT 移到 Claude → 把 ## Heading 转 <heading>
   └─ 从 Claude 移到 GPT → XML 标签转 markdown 标题

□ JSON 输出
   ├─ Claude / DeepSeek → 强调"不要 ```json 围栏"
   └─ GPT → 用 JSON mode 或 structured output

□ Tool 描述
   └─ 重写每个工具的 description，确保新模型能解析意图

□ 安全 / 拒绝
   ├─ Claude → 拒答多，需要在 system 明确"不要无端拒绝合理请求"
   └─ DeepSeek / Qwen → 拒答少，反而要加更多禁区

□ 中文 prompt
   ├─ 移到 Qwen / DeepSeek → 中文 prompt 直接用，效果可能更好
   └─ 移到 GPT / Claude → 中文 prompt 也行，但 RAG 资料英文化更稳

□ 长上下文
   ├─ Gemini → 可塞 500K，但仍建议总结再用
   └─ 其他 → > 100K 必须 RAG 化

□ Reasoning
   ├─ 普通模型 → 加 CoT prompt
   └─ Reasoning 模型 → 删掉 CoT prompt，让模型自己思考

□ Persona
   └─ Claude 严格 → roleplay 类 prompt 可能被拒，改用"职业化"风格

□ Temperature
   └─ 默认值不同：DeepSeek 默认 1.0、OpenAI 默认 1.0、Claude 默认 1.0
      但同一 temperature 下分布形状不同，需要重新调

□ Max tokens
   └─ 各家 token 计费差异大，移植后重测成本

□ 评测
   └─ 必须用 §10 的方法跑回归集，不能"看起来差不多"就上线
```

## 7. 一段可运行代码：跨厂商抽象

```python
# pip install openai anthropic
import os
import json
from openai import OpenAI
import anthropic

oa = OpenAI()
ant = anthropic.Anthropic()

SYSTEM_BASE = """你是中文情感分析助手。
输出严格 JSON：{"sentiment": "positive|negative|neutral", "confidence": 0-1}
不要 markdown 围栏，不要其他文字。"""

# Claude 偏好的 system 改写（XML 化）
SYSTEM_CLAUDE = """<role>中文情感分析助手</role>

<output_format>
严格 JSON：
{"sentiment": "positive|negative|neutral", "confidence": 0-1}
</output_format>

<rules>
- 不要 markdown 围栏
- 不要任何 JSON 之外的文字
</rules>
"""

def call_openai(text: str, model: str = "gpt-4o-mini") -> dict:
    resp = oa.chat.completions.create(
        model=model,
        response_format={"type": "json_object"},
        temperature=0,
        messages=[
            {"role": "system", "content": SYSTEM_BASE},
            {"role": "user", "content": text},
        ],
    )
    return json.loads(resp.choices[0].message.content)

def call_claude(text: str, model: str = "claude-sonnet-4-5") -> dict:
    resp = ant.messages.create(
        model=model,
        max_tokens=256,
        system=SYSTEM_CLAUDE,
        temperature=0,
        messages=[{"role": "user", "content": text}],
    )
    return json.loads(resp.content[0].text)

def call_deepseek(text: str, model: str = "deepseek-chat") -> dict:
    """DeepSeek 兼容 OpenAI SDK，仅 base_url 不同。"""
    client = OpenAI(
        api_key=os.environ["DEEPSEEK_API_KEY"],
        base_url="https://api.deepseek.com",
    )
    resp = client.chat.completions.create(
        model=model,
        response_format={"type": "json_object"},
        temperature=0,
        messages=[
            {"role": "system", "content": SYSTEM_BASE},
            {"role": "user", "content": text},
        ],
    )
    return json.loads(resp.choices[0].message.content)

if __name__ == "__main__":
    text = "服务太差，再也不来了。"
    for name, fn in [("openai", call_openai), ("claude", call_claude), ("deepseek", call_deepseek)]:
        try:
            print(name, "→", fn(text))
        except Exception as e:
            print(name, "→ failed:", e)
```

要点：

- 同一份语义，三个模型各自最适的 prompt 形式
- Claude 用 XML，OpenAI / DeepSeek 用 JSON mode
- temperature=0 + JSON 强约束，最大化跨模型一致性

## 8. 模型升级（4o → 5）时 prompt 该不该改

新模型出来时常见问题：旧 prompt 还能用吗？

| 升级幅度        | 旧 prompt 处理                                           |
| ----------- | ----------------------------------------------------- |
| 小版本（4 → 4o） | 一般直接兼容，必要时跑回归集                                        |
| 同代次（4o → 5） | 需重测——能力变强后，旧 prompt 里的"补丁规则"可能多余                     |
| 跨代（3.5 → 4） | **必须重写**——旧 prompt 里的 CoT、咒语、补丁，新模型不需要                |
| 切到 reasoning（→ o1） | **必须重写**——CoT 全删，prompt 极简化                          |
| 跨厂商         | 必须按本章 §6 清单移植                                         |

**反直觉建议**：升级模型时，**先把 prompt 简化**，再看是否需要补回去。新模型常常让旧 prompt 的"补丁"显得冗余甚至有害。

## 9. 国产模型 vs 海外模型选型

| 维度          | 国产（DeepSeek / Qwen / 智谱）        | 海外（GPT / Claude）         |
| ----------- | ------------------------------ | ------------------------ |
| 中文能力        | **极强**                          | 强                        |
| 中国合规要求      | 满足                             | 不满足（需要海外部署）              |
| 价格          | **便宜 5-10×**                    | 贵                        |
| 长上下文        | 一般 128K 内                       | 200K-2M                  |
| Tool calling | 成熟度追上中                        | 最成熟                      |
| 多模态         | 追赶中                           | 领先                       |
| 安全 / 越狱难度   | 较易越狱                            | 较难                       |
| API 稳定性     | 提升中                            | 高                        |

**选型经验**：

- 中文为主、成本敏感、合规要求 → DeepSeek / Qwen
- 长文档、多模态、tool calling 复杂 → Claude / GPT
- Agent 框架最成熟 → GPT（OpenAI 生态）
- 写作 / 推理 → Claude
- 推理 + 性价比 → DeepSeek-R1

## 常见坑

1. **照搬 GPT prompt 给 Claude 用**：一堆 ## markdown，Claude 解析得一般，少用 XML 损失 5-15% 质量。Claude 用户改 XML。
2. **Claude 上写 CoT 给 thinking 模式**：thinking mode 已内置 reasoning，外部 CoT 干扰。Reasoning 模型只给规则。
3. **Qwen / DeepSeek 上用英文 prompt**：以为"英文 prompt 更专业"，实际中文 prompt 在国产模型上效果常更好。
4. **多 system 消息跨厂商**：在 OpenAI 上写 3 条 system，移植到 Claude 直接报错——Claude 只支持一条。合并成一条最兼容。
5. **Tool 描述照搬**：工具 description 在不同模型上理解度差异大，移植后必须重测 tool 调用准确率。
6. **不重测 temperature**：DeepSeek 推荐 temperature=1.3 用于代码，OpenAI 推荐 0.7，Claude 推荐 0.3。同一 temperature 在不同模型上分布不同，必须重新调。

## 下一步

- [08 · Prompt 模板化与版本管理](./08-templates.md) — 跨模型 prompt 怎么管理
- [10 · Prompt 评测与迭代](./10-evaluation.md) — 模型升级 / 切换时怎么验回归
- [04 · CoT](./04-cot.md) — Reasoning 模型相关 prompt 调整
- [../langchain/](../langchain/README.md) — 跨厂商抽象层
