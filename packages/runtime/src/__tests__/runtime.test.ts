import { describe, expect, it } from 'vitest';
import { emptyTapes, runSealed } from '../index';
import { isEngineAvailable } from '@jsseal/engine-native';

/** 引擎二进制不可用的环境（如 windows CI 未编 native）自动跳过 native 用例 */
const nativeIt = isEngineAvailable() ? it : it.skip;
const backends = isEngineAvailable() ? [['quickjs'], ['native']] : [['quickjs']];

const sample = `
var key = "SECRET_KEY_123";
function encrypt(msg) {
  var out = '';
  for (var i = 0; i < msg.length; i++) {
    out += String.fromCharCode(msg.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return out;
}
console.log('start');
var r = encrypt('hello world');
console.log('result:' + r);
`;

describe.each(backends)('%s 后端 · 封闭执行', (backend: string) => {
  it('record 模式：录制种子磁带，输出稳定可读', async () => {
    const out = await runSealed({ backend: backend as never, code: sample, mode: 'record' });
    expect(out.ok).toBe(true);
    expect(out.console.length).toBe(2);
    expect(out.console[0].text).toBe('"start"');
    expect(out.console[1].text).toContain('result:');
  });

  it('种子代码：record 录制 → replay 重放逐位一致（可重放确定性）', async () => {
    const code = `
var a = Math.random(), b = Date.now(), c = performance.now();
var d = Math.random();
console.log(JSON.stringify([a, b, c, d]));
crypto.getRandomValues(__arr = new Uint8Array(8));
console.log(JSON.stringify(Array.from(__arr)));
console.log(crypto.randomUUID());
`;
    const rec = await runSealed({ backend: backend as never, code, mode: 'record' });
    expect(rec.ok).toBe(true);
    expect(rec.consumed.random).toBe(2);
    expect(rec.consumed.date).toBe(1);
    expect(rec.consumed.time).toBe(1);
    // crypto 计数语义：native 引擎级按字节记槽（8+16=24）；prelude 层按字节 1/4（u32 粒度，6）
    expect(rec.consumed.crypto).toBe(backend === 'native' ? 8 + 16 : 2 + 4);
    expect(rec.tapes.random.length).toBe(2);

    const rep1 = await runSealed({ backend: backend as never, code, mode: 'replay', tapes: rec.tapes });
    const rep2 = await runSealed({ backend: backend as never, code, mode: 'replay', tapes: rec.tapes });
    expect(rep1.console).toEqual(rec.console);
    expect(rep2.console).toEqual(rec.console);
  });

  it('磁带耗尽 → tapeExhausted 标记（执行发散哨兵）', async () => {
    const code = `console.log(Math.random()); console.log(Math.random());`;
    const rec = await runSealed({ backend: backend as never, code, mode: 'record' });
    const short = { ...rec.tapes, random: rec.tapes.random.slice(0, 1) };
    const rep = await runSealed({ backend: backend as never, code, mode: 'replay', tapes: short });
    expect(rep.flags.tapeExhausted).toBe(true);
  });

  it('toString 钉死：pins 优先返回原始文本（反制 beautify 检测）', async () => {
    const code = `function _0x4a3b(){return 1;} console.log(_0x4a3b.toString());`;
    const rec = await runSealed({ backend: backend as never, code, mode: 'record' });
    // 未提供 pins：返回自身文本
    expect(rec.console[0].text).toContain('return 1');

    const pins = [{ name: '_0x4a3b', text: 'function _0x4a3b(){/*ORIGINAL*/}' }];
    const rep = await runSealed({ backend: backend as never, code, mode: 'replay', tapes: rec.tapes, pins });
    expect(rep.console[0].text).toContain('ORIGINAL');
  });

  it('入口模式②：入口函数参数钉死，返回值捕获', async () => {
    const code = `
function sign(a, b) { return 'sig:' + a + ':' + b + ':' + Date.now(); }
`;
    const rec = await runSealed({ backend: backend as never, code, mode: 'record', entry: { name: 'sign', args: ['x1', 42] } });
    expect(rec.ok).toBe(true);
    expect(rec.ret).toContain('"sig:x1:42:');
    const rep = await runSealed({ backend: backend as never, code, mode: 'replay', tapes: rec.tapes, entry: { name: 'sign', args: ['x1', 42] } });
    expect(rep.ret).toBe(rec.ret);
    expect(rep.consumed.date).toBe(1);
  });

  it('storage 捕获与未捕获异常', async () => {
    const code = `
localStorage.setItem('token', 'abc' + Math.random());
throw new Error('boom-' + Math.random());
`;
    const rec = await runSealed({ backend: backend as never, code, mode: 'record' });
    expect(rec.ok).toBe(false);
    expect(rec.thrown).toContain('boom-');
    expect(rec.storage['token']).toMatch(/^abc/);
    const rep = await runSealed({ backend: backend as never, code, mode: 'replay', tapes: rec.tapes });
    expect(rep.thrown).toBe(rec.thrown);
    expect(rep.storage).toEqual(rec.storage);
  });

  it('死循环触发超时中断 → timeout 标记', async () => {
    const rec = await runSealed({ backend: backend as never, code: `while(true){}`, mode: 'record', timeoutMs: 500 });
    expect(rec.flags.timeout).toBe(true);
  }, 20_000);

  it('nodevm 备用后端：同一后端内 record/replay 一致', async () => {
    const code = `console.log(Math.random() + ':' + Date.now());`;
    const rec = await runSealed({ code, mode: 'record', backend: 'nodevm' });
    const rep = await runSealed({ code, mode: 'replay', tapes: rec.tapes, backend: 'nodevm' });
    expect(rep.console).toEqual(rec.console);
  });

  it('emptyTapes 形状', () => {
    expect(emptyTapes()).toEqual({ random: [], date: [], time: [], crypto: [] });
  });
});

describe('native 引擎级种子拦截（M2.2）', () => {
  nativeIt('guest 不可觉察：toString 为 [native code]，行为与原生一致', async () => {
    const code = `var s = Math.random.toString() + '|' + typeof Math.random; console.log(s); console.log(Math.random());`;
    const rec = await runSealed({ code, mode: 'record', backend: 'native' });
    expect(rec.console[0].text).toContain('[native code]');
    expect(rec.consumed.random).toBe(1);
  });

  nativeIt('new Date() 无参构造也走磁带（引擎级 date_now 拦截）', async () => {
    const code = `var d = new Date(); console.log(d.getTime()); console.log(Date.now());`;
    const rec = await runSealed({ code, mode: 'record', backend: 'native' });
    expect(rec.consumed.date).toBe(2);
    const rep = await runSealed({ code, mode: 'replay', tapes: rec.tapes, backend: 'native' });
    expect(JSON.stringify(rep.console)).toBe(JSON.stringify(rec.console));
  });

  nativeIt('performance.now 走引擎磁带', async () => {
    const code = `console.log(performance.now());`;
    const rec = await runSealed({ code, mode: 'record', backend: 'native' });
    expect(rec.consumed.time).toBe(1);
    const rep = await runSealed({ code, mode: 'replay', tapes: rec.tapes, backend: 'native' });
    expect(JSON.stringify(rep.console)).toBe(JSON.stringify(rec.console));
  });

  nativeIt('delete Math.random 无法恢复真实随机（引擎级拦截不可绕过）', async () => {
    const code = `try { delete Math.random; } catch(e) {} try { console.log(Math.random()); } catch(e) { console.log('gone:' + e.constructor.name); }`;
    const rec = await runSealed({ code, mode: 'record', backend: 'native' });
    // 无论属性删除与否，取值都来自磁带（或属性真被删则 TypeError——与浏览器一致），
    // 关键是：不可能拿到引擎真实随机数
    expect(rec.console.length).toBe(1);
    const rep = await runSealed({ code, mode: 'replay', tapes: rec.tapes, backend: 'native' });
    expect(JSON.stringify(rep.console)).toBe(JSON.stringify(rec.console));
  });

  nativeIt('磁带耗尽 → tapeExhausted 哨兵（引擎级）', async () => {
    const code = `console.log(Math.random()); console.log(Math.random());`;
    const rec = await runSealed({ code, mode: 'record', backend: 'native' });
    const short = { ...rec.tapes, random: rec.tapes.random.slice(0, 1) };
    const rep = await runSealed({ code, mode: 'replay', tapes: short, backend: 'native' });
    expect(rep.flags.tapeExhausted).toBe(true);
  });
});
