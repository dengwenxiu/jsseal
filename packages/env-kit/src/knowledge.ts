/**
 * 环境对齐认知库（knowledge base）
 *
 * 为什么需要它：环境就是封闭边界本身。风控对抗 SDK 对环境感知极其敏感——
 * 一旦发现异常（字段缺失/形态不对/跨字段矛盾）就走非预期分支，锚库采样到
 * 的就是那条"错的路"，后续所有优化跟着走偏。
 *
 * 为什么是"认知库"而不是"实现"：**环境的正常性不可证明，只是认知**——
 * 我们无法穷举风控看什么，只能持续维护这份认知。因此每条认知都必须：
 * - 可机器校验（expr 在封闭运行时内求值，true=对齐）
 * - 带风控语义（desc 说明为什么看它）
 * - 带泄漏风险分级（severity）
 *
 * 三类条目：
 * - field    存在性/形态：单字段类型与典型值域
 * - consist  跨字段一致性：UA ↔ platform/plugins/window.chrome 等互相印证
 *            （风控的强项：单字段可伪造，矛盾难伪造）
 * - behavior 行为级：Object.prototype.toString 的内部槽（'[object Navigator]'）、
 *            原型链、方法行为——平面对象 stub 的经典泄漏
 */

export type Severity = 'high' | 'medium' | 'low';
export type EnvCategory = 'navigator' | 'window' | 'document' | 'screen' | 'consistency' | 'behavior';

export interface EnvCheck {
  /** 唯一 id（报告与维护用） */
  id: string;
  category: EnvCategory;
  /** 风控语义：为什么看它 / 它泄漏什么 */
  desc: string;
  severity: Severity;
  /** 审计表达式：封闭运行时内求值；true=对齐；抛错=缺失 */
  expr: string;
  /** 采集键（真机快照用：读取该值的表达式，与 expr 对应） */
  capture: string;
}

export const KNOWLEDGE: EnvCheck[] = [
  /* ---------------- navigator：存在性/形态 ---------------- */
  { id: 'nav-useragent-string', category: 'navigator', severity: 'high',
    desc: 'userAgent 必须是长字符串；缺失/空串是无头环境的最直接信号',
    expr: `typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string' && navigator.userAgent.length > 50`,
    capture: 'navigator.userAgent' },
  { id: 'nav-webdriver-false', category: 'navigator', severity: 'high',
    desc: '自动化标记：Selenium/Puppeteer/Playwright 下为 true——风控第一检查',
    expr: `navigator.webdriver === false`,
    capture: 'navigator.webdriver' },
  { id: 'nav-platform-set', category: 'navigator', severity: 'high',
    desc: 'platform 应为非空字符串（MacIntel/Win32/Linux x86_64）',
    expr: `typeof navigator.platform === 'string' && navigator.platform.length > 0`,
    capture: 'navigator.platform' },
  { id: 'nav-languages-array', category: 'navigator', severity: 'high',
    desc: 'languages 必须是非空数组；undefined/空是无头特征',
    expr: `Array.isArray(navigator.languages) && navigator.languages.length >= 1`,
    capture: 'Array.isArray(navigator.languages) ? navigator.languages.slice() : String(navigator.languages)' },
  { id: 'nav-language-in-languages', category: 'navigator', severity: 'medium',
    desc: 'language 与 languages[0] 一致性',
    expr: `navigator.language === navigator.languages[0]`,
    capture: 'navigator.language' },
  { id: 'nav-vendor-chrome', category: 'navigator', severity: 'medium',
    desc: 'Chrome 系 vendor 恒为 "Google Inc."（Firefox 为 ""）',
    expr: `navigator.userAgent.includes('Chrome') ? navigator.vendor === 'Google Inc.' : true`,
    capture: 'navigator.vendor' },
  { id: 'nav-plugins-chrome', category: 'navigator', severity: 'high',
    desc: 'Chrome 桌面版 plugins.length ≥ 1（通常 5，PDF Viewer 系）；空 plugins 是 headless Chrome 经典特征',
    expr: `navigator.userAgent.includes('Chrome') && !navigator.userAgent.includes('Edg/') ? navigator.plugins.length >= 1 : true`,
    capture: 'navigator.plugins.length' },
  { id: 'nav-mimetypes', category: 'navigator', severity: 'medium',
    desc: 'mimeTypes 与 plugins 配套（Chrome 桌面 ≥ 2）',
    expr: `navigator.mimeTypes.length >= 1`,
    capture: 'navigator.mimeTypes.length' },
  { id: 'nav-hardwareConcurrency-range', category: 'navigator', severity: 'medium',
    desc: 'CPU 核数应在 1–64 的合理区间；undefined/0 异常',
    expr: `typeof navigator.hardwareConcurrency === 'number' && navigator.hardwareConcurrency >= 1 && navigator.hardwareConcurrency <= 64`,
    capture: 'navigator.hardwareConcurrency' },
  { id: 'nav-deviceMemory-power2', category: 'navigator', severity: 'medium',
    desc: 'deviceMemory 只取 0.25/0.5/1/2/4/8（浏览器上限 8，防指纹穷举）',
    expr: `navigator.deviceMemory === undefined || [0.25, 0.5, 1, 2, 4, 8].includes(navigator.deviceMemory)`,
    capture: 'navigator.deviceMemory' },
  { id: 'nav-maxTouchPoints-desktop', category: 'navigator', severity: 'medium',
    desc: '桌面 UA 下 maxTouchPoints 应为 0（移动端 > 0）——与 UA 矛盾即泄漏',
    expr: `navigator.userAgent.includes('Mobile') ? navigator.maxTouchPoints > 0 : navigator.maxTouchPoints === 0`,
    capture: 'navigator.maxTouchPoints' },
  { id: 'nav-cookieEnabled', category: 'navigator', severity: 'low',
    desc: '常规浏览器 cookieEnabled=true',
    expr: `navigator.cookieEnabled === true`,
    capture: 'navigator.cookieEnabled' },
  { id: 'nav-onLine', category: 'navigator', severity: 'low',
    desc: 'onLine=true（部分风控把 false 视为爬虫环境）',
    expr: `navigator.onLine === true`,
    capture: 'navigator.onLine' },
  { id: 'nav-userAgentData', category: 'navigator', severity: 'medium',
    desc: 'Chrome 90+ 有 userAgentData（brands/getHighEntropyValues）；缺失+新 UA 矛盾',
    expr: `navigator.userAgent.includes('Chrome') ? typeof navigator.userAgentData !== 'undefined' : true`,
    capture: `typeof navigator.userAgentData !== 'undefined' ? { brands: navigator.userAgentData.brands, platform: navigator.userAgentData.platform, mobile: navigator.userAgentData.mobile } : undefined` },
  { id: 'nav-permissions', category: 'navigator', severity: 'medium',
    desc: 'permissions.query 是 headless 检测常用点（notifications 状态与 Notification.permission 互证）',
    expr: `typeof navigator.permissions !== 'undefined' && typeof navigator.permissions.query === 'function'`,
    capture: `typeof navigator.permissions !== 'undefined' ? 'present' : undefined` },

  /* ---------------- window / 全局 ---------------- */
  { id: 'win-chrome-obj', category: 'window', severity: 'high',
    desc: 'Chrome 特有 window.chrome 对象（app/runtime/loadTimes）——UA 声称 Chrome 而无此对象是第一代 headless 特征',
    expr: `navigator.userAgent.includes('Chrome') && !navigator.userAgent.includes('Edg/') ? typeof chrome !== 'undefined' && chrome !== null && typeof chrome === 'object' : true`,
    capture: `typeof chrome !== 'undefined' ? Object.keys(chrome) : undefined` },
  { id: 'win-notification', category: 'window', severity: 'medium',
    desc: 'Notification 构造器存在（permission 与 permissions API 互证）',
    expr: `typeof Notification !== 'undefined'`,
    capture: `typeof Notification !== 'undefined' ? Notification.permission : undefined` },
  { id: 'win-localStorage', category: 'window', severity: 'medium',
    desc: 'localStorage 可用（风控常写探针值再读回）',
    expr: `(function(){ try { return typeof localStorage !== 'undefined'; } catch(e){ return false; } })()`,
    capture: `'present'` },
  { id: 'win-indexedDB', category: 'window', severity: 'low',
    desc: 'indexedDB 存在（无头某些配置缺失）',
    expr: `typeof indexedDB !== 'undefined'`,
    capture: `typeof indexedDB !== 'undefined' ? 'present' : undefined` },
  { id: 'win-performance-now', category: 'window', severity: 'high',
    desc: 'performance.now 存在且单调（时间侧信道的基础，缺失异常）',
    expr: `typeof performance !== 'undefined' && typeof performance.now === 'function'`,
    capture: `'present'` },
  { id: 'win-raf', category: 'window', severity: 'medium',
    desc: 'requestAnimationFrame 存在（渲染循环依赖）',
    expr: `typeof requestAnimationFrame === 'function'`,
    capture: `'present'` },
  { id: 'win-devicePixelRatio', category: 'window', severity: 'medium',
    desc: 'devicePixelRatio 是 ≥1 的数值（dpr 与 screen 尺寸配合的指纹项）',
    expr: `typeof devicePixelRatio === 'number' && devicePixelRatio >= 1`,
    capture: 'devicePixelRatio' },
  { id: 'win-inner-size', category: 'window', severity: 'medium',
    desc: 'innerWidth/innerHeight > 0（0×0 是无头默认视口特征）',
    expr: `typeof innerWidth === 'number' && innerWidth > 0 && typeof innerHeight === 'number' && innerHeight > 0`,
    capture: '[innerWidth, innerHeight]' },
  { id: 'win-outer-ge-inner', category: 'window', severity: 'medium',
    desc: 'outerWidth ≥ innerWidth（无头常两者相等或 outer 为 0）',
    expr: `typeof outerWidth === 'number' ? outerWidth >= innerWidth : false`,
    capture: '[outerWidth, outerHeight]' },

  /* ---------------- document ---------------- */
  { id: 'doc-documentElement', category: 'document', severity: 'high',
    desc: 'documentElement 存在（DOM 根；风控访问 documentElement.style 检测 CSS 特性）',
    expr: `typeof document !== 'undefined' && document.documentElement !== null && document.documentElement !== undefined`,
    capture: `'present'` },
  { id: 'doc-visibility-visible', category: 'document', severity: 'medium',
    desc: "visibilityState='visible' 且 hidden=false（后台/无头常为 'prerender'/hidden）",
    expr: `document.visibilityState === 'visible' && document.hidden === false`,
    capture: 'document.visibilityState' },
  { id: 'doc-body', category: 'document', severity: 'medium',
    desc: 'document.body 存在（脚本执行期 body 应已解析；风控贴探针元素）',
    expr: `document.body !== null && document.body !== undefined`,
    capture: `'present'` },
  { id: 'doc-cookie-string', category: 'document', severity: 'low',
    desc: 'document.cookie 是字符串（可写可读）',
    expr: `typeof document.cookie === 'string'`,
    capture: `document.cookie.length` },
  { id: 'doc-referrer', category: 'document', severity: 'low',
    desc: 'referrer 是字符串（空串合法，undefined 不是）',
    expr: `typeof document.referrer === 'string'`,
    capture: 'document.referrer' },
  { id: 'doc-createElement-canvas', category: 'document', severity: 'high',
    desc: 'createElement 可用且产物有 getContext（canvas 指纹的基础设施）',
    expr: `(function(){ try { var c = document.createElement('canvas'); return typeof c === 'object' && c !== null; } catch(e){ return false; } })()`,
    capture: `'present'` },

  /* ---------------- screen ---------------- */
  { id: 'scr-dims-sane', category: 'screen', severity: 'medium',
    desc: '屏幕尺寸合理（≥800×600）',
    expr: `typeof screen !== 'undefined' && screen.width >= 800 && screen.height >= 600`,
    capture: '[screen.width, screen.height]' },
  { id: 'scr-avail-le-dims', category: 'screen', severity: 'medium',
    desc: 'availWidth/availHeight ≤ width/height（任务栏/菜单栏占用）；相等也可（全屏）但大于必假',
    expr: `screen.availWidth <= screen.width && screen.availHeight <= screen.height`,
    capture: '[screen.availWidth, screen.availHeight]' },
  { id: 'scr-colorDepth', category: 'screen', severity: 'low',
    desc: 'colorDepth 24（常见）或 30（Retina/ProMotion）',
    expr: `screen.colorDepth === 24 || screen.colorDepth === 30`,
    capture: 'screen.colorDepth' },

  /* ---------------- 跨字段一致性（风控的强项） ---------------- */
  { id: 'cons-ua-mac-platform', category: 'consistency', severity: 'high',
    desc: 'UA 含 Mac OS X → platform 必须是 MacIntel（CPU 架构重写 UA 后的经典矛盾点）',
    expr: `navigator.userAgent.includes('Mac OS X') ? navigator.platform === 'MacIntel' : true`,
    capture: 'navigator.platform' },
  { id: 'cons-ua-win-platform', category: 'consistency', severity: 'high',
    desc: 'UA 含 Windows NT → platform 以 Win 开头',
    expr: `navigator.userAgent.includes('Windows NT') ? navigator.platform.indexOf('Win') === 0 : true`,
    capture: 'navigator.platform' },
  { id: 'cons-ua-linux-no-win', category: 'consistency', severity: 'medium',
    desc: 'UA 含 Linux 且不含 Android/Windows → platform 形如 Linux x86_64',
    expr: `navigator.userAgent.includes('Linux') && !navigator.userAgent.includes('Android') && !navigator.userAgent.includes('Windows') ? navigator.platform.indexOf('Linux') === 0 : true`,
    capture: 'navigator.platform' },
  { id: 'cons-timezone-intl', category: 'consistency', severity: 'medium',
    desc: 'Intl 时区可解析为非空串（无头/Node 有时 undefined；与 IP 地理互证是服务端强项）',
    expr: `(function(){ try { return Intl.DateTimeFormat().resolvedOptions().timeZone.length > 0; } catch(e){ return false; } })()`,
    capture: 'Intl.DateTimeFormat().resolvedOptions().timeZone' },
  { id: 'cons-ua-mobile-dpr', category: 'consistency', severity: 'low',
    desc: '移动 UA → devicePixelRatio 通常 > 1；桌面 1 也可',
    expr: `navigator.userAgent.includes('Mobile') ? devicePixelRatio > 1 : true`,
    capture: 'devicePixelRatio' },

  /* ---------------- 行为级（内部槽/原型链——平面对象 stub 的天敌） ---------------- */
  { id: 'behav-navigator-tostring-tag', category: 'behavior', severity: 'high',
    desc: "Object.prototype.toString.call(navigator) === '[object Navigator]'——平面对象 stub 输出 '[object Object]'，headless 检测经典",
    expr: `Object.prototype.toString.call(navigator) === '[object Navigator]'`,
    capture: `Object.prototype.toString.call(navigator)` },
  { id: 'behav-screen-tostring-tag', category: 'behavior', severity: 'medium',
    desc: "screen 内部槽应为 '[object Screen]'",
    expr: `Object.prototype.toString.call(screen) === '[object Screen]'`,
    capture: `Object.prototype.toString.call(screen)` },
  { id: 'behav-navigator-prototype', category: 'behavior', severity: 'high',
    desc: 'navigator 原型链应到达 Navigator.prototype（getter 定义在原型上；实例自有属性是伪造特征）',
    expr: `(function(){ try { return Object.getPrototypeOf(navigator).constructor.name === 'Navigator'; } catch(e){ return false; } })()`,
    capture: `Object.getPrototypeOf(navigator).constructor.name` },
  { id: 'behav-navigator-getter', category: 'behavior', severity: 'medium',
    desc: 'userAgent 应是原型 getter（数据属性 own 在实例上是注入特征）',
    expr: `(function(){ try { return !Object.getOwnPropertyDescriptor(navigator, 'userAgent'); } catch(e){ return false; } })()`,
    capture: `Object.getOwnPropertyDescriptor(navigator, 'userAgent') ? 'own-data' : 'prototype-getter'` },
  { id: 'behav-hidden-state-enum', category: 'behavior', severity: 'medium',
    desc: '封闭运行时的内部状态对象不得出现在 Object.keys/for...in 穷举中（开源特征防御：guest 枚举 window 发现宿主痕迹即判定虚拟环境）',
    expr: `Object.keys(globalThis).indexOf('__jsseal') < 0 && (function(){ for (var k in globalThis) if (k === '__jsseal') return false; return true; })()`,
    capture: `Object.keys(globalThis).filter(function(k){ return k.indexOf('__jsseal') >= 0; })` },
  { id: 'behav-native-tostring', category: 'behavior', severity: 'medium',
    desc: "宿主函数 toString 含 '[native code]'（我们已保证，此条是回归哨兵）",
    expr: `(function(){ try { return Function.prototype.toString.call(Function.prototype.toString).includes('[native code]'); } catch(e){ return false; } })()`,
    capture: `'ok'` },
];

/** 按 id 索引 */
export const KNOWLEDGE_BY_ID: ReadonlyMap<string, EnvCheck> = new Map(KNOWLEDGE.map((k) => [k.id, k]));
