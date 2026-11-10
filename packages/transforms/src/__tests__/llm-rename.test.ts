import { describe, expect, it } from 'vitest';
import { parseCode, printCode } from '@jsseal/ast';
import { createLLMRenameTransform } from '../llm-rename';
import { buildCorpus, validateCorpus } from '@jsseal/anchors';
import type { TransformContext } from '../types';

const sample = `
var _0x4a3b = "SECRET_KEY_123";
var _0x5c6d = 5;
function _0x7e8f(msg) {
  var _0x9a1b = msg.charCodeAt(0);
  return _0x9a1b + _0x5c6d;
}
console.log(_0x4a3b);
console.log(_0x7e8f("hello"));
`;

describe('LLM 辅助重命名（mock provider）', () => {
  it('mock 后端：启发式命名 + 行为恒等验证', async () => {
    const transform = createLLMRenameTransform({ provider: 'mock' });
    const code = sample;
    const corpus = await buildCorpus({ code, samples: 2 });
    const ctx: TransformContext = {
      code,
      detection: { family: 'plain', confidence: 0.5, features: [] },
      backend: 'native',
      corpus,
    };
    const ast = parseCode(code);
    const r = await transform.run(ast, ctx);
    expect(r.changed).toBe(true);
    expect(r.notes[0]).toMatch(/^renamed=\d+$/);
    // 大部分标识符被重命名（函数名可能保留——fn.name 属性可观测）
    const out = printCode(ast);
    const mangled = (out.match(/_0x[0-9a-fA-F]+/g) ?? []).length;
    expect(mangled).toBeLessThanOrEqual(2); // 函数名残留（声明+调用各 1 次）
    // 行为恒等
    const v = await validateCorpus(corpus, out);
    expect(v.pass).toBe(true);
  });

  it('mock 后端：charCodeAt 使用 → charBuf 命名', async () => {
    const transform = createLLMRenameTransform({ provider: 'mock' });
    const code = `
var _0xa1b2 = "test";
var _0xc3d4 = _0xa1b2.charCodeAt(0);
console.log(_0xc3d4);
`;
    const corpus = await buildCorpus({ code, samples: 2 });
    const ctx: TransformContext = { code, detection: { family: 'plain', confidence: 0.5, features: [] }, backend: 'native', corpus };
    const ast = parseCode(code);
    const r = await transform.run(ast, ctx);
    expect(r.changed).toBe(true);
    const out = printCode(ast);
    // charCodeAt 使用应被命名为 charBuf
    expect(out).toContain('charBuf');
  });

  it('无混淆标识符时跳过', async () => {
    const transform = createLLMRenameTransform({ provider: 'mock' });
    const code = `var normalName = 1; console.log(normalName);`;
    const ctx: TransformContext = { code, detection: { family: 'plain', confidence: 0.5, features: [] }, backend: 'native' };
    const ast = parseCode(code);
    const r = await transform.run(ast, ctx);
    expect(r.changed).toBe(false);
  });
});
