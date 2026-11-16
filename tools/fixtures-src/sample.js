// 本文件是 javascript-obfuscator 的输入样本（tools/gen-fixtures.mjs 生成已提交夹具
// 的数据源），定位等同于 samples/ 与 packages/transforms/fixtures/ 下的样本数据，
// 而不是可维护源码：它命中的规则都是“作为混淆目标”的固有写法——经典脚本的全局
// 函数声明、XOR 位运算、对称的加/解密实现。因此整文件豁免，不改写代码。
/* oxlint-disable anti-slop/require-readable-spacing, eslint/func-style, eslint/no-bitwise, eslint/no-implicit-globals, eslint/no-plusplus, sonarjs/declarations-in-global-scope, sonarjs/no-identical-functions, typescript/no-unsafe-call, typescript/no-unsafe-member-access, unicorn/prefer-code-point -- 见上：夹具源数据不改写，命中的规则都是混淆目标的固有写法 */

const key = "SECRET_KEY_123";

function encrypt(msg) {
  let out = "";
  for (let i = 0; i < msg.length; i++) {
    out += String.fromCharCode(
      msg.charCodeAt(i) ^ key.charCodeAt(i % key.length)
    );
  }

  return out;
}

function decrypt(msg) {
  let out = "";
  for (let i = 0; i < msg.length; i++) {
    out += String.fromCharCode(
      msg.charCodeAt(i) ^ key.charCodeAt(i % key.length)
    );
  }

  return out;
}

function main() {
  const enc = encrypt("hello world");
  console.log(`encrypted:${enc}`);
  console.log(`decrypted:${decrypt(enc)}`);
  console.log(`token:${Math.random().toString(36).slice(2, 10)}`);

  return "done";
}

main();
