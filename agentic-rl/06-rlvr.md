# 06 · RLVR 可验证奖励

> RLVR（RL with Verifiable Rewards）的核心动机：**别让 RM 当裁判，让"程序"当裁判**。数学题有标准答案，代码题有单测，这种地方为什么还要训个 70B 的 RM？

DeepSeek-R1 / o1 / Qwen-QwQ 都靠 RLVR 把 reasoning 拉起来。本章讲怎么设计 verifier、怎么避免 reward hacking、以及一个能跑的 GRPO + 数学 verifier 例子（GRPO 算法本身在 §07）。

## 1. 什么是"可验证 reward"

| 任务类型 | 验证方式 | reward 形态 |
| --- | --- | --- |
| 数学题 | 提取答案 → 精确匹配 | 0/1 |
| 代码题 | 跑单测 / IO 比对 | 通过率 0-1 |
| 格式遵循 | 正则 / JSON schema | 0/1 |
| 工具调用 | 函数签名 + 参数校验 | 0/1 |
| Agent 任务 | 环境状态判断 | 子任务通过率 |
| SQL 题 | 在 DB 上执行比对结果 | 0/1 |

> 这些都比 RM 评分**客观**且**不会被 reward hack**（除非 verifier 本身有 bug）。

## 2. 数学 verifier 实现

```python
# pip install sympy
import re
from sympy import sympify, simplify

def extract_answer(text: str) -> str | None:
    """从 chain-of-thought 输出抠出最终答案。"""
    # 优先匹配 \boxed{} （MATH 数据集风格）
    m = re.search(r"\\boxed\{([^{}]+)\}", text)
    if m: return m.group(1).strip()
    # 退化：最后一个 "答案是" 或 "answer is"
    m = re.search(r"(?:答案是|answer is|####)\s*([^\s\n]+)", text, re.I)
    if m: return m.group(1).strip().rstrip(".,。")
    return None

def math_verify(response: str, gold: str) -> float:
    pred = extract_answer(response)
    if pred is None:
        return 0.0
    # 字符串完全相等
    if pred.strip() == gold.strip():
        return 1.0
    # 用 sympy 做数学等价（处理 1/2 vs 0.5 vs "0.50" 这种）
    try:
        if simplify(sympify(pred) - sympify(gold)) == 0:
            return 1.0
    except Exception:
        pass
    return 0.0

# 测试
print(math_verify(r"经过推理，\boxed{0.5}", "1/2"))   # 1.0
print(math_verify("答案是 42。", "42"))                # 1.0
print(math_verify("我猜是 100", "42"))                 # 0.0
```

| 边界 case | 注意 |
| --- | --- |
| 分数 vs 小数 | sympy 等价处理 |
| 单位（cm / m） | 加规则去单位 |
| 多重答案 | x=1 or x=2，需 set 比较 |
| 大数 / 浮点 | 容差 1e-6 |
| 中英文混写 | 提取规则要兼容 |

> 推荐用 HuggingFace `math-verify` 包（<https://github.com/huggingface/Math-Verify>），覆盖 MATH / AIME 主要 corner case。

## 3. 代码 verifier 实现

```python
# pip install timeout-decorator
import subprocess, tempfile, json, os
from typing import List

def code_verify(response: str, tests: List[str], timeout: int = 5) -> float:
    """提取代码 + 跑 unit test，返回通过率。"""
    # 抠代码块
    import re
    m = re.search(r"```python\n(.*?)\n```", response, re.S)
    if not m:
        return 0.0
    code = m.group(1)

    passed = 0
    for t in tests:
        script = code + "\n" + t  # t 形如 "assert solution(1,2)==3"
        with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f:
            f.write(script); f.flush()
            try:
                r = subprocess.run(["python", f.name],
                                   timeout=timeout, capture_output=True)
                if r.returncode == 0:
                    passed += 1
            except subprocess.TimeoutExpired:
                pass
            finally:
                os.unlink(f.name)
    return passed / len(tests)
```

| 安全注意 | 处理 |
| --- | --- |
| 模型代码可能 `os.system("rm -rf")` | 沙箱（Docker / firejail / nsjail） |
| 死循环 | timeout 必备 |
| 网络访问 | 沙箱禁网 |
| 文件写盘 | 临时目录 + 沙箱 quota |

> 生产用：HumanEval/MBPP 跑分用 `evalplus` 或 `bigcode-evaluation-harness`。训练侧用 `sandbox-fusion` / `firejail`。**不要在裸机上跑 RL 生成的代码**。

## 4. Reward shaping：超越 0/1

只给 0/1 的 reward 信号稀疏，特别是任务难时整 batch 全 0，梯度全 0。需要 shaping：

```python
def shaped_math_reward(response, gold):
    r = 0.0
    # 1. 格式 reward
    if r"\boxed{" in response:
        r += 0.1
    # 2. 长度 reward（鼓励有推理过程，限制过长）
    n_tokens = len(response.split())
    if 100 < n_tokens < 2000:
        r += 0.1
    # 3. 最终答案对错
    r += math_verify(response, gold)   # 0 or 1
    return r
```

| Shaping 类别 | 例子 | 风险 |
| --- | --- | --- |
| 格式 reward | `\boxed{}` 出现 | 模型刷格式不解题 |
| 长度 reward | 100-2000 token | 模型灌水到上限 |
| Intermediate step | 含 "Step 1/2/3" | 模型伪造步骤 |
| 多样性 reward | distinct n-gram | 模型乱说话 |

> DeepSeek-R1 paper（2025）的 reward 是 **answer reward + format reward** 两项；其余全是模型自己 emerge 的。

## 5. Reward Hacking 案例集

| Hacking | 表现 | 修复 |
| --- | --- | --- |
| 答案重复刷 | 模型输出 `\boxed{1}` `\boxed{2}` ... `\boxed{42}` 穷举 | verifier 只看第一个 / 最后一个 |
| Verifier 漏洞 | 用 `eval()` 给答案，模型输出 `__import__('os').system(...)` | sympify 而非 eval；沙箱 |
| 单测漂白 | 模型代码 `if __name__: ...` 检测测试环境跳过 | 隐藏测试样例 |
| 格式 + 错答案 | 模型刷 `\boxed{}` 拿格式分但答案错 | 格式分必须 + 答案分 |
| 长度灌水 | 模型刷推理步骤但都重复 | 长度 reward 上限 + entropy |
| Self-correct 蒸馏 | 模型输出"上一答案错，正确是..."骗 verifier 看末尾 | verifier 只取最终 `\boxed{}` |

> 经典：OpenAI *Reward Hacking in Reinforcement Learning* 系列博文。DeepMind 2024 *Specification Gaming* 综述列了 60+ 个例子。

## 6. RLVR + GRPO：一个最小 loop

```python
# pip install trl 0.12+
from trl import GRPOTrainer, GRPOConfig
from transformers import AutoTokenizer, AutoModelForCausalLM
from datasets import load_dataset

MODEL = "Qwen/Qwen2.5-Math-7B"
tok = AutoTokenizer.from_pretrained(MODEL)
model = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype="bfloat16")

ds = load_dataset("HuggingFaceH4/MATH-500", split="train")

def reward_fn(prompts, completions, **kwargs):
    """TRL GRPO reward 接口。返回每个 sample 的 scalar reward。"""
    golds = kwargs["answer"]
    rewards = []
    for c, g in zip(completions, golds):
        r = 0.0
        if r"\boxed{" in c:
            r += 0.1                              # 格式 bonus
        r += math_verify(c, g)                    # 答案 reward
        rewards.append(r)
    return rewards

cfg = GRPOConfig(
    output_dir="grpo-math",
    per_device_train_batch_size=1,                # 注意 group sample 占显存
    num_generations=8,                            # group size
    max_prompt_length=512,
    max_completion_length=2048,
    learning_rate=5e-6,
    beta=0.04,                                    # KL 系数
    num_train_epochs=1,
    bf16=True,
    logging_steps=10,
)

trainer = GRPOTrainer(
    model=model,
    args=cfg,
    train_dataset=ds,
    reward_funcs=[reward_fn],
    tokenizer=tok,
)
trainer.train()
```

> GRPO 算法细节见 [07 · GRPO](./07-grpo.md)。这里关注 reward_fn 的设计。

## 7. 数据集

| 数据集 | 规模 | 适合 |
| --- | --- | --- |
| GSM8K | 8.5K 小学数学 | 入门、快速调试 |
| MATH | 12.5K 高中竞赛 | 主力训练 |
| AIME 2024/2025 | 30 题 | 终极评测 |
| HumanEval | 164 | 代码评测 |
| MBPP | 974 | 代码训练 |
| LiveCodeBench | 持续更新 | 防数据污染 |
| TACO | 25K 算法题 | 代码训练 |
| APPS | 10K | 代码训练 |
| BigCodeBench | 1140 | 复杂代码 |

> 实战配方：GSM8K + MATH 训练 + AIME 评测（DeepSeek-R1 / Qwen-Math 同款）。

## 8. 数据污染问题

可验证 reward 的最大隐患：模型预训练时已经见过答案。

```python
# 简易检测：n-gram overlap 与预训练语料
from datasets import load_dataset

def has_contamination(text, ref_corpus, n=13):
    ngrams = set(zip(*[text.split()[i:] for i in range(n)]))
    for ref in ref_corpus:
        ref_ngrams = set(zip(*[ref.split()[i:] for i in range(n)]))
        if ngrams & ref_ngrams:
            return True
    return False
```

| 缓解 | 效果 |
| --- | --- |
| 用 LiveCodeBench / 最新 AIME（截止日后） | 强 |
| 私有题库 | 强但贵 |
| paraphrase 重写题面 | 中 |
| 仅看相对提升 vs 基线 | 弱但实用 |

> Qwen-Math（2024）专门做了 contamination 报告，AIME 2024 上即便 contamination 控制后仍有 +20 pt 提升，证明 RLVR 不是单纯记忆。

## 9. 多 verifier 组合

复杂任务用一个 reward 不够。组合方式：

| 组合 | 例子 | 风险 |
| --- | --- | --- |
| 加权和 | r = 0.7·ans + 0.2·fmt + 0.1·len | 系数难调 |
| 阶段化 | epoch < 5 用 fmt，>5 用 ans | 防早期信号太稀疏 |
| 乘法门 | r = fmt · ans（格式不对全 0） | 严格但难探索 |
| 多 head GRPO | 每个 group sample 给多维 reward | 实现复杂 |

```python
def composite_reward(prompts, completions, **kw):
    rewards = []
    for c, g in zip(completions, kw["answer"]):
        fmt = 1.0 if r"\boxed{" in c else 0.0
        ans = math_verify(c, g)
        # 乘法门：格式错就 0
        r = fmt * (0.1 + 0.9 * ans)
        rewards.append(r)
    return rewards
```

## 常见坑

1. **`eval()` 当 verifier 跑模型代码**：模型会注入 `import os; os.system('curl evil...')`。**永远用沙箱**或纯 sympify。
2. **answer extraction 太脆弱**：只匹配 `\boxed{}`，但模型经常输出 `答案是 42`。多个正则 + 兜底。
3. **训练集和测试集 verifier 不一致**：训练 verifier 宽松（部分对也给分），测试严格。线上分数虚高。
4. **reward batch 全 0**：任务太难，模型瞎猜全错，梯度全 0 学不动。先 SFT 到 baseline > 30% 再上 RLVR，或加 shaping。
5. **以为 verifier 完美就不会 hack**：sympy 也能被绕（如答案 `1/0` 算 NaN 但被 verifier 当通过）。**人工 review 100 条训练后样本**。

## 下一步

- GRPO 算法细节：[07 · GRPO](./07-grpo.md)
- 过程 reward（PRM）替代结果 reward：[08 · 过程 vs 结果](./08-process-vs-outcome.md)
- 训练框架（verl / OpenRLHF）：[09 · 工具](./09-tools.md)
- DeepSeek-R1 复现细节：[10 · 案例](./10-case-study.md)
- 跨主题：Agent 任务 reward 怎么设计 [`../agents/10-production.md`](../agents/10-production.md)
- 跨主题：评测可验证任务 [`../eval/`](../eval/README.md)
