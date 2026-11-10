/**
 * 生成 e2e fixtures：用 javascript-obfuscator 对 sample.js 按多种配置混淆。
 * 产物提交进仓库（packages/transforms/fixtures/），保证测试 hermetic。
 *
 * 运行：npm run gen:fixtures
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import JavaScriptObfuscator from 'javascript-obfuscator';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(root, 'tools/fixtures-src/sample.js'), 'utf8');
const outDir = resolve(root, 'packages/transforms/fixtures');
mkdirSync(outDir, { recursive: true });

const configs = [
  {
    name: 'ob-stringarray-base64',
    options: {
      compact: true,
      stringArray: true,
      stringArrayEncoding: ['base64'],
      stringArrayRotate: true,
      stringArrayShuffle: true,
      stringArrayThreshold: 1,
      deadCodeInjection: false,
      controlFlowFlattening: false,
    },
  },
  {
    name: 'ob-stringarray-rc4',
    options: {
      compact: true,
      stringArray: true,
      stringArrayEncoding: ['rc4'],
      stringArrayRotate: true,
      stringArrayShuffle: true,
      stringArrayThreshold: 1,
      deadCodeInjection: false,
      controlFlowFlattening: false,
    },
  },
  {
    name: 'ob-full',
    options: {
      compact: true,
      stringArray: true,
      stringArrayEncoding: ['base64'],
      stringArrayRotate: true,
      stringArrayShuffle: true,
      stringArrayThreshold: 1,
      stringArrayWrappersCount: 2,
      stringArrayWrappersType: 'function',
      deadCodeInjection: true,
      deadCodeInjectionThreshold: 0.4,
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 1,
      numbersToExpressions: true,
      selfDefending: true,
      unicodeEscapeSequence: true,
      renameGlobals: false,
      transformObjectKeys: false,
    },
  },
  {
    name: 'ob-cff-only',
    options: {
      compact: true,
      stringArray: false,
      deadCodeInjection: false,
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 1,
    },
  },
  {
    name: 'ob-deadcode-only',
    options: {
      compact: true,
      stringArray: false,
      deadCodeInjection: true,
      deadCodeInjectionThreshold: 0.5,
      controlFlowFlattening: false,
    },
  },
];

for (const cfg of configs) {
  const result = JavaScriptObfuscator.obfuscate(src, {
    ...cfg.options,
    identifierNamesGenerator: 'hexadecimal',
    disableConsoleOutput: false,
    selfDefending: cfg.options.selfDefending ?? false,
    debugProtection: false,
    domainLock: [],
  });
  const out = result.getObfuscatedCode();
  writeFileSync(resolve(outDir, cfg.name + '.js'), out);
  console.log(`generated ${cfg.name}.js (${out.length} bytes)`);
}

// ---------- packer fixture（Dean Edwards packer 算法，base36） ----------
function packPacker(code) {
  const words = [...new Set(code.match(/[a-zA-Z_$][\w$]*/g) || [])];
  const a = 36;
  const e = (n) => n.toString(a);
  const p = code.replace(/[a-zA-Z_$][\w$]*/g, (w) => e(words.indexOf(w)));
  const k = words.slice();
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `eval(function(p,a,c,k,e,d){e=function(c){return c.toString(36)};if(!''.replace(/^/,String)){while(c--){d[e(c)]=k[c]||e(c)}k=[function(e){return d[e]}];e=function(){return'\\\\w+'};c=1};while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}('${esc(p)}',${a},${k.length},'${esc(k.join('|'))}'.split('|'),0,{}))`;
}
{
  const payload = 'var secret="PACKER_SECRET_42";console.log("pv="+secret);console.log("token:"+Math.random().toString(36).slice(2,6));';
  const packed = packPacker(payload);
  writeFileSync(resolve(outDir, 'packer-basic.js'), packed);
  console.log(`generated packer-basic.js (${packed.length} bytes)`);
}
