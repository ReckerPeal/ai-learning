# 06 · 长上下文优化

128K context 听起来很美，工程实现上一句话：**KV cache 会爆**。本章给的不是 attention 论文综述，是"你想上长 context 该怎么取舍"。

## 1. 长 context 的核心代价

KV cache 随 context 长度**线性增长**，但叠加并发就是乘法关系：

```
KV 占用 = num_seqs × context_len × per_token_kv
```

实测数字（Llama-3-70B，BF16，per_token_kv ≈ 320 KB）：

| Context  | 单请求 KV | 32 并发 KV  | 备注              |
| -------- | ------ | --------- | --------------- |
| 4K       | 1.3 GB | 41 GB     | A100 80G 单卡轻松   |
| 16K      | 5 GB   | 160 GB    | TP=2 才放得下并发     |
| 32K      | 10 GB  | 320 GB    | TP=4 才能服务 32 并发 |
| 128K     | 40 GB  | 1280 GB   | 单卡只能 1-2 并发     |
| 1M       | 320 GB | 不可能       | 必须 streaming KV |

**结论**：长 context 不是"开个开关"，是**整个并发模型重排**的问题。

## 2. 长 context 模型清单

| 模型                       | 训练 context | 实际可用（不显著掉点） | 备注               |
| ------------------------ | ---------- | ----------- | ---------------- |
| Llama-3.1-8B/70B         | 128K       | 64K         | 后段 needle-in-haystack 掉    |
| Qwen2.5-7B/14B/72B       | 128K       | 128K        | 表现稳定             |
| Qwen2.5-1M               | 1M         | 1M          | 阿里专门训的版本         |
| Mistral Large            | 128K       | 64K         |                  |
| Gemini 1.5 Pro / 2.0     | 1M / 2M    | 几百K稳，1M 偶尔掉 | 商业 API           |
| Claude 3.5 / 3.7         | 200K       | 200K        | 商业 API           |
| GPT-4 Turbo / GPT-4o     | 128K       | 128K        | 商业 API           |
| DeepSeek-V3              | 64K → 128K | 64K         |                  |
| Yi-200K                  | 200K       | 100K        |                  |

注意：训练 context 不等于真正能用的 context。要看 **needle-in-a-haystack** 测试和实际任务效果。

## 3. PagedAttention 在长 context 下的优势

[02 · 关键概念](./02-key-concepts.md) 讲了 PagedAttention，但**长 context 下它是必需而非可选**：

- 传统：32K context 单请求要预留 10 GB 连续显存。
- PagedAttention：按 16-token block 分配，按需增长，不浪费。

实际节省（serving 32 并发，平均 10K context，最大 32K）：

| 方案             | KV 占用     |
| -------------- | --------- |
| 传统按 max 预留     | 32 × 32K × KV ≈ 320 GB |
| PagedAttention | 32 × 10K × KV ≈ 100 GB（节省 70%） |

vLLM、TGI、SGLang 都默认 PagedAttention，**这是上长 context 必须用推理引擎而非裸 transformers 的核心理由之一**。

## 4. 加速长 context attention 的算法

| 算法                         | 原理                            | 复杂度       | 谁实现           |
| -------------------------- | ----------------------------- | --------- | ------------- |
| Vanilla attention          | 全 attention                   | O(n²)     | -             |
| FlashAttention 2/3         | 分块 + 重计算，避免 O(n²) 中间矩阵        | O(n²) FLOPs，但 IO 优 | vLLM、TGI、TRT-LLM |
| Sliding window attention   | 只看最近 W token                  | O(n × W)  | Mistral 早期    |
| RingAttention              | 序列并行，多卡分段算 attention          | O(n²) 但分布式 | 研究 / 个别引擎     |
| Grouped-query attention (GQA) | 多 query 共享 KV head           | O(n²) 但 KV 减少 | 现代模型默认      |
| StreamingLLM / Sink tokens | 保留 sink + recent，丢中间          | O(W)      | 研究            |
| Hyena / Mamba              | 非 attention，线性复杂度             | O(n)      | 新模型           |

**实操**：你不用选——**FlashAttention 2/3 + GQA** 是现代推理引擎默认，开箱即用。Sliding window 等是研究题材或 Mistral-7B 早期方案。

## 5. 长 context 实测数据（参考）

Qwen2.5-72B AWQ on 4× A100 80G NVLink：

| 输入 / 输出       | TTFT      | TBT       | 总延迟（4K out）  |
| ------------- | --------- | --------- | ------------ |
| 4K in / 256 out  | 200 ms    | 25 ms     | 6.6 s        |
| 16K in / 256 out | 600 ms    | 30 ms     | 7.7 s        |
| 32K in / 256 out | 1.2 s     | 35 ms     | 9.8 s        |
| 64K in / 256 out | 3 s       | 45 ms     | 14.5 s       |
| 100K in / 256 out | 6 s      | 55 ms     | 20 s         |
| 128K in / 256 out | 9 s      | 65 ms     | 25.6 s       |

观察：
- TTFT 随输入接近线性增长（prefill 是 compute-bound）。
- TBT 随 KV 累积有缓慢上升（attention 计算 O(n)）。
- **100K context 单请求 6 秒首 token**——用户能忍吗？这是产品决策。

并发的影响（32K context 输入，并发数 vs TTFT p95）：

| 并发  | TTFT p95 | TBT p95 |
| --- | -------- | ------- |
| 1   | 1.2 s    | 35 ms   |
| 4   | 1.6 s    | 40 ms   |
| 16  | 3 s      | 60 ms   |
| 32  | 6 s      | 90 ms   |
| 64  | 排队中     | -       |

并发 32 上去之后 KV 已经接近上限，再加请求开始排队。

## 6. 长 context + 推理优化的组合

不是单点优化，是**组合拳**：

```yaml
optimization_stack:
  base:
    - 选 GQA 模型（Llama 3 / Qwen 2.5）
    - vLLM PagedAttention（默认）
    - FlashAttention 2/3（默认）
  显存:
    - --kv-cache-dtype fp8（KV 量化，省一半）
    - 权重量化（AWQ / FP8）
    - --enable-prefix-caching（共享系统 prompt）
  TTFT:
    - --enable-chunked-prefill（避免长 prefill 阻塞 decode）
    - --max-num-batched-tokens 调高
  跨卡:
    - 长 context 优先 TP（KV 跟着切）
    - 跨节点 PP 不能切 KV，单节点必须放下
```

vLLM 长 context 推荐启动模板：

```bash
python -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen2.5-72B-Instruct-AWQ \
  --quantization awq \
  --tensor-parallel-size 4 \
  --max-model-len 131072 \
  --gpu-memory-utilization 0.92 \
  --kv-cache-dtype fp8 \
  --enable-prefix-caching \
  --enable-chunked-prefill \
  --max-num-batched-tokens 8192 \
  --max-num-seqs 16
```

注意 `--max-num-seqs 16` 比短 context 服务（128）小一个数量级——这是长 context 的代价。

## 7. 何时该上 RAG 而不是塞长 context

不是所有"我需要看更多内容"的场景都该用长 context。**RAG 通常更便宜更快**。

### 7.1 决策

```
内容长度？
├─ < 8K → 直接塞 prompt
├─ 8K-32K → 塞 prompt，注意成本
├─ 32K-128K → RAG 优先；除非任务需要全局理解
└─ > 128K → 必须 RAG（或 long-context 模型 + 评估接受度）

任务类型？
├─ 全局摘要 / 对比多文档全文 → 长 context（RAG 难抓全）
├─ 检索式问答 / 找具体段落 → RAG（更快、更便宜、命中率可控）
├─ 多轮 chat 累积历史 → 短期长 context，长期 RAG 缓存
└─ 代码库分析 → 混合：依赖图 + RAG + 关键文件全量
```

### 7.2 成本对比

| 方案                              | 单次成本（API） | 自部署延迟      | 准确率        |
| ------------------------------- | --------- | --------- | ---------- |
| 100K context 全塞                  | $0.30+    | 5-10 s    | 高（信息全）     |
| RAG（top-5 chunks，每 chunk 500 token） | $0.005 | 0.5 s     | 看 retrieval |
| RAG + rerank + 长 context 兜底      | $0.02-0.05 | 1-2 s     | 平衡         |

RAG 工程详见 [../rag-advanced/](../rag-advanced/)。

### 7.3 反过来：什么场景长 context 必须

- 法律 / 合同**全文一致性检查**——切了就漏。
- 长视频 / 长会议**全程跨时刻引用**。
- 代码 / 文档**全局重构 / 总览生成**。
- agent **对话历史长期累积**（这种最好压缩 + summarize，详 [../agents/](../agents/)）。

## 8. 流式长输出的特殊关注

长输出（生成几千 token）的问题不是 context，是 **decode 时长**：

| 输出长度  | 70B model decode 时长（30 tok/s） |
| ----- | ----------------------------- |
| 256   | 8.5 s                         |
| 1K    | 33 s                          |
| 4K    | 2.2 min                       |
| 8K    | 4.5 min                       |

工程动作：
- **必须用流式**（`stream=True`）。否则用户等几分钟看不到第一个字。
- 客户端做"已生成 N token / 预计还有 M"的进度提示。
- 超时配置要长：HTTP / nginx / LB 默认 60s，长输出场景设 600s+。
- 速度优化（speculative decoding）：[07 · 推理优化技术](./07-decoding.md)。

## 9. 长 context 调参实战

> 场景：要服务"上传 100 页 PDF 提问"业务，平均输入 50K，输出 1K。

### 9.1 模型选择

```
50K 输入 → 选 128K context 模型，留余量（用 64K-128K 段时不该掉点）
推理质量要 70B 级 → Qwen2.5-72B 或 Llama-3.1-70B
```

### 9.2 硬件选择

```
70B FP16 = 140 GB → 量化到 AWQ 4-bit = 35 GB
50K context KV ≈ 16 GB（FP16）→ FP8 KV 后 8 GB
单请求总占用 ≈ 43 GB

并发 8 → KV 8×8 GB = 64 GB
权重 + KV ≈ 100 GB → 2× A100 80G（TP=2）刚好
```

### 9.3 启动命令

```bash
python -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen2.5-72B-Instruct-AWQ \
  --quantization awq \
  --tensor-parallel-size 2 \
  --max-model-len 65536 \
  --max-num-seqs 8 \
  --gpu-memory-utilization 0.92 \
  --kv-cache-dtype fp8 \
  --enable-prefix-caching \
  --enable-chunked-prefill \
  --max-num-batched-tokens 4096 \
  --port 8000
```

### 9.4 业务侧

- TTFT 5-10 秒在长 context PDF 问答场景可接受，但**必须流式**。
- 提示用户"AI 阅读中…"，前端不要白屏 10 秒。
- prefix cache 命中：把 PDF 内容放在 system prompt（每个请求重复），再追加用户问题 → 多次问同一文档第二次起 prefill 几乎免费。

## 10. 监控长 context 服务

关键 metric（结合 [03 · vLLM 实战](./03-vllm.md) §6）：

| 指标                              | 长 context 阈值        |
| ------------------------------- | ------------------ |
| `vllm:gpu_cache_usage_perc`     | 持续 > 0.9 = 容量危险    |
| `vllm:num_requests_waiting`     | 长期 > 0 = 容量不够      |
| `vllm:time_to_first_token_seconds` p95 | 业务目标，比如 < 8s |
| 单请求 input token 分布              | p95 是不是真的 100K，还是异常拉长 |
| 输出 token 分布                     | 输出超长 → decode 时间预算  |

## 常见坑

1. **以为 max_model_len 设大不要钱**——KV 跟着翻倍。设 128K 之前先算并发能塞几个。
2. **拿 long-context 模型当短 context 用**——`max_model_len 8192` 就够了，硬开 128K 浪费 KV 容量。按业务需求设。
3. **没测 needle-in-haystack 就上线**——模型说支持 128K 不代表 128K 都能精确 recall。开源工具 RULER / NIAH 跑一下。
4. **长 prefill 阻塞短请求**——不开 chunked prefill，一个 100K prompt 的 prefill 5 秒，期间所有 decode 卡住。**生产必开 chunked prefill**。
5. **prefix cache 算错节省**——只有 prefix 完全一致到 block 边界（16 token）才共享。中间换一个标点全部失效。把固定段固定，把可变段放后面。
6. **长输出业务用同步 HTTP**——LB / nginx 默认 60s 超时，4 分钟输出直接断连。流式 + 长 timeout。
7. **以为 1M context 模型一定比 128K 好**——长 context 模型在短输入上有时表现还略差（训练数据分布偏了）。短任务还是用短 context 模型。
8. **拿 RAG 能解决的问题硬塞长 context**——成本可能差 10-100 倍，效果还更差（检索精准 chunk 比噪声满满的 100K 好）。

## 下一步

- 不上长 context，改 RAG → [../rag-advanced/](../rag-advanced/)
- 长 context 加速 → [07 · 推理优化技术](./07-decoding.md)
- 多卡放 KV → [05 · 多 GPU 调度](./05-multi-gpu.md)
- KV 量化 → [04 · 量化](./04-quantization.md) §9
- 测 long-context 真实能力 → [../eval/](../eval/)
- vLLM long context guide → <https://docs.vllm.ai/en/latest/models/supported_models.html>
- RULER benchmark → <https://github.com/NVIDIA/RULER>
