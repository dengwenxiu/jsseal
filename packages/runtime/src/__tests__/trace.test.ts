import { describe, expect, it } from 'vitest';
import { runSealed } from '../index';
import { isEngineAvailable } from '@jsseal/engine-native';

const nativeIt = isEngineAvailable() ? it : it.skip;

const decoderSample = `
function dec(i) {
  var pool = ['AAA', 'SECRET_KEY_123', 'BBB'];
  return pool[i];
}
function main() {
  var k = dec(1);
  console.log('key=' + k);
  return dec(0);
}
main();
`;

describe('native 引擎 trace + gas（M2.3）', () => {
  nativeIt('sret 事件捕获解码函数返回的字符串', async () => {
    const out = await runSealed({
      code: decoderSample,
      mode: 'record',
      backend: 'native',
      trace: { calls: true, stringReturns: true },
    });
    expect(out.trace).toBeDefined();
    expect(out.trace!.truncated).toBe(false);
    const srets = out.trace!.events.filter((e) => e.k === 'sret' && e.fn === 'dec');
    expect(srets.map((e) => e.v)).toEqual(['SECRET_KEY_123', 'AAA']);
    const calls = out.trace!.events.filter((e) => e.k === 'call' && e.fn === 'dec');
    expect(calls.length).toBe(2);
  });

  nativeIt('重放时 trace 逐位一致（确定性）', async () => {
    const opts = { code: decoderSample, backend: 'native' as const, trace: { calls: true, stringReturns: true } };
    const rec = await runSealed({ ...opts, mode: 'record' });
    const rep = await runSealed({ ...opts, mode: 'replay', tapes: rec.tapes });
    // 过滤 prelude 内部函数（replace/stringify 等依赖 dump 时机，非确定性来源）
    const userOnly = (ev: typeof rec.trace!.events) =>
      ev.filter((e) => !['replace', 'stringify', '__canon', 'join', 'log'].includes(e.fn));
    expect(JSON.stringify(userOnly(rep.trace!.events))).toBe(JSON.stringify(userOnly(rec.trace!.events)));
  });

  nativeIt('gas 确定性：同代码消耗一致', async () => {
    const code = 'var s=0; for (var i=0;i<100000;i++){s+=i;} s;';
    const a = await runSealed({ code, mode: 'record', backend: 'native' });
    const b = await runSealed({ code, mode: 'record', backend: 'native' });
    expect(a.gasUsed).toBe(b.gasUsed);
    expect(a.gasUsed).toBeGreaterThan(0);
  });

  nativeIt('gas 限额哨兵（确定性资源上限，区别于壁钟超时）', async () => {
    const out = await runSealed({
      code: 'while(true){}',
      mode: 'record',
      backend: 'native',
      gasLimit: 300,
      timeoutMs: 20000,
    });
    expect(out.flags.gasExhausted).toBe(true);
    // 限额触发时间远早于壁钟——确定性上限
    expect(out.flags.timeout).toBeFalsy();
  });

  nativeIt('gas 在 prelude 之后生效（prelude 开销不计入）', async () => {
    const out = await runSealed({
      code: 'var x = 1 + 1; x;',
      mode: 'record',
      backend: 'native',
      gasLimit: 50,
    });
    expect(out.ret).toBe('2');
    expect(out.flags.gasExhausted).toBeFalsy();
  });
});

describe('native cret 白名单过滤（M2.4）', () => {
  nativeIt('cretFns 只记录目标函数（rotate 噪声免疫）', async () => {
    // 模拟 rotate 噪声：大量 noise() 调用 + 目标 dec() 调用
    const code = `
function noise(i) { return i + 1; }
function dec(i) { var p = ['AAA', 'SECRET']; return p[i]; }
for (var i = 0; i < 5000; i++) { noise(i); }
var a = dec(1); var b = dec(0); a + b;
`;
    const out = await runSealed({
      code, mode: 'record', backend: 'native',
      trace: { callArgs: true, cretFns: ['dec'] },
    });
    const crets = out.trace?.events ?? [];
    expect(crets.length).toBe(2);
    expect(crets.every((e) => e.fn === 'dec')).toBe(true);
    expect(crets[0].v).toBe('SECRET');
    expect(crets[1].v).toBe('AAA');
    expect(out.trace!.truncated).toBe(false);
  });
});

describe('环境探针（M2.6 自动报缺）', () => {
  nativeIt('记录 stub 对象的缺失属性访问（含次数）', async () => {
    const out = await runSealed({
      code: 'var a = navigator.sendBeacon; var b = navigator.userAgent; document.missingApi; document.missingApi; 1',
      mode: 'record', backend: 'native', envProbe: true,
    });
    expect(out.envMisses).toEqual({ 'navigator.sendBeacon': 1, 'document.missingApi': 2 });
  });

  it('默认不开启（无 envMisses 记录，无 Proxy 开销）', async () => {
    const out = await runSealed({
      code: 'var a = navigator.sendBeacon; typeof a;',
      mode: 'record', backend: 'quickjs',
    });
    expect(out.envMisses).toEqual({});
  });
});

describe('引擎级污点传播（M2.7）', () => {
  const tainted = `
function f(x) { return x + Math.random(); }
function d(x) { return x + Date.now(); }
function g(x) { return x * 2; }
function h(x) { return f(x) + 1; }
var a = f(1); var b = g(21); var c = h(5); var e = d(2);
[a, b, c, e];
`;

  nativeIt('种子参与 → t=1；纯计算 → 无 t；嵌套子树传播', async () => {
    const out = await runSealed({ code: tainted, mode: 'record', backend: 'native', trace: { callArgs: true } });
    const m = new Map((out.trace?.events ?? []).filter((e) => e.k === 'cret').map((e) => [`${e.fn}:${e.a?.join(',')}`, e.t ?? 0]));
    expect(m.get('f:1')).toBe(1);
    expect(m.get('g:21')).toBe(0);
    expect(m.get('h:5')).toBe(1); // 子树感染
    expect(m.get('d:2')).toBe(1);
  });

  nativeIt('replay 模式感染形态一致（污点与磁带模式无关）', async () => {
    const rec = await runSealed({ code: tainted, mode: 'record', backend: 'native', trace: { callArgs: true } });
    const rep = await runSealed({ code: tainted, mode: 'replay', tapes: rec.tapes, backend: 'native', trace: { callArgs: true } });
    const key = (evs: typeof rec.trace!.events) =>
      evs.filter((e) => e.k === 'cret').map((e) => `${e.fn}:${e.t ?? 0}`).join(' ');
    expect(key(rep.trace!.events)).toBe(key(rec.trace!.events));
  });

  nativeIt('crypto 种子同样感染', async () => {
    const out = await runSealed({
      code: 'function k(x) { var a = new Uint8Array(4); crypto.getRandomValues(a); return x + a[0]; } k(1);',
      mode: 'record', backend: 'native', trace: { callArgs: true },
    });
    const cret = (out.trace?.events ?? []).find((e) => e.k === 'cret' && e.fn === 'k');
    expect(cret?.t).toBe(1);
  });
});

describe('虚拟时钟（G.1 异步封闭）', () => {
  nativeIt('延时序确定性：微任务 → 按时序定时器，重放逐位一致', async () => {
    const code = `
console.log('start');
setTimeout(function(){ console.log('t+50'); }, 50);
setTimeout(function(){ console.log('t+10'); }, 10);
Promise.resolve().then(function(){ console.log('microtask'); });
setTimeout(function(){ console.log('t+10-b'); }, 10);
setTimeout(function(){ console.log('end'); }, 100);
`;
    const rec = await runSealed({ code, mode: 'record', backend: 'native' });
    expect(rec.console.map((c) => c.text)).toEqual(['"start"', '"microtask"', '"t+10"', '"t+10-b"', '"t+50"', '"end"']);
    const rep = await runSealed({ code, mode: 'replay', tapes: rec.tapes, backend: 'native' });
    expect(JSON.stringify(rep.console)).toBe(JSON.stringify(rec.console));
  });

  nativeIt('setInterval + clearInterval：有限循环确定性执行', async () => {
    const code = `
var n = 0;
var id = setInterval(function(){ n++; console.log('tick' + n); if (n >= 3) clearInterval(id); }, 10);
`;
    const rec = await runSealed({ code, mode: 'record', backend: 'native' });
    expect(rec.console.map((c) => c.text)).toEqual(['"tick1"', '"tick2"', '"tick3"']);
  });

  nativeIt('await + setTimeout 链：async 函数封闭', async () => {
    const code = `
async function flow() {
  var out = [];
  out.push('a');
  await new Promise(function (res) { setTimeout(res, 10); });
  out.push('b');
  await new Promise(function (res) { setTimeout(res, 5); });
  out.push('c');
  console.log(out.join('-'));
}
flow();
`;
    const rec = await runSealed({ code, mode: 'record', backend: 'native' });
    expect(rec.console.map((c) => c.text)).toEqual(['"a-b-c"']);
    const rep = await runSealed({ code, mode: 'replay', tapes: rec.tapes, backend: 'native' });
    expect(JSON.stringify(rep.console)).toBe(JSON.stringify(rec.console));
  });

  nativeIt('永不停止的 setInterval → timerDropped 哨兵（步数封顶）', async () => {
    const code = `setInterval(function(){}, 1); console.log('alive');`;
    const out = await runSealed({ code, mode: 'record', backend: 'native', timeoutMs: 30000 });
    expect(out.console.map((c) => c.text)).toEqual(['"alive"']);
    expect(out.flags.timers).toBe(true);
    expect(out.flags.timerDropped).toBe(true);
  }, 60_000);
});

describe('网络 VCR（G.2）', () => {
  const netCode = `
async function main() {
  var r = await fetch('https://api.example.com/sign?ts=123');
  var t = await r.text();
  console.log('fetch:' + r.status + ':' + t.slice(0, 16));
  var xhr = new XMLHttpRequest();
  xhr.onreadystatechange = function () {
    if (xhr.readyState === 4) console.log('xhr:' + xhr.responseText.slice(0, 16));
  };
  xhr.open('POST', 'https://api.example.com/report');
  xhr.send('payload-1');
}
main();
`;

  nativeIt('fetch/XHR 走虚拟事件循环，罐头响应确定，netLog 记录，重放一致', async () => {
    const rec = await runSealed({ code: netCode, mode: 'record', backend: 'native' });
    expect(rec.console.length).toBe(2);
    expect(rec.console[0].text).toContain('fetch:200:jsseal-canned-');
    expect(rec.console[1].text).toContain('xhr:jsseal-canned-');
    expect(rec.netLog).toEqual([
      { method: 'GET', url: 'https://api.example.com/sign?ts=123', body: null },
      { method: 'POST', url: 'https://api.example.com/report', body: 'payload-1' },
    ]);
    const rep = await runSealed({ code: netCode, mode: 'replay', tapes: rec.tapes, backend: 'native' });
    expect(JSON.stringify(rep.console)).toBe(JSON.stringify(rec.console));
    expect(JSON.stringify(rep.netLog)).toBe(JSON.stringify(rec.netLog));
  });

  nativeIt('fixture 命中（精确+前缀）与 netMisses 报缺', async () => {
    const out = await runSealed({
      code: netCode, mode: 'record', backend: 'native',
      netFixtures: { 'https://api.example.com/sign': { status: 403, body: 'DENIED' } },
    });
    expect(out.console[0].text).toContain('fetch:403:DENIED');
    expect(out.netMisses).toEqual(['https://api.example.com/report']);
  });

  it('netLog 是可观测行为：URL 变化被锚库拦截', async () => {
    const { buildCorpus, validateCorpus } = await import('@jsseal/anchors');
    const corpus = await buildCorpus({ code: netCode, samples: 2 });
    const mutated = netCode.replace('sign?ts=123', 'sign?ts=999');
    const v = await validateCorpus(corpus, mutated);
    expect(v.pass).toBe(false);
    expect(v.failures.some((f) => f.detail.includes('netLog'))).toBe(true);
  });
});

describe('eval/Function 拦截（M3.1）', () => {
  nativeIt('evalLog 记录生成代码；toString 原生外观不可觉察', async () => {
    const out = await runSealed({
      code: `eval("var a=1; console.log('ok')"); console.log(eval.toString()); var f = Function("return 2"); console.log(f());`,
      mode: 'record', backend: 'native',
    });
    expect(out.evalLog).toEqual(['var a=1; console.log(\'ok\')', '[Function] return 2']);
    expect(out.console[1].text).toContain('[native code]');
  });
});
