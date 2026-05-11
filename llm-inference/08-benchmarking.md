# 08 · 性能基准与调优

"性能"在 LLM serving 不是一个数。本章把它拆成几个指标、给出测法、给真实数字、给调参顺序。

## 1. 关键指标

| 指标          | 全名                            | 含义                | 谁关心        |
| ----------- | ----------------------------- | ----------------- | ---------- |
| TTFT        | Time To First Token           | 用户从发请求到看到第一个字     | 用户体验       |
| TBT / ITL   | Time Between Tokens / Inter-Token Latency | 流式中两个 token 间隔 | 用户感知速度 |
| E2E latency | end-to-end                    | 整次请求总耗时           | 业务 SLA     |
| Throughput  | tokens / second               | 系统所有 token 输出速度   | 成本         |
| QPS         | requests / second             | 每秒完成请求数           | 容量规划       |
| Goodput     | 满足 SLA 的 throughput            | 不算超时的吞吐           | 真实业务容量     |

### 1.1 单流 vs 总吞吐

容易混淆：

```
单流 throughput = 一个请求自己感觉的速度（30 tok/s）
系统总 throughput = 所有并发请求 token 输出之和（1500 tok/s）
```

并发 50 时单流可能慢一点（35 → 28 tok/s），但总吞吐远高于单流。**做容量规划看总吞吐，做用户体验看单流**。

### 1.2 该报哪些数

汇报性能必须**至少**给：

| 数                     | 为什么不能省          |
| --------------------- | -------------- |
| 模型名 + 量化 + 引擎版本       | 不然不可比          |
| GPU 型号 + 卡数           | 硬件决定一切          |
| 输入长度 + 输出长度（分布而非平均）   | 不同长度差几倍        |
| 并发                    | 单流 vs 50 并发不同  |
| TTFT p50 / p95 / p99 + TBT p50 / p95 + 总 throughput | 一句话 "30 tok/s" 没意义 |

## 2. vLLM benchmark 工具

vLLM 自带 benchmark 脚本（`benchmarks/`）：

```bash
# 启动 vLLM server（另一个终端）
python -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen2.5-7B-Instruct \
  --port 8000

# 跑 serving benchmark（最常用）
python benchmarks/benchmark_serving.py \
  --backend vllm \
  --model Qwen/Qwen2.5-7B-Instruct \
  --dataset-name sharegpt \
  --dataset-path ./ShareGPT_V3_unfiltered_cleaned_split.json \
  --num-prompts 1000 \
  --request-rate 10 \
  --port 8000
```

输出（关键字段）：

```
Successful requests:                     1000
Benchmark duration (s):                  103.5
Total input tokens:                      245312
Total generated tokens:                  198746
Request throughput (req/s):              9.66
Input token throughput (tok/s):          2370
Output token throughput (tok/s):         1920
Mean TTFT (ms):                          152
Median TTFT (ms):                        128
P99 TTFT (ms):                           450
Mean TPOT (ms):                          22
Median TPOT (ms):                        21
P99 TPOT (ms):                           38
```

参数说明：

| 参数                  | 含义                        | 备注              |
| ------------------- | ------------------------- | --------------- |
| `--num-prompts`     | 总请求数                      | 1000-5000 够     |
| `--request-rate`    | 每秒发请求                     | inf = 一次性发完     |
| `--dataset-name`    | sharegpt / random / ...    | 用 sharegpt 接近真实 |
| `--sharegpt-output-len` | 强制输出长度（覆盖数据集）            | 测稳定性时用          |
| `--burstiness`      | 请求到达分布（gamma shape）       | 1.0 = 泊松        |

## 3. 真实负载 vs synthetic

**用 synthetic 测出来的数字不能信。**真实负载特征通常：

| 特征             | synthetic 假定        | 真实分布                 |
| -------------- | ------------------- | -------------------- |
| 输入长度           | 固定或均匀               | 长尾，p50=200，p99=8000  |
| 输出长度           | 固定                  | 长尾，p50=80，p99=2000   |
| 到达模式           | 泊松                  | 工作时间峰值 + 突发           |
| prefix 重复       | 全独立                 | 同 system 大量重复        |
| 取消率            | 0                   | 5-15%（用户中断）          |

工程做法：
- 抓一周生产真实流量，按 (input_len, output_len, prefix_overlap) 三元组采样。
- 重放（replay）到 staging vLLM。
- 看真实 TTFT / TBT / 错误率。

## 4. 压测脚本（自家）

简单 Python asyncio 压测：

```python
import asyncio, time, statistics
from openai import AsyncOpenAI

client = AsyncOpenAI(base_url="http://vllm:8000/v1", api_key="x")

async def one_request(prompt: str):
    t0 = time.time()
    first_tok_t = None
    n_tok = 0
    stream = await client.chat.completions.create(
        model="qwen2.5-7b",
        messages=[{"role": "user", "content": prompt}],
        max_tokens=200,
        stream=True,
    )
    async for chunk in stream:
        if chunk.choices and chunk.choices[0].delta.content:
            if first_tok_t is None:
                first_tok_t = time.time()
            n_tok += 1
    end_t = time.time()
    return {
        "ttft_ms": (first_tok_t - t0) * 1000 if first_tok_t else None,
        "e2e_ms": (end_t - t0) * 1000,
        "tbt_ms": (end_t - first_tok_t) / max(n_tok - 1, 1) * 1000,
        "n_tok": n_tok,
    }

async def main(concurrency=32, n_total=500):
    sem = asyncio.Semaphore(concurrency)
    prompt = "用 200 字解释 Transformer 自注意力机制。"

    async def bound():
        async with sem:
            return await one_request(prompt)

    t0 = time.time()
    results = await asyncio.gather(*[bound() for _ in range(n_total)])
    duration = time.time() - t0

    ttfts = [r["ttft_ms"] for r in results if r["ttft_ms"]]
    tbts = [r["tbt_ms"] for r in results]
    total_tok = sum(r["n_tok"] for r in results)

    print(f"QPS: {n_total/duration:.2f}")
    print(f"Throughput: {total_tok/duration:.0f} tok/s")
    print(f"TTFT p50/p95/p99: "
          f"{statistics.median(ttfts):.0f} / "
          f"{sorted(ttfts)[int(len(ttfts)*0.95)]:.0f} / "
          f"{sorted(ttfts)[int(len(ttfts)*0.99)]:.0f} ms")
    print(f"TBT p50/p95: "
          f"{statistics.median(tbts):.0f} / "
          f"{sorted(tbts)[int(len(tbts)*0.95)]:.0f} ms")

asyncio.run(main(concurrency=32, n_total=500))
```

### 4.1 用 wrk 测纯 HTTP 吞吐

```bash
# wrk + Lua 脚本（非流式）
wrk -t8 -c64 -d60s -s post.lua http://localhost:8000/v1/chat/completions
```

`post.lua`:

```lua
wrk.method = "POST"
wrk.headers["Content-Type"] = "application/json"
wrk.body = '{"model":"qwen2.5-7b","messages":[{"role":"user","content":"hi"}],"max_tokens":50}'
```

适合容量上限快速测，但**不能测流式 TTFT**。复杂场景用上面 Python。

### 4.2 locust（带 web UI）

```python
from locust import HttpUser, task, between

class LLMUser(HttpUser):
    wait_time = between(0.5, 2)

    @task
    def chat(self):
        self.client.post("/v1/chat/completions", json={
            "model": "qwen2.5-7b",
            "messages": [{"role": "user", "content": "1+1=?"}],
            "max_tokens": 30,
        })
```

```bash
locust -f locust.py --host http://vllm:8000 --users 50 --spawn-rate 5
```

## 5. 真实性能数字（参考）

测试条件：vLLM 0.6+，BF16，开 prefix cache + chunked prefill，sharegpt 数据。

### 5.1 单卡 7B

| GPU         | 模型                  | TTFT p95 | 单流 tok/s | 32 并发总吞吐 |
| ----------- | ------------------- | -------- | ------- | -------- |
| RTX 4090 24G | Qwen2.5-7B BF16     | 110 ms   | 95      | 1800     |
| A10 24G     | Qwen2.5-7B BF16     | 130 ms   | 75      | 1400     |
| L40S 48G    | Qwen2.5-7B BF16     | 90 ms    | 110     | 2400     |
| A100 80G    | Qwen2.5-7B BF16     | 80 ms    | 130     | 3200     |
| H100 80G    | Qwen2.5-7B BF16     | 60 ms    | 180     | 4800     |
| H100 80G    | Qwen2.5-7B FP8      | 55 ms    | 220     | 6500     |

### 5.2 中端 14B（量化）

| GPU         | 模型                       | TTFT p95 | 单流 tok/s | 32 并发总吞吐 |
| ----------- | ------------------------ | -------- | ------- | -------- |
| RTX 4090 24G | Qwen2.5-14B-AWQ         | 180 ms   | 60      | 900      |
| A10 24G     | Qwen2.5-14B-AWQ         | 230 ms   | 45      | 700      |
| A100 80G    | Qwen2.5-14B BF16        | 130 ms   | 80      | 2100     |
| H100 80G    | Qwen2.5-14B FP8         | 80 ms    | 130     | 3500     |

### 5.3 大模型 70B / 72B

| GPU                   | 模型                     | TTFT p95 | 单流 tok/s | 32 并发总吞吐 |
| --------------------- | ---------------------- | -------- | ------- | -------- |
| 1× A100 80G           | Qwen2.5-72B-AWQ        | 320 ms   | 22      | 350      |
| 2× A100 80G NVLink TP=2 | Llama-3-70B BF16     | 280 ms   | 28      | 600      |
| 4× A100 80G NVLink TP=4 | Llama-3-70B BF16     | 250 ms   | 35      | 900      |
| 4× H100 80G NVLink TP=4 | Llama-3-70B BF16     | 150 ms   | 55      | 1700     |
| 8× H100 NVSwitch TP=8 | Llama-3-70B BF16       | 110 ms   | 70      | 2400     |
| 8× H100 NVSwitch TP=8 | Llama-3-70B FP8        | 100 ms   | 95      | 3500     |

注意：这些数字依赖 vLLM 版本、内核驱动、prompt 分布。**别拿这表当 SLA 承诺**，自己测一遍。

## 6. 调参顺序

按"收益 / 风险"从安全到激进：

| 顺序 | 调什么                                       | 预期收益          | 风险             |
| -- | ----------------------------------------- | ------------- | -------------- |
| 1  | `--enable-prefix-caching`                 | 重复 prompt 大省 | 几乎没风险          |
| 2  | `--enable-chunked-prefill`                | TTFT 稳定       | 默认开            |
| 3  | `--max-num-seqs` 调大                       | 总吞吐升          | 太大 OOM         |
| 4  | `--max-num-batched-tokens` 调大              | TTFT 优化       | 抢 KV 容量         |
| 5  | `--gpu-memory-utilization` 0.85 → 0.92     | KV 容量大        | OOM 风险          |
| 6  | KV cache FP8（`--kv-cache-dtype fp8`）      | KV 容量翻倍       | 精度 < 0.5% 损失   |
| 7  | 权重量化（AWQ / FP8）                            | 显存 ↓ 速度 ↑     | 精度 1-3% 损失     |
| 8  | Speculative decoding                      | 单流 2-3x      | 大 batch 反慢     |
| 9  | TP=2/4 升级                                 | 大模型放下         | 互联要求高           |
| 10 | EAGLE-2 / Medusa                          | 极致延迟          | 训练投入           |

每改一项**单独 benchmark**，否则你不知道哪步拉胯。

## 7. A/B 对比（量化前后）

```bash
# A: BF16 baseline
python -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen2.5-7B-Instruct \
  --port 8001

# B: AWQ 4-bit
python -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen2.5-7B-Instruct-AWQ \
  --quantization awq \
  --port 8002

# 同一份请求集分别打两个端口，比对：
#   - 性能（tokens/s, TTFT）
#   - 输出质量（用 ../eval/ 跑 metrics）
```

汇总表格：

| 指标              | A (BF16) | B (AWQ) | 差异     |
| --------------- | -------- | ------- | ------ |
| TTFT p95        | 80 ms    | 70 ms   | -12%   |
| 单流 tok/s        | 130      | 145     | +12%   |
| 32 并发总吞吐        | 3200     | 4500    | +40%   |
| 显存占用            | 22 GB    | 12 GB   | -45%   |
| MMLU acc        | 71.2%    | 70.5%   | -0.7pp |
| HumanEval pass@1 | 60%      | 56%     | -4pp   |

**典型决策**：通用任务量化收益大于损失；code 任务掉 4pp 要看业务能不能接受。

## 8. 性能问题诊断手册

| 症状                           | 可能原因                          | 排查 / 修复                                        |
| ---------------------------- | ----------------------------- | ---------------------------------------------- |
| TTFT p99 突然飙到 5s+             | KV 满了，请求开始排队                  | 看 `num_requests_waiting` 和 `gpu_cache_usage_perc`   |
| 总吞吐上不去（GPU util 50%）          | batch 没满 / 静态 batching         | 确认用 vLLM；调大 `max-num-seqs`                     |
| 单流 tok/s 慢                    | decode 没量化 / batch 太大          | 量化 / speculative                              |
| TTFT 抖动大（p50 100ms p99 2s）    | 长 prompt 阻塞 decode（没开 chunked prefill）| `--enable-chunked-prefill`                |
| 多卡 TP 慢于单卡                    | 互联走 PCIe                       | 看 `NCCL_DEBUG=INFO`                            |
| 启动 OOM                        | 模型 + KV 超显存                   | 减 `max-model-len` / `gpu-memory-utilization`   |
| 偶发推理失败（500）                   | KV 突发 OOM / 超 context          | 减 `max-num-seqs` 或加 `swap-space`              |
| Prefix cache 命中率低              | prefix 没对齐 / 变量在前              | 改 prompt 结构                                  |
| Speculative 反而慢               | 接受率低                          | benchmark 接受率，太低关掉                          |

## 9. 监控仪表盘最小集

Grafana 面板必备 6 个图：

| 图                                  | 数据源                              | 看什么            |
| ---------------------------------- | -------------------------------- | -------------- |
| TTFT p50 / p95 / p99              | `vllm:time_to_first_token_seconds` histogram | 用户体验          |
| TBT p50 / p95                     | `vllm:time_per_output_token_seconds` | 流速            |
| Tokens/s（in + out 分开）             | `vllm:prompt_tokens_total` / `generation_tokens_total` rate | 吞吐 |
| Concurrent / Queue                | `vllm:num_requests_running` / `waiting` | 容量            |
| KV cache usage                    | `vllm:gpu_cache_usage_perc`     | KV 是否快满       |
| Prefix cache hit rate             | `vllm:prefix_cache_hits_total` / `queries_total` | 优化是否生效    |

## 10. 容量规划计算

给定业务流量预估，反推需要多少卡：

```python
# 输入：
peak_qps = 5                # 高峰 QPS
avg_input_tokens = 500
avg_output_tokens = 200
target_ttft_p95_ms = 500

# 单 vLLM 实例容量（来自 benchmark）：
single_instance_qps_at_sla = 8       # benchmark 测出来 SLA 内能扛 8 QPS
single_instance_throughput = 1800    # tok/s

# 请求 token 总量
total_tok_per_req = avg_input_tokens + avg_output_tokens   # 700
required_throughput = peak_qps * total_tok_per_req         # 3500 tok/s

# 按吞吐：
n_instances_throughput = required_throughput / single_instance_throughput  # 1.94 → 2

# 按 QPS（含 SLA）：
n_instances_qps = peak_qps / single_instance_qps_at_sla                    # 0.625 → 1

# 取较大值 + 冗余（30% headroom）
n_instances = max(2, 1) * 1.3   # ≈ 3 副本
print(f"需要 {n_instances:.0f} 个 vLLM 副本")
```

加上 99.9% SLA、AZ 冗余、平滑滚动升级，建议 **n_instances + 1**。

## 常见坑

1. **拿 vLLM 自带的 sharegpt benchmark 数字向老板汇报**——synthetic 高估真实容量 30-50%。生产前必须用真实流量重放。
2. **不分 input / output 长度报数字**——同一 model "100 tok/s" 在 input=4K 和 input=100 时差几倍。
3. **TTFT 只报均值不报 p99**——均值漂亮，p99 用户体验崩。生产看 p95/p99。
4. **测一下就改一堆参数**——一次只改一个，否则归因不到。
5. **不测 prefix cache 命中率**——开了不代表命中。生产一定监控 cache hit rate。
6. **压测时间太短**——10 秒压测看不到 KV 满之后的退化，至少跑 1 分钟稳态。
7. **测试机和生产机硬件不一致**——4090 测出来扔到 A100 上数字差很大，环境必须 close。
8. **没跑 cold start**——第一次调用 CUDA graph capture / warmup 慢，要丢掉前 N 个数据点。

## 下一步

- 调完性能，把架构搭好 → [09 · 推理服务架构](./09-architecture.md)
- 把延迟和成本权衡清楚 → [10 · 成本与延迟权衡](./10-cost-latency.md)
- 量化 / speculative 对效果的影响 → [../eval/](../eval/)
- vLLM benchmark 脚本 → <https://github.com/vllm-project/vllm/tree/main/benchmarks>
- LLM Performance Leaderboard → <https://www.anyscale.com/llm-performance-leaderboard>
- ARTIFICIALANALYSIS：模型推理成本数据 → <https://artificialanalysis.ai/>
