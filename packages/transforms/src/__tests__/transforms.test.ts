import { describe, expect, it } from 'vitest';
import { parseCode, printCode } from '@jsseal/ast';
import type { Detection } from '@jsseal/detector';
import type { TransformContext } from '../types';
import { foldConstants } from '../fold-constants';
import { memberNormalize } from '../member-normalize';
import { deadCode } from '../dead-code';
import { splitSequences } from '../sequences';
import { inlineProxyFunctions } from '../proxy-inline';
import { unflattenCff } from '../unflatten-cff';
import { demangleNames } from '../demangle';
import { foldJsfuck } from '../fold-jsfuck';
import { purifyClosures } from '../purify-closures';

const plainDetection: Detection = { family: 'plain', confidence: 0.5, features: [] };

function ctx(code = ''): TransformContext {
  return { code, detection: plainDetection, backend: 'quickjs' };
}

async function apply(t: { run: (ast: never, ctx: TransformContext) => Promise<{ changed: boolean; notes: string[] }> }, code: string): Promise<string> {
  const ast = parseCode(code);
  await t.run(ast as never, ctx(code));
  return printCode(ast);
}

describe('transforms 单测', () => {
  it('fold-constants：数字表达式/布尔混淆/字符串拼接', async () => {
    const out = await apply(foldConstants, `var a = 0x14f * 0x2 + -0x1b0; var b = !![]; var c = !+[] + !+[]; var d = 'x' + 'y';`);
    expect(out).toContain('a = 238');
    expect(out).toContain('b = true');
    expect(out).toContain(`"xy"`);
  });

  it('member-normalize：bracket → dot', async () => {
    const out = await apply(memberNormalize, `a['foo'](); b['not-id'](); c['$valid_1']++;`);
    expect(out).toContain('a.foo()');
    expect(out).toContain(`b['not-id']()`);
    expect(out).toContain('c.$valid_1++');
  });

  it('dead-code：常量 if 折叠 + 不可达语句删除', async () => {
    const out = await apply(deadCode, `function f(){ if ('a' !== 'a') { junk(); } return 1; var dead = 2; }`);
    expect(out).not.toContain('junk');
    expect(out).not.toContain('dead');
  });

  it('split-sequences：语句级序列拆分', async () => {
    const out = await apply(splitSequences, `function f(){ (a(), b(), c()); return (x(), y); }`);
    expect(out).toContain('a();');
    expect(out).toContain('b();');
    expect(out).toContain('c();');
    expect(out).toContain('x();');
    expect(out).toContain('return y;');
  });

  it('inline-proxy-functions：转发壳内联', async () => {
    const out = await apply(inlineProxyFunctions, `function p(a, b) { return real(a, b); } function caller() { return p(1, 2); } function real(a, b) { return a + b; }`);
    expect(out).toContain('real(1, 2)');
    expect(out).not.toContain('function p(');
  });

  it('unflatten-cff：标准分发器还原', async () => {
    const code = `
function work() {
  var out = '';
  var seq = '2|0|1'.split('|'), i = 0;
  while (!![]) {
    switch (seq[i++]) {
      case '0':
        out += 'a';
        continue;
      case '1':
        out += 'c';
        continue;
      case '2':
        out += 'b';
        continue;
    }
    break;
  }
  return out;
}`;
    const out = await apply(unflattenCff, code);
    expect(out).not.toContain('switch');
    expect(out).not.toContain(`'2|0|1'`);
    // 顺序必须按 2,0,1 → b a c
    const b = out.indexOf("out += 'b'");
    const a = out.indexOf("out += 'a'");
    const c = out.indexOf("out += 'c'");
    expect(b).toBeGreaterThan(-1);
    expect(a).toBeGreaterThan(b);
    expect(c).toBeGreaterThan(a);
  });

  it('demangle：hex 名重命名', async () => {
    const out = await apply(demangleNames, `var _0x4a3b = 1; function _0xdead(_0xfeed) { return _0xfeed + _0x4a3b; }`);
    expect(out).not.toMatch(/_0x/);
    expect(out).toMatch(/v_\d+/);
  });
});

describe('fold-jsfuck 单测', () => {
  it('charset 原子折叠为字面量（字符访问 + 拼接）', async () => {
    const out = await apply(foldJsfuck, `var s = (![]+[])[+!+[]]+(![]+[])[+[]];`);
    expect(out).toContain(`"af"`);
  });

  it('数字原子折叠 + 调用根保持（payload 执行调用禁止求值）', async () => {
    const out = await apply(foldJsfuck, `var n = +[]+!+[]; foo((![]+[])[+[]]);`);
    expect(out).toContain('n = 1');
    expect(out).toContain('foo("f")');
  });

  it('函数/对象结果跳过（[]["filter"] 保持原样）', async () => {
    const out = await apply(foldJsfuck, `[][((![]+[])[+[]]+(!+[]+[])[+!+[]+!+[]+!+[]+!+[]]+(![]+[])[+!+[]+!+[]]+(![]+[])[+!+[]+!+[]])];`);
    // []["truefalse..."]——成员访问求值为 undefined 也回填为 undefined? 不：undefined 不在回填类型内
    expect(out).toContain('[');
  });
});

describe('purify-closures 单测', () => {
  it('提升策略：单赋值字面量捕获 + 函数搬移到模块顶层', async () => {
    const out = await apply(purifyClosures, `(function(){ var pool=['a','b']; function dec(i){return pool[i];} console.log(dec(1)); })();`);
    // 池与函数都到模块顶层（第一行是 var 声明；IIFE 内不再有 function 声明）
    expect(out.trim().startsWith('var pool')).toBe(true);
    expect(out).toContain('function dec(i)');
    expect((out.match(/var pool/g) ?? []).length).toBe(1);
  });

  it('参数化策略：重赋值捕获变为前导参数（时间语义保持）', async () => {
    const out = await apply(purifyClosures, `(function(){ var c=0; function f(){ return 'v'+c; } c=5; console.log(f()); })();`);
    expect(out).toContain('function f(c)');
    expect(out).toContain('f(c)');
  });

  it('递归自引用不是捕获（自引用漏网曾致二次 remove 崩溃）', async () => {
    const out = await apply(purifyClosures, `(function(){ var m=[1,2]; function r(i){ if(i<=0) return 0; return m[i-1]+r(i-1); } console.log(r(2)); })();`);
    expect(out.trim().startsWith('var m')).toBe(true);
    expect(out.match(/function r\(/g)?.length).toBe(1);
  });

  it('安全栅栏：逃逸（return F）/ F 内写捕获 → 不动', async () => {
    const escape = await apply(purifyClosures, `(function(){ var p=[1]; function d(i){return p[i];} return d; })()()(0);`);
    expect(escape).toContain('(function');
    const written = await apply(purifyClosures, `(function(){ var c=0; function f(){ return c++; } f(); })();`);
    expect(written).toContain('c++');
  });
});
