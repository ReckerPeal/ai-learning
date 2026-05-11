# 10 · CI/CD 与版本灰度

LLM 应用的 CI/CD 与普通 web 服务**多了一层"prompt / 模型也是部署对象"**——改一句 system prompt 等同于改代码，要走流水线、过 eval、灰度上线、能回滚。

本章给 GitHub Actions + ArgoCD（或 Argo Rollouts）的完整流水线模板，重点讲**蓝绿 / 金丝雀、prompt 与模型版本一起灰度**的真实流程。

## 1. CI/CD 的层次

| 流水线 | 触发 | 内容 |
|---|---|---|
| **PR check** | PR 提交 | lint / type / unit test / eval（短） |
| **Build** | merge to main | 打镜像 / 推 registry |
| **Deploy staging** | build 成功 | 自动 deploy 到 staging |
| **E2E + eval** | staging 部署完 | 端到端测试 + 完整 eval suite |
| **Deploy prod** | 手工 approve / 定时 | 金丝雀 5% → 25% → 100% |
| **Rollback** | 告警 / 手工 | 回到上一个绿版本 |

## 2. PR Pipeline（GitHub Actions）

```yaml
# .github/workflows/pr.yml
name: pr-check
on:
  pull_request:
    branches: [main]

jobs:
  lint-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v3
      - run: uv sync --frozen
      - run: uv run ruff check .
      - run: uv run mypy app/
      - run: uv run pytest -x --cov=app --cov-fail-under=70

  eval-quick:
    runs-on: ubuntu-latest
    needs: lint-test
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v3
      - run: uv sync --frozen
      - name: Run eval (small, deterministic seed)
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY_CI }}
          LANGCHAIN_API_KEY: ${{ secrets.LANGCHAIN_API_KEY }}
        run: |
          uv run python -m eval.run \
            --dataset eval/datasets/pr-smoke.jsonl \
            --model gpt-4o-mini \
            --max-samples 30 \
            --baseline eval/baselines/main.json \
            --fail-on-regression 0.05

  build:
    runs-on: ubuntu-latest
    needs: lint-test
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64
          push: false                  # PR 只构建不推
          cache-from: type=gha
          cache-to: type=gha,mode=max
          tags: agent:pr-${{ github.event.pull_request.number }}
```

**关键点**：

| 步骤 | LLM 应用特殊 |
|---|---|
| eval-quick | PR 上跑小规模 eval（30-100 sample），fail-on-regression 比 baseline 退步 > 5% 阻断 |
| 用 `gpt-4o-mini` | CI 别烧 `gpt-4o`，成本控制 |
| 跑前导入 baseline | eval 结果必须对照历史，而非绝对分数 |

## 3. Main Pipeline（merge 后）

```yaml
# .github/workflows/main.yml
name: main
on:
  push:
    branches: [main]

jobs:
  build-push:
    runs-on: ubuntu-latest
    permissions: { contents: read, packages: write, id-token: write }
    outputs:
      image: ${{ steps.build.outputs.image }}
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/setup-buildx-action@v3
      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository }}/agent
          tags: |
            type=raw,value=latest
            type=sha,prefix=sha-
            type=raw,value=${{ github.run_number }}
      - id: build
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Sign image
        uses: sigstore/cosign-installer@v3
      - run: cosign sign --yes ghcr.io/${{ github.repository }}/agent@${{ steps.build.outputs.digest }}

  deploy-staging:
    needs: build-push
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@v4
      - name: Update kustomize image tag
        run: |
          cd k8s/overlays/staging
          kustomize edit set image agent=ghcr.io/${{ github.repository }}/agent:sha-${{ github.sha }}
          git config user.email "ci@example.com"
          git config user.name "CI"
          git commit -am "ci: bump staging to ${{ github.sha }}"
          git push

  eval-full:
    needs: deploy-staging
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Wait for staging healthy
        run: |
          for i in {1..30}; do
            if curl -fs https://staging.example.com/health/ready; then exit 0; fi
            sleep 10
          done
          exit 1
      - name: Run full eval suite
        run: |
          uv run python -m eval.run \
            --target https://staging.example.com \
            --dataset eval/datasets/full.jsonl \
            --max-samples 500 \
            --baseline eval/baselines/prod.json \
            --report eval-report.html
      - uses: actions/upload-artifact@v4
        with: { name: eval-report, path: eval-report.html }

  promote-prod:
    needs: eval-full
    runs-on: ubuntu-latest
    environment: production           # 需要 reviewer approve
    steps:
      - uses: actions/checkout@v4
      - name: Update prod overlay
        run: |
          cd k8s/overlays/prod
          kustomize edit set image agent=ghcr.io/${{ github.repository }}/agent:sha-${{ github.sha }}
          git commit -am "deploy: prod ${{ github.sha }}"
          git push
```

`environment: production` 让 GitHub Actions 卡在 manual approval。这是**最朴素的金丝雀前置门禁**。

## 4. GitOps：ArgoCD 自动同步

应用代码改了 → Helm/kustomize 配置改了 → ArgoCD 检测到 → 自动同步到 k8s。

```yaml
# argocd/agent-prod.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: agent-prod
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/me/agent
    targetRevision: main
    path: k8s/overlays/prod
  destination:
    server: https://kubernetes.default.svc
    namespace: agent
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    retry:
      limit: 3
      backoff: { duration: 30s, maxDuration: 5m }
```

CI 只改 git，不直接 kubectl。

## 5. 金丝雀发布（Argo Rollouts）

K8s 原生 Deployment 只支持滚动升级，**没有"流量按权重切"**。要用 Argo Rollouts：

```yaml
# k8s/rollout.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata: { name: agent-api }
spec:
  replicas: 10
  strategy:
    canary:
      canaryService: agent-api-canary
      stableService: agent-api-stable
      trafficRouting:
        nginx:
          stableIngress: agent-api
      steps:
        - setWeight: 5
        - pause: { duration: 10m }       # 观察 10 分钟
        - setWeight: 25
        - pause: { duration: 20m }
        - setWeight: 50
        - pause: { duration: 30m }
        - setWeight: 100
      analysis:
        templates:
          - templateName: success-rate
          - templateName: ttft-p95
        startingStep: 1                  # canary 第一步后开始 analysis
  selector: { matchLabels: { app: agent-api } }
  template:
    # ... 同 Deployment template
```

```yaml
# k8s/analysis-template.yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata: { name: success-rate }
spec:
  metrics:
    - name: success-rate
      interval: 1m
      successCondition: result >= 0.98
      failureLimit: 3
      provider:
        prometheus:
          address: http://prometheus:9090
          query: |
            sum(rate(http_requests_total{app="agent-api-canary", status!~"5.."}[2m]))
            /
            sum(rate(http_requests_total{app="agent-api-canary"}[2m]))
```

Argo Rollouts 在 canary 阶段持续查询 Prometheus，**指标不达标自动回滚**。

## 6. 蓝绿 vs 金丝雀

| 策略 | 适合 | 不适合 |
|---|---|---|
| **蓝绿** | 数据库 schema 变更、不可分割的大改 | 想小流量验证（蓝绿是 0% → 100%） |
| **金丝雀** | 增量改动、新模型 / prompt | 数据库不兼容变更 |
| **滚动** | 兼容小改 | 流式服务（连接重置） |

LLM 应用的 prompt 调整、模型升级 → **金丝雀**最合适。

## 7. Prompt 与模型版本灰度

这是 LLM 部署的"独家"内容。Prompt 改一句话，行为可能差很远，**像代码一样灰度**。

### 7.1 把 prompt 当代码

```python
# app/prompts/v1.py
SYSTEM_PROMPT = """你是企业知识库助手……"""

# app/prompts/v2.py
SYSTEM_PROMPT = """你是企业知识库助手（v2 改写：更简洁，更专业）……"""

# app/config.py
PROMPT_VERSION = os.environ.get("PROMPT_VERSION", "v1")

from importlib import import_module
prompts = import_module(f"app.prompts.{PROMPT_VERSION}")
```

部署时通过 env var / ConfigMap 切版本，**和镜像 tag 同等地位**。

### 7.2 prompt 版本管理工具

| 工具 | 特点 |
|---|---|
| **LangSmith Prompts** | git-like，可 release / fetch by name |
| **Langfuse Prompts** | 类似，OSS |
| **PromptLayer** | 商业 |
| **自家 git** | 简单，所有版本在 code |

LangSmith 示例：

```python
from langsmith import Client
client = Client()

# 部署时拉一次
prompt = client.pull_prompt("knowledge-assistant", include_model=False)
SYSTEM = prompt.format()
```

Prompt 版本变更 → 自动触发 deployment？**慎重**——prompt 改完一定要过 eval。

### 7.3 模型与 prompt 联合灰度

真实例子：同时改 prompt 从 v1 到 v2，**且**模型从 gpt-4o-mini 升到 gpt-4o：

```python
# 联合版本
EXPERIMENT_VARIANTS = {
    "control":   { "prompt": "v1", "model": "gpt-4o-mini" },
    "treatment": { "prompt": "v2", "model": "gpt-4o" },
}

async def chat_with_variant(messages, user_id):
    variant = bucket(user_id, weights={"control": 95, "treatment": 5})
    cfg = EXPERIMENT_VARIANTS[variant]
    EXPERIMENT_BUCKET.labels(variant).inc()
    return await chat(messages, prompt_version=cfg["prompt"], model=cfg["model"])

def bucket(user_id, weights):
    """一致性哈希分桶。"""
    h = int(hashlib.md5(user_id.encode()).hexdigest(), 16)
    pct = h % 100
    cum = 0
    for name, w in weights.items():
        cum += w
        if pct < cum: return name
```

监控 dashboard：

```
control vs treatment：
- 错误率
- TTFT
- 用户满意（thumbs up/down）
- 完成率（任务真正解决）
- token cost / req
```

**任一指标 treatment 退步 → 立即停灰度**。

## 8. eval 进 CI/CD：门禁怎么设

eval 不是"跑跑看分数"，而是**像单元测试一样卡 PR**：

```yaml
# eval/gate.py 思路
baseline = load_json("baselines/main.json")
results = run_eval(...)

for metric, baseline_value in baseline.items():
    new_value = results[metric]
    if new_value < baseline_value - TOLERANCE[metric]:
        print(f"REGRESSION: {metric} {baseline_value} -> {new_value}")
        sys.exit(1)
```

`TOLERANCE` 按指标定：

| 指标 | 容忍 |
|---|---|
| accuracy | -1% |
| latency p95 | +200ms |
| cost / req | +10% |
| safety violation | 0%（任何退步都阻断） |

详见 [../eval/](../eval/)。

## 9. Secrets 在 CI/CD

| 用途 | 存哪里 |
|---|---|
| CI 用的 LLM API key | GitHub Actions secrets |
| 生产 LLM API key | External Secrets + AWS Secrets Manager / Vault |
| 仓库 deploy token | OIDC（GitHub → AWS / GCP federated identity） |
| 镜像签名 key | Cosign + Sigstore（keyless） |

**关键**：GitHub Actions OIDC → 云 IAM 无需长期 key：

```yaml
permissions: { id-token: write }
steps:
  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: arn:aws:iam::123456789:role/ci-deployer
      aws-region: us-east-1
```

## 10. 回滚

```bash
# Argo Rollouts 一键
kubectl argo rollouts abort agent-api
kubectl argo rollouts undo agent-api

# 或回到指定 revision
kubectl argo rollouts undo agent-api --to-revision=42
```

GitOps 路径：

```bash
# git revert 上一次的镜像 tag bump
git revert <commit>
git push
# ArgoCD 自动同步回去
```

**回滚不只是镜像**——prompt、模型、feature flag 都要能回。每个版本对象有 git 提交。

## 11. Feature Flag：比代码部署更细的灰度

某些功能（如新工具、新 RAG retriever）适合 feature flag 控制：

```python
from launchdarkly import LDClient

ld = LDClient(...)

def chat(messages, user_id):
    use_new_retriever = ld.variation("new-rag-retriever", {"key": user_id}, False)
    retriever = NewRetriever() if use_new_retriever else OldRetriever()
    ...
```

OSS 选型：[Unleash](https://www.getunleash.io/)、[Flagsmith](https://www.flagsmith.com/)、[GrowthBook](https://www.growthbook.io/)。

## 12. 完整 CI/CD checklist

```yaml
pr_check:
  - [ ] lint + type + unit test
  - [ ] eval-quick（小样本 + baseline 比对）
  - [ ] 镜像构建（不推）

main:
  - [ ] 镜像构建并推
  - [ ] 镜像签名（cosign）
  - [ ] 漏洞扫描（trivy）

staging:
  - [ ] GitOps 自动同步
  - [ ] 健康检查通过
  - [ ] eval-full 通过
  - [ ] e2e smoke 通过

prod:
  - [ ] manual approval（高风险）
  - [ ] 金丝雀（5%/25%/50%/100%）
  - [ ] Argo Rollouts analysis 自动监控
  - [ ] 任一指标退步自动回滚
  - [ ] runbook 写好回滚步骤

versioning:
  - [ ] 镜像 tag = git SHA
  - [ ] prompt 版本管理（LangSmith / Langfuse / git）
  - [ ] config 版本管理（ConfigMap + Reloader）
  - [ ] 全部进 git，能回到任意时间点

observability:
  - [ ] 部署事件入 trace / log（带 commit）
  - [ ] Grafana annotation 标记每次部署
  - [ ] 灰度期 dashboard 实时对比
```

## 13. 一个真实灰度时间表

新 prompt + 新模型组合上线：

```
Day 0:  PR 通过，merge to main
Day 0:  staging 自动部署，full eval 通过（+2% accuracy, +5% cost）
Day 0:  manual approve → prod canary 5%
Day 0+10min:  自动 analysis → 错误率正常 → 继续
Day 0+30min:  扩到 25%
Day 0+1h:     扩到 50%
Day 0+2h:     扩到 100% → 灰度完成
Day 1:  全量监控，对比前后 24h 指标
Day 7:  确认稳定，关老版本（删 prompt v1）
```

任何阶段告警 → Argo Rollouts 自动回滚 → 5 分钟内恢复。

## 常见坑

1. **eval 不跑 baseline 比对**——只看绝对分数（"acc 80%"），但上次 85%，没人察觉退步。一定要 fail-on-regression。
2. **prompt 改了直接 push 到 prod**——绕过 PR / eval，prompt 当文档不当代码，事故来源。Prompt 改动必须走 PR + eval。
3. **滚动升级流式服务**——升级时长连接被切，用户中途断。要 canary + `maxUnavailable: 0`。
4. **canary 没 analysis 自动判断**——人盯 dashboard 几小时就看不下去了，后面就放任。analysis template 强制自动判断。
5. **回滚演练没做**——真要回滚时发现 ArgoCD 卡住、image 已被清理。每月演练一次。
6. **多版本并存数据不兼容**——v1 写 state schema A，v2 读 schema B 报错。schema 变更要兼容双向（migration 思路）。
7. **金丝雀路由用 user_id hash**——同一用户跨设备落不同桶，体验不一致。用 user_id 或 session_id 哈希，**保持稳定**。
8. **prod 没有 manual approval**——CI 自动一路推到 prod，半夜事故。高风险变更必须人工 approve。
9. **Secrets 在 PR runner 上能看到**——fork 仓库的 PR 不要给 secrets，用 `pull_request_target` 时小心。
10. **没标记部署事件**——事故复盘时找不到"是哪次部署引入的"。Grafana annotation 每次 deploy 打一个。

## 下一步

- 部署后看监控对比 → [07 · 监控与指标](./07-monitoring.md)
- 通过 trace 验证灰度效果 → [08 · 日志与 Trace](./08-logging-tracing.md)
- 灰度失败时自动降级 → [09 · 容灾与降级](./09-disaster-recovery.md)
- 模型层灰度（vLLM 双池）→ [../llm-inference/09-architecture.md](../llm-inference/09-architecture.md)
- eval 流水线设计 → [../eval/](../eval/)
- prompt 版本管理 → [../prompt-engineering/](../prompt-engineering/)
- Argo Rollouts → <https://argo-rollouts.readthedocs.io/>
- LaunchDarkly / Unleash → <https://www.getunleash.io/>
- GitOps with ArgoCD → <https://argo-cd.readthedocs.io/>
