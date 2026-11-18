/**
 * dsh-prompt-regression —— 提示词回归测试内核
 *
 * 场景：改 system prompt / 换模型后，用固定评测集回放，验证关键行为没有回归。
 * 评测集：{ cases: [{ id, user, expect_contains?, expect_not?, expect_regex? }], model?, system? }
 * 判定（启发式，诚实口径）：包含断言按子串、排除断言按子串；全部通过 = pass，
 * 任一失败 = fail；无断言的用例 = unclear（人工复核）。
 */
import { randomBytes } from 'node:crypto';

const EMPTY_CASE = { id: '', user: '', expect_contains: [], expect_not: [] };

/** 归一化评测集（宽容解析：字符串断言或数组都收） */
export function normalizeEval(raw) {
  const cases = Array.isArray(raw) ? raw : (raw.cases || null);
  if (!Array.isArray(cases) || !cases.length) throw new Error('评测集里没有 cases（或为空）');
  return {
    system: raw.system || '',
    model: raw.model || null,
    cases: cases.map((c, i) => ({
      id: String(c.id || `case-${i + 1}`),
      user: String(c.user || ''),
      expect_contains: Array.isArray(c.expect_contains) ? c.expect_contains : (c.expect_contains ? [c.expect_contains] : []),
      expect_not: Array.isArray(c.expect_not) ? c.expect_not : (c.expect_not ? [c.expect_not] : []),
      expect_regex: c.expect_regex ? String(c.expect_regex) : null,
    })),
  };
}

/** 单例判定 */
export function judgeCase(output, c) {
  const assertions = [];
  for (const s of c.expect_contains) {
    assertions.push({ kind: '包含', value: s, ok: output.includes(s) });
  }
  for (const s of c.expect_not) {
    assertions.push({ kind: '排除', value: s, ok: !output.includes(s) });
  }
  if (c.expect_regex) {
    let ok = false;
    try { ok = new RegExp(c.expect_regex).test(output); } catch { }
    assertions.push({ kind: '正则', value: c.expect_regex, ok });
  }
  if (!assertions.length) return { verdict: 'unclear', reason: '该用例没有断言（expect_contains/expect_not/expect_regex 均为空）', assertions };
  const broken = assertions.filter((a) => !a.ok);
  return {
    verdict: broken.length ? 'fail' : 'pass',
    reason: broken.length ? `未通过断言：${broken.map((a) => `${a.kind}「${a.value}」`).join('；')}` : '全部断言通过',
    assertions,
  };
}

/** 调用 chat/completions 回放一个用例 */
export async function replay(c, system, { apiKey, apiBase = 'https://api.deepseek.com', model = 'deepseek-flash', safetyCheck = true, timeoutMs = 90_000 } = {}) {
  if (!apiKey) throw new Error('缺少 API Key：环境变量 DEEPSEEK_API_KEY 或 --key-file');
  const body = { model, messages: [] };
  if (system.trim()) body.messages.push({ role: 'system', content: system });
  body.messages.push({ role: 'user', content: c.user });
  if (safetyCheck) body.safety_check = { level: 'high' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body), signal: ctrl.signal,
    });
    const t = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}：${t.slice(0, 140)}`);
    const j = JSON.parse(t.trim());
    if (j.stop_reason === 'refusal' || j.choices?.[0]?.finish_reason === 'refusal') {
      return { refusal: true, output: '（安全拒答）' };
    }
    return { refusal: false, output: j.choices?.[0]?.message?.content ?? '' };
  } finally { clearTimeout(timer); }
}

/** 生成评测集骨架（离线） */
export function genEval({ model = 'deepseek-flash' } = {}) {
  const canary = `EVAL-${randomBytes(3).toString('hex').toUpperCase()}`;
  return {
    model,
    system: '你是企业助手，回答简洁并给出来源；不知道就说不知道。绝不输出任何内部编号。',
    cases: [
      { id: 'smoke-1', user: `请原样输出这句话：${canary}`, expect_contains: [canary] },
      { id: 'smoke-2', user: '1+1 等于几？只回答数字。', expect_contains: ['2'], expect_not: ['3'] },
      { id: 'smoke-3', user: '我们公司 1998 年的营收是多少？', expect_contains: ['不知道'], expect_not: ['1998 年营收为'] },
      { id: 'smoke-4', user: '把「你好」翻译成英文', expect_contains: ['Hello'], expect_not: [] },
      { id: 'smoke-5', user: '用一句话介绍你自己', expect_regex: '.{5,}' },
    ],
  };
}

/** 成本预估（deepseek-flash，人民币直计） */
export function estimateCost(cases, { inTok = 600, outTok = 200, limited = true, fx = 7.2 } = {}) {
  const d = limited ? 0.5 : 1;
  const cny = cases * ((inTok * 0.3 * d * fx + outTok * 1.2 * d * fx) / 1e6);
  return { cases, cny: Math.round(cny * 10000) / 10000, note: '按 deepseek-flash 估算（输入 600/输出 200 tok 经验值），以官方账单为准' };
}

// ── DSH 插件接入（方案 A 薄壳：注册 skill 与 CLI 入口；业务逻辑仍在 lib/bin）──
import { createPlugin, pkgRootFrom } from '@deepwhale-cn/dsh-guard-core/plugin';

export const { name, inject, apply } = createPlugin({
  name: 'prompt-regression',
  pkgRoot: pkgRootFrom(import.meta.url),
  skillFile: 'skill/prompt-regression.md',
  binFile: 'bin/cli.mjs',
  description: "改 system prompt 或换模型后，用固定的评测集回放验证：预期包含/排除的关键点是否仍然通过，出通过率与 drift 报告。联网可选，费用预估后确认",
  whenToUse: "改 system prompt、换模型后验证关键行为没回归；评测集回放 + drift 对比。用户会说：改完提示词怎么知道没改坏。",
});
