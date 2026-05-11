# 02 · 关键概念

读懂推理引擎要的不是 transformer 内部细节，是**这些概念怎么影响你调参和成本**。本章按"概念 → 影响 → 调参动作"组织。

## 1. KV cache：推理的内存大头

### 1.1 它是什么

Transformer 在生成每个 token 时，attention 需要看**之前所有 token 的 K 和 V**。如果不缓存，每生成一个 token 都要重算所有历史 → O(n²) 计算。

**KV cache** 就是把 K、V 算完存下来，下一步直接复用，把 decode 阶段的算力从 O(n²) 降到 O(n)。

代价：**显存**。每个 token 的 KV 大小：

```
kv_per_token = 2 (K+V) × num_layers × num_kv_heads × head_dim × dtype_bytes
```

### 1.2 真实数字

| 模型               | layers | kv_heads | head_dim | dtype  | 每 token KV 大小 | 8K context | 128K context |
| ---------------- | ------ | -------- | -------- | ------ | ------------ | ---------- | ------------ |
| Llama-3-8B       | 32     | 8        | 128      | FP16   | 128 KB       | 1 GB       | 16 GB        |
| Llama-3-70B      | 80     | 8        | 128      | FP16   | 320 KB       | 2.5 GB     | 40 GB        |
| Qwen2.5-72B      | 80     | 8        | 128      | FP16   | 320 KB       | 2.5 GB     | 40 GB        |
| Mistral-7B       | 32     | 8        | 128      | FP16   | 128 KB       | 1 GB       | 16 GB        |
| Llama-3-405B     | 126    | 8        | 128      | FP16   | 504 KB       | 4 GB       | 63 GB        |

**MQA / GQA（multi-query / grouped-query attention）**通过减少 kv_heads（比如从 64 → 8）把 KV cache 砍 8 倍。这就是为什么现代模型 KV 占比反而小。

### 1.3 为什么这事很贵

7B 模型 FP16 权重 14 GB。一张 24 GB 卡（4090）剩 10 GB 给 KV cache → 只能放 80 个 token × 128 用户的并发。**KV cache 直接决定你能服务多少并发**。

调参动作：
- 显存吃紧 → 量化模型或量化 KV cache（FP8 KV）。
- 长 context 业务 → 优先选 GQA 模型（Llama 3、Qwen 2.5）。
- vLLM `--gpu-memory-utilization 0.9` → 留 10% 给系统。
- vLLM `--max-num-seqs N` 限并发，反推 max KV 占用。

## 2. PagedAttention：vLLM 的核心创新

### 2.1 问题

传统实现给每个请求**预留连续显存**作为 KV cache：

```
请求 A: max_len=2048 → 预留 2048 × kv_per_token 显存
        实际只用了 100 token → 95% 浪费
请求 B: max_len=2048 → 又预留一块连续显存
```

碎片严重，并发数被严重高估。

### 2.2 PagedAttention 怎么解

借鉴 OS 虚拟内存：把 KV cache 切成固定大小的 block（默认 16 token / block），按需分配。

| 维度          | 传统          | PagedAttention      |
| ----------- | ----------- | ------------------- |
| 显存分配粒度      | 整个请求 max_len | block（16 token）     |
| 碎片          | 严重          | 接近 0                |
| 共享 prefix   | 不行          | block 级共享           |
| 实测内存利用率     | 30-40%      | 80-95%              |
| 同等显存下并发能力   | 1×          | 2-4×                |

### 2.3 共享 prefix

PagedAttention 让多个请求共享同一段 prefix 的 KV cache。系统提示长、用户消息短的场景（agent / chatbot）受益巨大：

```
用户A: <SYS 1000 token><USER 50 token>
用户B: <SYS 1000 token><USER 50 token>
用户C: <SYS 1000 token><USER 50 token>

传统：3 × 1050 = 3150 token KV 占用
PagedAttention：1 × 1000 + 3 × 50 = 1150 token，省 64%
```

vLLM 的 `--enable-prefix-caching` 默认开。详见 [07 · 推理优化技术](./07-decoding.md)。

## 3. Continuous batching：调度的革命

### 3.1 静态 batching 的问题

```
batch = [req1, req2, req3]   # 都要 100 step
开始：3 个一起跑
step 30: req2 已经生成完 → 但其他还在跑，req2 占着 slot 空转
step 60: req1, req3 完成 → 整个 batch 才结束
新请求？等下一个 batch 凑齐
```

GPU 空转、新请求延迟高、长短请求互相拖。

### 3.2 Continuous batching

每个生成 step 后**重新组 batch**：

```
step k:  batch = [req1, req2, req3]
req2 完成 → 立刻退出，下一 step
step k+1: batch = [req1, req3, req4 (新进)]
```

| 维度           | 静态 batching   | continuous batching |
| ------------ | ------------- | ------------------- |
| GPU 利用率      | 30-50%        | 80-95%              |
| TTFT（新请求等待）  | 0-batch 周期    | 几个 step             |
| 长短请求互相影响     | 严重            | 小                   |
| 实现复杂度        | 简单            | 高（推理引擎做了）           |
| 代表实现         | transformers  | vLLM / TGI / SGLang |

实测：同硬件下 continuous batching 把吞吐拉到 5-10 倍。这是推理引擎的根本性能优势。

## 4. Prefill vs Decode：两阶段，两性格

### 4.1 区分

| 阶段         | 输入                | 操作                   | 计算特征    | 速度指标                  |
| ---------- | ----------------- | -------------------- | ------- | --------------------- |
| **Prefill** | prompt（一次性 N 个 token） | 一次 forward 算所有 K/V，生成第一个 token | 计算密集（compute-bound） | TTFT（time to first token） |
| **Decode**  | 单个 token（自回归）       | 每步生成一个，复用 KV cache | 内存带宽密集（memory-bound） | TBT（time between tokens）/ tokens/s |

### 4.2 性能差距

| 操作            | A100 80GB 实测                | 瓶颈           |
| ------------- | --------------------------- | ------------ |
| Prefill 4K    | ~50ms（80K tokens/s）         | FLOPs        |
| Decode 1 step | ~15ms（66 tokens/s 单流）       | HBM 带宽       |

**Decode 每步要把全部模型权重从 HBM 读一遍**。这就是为什么：
- 量化（W4A16）能加速 decode（读的字节少）。
- Speculative decoding 把多个 token 塞到一次 forward 里。
- 大 batch decode 能摊薄权重读取成本（→ continuous batching）。

### 4.3 调参影响

| 你的负载            | 关注           | 调参                         |
| --------------- | ------------ | -------------------------- |
| 大量短输入短输出（chat）  | TBT、并发        | 拉大 batch、量化、speculative    |
| 长输入短输出（RAG）     | TTFT          | chunked prefill、prefix cache |
| 短输入长输出（生成文章）    | TBT           | 量化、speculative              |
| 长输入长输出（document） | TTFT + TBT 都重要 | 全套组合                       |

vLLM 0.6+ 支持 `--enable-chunked-prefill`：把长 prefill 切成小段，和 decode 交错执行，避免长 prompt 阻塞短请求的 decode。生产强烈推荐开。

## 5. Speculative decoding（占位）

核心思路：用一个小的"草稿"模型快速生成 N 个候选 token，大模型一次性校验它们。如果草稿对了，相当于一次 forward 出多个 token。

| 加速比 | 草稿模型质量要求 | 接受率 |
| ---- | -------- | --- |
| 1.5x | 中        | 50% |
| 2.5x | 高        | 75% |
| 3-4x | 极高（同家族） | 85% |

详细见 [07 · 推理优化技术](./07-decoding.md)。这里只要知道：speculative 不改变输出（数学等价），只压时间。

## 6. 并行三剑客：TP / PP / DP

把模型切到多卡的三种方式。这是判断"我这个 70B 模型怎么放 4 张卡"的基础。

### 6.1 对比

| 名称                   | 切什么          | 通信量         | 用在哪          | vLLM 参数                     |
| -------------------- | ------------ | ----------- | ------------ | --------------------------- |
| **DP**（Data Parallel） | 不切模型，每卡一份副本  | 几乎 0（推理）    | 复制水平扩容       | 起多个 vLLM 实例 + LB            |
| **TP**（Tensor Parallel） | 单层内权重切片      | 大（每层 2 次 all-reduce） | 单机多卡         | `--tensor-parallel-size N`  |
| **PP**（Pipeline Parallel） | 层切到不同卡       | 小（层间 send/recv） | 跨节点 / 极大模型   | `--pipeline-parallel-size N` |

### 6.2 选择决策

```
模型放得下单卡？
├─ 是 → DP（多副本 + LB），最简单
└─ 否 → 多卡
        单机多卡 + 高带宽（NVLink/NVSwitch）？
        ├─ 是 → TP（首选）
        └─ 否（跨节点）→ PP（或 PP + TP）
```

实测带宽要求：
- TP 要求卡间带宽 ≥ **600 GB/s**（NVLink）。PCIe 4.0 才 64 GB/s，跑 TP 会慢得离谱。
- PP 在层间传 activation，几 GB/s 也行（IB / 25Gb 以太网）。

详细见 [05 · 多 GPU 调度](./05-multi-gpu.md)。

## 7. 这些概念怎么影响你调参

把上面所有概念串起来 → 你看到一个 LLM 推理服务时关心什么：

| 看到的现象                     | 可能原因                       | 调什么                                   |
| ------------------------- | -------------------------- | ------------------------------------- |
| TTFT 高（>1s）               | prefill 阻塞 / 长 prompt      | enable chunked prefill / prefix cache |
| TBT 高（生成慢）                | decode bound / batch 小     | 量化 / 加大 max-num-seqs / speculative    |
| 并发上不去（OOM）                | KV cache 满                 | 量化 KV / 减 max-model-len / 升级显存        |
| GPU 利用率低（<60%）            | batch 小 / 静态 batching      | 用 vLLM / 调 max-num-seqs                |
| 多卡 TP 反而慢                 | 卡间带宽不足                     | 检查 NVLink / 改 DP                      |
| 长 context 时延飙升            | KV cache 爆 / attention O(n²) | 看 §06                                 |
| prompt 重复但每次都满速 prefill   | 没开 prefix cache             | `--enable-prefix-caching`             |

## 8. 一个实战感受脚本

跑一下，亲眼看 prefill / decode 速度差异：

```python
import time
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM

model_id = "Qwen/Qwen2.5-1.5B-Instruct"
tok = AutoTokenizer.from_pretrained(model_id)
model = AutoModelForCausalLM.from_pretrained(
    model_id, torch_dtype=torch.bfloat16, device_map="cuda"
)

prompt = "Explain transformer architecture in detail. " * 100  # 长 prompt
inputs = tok(prompt, return_tensors="pt").to("cuda")
print(f"Prompt tokens: {inputs.input_ids.shape[1]}")

# Prefill 计时
torch.cuda.synchronize()
t0 = time.time()
with torch.no_grad():
    out = model(**inputs, use_cache=True)
torch.cuda.synchronize()
prefill_time = time.time() - t0
print(f"Prefill: {prefill_time*1000:.1f}ms, "
      f"{inputs.input_ids.shape[1]/prefill_time:.0f} tokens/s")

# Decode 计时（手动循环 50 步）
past = out.past_key_values
next_tok = out.logits[:, -1].argmax(-1, keepdim=True)
torch.cuda.synchronize()
t0 = time.time()
for _ in range(50):
    with torch.no_grad():
        out = model(next_tok, past_key_values=past, use_cache=True)
    past = out.past_key_values
    next_tok = out.logits[:, -1].argmax(-1, keepdim=True)
torch.cuda.synchronize()
decode_time = time.time() - t0
print(f"Decode: {decode_time*1000:.1f}ms / 50 step, "
      f"{50/decode_time:.0f} tokens/s")
```

典型输出（A100，1.5B 模型）：
- Prefill 4K tokens: 80ms → 50K tokens/s
- Decode 50 step: 700ms → 70 tokens/s

差**700 倍**。这就是为什么 batch decode 是性能关键。

## 常见坑

1. **以为 KV cache 是「优化技巧」，可以不开**——不开 KV cache decode 是 O(n²)，长输出直接慢到不可用。所有推理引擎默认开。
2. **算 KV 大小忘了 GQA**——拿 num_attention_heads 而不是 num_kv_heads 算，估出来大 8 倍，把自己吓到。一定看 config.json 的 `num_key_value_heads`。
3. **以为 PagedAttention 必须改模型**——它是推理时调度策略，对模型透明，权重不变。
4. **prefill 和 decode 用同一个 throughput 数字汇报**——10K tokens/s 是 prefill，30 tokens/s 是 decode，差几个数量级。benchmark 必须分开报。详 [08 · 性能基准与调优](./08-benchmarking.md)。
5. **TP=8 跑在 PCIe 上**——NVLink 算 600 GB/s，PCIe 4.0 才 64 GB/s。TP 在 PCIe 上比单卡都慢。先确认互联。
6. **以为 continuous batching 一定比静态快**——离线 batch（批量数据，请求长度均匀，无新请求进来）静态 batching 略快，因为没调度开销。serving 场景才是 continuous 的主场。
7. **speculative decoding 在 batch 大时没收益**——大 batch 已经摊薄权重读取，speculative 的 wins 来自压缩 decode latency，不是 throughput。

## 下一步

- 把概念落地到 vLLM 配置 → [03 · vLLM 实战](./03-vllm.md)
- 量化怎么和 KV cache 配合 → [04 · 量化](./04-quantization.md)
- TP / PP 实战配置 → [05 · 多 GPU 调度](./05-multi-gpu.md)
- Speculative decoding 详解 → [07 · 推理优化技术](./07-decoding.md)
- 测 TTFT / TBT → [08 · 性能基准与调优](./08-benchmarking.md)
- 论文：*Efficient Memory Management for Large Language Model Serving with PagedAttention* — <https://arxiv.org/abs/2309.06180>
