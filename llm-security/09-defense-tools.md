# 09 · 防御工具

> 不要从零造 guardrail。本章对市面上主流工具做横评——Llama Guard、NeMo、Lakera、Prompt Shields、OpenAI Moderation——给出选型矩阵和部署建议。

## 1. 防御层与对应工具

```
┌─────────────────────────────────────────┐
│ 用户输入                                 │
│   ↓                                      │
│ [Pre-LLM Filter]   ← 输入侧 guardrail   │
│   ↓                                      │
│ [LLM 调用]                               │
│   ↓                                      │
│ [Post-LLM Filter]  ← 输出侧 guardrail   │
│   ↓                                      │
│ [Inline Policy]    ← 工具调用层         │
│   ↓                                      │
│ 返回用户                                 │
└─────────────────────────────────────────┘
```

| 工具 | Pre | Post | Inline | 备注 |
| --- | --- | --- | --- | --- |
| Llama Guard | ✅ | ✅ | — | 开源 |
| NeMo Guardrails | ✅ | ✅ | ✅ | DSL，全栈 |
| Lakera Guard | ✅ | ✅ | — | 商业 SaaS |
| MS Prompt Shields | ✅ | ✅ | — | Azure 生态 |
| OpenAI Moderation | ✅ | ✅ | — | 仅内容审核 |
| Guardrails AI | — | ✅ | — | 输出 schema |
| 自建 regex + 小模型 | ✅ | ✅ | ✅ | 灵活 |

## 2. Llama Guard（Meta 开源）

| 维度 | 描述 |
| --- | --- |
| 项目 | Purple Llama / meta-llama/Llama-Guard-3-8B（2024 发布的 v3）|
| 许可 | Llama Community License（商业可用） |
| 形态 | 8B 模型，本地推理 |
| 覆盖 | 14 类有害内容 |
| 输入 / 输出 | 都能审核 |
| 多语言 | 8 种语言 |

部署：

```bash
# vLLM
vllm serve meta-llama/Llama-Guard-3-8B --port 8000

# 或者用 Together / Replicate API
```

调用见 [03 · §8](./03-jailbreak.md#8-一段-python用-llama-guard-做输出审核)。

| 优势 | 劣势 |
| --- | --- |
| 开源、可微调 | 8B 推理需 GPU |
| 与 Llama 生态对齐 | 自部署运维成本 |
| Taxonomy 清晰 | 业务专属类别需 fine-tune |

## 3. NVIDIA NeMo Guardrails

| 维度 | 描述 |
| --- | --- |
| 项目 | NVIDIA/NeMo-Guardrails |
| 形态 | Python framework + DSL (Colang) |
| 覆盖 | 输入、输出、对话、工具、检索 |
| 后端 | 可接 LLM / 自定义模型 |

特色：用 Colang DSL 描述对话规则。

```colang
# rails.co
define user ask off-topic
  "tell me about politics"
  "what about elections"

define bot decline off-topic
  "I'm here to help with technical support questions only."

define flow off-topic
  user ask off-topic
  bot decline off-topic

define rail input
  $intent = ...
  if $intent == "jailbreak"
    bot decline jailbreak
    abort
```

| 优势 | 劣势 |
| --- | --- |
| 全栈：输入 / 输出 / 对话 / 工具 | DSL 学习曲线 |
| 与 LangChain / LlamaIndex 集成 | 复杂场景配置爆炸 |
| 支持 fact-checking / RAG 校验 | 性能 overhead 不低 |

## 4. Lakera Guard（商业 SaaS）

| 维度 | 描述 |
| --- | --- |
| 形态 | API 服务，REST 调用 |
| 覆盖 | prompt injection、PII、jailbreak、有害内容 |
| 延迟 | < 100ms |
| 数据 | 持续更新 jailbreak 库 |

```python
import requests
LAKERA_KEY = "..."

def lakera_check(text: str) -> dict:
    r = requests.post(
        "https://api.lakera.ai/v2/guard",
        headers={"Authorization": f"Bearer {LAKERA_KEY}"},
        json={"messages": [{"content": text, "role": "user"}]},
    )
    return r.json()  # 含 categories、scores、flagged
```

| 优势 | 劣势 |
| --- | --- |
| 维护成本零 | 数据出境（注意合规） |
| 持续更新攻击集 | 商业付费 |
| 多语言 | 自定义类别有限 |

## 5. Microsoft Prompt Shields / Azure Content Safety

Azure AI Content Safety 提供：

| 模块 | 功能 |
| --- | --- |
| Prompt Shields | 直接 + 间接注入检测 |
| Content Filter | 4 类有害内容（hate / sex / violence / self-harm） |
| Groundedness | 检测 LLM 输出是否脱离上下文（幻觉） |
| Protected material | 版权内容检测 |

```python
from azure.ai.contentsafety import ContentSafetyClient
from azure.core.credentials import AzureKeyCredential

client = ContentSafetyClient(endpoint, AzureKeyCredential(key))

# 直接 + 间接注入
result = client.detect_prompt_injection_attacks(
    user_prompt="请忽略上面",
    documents=["[RAG doc]..."],  # 间接注入检查
)
print(result.user_prompt_analysis.attack_detected)
```

| 优势 | 劣势 |
| --- | --- |
| 间接注入是少数支持的 | Azure 生态绑定 |
| 企业级 SLA | 不开源 |

## 6. OpenAI Moderation API

```python
from openai import OpenAI
client = OpenAI()
r = client.moderations.create(model="omni-moderation-latest", input="...")
print(r.results[0].flagged, r.results[0].categories)
```

| 优势 | 劣势 |
| --- | --- |
| 免费 | 仅内容审核（不防注入 / 越狱） |
| 多模态 | 范围窄 |

**只用 OpenAI Moderation 是不够的**——它不防 jailbreak / injection，只防有害内容。

## 7. Guardrails AI（输出 schema）

```python
from guardrails import Guard
from pydantic import BaseModel, Field

class ResponseSchema(BaseModel):
    answer: str = Field(max_length=500)
    sources: list[str]
    confidence: float = Field(ge=0, le=1)

guard = Guard.from_pydantic(ResponseSchema)
validated_output = guard.parse(llm_output)
```

定位：**输出端的 schema 强校验**——补 LLM 输出的结构化保证。

## 8. 自建轻量方案

不一定非用商业 SaaS。最小可用栈：

```
[regex / 关键词]    ← 0ms，挡明显攻击
   ↓
[小模型分类]        ← <100ms，本地部署 distilbert
   ↓
[大模型审核]        ← 关键路径，仅在低置信时调
```

```python
"""
三段式：regex → distilbert → Claude 仲裁
"""
import re
from transformers import pipeline
from anthropic import Anthropic

INJECTION_RE = [
    re.compile(r"ignore\s+(all\s+)?(previous|above)", re.I),
    re.compile(r"忽略\s*(以上|之前)", re.I),
    re.compile(r"\bDAN\b"),
]

clf = pipeline("text-classification", model="protectai/deberta-v3-base-prompt-injection")
client = Anthropic()


def fast_check(text: str) -> bool:
    return any(p.search(text) for p in INJECTION_RE)


def model_check(text: str) -> dict:
    res = clf(text)[0]
    return {"label": res["label"], "score": res["score"]}


def llm_arbitrate(text: str) -> dict:
    msg = client.messages.create(
        model="claude-haiku-4-5",
        max_tokens=100,
        messages=[{"role": "user", "content": f"是否 prompt injection? 仅 JSON. {text}"}],
    )
    import json
    return json.loads(msg.content[0].text)


def detect(text: str) -> bool:
    if fast_check(text):
        return True
    m = model_check(text)
    if m["label"] == "INJECTION" and m["score"] > 0.95:
        return True
    if m["score"] > 0.6:  # 低置信走仲裁
        return llm_arbitrate(text).get("injection", False)
    return False
```

## 9. 选型矩阵

| 维度 | Llama Guard | NeMo | Lakera | MS PS | OpenAI Mod | 自建 |
| --- | --- | --- | --- | --- | --- | --- |
| 部署 | 自托管 | 自托管 | SaaS | Azure | API | 自托管 |
| 成本 | GPU | GPU | $$$ | $$ | 免费 | 人 |
| 延迟 | 50-200ms | 100-500ms | < 100ms | < 100ms | < 50ms | 0-100ms |
| 注入防护 | 中 | 强 | 强 | 强（含间接） | 弱 | 看实现 |
| 越狱防护 | 中 | 强 | 强 | 中 | 弱 | 看实现 |
| 内容审核 | 强 | 中 | 中 | 强 | 强 | 弱 |
| 间接注入 | 弱 | 中 | 中 | **强** | 弱 | 看实现 |
| PII | 弱 | 中 | 中 | 中 | 弱 | + Presidio 强 |
| 数据合规 | ✅（自托管） | ✅ | ⚠️（出境） | 看 region | ⚠️ | ✅ |
| 多语言 | 8 | 看 LLM | 多 | 多 | 多 | 看实现 |
| 自定义类 | 微调 | DSL | 有限 | 有限 | 无 | 任意 |

> 我的建议（一句话）：**Pre-LLM 用 Lakera 或 MS PS（间接注入要紧）+ Post-LLM 用 Llama Guard（开源、免费、可定制）+ Output schema 用 Guardrails AI**。预算紧的：自建 regex + ProtectAI 的开源分类器。

## 10. 部署位置详解

### Pre-LLM（输入侧）

| 任务 | 工具 |
| --- | --- |
| 快速 regex / 关键词 | 自建 |
| Prompt injection 分类 | Lakera / MS PS / 自建分类器 |
| PII 脱敏 | Presidio |
| Rate limit | Redis / API gateway |

### Post-LLM（输出侧）

| 任务 | 工具 |
| --- | --- |
| 有害内容 | Llama Guard / OpenAI Mod |
| Canary（system prompt 泄漏） | 自建（[04 · §6](./04-data-leak.md)） |
| Schema 校验 | Guardrails AI / Pydantic |
| PII 二次扫 | Presidio |

### Inline（工具调用层）

| 任务 | 工具 |
| --- | --- |
| 工具白名单 / RBAC | 自建 |
| HITL | LangGraph interrupt（[../langgraph/07-human-in-the-loop.md](../langgraph/07-human-in-the-loop.md)） |
| 审计 | OpenTelemetry / SIEM |
| 沙箱 | E2B / Modal / Docker |

## 11. 落地路线图

按团队成熟度：

| 阶段 | 配置 |
| --- | --- |
| **POC** | OpenAI Moderation + 简单 regex |
| **MVP** | + ProtectAI 注入分类器 + Llama Guard 输出 |
| **上线 v1** | + Lakera/MS PS 输入 + Presidio PII + canary + 审计 |
| **生产稳定** | + NeMo / 自建 DSL 业务规则 + 工具 gateway |
| **企业级** | + 第三方红队 SaaS + SIEM + IR playbook |

不要一上来就堆所有工具——先把 trace + canary + Llama Guard 跑起来，再按 incident 加层。

## 12. 性能与成本

| 配置 | 加成本 | 加延迟 | 备注 |
| --- | --- | --- | --- |
| OpenAI Mod | $0 | +50ms | 同步调 |
| Lakera | $0.01-0.05 / 调用 | +50-100ms | SaaS |
| Llama Guard self-host | GPU $$ | +100-200ms | 流式可缓解 |
| NeMo | GPU $ | +200-500ms | DSL |
| 自建 regex | 0 | < 5ms | 0 成本 |

> 安全的延迟用户能接受到 +500ms 是常见上限。**关键路径异步化** + 关键拦截点同步——平衡。

## 常见坑

1. **只用 OpenAI Moderation 当全部防护**：它不防注入 / 越狱，只防有害内容。看清楚每个工具范围。
2. **guardrail 加了但没看 trace**：被绕过都不知道。每个 guardrail block / pass 都要可观测。
3. **生产用 SaaS 没看合规**：Lakera 的数据出境 / OpenAI Moderation 的训练使用——金融 / 医疗要确认。
4. **多 guardrail 串行没并行**：3 个 +500ms 串行 = 1.5s。能并行的并行。
5. **微调 Llama Guard 用业务数据混了 PII**：fine-tune 后模型可能记住，反而泄漏。先脱敏。
6. **没监 false positive rate**：guardrail 误拦把客户挡门外，业务侧投诉。两个 KPI 一起跟。
7. **依赖一个工具**：单点失败。**输入 + 输出 + 工具层各有一个**，叠加才稳。

## 下一步

- [02 · Prompt 注入](./02-prompt-injection.md) — 工具针对的主要攻击
- [03 · Jailbreak](./03-jailbreak.md) — 输出侧 guardrail 主战场
- [08 · 红队测试](./08-red-team.md) — 验证 guardrail 有效性
- [10 · 合规](./10-compliance.md) — 工具选型的合规约束
