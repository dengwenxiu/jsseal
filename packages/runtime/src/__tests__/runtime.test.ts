import { isEngineAvailable } from "@jsseal/engine-native";
import { describe, expect, it } from "vitest";

import { emptyTapes, runSealed } from "../index";
import type { BackendKind } from "../index";

/** 引擎二进制不可用的环境（如 windows CI 未编 native）自动跳过 native 用例 */
const nativeAvailable = isEngineAvailable();

const backends: [BackendKind][] = nativeAvailable
  ? [["quickjs"], ["native"]]
  : [["quickjs"]];

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

/** 四类种子样本：random 2 次、date/time 各 1 次、crypto 8+16 字节 */
const seedSample = `
var a = Math.random(), b = Date.now(), c = performance.now();
var d = Math.random();
console.log(JSON.stringify([a, b, c, d]));
crypto.getRandomValues(__arr = new Uint8Array(8));
console.log(JSON.stringify(Array.from(__arr)));
console.log(crypto.randomUUID());
`;

describe.each(backends)("%s 后端 · 封闭执行", (backend: BackendKind) => {
  it("record 模式：录制种子磁带，输出稳定可读", async () => {
    const out = await runSealed({
      backend,
      code: sample,
      mode: "record",
    });

    expect(out.ok).toBeTruthy();
    expect(out.console).toHaveLength(2);
    expect(out.console[0].text).toBe('"start"');
    expect(out.console[1].text).toContain("result:");
  });

  it("种子代码：record 录制消费计数与磁带", async () => {
    const rec = await runSealed({
      backend,
      code: seedSample,
      mode: "record",
    });

    expect(rec.ok).toBeTruthy();
    expect([
      rec.consumed.random,
      rec.consumed.date,
      rec.consumed.time,
    ]).toStrictEqual([2, 1, 1]);
    // crypto 计数语义：native 引擎级按字节记槽（8+16=24）；prelude 层按字节 1/4（u32 粒度，6）
    expect(rec.consumed.crypto).toBe(backend === "native" ? 8 + 16 : 2 + 4);
    expect(rec.tapes.random).toHaveLength(2);
  });

  it("种子代码：replay 重放逐位一致（可重放确定性）", async () => {
    const rec = await runSealed({
      backend,
      code: seedSample,
      mode: "record",
    });

    const rep1 = await runSealed({
      backend,
      code: seedSample,
      mode: "replay",
      tapes: rec.tapes,
    });

    const rep2 = await runSealed({
      backend,
      code: seedSample,
      mode: "replay",
      tapes: rec.tapes,
    });

    expect(rep1.console).toStrictEqual(rec.console);
    expect(rep2.console).toStrictEqual(rec.console);
  });

  it("磁带耗尽 → tapeExhausted 标记（执行发散哨兵）", async () => {
    const code = `console.log(Math.random()); console.log(Math.random());`;

    const rec = await runSealed({
      backend,
      code,
      mode: "record",
    });

    const short = { ...rec.tapes, random: rec.tapes.random.slice(0, 1) };

    const rep = await runSealed({
      backend,
      code,
      mode: "replay",
      tapes: short,
    });

    expect(rep.flags.tapeExhausted).toBeTruthy();
  });

  it("toString 钉死：pins 优先返回原始文本（反制 beautify 检测）", async () => {
    const code = `function _0x4a3b(){return 1;} console.log(_0x4a3b.toString());`;

    const rec = await runSealed({
      backend,
      code,
      mode: "record",
    });

    // 未提供 pins：返回自身文本
    expect(rec.console[0].text).toContain("return 1");

    const pins = [
      { name: "_0x4a3b", text: "function _0x4a3b(){/*ORIGINAL*/}" },
    ];

    const rep = await runSealed({
      backend,
      code,
      pins,
      mode: "replay",
      tapes: rec.tapes,
    });

    expect(rep.console[0].text).toContain("ORIGINAL");
  });

  it("入口模式②：入口函数参数钉死，返回值捕获", async () => {
    const code = `
function sign(a, b) { return 'sig:' + a + ':' + b + ':' + Date.now(); }
`;

    const rec = await runSealed({
      backend,
      code,
      mode: "record",
      entry: { name: "sign", args: ["x1", 42] },
    });

    expect(rec.ok).toBeTruthy();
    expect(rec.ret).toContain('"sig:x1:42:');

    const rep = await runSealed({
      backend,
      code,
      mode: "replay",
      tapes: rec.tapes,
      entry: { name: "sign", args: ["x1", 42] },
    });

    expect(rep.ret).toBe(rec.ret);
    expect(rep.consumed.date).toBe(1);
  });

  it("storage 捕获与未捕获异常", async () => {
    const code = `
localStorage.setItem('token', 'abc' + Math.random());
throw new Error('boom-' + Math.random());
`;

    const rec = await runSealed({
      backend,
      code,
      mode: "record",
    });

    expect(rec.ok).toBeFalsy();
    expect(rec.thrown).toContain("boom-");
    expect(rec.storage.token).toMatch(/^abc/u);

    const rep = await runSealed({
      backend,
      code,
      mode: "replay",
      tapes: rec.tapes,
    });

    expect(rep.thrown).toBe(rec.thrown);
    expect(rep.storage).toStrictEqual(rec.storage);
  });

  it("死循环触发超时中断 → timeout 标记", async () => {
    const rec = await runSealed({
      backend,
      code: `while(true){}`,
      mode: "record",
      timeoutMs: 500,
    });

    expect(rec.flags.timeout).toBeTruthy();
  }, 20_000);

  it("nodevm 备用后端：同一后端内 record/replay 一致", async () => {
    const code = `console.log(Math.random() + ':' + Date.now());`;
    const rec = await runSealed({ code, mode: "record", backend: "nodevm" });

    const rep = await runSealed({
      code,
      mode: "replay",
      tapes: rec.tapes,
      backend: "nodevm",
    });

    expect(rep.console).toStrictEqual(rec.console);
  });

  it("emptyTapes 形状", () => {
    expect(emptyTapes()).toStrictEqual({
      random: [],
      date: [],
      time: [],
      crypto: [],
    });
  });
});

describe.skipIf(!nativeAvailable)("native 引擎级种子拦截（M2.2）", () => {
  it("guest 不可觉察：toString 为 [native code]，行为与原生一致", async () => {
    const code = `var s = Math.random.toString() + '|' + typeof Math.random; console.log(s); console.log(Math.random());`;
    const rec = await runSealed({ code, mode: "record", backend: "native" });
    expect(rec.console[0].text).toContain("[native code]");
    expect(rec.consumed.random).toBe(1);
  });

  it("new Date() 无参构造也走磁带（引擎级 date_now 拦截）", async () => {
    const code = `var d = new Date(); console.log(d.getTime()); console.log(Date.now());`;
    const rec = await runSealed({ code, mode: "record", backend: "native" });
    expect(rec.consumed.date).toBe(2);

    const rep = await runSealed({
      code,
      mode: "replay",
      tapes: rec.tapes,
      backend: "native",
    });

    expect(JSON.stringify(rep.console)).toBe(JSON.stringify(rec.console));
  });

  it("performance.now 走引擎磁带", async () => {
    const code = `console.log(performance.now());`;
    const rec = await runSealed({ code, mode: "record", backend: "native" });
    expect(rec.consumed.time).toBe(1);

    const rep = await runSealed({
      code,
      mode: "replay",
      tapes: rec.tapes,
      backend: "native",
    });

    expect(JSON.stringify(rep.console)).toBe(JSON.stringify(rec.console));
  });

  it("delete Math.random 无法恢复真实随机（引擎级拦截不可绕过）", async () => {
    const code = `try { delete Math.random; } catch(e) {} try { console.log(Math.random()); } catch(e) { console.log('gone:' + e.constructor.name); }`;
    const rec = await runSealed({ code, mode: "record", backend: "native" });
    // 无论属性删除与否，取值都来自磁带（或属性真被删则 TypeError——与浏览器一致），
    // 关键是：不可能拿到引擎真实随机数
    expect(rec.console).toHaveLength(1);

    const rep = await runSealed({
      code,
      mode: "replay",
      tapes: rec.tapes,
      backend: "native",
    });

    expect(JSON.stringify(rep.console)).toBe(JSON.stringify(rec.console));
  });

  it("磁带耗尽 → tapeExhausted 哨兵（引擎级）", async () => {
    const code = `console.log(Math.random()); console.log(Math.random());`;
    const rec = await runSealed({ code, mode: "record", backend: "native" });
    const short = { ...rec.tapes, random: rec.tapes.random.slice(0, 1) };

    const rep = await runSealed({
      code,
      mode: "replay",
      tapes: short,
      backend: "native",
    });

    expect(rep.flags.tapeExhausted).toBeTruthy();
  });
});
