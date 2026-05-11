# AGENTS.md

> 本仓库面向 LLM 编码代理（Claude Code / Codex / Cursor 等）的协作规范。
> 人工读者请看 [README.md](./README.md)（主题清单）、[USAGE.md](./USAGE.md)（使用方式）、[ROADMAP.md](./ROADMAP.md)（学习路径规划）。

## 0. 仓库性质

- 学习笔记仓库，**主要内容是 Markdown 文档**
- 不是软件项目：没有 build / test / lint 流程
- 编辑代码 = 编辑 Markdown + 维护一个轻量 HTML 阅读器
- 风格定位：**工程实战向、信息密度高、有明确"反模式"**——不是教科书翻译，也不是 API 罗列

## 1. 学习资源参考

写作 / 校对 / 扩充章节时，可以从下面这些**外部高质量资源**获取灵感与事实参考。**严禁**直接搬运段落（侵权），但**鼓励**借鉴知识结构、术语、配图思路。

### 综合 Agent 教程

- **[datawhalechina/hello-agents](https://github.com/datawhalechina/hello-agents)** — Datawhale 开源的 16 章中文 Agent 教程，覆盖：
  - 第 1-3 章 智能体基础（定义、历史、LLM 基础）
  - 第 4 章 经典范式（ReAct / Plan-and-Solve / Reflection）→ 与本仓 [`langgraph/05`](./langgraph/05-tools-and-agents.md) 互补
  - 第 6 章 框架实战（AutoGen / AgentScope / **LangGraph**）→ 对应本仓 [`langgraph/`](./langgraph/) 全主题
  - 第 7 章 从零造 Agent 框架
  - 第 8 章 Memory 与 RAG → 对应本仓 [`rag-advanced/`](./rag-advanced/)
  - 第 9 章 上下文工程
  - 第 10 章 通信协议（**MCP / A2A / ANP**）
  - 第 11 章 Agentic 强化学习（SFT → GRPO）
  - 第 12 章 Agent 评测 → 对应本仓 [`eval/07`](./eval/07-agent-eval.md)
  - 第 13-16 章 实战项目（旅行助手、Deep Research、Cyber Town、毕业项目）

  **何时参考**：开新主题（如 MCP / 多 Agent 通信 / Agentic RL）找不到切入点时；想看一条完整学习路径如何编排时。

### 官方文档（事实校对的金标）

- LangChain：https://python.langchain.com/
- LangGraph：https://langchain-ai.github.io/langgraph/
- LangSmith：https://docs.smith.langchain.com/
- RAGAS：https://docs.ragas.io/
- Anthropic API：https://docs.anthropic.com/
- OpenAI Cookbook：https://cookbook.openai.com/

写章节涉及具体 API 时，**先核对官方文档版本**——LangChain / LangGraph 迭代很快，老博客的代码常已废弃。

### 学术与基准

- arxiv-sanity / Papers with Code（找 SOTA）
- MTEB（embedding 基准）
- LMArena / MT-Bench（模型与 judge 校准）

### 风格基准

仓库内现有四大主题（[langchain](./langchain/) / [langgraph](./langgraph/) / [rag-advanced](./rag-advanced/) / [eval](./eval/)）已建立稳定写作风格，新内容**先模仿它们**：表格密集、有"常见坑"小节、章末有"下一步"链接。

## 2. 目录结构（强制）

```
AI-Learn/
├── README.md                  # 仓库入口（人工版，主题清单）
├── USAGE.md                   # 使用方式 / FAQ
├── AGENTS.md                  # 本文件（代理协作规范）
├── manifest.json              # 主题注册表（HTML 视图用）
├── index.html                 # SPA 入口
├── assets/
│   ├── style.css
│   └── app.js
└── <topic-slug>/              # 每个主题一个目录
    ├── README.md              # 主题入口 + 章节索引
    ├── 01-<slug>.md           # 章节，按数字前缀排序
    ├── 02-<slug>.md
    ├── ...
    └── assets/                # 该主题的图片等资源
        └── *.png
```

### 命名约定

| 项 | 规则 |
|---|---|
| 主题目录 | kebab-case，例：`langchain`、`rag-advanced` |
| 章节文件 | `NN-<slug>.md`，`NN` 是两位数字（`01`-`99`），slug 用 kebab-case |
| 图片资源 | 放在 `<topic>/assets/`，章节内用相对路径 `./assets/<file>` 引用 |
| 章节标题 | `# NN · <中文标题>`（Markdown H1，`·` 是中文间隔号 U+00B7） |

## 3. 章节索引格式（强制）

每个 `<topic>/README.md` **必须**包含 `## 章节索引` 一节，使用有序列表，链接形如 `./NN-slug.md`：

```markdown
## 章节索引

1. [01 · 概览与生态](./01-overview.md) — 一句话简介
2. [02 · 快速上手](./02-quickstart.md) — 一句话简介
3. ...
```

要求：
- 必须是有序列表（`1.` `2.` ...），不能用无序列表（`-`）
- 标题部分以 `NN · 标题` 开头（HTML 视图据此提取章节序号）
- 链接使用 `./NN-slug.md` 相对路径
- `—` 后是简短描述（可选但强烈建议）

**为什么强制**：HTML 阅读器（`assets/app.js` 的 `parseChapters`）按这个格式扫 README，**格式跑偏 → 章节列表空白**。

### 自检（修改后必跑）

```bash
# 在仓库根
grep -n "^[0-9]\+\." <topic>/README.md
# 输出条数应该 = 该主题章节文件数
ls <topic>/[0-9]*.md | wc -l
```

两数字不一致 = 索引漏了 / 多了。

## 4. 跨章节 / 跨主题引用（强制）

| 引用 | 写法 |
|---|---|
| 同主题章节 | `[02 · 快速上手](./02-quickstart.md)` |
| 同主题章节 + 锚点 | `[X 节](./02-quickstart.md#3-加上-prompt-模板)` |
| 跨主题章节 | `[langgraph/04](../langgraph/04-control-flow.md)` |
| 跨主题主页 | `[../langgraph/README.md](../langgraph/README.md)` |
| 仓库总目录 | `[../README.md](../README.md)` |

HTML 阅读器会自动把这些 `.md` 链接重写为 hash 路由。**不要直接写 `.html` 链接**——保持 .md 是规范源。

锚点生成规则：**marked.js 默认把标题转 kebab-case**，如 `## 3.1 加上 Prompt 模板` → `#31-加上-prompt-模板`（数字间小数点会丢、空格转 `-`、保留中文、英文小写）。不确定时实际渲染一次确认。

## 5. 章节通用结构（推荐模板）

现有主题章节有稳定的"骨架"，新章节先按这个写，再按需调整：

```markdown
# NN · 章节标题

> 1-2 句话引子，说"本章解决什么问题"。可选。

## 1. <核心概念 / 心智模型>

文字 + 表格 / 图。

## 2. <最简例子 / Hello World>

```python
# 可运行的最小代码
```

## 3-N. <分主题深入>

每节 1 个清晰主题，配代码 / 表格 / 决策树。

## <倒数第二节> 常见坑（强烈建议）

| 现象 | 原因 |
|---|---|
| ... | ... |

## <最后一节> 下一步（强烈建议）

- [相关章节 1](./XX-xxx.md)：一句话说明
- [相关章节 2](../<其他主题>/XX-xxx.md)：一句话说明
```

**为什么这样**：HTML 阅读器会自动加"上一章 / 下一章"导航，但**章末的"下一步"指向的是相关而非顺序的章节**——更有用。"常见坑"是高密度信息，读者最爱看。

## 6. 写作规范（软约束）

适用所有 `.md` 内容。**不强制语法检查**，但保持一致性能让阅读器渲染更可控。

### 排版

| 项 | 推荐 |
|---|---|
| 列表 | 顶层用 `-`；章节索引用 `1. 2. 3.` |
| 代码块 | 三反引号 + 语言标签（`python` / `bash` / `yaml` / `json` 等），便于高亮 |
| 表格 | 用 GFM 语法；不要超过 5 列（mobile 横滚） |
| 中英文 | 中英文之间留一个空格；中文标点用全角 |
| 标题层级 | 不跳级（H2 → H3 → H4，不要 H2 → H4） |
| 引用块 | `> ` 用于关键提示 / TLDR / 警告 |
| 强调 | 重要词用 `**加粗**`；术语用反引号 |

### 语气与文风

- **直接、不绕弯**：避免"在本章节中我们将探讨……"这种学院派开场
- **结论先行**：先给答案 / 决策，再给解释
- **有立场**：不要回避取舍，明说"推荐 X，因为 Y"
- **避免空话**：删掉"非常重要"、"务必注意"这种没信息量的修饰
- **代码贴近能跑**：示例代码尽量自包含，不要写 `# ...` 省略关键逻辑

### 信息密度

- 表格 > 段落（同等信息量下表格更易扫读）
- 决策树 / 流程图比口述步骤好
- "常见坑 / 反模式" 是金块——只要凑得出 3 条就值得加一节

## 7. 新增主题流程

1. 选定 `slug`（kebab-case），创建目录：
   ```bash
   mkdir -p <slug>/assets
   ```
2. 编写 `<slug>/README.md`，**必须**包含：
   - 主题简介（1 段）
   - `## 章节索引` 节（即使一开始只有占位）
   - 可选：与其他主题的关系速记表
3. 编写章节文件 `01-*.md`、`02-*.md` ...（参考 §5 模板）
4. 在 [`manifest.json`](./manifest.json) 的 `topics` 数组追加：
   ```json
   {
     "slug": "<slug>",
     "title": "<显示标题>",
     "summary": "<一句话简介，HTML 卡片用>",
     "tags": ["<标签1>", "<标签2>"]
   }
   ```
5. 在根 [`README.md`](./README.md) 的"主题索引"追加一行链接
6. 同步更新本文件 §10 的主题清单表

**惯例**：先创建骨架（README + 第 1 章占位），让用户审核结构是否合理；用户确认后再批量展开后续章节。

## 8. 新增章节流程

1. 创建 `<topic>/NN-<slug>.md`，序号衔接已有章节
2. 章节首行用 `# NN · 标题` 作为 H1
3. 在 `<topic>/README.md` 的 `## 章节索引` 追加对应行
4. 章节末尾加 "下一步" / "进一步阅读" 链接，指向相关章节
5. 跑一遍 §3 的自检命令

## 9. HTML 阅读器（`index.html`）

- 单页应用，hash 路由：
  - `#/` → 主题列表
  - `#/topic/<slug>` → 该主题章节列表
  - `#/topic/<slug>/<chapter-slug>` → 章节渲染页
- **不修改 `.md` 文件**——所有导航、面包屑、图片重定向都在 JS 层完成
- 本地浏览需要 HTTP 服务器：
  ```bash
  python3 -m http.server
  # 然后浏览器打开 http://localhost:8000/
  ```
  直接 `file://` 打开会因 fetch 限制而无法加载 .md

### 修改阅读器时

- `manifest.json`：只增删主题元信息，不放章节（章节由 README 解析）
- `assets/style.css`：明/暗主题变量在顶部 `:root` / `[data-theme="dark"]`
- `assets/app.js`：路由 + Markdown 渲染 + 链接重写
- 不引入构建工具：保持纯 HTML/CSS/JS，CDN 加载 marked + highlight.js

## 10. 代理工作约束

| 场景 | 约定 |
|---|---|
| 用户要"开新主题" | 按 §7 流程；先创建骨架（README + 第 1 章占位），等用户确认结构再展开 |
| 用户要"加章节" | 按 §8 流程；新章末尾别忘改 README 索引；用 §3 自检 |
| 用户要"重命名章节" | 改文件名 + README 索引同步；旧链接会失效，必要时全仓 grep 替换 |
| 修改阅读器 | 改完直接告诉用户用本地服务器测试（无法在沙箱里跑 server） |
| 提交习惯 | 仅在用户明确请求时提交（git commit） |
| 大批量改 .md | 优先用 Edit（精准替换），不要整文件 Write 覆盖（容易丢内容） |
| 引用外部资料 | 给出来源链接；不要原文搬运段落（侵权）；可借鉴结构和事实 |
| 写代码示例 | 优先选**当前最新稳定版**的 API；老 API 出现时显式标注"已弃用" |
| 标记 TODO | 用 `> TODO: ...` 引用块，便于 grep |

## 11. 当前主题清单

| Slug | 主题 | Step | 章节数 | 备注 |
|---|---|---|---|---|
| `langchain` | LangChain | 1 | 10 | hello-agents 第 6 章节内提及 |
| `prompt-engineering` | Prompt 工程进阶 | 1 | 10 | — |
| `langgraph` | LangGraph | 2 | 10 | hello-agents 第 4 / 6 章 |
| `rag-advanced` | RAG 进阶 | 2 | 10 | hello-agents 第 8 章 |
| `multimodal` | 多模态 | 2 | 10 | — |
| `agents` | Agents · 智能体系统 | 3 | 10 | hello-agents 第 1-12 章（系统综合） |
| `agentic-rl` | Agentic RL 深度 | 3 | 10 | DPO / GRPO / 过程监督 |
| `agent-projects` | Agent 实战项目集 | 3 | 10 | hello-agents 第 13-16 章风格 |
| `eval` | LLM Eval | 4 | 10 | hello-agents 第 12 章 |
| `llm-security` | LLM 安全 | 4 | 10 | — |
| `deployment` | 部署进阶 | 4 | 10 | 应用层部署（K8s / Serverless / 监控） |
| `cost-optimization` | 成本优化 | 4 | 10 | Token 经济 / 路由 / 缓存 / 拆账 |
| `fine-tuning` | 模型微调 | 5 | 10 | — |
| `llm-inference` | 推理与部署 | 5 | 10 | 模型层推理（vLLM / 量化 / 多 GPU） |
| `coding-agent` | Coding Agent | 6 | 10 | hello-agents 第 13 章风格 |
| `browser-agent` | Browser / 自动化 Agent | 6 | 10 | Computer Use / Playwright / DOM+Vision |
| `data-agent` | Data Analysis Agent | 6 | 10 | SQL Agent / Pandas / 可视化 |

新增 / 修改主题后**同步更新**本表与 `manifest.json`。

候选主题与开工优先级见 **[ROADMAP.md](./ROADMAP.md)**——含每个候选的章节大纲、依赖、价值评估。新增 / 完成主题时同步更新 ROADMAP。

## 12. 遇到不确定时

- **写作风格不确定** → 看 [`langgraph/`](./langgraph/) 任意一章作为参考样板
- **章节索引格式不确定** → 看 [`langgraph/README.md`](./langgraph/README.md)
- **HTML 视图行为不确定** → 让用户启动本地 server 实测
- **某主题的章节怎么编排不确定** → 参考 §1 列出的外部资源（特别是 hello-agents 的目录）找思路
- **命名拿不准** → 先在对话中和用户对齐，不要自己拍板
- **删 / 改大段已有内容** → 先解释意图给用户，确认后再动手
