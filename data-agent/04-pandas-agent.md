# 04 · Pandas / DataFrame Agent

SQL Agent 适合"我有仓库、给我数"。**Pandas Agent 适合"我有一个 CSV/DataFrame，帮我探索"**——典型场景：分析师上传文件、Notebook 内 EDA、Code Interpreter 风格产品。本章讲清两种实现路径（LangChain `create_pandas_dataframe_agent` 与 PandasAI），以及绕不开的内存、安全、可读性问题。

## 1. SQL Agent vs Pandas Agent

| 维度 | SQL Agent | Pandas Agent |
| --- | --- | --- |
| 数据源 | DB | DataFrame（内存）/ Parquet / CSV |
| 代码 | SQL | Python（pandas / numpy / matplotlib） |
| 执行 | DB engine | **Python sandbox** |
| 风险 | DROP TABLE、慢查询 | `os.system`、读宿主文件、OOM |
| 上限 | 仓库表 | 单机内存（GB 级） |
| 优势 | 大数据、强类型 | 灵活、丰富生态（含画图、ML） |

**速判**：

- 数据 < 1GB、用户要互动探索 → Pandas Agent
- 数据 > 10GB、定时报表 → SQL Agent
- 1–10GB 中间地带 → DuckDB（SQL on Parquet，内存效率高，§7 详谈）

## 2. 三条主流路径

```
                ┌───────────────────────────────────┐
                │ Path A: LangChain pandas_agent    │
                │   LLM 写 Python → exec()          │
                │   优点：装一下就能跑               │
                │   缺点：默认不沙箱，生产不要用     │
                └───────────────────────────────────┘

                ┌───────────────────────────────────┐
                │ Path B: PandasAI                  │
                │   df.chat("...") → LLM → 代码 → 跑 │
                │   优点：API 优雅、内置部分沙箱     │
                │   缺点：抽象重，定制难             │
                └───────────────────────────────────┘

                ┌───────────────────────────────────┐
                │ Path C: 自建 Code Interpreter     │
                │   LLM 生成代码 → E2B/Modal → 结果 │
                │   优点：可控、可观测、可演化      │
                │   缺点：自己造轮子                │
                └───────────────────────────────────┘
```

生产推荐 Path C，原因见 §6 / §8。Path A/B 适合 PoC。

## 3. Path A：LangChain pandas_agent（最快上手）

```python
"""
LangChain pandas_agent：30 行跑通。
仅本地玩。
依赖：pip install langchain-experimental langchain-openai pandas
"""
import pandas as pd
from langchain_experimental.agents import create_pandas_dataframe_agent
from langchain_openai import ChatOpenAI

df = pd.read_csv("sales_2025.csv")
agent = create_pandas_dataframe_agent(
    ChatOpenAI(model="gpt-4o-mini", temperature=0),
    df,
    agent_type="openai-tools",
    verbose=True,
    allow_dangerous_code=True,   # 注意这个开关
)

print(agent.invoke({"input": "按 region 汇总 GMV 并画柱状图"}))
```

`allow_dangerous_code=True` 必须显式打开。**这就是裸 exec**——LLM 写啥就跑啥，包括 `os.system`。**永远别在生产用**。

## 4. Path B：PandasAI（开箱体验最佳）

```python
"""
PandasAI：df.chat("...") 风格。
依赖：pip install pandasai
"""
import pandas as pd
from pandasai import SmartDataframe
from pandasai.llm import OpenAI

df = pd.read_csv("sales_2025.csv")
sdf = SmartDataframe(df, config={
    "llm": OpenAI(api_token="..."),
    "enable_cache": True,
    "save_charts": True,
    "save_charts_path": "./charts/",
})

print(sdf.chat("按 region 汇总 GMV，输出 top 5"))
sdf.chat("画 region GMV 柱状图")
```

PandasAI 内置：

- **代码白名单**：禁止 `os`、`sys`、`subprocess`、文件系统操作（不完整但比 Path A 强）
- 缓存：相同 question 不再调 LLM
- 多 DataFrame join：`SmartDatalake([df1, df2])`

**仍然不安全**：白名单可绕过（`__import__('os')`）。生产要走 Path C。

## 5. Path C：自建 Code Interpreter（生产推荐）

最小骨架：

```python
"""
自建 Pandas Agent，跑在 E2B sandbox。
LLM 输出 Python 代码 → E2B 执行 → 拿结果。
依赖：pip install e2b-code-interpreter langchain-openai pandas
"""
from e2b_code_interpreter import Sandbox
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(model="gpt-4o", temperature=0)

PROMPT = """\
你是一个数据分析助手。用户给你一个 DataFrame df，结构如下：

【df 描述】
{df_describe}

【df.head()】
{df_head}

请用 pandas 回答用户问题。要求：
1. 只输出可直接执行的 Python 代码块，不要解释
2. 最终结果赋给变量 `result`
3. 需要画图时用 matplotlib 并 plt.savefig('out.png')
4. 不要读写本地任何文件（除 'out.png' 用于绘图）
5. 不要 import os/sys/subprocess

【问题】
{question}
"""

def analyze(df_path: str, question: str) -> dict:
    with Sandbox.create() as sbx:
        sbx.files.write("/home/user/data.csv", open(df_path).read())
        # 先获取 describe / head
        meta = sbx.run_code(
            "import pandas as pd; df = pd.read_csv('/home/user/data.csv'); "
            "print(df.describe().to_string()); print('---'); print(df.head().to_string())"
        )
        df_meta = meta.logs.stdout

        # 让 LLM 生成代码
        prompt = PROMPT.format(
            df_describe=df_meta.split("---")[0],
            df_head=df_meta.split("---")[1],
            question=question,
        )
        code = llm.invoke(prompt).content
        # 提取 code block
        code = code.split("```python")[-1].split("```")[0].strip()
        # 在 sandbox 执行
        full = (
            "import pandas as pd, matplotlib.pyplot as plt\n"
            "df = pd.read_csv('/home/user/data.csv')\n"
            + code + "\n"
            "import json; print('__RESULT__', json.dumps(str(result)[:2000]))"
        )
        res = sbx.run_code(full)
        return {
            "code": code,
            "stdout": res.logs.stdout,
            "stderr": res.logs.stderr,
            "files": [f.path for f in res.results if hasattr(f, 'path')],
        }

print(analyze("sales_2025.csv", "按 region 汇总 GMV，top 5 + 柱状图"))
```

详见 [`../coding-agent/05-sandbox.md`](../coding-agent/05-sandbox.md) 的 E2B 细节。这条路**所有富输出（图、文件、df 表格）都能在 sandbox 里拿到**，安全可观测。

## 6. 内存与大数据策略

Pandas Agent 默认假设 DataFrame 全在内存。CSV 大了直接 OOM。

| 策略 | 适用 | 代价 |
| --- | --- | --- |
| 直接 `pd.read_csv` | < 1GB | OK |
| `pd.read_csv(chunksize=)` 分块 | 1–10GB 单机 | 代码复杂 |
| **DuckDB** | 1–100GB | 推荐——直接 SQL on Parquet/CSV |
| Polars | 1–50GB | 速度 5–10x Pandas |
| Dask / Ray | 分布式 | 复杂度高 |

**强烈推荐 DuckDB 作为 Pandas Agent 的底层**：

```python
import duckdb
con = duckdb.connect()
# 直接 query 文件，零拷贝
df = con.execute("""
    SELECT region, SUM(amount_cents)/100 AS gmv
    FROM 'sales_2025.parquet'
    WHERE status = 'paid'
    GROUP BY region ORDER BY gmv DESC
""").df()
```

DuckDB + LLM 生成 SQL 就是 §02 的 SQL Agent 应用到本地文件——同一套基础设施。

## 7. Prompt 模板（生产版）

```text
你是 Pandas 数据分析助手。

【环境】
- 已加载 DataFrame `df`，列与类型如下：
{schema}
- 行数：{nrow}
- 内存占用：{memory_mb} MB

【前 5 行】
{head}

【描述统计】
{describe}

【用户问题】
{question}

【硬约束】
1. 只输出一个 Python 代码块
2. 把最终回答放到变量 `result`（DataFrame / 字符串 / 数字）
3. 如果要画图：plt.figure() → 画 → plt.savefig('out.png', dpi=120, bbox_inches='tight')
4. 严禁导入：os, sys, subprocess, requests, urllib, socket
5. 严禁读取除 df 之外的文件
6. 如果数据不足以回答，把 result 设为字符串说明原因
7. 列名严格按 schema 拼写

【可选改进】
- 数字保留 2 位小数
- 时间戳用 pd.to_datetime
- 缺失值显式 fillna 或 dropna 并在 result 里说明
```

**关键点**：

- "硬约束"段必须重复每次。LLM 会忘。
- "数据不足时 result 设字符串"——避免 LLM 幻觉数据。
- schema 不只是列名，要带 dtype 和 nullable 信息。

## 8. 错误恢复（同 SQL Agent §05 思路）

```python
"""
Pandas Agent 的 retry-with-error。
"""
def analyze_with_retry(df_path, question, max_attempts=3):
    history = []
    for attempt in range(max_attempts):
        prompt = build_prompt(df_path, question, history)
        code = extract_code(llm.invoke(prompt).content)
        res = run_in_sandbox(code, df_path)
        if not res["stderr"]:
            return res
        history.append({"code": code, "error": res["stderr"]})
    return {"error": "max retry exceeded", "history": history}
```

常见错误与对策：

| 错误 | LLM 通常的"自救" |
| --- | --- |
| `KeyError: 'gmv'` | 看 schema 改成正确列名 |
| `dtype` 不匹配 | 加 `astype(...)` |
| 时间字符串没 parse | `pd.to_datetime(...)` |
| 内存溢出 | 改用 `chunksize` 或 `dtype={'col': 'int32'}` |
| `matplotlib` 后端报错 | `matplotlib.use('Agg')` 加在最前 |

## 9. 富输出（results）

LLM 跑完代码，结果可能是：

| 输出类型 | 处理 |
| --- | --- |
| 数字 / 字符串 | 直接 `print(result)` |
| DataFrame | `result.to_html(max_rows=20)` 渲染 |
| matplotlib 图 | `plt.savefig('out.png')` + 从 sandbox download |
| Plotly 图 | `fig.to_html()` 或 `fig.write_image()` |
| 多图 | 命名为 `chart_1.png`、`chart_2.png` |

E2B 的 `sbx.run_code(...)` 返回 `Result` 列表，自动捕获 PNG/JPEG 输出——直接可以渲染给前端。

## 10. 真实例子：从 CSV 到洞察

**用户**："分析 sales_2025.csv，找出销量异常下降的 SKU。"

**LLM 输出**：

```python
import pandas as pd, matplotlib.pyplot as plt

df['date'] = pd.to_datetime(df['date'])
df['month'] = df['date'].dt.to_period('M')
monthly = df.groupby(['sku_id', 'month'])['qty'].sum().unstack().fillna(0)

# 计算近 3 月平均 vs 上一月对比
recent_avg = monthly.iloc[:, -4:-1].mean(axis=1)
last      = monthly.iloc[:, -1]
drop      = (recent_avg - last) / recent_avg.replace(0, 1)

anomaly = drop.sort_values(ascending=False).head(10)
result  = anomaly.to_frame("drop_ratio").join(
    monthly.iloc[:, -4:], how="left"
)

plt.figure(figsize=(8, 4))
anomaly.plot(kind='bar')
plt.title("Top 10 SKUs with largest sales drop vs 3-month avg")
plt.ylabel("Drop ratio")
plt.tight_layout()
plt.savefig('out.png', dpi=120)
```

**输出**：

- `result`：DataFrame，10 行（SKU id + drop_ratio + 月度量）
- `out.png`：柱状图

下一步是把 `result` 喂 LLM 做 §06 的 **insight extraction**："SKU-1234 下降 67%，远超季节性平均"。

## 常见坑

1. **直接 exec 不沙箱**：LLM 一句 `os.system('rm -rf /')` 玩完。**生产必走 sandbox**。
2. **整个 DataFrame 塞 prompt**：100 万行的 head 不会出大问题，但有人会塞 `df.to_csv()` 进 prompt，token 爆。**只塞 schema + describe + head(5)**。
3. **matplotlib 不 close**：循环里画图 → 内存泄漏 + 句柄爆。**`plt.close('all')` 每次后**。
4. **结果没 result 变量**：LLM 直接 `print`，后续渲染拿不到结构化结果。**强制约束变量名**。
5. **数字精度**：浮点直接显示 `0.83333333`，业务方反感。**统一 `round(2)` 或 `:.2%`**。

## 下一步

- [05 · 可视化生成](./05-visualization.md) — 把 matplotlib 替换成 Plotly / Vega-Lite，可交互前端。
- [07 · Code Interpreter](./07-code-interpreter.md) — sandbox 选型、执行链路细节。
- [`../coding-agent/05-sandbox.md`](../coding-agent/05-sandbox.md) — E2B / Modal / Docker 详细对比。
- [`../llm-security/06-tool-safety.md`](../llm-security/06-tool-safety.md) — `exec` / `eval` 的攻击面、import 白名单。
- DuckDB 文档：<https://duckdb.org/docs/> — 本地文件即 SQL。
- 真实参考：PandasAI、Hex Magic、OpenAI Advanced Data Analysis。
