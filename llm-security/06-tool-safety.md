# 06 · 工具调用安全

> Agent 给 LLM 装上了"手脚"。手脚干的事被自然语言驱动 → **工具是注入打到现实世界的那道门**。
>
> 本章是 [../agents/04-tool-use.md#6-安全工具是攻击面](../agents/04-tool-use.md) 的深化版：那里讲设计原则，这里讲攻防细节。

## 1. 与既有内容的关系

| 既有内容 | 覆盖范围 | 本章补充 |
| --- | --- | --- |
| [../agents/04-tool-use.md](../agents/04-tool-use.md) | 工具设计、schema、错误处理 | 工具的攻击面与具体防御 |
| [../agents/10-production.md](../agents/10-production.md) | 生产关卡 | 安全工具关卡的实现细节 |
| [../langgraph/07-human-in-the-loop.md](../langgraph/07-human-in-the-loop.md) | HITL 机制 | 必引：副作用工具强制 HITL |
| 本章 | — | 信任分级、最小权限、沙箱、审计、案例 |

## 2. 工具的信任层级分类

不是所有工具风险一样。**按"被滥用后的影响"分级**，对每级有差异化防护：

| 层级 | 描述 | 例子 | 必备防护 |
| --- | --- | --- | --- |
| **L0 — 只读公开** | 不影响任何状态，公开数据 | 查天气、搜索新闻 | rate limit |
| **L1 — 只读私有** | 读敏感数据但不写 | 查订单、读邮件 | rate limit + 鉴权 + 审计 |
| **L2 — 内部副作用** | 改内部状态 | 标记已读、更新偏好 | + 幂等 + 上限 |
| **L3 — 外部副作用** | 影响外部世界 | 发邮件、调 API | + HITL（首次） |
| **L4 — 不可逆 / 高代价** | 钱、删除、群发 | 退款、注销、群发邮件 | + HITL（每次）+ 二次确认 + 上限 |
| **L5 — 任意代码执行** | 完全开放 | code interpreter、shell | + 沙箱 + 网络隔离 + 资源上限 |

> **规则**：每个工具 PR 必须标注层级，没有层级就不能上线。

## 3. 最小权限工具设计

| 反例 | 正例 |
| --- | --- |
| `query_db(sql)` | `query_orders(user_id, date_range)` |
| `send_email(to, body)` | `send_order_confirmation(order_id)` |
| `update_user(user_id, **fields)` | `update_user_preference(user_id, pref_key, pref_value)` |
| `read_file(path)` | `read_kb_article(article_id)` |
| `http_get(url)` | `lookup_partner_status(partner_id)` |

### 设计原则

1. **不暴露通用接口**：不要给 LLM "万能 SQL"、"万能 HTTP"
2. **参数有 enum / 范围**：amount 必须 0-1000，不能任意值
3. **隐式参数从 context 注入**：userId / tenantId 不该由 LLM 提供
4. **工具粒度 = 业务动作**：不是 CRUD，是"批准请假"、"退款"
5. **错误信息不泄漏内部**：Stack trace、SQL 错误信息不能直接给 LLM

```python
# 反例：危险的通用工具
def query_database(sql: str) -> list:
    return db.execute(sql)

# 正例：业务粒度 + 参数约束 + 隐式注入
def get_user_orders(
    days_back: int,  # LLM 提供
    *,
    user_id: str,    # 应用注入，LLM 看不到 / 改不了
) -> list:
    if not 1 <= days_back <= 90:
        raise ValueError("days_back must be 1-90")
    return db.query(
        "SELECT * FROM orders WHERE user_id = %s AND created_at > NOW() - INTERVAL %s DAY",
        (user_id, days_back),
    )
```

## 4. 隐式参数：分清"LLM 提供"和"应用注入"

```python
# 把 LLM-facing schema 和 application-injected params 分开
LLM_SCHEMA = {
    "name": "issue_refund",
    "input_schema": {
        "type": "object",
        "properties": {
            "order_id": {"type": "string", "pattern": "^ORD-[0-9]+$"},
            "amount_cents": {"type": "integer", "minimum": 1, "maximum": 100_000},
            "reason": {"type": "string", "maxLength": 200},
        },
        "required": ["order_id", "amount_cents", "reason"],
    },
}


def issue_refund_impl(
    # LLM 提供（schema 暴露）
    order_id: str,
    amount_cents: int,
    reason: str,
    *,
    # 应用注入（LLM 看不到）
    actor_user_id: str,
    tenant_id: str,
    request_id: str,  # idempotency key
):
    # 1. 业务校验
    order = orders.get(order_id, tenant_id=tenant_id)
    if order.user_id != actor_user_id and not is_csr(actor_user_id):
        raise PermissionError("not your order")
    
    if amount_cents > order.amount_cents:
        raise ValueError("refund > order")
    
    # 2. 幂等
    if refunds.exists(request_id=request_id):
        return refunds.get(request_id=request_id)
    
    # 3. HITL（金额超过阈值）
    if amount_cents > 50_00:  # 超 $50 必须人工
        ticket = hitl.create_pending(
            action="refund",
            payload={"order_id": order_id, "amount_cents": amount_cents, "reason": reason},
            requested_by_agent=True,
        )
        return {"status": "pending_review", "ticket_id": ticket.id}
    
    # 4. 执行
    refund = payment.refund(order, amount_cents, request_id=request_id)
    audit.log("refund", actor_user_id, order_id=order_id, amount_cents=amount_cents)
    return {"status": "completed", "refund_id": refund.id}
```

## 5. HITL 强制（重点）

详细 HITL 机制见 [../langgraph/07-human-in-the-loop.md](../langgraph/07-human-in-the-loop.md)。本章只补充"哪些工具必须 HITL"：

| 工具 | HITL 触发 | 例外 |
| --- | --- | --- |
| `send_email`（外部） | 必须，每次 | 已绑定客户邮箱的模板邮件 |
| `issue_refund` | 金额 > $X 或频率异常 | 小额 + 客户邮箱匹配 |
| `delete_*` | 必须 | 永远不该没有 HITL |
| `transfer_*`（资金） | 必须 | 永远不该没有 HITL |
| `post_to_social` | 必须 | 内部测试环境 |
| `execute_code`（生产） | 必须 | 沙箱内只读分析 |
| `query_*`（敏感） | 频率异常时 | 通常不需 HITL |

> 永远不要相信"模型说要做"——重要操作必须**用户当面点确认**。Confirm 按钮要展示**完整 payload**，不能只写"是否同意？"。

## 6. 副作用工具的幂等性

LLM 有重试 / 工具失败回放 / 多 Agent 复制等场景，**任何副作用工具都必须幂等**：

```python
def idempotent_decorator(get_key):
    def wrap(fn):
        def inner(*args, **kwargs):
            key = get_key(*args, **kwargs)
            if cached := idem_store.get(key):
                return cached
            result = fn(*args, **kwargs)
            idem_store.set(key, result, ttl=86400)
            return result
        return inner
    return wrap


@idempotent_decorator(lambda *_, request_id, **__: f"refund:{request_id}")
def issue_refund(order_id, amount_cents, *, request_id):
    return payment.refund(order_id, amount_cents)
```

`request_id` 由应用层生成（每个 LLM 调用一个），LLM 永远拿不到也改不了。

## 7. 沙箱执行：代码 / Shell 工具

| 沙箱 | 强度 | 延迟 | 成本 | 适用 |
| --- | --- | --- | --- | --- |
| E2B | 强（独立 firecracker VM） | < 1s 启动 | 中 | 通用代码 |
| Modal | 强 | 几秒 | 中 | Python 任务 |
| Daytona | 中 | 中 | 低 | 开发环境 |
| Docker | 弱-中 | 快（容器复用） | 低 | 自托管 |
| Pyodide (browser) | 中 | 即时 | 零 | 浏览器内 |
| `exec()` 同进程 | **零** | 即时 | 零 | **永远不要** |

### Docker 沙箱最小配置

```python
import docker

def run_in_sandbox(code: str, timeout: int = 30) -> dict:
    client = docker.from_env()
    try:
        container = client.containers.run(
            image="python:3.11-slim",
            command=["python", "-c", code],
            detach=True,
            # 资源限制
            mem_limit="256m",
            cpu_quota=50000,  # 50% of one CPU
            pids_limit=50,
            # 网络隔离
            network_mode="none",  # 完全无网
            # 文件系统
            read_only=True,
            tmpfs={"/tmp": "size=64m"},
            # 安全
            security_opt=["no-new-privileges"],
            cap_drop=["ALL"],
            user="65534:65534",  # nobody
        )
        try:
            container.wait(timeout=timeout)
            return {
                "stdout": container.logs(stdout=True, stderr=False).decode(),
                "stderr": container.logs(stdout=False, stderr=True).decode(),
            }
        finally:
            container.remove(force=True)
    except docker.errors.ContainerError as e:
        return {"error": str(e)}
```

> 即使有沙箱，也不要让 LLM 输出**直接进数据库**。代码执行结果必须再过一层结构化校验。

## 8. 审计日志

每个工具调用必须落审计日志，至少包含：

| 字段 | 例子 |
| --- | --- |
| trace_id | "tr_abc123" |
| user_id | "u_42" |
| tenant_id | "t_acme" |
| tool_name | "issue_refund" |
| arguments | {...}（脱敏后） |
| result | "success" / err |
| duration_ms | 234 |
| model | "claude-opus-4-5" |
| reasoning_excerpt | LLM 调用前的 thinking（如有） |
| hitl_required | true |
| hitl_approved_by | "csr_007" |
| timestamp | ISO8601 |

落到 append-only 存储（如 immutable S3 / SIEM），**应用层无权删**。SOC 2 / 金融监管要求。

## 9. 真实事故案例

| 时间 | 案例 | 原因 |
| --- | --- | --- |
| 2023 | Air Canada chatbot 给虚假退款政策 → 法庭判赔 | 工具产生具有法律效力的承诺，没 HITL |
| 2024 | DPD chatbot 骂客户 + 写诗黑公司 | 没输出过滤、没主题白名单 |
| 2024 | Replicate 客户的 RAG bot 被注入泄漏 system prompt | 工具结果未净化 |
| 2024 | Gemini "Bard for Workspace" 泄漏内部文档 | 多租户隔离 bug |
| 2024 | Devin / 早期 coding agent 删错文件 | 代码执行无沙箱 + 无 HITL |

共同模式：**工具权限过大 + 没 HITL + 输出未审核**。

## 10. 一段 Python：工具安全装饰器

```python
"""
统一的工具安全包装：审计 + 速率 + HITL 触发 + 幂等。
所有 L2+ 工具都套这个装饰器。
"""
from dataclasses import dataclass
from functools import wraps
import time
import uuid

@dataclass
class ToolPolicy:
    name: str
    level: str  # L0..L5
    rate_limit_per_min: int = 60
    requires_hitl: bool = False
    hitl_threshold: dict | None = None  # 比如 {"amount_cents": 5000}
    idempotent_key: callable | None = None  # 从 args 构造 key
    audit: bool = True


def secure_tool(policy: ToolPolicy):
    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, actor_user_id: str, tenant_id: str, request_id: str = None, **kwargs):
            request_id = request_id or str(uuid.uuid4())
            t0 = time.time()
            
            # 1. 速率
            if not rate_limiter.allow(f"tool:{policy.name}:{actor_user_id}", policy.rate_limit_per_min):
                raise RateLimitExceeded(policy.name)
            
            # 2. 幂等
            if policy.idempotent_key:
                key = policy.idempotent_key(*args, **kwargs)
                if cached := idem_store.get(f"{policy.name}:{key}"):
                    return cached
            
            # 3. HITL
            if policy.requires_hitl or _hitl_threshold_hit(policy, kwargs):
                ticket = hitl.create(policy.name, args, kwargs, actor_user_id)
                _audit("hitl_pending", policy, args, kwargs, actor_user_id, request_id)
                return {"status": "pending_review", "ticket_id": ticket.id}
            
            # 4. 执行
            try:
                result = fn(*args, actor_user_id=actor_user_id, tenant_id=tenant_id, **kwargs)
                _audit("success", policy, args, kwargs, actor_user_id, request_id, result, t0)
                if policy.idempotent_key:
                    idem_store.set(f"{policy.name}:{key}", result, ttl=86400)
                return result
            except Exception as e:
                _audit("error", policy, args, kwargs, actor_user_id, request_id, error=str(e), t0=t0)
                raise
        return wrapper
    return decorator


def _hitl_threshold_hit(policy, kwargs):
    if not policy.hitl_threshold:
        return False
    return any(kwargs.get(k, 0) > v for k, v in policy.hitl_threshold.items())


def _audit(*args, **kwargs):
    audit_logger.append({"args": args, "kwargs": kwargs, "ts": time.time()})


# 用法
@secure_tool(ToolPolicy(
    name="issue_refund",
    level="L4",
    rate_limit_per_min=10,
    hitl_threshold={"amount_cents": 5000},
    idempotent_key=lambda *_, request_id, **__: request_id,
))
def issue_refund(order_id, amount_cents, *, actor_user_id, tenant_id):
    return payment.refund(order_id, amount_cents)
```

## 11. 工具安全 PR Checklist

每加 / 改一个工具，都要回答：

- [ ] 信任层级（L0-L5）是什么？
- [ ] 谁能调用？（鉴权）
- [ ] 错误信息会不会泄漏内部？
- [ ] 参数是否最小化（无万能 SQL/HTTP）？
- [ ] userId / tenantId 是隐式注入还是 LLM 提供？
- [ ] 是否需要 HITL？阈值是什么？
- [ ] 是否幂等？key 是什么？
- [ ] rate limit 是多少？
- [ ] 审计日志记什么？
- [ ] 红队测试用例是什么？
- [ ] 失败 / 超时怎么处理？
- [ ] 工具结果是否要 sanitize 后再返回 LLM？

## 常见坑

1. **暴露通用 SQL / HTTP 工具**：图省事，结果给攻击者一个完整执行环境。坚决不开。
2. **userId 由 LLM 提供**：注入诱导 LLM 传别人 userId，跨用户操作。永远从 session 注入。
3. **工具错误吐 stack trace 给 LLM**：LLM 把 trace 写进回复 → 用户看到内部代码结构。统一包装错误。
4. **HITL 但不展示 payload**：用户点了 confirm 但不知道在批准什么。UI 必须展示完整动作。
5. **没幂等就重试**：网络抖动重试一次发了 2 封邮件 / 退了 2 次款。所有 L2+ 工具必须幂等。
6. **沙箱以为 docker 默认就安全**：Docker 默认网络可达内网、文件系统可写、可 mount socket。必须显式锁死（[§7](#7-沙箱执行代码--shell-工具)）。
7. **审计日志可被应用删**：被注入诱导 LLM 调"清空日志"工具。审计必须 append-only + 物理隔离。

## 下一步

- [../agents/04-tool-use.md](../agents/04-tool-use.md) — 工具基础
- [../langgraph/07-human-in-the-loop.md](../langgraph/07-human-in-the-loop.md) — HITL 编排
- [07 · 多 Agent 安全](./07-multi-agent-safety.md) — 多 Agent 间工具传染
- [02 · Prompt 注入](./02-prompt-injection.md) — 注入到工具的纵深
