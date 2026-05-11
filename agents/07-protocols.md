# 07 · 通信协议（MCP / A2A / ANP）

> 对应 [hello-agents](https://github.com/datawhalechina/hello-agents) 第 10 章。
> 协议是 Agent 生态的"基础设施"——决定了 Agent 之间、Agent 与工具之间能不能"互联互通"。

## 1. 为什么需要协议

没有协议时，每个 Agent 框架自己定义一套"工具调用格式"——LangChain 一种、AutoGen 一种、自家代码一种。结果：

- 同一个工具要为每个框架适配一遍
- 跨厂商 Agent 协作几乎不可能
- 用户被锁在单一生态

协议解决三类标准化：

| 协议 | 标准化什么 | 比喻 |
|---|---|---|
| **MCP**（Model Context Protocol） | Agent ↔ 工具 / 资源 | USB |
| **A2A**（Agent-to-Agent） | Agent ↔ Agent | HTTP |
| **ANP**（Agent Network Protocol） | Agent 网络发现与发布 | DNS |

## 2. MCP：当下最重要的协议

[Model Context Protocol](https://modelcontextprotocol.io)（Anthropic 主导，2024-11 开源）—— 已被广泛采纳的事实标准。

### 2.1 解决了什么

```
没 MCP 之前：           有 MCP 之后：

Claude Code ──► GitHub  Claude Code ┐
LangGraph   ──► GitHub  LangGraph   ├──► MCP Client ──► GitHub MCP Server
Cursor      ──► GitHub  Cursor      ┘                 (官方/社区写一次)
[每家都要写一遍]
```

写一次 MCP server，所有支持 MCP 的 Agent 都能用。

### 2.2 架构

```
┌─────────────────┐                  ┌─────────────────┐
│   Host          │                  │   MCP Server    │
│  （Claude Code  │  JSON-RPC over   │                 │
│   / IDE / etc）│  stdio / HTTP    │  - Tools        │
│                 │ ◄──────────────► │  - Resources    │
│  + MCP Client   │                  │  - Prompts      │
└─────────────────┘                  └─────────────────┘
```

三种基础能力：

| Primitive | 是什么 | 例子 |
|---|---|---|
| **Tools** | 可调用函数 | `search_repos`、`create_pr` |
| **Resources** | 可读资源（URI 寻址） | `file:///path/x.md`、`postgres://table/users` |
| **Prompts** | 模板化 prompt | "请审查这段代码：{code}" |

### 2.3 用一个 MCP server（Client 视角）

LangChain 集成：

```python
# pip install langchain-mcp-adapters
from langchain_mcp_adapters.client import MultiServerMCPClient

async with MultiServerMCPClient({
    "github": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-github"],
        "env": {"GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..."},
    },
    "filesystem": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
    },
}) as client:
    tools = client.get_tools()    # 返回所有 server 的工具
    agent = create_react_agent(llm, tools)
    result = await agent.ainvoke({"messages": [HumanMessage("查看仓库 X 的最新 PR")]})
```

Claude Code / Cursor / Continue 等 IDE 中直接配 `mcp.json` 即可，**无需改 Agent 代码**。

### 2.4 写一个 MCP server（Server 视角）

Python SDK：

```python
# pip install mcp
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("my-server")

@mcp.tool()
def search_users(query: str) -> list[dict]:
    """根据关键词搜索用户。"""
    return db.query(query)

@mcp.resource("user://{user_id}")
def get_user(user_id: str) -> str:
    """获取用户详情（作为资源）。"""
    return json.dumps(db.get(user_id))

@mcp.prompt()
def review_user(user_id: str) -> str:
    """生成审查用户的 prompt 模板。"""
    return f"请审查用户 {user_id} 的注册信息..."

if __name__ == "__main__":
    mcp.run()    # 默认 stdio
```

部署：
- **stdio**：本地进程，Host 启动 server 子进程通过 stdin/stdout 通信（最常见）
- **HTTP / SSE**：远程，HTTP server 跑着等 Client 连

### 2.5 现成的 MCP server 生态

[官方仓库](https://github.com/modelcontextprotocol/servers) 提供大量现成 server：

| Server | 能力 |
|---|---|
| filesystem | 读写本地文件 |
| github | GitHub API 全套 |
| postgres | SQL 查询 |
| puppeteer | 浏览器自动化 |
| brave-search / fetch | Web 搜索与抓取 |
| memory | 简单 KV 记忆 |
| slack / google-drive / sentry | SaaS 集成 |

社区还有 几百+ 第三方 server——用之前看星标和最近 commit。

### 2.6 MCP 的工程考量

| 维度 | 注意 |
|---|---|
| 安全 | server 跑在你机器上 / VPC 内，但 LLM 调用是 black box → 关键 server 加 HITL |
| 性能 | stdio 启动有冷启动；高频调用考虑 HTTP server 长连接 |
| 错误传播 | server 错误 → MCP 返回 error response → Client 转给 LLM |
| 版本 | server 升级可能改 schema；锁定版本 |
| 鉴权 | server 自己处理（环境变量 / OAuth） |

## 3. A2A：Agent-to-Agent 协议

[A2A Protocol](https://github.com/google-a2a/a2a-spec)（Google 主导，2025）——让不同厂商、不同框架的 Agent 互相调用。

### 3.1 解决什么

MCP 解决 Agent ↔ 工具；A2A 解决 Agent ↔ Agent。场景：

- 你的 Agent 想调 OpenAI 官方 Agent
- 你的客服 Agent 想调供应商的物流 Agent
- 多家公司的 Agent 协作完成一个任务

### 3.2 核心概念

| 概念 | 说明 |
|---|---|
| **Agent Card** | 一个 JSON 描述 Agent 的能力、endpoint、鉴权（类似 OpenAPI spec） |
| **Task** | 用户发起的一个任务（有 ID、状态、消息历史） |
| **Skills** | Agent 提供的能力清单（与 MCP Tools 类似但更"任务级"） |
| **Push** | Agent 主动通知任务进展（流式 / webhook） |

### 3.3 简化流程

```
Client Agent          Remote Agent
  ┌──────┐               ┌──────┐
  │      │ 1. discover   │      │
  │      │ ──────────────►│      │ → Agent Card
  │      │               │      │
  │      │ 2. send Task  │      │
  │      │ ──────────────►│      │
  │      │               │      │
  │      │ 3. updates    │      │
  │      │ ◄──────────────│      │ (push)
  │      │               │      │
  │      │ 4. final      │      │
  │      │ ◄──────────────│      │
  └──────┘               └──────┘
```

A2A 比 MCP**更"高层"**——MCP 是工具粒度，A2A 是任务粒度。

### 3.4 落地状态（2025 年中）

A2A 还在快速演化，生态远不如 MCP 成熟。**实战推荐**：
- 短期：用 MCP 把"被调 Agent"包成 MCP server
- 长期：观察 A2A 标准成熟度，主流框架（LangGraph / AutoGen）都在跟进

## 4. ANP：Agent Network Protocol

[Agent Network Protocol](https://github.com/agent-network-protocol/AgentNetworkProtocol)（中国发起，开源）—— **Agent 之间的"DNS + 协议层"**。

### 4.1 三层架构

```
L3  应用层      Agent 之间消息（基于 NLIP / 自定义）
L2  元协议      能力发现、协商
L1  身份层      DID（Decentralized Identifier） + 加密
```

### 4.2 与 A2A 的区别

| 维度 | A2A | ANP |
|---|---|---|
| 设计目标 | 企业内部 / 受信任伙伴间 | 开放互联网（去中心） |
| 身份 | 厂商鉴权 | DID（区块链思路） |
| 主导方 | Google | 开源社区（中国） |
| 成熟度 | 早期 | 早期 |

### 4.3 ANP 的愿景

让 Agent 像网页一样"能被搜索"：

```
搜索"想找一个会订机票的 Agent"
   │
   ▼
ANP 网络
   │
   ▼
返回多个候选 Agent（带能力卡 + DID）
   │
   ▼
你的 Agent 直接和它们通信
```

很有想象力，但**目前是概念阶段**——本章作了解，不需要落地。

## 5. 协议选型：实战指南

| 你想做的 | 选哪个 |
|---|---|
| 让 Claude Code / Cursor 用上你的工具 | MCP（首选） |
| 让 LangGraph Agent 用第三方工具 | MCP |
| 自家不同 Agent 之间协作 | LangGraph 子图 / 共享 state（不需要协议） |
| 调外部供应商的 Agent | A2A（如果对方支持）/ HTTP API |
| 公开 Agent 给陌生 Agent 调用 | A2A / ANP（前沿） |

**实操优先级**：MCP >> A2A > ANP。先把 MCP 玩熟，A2A 关注但不急上车。

## 6. MCP 的进阶用法

### 6.1 Claude Skills + MCP 组合

Anthropic 还推了 **Skills**——markdown 格式的可调用"工作流模板"。Skills + MCP 的组合：

- Skill 定义"做某事的步骤"
- 每个步骤调 MCP server 提供的具体工具
- Skills 可在 MCP server 里发布

详见 [`agents/03 §6.2`](./03-cognitive-architecture.md#62-claude-skills-范式)。

### 6.2 多 MCP server 协作

一个 Agent 同时连多个 server，工具空间合并：

```python
async with MultiServerMCPClient({
    "github": {...},
    "slack": {...},
    "memory": {...},
}) as client:
    tools = client.get_tools()   # 三个 server 的所有工具
    # Agent 可以"在 GitHub 创建 issue 后通知 Slack"
```

### 6.3 远程 MCP

stdio 适合本地开发；生产用 HTTP server：

```python
@mcp.tool()
def my_tool(...): ...

if __name__ == "__main__":
    mcp.run(transport="streamable-http", port=8080)
```

部署成普通 web service（Docker / k8s），Client 通过 URL 连。可以加：
- 反向代理（nginx）
- 鉴权层（JWT、OAuth）
- 速率限制

## 7. 协议层的安全

协议本身解决"互通"，**不**解决"安全"。每层要自己加：

| 层 | 安全措施 |
|---|---|
| MCP server | 鉴权（API key / OAuth）、最小权限、审计日志 |
| MCP client | 不要让 LLM 自己控制敏感参数（user_id 等）；高危工具走 HITL |
| A2A | TLS、签名、零信任：每次任务都重新校验权限 |
| ANP | DID 防伪造；但 Agent 本身可能撒谎 → 行为可信度评估 |

特别注意：**MCP server 的输出会进 LLM 上下文**——server 返回的恶意内容（prompt 注入）会劫持 Agent。详见 [`§04 §6.3`](./04-tool-use.md#63-output-也是攻击面)。

## 8. 协议生态参考

| 项目 | 协议 | 备注 |
|---|---|---|
| modelcontextprotocol/servers | MCP | 官方 server 集合 |
| modelcontextprotocol/python-sdk / typescript-sdk | MCP | 官方 SDK |
| langchain-mcp-adapters | MCP | LangChain 集成 |
| google-a2a/a2a-spec | A2A | 协议规范 |
| AgentNetworkProtocol/AgentNetworkProtocol | ANP | 主仓库 |
| OpenAI Agents SDK | 自家协议 | 偏 OpenAI 生态 |
| Claude Agent SDK | 自家协议 + MCP | Anthropic 主推 |

## 9. 协议演化的思考

类比 Web 协议史：

- HTTP（应用层）→ MCP
- DNS（发现层）→ ANP
- HTTPS / OAuth（安全层）→ 各家在补

我们正处在"Agent 的 HTTP 1.0 阶段"——协议正在快速迭代，标准远未稳定。**保守做法**：

- 短期工程上**只押注 MCP**（生态好、回报确定）
- 中期跟踪 A2A
- ANP 等观望

## 10. 反模式

| 反模式 | 后果 |
|---|---|
| 自己造一套 Agent 协议 | 重复造轮子；上了 MCP 才知道好用 |
| MCP server 跑在生产时不限流 | LLM 失控 → server 被 DDoS |
| 让 LLM 看到 MCP server 内部错误堆栈 | 暴露信息；统一包装 error |
| MCP server 没有 idempotency | LLM 反复调时副作用累加 |
| A2A 接陌生 Agent 不验证 | Agent 之间互相欺骗 |
| MCP / A2A 全部用 stdout 日志 | 协议本身就是 stdio，搞乱通信 → 用 stderr 或专门 logger |

## 11. 实战：从 0 写一个有用的 MCP server

下面这个 server 给 Agent 一个"项目 readme 查询"工具：

```python
# my_mcp_server.py
import os, glob
from pathlib import Path
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("project-readme")

PROJECTS_DIR = Path(os.environ.get("PROJECTS_DIR", "~/work")).expanduser()

@mcp.tool()
def list_projects() -> list[str]:
    """列出所有有 README 的项目。"""
    return [p.parent.name for p in PROJECTS_DIR.glob("*/README.md")]

@mcp.tool()
def read_readme(project: str) -> str:
    """读取项目的 README.md。"""
    path = PROJECTS_DIR / project / "README.md"
    if not path.exists():
        return f"Error: project '{project}' has no README"
    return path.read_text()[:5000]

if __name__ == "__main__":
    mcp.run()
```

注册到 Claude Code（`~/.claude.json`）：

```json
{
  "mcpServers": {
    "project-readme": {
      "command": "python3",
      "args": ["/path/to/my_mcp_server.py"],
      "env": {"PROJECTS_DIR": "/Users/me/work"}
    }
  }
}
```

重启 Claude Code，问"列出我的项目，读一下 X 项目的 README" → 自动调你的工具。**写一次，所有 MCP-aware Agent 都能用**。

## 12. 下一步

- [04 · 工具使用](./04-tool-use.md) — MCP tool 也按这套设计原则
- [09 · 框架对比](./09-frameworks.md) — 各框架 MCP 集成情况
- [Anthropic MCP 官方文档](https://modelcontextprotocol.io)
- [A2A 协议规范](https://github.com/google-a2a/a2a-spec)
