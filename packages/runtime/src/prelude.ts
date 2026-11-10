/**
 * 封闭 prelude：注入到 guest 程序最前面的 JS 源码。
 *
 * 职责（全部在 guest 内完成，宿主只收最终 dump JSON）：
 *  1. 种子拦截：Math.random / Date / performance.now / crypto —— record 录制，replay 按序回放
 *  2. console 劫持：所有方法记录为规范化文本
 *  3. localStorage/sessionStorage 捕获
 *  4. Function.prototype.toString 钉死：优先返回 pins 里的原始文本（反制 beautify 检测），否则惰性缓存首见文本
 *  5. 定时器：确定性 no-op（MVP 不执行回调，置 flags.timers）
 *  6. __canon：规范化序列化（锚库比较的标准）
 *  7. 环境模板：window 别名 / navigator 最小模板
 */

import type { EnvTemplate, EntrySpec, FunctionPin, SeedTapes } from './types';

export interface NetFixture {
  status?: number;
  body?: string;
}

export interface PreludeConfig {
  mode: 'record' | 'replay';
  tapes: SeedTapes;
  pins: FunctionPin[];
  entry?: EntrySpec;
  env?: EnvTemplate;
  /** 网络 fixture：url（精确或前缀）→ 响应；未命中走确定性罐头 */
  netFixtures?: Record<string, NetFixture>;
  /** native 后端：种子(random/date/time)由引擎级拦截接管，prelude 不做 JS 覆盖 */
  engineSeeds?: boolean;
  /** 环境探针：Proxy 包装 stub 对象，记录缺失属性访问（自动报缺数据源） */
  envProbe?: boolean;
  /** 访问图谱：记录 stub 对象的全部属性访问（SDK 实际探测面的完整地图） */
  envTrace?: boolean;
}

export function buildPrelude(cfg: PreludeConfig): string {
  // 注入配置数据（JSON 安全）
  const data = JSON.stringify({
    mode: cfg.mode,
    tapes: cfg.tapes,
    pins: cfg.pins,
    engineSeeds: cfg.engineSeeds === true,
    envProbe: cfg.envProbe === true,
    envTrace: cfg.envTrace === true,
    netFixtures: cfg.netFixtures || {},
    env: {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      language: 'zh-CN',
      platform: 'MacIntel',
      ...cfg.env,
    },
  });
  return `(function () {
'use strict';
var __cfg = ${data};
var __jsseal = (typeof globalThis.__jsseal !== 'undefined') ? globalThis.__jsseal : (globalThis.__jsseal = {
  ok: true, ret: undefined, thrown: undefined,
  console: [], storage: {}, storage2: {}, envMisses: {}, envAccesses: {}, evalLog: [],
  debug: [],
  consumed: { random: 0, date: 0, time: 0, crypto: 0 },
  tapes: __cfg.tapes || { random: [], date: [], time: [], crypto: [] },
  flags: {},
});
// 反探测（开源特征防御）：内部状态不可枚举——Object.keys/for...in/JSON.stringify(globalThis)
// 三类穷举向量全部隐藏。ownNames 穷举仍可见（完全隐藏需随机名/闭包化，见 ARCHITECTURE 分级）。
// 预定义非枚举的 raw 通道存根：后续赋值不改变属性属性
try {
  Object.defineProperty(globalThis, '__jsseal', { value: globalThis.__jsseal, writable: true, enumerable: false, configurable: false });
  Object.defineProperty(globalThis, '__jsseal_ret_raw', { value: undefined, writable: true, enumerable: false, configurable: true });
  Object.defineProperty(globalThis, '__jsseal_err', { value: undefined, writable: true, enumerable: false, configurable: true });
} catch (e) { /* 已存在（重复注入）则跳过 */ }
// 插桩旁路：dbg 只经闭包注入（instrument 片段作用域），零全局足迹——guest 无法枚举
__jsseal.dbg = function () {
  var parts = [];
  for (var i = 0; i < arguments.length; i++) parts.push(__canon(arguments[i], new Set()));
  __jsseal.debug.push(parts.join(' '));
};

// ---------- 原始引用（在任何 patch 前捕获） ----------
var __rnd = Math.random;
var __RealDate = Date;
var __realNow = Date.now;
var __rndCrypto = function () { return __rnd(); };

// ---------- 种子函数 ----------
function __gen(cat) {
  if (cat === 'random') return __rnd();
  if (cat === 'date') return __realNow();
  if (cat === 'time') return __realNow();
  if (cat === 'crypto') return __rndCrypto();
  throw new Error('jsseal: unknown seed category ' + cat);
}
function __next(cat) {
  if (__cfg.mode === 'replay') {
    var tape = __jsseal.tapes[cat];
    if (__jsseal.consumed[cat] >= tape.length) {
      __jsseal.flags.tapeExhausted = true;
      throw new Error('__JSSEAL_TAPE_EXHAUSTED__:' + cat);
    }
    var v = tape[__jsseal.consumed[cat]];
    __jsseal.consumed[cat]++;
    return v;
  }
  var g = __gen(cat);
  __jsseal.tapes[cat].push(g);
  __jsseal.consumed[cat]++;
  return g;
}

// ---------- Math.random ----------
// 引擎级拦截（native 后端）时跳过 JS 覆盖：保持 [native code] 外观，guest 不可觉察
if (!__cfg.engineSeeds) {
Math.random = function () { return __next('random'); };

// ---------- Date ----------
var SealedDate = class extends __RealDate {
  constructor(...args) {
    if (args.length === 0) {
      super(__next('date'));
    } else {
      super(...args);
    }
  }
  static now() { return __next('date'); }
};
globalThis.Date = SealedDate;
}

// ---------- performance ----------
if (!__cfg.engineSeeds) {
globalThis.performance = {
  now: function () { return __next('time'); },
  timeOrigin: 0,
  timing: { navigationStart: 0 },
  getEntries: function () { return []; },
  getEntriesByType: function () { return []; },
  mark: function () {},
  measure: function () {},
};
}

// ---------- crypto（getRandomValues / randomUUID；native 后端由引擎原生接管） ----------
if (!__cfg.engineSeeds) {
function __u32() { return Math.floor(__next('crypto') * 4294967296) >>> 0; }
function __bytes(n) {
  var out = new Array(n);
  for (var i = 0; i < n; i++) {
    if ((i & 3) === 0) { var u = __u32(); out.__p = u; }
    var u2 = out.__p;
    out[i] = (u2 >>> ((i & 3) * 8)) & 0xff;
  }
  return out;
}
globalThis.crypto = {
  getRandomValues: function (arr) {
    var bs = __bytes(arr.length);
    for (var i = 0; i < arr.length; i++) arr[i] = bs[i];
    return arr;
  },
  randomUUID: function () {
    var bs = __bytes(16);
    bs[6] = (bs[6] & 0x0f) | 0x40;
    bs[8] = (bs[8] & 0x3f) | 0x80;
    var h = bs.map(function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  },
};
}

// ---------- console ----------
function __canon(v, seen) {
  seen = seen || new Set();
  var t = typeof v;
  if (v === null) return 'null';
  if (t === 'undefined') return 'undefined';
  if (t === 'number') {
    if (Number.isNaN(v)) return '"NaN"';
    if (v === 0) return '"0"'; /* -0 归一化为 0 */
    if (!Number.isFinite(v)) return v > 0 ? '"Infinity"' : '"-Infinity"';
    return JSON.stringify(v);
  }
  if (t === 'string' || t === 'boolean') return JSON.stringify(v);
  if (t === 'bigint') return '"' + v.toString() + 'n"';
  if (t === 'symbol') return '"' + v.toString() + '"';
  if (t === 'function') return '"[Function ' + (v.name || 'anonymous') + ']"';
  if (v instanceof Error) {
    /* message/stack 不可枚举，普通对象序列化会得到 {} */
    var et = (v.name || 'Error') + ': ' + (v.message || '');
    return '"' + et.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"') + '"';
  }
  if (Array.isArray(v)) {
    if (seen.has(v)) return '"[Circular]"';
    seen.add(v);
    return '[' + v.map(function (x) { return __canon(x, seen); }).join(',') + ']';
  }
  if (seen.has(v)) return '"[Circular]"';
  seen.add(v);
  try {
    var ks = Object.keys(v).sort();
    return '{' + ks.map(function (k) { return JSON.stringify(k) + ':' + __canon(v[k], seen); }).join(',') + '}';
  } catch (e) {
    return '"' + String(v) + '"';
  }
}
globalThis.__jsseal.json = function (v) { return __canon(v, new Set()); };

function __log(level) {
  return function () {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) parts.push(__canon(arguments[i]));
    __jsseal.console.push({ level: level, text: parts.join(' ') });
  };
}
var consoleMethods = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table',
  'group', 'groupCollapsed', 'groupEnd', 'time', 'timeEnd', 'timeLog', 'assert', 'count',
  'countReset', 'dirxml', 'profile', 'profileEnd'];
var consoleObj = {};
for (var ci = 0; ci < consoleMethods.length; ci++) consoleObj[consoleMethods[ci]] = __log(consoleMethods[ci]);
consoleObj.clear = function () {};
globalThis.console = consoleObj;

// ---------- storage ----------
function mkStorage(backing) {
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(backing, String(k)) ? backing[String(k)] : null; },
    setItem: function (k, v) { backing[String(k)] = String(v); },
    removeItem: function (k) { delete backing[String(k)]; },
    clear: function () { var ks = Object.keys(backing); for (var i = 0; i < ks.length; i++) delete backing[ks[i]]; },
    key: function (i) { return Object.keys(backing)[i] || null; },
    get length() { return Object.keys(backing).length; },
  };
}
globalThis.localStorage = mkStorage(__jsseal.storage);
globalThis.sessionStorage = mkStorage(__jsseal.storage2);

// ---------- eval / Function 拦截（pass-through 记录，供 unfold-eval 消费） ----------
var __origEval = globalThis.eval;
var __sealedEval = function (src) {
  if (typeof src === 'string') __jsseal.evalLog.push(src);
  return __origEval(src);
};
Object.defineProperty(__sealedEval, 'name', { value: 'eval' });
globalThis.eval = __sealedEval;
var __OrigFunction = Function;
var __sealedFunction = function () {
  var __args = Array.prototype.slice.call(arguments);
  if (__args.length > 0 && typeof __args[__args.length - 1] === 'string') {
    __jsseal.evalLog.push('[Function] ' + __args[__args.length - 1]);
  }
  return __OrigFunction.apply(this, __args);
};
Object.defineProperty(__sealedFunction, 'name', { value: 'Function' });
globalThis.Function = __sealedFunction;
globalThis.Function.prototype = __OrigFunction.prototype;
globalThis.Function.prototype.constructor = globalThis.Function;

// ---------- toString 钉死 ----------
// 1) pins 命中（按函数名）→ 返回原始文本（反制 beautify 检测）
// 2) 未命中（匿名函数等）→ 返回"去换行"文本：beautify 只增加空白不改 token 序列，
//    去换行后与原文本等价。对 ReDoS 型格式检测（search 嵌套量词，点号不匹配换行）
//    与换行检测通用免疫；若变换真的改变了 token，检测失败由锚库验证拦截（正确语义）
var __origToString = Function.prototype.toString;
var __tsCache = new WeakMap();
Function.prototype.toString = function () {
  if (__tsCache.has(this)) return __tsCache.get(this);
  var t = null;
  var nm = this.name;
  var __nativeLook = {
    eval: 'function eval() { [native code] }',
    Function: 'function Function() { [native code] }',
  };
  if (nm && __nativeLook[nm]) t = __nativeLook[nm];
  if (nm) {
    for (var i = 0; i < __cfg.pins.length; i++) {
      if (__cfg.pins[i].name === nm) { t = __cfg.pins[i].text; break; }
    }
  }
  if (t === null) {
    t = __origToString.call(this);
    if (/[\\n\\r]/.test(t)) t = t.replace(/\\r?\\n\\s*/g, '');
  }
  __tsCache.set(this, t);
  return t;
};

// ---------- 定时器：虚拟时钟（确定性调度） ----------
// 时间读数（Date/performance）仍走磁带（已确定）；定时器按 (at, seq) 虚拟排序，
// 宿主在主代码后驱动"微任务 → 到期定时器"循环 → 异步流程可封闭可重放
__jsseal.timerQueue = [];
__jsseal.vtime = 0;
var __timerSeq = 0;
function __virtSchedule(fn, delay, interval, args) {
  __jsseal.flags.timers = true;
  var d = Math.max(0, Number(delay) || 0);
  var id = ++__timerSeq;
  __jsseal.timerQueue.push({ id: id, at: __jsseal.vtime + d, seq: id, fn: fn, interval: interval ? d : 0, args: args || [] });
  return id;
}
var __clearedTimers = {};
function __virtClear(id) {
  __clearedTimers[id] = true; /* 回调执行期间被清除 → 重注册前检查（防复活） */
  for (var i = 0; i < __jsseal.timerQueue.length; i++) {
    if (__jsseal.timerQueue[i].id === id) { __jsseal.timerQueue.splice(i, 1); return; }
  }
}
globalThis.setTimeout = function (fn, delay) {
  return __virtSchedule(fn, delay, 0, Array.prototype.slice.call(arguments, 2));
};
globalThis.setInterval = function (fn, delay) {
  return __virtSchedule(fn, delay, 1, Array.prototype.slice.call(arguments, 2));
};
globalThis.setImmediate = function (fn) {
  return __virtSchedule(fn, 0, 0, Array.prototype.slice.call(arguments, 1));
};
globalThis.requestAnimationFrame = function (fn) {
  return __virtSchedule(function () { fn(__jsseal.vtime); }, 16, 0);
};
globalThis.requestIdleCallback = function (fn) {
  return __virtSchedule(function () { fn({ didTimeout: false, timeRemaining: function () { return 50; } }); }, 0, 0);
};
globalThis.clearTimeout = __virtClear;
globalThis.clearInterval = __virtClear;
globalThis.cancelAnimationFrame = __virtClear;
globalThis.cancelIdleCallback = __virtClear;
/** 宿主事件循环驱动：执行下一个到期定时器；返回 false 表示队列空 */
// ---------- 加载生命周期（确定性事件序：同步代码 → DOMContentLoaded → load → 定时器） ----------
// readyState 语义与真实页面一致：同步脚本期 'loading'，DCL 后 'interactive'，load 后 'complete'
__jsseal.lifecycle = { state: 'loading', firedDcl: false, firedLoad: false, listeners: [] };
function __lifecycleOn(type, fn) {
  if (typeof fn !== 'function') return;
  __jsseal.lifecycle.listeners.push({ type: type, fn: fn });
}
function __lifecycleOff(type, fn) {
  var ls = __jsseal.lifecycle.listeners;
  for (var i = ls.length - 1; i >= 0; i--) {
    if (ls[i].type === type && ls[i].fn === fn) ls.splice(i, 1);
  }
}
function __lifecycleDispatch(type, target) {
  var ev = {
    type: type, target: target, currentTarget: target, timeStamp: __jsseal.vtime, defaultPrevented: false,
    preventDefault: function () { this.defaultPrevented = true; }, stopPropagation: function () {}, stopImmediatePropagation: function () {},
  };
  var ls = __jsseal.lifecycle.listeners.slice();
  for (var i = 0; i < ls.length; i++) {
    if (ls[i].type !== type) continue;
    try { ls[i].fn.call(target, ev); } catch (e) {
      /* 浏览器语义：监听器异常不终止事件流，记录为可观测事件 */
      __jsseal.console.push({ level: 'lifecycleError', text: __canon(e) });
    }
  }
}
/** 每次调用推进一步：DCL → load → false（定时器开始）。无监听器也推进 readyState（与真实浏览器一致） */
__jsseal.lifecycleStep = function () {
  if (!__jsseal.lifecycle.firedDcl) {
    __jsseal.lifecycle.firedDcl = true;
    __jsseal.lifecycle.state = 'interactive';
    __lifecycleDispatch('DOMContentLoaded', globalThis.document || globalThis);
    return true;
  }
  if (!__jsseal.lifecycle.firedLoad) {
    __jsseal.lifecycle.firedLoad = true;
    __jsseal.lifecycle.state = 'complete';
    __lifecycleDispatch('load', globalThis.document || globalThis);
    return true;
  }
  return false;
};

__jsseal.runNextTimer = function () {
  if (__jsseal.lifecycleStep()) return true; // 生命周期先于定时器（浏览器序）
  var q = __jsseal.timerQueue;
  if (!q.length) return false;
  q.sort(function (a, b) { return a.at - b.at || a.seq - b.seq; });
  var t = q.shift();
  if (__jsseal.vtime < t.at) __jsseal.vtime = t.at;
  try {
    t.fn.apply(undefined, t.args);
  } catch (e) {
    /* 浏览器语义：回调异常不终止事件循环，记录为可观测事件 */
    __jsseal.console.push({ level: 'timerError', text: __canon(e) });
  }
  if (t.interval && !__clearedTimers[t.id]) {
    q.push({ id: t.id, at: __jsseal.vtime + t.interval, seq: t.seq, fn: t.fn, interval: t.interval, args: t.args });
  }
  return true;
};

// ---------- 环境模板 ----------
if (typeof globalThis.devicePixelRatio === 'undefined') globalThis.devicePixelRatio = 2;
if (typeof globalThis.innerWidth === 'undefined') { globalThis.innerWidth = 1440; globalThis.innerHeight = 855; }
if (typeof globalThis.outerWidth === 'undefined') { globalThis.outerWidth = 1440; globalThis.outerHeight = 900; }
if (typeof globalThis.indexedDB === 'undefined') { globalThis.indexedDB = { open: function () { return { set onsuccess(f) {}, set onerror(f) {}, set onupgradeneeded(f) {} }; }, deleteDatabase: function () {} }; }
if (typeof globalThis.Notification === 'undefined') {
  var __Notif = function Notification(title, options) { this.title = title; };
  __Notif.permission = 'default';
  __Notif.requestPermission = function () { return Promise.resolve('default'); };
  globalThis.Notification = __Notif;
}
if (typeof globalThis.chrome === 'undefined' && __cfg.env.userAgent.indexOf('Chrome') >= 0 && __cfg.env.userAgent.indexOf('Edg/') < 0) {
  // Chrome 特有对象：UA 声称 Chrome 而无 window.chrome 是第一代 headless 特征
  globalThis.chrome = { app: { isInstalled: false, getDetails: function () { return null; }, getIsInstalled: function () { return false; } } };
}
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
if (typeof globalThis.global === 'undefined') globalThis.global = globalThis;
if (typeof globalThis.navigator === 'undefined' || !globalThis.navigator.__jsseal) {
  // 拟真形态（认知库 behavior 级条目驱动）：原型 getter + Symbol.toStringTag
  // 内部槽——平面对象会泄漏 '[object Object]' 与断裂原型链（headless 经典检测）
  var __NavCtor = function Navigator() {};
  Object.defineProperty(__NavCtor.prototype, Symbol.toStringTag, { value: 'Navigator', configurable: true });
  var __navProps = {
    userAgent: __cfg.env.userAgent,
    appVersion: __cfg.env.userAgent.replace(/^Mozilla\\//, ''),
    language: __cfg.env.language,
    languages: [__cfg.env.language],
    platform: __cfg.env.platform,
    vendor: 'Google Inc.',
    webdriver: false,
    onLine: true,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    maxTouchPoints: 0,
    cookieEnabled: true,
    doNotTrack: null,
    plugins: { length: 5 },
    mimeTypes: { length: 2 },
    product: 'Gecko',
    productSub: '20030107',
    connection: { effectiveType: '4g', rtt: 50, downlink: 10 },
    userAgentData: { brands: [{ brand: 'Chromium', version: '131' }, { brand: 'Not_A Brand', version: '24' }], mobile: false, platform: 'macOS' },
    permissions: { query: function (d) { return Promise.resolve({ state: 'default', name: d && d.name }); } },
  };
  Object.keys(__navProps).forEach(function (k) {
    var v = __navProps[k];
    Object.defineProperty(__NavCtor.prototype, k, { get: function () { return v; }, configurable: true });
  });
  globalThis.navigator = Object.create(__NavCtor.prototype);
  Object.defineProperty(globalThis.navigator, '__jsseal', { value: true, configurable: true });
}
if (typeof globalThis.screen === 'undefined') {
  var __ScrCtor = function Screen() {};
  Object.defineProperty(__ScrCtor.prototype, Symbol.toStringTag, { value: 'Screen', configurable: true });
  var __scrProps = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 };
  Object.keys(__scrProps).forEach(function (k) {
    var v = __scrProps[k];
    Object.defineProperty(__ScrCtor.prototype, k, { get: function () { return v; }, configurable: true });
  });
  globalThis.screen = Object.create(__ScrCtor.prototype);
}
if (typeof globalThis.location === 'undefined') {
  globalThis.location = {
    href: 'https://example.com/page.html',
    protocol: 'https:',
    host: 'example.com',
    hostname: 'example.com',
    port: '',
    pathname: '/page.html',
    search: '',
    hash: '',
    origin: 'https://example.com',
    toString: function () { return 'https://example.com/page.html'; },
  };
}
if (typeof globalThis.history === 'undefined') {
  globalThis.history = { length: 1, state: null, pushState: function () {}, replaceState: function () {}, back: function () {}, forward: function () {}, go: function () {} };
}
if (typeof globalThis.document === 'undefined') {
  // 最小 DOM stub（尽力而为；缺失 API 由后续版本自由变量分析报告）
  var __docEl = { style: {}, clientWidth: 1920, clientHeight: 1080, getAttribute: function () { return null; } };
  globalThis.document = {
    __jsseal_stub: true,
    documentElement: __docEl,
    body: __docEl,
    head: __docEl,
    title: '',
    cookie: '',
    visibilityState: 'visible',
    hidden: false,
    referrer: '',
    domain: 'example.com',
    URL: 'https://example.com/page.html',
    characterSet: 'UTF-8',
    compatMode: 'CSS1Compat',
    createElement: function () {
      return { style: {}, children: [], attributes: {}, setAttribute: function () {}, getAttribute: function () { return null; },
        appendChild: function (c) { return c; }, removeChild: function (c) { return c; }, addEventListener: function () {},
        getContext: function () { return null; }, innerHTML: '', textContent: '', className: '' };
    },
    createTextNode: function (t) { return { textContent: t }; },
    getElementById: function () { return null; },
    getElementsByTagName: function () { return []; },
    getElementsByClassName: function () { return []; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    addEventListener: function (type, fn) { __lifecycleOn(type, fn); },
    removeEventListener: function (type, fn) { __lifecycleOff(type, fn); },
    dispatchEvent: function (ev) { __lifecycleDispatch(ev && ev.type, globalThis.document); return true; },
    createEvent: function (t) { return { type: t, initEvent: function (ty) { this.type = ty; } }; },
    write: function (t) { __jsseal.console.push({ level: 'document.write', text: __canon(String(t)) }); },
    writeln: function (t) { __jsseal.console.push({ level: 'document.write', text: __canon(String(t)) }); },
  };
  // readyState 跟随生命周期状态机（同步期 'loading'——与真实页面脚本所见一致）
  try {
    Object.defineProperty(globalThis.document, 'readyState', {
      get: function () { return __jsseal.lifecycle.state; }, configurable: true,
    });
  } catch (e) { /* 已有定义则跳过 */ }
}
globalThis.addEventListener = function (type, fn) { __lifecycleOn(type, fn); };
globalThis.removeEventListener = function (type, fn) { __lifecycleOff(type, fn); };
globalThis.dispatchEvent = function () { return true; };
globalThis.atob = function (s) {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var str = String(s).replace(/[^A-Za-z0-9+\\/=]/g, '').replace(/=+$/, '');
  var out = '';
  var i = 0;
  while (i < str.length) {
    var b1 = chars.indexOf(str[i]);
    var b2 = i + 1 < str.length ? chars.indexOf(str[i + 1]) : -1;
    var b3 = i + 2 < str.length ? chars.indexOf(str[i + 2]) : -1;
    var b4 = i + 3 < str.length ? chars.indexOf(str[i + 3]) : -1;
    i += 4;
    if (b1 < 0 || b2 < 0) break;
    var n = (b1 << 18) | (b2 << 12) | ((b3 < 0 ? 0 : b3) << 6) | (b4 < 0 ? 0 : b4);
    out += String.fromCharCode((n >> 16) & 0xff);
    if (b3 >= 0) out += String.fromCharCode((n >> 8) & 0xff);
    if (b4 >= 0) out += String.fromCharCode(n & 0xff);
  }
  return out;
};
globalThis.btoa = function (s) {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var str = String(s), out = '';
  for (var i = 0; i < str.length; i += 3) {
    var b1 = str.charCodeAt(i), b2 = i + 1 < str.length ? str.charCodeAt(i + 1) : NaN, b3 = i + 2 < str.length ? str.charCodeAt(i + 2) : NaN;
    out += chars[b1 >> 2];
    out += chars[((b1 & 3) << 4) | (isNaN(b2) ? 0 : b2 >> 4)];
    out += isNaN(b2) ? '=' : chars[((b2 & 15) << 2) | (isNaN(b3) ? 0 : b3 >> 6)];
    out += isNaN(b3) ? '=' : chars[b3 & 63];
  }
  return out;
};

// ---------- 网络 VCR（确定性罐头 + fixture 覆盖） ----------
__jsseal.netLog = [];    // {method, url, body}：样本发出的全部请求（可观测行为）
__jsseal.netMisses = []; // 配置了 fixture 但未命中的 url（缺流量报缺，与 envMisses 同构）
function __netRespond(method, url, body) {
  var bodyStr = body == null ? null : String(body);
  __jsseal.netLog.push({ method: method, url: url, body: bodyStr });
  var fx = __cfg.netFixtures;
  var f = null;
  if (Object.prototype.hasOwnProperty.call(fx, url)) f = fx[url];
  else {
    var keys = Object.keys(fx);
    for (var fi = 0; fi < keys.length; fi++) {
      if (url.indexOf(keys[fi]) === 0) { f = fx[keys[fi]]; break; }
    }
  }
  if (f) return { status: f.status || 200, body: f.body == null ? '' : String(f.body) };
  if (Object.keys(fx).length > 0) __jsseal.netMisses.push(url);
  /* 确定性罐头：请求的纯函数 → record/replay 自动同构 */
  var src = method + ' ' + url + ' ' + (bodyStr == null ? '' : bodyStr);
  var h = 0;
  for (var ni = 0; ni < src.length; ni++) h = (h * 31 + src.charCodeAt(ni)) | 0;
  return { status: 200, body: 'jsseal-canned-' + (h >>> 0).toString(36) + '-' + src.length };
}
globalThis.fetch = function (url, opts) {
  opts = opts || {};
  var u = String(url);
  var m = ((opts.method || 'GET') + '').toUpperCase();
  return new Promise(function (resolve) {
    setTimeout(function () {
      var r = __netRespond(m, u, opts.body);
      resolve({
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        statusText: r.status === 200 ? 'OK' : '',
        headers: { get: function () { return null; } },
        text: function () { return Promise.resolve(r.body); },
        json: function () {
          try { return Promise.resolve(JSON.parse(r.body)); }
          catch (e) { return Promise.reject(e); }
        },
      });
    }, 0);
  });
};
function XMLHttpRequest() {
  this.readyState = 0;
  this.status = 0;
  this.responseText = '';
  this.response = '';
  this.onreadystatechange = null;
  this.onload = null;
}
XMLHttpRequest.prototype.open = function (method, url) {
  this.__m = String(method || 'GET').toUpperCase();
  this.__u = String(url);
  this.readyState = 1;
};
XMLHttpRequest.prototype.setRequestHeader = function () {};
XMLHttpRequest.prototype.send = function (body) {
  var self = this;
  setTimeout(function () {
    var r = __netRespond(self.__m, self.__u, body);
    self.status = r.status;
    self.responseText = r.body;
    self.response = r.body;
    self.readyState = 4;
    if (typeof self.onreadystatechange === 'function') self.onreadystatechange();
    if (typeof self.onload === 'function') self.onload();
  }, 0);
};
XMLHttpRequest.prototype.getAllResponseHeaders = function () { return ''; };
XMLHttpRequest.prototype.abort = function () {};
globalThis.XMLHttpRequest = XMLHttpRequest;

// ---------- 环境探针：记录 stub 对象的缺失属性访问（自动报缺） ----------
function __probeWrap(obj, name) {
  if (!obj || typeof Proxy === 'undefined') return obj;
  return new Proxy(obj, {
    get: function (t, k) {
      if (typeof k === 'string') {
        var key = name + '.' + k;
        if (!(k in t)) {
          // 缺失访问（报缺数据源）
          __jsseal.envMisses[key] = (__jsseal.envMisses[key] || 0) + 1;
        }
        if (__cfg.envTrace) {
          // 访问图谱（envTrace）：全部 get 计数——SDK 实际探测面的完整地图
          __jsseal.envAccesses[key] = (__jsseal.envAccesses[key] || 0) + 1;
        }
      }
      return t[k];
    },
  });
}
if (__cfg.envProbe) {
  var __probeTargets = ['navigator', 'document', 'screen', 'location', 'history'];
  for (var pi = 0; pi < __probeTargets.length; pi++) {
    var pn = __probeTargets[pi];
    if (globalThis[pn]) globalThis[pn] = __probeWrap(globalThis[pn], pn);
  }
}

// ---------- dump ----------
__jsseal.dump = function () {
  return {
    ok: __jsseal.ok,
    ret: __jsseal.ret,
    thrown: __jsseal.thrown,
    console: __jsseal.console,
    storage: __jsseal.storage,
    consumed: __jsseal.consumed,
    tapes: __jsseal.tapes,
    flags: __jsseal.flags,
    envMisses: __jsseal.envMisses,
    envAccesses: __cfg.envTrace ? __jsseal.envAccesses : undefined,
    debugLog: __jsseal.debug.length ? __jsseal.debug : undefined,
    evalLog: __jsseal.evalLog,
    netLog: __jsseal.netLog,
    netMisses: __jsseal.netMisses,
  };
};
})();`;
}

/** 入口调用尾巴（与用户代码同属一个 program，保持顶层作用域语义） */
export function buildEntryTail(entry: EntrySpec | undefined): string {
  if (!entry) return '';
  const argsJson = JSON.stringify(entry.args ?? []);
  return `
;try {
  var __e = globalThis[${JSON.stringify(entry.name)}];
  if (typeof __e !== 'function') {
    globalThis.__jsseal.flags.entryNotFound = true;
  } else {
    globalThis.__jsseal.ret = globalThis.__jsseal.json(__e.apply(null, ${argsJson}));
    globalThis.__jsseal.retCaptured = true;
  }
} catch (e) {
  globalThis.__jsseal.ok = false;
  globalThis.__jsseal.thrown = globalThis.__jsseal.json(e);
}`;
}

/** 完成值捕获 + dump 尾巴（backend 在 evalCode 之后注入执行） */
export const CAPTURE_TAIL = `
;try {
  if (typeof globalThis.__jsseal_err !== 'undefined') {
    globalThis.__jsseal.ok = false;
    globalThis.__jsseal.thrown = globalThis.__jsseal.json(globalThis.__jsseal_err);
  } else if (typeof globalThis.__jsseal_ret_raw !== 'undefined') {
    /* guest 主动设置的原始结果通道（不经 __canon 二次编码） */
    globalThis.__jsseal.ret = globalThis.__jsseal_ret_raw;
    globalThis.__jsseal.retCaptured = true;
  } else if (typeof globalThis.__jsseal_last !== 'undefined' && !globalThis.__jsseal.retCaptured) {
    globalThis.__jsseal.ret = globalThis.__jsseal.json(globalThis.__jsseal_last);
  }
} catch (e) {}`;

export const DUMP_EXPR = 'JSON.stringify(globalThis.__jsseal.dump())';

/** 空磁带（record 模式起始值 / 默认值） */
export function emptyTapes(): SeedTapes {
  return { random: [], date: [], time: [], crypto: [] };
}
