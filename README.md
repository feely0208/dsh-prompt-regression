# @deepwhale-cn/dsh-prompt-regression

提示词回归测试：改 system prompt / 换模型后，用固定评测集回放验证关键行为——包含/排除/正则三类断言、pass 率、**drift 对比**（新破坏/已修复）。退出码有 fail → 1（CI 门禁可用）。

```bash
npx @deepwhale-cn/dsh-prompt-regression gen --out 评测集.json
npx @deepwhale-cn/dsh-prompt-regression run --eval 评测集.json --system system.md --confirm --out ./run1
npx @deepwhale-cn/dsh-prompt-regression run --eval 评测集.json --baseline ./run1/结果.json --html 报告.html
```

**联网插件**：回放调 chat/completions，费用预估后 --confirm 才执行。断言为子串/正则启发式。
