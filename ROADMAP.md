# 学习路线图

> 本仓库的**主题规划**。已完成的主题在 [README.md](./README.md) 索引；本文档列出**待规划与候选主题**，按学习阶段组织，给优先级 / 章节方向 / 依赖关系。

> 此文档**只做规划**，不展开主题内容。每个候选主题真正动工时，按 [AGENTS.md §7](./AGENTS.md#7-新增主题流程) 流程逐步建立。

## 0. 设计原则

1. **学习路径优先**：主题必须能放进现有 4 阶段（基础 → 进阶编排 → Agent 系统 → 工程化），或合理新增阶段
2. **不重复**：新主题与现有主题严格区分（cross-reference 而非复述）
3. **工程视角**：所有主题面向"做产品"，不是论文复读
4. **10 章原则**：每个主题目标 ~10 章；明显大于 10 章 → 拆分；明显小于 → 合并
5. **优先级有立场**：明确分 P0/P1/P2，不模棱两可
6. **可独立选学**：用户可以按顺序学，也可以跳到自己最需要的那个

## 1. 学习地图全景

```
┌─── Step 0 · 准备（可选前置）────────────────────┐
│  📋 LLM 基础 · 📋 Python for AI                │
└─────────────────────────────────────────────────┘
                       ▼
┌─── Step 1 · 基础（组件 + 链）──────────────────┐
│  ✅ LangChain                                  │
│  ✅ Prompt 工程进阶                             │
│  📋 模型选型与对比  ⭐⭐⭐                       │
└─────────────────────────────────────────────────┘
                       ▼
┌─── Step 2 · 进阶编排（状态 + 检索）────────────┐
│  ✅ LangGraph     ✅ RAG 进阶                  │
│  ✅ 多模态                                      │
│  📋 流式与异步深度  ⭐⭐                        │
└─────────────────────────────────────────────────┘
                       ▼
┌─── Step 3 · Agent 系统（范式 + 协议）──────────┐
│  ✅ Agents · 智能体系统                        │
│  ✅ Agentic RL 深度                             │
│  ✅ Agent 实战项目集                            │
└─────────────────────────────────────────────────┘
                       ▼
┌─── Step 4 · 工程化（评测 + 上线）──────────────┐
│  ✅ LLM Eval                                   │
│  ✅ LLM 安全                                    │
│  ✅ 部署进阶                                    │
│  ✅ 成本优化                                    │
└─────────────────────────────────────────────────┘
                       ▼
┌─── Step 5 · 模型层 ─────────────────────────────┐
│  ✅ 模型微调                                    │
│  ✅ 推理与部署                                  │
│  📋 LLM 架构  ⭐⭐⭐                              │
└─────────────────────────────────────────────────┘
                       ▼
┌─── Step 6 · 垂直应用 ───────────────────────────┐
│  ✅ Coding Agent                               │
│  ✅ Browser / 自动化 Agent                     │
│  ✅ Data Analysis Agent                        │
│  📋 客服 / 销售 Agent  ⭐⭐⭐                      │
└─────────────────────────────────────────────────┘
                       ▼
┌─── Step 7 · 前沿（暂不展开）────────────────────┐
│  Reasoning 模型 · World Model · Memory 前沿    │
└─────────────────────────────────────────────────┘

✅ 已完成   📋 候选规划   ⭐ 价值评估
```

## 2. 当前进度（17 主题 / 170 章）

| Slug | 主题 | 阶段 | 章节 |
|---|---|---|---|
| `langchain` | LangChain | Step 1 | 10 |
| `prompt-engineering` | Prompt 工程进阶 | Step 1 | 10 |
| `langgraph` | LangGraph | Step 2 | 10 |
| `rag-advanced` | RAG 进阶 | Step 2 | 10 |
| `multimodal` | 多模态 | Step 2 | 10 |
| `agents` | Agents · 智能体系统 | Step 3 | 10 |
| `agentic-rl` | Agentic RL 深度 | Step 3 | 10 |
| `agent-projects` | Agent 实战项目集 | Step 3 | 10 |
| `eval` | LLM Eval | Step 4 | 10 |
| `llm-security` | LLM 安全 | Step 4 | 10 |
| `deployment` | 部署进阶 | Step 4 | 10 |
| `cost-optimization` | 成本优化 | Step 4 | 10 |
| `fine-tuning` | 模型微调 | Step 5 | 10 |
| `llm-inference` | 推理与部署 | Step 5 | 10 |
| `coding-agent` | Coding Agent | Step 6 | 10 |
| `browser-agent` | Browser / 自动化 Agent | Step 6 | 10 |
| `data-agent` | Data Analysis Agent | Step 6 | 10 |

合计 **170 章**。规划层面候选还有 ~6 个主题（下文）。

> **2026-05 进度更新**：6 个 P0 候选（Prompt 工程、LLM 安全、多模态、模型微调、推理与部署、Coding Agent）已并行完成。
> **2026-05 进度二更**：6 个高价值 P1 主题（Agentic RL / 实战项目集 / 部署进阶 / 成本优化 / Browser Agent / Data Agent）已并行完成，合计 60 章 / ~20K 行。剩余 P1：LLM 基础、模型选型、LLM 架构（偏理论 / 选型）。

## 3. 优先级图例

| 标记 | 含义 |
|---|---|
| **P0** | 强烈推荐下一步开工——回报最高 / 缺口最大 |
| **P1** | 中期必学——主题成熟、价值清晰 |
| **P2** | 视情况展开——可能并入其他主题 / 等领域更稳定 |

| 价值 ⭐ | 含义 |
|---|---|
| ⭐⭐⭐⭐⭐ | 必须有 |
| ⭐⭐⭐⭐ | 强烈建议有 |
| ⭐⭐⭐ | 锦上添花 |
| ⭐⭐ | 视场景 |
| ⭐ | 兴趣向 |

---

## Step 0 · 准备（可选前置）

读者已具备 Python + 基本 LLM 调用经验时可跳过。

### 0.1 LLM 基础 · `llm-fundamentals` · P1 · ⭐⭐⭐

**简介**：理解 LLM 内部"是什么"——不学这层不影响做应用，但很多疑难问题（为什么 hallucination、为什么长 context 不可靠）回到这层就清楚。

**章节大纲（建议）**：
1. Tokenization（BPE/SentencePiece、token 经济）
2. Transformer 直觉（Attention 是怎么"看"的）
3. 现代 LLM 架构（GPT 系 / LLaMA 系 / DeepSeek-R1）
4. 训练流程（Pre-training / SFT / RLHF）
5. 推理与采样（temperature / top-p / beam）
6. 上下文窗口与 KV cache
7. 模型规模法则（Scaling Laws）
8. 涌现能力与边界
9. 评估基准（MMLU / GPQA / HumanEval / Arena）
10. 模型生态地图（OpenAI / Anthropic / DeepSeek / Qwen / Llama）

**依赖**：无
**参考**：3Blue1Brown LLM 系列视频、《Build a Large Language Model from Scratch》、Lilian Weng 博客

### 0.2 Python for AI · `python-for-ai` · P2 · ⭐⭐

**简介**：把 Agent / RAG 工程会用到的 Python 高级特性集中讲——异步、生成器、类型、Pydantic、性能。

**章节大纲（建议）**：
1. 异步基础（asyncio、协程、事件循环）
2. 异步进阶（Semaphore / Task Group / Cancellation）
3. Generator / AsyncGenerator（流式输出依赖）
4. 类型系统（Pydantic、TypedDict、Generic）
5. Decorator 模式
6. Context Manager（资源管理）
7. 性能（multiprocessing / threading / 选择）
8. Logging / Tracing 集成
9. 包管理（uv、Poetry、pyproject）
10. 调试技巧（pdb / icecream / structlog）

**依赖**：基础 Python
**何时省略**：已熟悉 async + Pydantic 可整段跳过

---

## Step 1 · 基础（已完成 + 扩展）

### ✅ LangChain（已完成）

### 1.1 Prompt 工程进阶 · `prompt-engineering` · **P0** · ⭐⭐⭐⭐⭐

**简介**：所有 LLM 应用的"基本功"，回报极高且稳定——模型升级、框架变了，prompt 工程的核心思路不变。

**章节大纲（建议）**：
1. 概览（Prompt 的"原理"——为什么 prompt 起作用）
2. 基础技巧（Role / Instruction / Format 三件套）
3. Few-shot 设计（数量、顺序、多样性）
4. Chain-of-Thought 与 Self-Consistency
5. 指令调优（System / User / 输出格式约束）
6. 角色扮演与 Persona
7. 模型差异（GPT vs Claude vs DeepSeek 写 prompt 区别）
8. Prompt 模板化（变量、partial、版本化）
9. 对抗 Prompt（注入、越权——侧重防御）
10. Prompt 评测与迭代（与 [`eval/`](./eval/) 衔接）

**依赖**：langchain
**参考**：Anthropic prompt cookbook、[promptingguide.ai](https://www.promptingguide.ai)、OpenAI Prompt 工程指南

### 1.2 模型选型与对比 · `model-selection` · P1 · ⭐⭐⭐

**简介**：怎么在一堆模型里给具体任务选对的——不止看 leaderboard，还要看延迟、价格、上下文、tool calling 质量。

**章节大纲（建议）**：
1. 模型生态全景（OpenAI / Anthropic / Google / 阿里 / DeepSeek / Llama）
2. 闭源 vs 开源（决策框架）
3. 评估维度（速度 / 价格 / 质量 / 上下文 / 工具支持）
4. 任务-模型匹配矩阵（分类 / 抽取 / 生成 / 推理 / 工具调用）
5. 国内外模型差异（中文场景）
6. Embedding 模型选型
7. 多模型路由（cost-aware routing）
8. 自部署 vs API（决策框架）
9. 监控模型变化（A/B test 模型升级）
10. 实战：一个生产应用的模型选型记

**依赖**：langchain、eval
**参考**：[lmarena.ai](https://lmarena.ai)、Artificial Analysis、各家 release notes

---

## Step 2 · 进阶编排（已完成 + 扩展）

### ✅ LangGraph、RAG 进阶（已完成）

### 2.1 多模态 · `multimodal` · **P0** · ⭐⭐⭐⭐⭐

**简介**：2025 年 LLM 应用快速进入多模态时代——VLM、文档理解、图表、音频、视频。本主题聚焦工程落地。

**章节大纲（建议）**：
1. 概览（VLM 简史、模型家族、能力边界）
2. 图像理解（VQA、OCR、定位、计数）
3. 文档理解（PDF、扫描件、复杂版式）
4. 表格与图表（提取、推理、可视化）
5. 多模态 RAG（图文检索、跨模态查询）
6. 音频（ASR、说话人分离、TTS）
7. 视频（关键帧、时序理解、长视频摘要）
8. 多模态 Agent（VLM + 工具）
9. 模型选型（GPT-4o / Claude / Gemini / Qwen-VL）
10. 评测与生产化

**依赖**：langchain、rag-advanced
**参考**：rag-advanced/08（已有简单覆盖）、Llava 系列论文、Anthropic / OpenAI Vision API 文档

### 2.2 流式与异步深度 · `streaming-async` · P2 · ⭐⭐

**简介**：LangGraph 流式 / LangChain 异步在主线主题已覆盖；本主题做"高性能场景"深度——SSE / WebSocket、并发控制、背压、流式 UI。

**章节大纲（建议）**：
1. 流式协议（SSE vs WebSocket vs HTTP/2）
2. 服务端流式（FastAPI / Express）
3. 客户端消费（前端 EventSource / fetch + ReadableStream）
4. Agent 多 stream_mode 整合
5. 异步并发（Semaphore / Bulkhead / 限流）
6. 背压（Producer 比 Consumer 快时怎么办）
7. 重连与状态恢复
8. 流式聚合 / 多源合流
9. 流式 UI（打字机 / 工具调用动画 / 思考态）
10. 监控与故障注入

**依赖**：langchain、langgraph
**何时不做**：现有 langchain/10 + langgraph/08 已覆盖 80%，规模不大可暂不展开

---

## Step 3 · Agent 系统（已完成 + 扩展）

### ✅ Agents（已完成）

### ✅ 3.1 Agentic RL 深度 · `agentic-rl` · P1 · ⭐⭐⭐⭐ · 已完成

**简介**：训练**专门**为 Agent 任务优化的模型——不止 SFT，还有 RLHF / DPO / GRPO / 过程监督。本主题接续 [`agents/10 §7`](./agents/10-production.md)。

**章节大纲（建议）**：
1. 概览（为什么训 Agent 模型 / 何时不训）
2. SFT 基础（数据格式、Loss、曲线）
3. 偏好对齐（RLHF 简史、PPO）
4. DPO（直接偏好优化）
5. RLAIF（用 AI 当 judge 生成偏好）
6. RLVR（可验证奖励）
7. GRPO（DeepSeek-R1 风格）
8. 过程监督 vs 结果监督
9. 工具：TRL / verl / OpenRLHF
10. 案例剖析（DeepSeek / OpenAI o1 / Claude reasoning）

**依赖**：agents、模型微调（Step 5）
**参考**：DeepSeek-R1 论文、TRL 文档、Hugging Face NLP course

### ✅ 3.2 实战项目集 · `agent-projects` · P1 · ⭐⭐⭐⭐ · 已完成

**简介**：把零散知识串成完整应用——3-5 个完整项目从 0 到生产。对应 [hello-agents 13-16 章](https://github.com/datawhalechina/hello-agents) 风格。

**章节大纲（建议）**：
1. 项目方法论（需求 → 架构 → 评测 → 上线）
2. 项目 1：智能旅行助手（多工具协作）
3. 项目 2：自动化深度调研（Plan-and-Execute）
4. 项目 3：客服 Agent（HITL + 多轮记忆）
5. 项目 4：代码审查 Agent（CI 集成）
6. 项目 5：数据分析助手（SQL + Plot）
7. 项目 6：知识库 Agent（RAG + Memory）
8. 横向对比：架构差异 / 共性
9. 评测与监控的统一方案
10. 上线 checklist 通用版

**依赖**：langgraph、agents、rag-advanced、eval
**参考**：hello-agents 第 13-16 章

### 3.3 自动化工作流 vs Agent · `workflow-vs-agent` · P2 · ⭐⭐

**简介**：n8n / Zapier / Power Automate vs Agent——什么时候上 Workflow、什么时候上 Agent、怎么混合。偏选型 / 产品决策。

**章节大纲（建议）**：精简到 5-6 章，可能并入 Agents 主题作为附录。

**何时不做**：内容偏产品而非工程；可作为博客文章而非完整主题。

---

## Step 4 · 工程化（已完成 + 扩展）

### ✅ LLM Eval（已完成）

### 4.1 LLM 安全 · `llm-security` · **P0** · ⭐⭐⭐⭐⭐

**简介**：上生产必修。Prompt 注入、Jailbreak、数据泄漏、模型滥用、隐私合规——分层防御。

**章节大纲（建议）**：
1. 威胁模型（OWASP LLM Top 10）
2. Prompt 注入（直接 / 间接 / 多步）
3. Jailbreak 与越狱
4. 数据泄漏（训练数据、PII、上下文）
5. 模型滥用（DDoS、token bombing、内容生成滥用）
6. 工具调用安全（agents/10 已部分覆盖，本章深化）
7. 多 Agent 安全（Agent 之间互相欺骗）
8. 红队测试（对抗集生成）
9. 防御工具（Llama Guard、NeMo Guardrails、Lakera）
10. 合规（GDPR / SOC2 / 行业规范）

**依赖**：agents、eval
**参考**：OWASP LLM Top 10、Anthropic safety papers、Lakera AI Red Team Guide

### ✅ 4.2 部署进阶 · `deployment` · P1 · ⭐⭐⭐⭐ · 已完成

**简介**：把 Agent / Chain 服务部署到生产。Docker / K8s / Serverless / LangGraph Server / 监控。

**章节大纲（建议）**：
1. 部署形态总览（VM / 容器 / Serverless / 托管）
2. Docker / Compose 基础
3. K8s 模式（Pod / Service / HPA / Sidecar）
4. Serverless（Lambda / Cloud Run / Modal）
5. LangGraph Server vs 自建 FastAPI
6. 流式服务部署（SSE / WebSocket Pod 设计）
7. 监控（Prometheus / Grafana / OpenTelemetry）
8. 日志与 Trace（Loki / Datadog / LangSmith）
9. 容灾（多区域、降级、熔断）
10. CI/CD（蓝绿、金丝雀、回滚）

**依赖**：langchain、langgraph
**参考**：langgraph/10（已部分覆盖）、Anthropic Skills Cloud Run 部署案例

### ✅ 4.3 成本优化 · `cost-optimization` · P1 · ⭐⭐⭐⭐ · 已完成

**简介**：规模化必修。Token 成本、模型路由、缓存、batch、自部署 vs API 经济模型。

**章节大纲（建议）**：
1. 成本结构（input / output / cache / 调用费 / GPU）
2. Token 经济（什么贵、什么省）
3. 模型路由（cheap-first / quality-first）
4. Prompt cache 系统设计
5. 批处理（Batch API、async batching）
6. 量化与自部署经济性
7. 缓存设计（语义缓存 / 精确缓存）
8. 限流与配额（per user / per task）
9. 成本监控（按租户 / 按功能拆账）
10. 真实案例（10K → 1M DAU 的成本曲线）

**依赖**：eval、deployment
**参考**：OpenAI Batch API、Anthropic Prompt Caching、社区博客

---

## Step 5 · 模型层（待开工）

### 5.1 模型微调 · `fine-tuning` · **P0** · ⭐⭐⭐⭐⭐

**简介**：定制化 LLM 必经之路。SFT / LoRA / QLoRA / PEFT / 数据合成 / 评测 / 部署。

**章节大纲（建议）**：
1. 概览（何时微调 vs Prompt 工程 vs RAG）
2. 数据：质量 > 数量
3. SFT 基础（loss、超参、early stopping）
4. PEFT 全家桶（LoRA / QLoRA / IA³ / Prefix）
5. 训练框架（HF Trainer / TRL / Unsloth / LLaMA-Factory）
6. 数据合成（用强模型造训练数据）
7. 评测（domain-specific + 通用能力衰减）
8. 量化（推理时 4bit / 8bit）
9. 部署微调模型（vLLM / TGI / Ollama）
10. 案例：从 0 微调一个领域 Agent

**依赖**：langchain、eval、推理与部署（5.2）
**参考**：HuggingFace NLP course、Unsloth 文档、Llama-Factory

### 5.2 推理与部署 · `llm-inference` · **P0** · ⭐⭐⭐⭐⭐

**简介**：自部署模型必备。vLLM / TGI / Llama.cpp / GGUF / 量化 / 调度 / 性能调优。

**章节大纲（建议）**：
1. 推理引擎全景（vLLM / TGI / SGLang / Llama.cpp / Ollama）
2. 关键概念（KV cache、PagedAttention、Continuous batching）
3. vLLM 实战（部署、调参、监控）
4. 量化（GGUF / GPTQ / AWQ / FP8）
5. 多 GPU 调度（TP / PP / DP）
6. 长上下文优化
7. 推理优化（speculative decoding、prompt cache）
8. 性能基准与调优
9. 推理服务架构（前端 → router → 多 backend）
10. 成本与延迟权衡

**依赖**：无（独立可学）
**参考**：vLLM 文档、TGI 文档、Llama.cpp 文档、SGLang 论文

### 5.3 Transformer 与现代 LLM 架构 · `llm-architecture` · P1 · ⭐⭐⭐

**简介**：理解模型架构。Attention / FFN / Position / MoE / Mamba / State Space。

**章节大纲（建议）**：
1. Attention 机制（Self / Cross / Multi-head）
2. Transformer 完整结构
3. 位置编码（Absolute / Relative / RoPE / ALiBi）
4. 高效 Attention（Flash / Sparse / Linear）
5. MoE（Mixture of Experts）
6. Mamba / SSM 架构
7. 多模态架构（CLIP / Flamingo / Llava）
8. Decoder-only vs Encoder-decoder
9. 训练技术（Norm / Init / Optimizer）
10. 现代 LLM 设计选择对比（GPT / Llama / Qwen / DeepSeek）

**依赖**：基础深度学习
**参考**：The Annotated Transformer、Karpathy nanoGPT、各家技术报告

---

## Step 6 · 垂直应用（待开工）

### 6.1 Coding Agent · `coding-agent` · **P0** · ⭐⭐⭐⭐⭐

**简介**：垂直领域第一应用方向。Cursor / Claude Code / Devin / Aider 拆解，代码理解、生成、调试、审查。

**章节大纲（建议）**：
1. 概览（Coding Agent 演化、Copilot → Cursor → Devin）
2. 代码理解（符号 / 类型 / 调用图）
3. Code RAG（代码库的 RAG 特殊问题）
4. 代码生成（diff 生成、增量编辑）
5. 代码执行沙箱（E2B / Modal / Docker）
6. 代码审查 Agent（PR review）
7. 调试 Agent（Stack trace → 修复）
8. 测试生成 Agent
9. Refactor Agent
10. 案例剖析（Cursor / Claude Code / Devin / Aider 架构）

**依赖**：agents、langgraph、rag-advanced
**参考**：Cursor docs、Claude Code 公开文档、Aider 源码、Devin 公开演示

### ✅ 6.2 Browser / 自动化操作 Agent · `browser-agent` · P1 · ⭐⭐⭐⭐ · 已完成

**简介**：Manus 之后的明确方向。浏览器自动化、Computer Use、Click/Type、状态识别。

**章节大纲（建议）**：
1. 概览（Browser Agent 现状、Manus / Anthropic Computer Use）
2. 浏览器自动化基础（Playwright / Selenium）
3. Vision 路径（截图 + VLM 理解）
4. Accessibility tree 路径（DOM-based）
5. 混合策略（Vision + DOM）
6. 元素定位与点击（坐标 / selector）
7. 表单与交互
8. 多步任务（电商下单、信息收集、复杂表单）
9. 错误恢复（页面变了、登录失效、CAPTCHA）
10. 安全与合规（限速、PII、TOS）

**依赖**：agents、多模态
**参考**：Anthropic Computer Use、Manus 演示、Browser Use 项目

### ✅ 6.3 Data Analysis Agent · `data-agent` · P1 · ⭐⭐⭐⭐ · 已完成

**简介**：B 端常见落地方向。SQL Agent、Pandas Agent、可视化、报告生成。

**章节大纲（建议）**：
1. 场景全景（BI 自助 / 报表 / 探索分析）
2. SQL Agent（Schema 注入、Few-shot、错误恢复）
3. NL2SQL 进阶（多表 join、复杂语义）
4. Pandas / DataFrame Agent
5. 可视化生成（Matplotlib / Plotly Agent）
6. 报告生成（结构化 + 叙事）
7. Code Interpreter 模式（OpenAI / Claude）
8. 数据质量与清洗
9. 多源数据（CSV / SQL / API / Excel）
10. 评测（结果正确性 + 生成代码可读性）

**依赖**：agents、langgraph
**参考**：LangChain SQL Agent / Pandas Agent、Vanna、PandasAI

### 6.4 客服 / 销售 Agent · `support-sales-agent` · P2 · ⭐⭐⭐

**简介**：常见 To B 落地。多轮对话、知识库 RAG、情绪识别、HITL、转人工。

**章节大纲（建议）**：精简到 8 章；与 6.1 / 6.3 共享方法论。

**何时不做**：偏行业经验，工程模式可以并入实战项目集（3.2）。

---

## Step 7 · 前沿（暂不展开）

下面这些方向**有趣但快速变化**——展开成完整主题会很快过时。建议作为**博客文章 / 阅读笔记**形式留存，不做完整主题。

| 方向 | 状态 | 建议 |
|---|---|---|
| Reasoning 模型（o1 / R1 / 思考模式）| 快速演化 | 集中放进 Agentic RL 主题 |
| World Model / Embodied AI | 离工程远 | 关注 / 不展开 |
| Memory 前沿（Letta / Mem0 / Zep） | 演化中 | 并入 agents/03 扩充 |
| AI Engineer / Software Engineer Agent 趋势 | 是趋势文 | 博客形式 |
| AGI 路径思考 | 哲学层 | 不展开 |

---

## 4. 候选优先级总览

### 4.1 P0（已全部完成 ✅，按完成顺序）

| # | 主题 | 阶段 | 价值 | 状态 |
|---|---|---|---|---|
| 1 | Prompt 工程进阶 | Step 1 | ⭐⭐⭐⭐⭐ | ✅ 已完成 |
| 2 | LLM 安全 | Step 4 | ⭐⭐⭐⭐⭐ | ✅ 已完成 |
| 3 | 多模态 | Step 2 | ⭐⭐⭐⭐⭐ | ✅ 已完成 |
| 4 | 模型微调 | Step 5 | ⭐⭐⭐⭐⭐ | ✅ 已完成 |
| 5 | 推理与部署 | Step 5 | ⭐⭐⭐⭐⭐ | ✅ 已完成 |
| 6 | Coding Agent | Step 6 | ⭐⭐⭐⭐⭐ | ✅ 已完成 |

> 6 个 P0 主题在 2026-05 由并行 Agent 集中产出，合计 60 章 16K+ 行。下一波建议从 P1 选起。

### 4.2 P1（中期）

**高价值 P1 已全部完成 ✅**（2026-05 第二批并行产出）：

| # | 主题 | 阶段 | 价值 | 状态 |
|---|---|---|---|---|
| 7 | Agentic RL 深度 | Step 3 | ⭐⭐⭐⭐ | ✅ 已完成 |
| 8 | Agent 实战项目集 | Step 3 | ⭐⭐⭐⭐ | ✅ 已完成 |
| 9 | 部署进阶 | Step 4 | ⭐⭐⭐⭐ | ✅ 已完成 |
| 10 | 成本优化 | Step 4 | ⭐⭐⭐⭐ | ✅ 已完成 |
| 11 | Browser Agent | Step 6 | ⭐⭐⭐⭐ | ✅ 已完成 |
| 12 | Data Analysis Agent | Step 6 | ⭐⭐⭐⭐ | ✅ 已完成 |

**剩余 P1（理论 / 选型类，按需推进）**：

| # | 主题 | 阶段 | 价值 |
|---|---|---|---|
| 13 | 模型选型与对比 | Step 1 | ⭐⭐⭐ |
| 14 | LLM 基础 | Step 0 | ⭐⭐⭐ |
| 15 | LLM 架构 | Step 5 | ⭐⭐⭐ |

### 4.3 P2（视情况）

- Python for AI（Step 0）
- 流式与异步深度（Step 2）
- 自动化工作流 vs Agent（Step 3）
- 客服 / 销售 Agent（Step 6）

---

## 5. 主题模板速查

新增主题统一遵循 [AGENTS.md §5](./AGENTS.md#5-章节通用结构推荐模板)：

```
# NN · 章节标题

> 1-2 句引子

## 1. <核心概念>
## 2. <最简例子>
## 3-N. <分主题深入>
## 倒数第二节：常见坑
## 最后一节：下一步
```

每个主题 ~10 章；目录结构、index 格式、跨章引用见 [AGENTS.md](./AGENTS.md)。

---

## 6. 路线图维护流程

| 触发 | 动作 |
|---|---|
| 完成一个主题 | 把候选挪到"已完成"区；更新 [README.md](./README.md) / [manifest.json](./manifest.json) / [AGENTS.md §11](./AGENTS.md#11-当前主题清单) |
| 发现新方向 | 加到本文档对应 Step；初步评定优先级 |
| 候选过时 | 标 P2 或移到 Step 7 / 删除 |
| 主题需要拆分 | 在本文档讨论拆分原因；保留旧目录或重组 |

**每季度** review 一次本文档：
- 删除已不重要的候选
- 更新优先级（生态变化）
- 增加新冒出的方向

---

## 7. 跨主题协作原则

候选主题之间**有依赖**——展开顺序合理可减少往复：

```
Prompt 工程 ──► 所有上层主题
模型微调 ──► Agentic RL
推理与部署 ──► 模型微调（部署微调后的模型）
多模态 ──► 多模态 Agent / Browser Agent / 视觉 RAG
LLM 安全 ──► 所有 P0 / P1 主题（横切）
```

**横切主题**（如安全、成本）开了之后，**老主题需要补章节**指向它们。

---

## 8. 当前推荐：下一步开工选哪个

如果让我（代理）从 P0 推荐**一个**最优先的下一步：

> **Prompt 工程进阶（`prompt-engineering`）**

理由：
- **回报最高**：所有上层应用都依赖它，回报立刻可见
- **门槛低**：不依赖训练 / 推理设施
- **稳定性强**：Prompt 工程的核心思路 5 年没变
- **缺口明显**：当前 5 个主题里 Prompt 工程是"分散在各处的零散提示"，没有系统化讲解

如果你的目标偏 **Agent / 应用产品**，可以选：
- **Coding Agent** — 最有商业价值的垂直应用方向

如果你的目标偏 **模型 / 训练**，可以选：
- **模型微调** + **推理与部署** 双线展开

请用户选择优先级，代理按 [AGENTS.md §7](./AGENTS.md#7-新增主题流程) 流程展开。
