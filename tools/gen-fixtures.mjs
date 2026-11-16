/**
 * 生成 e2e fixtures：用 javascript-obfuscator 对 sample.js 按多种配置混淆。
 * 产物提交进仓库（packages/transforms/fixtures/），保证测试 hermetic。
 *
 * 运行：npm run gen:fixtures
 */

// 本脚本是 .mjs 直跑工具，未纳入任何 tsconfig 项目：node:fs / node:path /
// javascript-obfuscator 在类型感知检查下解析为 error 类型，typescript/no-unsafe-*
// 的报告无法靠改代码消除（需要把脚本纳入 tsconfig 项目，属仓库配置范畴）。
/* oxlint-disable typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return -- 见上：.mjs 脚本不在 tsconfig 项目内，node 内置模块与第三方包为 error 类型 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import JavaScriptObfuscator from "javascript-obfuscator";

const root = path.resolve(import.meta.dirname, "..");

const src = readFileSync(
  path.resolve(root, "tools/fixtures-src/sample.js"),
  "utf-8"
);

const outDir = path.resolve(root, "packages/transforms/fixtures");

mkdirSync(outDir, { recursive: true });

const configs = [
  {
    name: "ob-stringarray-base64",
    options: {
      compact: true,
      stringArray: true,
      stringArrayEncoding: ["base64"],
      stringArrayRotate: true,
      stringArrayShuffle: true,
      stringArrayThreshold: 1,
      deadCodeInjection: false,
      controlFlowFlattening: false,
    },
  },
  {
    name: "ob-stringarray-rc4",
    options: {
      compact: true,
      stringArray: true,
      stringArrayEncoding: ["rc4"],
      stringArrayRotate: true,
      stringArrayShuffle: true,
      stringArrayThreshold: 1,
      deadCodeInjection: false,
      controlFlowFlattening: false,
    },
  },
  {
    name: "ob-full",
    options: {
      compact: true,
      stringArray: true,
      stringArrayEncoding: ["base64"],
      stringArrayRotate: true,
      stringArrayShuffle: true,
      stringArrayThreshold: 1,
      stringArrayWrappersCount: 2,
      stringArrayWrappersType: "function",
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
    name: "ob-cff-only",
    options: {
      compact: true,
      stringArray: false,
      deadCodeInjection: false,
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 1,
    },
  },
  {
    name: "ob-deadcode-only",
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
    identifierNamesGenerator: "hexadecimal",
    disableConsoleOutput: false,
    selfDefending: cfg.options.selfDefending ?? false,
    debugProtection: false,
    domainLock: [],
  });

  const out = result.getObfuscatedCode();

  writeFileSync(path.resolve(outDir, `${cfg.name}.js`), out);
  console.log(`generated ${cfg.name}.js (${out.length} bytes)`);
}

// ---------- packer fixture（Dean Edwards packer 算法，base36） ----------

/** packer 头部单引号串转义（先转义反斜杠再转义单引号） */
const escapePackerString = (s) =>
  s.replaceAll("\\", "\\\\").replaceAll("'", "\\'");

const packPacker = (code) => {
  const matches = code.match(/[a-zA-Z_$][\w$]*/gu) ?? [];

  const words = [...new Set(matches)];
  const a = 36;
  const e = (n) => n.toString(a);

  const p = code.replaceAll(/[a-zA-Z_$][\w$]*/gu, (w) => e(words.indexOf(w)));

  const k = [...words];

  return `eval(function(p,a,c,k,e,d){e=function(c){return c.toString(36)};if(!''.replace(/^/,String)){while(c--){d[e(c)]=k[c]||e(c)}k=[function(e){return d[e]}];e=function(){return'\\\\w+'};c=1};while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}('${escapePackerString(p)}',${a},${k.length},'${escapePackerString(k.join("|"))}'.split('|'),0,{}))`;
};

{
  const payload =
    'var secret="PACKER_SECRET_42";console.log("pv="+secret);console.log("token:"+Math.random().toString(36).slice(2,6));';

  const packed = packPacker(payload);

  writeFileSync(path.resolve(outDir, "packer-basic.js"), packed);
  console.log(`generated packer-basic.js (${packed.length} bytes)`);
}
