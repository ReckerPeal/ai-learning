# 02 · Docker 与 Compose

LLM 应用打镜像，看起来和普通 Python 服务一样，但有几个**容易踩的细节**：依赖大（torch + transformers 一个就 4GB+）、需要原生扩展（lxml/asyncpg/uvloop）、要跑非 root、要给 LangChain/LangGraph 留 secrets 的路径。这一章给可以直接复制的模板。

## 1. 镜像策略：多阶段构建

```dockerfile
# syntax=docker/dockerfile:1.7

# ---------- 构建阶段 ----------
FROM python:3.12-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

# 编译期才要的系统库
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        curl \
        git \
    && rm -rf /var/lib/apt/lists/*

# uv 比 pip 快很多
RUN pip install uv==0.5.4

WORKDIR /build
COPY pyproject.toml uv.lock ./

# 用 cache mount 大幅加速二次构建（BuildKit）
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

# ---------- 运行阶段 ----------
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:$PATH"

# 运行时才要的系统库（注意不要装 build-essential）
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        libpq5 \
        tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app --home /app --shell /sbin/nologin app

WORKDIR /app

# 仅拷贝虚拟环境，不带 build-essential
COPY --from=builder --chown=app:app /build/.venv /app/.venv

# 业务代码
COPY --chown=app:app app/ /app/app/
COPY --chown=app:app pyproject.toml /app/

# 非 root 是硬要求（k8s PodSecurity 也会强制）
USER app

# tini 处理信号转发，否则 Ctrl-C 不优雅
ENTRYPOINT ["/usr/bin/tini", "--"]

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:8000/health || exit 1

CMD ["uvicorn", "app.api:api", \
     "--host", "0.0.0.0", "--port", "8000", \
     "--workers", "2", \
     "--proxy-headers", "--forwarded-allow-ips=*"]
```

**关键点**：

| 细节 | 为什么 |
|---|---|
| 多阶段（builder + runtime） | 不把 gcc/git 带进运行镜像，瘦身 200MB+ |
| `--mount=type=cache` | 二次构建从 5 分钟降到 30 秒 |
| 非 root（uid 10001） | k8s 默认 PodSecurity restricted 会拒绝 root |
| `tini` 作为 PID 1 | 信号转发 + 僵尸进程回收 |
| `--proxy-headers` | 通过 Ingress 时拿到真实客户端 IP |
| `HEALTHCHECK` | docker / compose 自带健康检查，k8s 用 probe 覆盖 |

## 2. 关于 `python:3.12-slim` vs `distroless` vs `alpine`

| 基础镜像 | 大小 | 兼容性 | 建议 |
|---|---|---|---|
| `python:3.12-slim` | ~130MB | 好（Debian glibc） | **默认推荐** |
| `python:3.12` | ~1GB | 最好 | 不推荐生产 |
| `python:3.12-alpine` | ~50MB | 差（musl，很多 wheel 没预编译） | 不推荐 LLM 场景 |
| `gcr.io/distroless/python3` | ~50MB | 中（没 shell，调试难） | 安全敏感场景 |

alpine 看着小，但 `lxml`、`asyncpg`、`grpcio` 在 alpine 上经常要现编，最终镜像更大、构建更慢。**老老实实 slim**。

## 3. .dockerignore（少了它每次 build 都把 .venv/data 拷一遍）

```
# .dockerignore
.git
.gitignore
.venv
.env
.env.*
__pycache__
*.pyc
*.pyo
.pytest_cache
.ruff_cache
.mypy_cache
node_modules
dist
build
.DS_Store
*.ipynb_checkpoints
data/
models/
logs/
*.log
docker-compose*.yml
Dockerfile*
README*.md
docs/
tests/
```

`.dockerignore` 不写好，每次 build 几个 GB 数据进 context，速度从 30 秒变成 5 分钟。

## 4. Docker Compose：本地开发

LLM 应用本地通常要一起跑：app + postgres（持久化 checkpoint）+ redis（缓存 / 限流）+ Langfuse（可选 trace）。

```yaml
# docker-compose.yml
services:
  app:
    build:
      context: .
      target: runtime
    image: my-agent:dev
    environment:
      - DATABASE_URL=postgresql+asyncpg://postgres:postgres@postgres:5432/agent
      - REDIS_URL=redis://redis:6379/0
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - LANGCHAIN_TRACING_V2=true
      - LANGCHAIN_API_KEY=${LANGCHAIN_API_KEY}
      - LANGCHAIN_PROJECT=local
    ports:
      - "8000:8000"
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    volumes:
      - ./app:/app/app:ro       # 开发时挂源码，热重载
    command:
      - uvicorn
      - app.api:api
      - --host=0.0.0.0
      - --port=8000
      - --reload
    restart: unless-stopped

  postgres:
    image: postgres:16-alpine
    environment:
      - POSTGRES_PASSWORD=postgres
      - POSTGRES_DB=agent
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "postgres"]
      interval: 5s
      timeout: 3s
      retries: 5
    ports:
      - "5432:5432"

  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    ports:
      - "6379:6379"

  # 可选：本地 trace
  langfuse:
    image: langfuse/langfuse:latest
    environment:
      - DATABASE_URL=postgresql://postgres:postgres@postgres:5432/langfuse
      - NEXTAUTH_SECRET=local-secret
      - SALT=local-salt
      - NEXTAUTH_URL=http://localhost:3000
    ports:
      - "3000:3000"
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  pgdata:
  redisdata:
```

启动：

```bash
cp .env.example .env       # 填 OPENAI_API_KEY 等
docker compose up -d
docker compose logs -f app
```

## 5. 镜像瘦身实测

一个真实的 LangChain + LangGraph + asyncpg + openai SDK 的应用：

| 优化项 | 镜像大小 | 备注 |
|---|---|---|
| `python:3.12` 单阶段 | 1.8 GB | baseline |
| 改 `python:3.12-slim` | 1.2 GB | 省 600MB |
| 多阶段，运行时不带 gcc | 870 MB | 省 330MB |
| 删 `__pycache__`、`*.pyc`（pip 选项） | 820 MB | 省 50MB |
| 用 uv 替 pip + `--no-dev` | 760 MB | 省 60MB |
| 不装 `torch`（应用层用不到） | 480 MB | torch 一个就 300MB+ |
| 用 `python-slim-bookworm` + jemalloc | 470 MB | 微调 |

**最大的赢点**：**别误装 torch**。LangChain 文档示例里很多 `pip install langchain[all]` 会把 torch 拉进来，应用层完全不需要。明确只装你用的子包：

```toml
# pyproject.toml
[project]
dependencies = [
    "fastapi>=0.115",
    "uvicorn[standard]>=0.30",
    "langchain-core>=0.3",
    "langchain-openai>=0.2",
    "langgraph>=0.2",
    "langgraph-checkpoint-postgres>=2.0",
    "asyncpg>=0.30",
    "pydantic>=2.9",
    "httpx>=0.27",
    "tenacity>=9.0",
    "structlog>=24.0",
]
```

## 6. 构建：本地 vs CI

### 6.1 本地

```bash
# 启用 BuildKit（默认已开）
DOCKER_BUILDKIT=1 docker build -t my-agent:local .

# 多架构（arm64 Mac → amd64 production）
docker buildx build \
  --platform linux/amd64 \
  --tag my-agent:dev \
  --load .
```

### 6.2 CI（GitHub Actions 片段）

```yaml
# .github/workflows/build.yml
name: build
on: { push: { branches: [main] }, pull_request: {} }

jobs:
  build:
    runs-on: ubuntu-latest
    permissions: { contents: read, packages: write }
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64
          push: ${{ github.event_name != 'pull_request' }}
          tags: |
            ghcr.io/${{ github.repository }}/agent:${{ github.sha }}
            ghcr.io/${{ github.repository }}/agent:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

`cache-from`/`cache-to` 是关键，二次构建 30 秒 vs 5 分钟。

## 7. Secrets 与运行时配置

**永远别**把 API key 写进镜像：

```dockerfile
# 错误示范
ENV OPENAI_API_KEY=sk-xxx     # 任何拿到镜像的人都能 docker history 看出来
```

正确做法：

| 方式 | 场景 |
|---|---|
| `--env-file .env`（本地） | docker run / compose |
| K8s Secret + envFrom | k8s |
| Cloud Run secret manager | Cloud Run |
| AWS Secrets Manager + sidecar | EKS |
| HashiCorp Vault Agent | 企业 |

LangChain 默认从环境变量读 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`LANGCHAIN_API_KEY`，让 secrets 落地到 env 即可。

## 8. 启动顺序与就绪信号

**坑**：Postgres 容器先起，但里面 server 还在初始化，应用连过去拒绝。Compose 用 healthcheck + `depends_on.condition`：

```yaml
depends_on:
  postgres:
    condition: service_healthy
```

K8s 上 init container 或应用代码层自带重试（用 tenacity）：

```python
from tenacity import retry, wait_exponential, stop_after_attempt

@retry(wait=wait_exponential(min=1, max=10), stop=stop_after_attempt(10))
async def connect_db():
    return await asyncpg.connect(DATABASE_URL)
```

## 9. 应用启动时长

| 阶段 | 时长 |
|---|---|
| Python interpreter 启动 | 50ms |
| Import langchain / langgraph | 1-3s（大量动态 import） |
| LLM client 初始化 | 100ms |
| Postgres checkpointer.setup() | 500ms-2s（建表） |
| 首次模型调用（warm cache） | 200ms |

总和 3-6 秒。对 k8s readinessProbe：

```yaml
readinessProbe:
  httpGet: { path: /health/ready, port: 8000 }
  initialDelaySeconds: 10
  periodSeconds: 3
```

`/health/ready` 必须在依赖（DB、Redis、LLM provider 可达性）都就绪后才返 200，否则流量过早进入会 5xx。

## 10. 镜像签名与扫描（可选但推荐）

```bash
# Trivy 扫漏洞
trivy image --severity HIGH,CRITICAL my-agent:latest

# Cosign 签名
cosign sign --yes ghcr.io/me/my-agent@sha256:...
cosign verify --certificate-identity=... ghcr.io/me/my-agent
```

CI 加一步 Trivy fail-on-HIGH，能拦下 90% 已知 CVE。

## 11. 一份生产 Dockerfile checklist

```yaml
- [ ] 多阶段构建（builder + runtime）
- [ ] 运行阶段不含 build-essential / gcc
- [ ] 非 root 用户（uid >= 1000）
- [ ] tini 或类似工具作 PID 1
- [ ] .dockerignore 完整
- [ ] cache mount（uv/pip）启用
- [ ] HEALTHCHECK 配置（与 k8s probe 区分）
- [ ] 无 secrets 进镜像（grep ENV / ARG）
- [ ] 镜像 < 1GB（应用层），> 1GB 必须解释原因
- [ ] Trivy 扫描通过（无 HIGH/CRITICAL）
- [ ] 多架构构建（mac dev + linux prod）
- [ ] 镜像 tag 包含 git SHA，便于回溯
```

## 常见坑

1. **base image 用 `latest`**——某天构建忽然失败（base 升 Python 主版本破坏依赖）。锁版本 `python:3.12.5-slim-bookworm`。
2. **没用 `.dockerignore`**——`__pycache__/`、`.venv/`、`data/` 全进 context，build 慢得要死且镜像膨胀。
3. **`COPY . .` 在装依赖前**——任何代码改动都触发依赖重装。正确顺序：先拷 `pyproject.toml`/`uv.lock` 装依赖，再拷代码。
4. **运行时还带 gcc/git**——攻击面大、镜像大。多阶段就是为了这个。
5. **不装 `tini`**——容器收到 SIGTERM 不优雅，k8s 强杀，正在跑的 LLM 请求被切断。
6. **uvicorn 不加 `--proxy-headers`**——拿到的 client IP 是 ingress 内网 IP，限流 / 日志全乱。
7. **CMD 用 shell 形式（不带数组）**——`tini` 没接管信号，PID 1 还是 shell。用 exec 形式 `["uvicorn", ...]`。
8. **HEALTHCHECK 用 `/health` 又依赖 DB**——DB 抖一下整个容器被判挂、重启风暴。用两个端点：`/health/live`（只查进程）和 `/health/ready`（查依赖）。
9. **本地 docker 用 amd64 base + arm Mac**——run 起来奇慢（QEMU），开发体验差。本地用 native，CI 用 buildx 编 amd64。

## 下一步

- 推到 K8s → [03 · Kubernetes 模式](./03-kubernetes.md)
- 走 Serverless 不需要 Dockerfile 也行（但很多平台需要） → [04 · Serverless 路径](./04-serverless.md)
- 流式服务额外注意点 → [06 · 流式服务部署](./06-streaming.md)
- CI/CD 中如何打镜像并推 registry → [10 · CI/CD 与版本灰度](./10-cicd.md)
- 模型镜像（vLLM）打包是另一套，节点要 GPU base image → [../llm-inference/03-vllm.md](../llm-inference/03-vllm.md)
- 镜像安全扫描深入 → [../llm-security/](../llm-security/)
