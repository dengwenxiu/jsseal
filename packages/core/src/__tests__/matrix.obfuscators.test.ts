/**
 * 混淆器矩阵回归测试：两个官方混淆器（javascript-obfuscator 4.2.2 /
 * js-confuser 2.1.3）的选项组合 → jsseal 全管线。
 *
 * 断言原则："验证正确"是硬约束（必须 PASS），"还原成功"是软约束（SECRET
 * 可见性对已知边界——js-confuser preset 的 dispatcher 间接化 / cff 动态
 * case 标签——按白名单豁免，防止把已知边界误报成回归）。
 */

import { describe, expect, it } from 'vitest';
import JavaScriptObfuscator from 'javascript-obfuscator';
import JsConfuser from 'js-confuser';
import { deobfuscate } from '@jsseal/core';
import { isEngineAvailable } from '@jsseal/engine-native';

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

async function runJsseal(code: string): Promise<{ pass: boolean; secret: boolean }> {
  const report = await deobfuscate({ code, samples: 2, maxRounds: 4 });
  return {
    pass: report.finalValidation?.pass === true,
    secret: (report.finalCode ?? '').includes('SECRET_TOKEN_ABC123'),
  };
}

describe('矩阵 · javascript-obfuscator 4.2.2', () => {
  const obBase = { compact: true, simplify: true, renameGlobals: false, seed: 42 };
  const cases: Array<[string, Record<string, unknown>]> = [
    ['sa-base64', { stringArray: true, stringArrayEncoding: ['base64'] }],
    ['sa-rc4-shuffle', { stringArray: true, stringArrayEncoding: ['rc4'], stringArrayShuffle: true, stringArrayRotate: true, stringArrayIndexShift: true }],
    ['cff', { controlFlowFlattening: true }],
    ['deadcode+numbers', { deadCodeInjection: true, numbersToExpressions: true }],
    ['objectkeys+split', { transformObjectKeys: true, splitStrings: true, splitStringsChunkLength: 3 }],
    ['all-on-rc4', { stringArray: true, stringArrayEncoding: ['rc4'], stringArrayShuffle: true, stringArrayRotate: true, stringArrayIndexShift: true, controlFlowFlattening: true, deadCodeInjection: true, numbersToExpressions: true, selfDefending: true, identifierNamesGenerator: 'hexadecimal' }],
  ];

  for (const [name, extra] of cases) {
    it(`${name}：PASS + SECRET 可见`, { timeout: 120_000, retry: 0 }, async () => {
      const code = JavaScriptObfuscator.obfuscate(BUSINESS, { ...obBase, ...extra }).getObfuscatedCode();
      const r = await runJsseal(code);
      expect(r.pass, `${name} 行为恒等`).toBe(true);
      expect(r.secret, `${name} SECRET 明文`).toBe(true);
    });
  }
});

describe('矩阵 · js-confuser 2.1.3', () => {
  // jsconfuser-strings 的还原依赖 cret trace（native 专属）；wasm 后端仍必须
  // PASS（恒等性是全平台硬约束），仅 SECRET 明文断言按后端动态豁免
  const native = isEngineAvailable();
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    // [名, 选项, SECRET 必须可见]（false = 已知边界：dispatcher 间接化 / cff 动态 case）
    ['stringConcealing(Base91)', { stringConcealing: true }, native],
    ['stringEncoding', { stringEncoding: true }, true],
    ['dispatcher', { dispatcher: true }, true],
    ['objectExtraction', { objectExtraction: true }, true],
    ['variableMasking', { variableMasking: true }, true],
    ['pack', { pack: true }, true],
    ['preset-low', { preset: 'low' }, false],
    ['cff(动态 case)', { controlFlowFlattening: true }, false],
  ];

  for (const [name, opts, expectSecret] of cases) {
    it(`${name}：PASS${expectSecret ? ' + SECRET 可见' : '（明文按已知边界豁免）'}`, { timeout: 120_000 }, async () => {
      const r0 = await JsConfuser.obfuscate(BUSINESS, { target: 'browser', ...opts });
      const code = typeof r0 === 'string' ? r0 : r0.code;
      const r = await runJsseal(code);
      expect(r.pass, `${name} 行为恒等`).toBe(true);
      if (expectSecret) expect(r.secret, `${name} SECRET 明文`).toBe(true);
    });
  }
});
