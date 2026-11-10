/**
 * @jsseal/runtime — 类型定义
 *
 * 封闭执行模型：
 *  - 程序 = f(代码, 环境模板, 入口参数, 种子磁带)
 *  - record 模式：真实熵源（Math.random/Date/crypto/performance）被逐次录制进磁带
 *  - replay 模式：种子函数按调用序从磁带取值 → 执行成为确定性可重放流程
 *  - 有序屏障语义：种子调用不可删除/重排（由变换层保证，运行时以 consumed 计数暴露）
 */

export type SeedCategory = 'random' | 'date' | 'time' | 'crypto';

export type SeedTapes = Record<SeedCategory, number[]>;

export interface ConsoleRecord {
  level: string;
  text: string;
}

/** 函数原始文本钉死（toString 反制 self-defending / 完整性检测） */
export interface FunctionPin {
  name: string;
  text: string;
}

export interface SealedOutput {
  /** 程序是否正常跑完（未抛出未捕获异常） */
  ok: boolean;
  /** 完成值/入口返回值的规范化串（__canon 规则） */
  ret?: string;
  /** 未捕获异常的规范化串 */
  thrown?: string;
  console: ConsoleRecord[];
  storage: Record<string, string>;
  /** 每类种子的消费次数（有序屏障计数，锚库验证的硬性比较项） */
  consumed: Record<SeedCategory, number>;
  /** record 模式录制到的磁带（replay 模式下等于输入磁带） */
  tapes: SeedTapes;
  flags: SealedFlags;
  /** 引擎级 trace 事件（native 后端，options.trace 开启时） */
  trace?: { events: TraceEvent[]; truncated: boolean };
  /** gas 消耗（native 后端） */
  gasUsed?: number;
  /** 环境缺失访问（envProbe 开启时）：'navigator.sendBeacon' → 次数 */
  envMisses?: Record<string, number>;
  /** 网络请求日志（可观测行为，参与锚库比较）：{method, url, body}[] */
  netLog?: Array<{ method: string; url: string; body: string | null }>;
  /** eval/Function 生成的代码记录（拦截 pass-through，供 unfold-eval 消费） */
  evalLog?: string[];
  /** fixture 配置存在但未命中的 url（缺流量报缺） */
  netMisses?: string[];
  /** forced execution：强制分支是否实际触发（native） */
  forceApplied?: boolean;
}

export interface TraceEvent {
  k: 'call' | 'sret' | 'cret' | 'br' | 'go';
  fn: string;
  argc?: number;
  v?: string | number | boolean | null;
  /** cret：实参（全原始类型） */
  a?: unknown[];
  /** br/go：跳转指令所在行号（br=条件跳转，go=无条件 goto） */
  l?: number;
  /** cret 污点：该调用子树消费过种子（输出为不稳定变量） */
  t?: 1;
}

export interface SealedFlags {
  /** gas 限额触发（确定性资源上限，区别于壁钟 timeout） */
  gasExhausted?: boolean;
  /** 使用了 setTimeout/setInterval/rAF（MVP 中为确定性 no-op，语义降级，报告中标注） */
  timers?: boolean;
  /** replay 时磁带耗尽 → 执行已发散，输出不可信 */
  tapeExhausted?: boolean;
  /** 超时被中断 */
  timeout?: boolean;
  /** 内存超限 */
  oom?: boolean;
  /** 入口函数未找到 */
  entryNotFound?: boolean;
  [k: string]: boolean | undefined;
}

export interface EntrySpec {
  /** 全局函数名（顶层 function 声明 / var 赋值均可） */
  name: string;
  args: unknown[];
}

export interface EnvTemplate {
  userAgent?: string;
  language?: string;
  platform?: string;
  [k: string]: unknown;
}

export type BackendKind = 'quickjs' | 'nodevm' | 'native';

export interface SealedRunOptions {
  code: string;
  mode: 'record' | 'replay';
  /** replay 模式必填；record 模式忽略 */
  tapes?: SeedTapes;
  pins?: FunctionPin[];
  entry?: EntrySpec;
  timeoutMs?: number;
  memoryLimitBytes?: number;
  backend?: BackendKind;
  env?: EnvTemplate;
  /** gas 限额（native 引擎级，单位 10000 ops） */
  gasLimit?: number;
  /** 引擎级 trace 开关（native） */
  trace?: { calls?: boolean; stringReturns?: boolean; callArgs?: boolean; branches?: boolean; cretFns?: string[] };
  /** 环境探针：记录 stub 对象（navigator/document/...）的缺失属性访问 */
  envProbe?: boolean;
  /** 网络 fixture：url（精确/前缀）→ {status, body}；未命中走确定性罐头 */
  netFixtures?: Record<string, { status?: number; body?: string }>;
  /** forced execution（native）：>0 时翻转第 k 个执行的条件分支 */
  forceBranchIndex?: number;
}

/** 后端之间的原始交接结构（prelude/tail 由 index 统一组装） */
export interface GuestProgram {
  prelude: string;
  code: string;
  tail: string;
  timeoutMs: number;
  memoryLimitBytes: number;
  /** 'record' | 'replay'（native 后端的引擎级磁带需要） */
  sealMode?: 'record' | 'replay';
  /** replay 磁带（native 后端引擎级注入用；quickjs 后端走 prelude 数据） */
  tapes?: SeedTapes;
  /** gas 限额（native：引擎级确定性限额） */
  gasLimit?: number;
  /** trace 开关（native：引擎级事件） */
  trace?: { calls?: boolean; stringReturns?: boolean; callArgs?: boolean; branches?: boolean; cretFns?: string[] };
  /** 环境探针 */
  envProbe?: boolean;
  /** forced execution（native） */
  forceBranchIndex?: number;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MEMORY_LIMIT = 512 * 1024 * 1024;
