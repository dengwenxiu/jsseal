#!/usr/bin/env node
/**
 * JsConfuser（js-confuser 2.1.3）矩阵压力测试 —— 第二家族盲区探测。
 *
 * 与 obfuscator.io 矩阵相同的判定维度：pass / secret / hex / ratio
 * 额外记录 rolledBack 明细与 corpus 状态（区分"我们的 bug" vs "混淆产物本身不可封闭"）3
 */

// 本脚本是 .mjs 直跑工具，未纳入任何 tsconfig 项目：js-confuser 与
// packages/*/dist 的导入在类型感知检查下解析为 error 类型，
// typescript/no-unsafe-* 的报告无法靠改代码消除（需把脚本纳入 tsconfig 项目）。
/* oxlint-disable typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return -- 见上：.mjs 脚本不在 tsconfig 项目内，导入模块与 catch 变量为 error/any 类型 */

import JsConfuser from "js-confuser";

import { deobfuscate } from "../packages/core/dist/index.js";
import { runSealed } from "../packages/runtime/dist/index.js";

const BUSINESS = `
const API_HOST = 'https://api.example.com';
function buildQuery(params) {
  const parts = [];
  for (const k in params) { parts.push(k + '=' + encodeURIComponent(params[k])); }
  return parts.join('&');
}
function signRequest(path, query) {
  const token = 'SECRET_TOKEN_ABC123';
  const raw = path + '?' + query + token;
  let h = 0;
  for (let i = 0; i < raw.length; i++) { h = (h * 31 + raw.charCodeAt(i)) | 0; }
  return 'sig_' + h;
}
function main() {
  const q = buildQuery({ user: 'virjar', page: '2' });
  const sig = signRequest('/list', q);
  console.log('REQ ' + API_HOST + '/list?' + q);
  console.log('SIG ' + sig);
}
main();
`;

/** @type {Array<[string, Record<string, unknown>]>} 变体名 + 混淆选项 */
const MATRIX = [
  ["preset-low", { preset: "low" }],
  ["preset-medium", { preset: "medium" }],
  ["preset-high", { preset: "high" }],
  ["stringConcealing", { stringConcealing: true }],
  ["stringEncoding", { stringEncoding: true }],
  ["stringSplitting", { stringSplitting: true }],
  ["cff", { controlFlowFlattening: true }],
  ["dispatcher", { dispatcher: true }],
  ["rgf", { rgf: true }],
  ["objectExtraction", { objectExtraction: true }],
  ["flatten", { flatten: true }],
  ["deadCode", { deadCode: true }],
  ["calculator", { calculator: true }],
  ["opaquePredicates", { opaquePredicates: true }],
  ["variableMasking", { variableMasking: true }],
  ["movedDeclarations", { movedDeclarations: true }],
  ["astScrambler", { astScrambler: true }],
  ["pack", { pack: true }],
  ["globalConcealing", { globalConcealing: true }],
  ["dupLit", { duplicateLiteralsRemoval: true }],
  [
    "combo-core",
    {
      stringConcealing: true,
      controlFlowFlattening: true,
      calculator: true,
      hexadecimalNumbers: true,
    },
  ],
];

const rows = [];

for (const [name, extra] of MATRIX) {
  let code;

  try {
    // oxlint-disable-next-line eslint/no-await-in-loop -- 逐变体串行混淆：需稳定输出顺序与内存占用，便于复现
    const r = await JsConfuser.obfuscate(BUSINESS, {
      target: "browser",
      ...extra,
    });

    // obfuscate() 按类型契约（ObfuscationResult）总是返回对象，.code 即产物
    ({ code } = r);
  } catch (error) {
    rows.push({ name, error: `obfuscate: ${error.message.slice(0, 100)}` });
    continue;
  }

  // 基线：混淆产物能否在封闭环境正常运行（区分混淆器产物问题 vs 我们的管线问题）
  let baselineOk = null;

  try {
    // oxlint-disable-next-line eslint/no-await-in-loop -- 基线运行必须逐变体串行，与后续管线共用同一封闭运行时
    const base = await runSealed({ code, mode: "record", backend: "native" });
    baselineOk = base.ok && base.console.some((c) => c.text.includes("SIG"));
  } catch {
    baselineOk = false;
  }

  const t0 = Date.now();

  try {
    // oxlint-disable-next-line eslint/no-await-in-loop -- 逐变体串行跑完整管线：需稳定耗时统计，且并行会干扰锚库采样
    const report = await deobfuscate({ code, samples: 3, maxRounds: 5 });
    const out = report.finalCode ?? "";
    rows.push({
      name,
      baselineOk,
      pass: report.finalValidation?.pass === true,
      secret: out.includes("SECRET_TOKEN_ABC123"),
      hex: (out.match(/_0x[a-f0-9]+/gu) ?? []).length,
      ratio: (out.length / code.length).toFixed(2),
      applied: [...new Set(report.applied.map((a) => a.name))],
      rolled: report.rolledBack.map((r) => r.name),
      ms: Date.now() - t0,
    });
  } catch (error) {
    rows.push({
      name,
      baselineOk,
      error: `deobfuscate: ${error.message.slice(0, 100)}`,
      ms: Date.now() - t0,
    });
  }

  console.error(`${name} done`);
}

console.log("\n=== JsConfuser 矩阵压力测试结果 ===");

console.log(
  `${"variant".padEnd(20) + "base".padEnd(6) + "pass".padEnd(6) + "secret".padEnd(7) + "hex".padEnd(6) + "ratio".padEnd(7)}ms`
);

let full = 0;

for (const r of rows) {
  if (r.error !== undefined) {
    console.log(
      `${r.name.padEnd(20)}${String(r.baselineOk).padEnd(6)}ERROR: ${r.error}`
    );
    continue;
  }

  // rows 是成功行/错误行两种形状的联合（错误行已 continue），Boolean() 把
  // 可能缺失的布尔字段收敛成 boolean，后续条件无需再考虑 undefined
  // oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- 联合形状下字段可能缺失（undefined），此处保留显式收敛以保证下游条件为 boolean
  const ok = Boolean(r.pass && r.secret && r.baselineOk);

  if (ok) {
    full += 1;
  }

  console.log(
    r.name.padEnd(20) +
      String(r.baselineOk).padEnd(6) +
      String(r.pass).padEnd(6) +
      String(r.secret).padEnd(7) +
      String(r.hex).padEnd(6) +
      r.ratio.padEnd(7) +
      String(r.ms) +
      (ok ? "" : "  ←⚠️")
  );

  if (!ok && (r.rolled?.length ?? 0) > 0) {
    console.log(`    rolled: ${r.rolled.join(", ")}`);
  }
}

console.log(
  `\n${full}/${rows.length} 完全成功（baseline OK + PASS + SECRET 可见）`
);
