# 05 · 多 GPU 调度

模型放不下单卡 → 多卡。但**怎么切**决定性能能不能起来。这章讲 TP / PP / DP 三种切法、何时用哪种、网络要求、跨节点和故障域。

## 1. 三种并行的本质

| 名称  | 切什么          | 通信模式                | 一句话              |
| --- | ------------ | ------------------- | ---------------- |
| DP（Data Parallel） | 不切模型，复制副本   | 推理时几乎无通信            | "多开几个，前面挂 LB"    |
| TP（Tensor Parallel） | 单层内权重切片  | 每层 2 次 all-reduce  | "一层切给多卡同时算"      |
| PP（Pipeline Parallel） | 层切到不同卡   | 层间 send / recv      | "前几层在 A 卡，后几层在 B 卡" |
| EP（Expert Parallel）  | MoE 的 expert 切到不同卡 | all-to-all      | MoE 模型专用（DeepSeek、Mixtral）|

实际生产里 **TP + DP** 是常见组合：单机内 TP 切一份，多副本 DP 横向扩。

## 2. 通信代价对比

每生成 1 个 token，通信量级（70B Llama 模型，TP=4）：

| 并行    | 每 token 跨卡通信量            | 频率                    | 总带宽需求               |
| ----- | ---------------------- | --------------------- | ------------------- |
| DP    | 0                      | -                     | 0（推理时）              |
| TP    | ~MB 级，每层 2 次 all-reduce | 每 step 80 次（每层 2 × 40 层） | 极高（>500 GB/s）       |
| PP    | 单层 activation（KB 级）     | 每 step 一次 send/recv    | 中（10-50 GB/s）       |
| TP+PP | 上述叠加                    | -                     | TP 段高，PP 段中         |

**TP 是带宽 / 延迟敏感型**，必须 NVLink。
**PP 是计算密度敏感型**，跨节点可接受。

## 3. 何时用哪种

### 3.1 决策树

```
模型放得下单 GPU 显存？
├─ 是 → DP（多副本 + LB）
│         同硬件下吞吐最高、最简单、容错最好
│         vLLM 起 N 个实例，前面挂 nginx / Envoy
│
└─ 否，需要多卡：
        单机内有 NVLink / NVSwitch（≥ 600 GB/s 卡间带宽）？
        ├─ 是 → TP（首选）
        │       8x H100 NVSwitch：TP=8 几乎线性
        │       4x A100 NVLink：TP=4 拿到 90% 线性
        │
        └─ 否（PCIe 或跨节点）：
                跨节点（多机）？
                ├─ 是 → PP，或 TP + PP（每节点内 TP，节点间 PP）
                └─ 否（单机 PCIe）→ TP=2 还行，TP≥4 别上，考虑量化或换卡

模型是 MoE？
└─ 上 EP（vLLM `--enable-expert-parallel`）
```

### 3.2 实战配置示例

| 模型             | 卡                         | 推荐切法                | 理由                          |
| -------------- | ------------------------- | ------------------- | --------------------------- |
| Llama-3-8B     | 1× A10 / 4090             | DP（不切）              | 单卡装得下                       |
| Llama-3-8B     | 4× A10                    | DP=4（4 副本）          | 横向扩，容错好                     |
| Llama-3-70B    | 4× A100 80G NVLink        | TP=4                | NVLink 带宽充足                 |
| Llama-3-70B AWQ | 1× A100 80G              | DP                  | 量化后单卡装下                     |
| Llama-3-70B    | 8× H100 NVSwitch          | TP=8（极致吞吐）or TP=4 DP=2 | 看是要单请求快还是总吞吐 |
| Llama-3-405B   | 8× H100 单机                | TP=8                | 卡多带宽够                       |
| Llama-3-405B   | 16× H100（2 节点）            | TP=8 PP=2           | 跨节点用 PP，单节点内 TP             |
| DeepSeek-V3    | 16× H100                  | TP=8 EP=2           | MoE → 走 EP                  |
| Qwen2.5-72B    | 2× A100 80G NVLink        | TP=2                | 刚好放下                        |
| Qwen2.5-72B AWQ | 2× 4090 24G PCIe         | TP=2 + 量化           | PCIe TP 性能折半，但能跑就行          |

## 4. vLLM TP 配置实战

### 4.1 启动命令

```bash
# 单机 TP=4
python -m vllm.entrypoints.openai.api_server \
  --model meta-llama/Llama-3.1-70B-Instruct \
  --tensor-parallel-size 4 \
  --gpu-memory-utilization 0.92 \
  --max-model-len 8192 \
  --enable-prefix-caching
```

注意：
- `--tensor-parallel-size` 必须能整除 num_attention_heads。Llama-3-70B 有 64 head，TP 可取 1/2/4/8。
- vLLM 默认用 multiprocessing（`mp`）后端。跨节点改 `--distributed-executor-backend ray`。

### 4.2 监控通信

启动后 NCCL 日志：

```bash
export NCCL_DEBUG=INFO
export NCCL_DEBUG_SUBSYS=NET,GRAPH
```

看到 `NCCL INFO Channel ... using NVLink/PCI` 就知道走的什么。如果 TP 但走 PCI → 性能崩塌。

### 4.3 cuda_visible_devices

如果一台机器有 8 张卡，只想给 vLLM 用 0-3：

```bash
CUDA_VISIBLE_DEVICES=0,1,2,3 python -m vllm.entrypoints.openai.api_server \
  --tensor-parallel-size 4 ...
```

## 5. 跨节点（多机多卡）

### 5.1 vLLM + Ray 起多节点

```bash
# Head 节点
ray start --head --port 6379 --num-gpus 8

# Worker 节点
ray start --address=<head-ip>:6379 --num-gpus 8

# 起 vLLM（在 head 节点）
python -m vllm.entrypoints.openai.api_server \
  --model meta-llama/Llama-3.1-405B-Instruct \
  --tensor-parallel-size 8 \
  --pipeline-parallel-size 2 \
  --distributed-executor-backend ray
```

### 5.2 PP 切片细节

vLLM 自动按层切。Llama-3-405B 126 层，PP=2 → 节点 1 跑 0-62 层，节点 2 跑 63-125 层。

性能影响：
- PP 引入 pipeline bubble（启动 / 结尾几个 step 利用率不满）。
- 长 prompt 的 prefill 经过整个 pipeline，TTFT 增加。
- 最佳实践：PP 段数 ≤ 4，再多 bubble 太大。

## 6. 网络要求

### 6.1 卡间互联（单机内）

| 互联方式            | 双向带宽（每对卡）   | 能跑 TP？               |
| --------------- | ----------- | -------------------- |
| NVSwitch（DGX H100） | 900 GB/s    | TP=8 几乎线性            |
| NVLink Gen4（H100 SXM）| 900 GB/s | TP=4-8 极佳            |
| NVLink Gen3（A100 SXM）| 600 GB/s | TP=4-8 良好            |
| NVLink Gen2（V100） | 300 GB/s    | TP=4 OK              |
| PCIe Gen5 x16   | 128 GB/s    | TP=2 凑合，TP=4+ 慢      |
| PCIe Gen4 x16   | 64 GB/s     | TP=2 慢，TP=4 不要尝试     |
| PCIe Gen4 x8（4090 实际） | 32 GB/s | TP=2 也很慢             |

### 6.2 节点间互联（多机）

| 网络               | 带宽            | 延迟       | 跑 PP？              |
| ---------------- | ------------- | -------- | ----------------- |
| InfiniBand HDR / NDR | 200-400 Gb/s | ~1 μs    | 优秀，能勉强跑跨节点 TP     |
| RoCE v2 100 Gb   | 100 Gb/s      | ~5 μs    | PP 良好，TP 不行       |
| 25 Gb 以太网        | 25 Gb/s       | ~50 μs   | PP 凑合             |
| 10 Gb 以太网        | 10 Gb/s       | ~100 μs  | PP 慢               |
| 1 Gb 以太网         | 1 Gb/s        | ~ms      | 别想了               |

经验法则：跨节点 TP 几乎不可能（除非 NDR IB），所以多机几乎都是 **节点内 TP + 节点间 PP**。

### 6.3 NCCL 调优

跨节点常用环境变量：

```bash
export NCCL_IB_DISABLE=0
export NCCL_IB_HCA=mlx5_0,mlx5_1   # 多 IB 卡时指定
export NCCL_SOCKET_IFNAME=eth0     # 控制走哪个网卡
export NCCL_NET_GDR_LEVEL=2        # GPUDirect RDMA
export NCCL_TOPO_FILE=/path/topo.xml  # 自定义拓扑
```

## 7. 故障域设计

多卡部署的失败模式：

| 失败                  | 影响                   | 缓解                                |
| ------------------- | -------------------- | --------------------------------- |
| 一张卡挂                | 整个 TP 实例挂            | 多副本 DP，挂一个 LB 把流量切到其他副本           |
| 一张卡显存波动 OOM         | 单请求失败                | 监控 KV usage，留 margin              |
| NCCL hang           | TP 实例僵死，所有请求超时       | 健康检查 + watchdog 重启                |
| 一个节点挂（多机）           | 整个跨节点实例挂             | 多套独立的多机实例 + LB                    |
| HF Hub 不可达          | 启动 / 重启失败            | 镜像 / 提前下载 weights                 |
| CUDA driver 升级      | 整批节点要重启              | 灰度 + rolling                      |

**架构原则**：把多卡 TP 实例当**一个不可分的单元**，外面用 LB 做副本级别的弹性。详见 [09 · 推理服务架构](./09-architecture.md)。

## 8. 实测数据（参考）

70B 模型，BF16，A100 80G：

| 配置        | 单请求 throughput | 总 throughput（并发 32） | TTFT（4K prompt）|
| --------- | ------------- | ------------------- | ------------- |
| TP=4 NVLink | 28 tok/s   | 600 tok/s            | 280 ms        |
| TP=8 NVSwitch | 35 tok/s | 900 tok/s            | 200 ms        |
| TP=2 PCIe Gen4 | 8 tok/s | 80 tok/s             | 800 ms（慢得离谱）  |
| 2× DP（量化 AWQ） | 22 tok/s | 1100 tok/s（合并） | 250 ms |

注意 **DP（多副本量化）总吞吐反而高**——因为量化省下的显存能塞更大 batch，且每副本独立调度。生产决策不是"哪个最快"，而是"哪个 $/M token 最低"。详 [10 · 成本与延迟权衡](./10-cost-latency.md)。

## 9. 一个完整多机示例

8 卡 × 2 节点跑 Llama-3-405B：

```bash
# === Node 1 (head) ===
# 拉镜像
docker pull vllm/vllm-openai:latest

# 起 ray head
ray start --head --port=6379 --num-gpus=8 \
  --node-ip-address=10.0.0.1

# === Node 2 (worker) ===
ray start --address='10.0.0.1:6379' --num-gpus=8

# === 回到 Node 1，起 vLLM ===
python -m vllm.entrypoints.openai.api_server \
  --model meta-llama/Llama-3.1-405B-Instruct \
  --tensor-parallel-size 8 \
  --pipeline-parallel-size 2 \
  --distributed-executor-backend ray \
  --gpu-memory-utilization 0.92 \
  --max-model-len 8192 \
  --port 8000

# 验证（在 Node 1 上）
curl http://localhost:8000/v1/models
```

## 10. 常见诊断

| 症状                        | 检查                                                   |
| ------------------------- | ---------------------------------------------------- |
| TP 启动卡死 5+ 分钟              | NCCL 没握上手，看 `NCCL_DEBUG=INFO` 日志，IB 卡 down 或 NIC 配错  |
| TP=8 比 TP=4 慢              | 通信瓶颈，检查互联，可能某对卡走 PCIe                              |
| 跨节点启动 timeout              | 防火墙、SSH、IP 路由检查                                    |
| 单个 worker GPU 利用率 0%       | NCCL 死锁，看 `nvidia-smi` 各卡 util，不一致就是                 |
| Ray dashboard 看不到 worker   | `ray status`，head 和 worker 的 ray 版本要一致              |
| GPU 显存分布不均（TP 后某卡满某卡空）     | layer 切分异常，看 vllm 启动日志的 layer 分配                    |
| 多机推理结果与单机不一致              | NCCL 数值差异（很小），但若大差异是 bug，先用 `--seed` 复现             |

## 常见坑

1. **PCIe 上跑 TP=4 然后疑惑为什么慢**——PCIe 4.0 才 64 GB/s 双向，TP 每 step 几十次 all-reduce 直接打满。先确认 NVLink，再上 TP≥4。
2. **以为 vLLM 跨节点开 `--tensor-parallel-size 16` 就行**——跨节点 TP 几乎不可用（除非 NDR IB），生产用节点内 TP + 节点间 PP。
3. **多副本 DP 不做 sticky session**——流式响应中途切到别的副本（虽然 vLLM 单请求不会切，但 LB 配置错可能导致）→ 上下文丢失。流式必须粘性。
4. **Ray cluster 留着不清理**——任务挂了 ray actor 还在，下次启动 GPU 被占。`ray stop --force` + `pkill ray` 兜底。
5. **NCCL_P2P_DISABLE 没设导致 PCIe 走 P2P 失败**——某些主板 / BIOS P2P 不稳，调试期可以 `export NCCL_P2P_DISABLE=1`。
6. **多卡机器没绑 NUMA**——CPU-GPU 数据传输跨 NUMA 节点慢一倍，启 vLLM 前 `numactl --cpunodebind=0 --membind=0`。
7. **以为 head=8 而 TP=8 必须用所有卡**——可以 TP=4 + 2 个实例 DP，吞吐通常更高。先 benchmark 再下结论。
8. **混合不同代 GPU**（A100 + V100 同一 TP 组）——NCCL 能跑但性能拉到最弱卡，不要混。

## 下一步

- 单机配置好了 → [03 · vLLM 实战](./03-vllm.md) 调参
- 量化能换更小的切法 → [04 · 量化](./04-quantization.md)
- 长 context 时 KV cache 怎么分布 → [06 · 长上下文优化](./06-long-context.md)
- 上 LB / 多副本 → [09 · 推理服务架构](./09-architecture.md)
- 测多卡性能 → [08 · 性能基准与调优](./08-benchmarking.md)
- DeepSpeed 多卡训练（不是推理） → [../fine-tuning/](../fine-tuning/)
- vLLM 分布式文档 → <https://docs.vllm.ai/en/latest/serving/distributed_serving.html>
