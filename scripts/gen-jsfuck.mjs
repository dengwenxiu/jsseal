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

// 本脚本是 .mjs 直跑工具，未纳入任何 tsconfig 项目：node:fs / process 在类型
// 感知检查下解析为 error 类型，typescript/no-unsafe-* 的报告无法靠改代码消除
// （需要把脚本纳入 tsconfig 项目，属仓库配置范畴），故按脚本整体豁免。
/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return -- 见上：.mjs 脚本不在 tsconfig 项目内，node 内置模块与 process 为 error 类型 */

// ---------- 原子 ----------

/**
 * 数字 n（作为表达式求值为 number；0/1/2...）—— n 个 +!+[] 直接连接（勿用 '+' 连接：会产生 ++）
 *
 * @param {number} n 非负整数
 * @returns {string} 求值结果为 n 的 JSFuck 表达式
 */
const num = (n) => {
  if (n === 0) {
    return "+[]";
  }

  return "+!+[]".repeat(n);
};

/** Infinity：+("1e1000") */
const INF = "+(+!+[]+(!+[]+[])[+!+[]+!+[]+!+[]]+[+!+[]]+[+[]]+[+[]]+[+[]])";

/** @typedef {{ s: string, e: string }} Atom 原子表条目：已知原生串与其拼接表达式 */

/** @type {Atom[]} */
const BASE = [
  { s: "false", e: "(![]+[])" },
  { s: "true", e: "(!+[]+[])" },
  { s: "undefined", e: "([][[]]+[])" },
  { s: "NaN", e: "(+[![]]+[])" },
  { s: "Infinity", e: `(${INF}+[])` },
  { s: "0.09090909090909091", e: "((+!+[])/(+!+[]+[+!+[]])+[])" },
];

// 原生构造器字符串（fill 在前：c/o 只能从这里来；'fill' 本身由基础字符拼出）
const nativeCtorString = (name) => `function ${name}() {[native code]}`;

/** @type {Atom[] | null} */
let SOURCES = null;

// str→ch→sources 是环（此处要 str 生成原子表，str 又要 sources 查表），只能靠
// 延迟调用分阶段初始化：sources() 的调用发生在模块求值完成后，无 TDZ 风险。
/* oxlint-disable eslint/no-use-before-define -- 下方 str 定义在 sources 之后，仅在 sources() 被调用时（模块求值完成后）才执行到，无 TDZ 风险 */
/**
 * 分阶段构造原子表（幂等，首次调用后缓存）
 *
 * @returns {Atom[]} 可查表拼接的原子表
 */
const sources = () => {
  if (SOURCES !== null) {
    return SOURCES;
  }

  // 分阶段初始化（避免 str→ch→sources 循环）：
  // ① 基础字符串（f/a/l/s/e/t/r/u/n/d/i/N/I/y + 数字 + .）
  SOURCES = [...BASE];

  // ② fill 原生串（f,i,l,l 可由基础拼出）→ 解锁 c,o,(,),{,},[,],' ',v,m? no m
  SOURCES.push({ s: nativeCtorString("fill"), e: `([][${str("fill")}]+[])` });

  // ③ constructor（c,o 来自 fill 串）→ 解锁全部构造器
  const ctor = str("constructor");

  SOURCES.push(
    { s: nativeCtorString("Array"), e: `([][${ctor}]+[])` },
    { s: nativeCtorString("String"), e: `(([]+[])[${ctor}]+[])` },
    { s: nativeCtorString("Number"), e: `((+[])[${ctor}]+[])` },
    { s: nativeCtorString("Boolean"), e: `((![])[${ctor}]+[])` }
  );

  return SOURCES;
};
/* oxlint-enable eslint/no-use-before-define */

/**
 * 单字符 → 原子表达式（(SRC)[idx]）
 *
 * @param {string} c 单个字符
 * @returns {string} 求值结果为该字符的表达式
 */
const ch = (c) => {
  if (c >= "0" && c <= "9") {
    const d = +c;

    return d === 0 ? "(+[]+[])" : `(${num(d)}+[])`;
  }

  for (const src of sources()) {
    const i = src.s.indexOf(c);

    if (i !== -1) {
      return `(${src.e})[${num(i)}]`;
    }
  }

  throw new Error(`unreachable char: ${JSON.stringify(c)}`);
};

/** 字符串 → 字符原子拼接 */
const str = (w) => w.split("").map(ch).join("+");

/** 完整 JSFuck 程序：[][fill][constructor](payload)() */
export const jsfuck = (payload) =>
  `[][${str("fill")}][${str("constructor")}](${str(payload)})();`;

// ---------- CLI：生成 fixture + 自校验 ----------

if (import.meta.url === `file://${process.argv[1]}`) {
  const { writeFileSync } = await import("node:fs");
  const { runSealed } = await import("../packages/runtime/dist/index.js");

  const targets = [
    {
      file: "packages/transforms/fixtures/jsfuck-full.js",
      payload: "console.log(1337)",
    },
    { file: "samples/jsfuck.js", payload: "console.log(1234567890)" },
  ];

  for (const { file, payload } of targets) {
    const code = jsfuck(payload);

    // 自校验：封闭运行生成物，输出必须等于 payload 直接执行的输出
    // oxlint-disable-next-line eslint/no-await-in-loop -- 逐 target 串行生成并自校验，串行顺序即产物写入顺序
    const expect = await runSealed({
      code: payload,
      mode: "record",
      backend: "native",
    });

    // oxlint-disable-next-line eslint/no-await-in-loop -- 同一 target 的期望输出必须在校验产物前跑完
    const actual = await runSealed({ code, mode: "record", backend: "native" });
    const eo = JSON.stringify(expect.console);
    const ao = JSON.stringify(actual.console);

    if (!actual.ok || eo !== ao) {
      console.error(
        `SELF-CHECK FAILED for ${file}\n  expect=${eo}\n  actual=${ao}`
      );
      process.exit(1);
    }

    writeFileSync(new URL(`../${file}`, import.meta.url), `${code}\n`);
    console.log(`${file}: ${code.length} bytes, self-check OK (${payload})`);
  }
}
