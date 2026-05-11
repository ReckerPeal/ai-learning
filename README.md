# AI-Learn

AI 学习笔记仓库，以 Markdown 形式记录学习内容，附带轻量 HTML 阅读器。

## 在浏览器中阅读

仓库提供一个零依赖的 SPA 阅读器：

```bash
cd /path/to/AI-Learn
python3 -m http.server
# 浏览器打开 http://localhost:8000/
```

完整使用、添加主题/章节、常见问题等见 **[USAGE.md](./USAGE.md)**。

> ⚠️ 不能直接双击 `index.html`——浏览器 fetch 不支持 `file://`，必须走本地服务器。

## 目录约定

- 每个主题一个独立目录，目录名使用小写短横线（kebab-case）
- 每个主题目录内：
  - `README.md` 作为主题入口/总览，必须包含 `## 章节索引` 节
  - 章节按 `NN-<slug>.md` 命名（`NN` 两位数字）
  - 图片等资源放在该主题目录的 `assets/` 子目录下

详细规范见 [AGENTS.md](./AGENTS.md)。

## 结构示例

```
AI-Learn/
├── README.md               # 本文件
├── AGENTS.md               # 协作规范（含 HTML 阅读器约定）
├── manifest.json           # 主题注册表
├── index.html              # SPA 入口
├── assets/
│   ├── style.css
│   └── app.js
└── <topic-slug>/
    ├── README.md           # 主题入口（含章节索引）
    ├── 01-<slug>.md
    ├── 02-<slug>.md
    └── assets/
        └── diagram.png
```

## 主题索引

<!-- 新增主题时同步更新本表 + manifest.json -->

**Step 1 · 基础**
- [LangChain](./langchain/) — LLM 应用的组件库 + LCEL 编排框架
- [Prompt 工程进阶](./prompt-engineering/) — CoT、Few-shot、模板化、对抗 Prompt

**Step 2 · 进阶编排**
- [LangGraph](./langgraph/) — 基于图的有状态 LLM 应用编排框架
- [RAG 进阶](./rag-advanced/) — 从 Naive 到生产级：分块、混合检索、Rerank、Agentic RAG
- [多模态](./multimodal/) — VLM、文档理解、图表、音视频、多模态 RAG / Agent

**Step 3 · Agent 系统**
- [Agents · 智能体系统](./agents/) — Agent 设计原则、范式、模式（参考 [hello-agents](https://github.com/datawhalechina/hello-agents)）
- [Agentic RL 深度](./agentic-rl/) — 训练专用 Agent 模型：SFT / DPO / GRPO / 过程监督
- [Agent 实战项目集](./agent-projects/) — Travel / Deep Research / 客服 / Code Review / Data 端到端

**Step 4 · 工程化**
- [LLM Eval](./eval/) — LLM 应用评测体系：数据集、指标、Judge、CI、A/B、EDD
- [LLM 安全](./llm-security/) — Prompt 注入、Jailbreak、红队、防御工具、合规
- [部署进阶](./deployment/) — Docker / K8s / Serverless / LangGraph Server / 监控 / 容灾 / CI-CD
- [成本优化](./cost-optimization/) — Token 经济、模型路由、Prompt 缓存、批处理、按租户拆账

**Step 5 · 模型层**
- [模型微调](./fine-tuning/) — SFT / LoRA / QLoRA / 数据合成 / 评测 / 部署
- [推理与部署](./llm-inference/) — vLLM / 量化 / 多 GPU / 长上下文 / 性能调优

**Step 6 · 垂直应用**
- [Coding Agent](./coding-agent/) — 代码理解 / 生成 / 沙箱 / Review / Debug
- [Browser / 自动化 Agent](./browser-agent/) — Computer Use / Vision + DOM / 错误恢复 / 合规
- [Data Analysis Agent](./data-agent/) — SQL Agent / Pandas / 可视化 / 报告生成 / 多源数据

## 学习路径与规划

- 已完成主题按 4 个阶段（基础 → 进阶编排 → Agent 系统 → 工程化）组织，首页可视化展示
- 候选主题与未来方向见 **[ROADMAP.md](./ROADMAP.md)**（含优先级、章节大纲、依赖关系）
