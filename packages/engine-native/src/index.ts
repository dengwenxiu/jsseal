/**
 * @jsseal/engine-native — quickjs-ng fork (jsseal) N-API 绑定
 *
 * 二进制产物由 engine/build.sh 编译（native/jsseal_engine.node）；
 * 正式分发走 CI 三平台预编译矩阵（esbuild 式 optionalDependencies，见 docs/ARCHITECTURE.md §8）。
 */

export interface NativeSealedRunOptions {
  prelude: string;
  code: string;
  captureTail: string;
  dumpExpr: string;
  memoryLimit: number;
  timeoutMs: number;
  /** 'off' | 'record' | 'replay'（缺省 off） */
  seedMode?: 'off' | 'record' | 'replay';
  /** replay 模式的引擎磁带（random/date/time） */
  seedTapes?: { random?: number[]; date?: number[]; time?: number[]; crypto?: number[] };
  /** gas 限额（单位：interrupt 轮 = 10000 ops；0=不限） */
  gasLimit?: number;
  /** trace 开关 */
  trace?: { calls?: boolean; stringReturns?: boolean; callArgs?: boolean; branches?: boolean; cretFns?: string[] };
  /** forced execution：>0 时翻转第 k 个执行的条件分支（多路径覆盖锚点） */
  forceBranchIndex?: number;
}

export interface NativeSealedRunResult {
  dump?: string;
  fault?: 'prelude-error' | 'dump-error' | 'oom';
  detail?: string;
  /** 引擎级种子磁带（record 后回读） */
  seedTapes?: { random: number[]; date: number[]; time: number[]; crypto?: number[] };
  /** 引擎级种子消费计数 */
  seedConsumed?: { random: number; date: number; time: number; crypto?: number };
  /** 磁带耗尽哨兵 */
  seedExhausted?: boolean;
  /** gas 消耗（单位：interrupt 轮 = 10000 ops） */
  gasUsed?: number;
  /** trace 事件 JSON 数组文本 */
  traceJson?: string;
  traceTruncated?: boolean;
  traceCount?: number;
  /** 强制分支是否实际触发（目标行执行过） */
  forceApplied?: boolean;
}

interface EngineAddon {
  sealedRun(opts: NativeSealedRunOptions): NativeSealedRunResult;
  engineVersion: string;
}

let cached: EngineAddon | null = null;

export function loadEngine(): EngineAddon {
  cached ??= require('../native/jsseal_engine.node') as EngineAddon;
  return cached;
}

export function engineVersion(): string {
  return loadEngine().engineVersion;
}

export function runSealedNative(opts: NativeSealedRunOptions): NativeSealedRunResult {
  return loadEngine().sealedRun(opts);
}

/** native 引擎二进制是否可用（用于默认后端选择与自动降级） */
export function isEngineAvailable(): boolean {
  try {
    loadEngine();
    return true;
  } catch {
    return false;
  }
}
