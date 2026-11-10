import { describe, expect, it } from 'vitest';
import { parseCode } from '@jsseal/ast';
import { KNOWLEDGE, buildCaptureScript } from '../index';
import { auditEnv } from '../audit';

describe('认知库 schema 自检', () => {
  it('条目 id 唯一且 expr/capture 皆可解析', () => {
    const ids = new Set(KNOWLEDGE.map((k) => k.id));
    expect(ids.size).toBe(KNOWLEDGE.length);
    for (const k of KNOWLEDGE) {
      expect(() => parseCode(`(${k.expr})`), k.id).not.toThrow();
      expect(() => parseCode(`var v = (${k.capture});`), k.id).not.toThrow();
    }
  });

  it('三类条目齐全（存在性/一致性/行为级）', () => {
    const cats = new Set(KNOWLEDGE.map((k) => k.category));
    for (const c of ['navigator', 'window', 'document', 'screen', 'consistency', 'behavior']) expect(cats.has(c as never)).toBe(true);
  });

  it('真机采集脚本可解析（认知库单一事实源派生）', () => {
    expect(() => parseCode(buildCaptureScript('chrome-mac'))).not.toThrow();
    expect(buildCaptureScript()).toContain('env-snapshot-');
  });
});

describe('环境审计（认知库 → 封闭环境）', () => {
  it('wasm 后端可审计且 high 缺口为 0（prelude 拟真形态生效）', { timeout: 60_000 }, async () => {
    const r = await auditEnv({ backend: 'quickjs' });
    expect(r.total).toBe(KNOWLEDGE.length);
    expect(r.aligned).toBeGreaterThanOrEqual(KNOWLEDGE.length - 5); // 引擎边界（Intl 等）允许有限缺口
    expect(r.highOpen).toBe(0);
    // 内部槽与原型链（平面对象 stub 的天敌）必须对齐
    const ids = new Set(r.failures.map((f) => f.id));
    expect(ids.has('behav-navigator-tostring-tag')).toBe(false);
    expect(ids.has('behav-navigator-prototype')).toBe(false);
    expect(ids.has('win-chrome-obj')).toBe(false);
  });

  it('样本执行后审计（风控实际看到的环境）：defineProperty 篡改被如实报告', { timeout: 60_000 }, async () => {
    // 注：普通赋值 navigator.webdriver = true 会静默失败——原型 getter 无 setter，
    // 与真实浏览器行为一致（拟真形态的副作用，sloppy 赋值不生效不抛错）
    const r = await auditEnv({
      code: [
        "Object.defineProperty(navigator, 'webdriver', { value: true, configurable: true });",
        "Object.defineProperty(navigator, 'userAgent', { value: 'fake-agent', configurable: true });",
      ].join('\n'),
      backend: 'quickjs',
    });
    const ids = new Set(r.failures.map((f) => f.id));
    expect(ids.has('nav-webdriver-false')).toBe(true); // 值篡改被报告
    expect(ids.has('behav-navigator-getter')).toBe(true); // own 数据属性触发原型形态检查（getter 应在原型上）
  }, 120_000);
});

describe('插桩旁路与访问图谱（instrument/envTrace）', () => {
  it('dbg 闭包通道：输出进 debugLog，不污染 console 输出向量', { timeout: 60_000 }, async () => {
    const { runSealed } = await import('@jsseal/runtime');
    const base = await runSealed({
      code: `console.log('biz:', 1);`,
      mode: 'record', backend: 'quickjs',
    });
    const withInst = await runSealed({
      code: `console.log('biz:', 1);`,
      mode: 'record', backend: 'quickjs',
      instrument: `dbg('旁路观察', 42);`,
    });
    // 插桩不改变可观测行为（console 向量逐位一致）
    expect(JSON.stringify(withInst.console)).toBe(JSON.stringify(base.console));
    expect(withInst.debugLog).toEqual(['"旁路观察" 42']);
  });

  it('插桩抛错不炸运行（容错进 debugLog）', { timeout: 60_000 }, async () => {
    const { runSealed } = await import('@jsseal/runtime');
    const out = await runSealed({
      code: `console.log('still-ok');`,
      mode: 'record', backend: 'quickjs',
      instrument: `dbg('a'); var x = NotDefined; dbg('b');`,
    });
    expect(out.ok).toBe(true);
    expect(out.console.map((c) => c.text)).toEqual(['"still-ok"']);
    expect(out.debugLog?.some((d) => d.includes('instrument') && d.includes('NotDefined'))).toBe(true);
  });

  it('guest 无法枚举 dbg（闭包注入零全局足迹）', { timeout: 60_000 }, async () => {
    const { runSealed } = await import('@jsseal/runtime');
    const out = await runSealed({
      code: `console.log('keys-has-dbg:', Object.keys(globalThis).indexOf('dbg') >= 0);`,
      mode: 'record', backend: 'quickjs',
      instrument: `dbg('hidden');`,
    });
    expect(out.console.map((c) => c.text)).toEqual(['"keys-has-dbg:" false']);
  });

  it('envTrace 访问图谱：全部 get 计数（含已有属性）', { timeout: 60_000 }, async () => {
    const { runSealed } = await import('@jsseal/runtime');
    const out = await runSealed({
      code: `var a = navigator.userAgent; var b = navigator.plugins.length; var c = navigator.sendBeacon;`,
      mode: 'record', backend: 'quickjs', envProbe: true, envTrace: true,
    });
    expect(out.envAccesses?.['navigator.userAgent']).toBe(1);
    expect(out.envAccesses?.['navigator.plugins']).toBe(1);
    expect(out.envMisses?.['navigator.sendBeacon']).toBe(1);
  });

  it('非枚举回归哨兵：内部状态不出现在 keys/for-in', { timeout: 60_000 }, async () => {
    const r = await auditEnv({ backend: 'quickjs' });
    expect(r.failures.some((f) => f.id === 'behav-hidden-state-enum')).toBe(false);
  });
});

describe('加载生命周期（确定性事件序）', () => {
  it('同步 loading → DCL interactive → load complete → 定时器在后', { timeout: 60_000 }, async () => {
    const { runSealed } = await import('@jsseal/runtime');
    const out = await runSealed({
      code: `
console.log('sync:' + document.readyState);
document.addEventListener('DOMContentLoaded', function () { console.log('dcl:' + document.readyState); });
window.addEventListener('load', function () { console.log('load:' + document.readyState); });
setTimeout(function () { console.log('timer:' + document.readyState); }, 10);
`,
      mode: 'record', backend: 'quickjs',
    });
    expect(out.console.map((c) => c.text)).toEqual([
      '"sync:loading"', '"dcl:interactive"', '"load:complete"', '"timer:complete"',
    ]);
  });

  it('无监听器也推进 readyState；监听器异常不终止事件流', { timeout: 60_000 }, async () => {
    const { runSealed } = await import('@jsseal/runtime');
    const out = await runSealed({
      code: `setTimeout(function(){ console.log('late:', document.readyState); }, 5);`,
      mode: 'record', backend: 'quickjs',
    });
    expect(out.console.map((c) => c.text)).toEqual(['"late:" "complete"']);
    const bad = await runSealed({
      code: `document.addEventListener('load', function(){ throw new Error('boom'); }); setTimeout(function(){ console.log('after:', document.readyState); }, 5);`,
      mode: 'record', backend: 'quickjs',
    });
    expect(bad.ok).toBe(true);
    expect(bad.console.some((c) => c.level === 'lifecycleError')).toBe(true);
    expect(bad.console.some((c) => c.text === '"after:" "complete"')).toBe(true);
  });
});
