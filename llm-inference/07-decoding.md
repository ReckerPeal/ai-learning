# 07 · 推理优化技术

[02 · 关键概念](./02-key-concepts.md) 提到了 decode 是 memory-bound。本章把"怎么压 decode 时间"展开：speculative decoding、Medusa、prompt cache、prefix sharing、约束解码、stream 化等。

## 1. Speculative decoding：本章的主角

### 1.1 思路

```
传统 decode：大模型 1 步出 1 token
Speculative：
  1. 小草稿模型一次出 K 个候选 token（快）
  2. 大模型一次 forward 校验这 K 个（一次而非 K 次）
  3. 接受连续匹配的前缀，遇到第一个不匹配换大模型自己的输出
  4. 数学等价：输出分布与无 spec 完全一致
```

收益来源：大模型的一次 forward 的延迟≈生成 1 token 的延迟（decode memory-bound）。一次能"产出"多个 token → 加速。

### 1.2 加速比与接受率

接受率（草稿被采纳的比例）决定加速比：

| 接受率 | 加速比     | 草稿模型质量       | 备注           |
| --- | ------- | ------------ | ------------ |
| 30% | 1.2-1.4x | 差            | 不值得部署        |
| 50% | 1.5-1.8x | 中            | 收益开始显现       |
| 70% | 2.0-2.5x | 好（同家族小版本）   | 主流目标         |
| 85% | 2.8-3.5x | 极好（distill 出来的草稿） | 上限，需要训练投入 |
| 95%+| 4.0x+   | 几乎完美         | 任务很简单 / 草稿专精 |

### 1.3 草稿模型选择

| 主模型              | 草稿模型推荐                              | 接受率（典型） |
| ---------------- | ----------------------------------- | ------- |
| Llama-3-70B      | Llama-3-8B                          | 70-80%  |
| Qwen2.5-72B      | Qwen2.5-1.5B / 3B                   | 65-75%  |
| Llama-3-405B     | Llama-3-8B                          | 60-70%  |
| 自家微调 70B          | 自家微调 8B（同数据训）                       | 75-85%  |
| 任意                | n-gram 草稿（无模型，用统计）                  | 30-50%（看任务）|

### 1.4 vLLM 启用

```bash
python -m vllm.entrypoints.openai.api_server \
  --model meta-llama/Llama-3.1-70B-Instruct \
  --tensor-parallel-size 4 \
  --speculative-model meta-llama/Llama-3.1-8B-Instruct \
  --num-speculative-tokens 5 \
  --use-v2-block-manager
```

参数：
- `--speculative-model`：草稿模型 path / hub id。
- `--num-speculative-tokens`：草稿一次出几个（4-8 是甜蜜点）。
- `--speculative-draft-tensor-parallel-size`：草稿模型自己的 TP（草稿小，常 1）。

### 1.5 Speculative 不是免费

| 坏处                              | 缓解                       |
| ------------------------------- | ------------------------ |
| 草稿模型也吃显存                        | 草稿模型 1.5B 量化 ≈ 1 GB，可控   |
| 大 batch 时收益消失                   | 大 batch 已经摊薄权重读取，没 wins |
| 草稿+主模型双倍 forward 成本（但延迟低）       | 看 throughput 还是 latency 优先 |
| 接受率低时反而更慢                       | 上线前测，接受率 < 50% 关掉        |

## 2. Medusa / EAGLE：speculative 的进化

### 2.1 区别

| 方案          | 草稿来源              | 训练成本    | 接受率    | 加速比    |
| ----------- | ----------------- | ------- | ------ | ------ |
| Vanilla spec | 独立小模型             | 0（用现成）  | 70-80% | 2-2.5x |
| Medusa      | 主模型加几个 head 预测后 N token | 小（几小时） | 70-85% | 2.5-3x |
| EAGLE / EAGLE-2 | 一个轻量 transformer 头预测 | 中     | 80-90% | 3-4x   |
| Lookahead decoding | 无草稿，靠 n-gram 自匹配 | 0       | 50-70% | 1.5-2x |

vLLM 0.6+ 支持 EAGLE-2：

```bash
--speculative-model yuhuili/EAGLE-llama3-Instruct-8B \
--speculative-draft-tensor-parallel-size 1
```

实际部署 cost / benefit：
- 已经在 serving、有现成同家族小模型 → vanilla spec，最容易。
- 有训练能力、追求极致延迟 → EAGLE。
- 不能训新东西、又想要点收益 → lookahead decoding（不需要任何模型）。

## 3. Prompt cache（前缀缓存）

### 3.1 概念

**Anthropic / OpenAI / Google 的「prompt cache」与 vLLM 的「prefix cache」是同一件事**：相同 prefix 的 KV cache 在多次请求间复用，省 prefill。

### 3.2 节省幅度

| 场景                   | 节省（prefill）       | 节省（成本/延迟） |
| -------------------- | ---------------- | --------- |
| 系统 prompt 1K，每请求新 50 token   | 95% prefill 跳过   | TTFT 几乎砍半 |
| Agent 历史 5K，每轮加 200 token    | 96%              | 大幅降低         |
| RAG 检索 3K + 用户 question 30  | 99%              | TTFT 接近 0  |
| 不重复（每请求完全独立 prompt）        | 0                | 没用        |

### 3.3 vLLM 启用

```bash
--enable-prefix-caching
```

vLLM 自动按 block（16 token）哈希复用，**用户无感**。前缀必须**完全一致到 block 边界**才能复用。

### 3.4 工程动作

把"会变的部分"放最后：

```python
# 不好：变量在前
prompt = f"用户问题：{user_q}\n系统说明：你是一个客服机器人，规则1...规则N"

# 好：固定在前
prompt = f"系统说明：你是一个客服机器人，规则1...规则N\n用户问题：{user_q}"
```

LangChain ChatPromptTemplate 默认结构（system → history → user）天然友好，照常用即可。

### 3.5 商业 API 的 prompt cache

| API           | 启用方式                     | 折扣            | 有效期   |
| ------------- | ------------------------ | ------------- | ----- |
| Anthropic     | `cache_control` 标记       | 命中收 1/10 价     | 5 分钟 |
| OpenAI        | 自动（前缀重复 1024 token+）     | 命中收 1/2 价     | 5-10 分钟 |
| Google Gemini | Context Caching API      | 命中省成本（具体看模型） | 自定义   |

[../langchain/](../langchain/) 与 [../langgraph/](../langgraph/) 给 prompt cache 在应用层的具体使用。

## 4. Prefix sharing（更激进的共享）

PagedAttention 让多个**同时活跃**的请求共享同一段 prefix 的 KV，不只是缓存：

```
请求 A start：<long_system_prompt> <user_a>
请求 B start（A 还没结束）：<long_system_prompt> <user_b>
→ system_prompt 部分的 KV 只算一次、只占一份显存
```

vLLM 自动做。SGLang 的 **RadixAttention** 把 prefix sharing 做到树状结构，多分支对话共享更激进，是 SGLang 在 agent / 多并发同 prompt 场景的杀手锏。

## 5. Beam search vs greedy vs sampling

| 方法              | 用途                | 算力     | 多样性    | 默认场景       |
| --------------- | ----------------- | ------ | ------ | ---------- |
| Greedy          | 最大概率 token        | 低      | 0      | 翻译 / 确定性任务 |
| Sampling        | 按 top-p / top-k 采样 | 低      | 高      | 闲聊 / 创意    |
| Beam search     | 同时跟踪 N 条          | 高（×N）   | 低      | 翻译 / 摘要老方案 |
| Best-of-N       | 采 N 条选一条          | 高（×N）   | 中      | 数学 / code  |
| Speculative + sampling | 上两者都和 spec 兼容 | 中  | -      | 通用         |

**生产几乎都用 sampling**（temperature 0.3-0.7）。Beam search 在大模型时代基本被 pass，效果不如 sampling + 多次。

## 6. Constrained / structured decoding

### 6.1 什么意思

强制输出符合某个 grammar（JSON schema、regex、context-free grammar）。这不只是后处理校验，是**在 sampling 时屏蔽掉不合法的 token**。

### 6.2 对推理速度的影响

意外地**很多时候反而更快**：

| 任务            | 普通 sampling 平均输出 | constrained 平均输出 | 速度比 |
| ------------- | --------------- | ---------------- | --- |
| JSON 输出       | 模型说人话再纠错        | 直接出最短 JSON       | 1.5-3x |
| 选项题（A/B/C/D）  | 输出"我认为答案是 B"    | 直接 1 个 token：B   | 10-20x |
| 短分类           | 多余客套话            | 直接类别名            | 5-10x |

原因：约束让模型早结束，省了一堆"As an AI…"开头。

### 6.3 vLLM 启用

```python
# Outlines / xgrammar 后端
client.chat.completions.create(
    model="qwen2.5-7b",
    messages=[{"role": "user", "content": "解析订单"}],
    extra_body={
        "guided_json": {...},        # JSON schema
        # 或 "guided_regex": "...",
        # 或 "guided_choice": ["A","B","C","D"],
        # 或 "guided_grammar": "...",  # CFG
    },
)
```

vLLM 后端默认用 outlines；0.6+ 支持更快的 xgrammar：

```bash
--guided-decoding-backend xgrammar
```

xgrammar 比 outlines 快 5-10x（grammar 编译时间）。生产推荐。

## 7. Stream 化对架构的影响

### 7.1 为什么必须流式

| 输出长度 | 70B 30 tok/s decode 时长 | 用户感知              |
| ---- | -------------------- | ----------------- |
| 100  | 3.3 s                | 流式 0.3s 见首字，非流式等 3s |
| 500  | 17 s                 | 不流式用户以为挂了         |
| 4K   | 2.2 min              | 不流式直接超时            |

**生产 chat 必须流式**。批处理（标数据）可以非流。

### 7.2 流式带来的工程要求

```yaml
要支持流式，整条链路都要改：
  - HTTP server: SSE / WebSocket / chunked transfer
  - LB / 反向代理: 关闭 buffer（nginx 加 proxy_buffering off）
  - timeout: 不能用单次 request timeout，用「无活动 timeout」
  - 客户端: 流式渲染、增量解析（如果约束 JSON 要支持流式 JSON parser）
  - 监控: 看 TTFT 和 TBT 而不是 e2e latency
  - 取消: 客户端断开要让推理引擎释放资源（vLLM 自动）
```

vLLM / TGI 的 OpenAI 兼容流式（SSE）：

```python
stream = client.chat.completions.create(
    model="qwen2.5-7b",
    messages=[...],
    stream=True,
    stream_options={"include_usage": True},  # 末尾带 usage
)
for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
```

## 8. 把上面所有东西叠加起来

一个"全副武装"的 vLLM 启动命令（Qwen2.5-72B 服务 chat + JSON 工具调用）：

```bash
python -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen2.5-72B-Instruct-AWQ \
  --quantization awq \
  --tensor-parallel-size 4 \
  --gpu-memory-utilization 0.92 \
  --max-model-len 32768 \
  --max-num-seqs 64 \
  --kv-cache-dtype fp8 \
  --enable-prefix-caching \
  --enable-chunked-prefill \
  --max-num-batched-tokens 8192 \
  --speculative-model Qwen/Qwen2.5-1.5B-Instruct-AWQ \
  --num-speculative-tokens 5 \
  --speculative-draft-tensor-parallel-size 1 \
  --guided-decoding-backend xgrammar \
  --port 8000
```

这台服务能：
- 70B 级别质量、AWQ 4-bit + FP8 KV 显存极省。
- 4 卡 NVLink TP，并发 64。
- Prefix cache：系统提示重复请求免 prefill。
- Chunked prefill：长 prompt 不阻塞短请求 decode。
- Speculative decoding：用 Qwen2.5-1.5B 草稿，2-3x decode 加速。
- xgrammar：JSON / 工具调用结构化输出快。

实测对比（与最朴素配置）：

| 配置               | TTFT (4K in) | tokens/s | 32 并发吞吐 |
| ---------------- | ------------ | -------- | ------- |
| 朴素 BF16          | 800 ms       | 25       | 380     |
| + AWQ + FP8 KV   | 600 ms       | 38       | 700     |
| + speculative    | 600 ms       | 80       | 1100    |
| + prefix cache（重复 prompt）| 80 ms | 80       | 1500    |

## 9. 优化技术兼容矩阵

不是所有组合都能叠：

| 技术                           | 兼容 vLLM    | 兼容 TGI | 注意           |
| ---------------------------- | ---------- | ------ | ------------ |
| PagedAttention + prefix cache | ✓          | ✓      | 默认开          |
| Chunked prefill              | ✓          | ✓      | 默认开（vLLM 0.6+）|
| Speculative + AWQ            | ✓          | 部分     | 草稿和主同精度更好    |
| Speculative + LoRA           | 限制         | 限制     | 草稿与 LoRA 兼容性看版本 |
| Speculative + 大 batch        | 收益减弱       | 收益减弱   | batch 大时关掉   |
| Constrained decoding + spec  | ✓（vLLM 0.6+） | 部分    | 校验路径要兼容      |
| FP8 KV + AWQ                 | ✓          | ✓      | 推荐组合         |
| Prefix cache + LoRA          | 受限        | 受限     | LoRA 切换会让 cache 失效 |
| Multi-LoRA + speculative     | ✗          | ✗      | 当前不支持        |

## 10. 调参顺序

按收益 / 难度从易到难：

1. **`--enable-prefix-caching`**：开了就赚（agent / chatbot 立省 50-90% prefill）。
2. **`--enable-chunked-prefill`**：长短请求混合服务必开（默认开）。
3. **量化（AWQ / FP8）+ KV FP8**：显存翻倍 / 速度涨。
4. **`max-num-seqs` / `max-num-batched-tokens` 调大**：吃满 KV / 算力。
5. **Speculative decoding**：找好草稿模型，2-3x 收益。
6. **Constrained decoding（用户场景对）**：JSON / 选项任务大省 token。
7. **EAGLE-2 / Medusa**：训练成本，最后考虑。

[08 · 性能基准与调优](./08-benchmarking.md) 给具体测法。

## 常见坑

1. **Speculative 接受率没测就上**——某次草稿和主对不上，接受率 25%，加了 50% 额外算力速度反而慢 20%。**上线前必测**。
2. **大 batch 还开 speculative**——大 batch 的 decode 已经计算 bound 了，spec 没收益还消耗显存。看吞吐 vs 延迟优先。
3. **Prefix cache 没生效又怀疑 vLLM bug**——80% 是 prefix 没对齐到 block 边界，或者中间被 user_id 之类的变量打断。打开 vLLM debug log 看 cache hit rate。
4. **流式响应被 nginx buffer**——nginx 默认 `proxy_buffering on`，攒完才发，看起来不流式。`proxy_buffering off; proxy_request_buffering off;`。
5. **constrained decoding 用 outlines，编译 grammar 太慢**——首次几百 ms 编译。换 xgrammar 或者预热。
6. **EAGLE 草稿用错版本**——EAGLE-1 和 EAGLE-2 不通用，模型 repo 看清楚。
7. **以为 prompt cache 在 5 分钟内一直有效**——商业 API 5 分钟是上限，实际看负载可能更短。生产监控命中率，别假定。
8. **Beam search 拿来上 chat**——同质化输出 + 慢，体验差。生产用 sampling。

## 下一步

- 上线前测一下加速效果是否真的有 → [08 · 性能基准与调优](./08-benchmarking.md)
- 长 context 下这些技术怎么配合 → [06 · 长上下文优化](./06-long-context.md)
- 多卡 + 这些优化 → [05 · 多 GPU 调度](./05-multi-gpu.md)
- LangChain / LangGraph 用 prompt cache → [../langchain/](../langchain/)
- 论文：*Fast Inference from Transformers via Speculative Decoding* — <https://arxiv.org/abs/2211.17192>
- 论文：*Medusa: Simple LLM Inference Acceleration Framework with Multiple Decoding Heads* — <https://arxiv.org/abs/2401.10774>
- 论文：*EAGLE-2* — <https://arxiv.org/abs/2406.16858>
- xgrammar — <https://github.com/mlc-ai/xgrammar>
