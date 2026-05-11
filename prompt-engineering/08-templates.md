# 08 · Prompt 模板化与版本管理

> TLDR：Prompt 不是写在代码里的字符串字面量，是**带版本、可 review、可灰度回滚的工程产物**。"在 ChatGPT 网页改一改 → 复制到代码 → push 上线"是事故源头。本章给一套 Prompt-as-Code 的最小工程化方案。

## 1. 为什么要"模板化"

把 prompt 模板化的 4 个理由：

| 理由             | 没模板化的痛                              |
| -------------- | ----------------------------------- |
| 变量注入安全         | f-string 拼接易被注入，{var} 里有 `}` 直接 KeyError |
| 复用             | 同一段 system prompt 散落在 5 个文件，改一处忘改另一处 |
| 版本管理 / 回滚      | 出 bug 想回滚 → 不知道当前哪版在跑               |
| 评测 / A/B       | 想对比 v1 vs v2 → 没法批量切换               |

## 2. 三种模板引擎对比

| 引擎              | 语法                | 优点                    | 缺点                 |
| --------------- | ----------------- | --------------------- | ------------------ |
| Python f-string | `f"hello {name}"` | 0 依赖、简单               | 不能条件 / 循环、变量名硬编码   |
| `str.format()`  | `"hello {name}"`  | 支持运行时变量、命名占位符          | 同上，无逻辑             |
| Jinja2          | `{{ name }}`      | 支持条件 / 循环 / 继承，标准选择   | 引入依赖，注意默认转义影响 prompt |
| LangChain `PromptTemplate` | `{name}` + `.format()` | 集成 LangChain 生态        | 仅在 LangChain 项目里值得 |

**推荐选型**：

```text
prompt 简单（< 5 个变量、无条件分支）→ str.format() / f-string
prompt 复杂（条件、循环、可选段）         → Jinja2
项目已用 LangChain                       → PromptTemplate
团队跨语言（Python + TS + Go）            → 自家 DSL 或共享 YAML
```

## 3. 模板写法实战

### 3.1 简单：str.format

```python
SYS_TEMPLATE = """你是 {language} 翻译助手。
将用户输入翻译为 {target_language}。
风格：{style}。"""

system = SYS_TEMPLATE.format(
    language="中文",
    target_language="英文",
    style="正式商务",
)
```

**陷阱**：用户输入里有 `{` 会触发 KeyError。所以**永远不要把用户输入塞进模板字符串**。

### 3.2 中等：Jinja2

```python
from jinja2 import Template

TPL = Template("""你是 {{ language }} 翻译助手。

{% if examples %}
参考示例：
{% for ex in examples %}
- 输入：{{ ex.src }}
- 输出：{{ ex.tgt }}
{% endfor %}
{% endif %}

风格：{{ style | default("中性") }}。
""")

system = TPL.render(
    language="中文",
    examples=[{"src": "你好", "tgt": "Hello"}],
    style="正式",
)
```

**Jinja2 在 prompt 中的注意点**：

| 注意                 | 处理                                      |
| ------------------ | --------------------------------------- |
| 默认 `autoescape` 关闭 | 对 prompt 而言 OK，不要开 HTML 转义              |
| 空白字符控制             | 用 `{%- ... -%}` 减少多余空行                  |
| 用户输入             | **不要**用 Jinja2 渲染用户输入——单独传 `messages` |

### 3.3 LangChain PromptTemplate

```python
from langchain_core.prompts import ChatPromptTemplate

prompt = ChatPromptTemplate.from_messages([
    ("system", "你是 {language} 翻译助手。"),
    ("user", "{user_text}"),
])

formatted = prompt.format_messages(language="中文", user_text="...")
```

详见 [../langchain/03-prompts-and-models.md](../langchain/03-prompts-and-models.md)（**不复述**），这里只指出："变量"和"用户输入"被分到两条 message，注入安全性高一档。

## 4. Prompt-as-Code：仓库结构

把 prompt 当代码管理：

```text
my-app/
├── src/
│   └── ...
├── prompts/                      ← 所有 prompt 集中放
│   ├── classify/
│   │   ├── v1.yaml
│   │   ├── v2.yaml               ← 当前版本
│   │   └── changelog.md
│   ├── summarize/
│   │   ├── v1.yaml
│   │   └── v2.yaml
│   └── shared/
│       ├── safety_rules.txt      ← 多 prompt 复用
│       └── persona_serious.txt
├── tests/
│   └── test_prompts.py           ← 评测集（见 §10）
└── prompt_registry.py            ← 加载 + 切版本
```

YAML 结构示例：

```yaml
# prompts/classify/v2.yaml
id: classify
version: 2
status: production
author: zzb
created: 2026-04-01
description: 客服问题三分类（logistics/refund/discount）

template: |
  你是电商客服分类助手。

  把用户问题归到下列一类：
  {{ categories | join("\n") }}

  输出 JSON: {"category": "<label>", "confidence": 0~1}

variables:
  categories:
    type: list[string]
    required: true
    description: 标签清单

eval:
  testset: tests/classify_eval.jsonl
  metrics: [accuracy, f1_macro]
  threshold: 0.85
```

## 5. Prompt Registry：运行时加载

```python
# prompt_registry.py
from pathlib import Path
import yaml
from jinja2 import Template

PROMPTS_DIR = Path(__file__).parent / "prompts"

class Prompt:
    def __init__(self, path: Path):
        data = yaml.safe_load(path.read_text())
        self.id = data["id"]
        self.version = data["version"]
        self.template = Template(data["template"])
        self.metadata = data

    def render(self, **kwargs) -> str:
        return self.template.render(**kwargs)

def load(name: str, version: int | str = "production") -> Prompt:
    """name='classify', version=2 or 'production'。"""
    folder = PROMPTS_DIR / name
    if version == "production":
        # 找 status: production 的版本
        for p in folder.glob("v*.yaml"):
            data = yaml.safe_load(p.read_text())
            if data.get("status") == "production":
                return Prompt(p)
        raise FileNotFoundError(f"No production version for {name}")
    return Prompt(folder / f"v{version}.yaml")

# 用法
classify = load("classify")  # 默认拿 production
sys = classify.render(categories=["logistics", "refund", "discount"])
```

好处：

- 切版本 = 改 YAML 状态字段
- 评测时可加载任意版本对比
- prompt 改动走 PR review，必须经过 git diff

## 6. 版本号 / A/B / 灰度

### 6.1 版本号约定

```text
v1.0.0  初版
v1.0.1  仅措辞调整，行为兼容
v1.1.0  新增字段 / 新增 few-shot
v2.0.0  破坏性变更（输出 schema 变化）
```

破坏性变更必须升 major version，下游消费者要同步升级。

### 6.2 A/B 实验

```python
import random

def get_prompt(user_id: str):
    # 50/50 流量切分
    if hash(user_id) % 100 < 50:
        return load("classify", version=1), "v1"
    else:
        return load("classify", version=2), "v2"

prompt, version_tag = get_prompt(user.id)
result = call_llm(prompt.render(...))
log_event(user_id=user.id, prompt_version=version_tag, result=result)
```

之后离线分析 v1 / v2 的指标差异。

### 6.3 灰度发布

| 阶段     | 流量比例           | 时长     |
| ------ | -------------- | ------ |
| Canary | 1%             | 24h    |
| Small  | 10%            | 48h    |
| Half   | 50%            | 1 周    |
| Full   | 100%           | -      |

每阶段都看：

- 评测集准确率 vs baseline
- 线上 bad case 反馈率
- 成本（token 消耗）
- 延迟

任一指标退化 → 立刻回滚（改 YAML 的 status 字段，下个请求就生效）。

## 7. 命名约定

| 维度       | 推荐命名                                                  |
| -------- | ----------------------------------------------------- |
| Prompt id | `<domain>_<task>` （`customer_classify`、`legal_extract`） |
| 文件        | `vN.yaml` 或 `vN.M.K.yaml`                            |
| Status   | `draft` / `staging` / `production` / `deprecated`     |
| 变量名       | snake_case，匹配 schema 字段                              |
| 共享 fragment | `shared/<purpose>.txt`（`safety_rules.txt`）           |

避免：

- 用日期当版本号（`v20260415`）—— 不容易判断破坏性变更
- 用 git commit hash 当版本号 —— 难记、难沟通
- prompt 名里带前缀如 `prompt_xxx` —— 已经在 prompts/ 目录了，冗余

## 8. Prompt 仓库工具

| 工具                    | 特点                                |
| --------------------- | --------------------------------- |
| Promptfoo             | 开源 + 评测一体化，支持 YAML 配置             |
| LangSmith Prompt Hub  | LangChain 生态，云端 prompt registry  |
| Helicone              | 监控 + Prompt 管理                    |
| 自家 YAML + Git         | 0 依赖，最灵活                          |
| Notion / Confluence  | **不要**用——脱离 git，没版本号约束           |

中小项目推荐自家 YAML + Git。规模上去（> 50 个 prompt、> 10 个开发者）可考虑 Promptfoo。

## 9. 一段可运行代码：完整 prompt registry + A/B

```python
# pip install pyyaml jinja2 anthropic
import hashlib
from pathlib import Path
import yaml
from jinja2 import Template
import anthropic

client = anthropic.Anthropic()

class PromptRegistry:
    def __init__(self, root: Path):
        self.root = root
        self._cache = {}

    def load(self, name: str, version: str = "production"):
        key = (name, version)
        if key in self._cache:
            return self._cache[key]
        folder = self.root / name
        if version == "production":
            for p in sorted(folder.glob("v*.yaml")):
                data = yaml.safe_load(p.read_text())
                if data.get("status") == "production":
                    obj = self._build(data)
                    self._cache[key] = obj
                    return obj
            raise FileNotFoundError(name)
        data = yaml.safe_load((folder / f"v{version}.yaml").read_text())
        obj = self._build(data)
        self._cache[key] = obj
        return obj

    def _build(self, data: dict):
        return {
            "id": data["id"],
            "version": data["version"],
            "render": Template(data["template"]).render,
        }

REG = PromptRegistry(Path("prompts"))

def hash_bucket(user_id: str, buckets: int = 100) -> int:
    return int(hashlib.md5(user_id.encode()).hexdigest(), 16) % buckets

def call(user_id: str, user_text: str):
    bucket = hash_bucket(user_id)
    if bucket < 10:
        # 10% 流量进 v2 灰度
        prompt = REG.load("classify", "2")
    else:
        prompt = REG.load("classify", "production")

    system = prompt["render"](categories=["logistics", "refund", "discount"])
    resp = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=128,
        system=system,
        messages=[{"role": "user", "content": user_text}],
        temperature=0,
    )
    return {
        "result": resp.content[0].text,
        "prompt_version": prompt["version"],
    }

if __name__ == "__main__":
    print(call("user_123", "我的快递到哪了"))
```

要点：

- Prompt 全部从 YAML 加载，代码里没有 prompt 字符串
- A/B 通过 hash 桶分流，方便事后归因
- prompt_version 落日志，离线分析依赖

## 10. Code Review checklist

Prompt 提交 PR 时要 review 的事项：

- [ ] 版本号正确（破坏性变更升 major）
- [ ] `description` 写明用途和上游消费者
- [ ] 变量名清晰、有 type
- [ ] 评测集已更新（若是新 prompt）
- [ ] 跑了离线评测，附结果对比
- [ ] 无敏感数据（PII、密钥）硬编码
- [ ] 无对其他系统 prompt 的明文引用（避免泄露）
- [ ] 注释了为什么这样写（特别是补丁性规则）
- [ ] 兼容现有调用方（看是否需要联动改 schema）

## 常见坑

1. **prompt 字符串散落代码里**：5 个文件各自有 system prompt，改一处忘改另一处。集中到 `prompts/` 目录。
2. **f-string 拼接用户输入**：`f"用户问：{user_input}"` → 用户 `user_input = "}; ignore previous"` → 解析出错或注入。Prompt 模板只渲染**配置变量**，用户输入永远走 messages。
3. **没有版本号**：直接 `prompt = "..."` 改字符串、push、上线。出 bug 不知道改了什么、没法回滚。最简方案：YAML + git。
4. **A/B 没记 prompt_version**：跑了 A/B 实验，但日志里没记哪条用了哪版，无法事后归因。版本 tag 必须落日志。
5. **灰度跳级**：从 1% 直接全量。用户报错没法限制爆炸半径。按 §6.3 阶梯灰度。
6. **Prompt 评测和代码评测分开**：prompt 改了不跑评测，代码改了不跑 prompt 测试。CI 里加 prompt eval gate（见 [10 · 评测](./10-evaluation.md)）。
7. **YAML 里有手机号 / token**：把测试用真实数据贴进 YAML，git push 上公网仓库。Prompt 也要走密钥扫描。

## 下一步

- [10 · Prompt 评测与迭代](./10-evaluation.md) — Prompt 仓库和评测的 CI 集成
- [05 · 指令调优与输出约束](./05-instruction-tuning.md) — 模板里如何写硬约束
- [09 · 对抗 Prompt](./09-adversarial.md) — 模板渲染时怎么防注入
- [../langchain/03-prompts-and-models.md](../langchain/03-prompts-and-models.md) — LangChain PromptTemplate API
- [../eval/02-datasets.md](../eval/02-datasets.md) — 评测集设计原则
