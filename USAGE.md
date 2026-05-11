# 使用指南

本仓库是一份 AI 学习笔记，**Markdown 文档 + 一个零依赖 HTML 阅读器**。本文档讲怎么阅读、怎么扩充。

> 主题清单见 [README.md](./README.md)，学习路径规划见 [ROADMAP.md](./ROADMAP.md)，协作/写作规范见 [AGENTS.md](./AGENTS.md)。

## 1. 快速开始（浏览器阅读）

### 方式 A：Python 内置服务器

```bash
cd /path/to/AI-Learn
python3 -m http.server 8000
```

浏览器打开 <http://localhost:8000/>。

### 方式 B：VS Code Live Server

1. 安装扩展 **Live Server**（Ritwick Dey）
2. 在编辑器中右键 `index.html` → **Open with Live Server**

### 方式 C：Node 一行命令

```bash
npx serve .
# 或
npx http-server -p 8000
```

### ⚠️ 不能直接双击 index.html

浏览器对 `file://` 协议禁用 fetch，会报 CORS / `Failed to fetch` 错误，看不到内容。**必须走 HTTP 服务器**。

## 2. 浏览器中导航

阅读器是**单页应用**，三级路由：

| URL | 页面 |
|---|---|
| `http://localhost:8000/` | 总目录（主题卡片） |
| `http://localhost:8000/#/topic/langchain` | LangChain 主题（章节列表） |
| `http://localhost:8000/#/topic/langchain/04-lcel` | LangChain 第 4 章 |

操作：
- **点击主题卡片** → 进入主题章节列表
- **点击章节** → 进入章节正文（自带"上一章 / 下一章"导航）
- **顶栏面包屑** → 任意层级跳回
- **右上角 ◐** → 切换明/暗主题（状态持久化）
- **章节内的相对链接**（如 `./05-tools.md`、`../langgraph/04-control-flow.md`）→ 自动重写为路由跳转

## 3. 不开服务器：直接读 Markdown

所有内容都是普通 Markdown，编辑器/GitHub 直接看也行：

```bash
# 命令行
cat langchain/01-overview.md

# VS Code 预览
code langchain/01-overview.md   # 然后 Cmd+Shift+V

# 任何 Markdown 阅读器：Typora、Obsidian、Marktext 等
```

HTML 阅读器只是个"漂亮包装"——`.md` 才是规范源。

## 4. 添加新主题

完整流程在 [AGENTS.md §4](./AGENTS.md#4-新增主题流程)，简版：

```bash
# 1. 建目录（kebab-case）
mkdir -p prompt-engineering/assets

# 2. 写主题 README（必须含 ## 章节索引）
cat > prompt-engineering/README.md <<'EOF'
# Prompt Engineering

简介……

## 章节索引

1. [01 · 概览](./01-overview.md) — 一句话简介
EOF

# 3. 写第一章
cat > prompt-engineering/01-overview.md <<'EOF'
# 01 · 概览

正文……
EOF
```

然后**两个地方同步登记**：

- [`manifest.json`](./manifest.json) 的 `topics` 数组追加：
  ```json
  {
    "slug": "prompt-engineering",
    "title": "Prompt 工程",
    "summary": "一句话简介",
    "tags": ["Prompt", "LLM"]
  }
  ```
- [`README.md`](./README.md) 的"主题索引"追加一行链接

刷新浏览器，新主题立即出现在首页卡片中。

## 5. 添加新章节

```bash
# 在已有主题下加章节
echo "# 11 · 新章节" > langchain/11-new-topic.md
```

更新该主题 `README.md` 的 `## 章节索引`，**追加一行**：

```markdown
11. [11 · 新章节](./11-new-topic.md) — 一句话简介
```

刷新主题页即出现新章节，不需要改 `manifest.json`（章节列表是从 README 实时解析的）。

### 章节索引格式（强约束）

阅读器解析这个固定格式，**写错了章节就不出现**：

```markdown
## 章节索引

1. [01 · 标题](./01-slug.md) — 描述
2. [02 · 标题](./02-slug.md) — 描述
```

要点：
- 必须**有序列表**（`1.` `2.`），不能用 `-`
- 标题以数字开头：`01 ·` / `02 ·`（`·` 是中文间隔号 U+00B7）
- 链接形如 `./NN-slug.md`，不要写 `.html`
- `—` 后是描述（可选但建议有）

详见 [AGENTS.md §2](./AGENTS.md#2-章节索引格式强制)。

## 6. 章节里的链接写法

| 想链到 | 写法 |
|---|---|
| 同主题章节 | `[02 · 快速上手](./02-quickstart.md)` |
| 同主题章节 + 锚点 | `[X 节](./02-quickstart.md#3-加上-prompt-模板)` |
| 跨主题章节 | `[langgraph/04](../langgraph/04-control-flow.md)` |
| 跨主题主页 | `[../langgraph/](../langgraph/README.md)` |
| 仓库总目录 | `[../README.md](../README.md)` |
| 外部链接 | `https://...`（自动新窗口打开） |
| 章节内图片 | `![alt](./assets/x.png)`（HTML 视图自动重定位到主题目录） |

不要直接写 `.html` 链接——`.md` 是规范源，HTML 路由由阅读器自动生成。

## 7. 修改阅读器（开发者）

| 文件 | 干什么 |
|---|---|
| [`index.html`](./index.html) | 页面骨架 + CDN 引入 |
| [`assets/style.css`](./assets/style.css) | 样式（顶部 `:root` 是颜色变量） |
| [`assets/app.js`](./assets/app.js) | 路由、Markdown 渲染、链接重写 |
| [`manifest.json`](./manifest.json) | 主题元信息 |

修改后**刷新浏览器即可**，没有构建步骤。

## 8. 常见问题（FAQ）

### Q: 打开 index.html 一片空白？
- 看一眼 URL 是 `file://` 还是 `http://`？前者必失败，参见 §1。
- 浏览器 DevTools 控制台（F12）有什么报错？
- 服务器日志里 `manifest.json` / `README.md` 是不是 404？路径不对。

### Q: 主题页章节列表是空的？
- 那个主题的 `README.md` 没有 `## 章节索引` 节，或格式不对（看 §5 末尾"格式强约束"）
- 章节链接里写错了（如忘了 `./` 前缀）

### Q: 我新加了主题，首页没显示？
- 没在 `manifest.json` 注册——加进去。
- 浏览器可能缓存了旧的 manifest，**强制刷新**（Ctrl/Cmd + Shift + R）。

### Q: 章节里的图片不显示？
- 路径不对：图片应放在 `<topic>/assets/<file>`，章节里写 `![](./assets/<file>)`
- 阅读器会把 `./assets/x.png` 自动改写为 `./<当前主题>/assets/x.png`

### Q: 跨主题链接点了不跳？
- 用了**绝对路径**或拼了 `.html`？改成相对 `.md` 形式：`../langgraph/04-control-flow.md`

### Q: 想离线用，没网怎么办？
- marked.js 和 highlight.js 走 CDN，**首次访问后浏览器会缓存**——之后离线打开能用。
- 想完全离线：把这两个 JS / CSS 下载到 `assets/`，`index.html` 改本地路径即可。

### Q: 想换字体 / 颜色？
- [`assets/style.css`](./assets/style.css) 顶部 `:root` 和 `[data-theme="dark"]` 是所有可调变量。

### Q: 浏览器历史回退正常吗？
- 正常。哈希路由配合浏览器 back/forward。但**手动改 hash 不会触发刷新**——切页用链接点击或 `location.hash = '...'`。

## 9. 推荐工作流

```
                ┌─── 写 / 改 .md ────┐
                │                    │
                ▼                    │
      VS Code (左侧编辑器)            │
                │                    │
                ▼                    │
      VS Code (右侧 Live Server 浏览) │
                │                    │
            刷新即看效果              │
                │                    │
                └─── 满意 ──→ 提交 ──┘
```

## 10. 仓库地图速查

```
AI-Learn/
├── README.md            ← 主题清单（你最常看的）
├── USAGE.md             ← 本文件
├── AGENTS.md            ← 协作规范（代理 / 贡献者必读）
├── manifest.json        ← 主题注册表（加主题时改）
├── index.html           ← 阅读器入口
├── assets/{style.css, app.js}
└── <topic>/
    ├── README.md        ← 主题入口（加章节时改 ## 章节索引）
    ├── 01-*.md ... 10-*.md
    └── assets/*.png
```

读 → 看 README.md。
规划 → 看 ROADMAP.md。
改 → 看 AGENTS.md。
跑不起来 → 看本文 §1 / §8。
