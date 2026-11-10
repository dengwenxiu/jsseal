#!/usr/bin/env node
/**
 * JSFuck 编码器（生成测试样本）——把任意 payload（限可达字符集）编码为
 * 仅含 []()!+ 的等价程序：  [][fill][constructor](PAYLOAD)()
 *
 * 可达字符集来源（已对 jsseal 引擎实测，勿凭记忆改——索引依赖精确字符串）：
 *   false / true / undefined / NaN / Infinity（1e1000 技巧）
 *   原生构造器 toString：quickjs-ng 格式 "function fill() {[native code]}"
 *     （注意与 V8 的 "function fill() { [native code] }" 空格不同！）
 *   数字：+!+[]+[]  /  小数点：1/11 = "0.09090909090909091"[1]
 *
 * 不可达（escape 扩展字符集，jsfuck.com 用 Function("return escape")() 突破，
 * 本编码器不支持）：引号、反斜杠、% 等。
 */

// ---------- 原子 ----------

/** 数字 n（作为表达式求值为 number；0/1/2...）—— n 个 +!+[] 直接连接（勿用 '+' 连接：会产生 ++） */
function num(n) {
  if (n === 0) return '+[]';
  return Array(n).fill('+!+[]').join('');
}

/** Infinity：+("1e1000") */
const INF = '+(+!+[]+(!+[]+[])[+!+[]+!+[]+!+[]]+[+!+[]]+[+[]]+[+[]]+[+[]])';

const BASE = [
  { s: 'false', e: '(![]+[])' },
  { s: 'true', e: '(!+[]+[])' },
  { s: 'undefined', e: '([][[]]+[])' },
  { s: 'NaN', e: '(+[![]]+[])' },
  { s: 'Infinity', e: '(' + INF + '+[])' },
  { s: '0.09090909090909091', e: '((+!+[])/(+!+[]+[+!+[]])+[])' },
];

// 原生构造器字符串（fill 在前：c/o 只能从这里来；'fill' 本身由基础字符拼出）
const NATIVE = (name) => `function ${name}() {[native code]}`;

let SOURCES = null;
function sources() {
  if (SOURCES) return SOURCES;
  // 分阶段初始化（避免 str→ch→sources 循环）：
  // ① 基础字符串（f/a/l/s/e/t/r/u/n/d/i/N/I/y + 数字 + .）
  SOURCES = [...BASE];
  // ② fill 原生串（f,i,l,l 可由基础拼出）→ 解锁 c,o,(,),{,},[,],' ',v,m? no m
  SOURCES.push({ s: NATIVE('fill'), e: `([][${str('fill')}]+[])` });
  // ③ constructor（c,o 来自 fill 串）→ 解锁全部构造器
  const ctor = str('constructor');
  SOURCES.push({ s: NATIVE('Array'), e: `([][${ctor}]+[])` });
  SOURCES.push({ s: NATIVE('String'), e: `(([]+[])[${ctor}]+[])` });
  SOURCES.push({ s: NATIVE('Number'), e: `((+[])[${ctor}]+[])` });
  SOURCES.push({ s: NATIVE('Boolean'), e: `((![])[${ctor}]+[])` });
  return SOURCES;
}

/** 单字符 → 原子表达式（(SRC)[idx]） */
function ch(c) {
  if (c >= '0' && c <= '9') {
    const d = +c;
    return d === 0 ? '(+[]+[])' : `(${num(d)}+[])`;
  }
  for (const src of sources()) {
    const i = src.s.indexOf(c);
    if (i >= 0) return `(${src.e})[${num(i)}]`;
  }
  throw new Error(`unreachable char: ${JSON.stringify(c)}`);
}

/** 字符串 → 字符原子拼接 */
function str(w) {
  return w.split('').map(ch).join('+');
}

/** 完整 JSFuck 程序：[][fill][constructor](payload)() */
export function jsfuck(payload) {
  return `[][${str('fill')}][${str('constructor')}](${str(payload)})();`;
}

// ---------- CLI：生成 fixture + 自校验 ----------

if (import.meta.url === `file://${process.argv[1]}`) {
  const { writeFileSync } = await import('node:fs');
  const { runSealed } = await import('../packages/runtime/dist/index.js');

  const targets = [
    { file: 'packages/transforms/fixtures/jsfuck-full.js', payload: 'console.log(1337)' },
    { file: 'samples/jsfuck.js', payload: 'console.log(1234567890)' },
  ];
  for (const { file, payload } of targets) {
    const code = jsfuck(payload);
    // 自校验：封闭运行生成物，输出必须等于 payload 直接执行的输出
    const expect = await runSealed({ code: payload, mode: 'record', backend: 'native' });
    const actual = await runSealed({ code, mode: 'record', backend: 'native' });
    const eo = JSON.stringify(expect.console);
    const ao = JSON.stringify(actual.console);
    if (!actual.ok || eo !== ao) {
      console.error(`SELF-CHECK FAILED for ${file}\n  expect=${eo}\n  actual=${ao}`);
      process.exit(1);
    }
    writeFileSync(new URL(`../${file}`, import.meta.url), code + '\n');
    console.log(`${file}: ${code.length} bytes, self-check OK (${payload})`);
  }
}
