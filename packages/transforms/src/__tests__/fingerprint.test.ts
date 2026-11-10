import { describe, expect, it } from 'vitest';
import { parseCode, printCode } from '@jsseal/ast';
import { extractBranchFingerprints, buildMigration, matchFingerprint } from '../branch-fingerprint';

describe('AST 分支指纹（路径锚定）', () => {
  it('提取条件分支指纹', () => {
    const code = `
var x = 5;
if (x > 10) { console.log("big"); }
if (x < 3) { console.log("small"); }
while (x > 0) { x--; }
for (var i = 0; i < 10; i++) {}
var y = x > 5 ? "a" : "b";
`;
    const ast = parseCode(code);
    const fps = extractBranchFingerprints(ast);
    // 5 个非常量条件分支（if×2 + while + for + ternary）
    expect(fps.length).toBe(5);
  });

  it('恒等变换（beautify/重命名）后指纹稳定', () => {
    const original = `if (x > 10) { console.log("big"); } else { console.log("small"); }`;
    const transformed = `if (x > 10) {\n  console.log("big");\n} else {\n  console.log("small");\n}\n`;
    const fp1 = extractBranchFingerprints(parseCode(original));
    const fp2 = extractBranchFingerprints(parseCode(transformed));
    expect(fp1.length).toBe(1);
    expect(fp2.length).toBe(1);
    expect(fp1[0].hash).toBe(fp2[0].hash);
  });

  it('死代码消除后存活分支的指纹不变', () => {
    const original = `
if ('a' !== 'a') { console.log("dead"); }
if (x > 10) { console.log("alive"); }
if (y < 5) { console.log("also alive"); }
`;
    // fold-constants + dead-code 会消除第一个 if
    const transformed = `
if (x > 10) { console.log("alive"); }
if (y < 5) { console.log("also alive"); }
`;
    const ast1 = parseCode(original);
    const ast2 = parseCode(transformed);
    const migration = buildMigration(ast1, ast2);
    // 常量分支已被指纹提取排除（evaluate 可折叠），原/变换各 2 个非常量
    expect(migration.originalFingerprints.length).toBe(2);
    expect(migration.transformedFingerprints.length).toBe(2);
    // 恒等映射（死代码消除不改存活分支的指纹）
    expect(migration.mapping.get(1)).toBe(1);
    expect(migration.mapping.get(2)).toBe(2);
  });

  it('标识符重命名后指纹变化（保守处理——不映射）', () => {
    const original = `if (x > 10) { console.log("big"); }`;
    const renamed = `if (count > 10) { console.log("big"); }`;
    const ast1 = parseCode(original);
    const ast2 = parseCode(renamed);
    const migration = buildMigration(ast1, ast2);
    // x→count 改变了测试表达式内容 → 指纹不匹配 → 不映射（保守安全）
    expect(migration.mapping.size).toBe(0);
  });
});
