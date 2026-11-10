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
