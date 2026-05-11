# 03 · Kubernetes 模式

K8s 是 LLM 应用规模化的事实标准。本章给**能直接复制到生产**的 Deployment / Service / Ingress / HPA / Helm 模板，并把 LLM 场景的特殊配置（GPU node pool、长连接、流式、sidecar）讲清楚。

如果你还在评估要不要上 K8s，先看 [01 · 部署形态总览](./01-overview.md)。如果你部署的是 vLLM 模型层，本章 GPU 节点部分有用，但模型层的副本调度细节看 [../llm-inference/09-architecture.md](../llm-inference/09-architecture.md)。

## 1. 资源对象速查

| 对象 | 用途 | LLM 场景注意 |
|---|---|---|
| Deployment | 应用 pod 的滚动升级 | 多副本 + 反亲和（避免单节点 SPOF） |
| StatefulSet | 有顺序的 pod | 通常 LLM 应用层无需，向量库 / Postgres 用 |
| Service | 集群内负载均衡 | `sessionAffinity: ClientIP` 用于 prefix cache |
| Ingress | 入口 | Nginx Ingress：流式 buffer 必须关 |
| HPA | 自动扩缩 | 默认 CPU 不适合 LLM，要 custom metric |
| PDB | 中断预算 | 灰度 / 节点升级时保留最少副本 |
| ConfigMap / Secret | 配置 / 密钥 | API key 必须 Secret，prompt 模板可以 ConfigMap |
| NetworkPolicy | 网络隔离 | agent 只能出公网到 OpenAI / Anthropic 的 IP |
| ServiceAccount | RBAC 主体 | 至少要 SA + 最小权限 |

## 2. Deployment 模板（应用层）

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: agent-api
  labels: { app: agent-api, tier: backend }
spec:
  replicas: 3                            # 至少 3，配合 PDB
  revisionHistoryLimit: 5
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0                  # 流式请求多，宁可超也别少
  selector:
    matchLabels: { app: agent-api }
  template:
    metadata:
      labels: { app: agent-api, tier: backend }
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8000"
        prometheus.io/path: "/metrics"
    spec:
      serviceAccountName: agent-api
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        fsGroup: 10001
        seccompProfile: { type: RuntimeDefault }
      terminationGracePeriodSeconds: 60  # 让正在流式的请求跑完
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels: { app: agent-api }
      affinity:
        podAntiAffinity:                 # 避免多副本扎堆同节点
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchLabels: { app: agent-api }
                topologyKey: kubernetes.io/hostname
      containers:
        - name: app
          image: ghcr.io/me/agent:1.4.2
          imagePullPolicy: IfNotPresent
          ports:
            - { name: http, containerPort: 8000 }
            - { name: metrics, containerPort: 8000 }
          env:
            - name: DATABASE_URL
              valueFrom: { secretKeyRef: { name: agent-secrets, key: db_url } }
            - name: OPENAI_API_KEY
              valueFrom: { secretKeyRef: { name: agent-secrets, key: openai_key } }
            - name: LANGCHAIN_PROJECT
              value: "prod"
            - name: POD_NAME
              valueFrom: { fieldRef: { fieldPath: metadata.name } }
          envFrom:
            - configMapRef: { name: agent-config }
          resources:
            requests: { cpu: "500m", memory: "1Gi" }
            limits:   { cpu: "2",    memory: "2Gi" }
          startupProbe:                  # 慢启动用 startup，避免 liveness 误杀
            httpGet: { path: /health/live, port: http }
            failureThreshold: 30
            periodSeconds: 2
          livenessProbe:
            httpGet: { path: /health/live, port: http }
            periodSeconds: 10
            timeoutSeconds: 3
            failureThreshold: 3
          readinessProbe:
            httpGet: { path: /health/ready, port: http }
            periodSeconds: 3
            timeoutSeconds: 2
            failureThreshold: 2
          lifecycle:
            preStop:                     # 优雅下线：先摘流量再让进程退出
              exec:
                command: ["sh", "-c", "sleep 10"]
```

**LLM 场景关键点**：

| 配置 | 原因 |
|---|---|
| `terminationGracePeriodSeconds: 60` | 流式请求可能跑 30s+，默认 30 太短 |
| `preStop sleep 10` | Service endpoint 摘除有几秒延迟，避免新流量打到要退的 pod |
| `maxUnavailable: 0` | 流式服务，宁可短暂超容也别少副本 |
| 三种 probe 分开 | startup 给慢启动留余地，liveness/readiness 分职责 |
| `automountServiceAccountToken: false` | 应用层不需要 K8s API token，少一个攻击面 |

## 3. Service 与 Ingress（流式必备配置）

```yaml
# k8s/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: agent-api
spec:
  type: ClusterIP
  selector: { app: agent-api }
  ports:
    - name: http
      port: 80
      targetPort: http
  # sessionAffinity 默认 None。如果要 prefix cache 命中（同用户同 pod）：
  # sessionAffinity: ClientIP
  # sessionAffinityConfig: { clientIP: { timeoutSeconds: 3600 } }
---
# k8s/ingress.yaml（nginx-ingress）
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: agent-api
  annotations:
    nginx.ingress.kubernetes.io/proxy-buffering: "off"        # 流式必关
    nginx.ingress.kubernetes.io/proxy-request-buffering: "off"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "600"     # 长输出
    nginx.ingress.kubernetes.io/proxy-send-timeout: "600"
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"        # RAG context 大
    nginx.ingress.kubernetes.io/enable-cors: "true"
    nginx.ingress.kubernetes.io/cors-allow-headers: "*"
spec:
  ingressClassName: nginx
  tls:
    - hosts: [api.example.com]
      secretName: agent-tls
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service: { name: agent-api, port: { number: 80 } }
```

**最常踩**：忘记 `proxy-buffering: off`，结果客户端拿到的不是 token-by-token 流式，而是攒了一坨。Cloud 环境另外的 LB（ALB / GCLB）还有各自的 buffering 配置，全链路都要关，见 §06。

## 4. HPA：别用 CPU 指标

```yaml
# k8s/hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: agent-api }
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: agent-api
  minReplicas: 3
  maxReplicas: 30
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 30
      policies:
        - { type: Percent, value: 100, periodSeconds: 30 }   # 30s 翻倍
        - { type: Pods,    value: 4,   periodSeconds: 30 }
        - { type: Percent, value: 100, periodSeconds: 30, selectPolicy: Max }
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - { type: Percent, value: 25, periodSeconds: 60 }
  metrics:
    # LLM 应用真正的负载指标：进行中请求数
    - type: Pods
      pods:
        metric: { name: inflight_requests }
        target: { type: AverageValue, averageValue: "8" }
    # 兜底：CPU 真的飙了也扩
    - type: Resource
      resource:
        name: cpu
        target: { type: Utilization, averageUtilization: 70 }
```

`inflight_requests` 通过 [prometheus-adapter](https://github.com/kubernetes-sigs/prometheus-adapter) 暴露成 custom metric。指标来源：应用代码用 `prometheus_client` 暴露当前正在处理的请求数（见 §07）。

模型层（vLLM）的 HPA 完全是另一套指标（queue_depth + KV usage），见 [../llm-inference/09](../llm-inference/09-architecture.md)。

## 5. GPU node pool（混合集群）

如果集群里既要跑应用 pod（CPU）也要跑 vLLM（GPU），要把节点池分开：

```yaml
# vLLM Deployment 片段（节选）
spec:
  template:
    spec:
      nodeSelector:
        node.kubernetes.io/instance-type: g5.12xlarge
      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule
      containers:
        - name: vllm
          image: vllm/vllm-openai:v0.6.3
          resources:
            limits:
              nvidia.com/gpu: 4
```

应用 pod 不加 toleration，自然就不会被调度到 GPU 节点。GPU 节点打 taint：

```bash
kubectl taint nodes <gpu-node> nvidia.com/gpu=true:NoSchedule
```

需要装 [NVIDIA GPU Operator](https://github.com/NVIDIA/gpu-operator) 才能让 k8s 识别 `nvidia.com/gpu` 资源。

## 6. PodDisruptionBudget 与节点升级

```yaml
# k8s/pdb.yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: agent-api }
spec:
  minAvailable: 2           # 升级时最少保留 2 个副本
  selector:
    matchLabels: { app: agent-api }
```

没 PDB，节点滚动升级时 kubectl 可能一次驱逐多个 pod，业务瞬时不可用。

## 7. Sidecar 模式

LLM 应用常见 sidecar：

| Sidecar | 用途 |
|---|---|
| **OpenTelemetry Collector** | 在 pod 内汇总 trace / metrics，避免每个进程都直连后端 |
| **Envoy / Linkerd proxy** | mTLS、可观测、流量控制 |
| **Vault Agent** | 从 Vault 拉 secrets 写到共享 volume |
| **LiteLLM Proxy** | 应用直接 `localhost:4000`，sidecar 做路由 / fallback |
| **fluent-bit** | 日志采集（若不用 stdout） |

示例：把 LiteLLM 作为 sidecar 跟应用一起跑：

```yaml
containers:
  - name: app
    image: ghcr.io/me/agent:1.4.2
    env:
      - name: OPENAI_BASE_URL
        value: http://localhost:4000/v1   # 走 sidecar
  - name: litellm
    image: ghcr.io/berriai/litellm:main-stable
    ports: [{ containerPort: 4000 }]
    volumeMounts:
      - name: litellm-config
        mountPath: /app/config.yaml
        subPath: config.yaml
    command: ["litellm", "--config", "/app/config.yaml", "--port", "4000"]
volumes:
  - name: litellm-config
    configMap: { name: litellm-config }
```

应用代码完全感知不到 fallback / 路由逻辑，配置改 ConfigMap 即可。

## 8. Helm chart 起步

生产建议用 Helm 管理 release。最小化 chart 结构：

```
charts/agent/
├── Chart.yaml
├── values.yaml
├── values-prod.yaml
└── templates/
    ├── deployment.yaml
    ├── service.yaml
    ├── ingress.yaml
    ├── hpa.yaml
    ├── pdb.yaml
    ├── configmap.yaml
    └── _helpers.tpl
```

`values.yaml` 抽出可变项：

```yaml
image:
  repository: ghcr.io/me/agent
  tag: ""        # 必须命令行覆盖
  pullPolicy: IfNotPresent

replicaCount: 3

resources:
  requests: { cpu: 500m, memory: 1Gi }
  limits:   { cpu: 2,    memory: 2Gi }

autoscaling:
  enabled: true
  minReplicas: 3
  maxReplicas: 30
  targetInflightRequests: 8

ingress:
  enabled: true
  className: nginx
  host: api.example.com
  tls: true

env:
  LANGCHAIN_PROJECT: prod
  LOG_LEVEL: INFO

secrets:
  - openai_key
  - anthropic_key
  - db_url
```

部署：

```bash
helm upgrade --install agent ./charts/agent \
  --namespace agent --create-namespace \
  -f values-prod.yaml \
  --set image.tag=$(git rev-parse --short HEAD) \
  --wait --timeout 5m
```

## 9. Secrets 管理

不要明文 `kubectl create secret`，而是：

| 方案 | 说明 |
|---|---|
| **External Secrets Operator** | 从 AWS Secrets Manager / Vault / GCP Secret Manager 同步成 K8s Secret |
| **Sealed Secrets** | 把加密后的 yaml 安全地 commit 到 git |
| **SOPS + Helm secrets** | git-ops 友好 |

External Secrets 示例：

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata: { name: agent-secrets }
spec:
  refreshInterval: 1h
  secretStoreRef: { name: aws-secretsmanager, kind: ClusterSecretStore }
  target: { name: agent-secrets, creationPolicy: Owner }
  data:
    - secretKey: openai_key
      remoteRef: { key: prod/agent, property: openai_api_key }
    - secretKey: db_url
      remoteRef: { key: prod/agent, property: database_url }
```

## 10. 监控指标暴露

`agent-api` Service 加 `prometheus.io/scrape` 注解，Prometheus 自动发现：

```python
# app/metrics.py
from prometheus_client import Counter, Histogram, Gauge

REQUESTS = Counter("agent_requests_total", "Total requests", ["status"])
LATENCY = Histogram("agent_request_seconds", "Latency", buckets=(0.1, 0.5, 1, 2, 5, 10, 30, 60, 120))
INFLIGHT = Gauge("inflight_requests", "Requests currently being processed")
TOKENS = Counter("llm_tokens_total", "LLM tokens", ["model", "kind"])
```

完整监控搭建见 §07。

## 11. NetworkPolicy（最小权限）

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: agent-api }
spec:
  podSelector: { matchLabels: { app: agent-api } }
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - namespaceSelector: { matchLabels: { name: ingress-nginx } }
      ports: [{ port: 8000 }]
  egress:
    - to:                              # DNS
        - namespaceSelector: { matchLabels: { name: kube-system } }
      ports: [{ port: 53, protocol: UDP }]
    - to:                              # 集群内 Postgres
        - podSelector: { matchLabels: { app: postgres } }
      ports: [{ port: 5432 }]
    - to:                              # 出公网（OpenAI/Anthropic）
        - ipBlock: { cidr: 0.0.0.0/0, except: [10.0.0.0/8, 172.16.0.0/12] }
      ports: [{ port: 443 }]
```

实际可以更严格：只允许特定 SaaS 的 IP 段，但这些 IP 经常变化，运维成本高，多数团队折衷只限端口 443。

## 12. 生产 K8s checklist

```yaml
deployment:
  - [ ] replicas >= 3，PDB minAvailable >= 2
  - [ ] podAntiAffinity 跨节点 / topologySpread 跨 AZ
  - [ ] non-root + readOnlyRootFilesystem（如可）
  - [ ] resources requests/limits 都设
  - [ ] startupProbe + liveness + readiness 三种分开
  - [ ] terminationGracePeriodSeconds 与最长请求时长匹配
  - [ ] preStop sleep 摘流量缓冲

ingress:
  - [ ] proxy-buffering off
  - [ ] proxy timeout 与最长请求时长匹配
  - [ ] body-size 足够（RAG context）
  - [ ] TLS + cert-manager
  - [ ] WAF（Cloudflare / AWS WAF）

autoscaling:
  - [ ] HPA 用业务指标（inflight），CPU 兜底
  - [ ] minReplicas >= 3
  - [ ] scaleDown 慢（stabilizationWindow 300s+）

security:
  - [ ] Secrets 走 External Secrets / Sealed Secrets
  - [ ] NetworkPolicy 限制出入站
  - [ ] ServiceAccount 最小权限
  - [ ] PodSecurity restricted

observability:
  - [ ] metrics 注解 + Prometheus 抓取
  - [ ] 日志 stdout，集群侧 fluent-bit 采集
  - [ ] OpenTelemetry trace 上报
```

## 常见坑

1. **`readinessProbe` 与 `livenessProbe` 用同一个端点**——liveness 不该依赖外部，否则下游抖一下整个 pod 被杀重启风暴。
2. **`terminationGracePeriodSeconds` 默认 30s 太短**——流式请求被中途切，用户体验差。设到 60-120s。
3. **HPA 用 CPU 扩 LLM app**——CPU 几乎全花在 wait（等 OpenAI 响应），CPU util 永远低，HPA 永远不扩。要用 custom metric。
4. **没设 PDB**——节点维护时 kubectl drain 一次驱逐所有副本，业务瞬时全挂。
5. **GPU pod 没 toleration，CPU pod 又没 anti-affinity**——结果 vLLM 被调度到 CPU 节点起不来，应用 pod 反而占了 GPU 节点。
6. **API key 用 `kubectl create secret` 命令行**——bash history 留下、CI 日志留下、git 历史留下。用 External Secrets。
7. **滚动升级 `maxUnavailable: 25%`**——升级时容量瞬时减少，流式请求堆积超时。设 `maxUnavailable: 0, maxSurge: 1`。
8. **Service `sessionAffinity` 用默认 None 但启用了 prefix cache**——同用户每次落不同 pod，prefix cache 命中率为 0。
9. **`ConfigMap` 改了没重启 pod**——ConfigMap 改动不会触发滚动升级。用 [stakater/Reloader](https://github.com/stakater/Reloader) 或在 annotation 里 hash。

## 下一步

- 走流式服务的 Pod 设计 → [06 · 流式服务部署](./06-streaming.md)
- 接 Prometheus / Grafana → [07 · 监控与指标](./07-monitoring.md)
- 灰度发布配 Argo Rollouts → [10 · CI/CD 与版本灰度](./10-cicd.md)
- 模型层（vLLM）的 K8s 细节 → [../llm-inference/09-architecture.md](../llm-inference/09-architecture.md)
- 应用层 secret 与权限攻防 → [../llm-security/](../llm-security/)
- KEDA（事件驱动扩缩） → <https://keda.sh/>
- Argo Rollouts → <https://argo-rollouts.readthedocs.io/>
