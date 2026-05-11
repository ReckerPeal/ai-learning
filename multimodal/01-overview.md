# 01 · 概览：VLM / 模型家族 / 能力边界

多模态不是"加个图片输入"那么简单。**模型架构、token 计费、能力上限**全都不一样了。本章建立全景，后续章节按场景深入。

## 1. 一段简史（按时间）

| 年份 | 里程碑 | 关键贡献 |
| ---- | ------ | -------- |
| 2021 | CLIP（OpenAI） | 文图对比学习 → 跨模态向量空间，至今 RAG 仍在用。 |
| 2022 | Flamingo（DeepMind） | 把视觉 token 注入到 LLM 注意力层，开启 VLM 时代。 |
| 2023.03 | GPT-4V | 首个真正可用的商用 VLM，OCR / VQA 能力震撼。 |
| 2023.10 | Llava-1.5 | 开源能跑的 VLM，把 VLM 变成"人人能玩"。 |
| 2024.05 | GPT-4o | 原生多模态（同模型吃文/图/音），延迟降一个量级。 |
| 2024.06 | Claude 3.5 Sonnet | 文档理解 / 图表读数能力对标 GPT-4o。 |
| 2024.06 | ColPali | 直接对**页面图像**做检索，跳过 OCR。 |
| 2024.09 | Llama 3.2 Vision | Meta 开源 VLM，可本地部署。 |
| 2024.12 | Gemini 2.0 | 长视频、原生工具调用、Live API。 |
| 2025 | Qwen2.5-VL / InternVL2.5 | 国产开源 VLM 拉到接近闭源水平。 |

**结论**：**2024 年起，多模态从"展示型 demo"变成"可工程化"。** 2025 年关键词是**视频 + Agent + ColPali 类视觉 RAG**。

## 2. 模型家族矩阵

| 模型 | 厂商 | 模态 | 强项 | 弱项 | API |
| ---- | ---- | ---- | ---- | ---- | --- |
| GPT-4o / 4o-mini | OpenAI | 文图音 | 综合最强、延迟低、生态全 | 价格中等、视频弱 | `chat.completions` |
| GPT-4.1 / o-series | OpenAI | 文图 | 长上下文、推理强 | 价格高 | 同上 |
| Claude 3.5 / 4 Sonnet | Anthropic | 文图 | 文档理解 / 图表读数 / Computer Use | 不接受音频 | `messages` |
| Gemini 2.0 / 2.5 | Google | 文图音视频 | 视频 / 长上下文 / 价格 | 中文略逊 | `generateContent` |
| Qwen2.5-VL（72B） | 阿里 | 文图视频 | 中文 / OCR / bbox / 视频 | 生态偏弱 | DashScope / 自部署 |
| Llama 3.2 Vision | Meta | 文图 | 开源、可商用 | 中文一般 | 自部署 |
| InternVL 2.5 / 3 | 上海 AI Lab | 文图视频 | 开源 SOTA、文档 | 部署成本 | 自部署 |
| Pixtral | Mistral | 文图 | 欧洲合规 | 一般 | API / 自部署 |

## 3. 模型分类：原生 vs 拼接

| 类型 | 代表 | 工作方式 | 优劣 |
| ---- | ---- | -------- | ---- |
| **原生多模态** | GPT-4o / Gemini 2.0 | 单一模型同时处理多种模态，token 同空间 | 延迟低、模态间推理自然；成本高 |
| **模态拼接（适配器）** | Llava / Qwen-VL / InternVL | Vision Encoder（如 SigLIP）→ projector → LLM | 训练便宜、可换 LLM；模态融合较浅 |
| **管道拼接** | Whisper + GPT-4 | 各自独立模型串联 | 灵活、可热替换；丢失信息（语调、情绪） |

**工程含义**：自部署多走"适配器"路线（更省）；商用 SaaS 走原生多模态拿能力上限。

## 4. 能力边界（先建立预期）

| 能力 | 当前水平（2025） | 备注 |
| ---- | ----------------- | ---- |
| 描述图片内容 | 强 | VQA 基本可用 |
| OCR（印刷体） | 强 | 接近专用 OCR |
| OCR（手写 / 复杂场景） | 中 | 仍需专用模型 |
| 表格理解（结构化） | 中-强 | 复杂合并单元格仍翻车 |
| 图表读数 | 中 | 数值精度差，建议复核 |
| 物体计数 | 弱 | 超过 ~10 个就开始猜 |
| 物体定位（bbox） | 中 | Qwen-VL / Gemini 较强 |
| 多图比较 | 中 | 通常 ≤ 4 张稳定 |
| 视频长片段 | 中 | Gemini 强；其他需抽帧 |
| 实时音频对话 | 强 | GPT-4o Realtime / Gemini Live |
| 图像生成 | 不在本主题 | 见生成模型主题 |

**铁律**：**模型说得头头是道，不代表它"看清"了**。涉及数字、计数、定位的任务必须做评测。

## 5. 输入分辨率与 token 成本

各家把图片切 patch 的方式不同，**这直接决定了你的账单**。

| 模型 | 计费方式 | 备注 |
| ---- | -------- | ---- |
| GPT-4o | `low`：85 token；`high`：85 + 170×N tile | 每 tile 512×512 |
| GPT-4.1 | 类似，high 模式 patch 更密 | 长边自动缩放至 2048 |
| Claude 3.5 | `(w × h) / 750` ≈ token 数 | 1092×1092 ≈ 1590 token |
| Gemini | 每张固定 ~258 token（小图）；大图分块 | 视频按帧采样计费 |
| Qwen2.5-VL | 按动态分辨率，ViT patch 数 | 自部署可控 |

**经验值**：一张 1024×1024 的图，**约等于 1000-1700 个文本 token**。VQA 系统跑量上去之前先做成本测算。

## 6. 一段最小可跑代码（多家对比）

```python
# pip install openai anthropic google-genai
import base64, pathlib

img_b64 = base64.b64encode(pathlib.Path("invoice.png").read_bytes()).decode()
prompt = "提取这张发票的金额、日期、开票方，输出 JSON。"

# --- OpenAI ---
from openai import OpenAI
oa = OpenAI()
r1 = oa.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": [
        {"type": "text", "text": prompt},
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img_b64}"}},
    ]}],
)
print("OpenAI:", r1.choices[0].message.content)

# --- Anthropic ---
import anthropic
ac = anthropic.Anthropic()
r2 = ac.messages.create(
    model="claude-3-5-sonnet-latest",
    max_tokens=1024,
    messages=[{"role": "user", "content": [
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": img_b64}},
        {"type": "text", "text": prompt},
    ]}],
)
print("Claude:", r2.content[0].text)

# --- Gemini ---
from google import genai
gm = genai.Client()
r3 = gm.models.generate_content(
    model="gemini-2.0-flash",
    contents=[
        {"inline_data": {"mime_type": "image/png", "data": img_b64}},
        prompt,
    ],
)
print("Gemini:", r3.text)
```

**对比同一张发票，三家的差异 95% 来自 prompt 结构与图片质量，而不是模型本身**。

## 7. 学习路径建议

| 你的目标 | 推荐顺序 |
| -------- | -------- |
| 文档处理（合同 / 发票 / 研报） | §02 → §03 → §04 → §05 → §10 |
| 客户端语音助手 | §06 → §08 → §09 → §10 |
| 视频内容理解 / 短视频分析 | §07 → §05 → §09 → §10 |
| Computer Use / UI Agent | §02 → §08 → `../agents/04-tool-use.md` → §10 |
| 自部署 VLM | §01 → §09 → §03/§04 看场景 → §10 |

## 8. 一张表收口本章

| 维度 | 关键点 |
| ---- | ------ |
| 模型选型 | 商用首选 GPT-4o / Claude / Gemini；中文重 Qwen；离线 InternVL |
| 成本意识 | 一张图 ≈ 上千 token；视频按帧爆炸 |
| 工程姿态 | **永远做评测**，不要相信 demo |
| 失败模式 | 数字、计数、定位 → 三大重灾区 |

## 常见坑

- **以为"放进消息里就行"**。每家 API 的图片字段格式都不同（`image_url` vs `image` vs `inline_data`），不要复制粘贴跨模型代码。
- **忽视 detail 参数**。OpenAI `detail: low/high/auto` 的 token 成本差 5-10 倍，默认值不一定省钱。
- **认为"开源 VLM 能替代 GPT-4o"**。在 OCR / 复杂版面 / 长文档上，闭源仍然领先，自部署需要 PoC。
- **把图片 base64 塞进 prompt 字符串**。所有 SDK 都有专门字段；塞字符串会让 LLM 试图"读 base64"。
- **不压缩、不裁剪原图**。手机拍的 4032×3024 图片直接发，token 爆 + 模型反而看不准。先 resize 到长边 1568 内。

## 下一步

- [02 · 图像理解](./02-vision.md) — VQA / OCR / 定位 / 计数的具体玩法。
- [09 · 模型选型](./09-model-selection.md) — 拍板用哪家模型。
- [10 · 评测与生产化](./10-production.md) — 上线前必读。
- [`../rag-advanced/08-multimodal-and-structured.md`](../rag-advanced/08-multimodal-and-structured.md) — RAG 视角的多模态简介。
