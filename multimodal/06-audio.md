# 06 · 音频

音频 = ASR（识别）+ TTS（合成）+ 语音 Agent。**2024 年起 OpenAI Realtime / Gemini Live 让"实时语音对话"工程化**，本章覆盖整套链路。

## 1. 音频任务全景

| 任务 | 输入 | 输出 | 推荐模型 |
| ---- | ---- | ---- | -------- |
| ASR（语音转文字） | 音频 | 文本 | Whisper / Deepgram / Paraformer |
| Diarization（说话人分离） | 多人音频 | 带说话人标签的文本 | pyannote / WhisperX / Deepgram Nova |
| 情绪 / 语调 | 音频 | 标签 / 描述 | Hume / SenseVoice |
| 语种检测 | 音频 | 语种代码 | Whisper / Faster-whisper |
| TTS（文字转语音） | 文本 | 音频 | OpenAI TTS / ElevenLabs / 通义 |
| 语音克隆 | 文本 + 参考音 | 音频 | OpenVoice / GPT-SoVITS / ElevenLabs |
| 实时对话 | 音频流 | 音频流 | GPT-4o Realtime / Gemini Live |

## 2. ASR 模型矩阵

| 模型 | 类型 | 强项 | 弱项 | 备注 |
| ---- | ---- | ---- | ---- | ---- |
| Whisper（OpenAI） | 开源 / API | 多语言、生态好 | 实时弱、长音频幻觉 | 99 种语言 |
| Whisper-large-v3 | 开源 | 准确、可本地 | 慢，需 GPU | 显存 ~10GB |
| Faster-whisper | 优化版 | 4× 速度 | 同 Whisper | CT2 部署 |
| Deepgram Nova | 商用 | 实时强、Diarization 好 | 中文一般 | 流式优秀 |
| AssemblyAI | 商用 | 摘要 / 标签 / 主题一站式 | 价格 | 英文场景 |
| Paraformer / SenseVoice（阿里） | 商用 / 开源 | 中文 SOTA | 多语言一般 | 国内首选 |
| FunASR | 阿里开源 | 中文、可本地 | 部署稍复杂 | 工业级 |
| Realtime API（GPT-4o） | 商用流式 | 端到端语音对话 | 非纯 ASR | §6 详谈 |

**选型一句话**：英文/多语言 → Whisper；中文 → Paraformer；流式对话 → Deepgram 或 OpenAI Realtime。

## 3. 实战：Whisper API + 长音频分段

```python
from openai import OpenAI

client = OpenAI()

# 短音频（< 25MB）直接传
with open("call.mp3", "rb") as f:
    transcript = client.audio.transcriptions.create(
        model="whisper-1",
        file=f,
        response_format="verbose_json",
        language="zh",
        prompt="本次通话涉及保险理赔与产品咨询。",   # 提供领域提示
    )
print(transcript.text)
for seg in transcript.segments:
    print(f"[{seg.start:.1f}-{seg.end:.1f}] {seg.text}")
```

**长音频策略**（> 25MB 或 > 25 分钟）：

```python
from pydub import AudioSegment

def split_audio(path, chunk_min=10, overlap_sec=2):
    audio = AudioSegment.from_file(path)
    chunks = []
    chunk_ms = chunk_min * 60 * 1000
    overlap_ms = overlap_sec * 1000
    for start in range(0, len(audio), chunk_ms - overlap_ms):
        chunks.append(audio[start:start + chunk_ms])
    return chunks
```

**为什么要 overlap**：避免在词中间切断。后处理时按相似度去重。

## 4. 说话人分离

| 工具 | 路径 | 准确率 | 备注 |
| ---- | ---- | ------ | ---- |
| pyannote.audio | 开源 | 中-高 | 需 HuggingFace token |
| WhisperX | 开源（Whisper + pyannote） | 高 | 一键集成 |
| Deepgram Nova | 商用 | 高 | API 内置 |
| AssemblyAI | 商用 | 高 | API 内置 |

```python
# pip install whisperx
import whisperx

model = whisperx.load_model("large-v3", "cuda")
audio = whisperx.load_audio("meeting.wav")
result = model.transcribe(audio)

# 对齐 + 说话人
align_model, meta = whisperx.load_align_model(language_code="zh", device="cuda")
result = whisperx.align(result["segments"], align_model, meta, audio, "cuda")

diarize = whisperx.DiarizationPipeline(use_auth_token="hf_xxx", device="cuda")
diarize_segments = diarize(audio)
result = whisperx.assign_word_speakers(diarize_segments, result)

for seg in result["segments"]:
    print(f"[{seg['speaker']}] {seg['text']}")
```

## 5. TTS：合成自然语音

| 模型 | 拟人度 | 中文 | 速度 | 价格 | 备注 |
| ---- | ------ | ---- | ---- | ---- | ---- |
| OpenAI TTS（gpt-4o-mini-tts） | 高 | 强 | 快 | 便宜 | 多音色 |
| ElevenLabs | 极高 | 中 | 中 | 贵 | 克隆首选 |
| 通义 CosyVoice | 高 | 极强 | 中 | 中 | 中文场景王 |
| GPT-SoVITS | 高 | 强 | 看部署 | 自部署 | 开源、克隆 |
| Coqui XTTS | 中 | 中 | 慢 | 自部署 | 已停止维护 |

```python
from openai import OpenAI
client = OpenAI()

with client.audio.speech.with_streaming_response.create(
    model="gpt-4o-mini-tts",
    voice="alloy",
    input="你好，我是 AI 客服，请问有什么可以帮您？",
    instructions="语气热情、语速适中、女声。",
    response_format="mp3",
) as resp:
    resp.stream_to_file("greeting.mp3")
```

**`instructions`** 是 OpenAI TTS 的杀手锏，能控制情绪、语速、口音。其他厂商需要切音色或调参数。

## 6. 实时流式语音 Agent

**最常见架构**有三种：

### A. 经典 Pipeline（ASR → LLM → TTS）

```
麦克风 → ASR 流式 → 句末检测 → LLM → TTS 流式 → 喇叭
```

| 优点 | 缺点 |
| ---- | ---- |
| 模型可热替换 | 延迟高（1-3 秒） |
| 调试方便 | 丢失语调情绪 |
| 便宜 | 拼接不自然 |

### B. 端到端（GPT-4o Realtime / Gemini Live）

```
麦克风 → WebSocket → 模型直接输出音频 → 喇叭
```

| 优点 | 缺点 |
| ---- | ---- |
| 延迟极低（< 500ms） | 价格高 |
| 保留情绪 / 语调 | 黑盒 |
| 自然打断 | 工具调用稍复杂 |

```python
# OpenAI Realtime（伪代码骨架）
import asyncio, json, websockets, base64

async def realtime_voice():
    url = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview"
    headers = {"Authorization": f"Bearer {API_KEY}", "OpenAI-Beta": "realtime=v1"}
    async with websockets.connect(url, extra_headers=headers) as ws:
        await ws.send(json.dumps({
            "type": "session.update",
            "session": {
                "voice": "alloy",
                "instructions": "你是一个保险客服，简洁、礼貌。",
                "turn_detection": {"type": "server_vad"},
            },
        }))
        # 推麦克风 PCM 帧（24kHz/16bit）；接服务器音频帧并播放
        async for msg in ws:
            evt = json.loads(msg)
            if evt["type"] == "response.audio.delta":
                audio_bytes = base64.b64decode(evt["delta"])
                player.feed(audio_bytes)
```

### C. 混合（用 Realtime 做对话 + 工具调用走 LLM）

把 Realtime 当作"耳朵和嘴巴"，业务逻辑走另一条 LLM 路径。

## 7. WebRTC + ASR + LLM + TTS 链路

```
浏览器 ─ WebRTC ─→ 媒体服务器 ─→ ASR worker
                                   ↓ text
                                 LLM worker
                                   ↓ text
浏览器 ←─ WebRTC ←── 媒体服务器 ←── TTS worker
```

**工程要点**：

- **VAD（语音活动检测）** 决定何时切句：webrtcvad / Silero VAD。
- **打断**：用户说话时，立刻停止当前 TTS 播放（barge-in）。
- **回声消除**：终端做（WebRTC 内置）或服务端做。
- **buffer**：ASR 用 200-500ms 滑窗，TTS 流式播放。
- **延迟预算**：端到端 < 1.5s 才"自然"。

## 8. 长音频处理策略

| 长度 | 策略 |
| ---- | ---- |
| < 25 分钟 | 直接调 API |
| 25 分钟 - 2 小时 | 分段（10min + 2s overlap）+ 拼接 |
| 2 - 8 小时 | 分段 + 并行 worker |
| > 8 小时 | 分布式 + 增量索引 |

**分段拼接**时去重：

```python
def merge_chunks(seg_a, seg_b, overlap_sec=2):
    # 简化：在 overlap 区域用文本相似度找到重叠点
    a_tail = " ".join(w["word"] for w in seg_a["words"] if w["end"] > seg_a["end"] - overlap_sec)
    b_head = " ".join(w["word"] for w in seg_b["words"] if w["start"] < seg_b["start"] + overlap_sec)
    # 用 difflib 找最长公共子序列定位拼接点
    ...
```

## 9. 工程坑：噪声、口音、术语

| 问题 | 应对 |
| ---- | ---- |
| 背景噪声 | 预处理（RNNoise / DeepFilterNet）+ ASR 微调 |
| 口音 / 方言 | 选合适模型（Paraformer 中国方言较好）+ prompt 提示 |
| 专业术语（药名 / 公司名） | Whisper `prompt` / Deepgram `keywords` 提示 |
| 数字 / 年份 | 后处理正则规整（"二零二五" → "2025"） |
| 多语言混合 | Whisper auto；或多次跑不同语言取置信度高的 |
| 静音 / 沉默 | VAD 过滤；不要让 ASR 跑空段（容易幻觉） |

**幻觉警告**：Whisper 在静音段会**自创内容**（"谢谢观看"、"请订阅本频道"），必须 VAD 预过滤。

## 10. 端到端示例：会议纪要

```python
# 流水线：分段 ASR → 说话人 → LLM 总结 → 待办抽取
def meeting_summary(audio_path: str):
    segments = transcribe_with_diarization(audio_path)   # WhisperX

    transcript_text = "\n".join(f"[{s['speaker']}] {s['text']}" for s in segments)

    summary = OpenAI().chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": (
            f"以下是会议逐字稿（含说话人）。请输出：\n"
            f"1. 三句话摘要\n2. 决策清单\n3. 待办（人名 + 时限 + 内容）\n\n{transcript_text}"
        )}],
    ).choices[0].message.content

    return summary
```

## 11. 价格参考（2025 年中）

| 服务 | 单价 | 备注 |
| ---- | ---- | ---- |
| Whisper API | $0.006 / 分钟 | 便宜 |
| OpenAI TTS | $15 / 1M 字符 | gpt-4o-mini-tts |
| ElevenLabs | $0.30 / 1k 字符（v3） | 拟人最强 |
| Deepgram Nova-3 | $0.0043 / 分钟 | 流式好 |
| GPT-4o Realtime | $0.10/min 输入 + $0.20/min 输出 | 端到端贵 |

## 常见坑

- **静音段不过滤直接喂 Whisper**。它会幻觉出"谢谢观看"等无关内容。VAD 是必须的。
- **TTS 不流式**。等整段合成完再播 → 用户体验差；改用 streaming response，边合成边播。
- **专有名词 / 人名识别错**。一定要用 prompt / keywords boost；否则 95% 准的 ASR 在关键名词上就 50%。
- **打断逻辑不写**。用户说话时 TTS 还在念，体验灾难。barge-in 必须实现。
- **多人会议不做说话人分离**。后续 LLM 总结分不清谁说了啥，待办抽取乱套。

## 下一步

- [07 · 视频](./07-video.md) — 视频里通常含音频，处理方式相通。
- [08 · 多模态 Agent](./08-multimodal-agent.md) — 把语音接进 Agent。
- [09 · 模型选型](./09-model-selection.md) — 各家 ASR / TTS 横评。
- [10 · 评测与生产化](./10-production.md) — WER / MOS 等音频评测指标。
