# 提示词回归测试（dsh-prompt-regression）

**什么时候用**：改 system prompt、换模型、升级全家桶参数之后，验证关键行为没有回归。
用户会说：「改完提示词怎么知道没把老功能改坏」「换模型后行为差在哪」。

## 怎么用（三步）

```bash
<cli 路径> gen --out 评测集.json                                # ① 生成骨架（5 个示例用例）
# ② 把 expect_contains/expect_not/expect_regex 改成业务必须稳定的关键行为
<cli 路径> run --eval 评测集.json --system system.md            # 预估费用
<cli 路径> run --eval 评测集.json --system system.md --confirm --out ./run1    # 回放
<cli 路径> run ... --baseline ./run1/结果.json --html 报告.html  # 下次改完跑：drift 对比
```

## 判定口径

- 断言三类：包含（expect_contains）/ 排除（expect_not）/ 正则（expect_regex）
- 全部通过 = pass；任一未过 = fail；**无断言用例 = unclear（必须补断言）**
- 安全拒答（stop_reason=refusal）视为该用例 fail——行为变化了
- 退出码有 fail → 1，可挂 CI 做提示词回归门禁

## 边界

联网插件：回放调 chat/completions，费用预估后 --confirm 才执行。断言是子串/正则级别的启发式，语义级回归仍需人工抽查。
