# 多模态

> 2025 LLM 应用最显著的崛起方向：**模型已经不止读字了**。本主题从工程视角覆盖 VLM、文档、图表、音频、视频、多模态 RAG 与 Agent，目标是让你能把"图/音/视频"接进真实业务管道。

## 章节索引

1. [01 · 概览：VLM / 模型家族 / 能力边界](./01-overview.md) — 多模态 LLM 简史、主流模型分类、能力边界与 token 成本。
2. [02 · 图像理解](./02-vision.md) — VQA、OCR、定位、计数、多图输入与 prompt 设计。
3. [03 · 文档理解](./03-documents.md) — PDF / 扫描件 / 复杂版式的真实业务路径。
4. [04 · 表格与图表](./04-charts.md) — 表格结构化、chart-to-table 与精度坑。
5. [05 · 多模态 RAG](./05-multimodal-rag.md) — 文图混合检索、ColPali、视觉 RAG 新范式。
6. [06 · 音频](./06-audio.md) — ASR / TTS / 实时流式语音 Agent 全栈。
7. [07 · 视频](./07-video.md) — 关键帧抽取、时序理解、长视频策略。
8. [08 · 多模态 Agent](./08-multimodal-agent.md) — VLM + 工具循环、Computer Use、UI Agent。
9. [09 · 模型选型](./09-model-selection.md) — GPT-4o / Claude / Gemini / Qwen-VL 决策矩阵。
10. [10 · 评测与生产化](./10-production.md) — 多模态评测、监控、对抗安全、上线 checklist。

## 与其他主题的关系（速查表）

| 本主题章节 | 相关主题 | 关系 |
| ---------- | --------- | ---- |
| 全主题 | [`../langchain/`](../langchain/) | LangChain 的多模态消息 / 文件 loader 是工具层。 |
| §08 多模态 Agent | [`../langgraph/`](../langgraph/) | 视觉 Agent 的状态机与 ReAct 循环。 |
| §05 多模态 RAG | [`../rag-advanced/08-multimodal-and-structured.md`](../rag-advanced/08-multimodal-and-structured.md) | 本主题 §3-§5 在其基础上深化，不复述基础概念。 |
| §10 评测 | [`../eval/`](../eval/) | 评测体系基座；§10 只讲多模态特化部分。 |
| §08 工具调用 | [`../agents/04-tool-use.md`](../agents/04-tool-use.md) | 工具调用基础；§08 引用并扩展到视觉工具。 |
| §08 设计原则 | [`../agents/`](../agents/) | Agent 设计与失败模式。 |

## 资源

**官方文档**

- [OpenAI Vision](https://platform.openai.com/docs/guides/vision)
- [Anthropic Vision](https://docs.anthropic.com/en/docs/build-with-claude/vision)
- [Gemini Multimodal](https://ai.google.dev/gemini-api/docs/vision)
- [Qwen2.5-VL](https://github.com/QwenLM/Qwen2.5-VL) — 国产首选

**开源 VLM**

- InternVL — <https://github.com/OpenGVLab/InternVL>
- Llava 系列 — <https://github.com/haotian-liu/LLaVA>
- DeepSeek-VL — <https://github.com/deepseek-ai/DeepSeek-VL>
- Llama 3.2 Vision — <https://www.llama.com/>

**文档处理工具**

- Marker — <https://github.com/VikParuchuri/marker>
- Docling — <https://github.com/DS4SD/docling>
- MinerU — <https://github.com/opendatalab/MinerU>
- unstructured — <https://github.com/Unstructured-IO/unstructured>
- ColPali — <https://github.com/illuin-tech/colpali>（视觉 RAG 新范式）

**音视频**

- Whisper — <https://github.com/openai/whisper>
- Deepgram — <https://deepgram.com/>
- ElevenLabs（TTS）— <https://elevenlabs.io/>

**评测基准**

- MMMU — <https://mmmu-benchmark.github.io/>
- MMBench — <https://github.com/open-compass/MMBench>
- ChartQA / DocVQA / MathVista
- Video-MME — <https://video-mme.github.io/>

**论文（必读）**

- CLIP (Radford et al., 2021)
- Flamingo (Alayrac et al., 2022)
- GPT-4V System Card (OpenAI, 2023)
- ColPali (Faysse et al., 2024) — 视觉 RAG 新范式

## 阅读顺序建议

- **完整路径**：§01 → §02 → §03/§04 → §05 → §06/§07 → §08 → §09 → §10
- **赶 PoC**：§01 → §02 → §09（选模型）→ §10（最小评测）
- **做文档抽取**：§01 → §03 → §04 → §05
- **做语音 / 视频 Agent**：§01 → §06/§07 → §08
- **选型决策**：§01 → §09 → §10
