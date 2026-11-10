/**
 * e2e：javascript-obfuscator 生成的真实混淆样本 → jsseal 管线（识别→封闭→采样→渐进变换→验证）
 * fixtures 由 tools/gen-fixtures.mjs 生成（提交进仓库，hermetic）。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detect } from '@jsseal/detector';
import { deobfuscate } from '@jsseal/core';
import { isEngineAvailable } from '@jsseal/engine-native';

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../transforms/fixtures');

function load(name: string): string {
  return readFileSync(resolve(fixturesDir, name + '.js'), 'utf8');
}

describe('e2e · obfuscator.io 家族', () => {
  it('识别：string array（base64/rc4/全开）与 cff/deadcode 样本', () => {
    for (const name of ['ob-stringarray-base64', 'ob-stringarray-rc4', 'ob-full']) {
      const d = detect(load(name));
      expect(d.family, name).toBe('obfuscator-io');
      expect(d.obfuscatorIO?.decoderNames.length, name).toBeGreaterThan(0);
    }
    expect(detect(load('ob-cff-only')).family).toBe('obfuscator-io');
    expect(detect(load('ob-deadcode-only')).family).not.toBe('plain');
  });

  it(
    'string array (base64)：解码内联 + 锚库验证通过 + 明文回归',
    async () => {
      const code = load('ob-stringarray-base64');
      const report = await deobfuscate({ code, samples: 3, maxRounds: 6 });
      expect(report.corpus.samples).toBeGreaterThan(0);
      expect(report.finalValidation?.pass).toBe(true);
      // 字符串池明文回归
      expect(report.finalCode).toContain('SECRET_KEY_123');
      expect(report.finalCode).toContain('encrypted:');
      expect(report.finalCode).toContain('hello world');
      // 三件套已移除
      expect(report.finalCode).not.toContain('fromCharCode===undefined');
      expect(report.applied.some((a) => a.name === 'inline-decoder')).toBe(true);
    },
    120_000,
  );

  it(
    'string array (rc4)：解码内联',
    async () => {
      const code = load('ob-stringarray-rc4');
      const report = await deobfuscate({ code, samples: 3, maxRounds: 6 });
      expect(report.corpus.samples).toBeGreaterThan(0);
      expect(report.finalValidation?.pass).toBe(true);
      expect(report.finalCode).toContain('SECRET_KEY_123');
    },
    120_000,
  );

  it(
    '全开样本（base64 + 死代码 + CFF + selfDefending + 数字表达式 + 包装层）：行为恒等',
    async () => {
      const code = load('ob-full');
      const report = await deobfuscate({ code, samples: 3, maxRounds: 8 });
      expect(report.corpus.samples).toBeGreaterThan(0);
      expect(report.finalValidation?.pass).toBe(true);
      // M2.4：freeze-string-array（池终态固化 + 删 rotate，消除 decoder 时变性）
      // 解锁 decoder-lookup-table（运行时事实查表），全开样本明文直接回归可见
      expect(report.applied.some((a) => a.name === 'freeze-string-array')).toBe(true);
      // decoder-lookup-table 与其解锁的明文回归依赖 cret trace（native 专属）；
      // wasm 后端仍必须 PASS（恒等性是全平台硬约束），仅还原度断言豁免
      if (isEngineAvailable()) {
        expect(report.applied.some((a) => a.name === 'decoder-lookup-table')).toBe(true);
        expect(report.finalCode).toContain('SECRET_KEY_123');
      }
      const mangleBefore = (code.match(/_0x[0-9a-fA-F]+/g) ?? []).length;
      const mangleAfter = (report.finalCode.match(/_0x[0-9a-fA-F]+/g) ?? []).length;
      expect(report.applied.some((a) => a.name === 'inline-decoder')).toBe(true);
      expect(report.applied.some((a) => a.name === 'demangle-names')).toBe(true);
      expect(mangleAfter).toBeLessThan(mangleBefore / 10);
    },
    180_000,
  );

  it(
    'cff-only：分发器还原',
    async () => {
      const code = load('ob-cff-only');
      const report = await deobfuscate({ code, samples: 3, maxRounds: 6 });
      expect(report.finalValidation?.pass).toBe(true);
      // 分发器显著减少（可能残留对象映射形式，此处只验证结构与行为）
      expect(report.applied.some((a) => a.name === 'unflatten-cff')).toBe(true);
    },
    120_000,
  );

  it(
    'deadcode-only：死代码清除',
    async () => {
      const code = load('ob-deadcode-only');
      const report = await deobfuscate({ code, samples: 3, maxRounds: 6 });
      expect(report.finalValidation?.pass).toBe(true);
      // obfuscator 4.x 的死代码多为常量比较，由 fold-constants/dead-code 协同消灭；
      // 死代码注入本体已被整体清除（产物显著缩小）
      expect(report.finalCode.length).toBeLessThan(code.length);
    },
    120_000,
  );

  it('行为恒等负例：篡改输出后锚库必须拦截', async () => {
    const code = load('ob-stringarray-base64');
    const report = await deobfuscate({ code, samples: 3, maxRounds: 6 });
    // 在"已还原"代码上做语义篡改，用同一锚库验证必须失败
    const tampered = report.finalCode.replace("var key = 'SECRET_KEY_123'", "var key = 'SECRET_KEY_999'");
    if (tampered !== report.finalCode) {
      const { buildCorpus, validateCorpus } = await import('@jsseal/anchors');
      const corpus = await buildCorpus({ code: report.finalCode, samples: 3 });
      const v = await validateCorpus(corpus, tampered);
      expect(v.pass).toBe(false);
    }
  });
});

const nativeDescribe = isEngineAvailable() ? describe : describe.skip;
nativeDescribe('e2e · native 引擎后端（M2.1 回归基线）', () => {
  it(
    'native 后端：rc4 样本完整管线（封闭→采样→变换→验证）与 quickjs 等价',
    async () => {
      const code = load('ob-stringarray-rc4');
      const report = await deobfuscate({ code, samples: 3, maxRounds: 6, backend: 'native' });
      expect(report.corpus.samples).toBeGreaterThan(0);
      expect(report.finalValidation?.pass).toBe(true);
      expect(report.finalCode).toContain('SECRET_KEY_123');
      // 与默认后端产物一致（确定性跨后端验证的第一步）
      const qjsReport = await deobfuscate({ code, samples: 3, maxRounds: 6, backend: 'quickjs' });
      expect(report.finalCode).toBe(qjsReport.finalCode);
    },
    120_000,
  );

  it(
    'native 后端：ob-full（selfDefending/包装层/CFF）行为恒等',
    async () => {
      const code = load('ob-full');
      const report = await deobfuscate({ code, samples: 2, maxRounds: 8, backend: 'native' });
      expect(report.finalValidation?.pass).toBe(true);
      expect(report.applied.some((a) => a.name === 'inline-decoder')).toBe(true);
    },
    180_000,
  );
});

const dynDescribe = isEngineAvailable() ? describe : describe.skip;
dynDescribe('e2e · 动态 CFF（M2.5 执行序探针）', () => {
  it(
    '顺序串来自函数调用（静态失败）→ br trace 命中序 → 恒等重排',
    async () => {
      const code = load('cff-dynamic');
      const report = await deobfuscate({ code, samples: 3, maxRounds: 6 });
      expect(report.finalValidation?.pass).toBe(true);
      expect(report.applied.some((a) => a.name === 'unflatten-cff-dynamic')).toBe(true);
      // 分发器消失，块按真实执行序（2,0,1,3）排列
      expect(report.finalCode).not.toContain('switch');
      expect(report.finalCode).not.toContain('while');
      const b = report.finalCode.indexOf('out += "b"');
      const a = report.finalCode.indexOf('out += "a"');
      const c = report.finalCode.indexOf('out += "c"');
      const d = report.finalCode.indexOf('out += "d"');
      expect(b).toBeGreaterThan(-1);
      expect(a).toBeGreaterThan(b);
      expect(c).toBeGreaterThan(a);
      expect(d).toBeGreaterThan(c);
    },
    120_000,
  );
});

nativeDescribe('e2e · forced execution（G.3 多路径覆盖）', () => {
  it(
    '悬空引用逃逸被强制锚点捕获（单路径覆盖局限的正解实测）',
    async () => {
      const code = `
function heavy() { return 42; }
function f(x) {
  if (x > 10) { return heavy(); }
  return 1;
}
console.log('r=' + f(5));
`;
      // 恶意变换：删除 heavy 定义（其调用点在采样输入下从不执行）
      const killHeavy = {
        name: 'kill-heavy',
        risk: 'unsafe' as const,
        async run(ast: import('@babel/types').File) {
          const { traverse } = await import('@jsseal/ast');
          const t = await import('@babel/types');
          let removed = false;
          traverse(ast, {
            FunctionDeclaration(path: import('@babel/traverse').NodePath<import('@babel/types').FunctionDeclaration>) {
              if (path.node.id?.name === 'heavy') {
                path.remove();
                removed = true;
              }
            },
          });
          return { changed: removed, notes: [`removed=${removed}`] };
        },
      };
      // 普通锚点（forcedBranches=0）下，该破坏性变换会通过验证
      const withoutForce = await deobfuscate({ code, samples: 2, forcedBranches: 0, transforms: [killHeavy] });
      expect(withoutForce.applied.some((a) => a.name === 'kill-heavy')).toBe(true);
      expect(withoutForce.finalValidation?.pass).toBe(true); // ← 单路径盲区
      // 开启强制锚点后，heavy 被强制执行 → ReferenceError → 拦截
      const withForce = await deobfuscate({ code, samples: 2, forcedBranches: 4, transforms: [killHeavy] });
      expect(withForce.forcedAnchors).toBeGreaterThan(0);
      expect(withForce.applied.some((a) => a.name === 'kill-heavy')).toBe(false);
      expect(withForce.rolledBack.some((a) => a.name === 'kill-heavy')).toBe(true);
    },
    120_000,
  );
});

describe('e2e · eval 系家族（M3.1 unfold-eval）', () => {
  it(
    'packer：eval 拦截 → 展开 → 明文回归 + 行为恒等',
    async () => {
      const code = load('packer-basic');
      const report = await deobfuscate({ code, samples: 3, maxRounds: 6 });
      expect(report.detection.family).toBe('packer');
      expect(report.finalValidation?.pass).toBe(true);
      expect(report.applied.some((a) => a.name === 'unfold-eval')).toBe(true);
      expect(report.finalCode).toContain('PACKER_SECRET_42');
      expect(report.finalCode).not.toContain('eval(function(p,a,c,k,e,d)');
    },
    120_000,
  );

  it(
    '简单 eval 链：多层 eval 逐层展开',
    async () => {
      const code = `eval("eval(\\"var k='NESTED_KEY_7'; console.log('n='+k);\\")");`;
      const report = await deobfuscate({ code, samples: 2, maxRounds: 4 });
      expect(report.finalValidation?.pass).toBe(true);
      expect(report.applied.some((a) => a.name === 'unfold-eval')).toBe(true);
      expect(report.finalCode).toContain('NESTED_KEY_7');
    },
    120_000,
  );
});

describe('e2e · ctor 链回填（M3.2）', () => {
  it(
    'X["constructor"]("payload")() → payload 内联（JSFuck 核心形态）',
    async () => {
      const code = `[]["filter"]["constructor"]("console.log('CTOR_CHAIN_OK')")();`;
      const report = await deobfuscate({ code, samples: 2, maxRounds: 4 });
      expect(report.finalValidation?.pass).toBe(true);
      expect(report.applied.some((a) => a.name === 'unfold-ctor-chain')).toBe(true);
      expect(report.finalCode).toContain('CTOR_CHAIN_OK');
      expect(report.finalCode).not.toContain('constructor');
    },
    120_000,
  );
});

describe('e2e · 侦察模式 probe（M3.3）', () => {
  it('obfuscator.io 样本：池明文含 SECRET + 全维度报告', async () => {
    const { probe } = await import('@jsseal/core');
    const r = await probe({ code: load('ob-stringarray-base64') });
    expect(r.family).toBe('obfuscator-io');
    expect(r.run.console.length).toBe(3);
    expect(r.run.consumed.random).toBe(1);
    expect(r.pool).toBeDefined();
    expect(r.pool!.decoded).toBe(true);
    expect(r.pool!.items).toContain('SECRET_KEY_123');
    expect(r.pool!.items).toContain('fromCharCode');
  });

  it('eval + 网络 + 环境缺失样本：三类事实全部捕获', async () => {
    const { probe } = await import('@jsseal/core');
    const code = `
eval("var k='PROBE_KEY'; console.log('k='+k)");
navigator.sendBeacon;
fetch('https://t.example.com/x');
`;
    const r = await probe({ code });
    expect(r.run.evalLog.some((e) => e.includes('PROBE_KEY'))).toBe(true);
    expect(r.run.netLog.map((n) => n.url)).toEqual(['https://t.example.com/x']);
    expect(r.run.envMisses['navigator.sendBeacon']).toBe(1);
  });
});

describe('e2e · JSFuck 核心形态（M4 ctor 链）', () => {
  it('ctor 链展开 + eval 拦截', async () => {
    const code = load('jsfuck');
    const report = await deobfuscate({ code, samples: 2, maxRounds: 4 });
    expect(report.finalValidation?.pass).toBe(true);
    expect(report.applied.some((a) => a.name === 'unfold-ctor-chain')).toBe(true);
    expect(report.finalCode).toContain('JSFUCK_PAYLOAD_OK');
  });

  it(
    'JSFuck 全编码：原子折叠 + ctor 形态 A 静态内联（2.8K 全编码 → 明文）',
    async () => {
      const code = load('jsfuck-full');
      const report = await deobfuscate({ code, samples: 2, maxRounds: 4 });
      expect(report.finalValidation?.pass).toBe(true);
      expect(report.applied.some((a) => a.name === 'fold-jsfuck')).toBe(true);
      expect(report.applied.some((a) => a.name === 'unfold-ctor-chain')).toBe(true);
      expect(report.finalCode).toContain('console.log(1337)');
      // 全编码字符已彻底消失
      expect(report.finalCode).not.toMatch(/[!+\[\]]{8,}/);
    },
    120_000,
  );
});

describe('e2e · 局部函数纯化（POSITIONING §5.1）', () => {
  it('IIFE 包裹的池+解码器：提升纯化 + 行为恒等', async () => {
    const code = `
(function () {
  var pool = ['log', 'SECRET_ALPHA', 'join'];
  function dec(i) { return pool[i]; }
  function biz(x) { return dec(0) + ':' + x; }
  console.log(biz(dec(1)));
})();
`;
    const report = await deobfuscate({ code, samples: 2, maxRounds: 4 });
    expect(report.finalValidation?.pass).toBe(true);
    expect(report.applied.some((a) => a.name === 'purify-closures')).toBe(true);
    // 池被提升到模块顶层（结构可读性：分析员第一行就能看到池内容）
    expect(report.finalCode?.trim().startsWith('var pool')).toBe(true);
  });
});

describe('e2e · 通用纯调用折叠（fold-pure-calls，家族无关）', () => {
  it('purify 提升后的池+解码器 → 无家族检测折叠出明文', async () => {
    const code = `
(function () {
  var pool = ['log', 'SECRET_ALPHA', 'join'];
  function dec(i) { return pool[i]; }
  console.log(dec(0) + ':' + dec(1));
})();
`;
    const report = await deobfuscate({ code, samples: 2, maxRounds: 5 });
    expect(report.finalValidation?.pass).toBe(true);
    // 家族识别为 plain（非 obfuscator-io）——decoder-lookup-table 不适用，
    // 明文完全来自 purify-closures + fold-pure-calls 的家族无关路径
    expect(report.detection.family).toBe('plain');
    expect(report.finalCode).toContain('SECRET_ALPHA');
  });
});
