# 07 · 视频

视频是多模态的**最贵也最难**：本质上是"图序列 + 音频"，token 成本指数级爆炸。本章讲清楚 2025 年视频处理的可行路径，并标注**哪些场景不该用 LLM 做**。

## 1. 视频任务谱系

| 任务 | 难度 | 推荐路径 |
| ---- | ---- | -------- |
| 视频描述 / 摘要 | 中 | 关键帧 + VLM / Gemini 长视频 |
| 动作识别 | 中 | 专用模型（VideoMAE / X-CLIP） |
| 视频问答 | 中-高 | Gemini / 抽帧 + VLM |
| 长视频理解（> 1h） | 高 | 分段 + 摘要级联 |
| 视频检索 | 中 | CLIP4Clip / VideoCLIP |
| 实时视频 Agent（看屏幕） | 高 | Computer Use / 抽帧流式 |
| 视频生成 | 不在本章 | 生成模型主题 |

## 2. 关键帧抽取策略

视频不能整段喂 VLM，必须抽帧。三种主流方法：

| 策略 | 算法 | 优 | 劣 | 适用 |
| ---- | ---- | -- | -- | ---- |
| Uniform | 每 N 秒一帧 | 简单 | 漏关键事件 | 内容稳定的视频 |
| Scene Change | 颜色直方图 / SSIM 变化检测 | 抓切换 | 切换密集时帧爆 | 影视、剪辑视频 |
| Motion-based | 光流 / 运动幅度 | 抓动作 | 静态场景丢 | 监控、动作分析 |
| Embedding 聚类 | CLIP embedding + KMeans | 多样性高 | 慢 | 长视频摘要 |

```python
# pip install scenedetect ffmpeg-python
from scenedetect import detect, ContentDetector
import ffmpeg, os

def extract_keyframes(video_path: str, out_dir: str, threshold=27.0):
    scenes = detect(video_path, ContentDetector(threshold=threshold))
    os.makedirs(out_dir, exist_ok=True)
    for i, (start, _) in enumerate(scenes):
        ts = start.get_seconds()
        (ffmpeg
         .input(video_path, ss=ts)
         .output(f"{out_dir}/frame_{i:04d}.jpg", vframes=1)
         .run(quiet=True, overwrite_output=True))
```

**经验值**：1 小时视频，Scene Change 抽出来 50-200 帧；10 帧/分钟左右是甜蜜区。

## 3. Token 预算：为什么视频"贵"

每帧按图片计费。直观感受：

| 视频长度 | 抽帧密度 | 帧数 | GPT-4o token | 单次成本（输入） |
| -------- | -------- | ---- | ------------- | ---------------- |
| 1 分钟 | 1 帧/秒 | 60 | ~60k | ~$0.15 |
| 10 分钟 | 0.5 帧/秒 | 300 | ~300k | ~$0.75 |
| 1 小时 | 0.1 帧/秒 | 360 | ~360k | ~$0.90 |
| 1 小时 | 1 帧/秒 | 3600 | **超出上下文** | ✕ |

**结论**：长视频必须**分段 + 摘要级联**（map-reduce），不要硬塞。

## 4. Gemini 长视频能力

Gemini 2.0 Flash 原生吃视频文件（一次最长 ~1 小时），**不需要你抽帧**：

```python
from google import genai

client = genai.Client()

video_file = client.files.upload(file="lecture_45min.mp4")

resp = client.models.generate_content(
    model="gemini-2.0-flash",
    contents=[video_file, "用 5 个要点总结这节课的重点，标注时间戳。"],
)
print(resp.text)
```

| 限制 | 数值 |
| ---- | ---- |
| 单文件大小 | 2GB |
| 长度 | ≤ 1 小时（标准） |
| 计费 | 按帧采样（约 1fps）+ 音频 token |
| 跨视频 | 多文件并行可 |

**适用**：会议录像、教程、长讲座、纪录片摘要。其他厂商（GPT-4o / Claude）目前**仍要你自己抽帧**。

## 5. 时序理解（专用模型）

**当任务是"识别动作 / 分类"** 时，VLM 不是最优解，专用模型更准也更便宜：

| 模型 | 任务 | 备注 |
| ---- | ---- | ---- |
| VideoMAE v2 | 动作识别 | Kinetics-400 SOTA |
| X-CLIP | 视频分类 | CLIP 视频版 |
| TimeSformer | 时序注意力 | 经典 |
| InternVideo 2 | 通用视频理解 | 上海 AI Lab 开源 |

VLM 适合"开放式问答"，专用模型适合"有限标签集分类"。

## 6. 视频 + ASR 联合处理

视频里大部分语义在**说话人**：

```
视频 ──┬─→ 抽关键帧 ──→ VLM 描述
       ├─→ 抽音频 ──→ ASR + Diarization ──→ 文字稿
       └─→ 文件元信息（时长、分辨率、帧率）

         ↓ 三路汇合到同一时间轴
         ↓
       LLM 综合分析（摘要、问答、时间戳定位）
```

```python
# 简化版：把帧描述和音频文字按时间轴对齐
def build_timeline(video_path):
    frames = extract_keyframes(video_path)        # 含 timestamp
    transcript = transcribe(extract_audio(video_path))   # 含 segments
    timeline = []
    for f in frames:
        timeline.append({"t": f["t"], "type": "frame", "desc": vlm_describe(f["img"])})
    for s in transcript["segments"]:
        timeline.append({"t": s["start"], "type": "speech", "speaker": s["speaker"], "text": s["text"]})
    timeline.sort(key=lambda x: x["t"])
    return timeline
```

把 timeline 喂给 LLM，可以问"第 12 分钟讲师在演示什么？"这种**跨模态时间戳问题**。

## 7. 视频检索（CLIP4Clip / VideoCLIP）

把视频片段索引起来，支持文本搜视频：

| 模型 | 思路 |
| ---- | ---- |
| CLIP4Clip | 帧级 CLIP embedding + 时序聚合 |
| VideoCLIP | 对比学习直接学视频-文本对齐 |
| InternVideo | 大模型版本 |

**简化做法**（实战常用）：

```python
def video_to_embeddings(path):
    frames = extract_keyframes(path, every_sec=2)
    embs = [clip_embed(img) for img in frames]
    # 平均 / 注意力加权 / 取中心帧
    return mean_pool(embs)
```

存进向量库，用文本 query 即可检索。**电商场景**（短视频商品搜索）这套已经在跑。

## 8. 实时视频 Agent

"看屏幕 + 反馈" 的 Agent，工程难点不在模型，在**采样频率与延迟**。

| 模式 | 延迟 | 应用 |
| ---- | ---- | ---- |
| 屏幕截图 1Hz + VLM | 1-3s | UI 测试、辅助驾驶 |
| 摄像头流 + Realtime | < 500ms | 实时翻译、视障辅助 |
| 游戏画面分析 | 帧级 | 不现实，太贵 |

```python
# 极简屏幕监控 Agent（伪代码）
import mss, time, base64
from openai import OpenAI

def watch_screen(question: str, interval=2.0, max_steps=30):
    sct = mss.mss()
    history = []
    for _ in range(max_steps):
        img_bytes = sct.grab(sct.monitors[1]).rgb
        # ... 转 PNG + base64 略
        resp = OpenAI().chat.completions.create(
            model="gpt-4o",
            messages=[*history, {"role": "user", "content": [
                {"type": "text", "text": question},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img_b64}"}},
            ]}],
        )
        ans = resp.choices[0].message.content
        if "DONE" in ans:
            return ans
        time.sleep(interval)
```

更深入见 [08 · 多模态 Agent](./08-multimodal-agent.md) 的 Computer Use 部分。

## 9. 长视频摘要的 map-reduce

> 1 小时以上视频，**任何模型都不能一次吃下**。

标准模式：

```
视频 → 切成 5 分钟段 → 每段独立摘要（map）
                                ↓
                       所有段摘要拼接（reduce）
                                ↓
                       LLM 输出总摘要
```

```python
def long_video_summary(path: str, segment_min=5):
    duration = get_duration(path)
    summaries = []
    for start in range(0, int(duration), segment_min * 60):
        seg_path = ffmpeg_cut(path, start, segment_min * 60)
        summaries.append(summarize_segment(seg_path))   # Gemini / VLM 抽帧
    final = OpenAI().chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content":
                   "以下是同一视频按 5 分钟段的摘要，请整合为整体摘要：\n" + "\n\n".join(summaries)}],
    ).choices[0].message.content
    return final
```

## 10. 不要用 VLM 做的视频任务

| 任务 | 为什么不该用 |
| ---- | ----------- |
| 帧级目标追踪 | 用 ByteTrack / SAM2 等专用 |
| 物体精确计数 | 同 §02，VLM 数不准 |
| 高频动作识别 | 用 SlowFast / VideoMAE |
| 帧级精确分割 | 用 SAM 2 |
| 实时视频生成 | 现阶段不存在足够便宜的方案 |
| 体育比赛打分 | 专用模型 + 规则 |

## 常见坑

- **抽帧太密**。1fps 看着合理，1 分钟视频 = 60 张图 = 60k token，价格起飞。先用 Scene Change 减到 5-10 帧/分钟。
- **不带时间戳给 VLM**。模型"看图"但不知道发生在哪一秒，无法回答"几分几秒发生了什么"。Prompt 里把时间戳写进去。
- **音频信息不用**。讲座 / 会议 / 教程 80% 信息在音轨，只看画面浪费。
- **以为 Gemini 视频"无限长"**。实际 1 小时是个软上限，超过精度大幅下降。
- **实时 Agent 全帧送 LLM**。屏幕没变化也每秒发一张图 = 烧钱。先做帧间差分，无明显变化跳过。

## 下一步

- [05 · 多模态 RAG](./05-multimodal-rag.md) — 视频库的检索方案。
- [06 · 音频](./06-audio.md) — 视频的"另一半信号"。
- [08 · 多模态 Agent](./08-multimodal-agent.md) — 实时视频 Agent 进阶。
- [09 · 模型选型](./09-model-selection.md) — 视频任务上谁强。
