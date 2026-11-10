#!/usr/bin/env node
/**
 * 混淆器矩阵压力测试：javascript-obfuscator 4.2.2 各选项组合 → jsseal 全管线。
 *
 * 判定维度（不止 PASS——"验证正确 ≠ 还原成功"）：
 *   pass        锚库行为恒等
 *   secret      SECRET_TOKEN_ABC123 明文在产物中可见（还原度核心指标）
 *   _0x         hex 名残留数（越少越好）
 *   size        输入/产物大小比
 */

import JavaScriptObfuscator from 'javascript-obfuscator';
import { deobfuscate } from '../packages/core/dist/index.js';

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

const MATRIX = [
  ['sa-base64', { stringArray: true, stringArrayEncoding: ['base64'] }],
  ['sa-rc4', { stringArray: true, stringArrayEncoding: ['rc4'] }],
  ['sa-rc4-shuffle', { stringArray: true, stringArrayEncoding: ['rc4'], stringArrayShuffle: true, stringArrayRotate: true, stringArrayIndexShift: true, stringArrayAlphabetShuffle: true }],
  ['cff', { compact: true, controlFlowFlattening: true }],
  ['cff+sa-base64', { compact: true, controlFlowFlattening: true, stringArray: true, stringArrayEncoding: ['base64'] }],
  ['deadcode', { compact: true, deadCodeInjection: true }],
  ['selfdefending', { compact: true, selfDefending: true }],
  ['debugprotection', { compact: true, debugProtection: true }],
  ['numbers', { compact: true, numbersToExpressions: true }],
  ['splitstrings', { compact: true, splitStrings: true, splitStringsChunkLength: 3, stringArray: true, stringArrayEncoding: ['base64'] }],
  ['objectkeys', { compact: true, transformObjectKeys: true, stringArray: true, stringArrayEncoding: ['base64'] }],
  ['unicode', { compact: true, unicodeEscapeSequence: true }],
  ['sa-calls-transform', { compact: true, stringArray: true, stringArrayEncoding: ['base64'], stringArrayCallsTransform: true, stringArrayCallsTransformThreshold: 1 }],
  ['all-on', { compact: true, stringArray: true, stringArrayEncoding: ['base64'], stringArrayShuffle: true, stringArrayRotate: true, stringArrayIndexShift: true, controlFlowFlattening: true, deadCodeInjection: true, numbersToExpressions: true, splitStrings: true, splitStringsChunkLength: 5, transformObjectKeys: true, unicodeEscapeSequence: true, selfDefending: true, identifierNamesGenerator: 'hexadecimal' }],
  ['all-on-rc4', { compact: true, stringArray: true, stringArrayEncoding: ['rc4'], stringArrayShuffle: true, stringArrayRotate: true, stringArrayIndexShift: true, controlFlowFlattening: true, deadCodeInjection: true, numbersToExpressions: true, selfDefending: true, identifierNamesGenerator: 'hexadecimal' }],
];

const base = { compact: true, simplify: true, renameGlobals: false, selfDefending: false, identifierNamesGenerator: 'hexadecimal' };

const rows = [];
for (const [name, extra] of MATRIX) {
  const cfg = { ...base, ...extra };
  let code;
  try {
    code = JavaScriptObfuscator.obfuscate(BUSINESS, { ...cfg, seed: 7 }).getObfuscatedCode();
  } catch (e) {
    rows.push({ name, error: `obfuscate: ${e.message}` });
    continue;
  }
  const t0 = Date.now();
  try {
    const report = await deobfuscate({ code, samples: 3, maxRounds: 5 });
    const out = report.finalCode ?? '';
    rows.push({
      name,
      pass: report.finalValidation?.pass === true,
      secret: out.includes('SECRET_TOKEN_ABC123'),
      hex: (out.match(/_0x[a-f0-9]+/g) ?? []).length,
      ratio: (out.length / code.length).toFixed(2),
      applied: [...new Set(report.applied.map((a) => a.name))].length,
      rolled: report.rolledBack.length,
      ms: Date.now() - t0,
    });
  } catch (e) {
    rows.push({ name, error: `deobfuscate: ${e.message.slice(0, 120)}`, ms: Date.now() - t0 });
  }
  console.error(`${name} done in ${Date.now() - t0}ms`);
}

// ---------- 汇总 ----------
console.log('\n=== 矩阵压力测试结果 ===');
const head = 'variant'.padEnd(20) + 'pass'.padEnd(6) + 'secret'.padEnd(7) + 'hex'.padEnd(6) + 'ratio'.padEnd(7) + 'appl'.padEnd(5) + 'roll'.padEnd(5) + 'ms';
console.log(head);
let fail = 0;
for (const r of rows) {
  if (r.error) { console.log(`${r.name.padEnd(20)}ERROR: ${r.error}`); fail++; continue; }
  const bad = !r.pass || !r.secret;
  if (bad) fail++;
  console.log(
    r.name.padEnd(20) +
    String(r.pass).padEnd(6) +
    String(r.secret).padEnd(7) +
    String(r.hex).padEnd(6) +
    String(r.ratio).padEnd(7) +
    String(r.applied).padEnd(5) +
    String(r.rolled).padEnd(5) +
    String(r.ms) + (bad ? '  ←⚠️' : ''),
  );
}
console.log(`\n${rows.length - fail}/${rows.length} 完全成功（PASS + SECRET 可见）`);
