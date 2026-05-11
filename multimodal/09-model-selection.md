# 09 · 模型选型

选错模型，再好的工程都白搭。本章给出 2025 年主流多模态模型的横向对比，并按业务场景给出**拍板建议**。

## 1. 决策矩阵：按业务维度

| 维度 / 模型 | GPT-4o | GPT-4o-mini | Claude 3.5/4 | Gemini 2.0/2.5 | Qwen2.5-VL | Llama 3.2 V | InternVL 2.5 |
| ----------- | ------ | ----------- | ------------ | -------------- | ---------- | ----------- | ------------ |
| 综合视觉 | A | B+ | A | A | A- | B | A- |
| OCR 印刷 | A | A- | A | A | A | B+ | A- |
| OCR 手写中文 | B | B- | B | B | A- | C | B+ |
| 文档理解 | A | A- | A | A- | A- | B | A- |
| 图表读数 | A- | B+ | A | A- | B+ | C+ | B+ |
| Bbox 定位 | C | C | C | A | A | C+ | B |
| 视频 | C+ | C | C | A | A- | C | A- |
| 音频原生 | A | A | ✕ | A | C+ | ✕ | ✕ |
| 中文 | A- | A- | A- | B+ | A | B | A |
| 价格 | 中 | 低 | 中 | 低-中 | 中 | 自部署 | 自部署 |
| 速度 | 中 | 快 | 中 | 快 | 中 | 看部署 | 看部署 |
| 工具调用 | A | A | A | A- | B | B | B |
| 自部署 | ✕ | ✕ | ✕ | ✕ | A（开源版） | A | A |

> 评分仅作排序参考，不绝对；建议你在自己业务集上跑评测拍板。

## 2. 价格对比（2025 年中）

每张 1024×1024 图近似 token / 价格估算：

| 模型 | 图 token | 输入 $/1M | 单图成本 |
| ---- | -------- | ---------- | -------- |
| GPT-4o | ~1100 | 2.50 | $0.0028 |
| GPT-4o-mini | ~1100 | 0.15 | $0.00017 |
| GPT-4.1 | ~1500 | 2.00 | $0.003 |
| Claude 3.5 Sonnet | ~1600 | 3.00 | $0.0048 |
| Claude 3.5 Haiku | ~1600 | 0.80 | $0.0013 |
| Claude 4 Sonnet | ~1600 | 3.00 | $0.0048 |
| Gemini 2.0 Flash | ~258 | 0.10 | $0.000026 |
| Gemini 2.5 Pro | ~258（小图） | 1.25 | $0.00032 |
| Qwen2.5-VL（DashScope） | 动态 | ~0.50 | $0.0005-0.002 |

**Gemini Flash 是单图成本王**（便宜 10-100 倍），但精度上限略低于 GPT-4o / Claude。

## 3. 各家强项画像（一句话）

| 模型 | 强项一句话 |
| ---- | ---------- |
| **GPT-4o** | 综合最稳、生态最全，没意见就先用它。 |
| **GPT-4o-mini** | 大批量场景的性价比之王，质量可接受。 |
| **Claude 3.5 / 4 Sonnet** | 文档 / 图表 / Computer Use 的精度王，中文也行。 |
| **Gemini 2.0 Flash** | 视频 + 价格 + bbox 三件套，长上下文加分。 |
| **Gemini 2.5 Pro** | 推理 + 多模态融合，长 1M 上下文。 |
| **Qwen2.5-VL** | 中文 + bbox + 视频 + 可自部署，国产首选。 |
| **Llama 3.2 Vision** | 开源、可商用、生态广，但不顶尖。 |
| **InternVL 2.5 / 3** | 开源 SOTA，文档理解强，部署门槛高。 |
| **Pixtral 12B** | 欧洲合规优先，能力中等。 |

## 4. 任务 → 模型推荐

| 任务 | 首选 | 备选 | 不推荐 |
| ---- | ---- | ---- | ------ |
| 通用 VQA | GPT-4o | Claude 3.5 | Llama 3.2 V（中文） |
| 印刷 OCR | Claude 3.5 / GPT-4o | Qwen2.5-VL | 小开源 |
| 手写中文 OCR | Qwen2.5-VL + Paddle | InternVL 3 | GPT-4o |
| 长 PDF 文档 | Claude 3.5 / Gemini 2.5 | GPT-4.1 | 小窗口模型 |
| 图表读数 | Claude 3.5 | GPT-4o | mini 系列 |
| Bbox 定位 | Qwen2.5-VL / Gemini | Molmo | GPT-4o（不准） |
| 视频摘要 | Gemini 2.0/2.5 | Qwen2.5-VL | Claude（不吃视频） |
| Computer Use | Claude（首发） | OpenAI CUA | 其他 |
| 实时语音对话 | GPT-4o Realtime | Gemini Live | 自拼 pipeline |
| 大批量低成本 OCR | GPT-4o-mini / Gemini Flash | Qwen-VL Plus | 旗舰 |
| 自部署 | Qwen2.5-VL / InternVL | Llama 3.2 V | 闭源 |

## 5. 自部署 VLM 选型

要不要自部署？决策：

```
QPS > 100 持续？
├─ 是：算账（API 月费 vs GPU 月费），通常 > $5k/月就值得
└─ 否：用 API

数据合规要离线？
├─ 是：必须自部署
└─ 否：看上一题

业务垂直需要 fine-tune？
├─ 是：自部署
└─ 否：API
```

| 模型 | 显存（推理） | QPS（A100 单卡） | 备注 |
| ---- | ------------- | ----------------- | ---- |
| Qwen2.5-VL 7B | ~16 GB | 5-10 | 中文好 |
| Qwen2.5-VL 72B | ~150 GB（多卡） | 1-3 | 旗舰 |
| Llama 3.2 11B Vision | ~22 GB | 3-8 | 英文 |
| InternVL 2.5 8B | ~16 GB | 5-10 | 文档强 |
| InternVL 2.5 78B | ~160 GB | 1-2 | 顶配 |
| MiniCPM-V 2.6 | ~10 GB | 8-15 | 端侧 |

部署方案：

| 方案 | 适用 |
| ---- | ---- |
| vLLM | 主流推理框架 |
| SGLang | 多模态原生支持好 |
| LMDeploy | 国产，InternVL 官方推荐 |
| TGI | HuggingFace 生态 |
| Ollama | 个人 / 小流量 |

## 6. 何时上 fine-tuning

> 默认答案：**先把 prompt 调到极限再考虑 fine-tune**。

适合 fine-tune 的情形：

| 信号 | 例子 |
| ---- | ---- |
| 输出格式极特殊 | 行业内部 schema |
| 视觉风格极特化 | 工业质检图、医疗影像 |
| 准确率瓶颈在 prompt 救不了 | 复杂图表 + 业务规则 |
| QPS 高、想用小模型 | 把 GPT-4o 蒸馏到 7B |

不适合 fine-tune 的情形：

- 数据 < 1000 条
- 通用任务（直接换大模型）
- 需求经常变（模型跟不上）

实操：Qwen-VL / Llama 3.2 V 用 LoRA 在 1×A100 上即可微调。

## 7. 速度延迟权衡

| 等级 | 延迟 | 选型 |
| ---- | ---- | ---- |
| 实时（< 500ms） | 极低 | Realtime / Gemini Live / 小模型本地 |
| 交互（< 3s） | 低 | mini 系列 / Gemini Flash |
| 异步（< 30s） | 中 | 旗舰 API |
| 批量（分钟） | 高 | Batch API（OpenAI / Anthropic 50% 折扣） |

## 8. 决策代码：路由器示例

实际系统常**多模型路由**：

```python
def route(task_type: str, importance: str = "normal"):
    table = {
        ("ocr_print", "normal"): "gpt-4o-mini",
        ("ocr_print", "critical"): "claude-3-5-sonnet-latest",
        ("ocr_handwriting_zh", "normal"): "qwen2.5-vl-72b",
        ("chart_extract", "normal"): "gpt-4o",
        ("chart_extract", "critical"): "claude-3-5-sonnet-latest",
        ("video_summary", "normal"): "gemini-2.0-flash",
        ("bbox_detection", "normal"): "qwen2.5-vl-72b",
        ("computer_use", "normal"): "claude-3-5-sonnet-latest",
        ("realtime_voice", "normal"): "gpt-4o-realtime",
    }
    return table.get((task_type, importance), "gpt-4o-mini")
```

落地时再叠加 **fallback**（首选超时降级到次选）和 **cost cap**（成本上限触发降级）。

## 9. 评测优先于经验

> **任何选型建议都比不过你自己业务集上的评测**。

最小可行评测：

```python
def quick_eval(models, dataset):
    results = []
    for m in models:
        scores = []
        for sample in dataset[:50]:
            pred = run_model(m, sample["input"])
            scores.append(score_fn(pred, sample["expected"]))
        results.append({"model": m, "acc": sum(scores)/len(scores)})
    return sorted(results, key=lambda x: -x["acc"])
```

50 个样本就能看出明显差距，详见 [10 · 评测与生产化](./10-production.md)。

## 10. 一张选型脑图

```
你的需求
├── 一次性 / 创业初期 → 全用 GPT-4o，省思考
├── 文档为主 → Claude 3.5 + Marker
├── 中文 OCR / 视频 → Qwen2.5-VL
├── 长视频 → Gemini 2.0 / 2.5
├── 大批量低成本 → GPT-4o-mini / Gemini Flash
├── Computer Use → Claude
├── 离线 / 合规 → Qwen / InternVL 自部署
└── 实时语音 → GPT-4o Realtime / Gemini Live
```

## 常见坑

- **跟着热点换模型**。新模型出 → 测一下 → 不上不换。频繁换模型让评测体系崩塌。
- **忽视 batch API**。OpenAI / Anthropic batch API 50% 折扣，离线任务直接砍一半成本。
- **用旗舰跑大批量**。100 万张图全 GPT-4o，账单到时候哭。先看 mini / Flash。
- **以为开源就便宜**。GPU 集群运维成本 + 工程师时间 + 故障 → 经常比 API 还贵。
- **不监控分模型成本**。多模型混用时，单个 bug 让某模型流量翻倍 → 月底账单爆炸。按模型打 metrics。

## 下一步

- [10 · 评测与生产化](./10-production.md) — 选型靠数据，本章方法论。
- [01 · 概览](./01-overview.md) — 模型简史与能力边界。
- [`../eval/`](../eval/) — 评测体系基座。
- [08 · 多模态 Agent](./08-multimodal-agent.md) — 不同任务下的实际部署考量。
