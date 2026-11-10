/**
 * @jsseal/transforms — 恒等变换接口
 *
 * 宪法：一切变换都是确定性恒等变换；governor 在锚库上逐条验证后才能提交。
 */

import type { Detection } from '@jsseal/detector';
import type { BackendKind } from '@jsseal/runtime';
import type * as t from '@babel/types';
import type { Corpus } from '@jsseal/anchors';

export interface TransformResult {
  changed: boolean;
  notes: string[];
  /** 重命名对（demangle），governor 用于同步 FunctionRegistry pins 的键名 */
  renamePairs?: Array<{ from: string; to: string }>;
}

export interface TransformContext {
  /** 当前轮的代码文本（变换输入） */
  code: string;
  detection: Detection;
  backend: BackendKind;
  timeoutMs?: number;
  memoryLimitBytes?: number;
  /** 验证锚库（trace 驱动的变换在此采样执行事实；governor 注入） */
  corpus?: Corpus;
}

export interface Transform {
  name: string;
  risk: 'safe' | 'unsafe';
  run(ast: t.File, ctx: TransformContext): Promise<TransformResult>;
}

export function result(changed: boolean, notes: string[] = [], renamePairs?: Array<{ from: string; to: string }>): TransformResult {
  return { changed, notes, renamePairs };
}
