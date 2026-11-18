#!/usr/bin/env node
/**
 * dsh-prompt-regression —— 提示词回归测试（可选联网）
 *
 * 用法：
 *   gen    [--out 评测集.json]                                   # 生成评测集骨架（离线）
 *   run    --eval 评测集.json [--system system.md] [--confirm]    # 预估 / 回放
 *          [--baseline 上次结果.json]  → drift 对比（新失败 / 已修复）
 *          [--model m] [--no-safety] [--api-base URL] [--key-file 路径] [--json] [--html 报告.html] [--out 目录]
 * 判定：包含/排除/正则三类断言；无断言用例 = unclear（人工补断言）。
 * 退出码：有 fail → 1（可挂 CI 做提示词回归门禁）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { normalizeEval, judgeCase, replay, genEval, estimateCost } from '../lib/index.js';

const args = process.argv.slice(2);
const cmd = args[0];
const has = (k) => args.includes('--' + k);
const val = (k, d = '') => {
  const i = args.indexOf('--' + k);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};

if (!cmd || has('help')) {
  console.log(`dsh-prompt-regression —— 提示词回归测试

用法：
  gen  [--out 评测集.json]                                   # 生成评测集骨架（离线）
  run  --eval 评测集.json [--system system.md] [--confirm]    # 预估 / 回放
       [--baseline 上次.json] [--model m] [--no-safety] [--api-base URL] [--key-file 路径]
       [--json] [--html 报告.html] [--out 目录]
判定：包含/排除/正则三类断言；改 prompt 后跑一遍看 pass 率与 drift。退出码有 fail → 1。`);
  process.exit(0);
}

if (cmd === 'gen') {
  const pack = genEval({ model: val('model', 'deepseek-flash') });
  const out = resolve(val('out', '评测集.json'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(pack, null, 2) + '\n', 'utf-8');
  console.log(`已生成评测集骨架：${pack.cases.length} 个用例 → ${out}`);
  console.log('把 expect_contains/expect_not 改成你业务里必须稳定的关键行为；改完 run --confirm 回放。');
  process.exit(0);
}

if (cmd === 'run') {
  const raw = JSON.parse(readFileSync(val('eval'), 'utf-8'));
  const evalSet = normalizeEval(raw);
  const system = has('system') ? readFileSync(val('system'), 'utf-8') : (evalSet.system || '');
  const est = estimateCost(evalSet.cases.length);
  if (!has('confirm')) {
    console.log(`\n  深鲸 · 提示词回归预估（不会联网）\n  ${'─'.repeat(56)}`);
    console.log(`  用例数     ${evalSet.cases.length} · system ${system.length} 字符`);
    console.log(`  预估费用   ${est.cny} 元（${est.note}）`);
    console.log(`\n  确认后加 --confirm 执行；模型 ${evalSet.model || val('model', 'deepseek-flash')}。`);
    process.exit(0);
  }
  const apiKey = process.env.DEEPSEEK_API_KEY || (has('key-file') ? readFileSync(val('key-file'), 'utf-8').trim() : '');
  const model = val('model', evalSet.model || 'deepseek-flash');
  const results = [];
  let pass = 0, fail = 0, unclear = 0, failed = 0;
  for (const c of evalSet.cases) {
    try {
      const { refusal, output } = await replay(c, system, { apiKey, model, safetyCheck: !has('no-safety'), apiBase: val('api-base', 'https://api.deepseek.com') });
      const v = judgeCase(output, c);
      const verdict = refusal ? 'fail' : v.verdict; // 安全拒答视为该用例未通过（行为变化了）
      if (verdict === 'pass') pass += 1; else if (verdict === 'fail') fail += 1; else unclear += 1;
      results.push({ id: c.id, verdict, refusal, reason: refusal ? '安全拒答（stop_reason=refusal）——行为与上次不同' : v.reason, assertions: v.assertions, output: output.slice(0, 500) });
      if (!has('json')) console.log(`${verdict === 'pass' ? '✅' : verdict === 'fail' ? '🚨' : '❓'} ${c.id}  ${refusal ? '安全拒答' : v.reason}`);
    } catch (e) {
      failed += 1;
      results.push({ id: c.id, verdict: 'error', reason: String(e.message || e).slice(0, 160) });
      if (!has('json')) console.log(`⚠️  ${c.id} 执行失败：${String(e.message || e).slice(0, 100)}`);
    }
  }
  const summary = { cases: evalSet.cases.length, pass, fail, unclear, failed, pass_rate: evalSet.cases.length ? Math.round((pass / evalSet.cases.length) * 100) : 0 };

  // drift 对比
  let drift = null;
  if (has('baseline')) {
    try {
      const base = JSON.parse(readFileSync(val('baseline'), 'utf-8'));
      const byId = new Map(base.results.map((r) => [r.id, r.verdict]));
      const newlyBroken = [], fixed = [];
      for (const r of results) {
        const prev = byId.get(r.id);
        if (prev && prev !== 'fail' && prev !== 'error' && r.verdict === 'fail') newlyBroken.push(r.id);
        if (prev === 'fail' && r.verdict === 'pass') fixed.push(r.id);
      }
      drift = { newlyBroken, fixed };
    } catch { drift = null; }
  }

  const run = { ran_at: new Date().toISOString(), model, system_chars: system.length, safety_check: !has('no-safety'), summary, drift, results };
  if (has('json')) console.log(JSON.stringify(run, null, 2));
  else {
    console.log(`\n评分：通过 ${pass} · 失败 ${fail} · 待人工 ${unclear} · 失败执行 ${failed}（通过率 ${summary.pass_rate}%）`);
    if (drift) {
      console.log(`drift：新破坏 ${drift.newlyBroken.length ? drift.newlyBroken.join(', ') : '无'} · 已修复 ${drift.fixed.length ? drift.fixed.join(', ') : '无'}`);
    }
    console.log('unclear 的用例补上断言再跑；断言口径 = 包含/排除/正则。');
  }
  if (has('out')) {
    mkdirSync(resolve(val('out')), { recursive: true });
    writeFileSync(join(resolve(val('out')), '结果.json'), JSON.stringify(run, null, 2) + '\n', 'utf-8');
    if (!has('json')) console.log(`结果已写入：${join(resolve(val('out')), '结果.json')}（可作下次 --baseline）`);
  }
  if (has('html')) {
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const rows = results.map((r) => `<tr><td>${r.verdict === 'pass' ? '✅' : r.verdict === 'fail' ? '🚨' : '❓'} ${r.id}</td><td>${r.verdict}</td><td>${esc(r.reason || '')}</td><td><code>${esc((r.output || '').slice(0, 120))}</code></td></tr>`).join('');
    writeFileSync(val('html'), `<!doctype html><meta charset="utf-8"><title>提示词回归报告</title><style>body{font:14px/1.6 -apple-system,sans-serif;margin:24px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:6px 10px;text-align:left;vertical-align:top}th{background:#f5f5f5}code{font-size:12px}</style><h1>提示词回归报告</h1><p>通过率 ${summary.pass_rate}% · fail ${summary.fail} · unclear ${summary.unclear}${drift ? ` · 新破坏 ${drift.newlyBroken.length} · 已修复 ${drift.fixed.length}` : ''} · 模型 ${esc(model)}</p><table><tr><th>用例</th><th>判定</th><th>原因</th><th>回答摘录</th></tr>${rows}</table>`, 'utf-8');
    console.log(`HTML 报告已写入：${val('html')}`);
  }
  process.exit(fail > 0 || failed > 0 ? 1 : 0);
}

console.error('未知子命令：' + cmd);
process.exitCode = 2;
