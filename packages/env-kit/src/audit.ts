/**
 * 环境审计器：把认知库条目编译成一段 JS，在封闭运行时内求值。
 *
 * 输出与 envMisses 互补：
 * - envMisses：样本执行时**摸到了什么缺**（样本驱动，事后）
 * - envAudit：环境本身**对不对**（认知驱动，事前/事后皆可）
 */

import { KNOWLEDGE, type EnvCheck, type Severity } from './knowledge';
import { runSealed } from '@jsseal/runtime';
import type { BackendKind } from '@jsseal/runtime';

export type AuditKind = 'aligned' | 'mismatch' | 'error';

export interface AuditFailure {
  id: string;
  category: EnvCheck['category'];
  severity: Severity;
  desc: string;
  kind: 'mismatch' | 'error';
}

export interface AuditReport {
  total: number;
  aligned: number;
  mismatch: number;
  error: number;
  /** 按泄漏风险分级的缺口计数（维护优先级：先修 high） */
  highOpen: number;
  mediumOpen: number;
  lowOpen: number;
  failures: AuditFailure[];
}

export interface AuditOptions {
  /** 附加宿主代码（样本）：审计在样本执行后进行——测的是风控实际看到的环境 */
  code?: string;
  backend?: BackendKind;
  timeoutMs?: number;
  memoryLimitBytes?: number;
}

/** 审计代码生成：每条独立 try（单条抛错不影响其余） */
function buildAuditCode(): string {
  const lines = KNOWLEDGE.map(
    (k) => `try { __env[${JSON.stringify(k.id)}] = (function(){ return (${k.expr}); })(); } catch (e) { __env[${JSON.stringify(k.id)}] = 'ERROR'; }`,
  );
  return `var __env = {};\n${lines.join('\n')}\nglobalThis.__jsseal_ret_raw = JSON.stringify(__env);`;
}

export async function auditEnv(opts: AuditOptions = {}): Promise<AuditReport> {
  const auditCode = buildAuditCode();
  const code = opts.code ? `${opts.code}\n;\n${auditCode}` : auditCode;
  let out;
  try {
    out = await runSealed({
      code,
      mode: 'record',
      backend: opts.backend ?? 'quickjs',
      timeoutMs: opts.timeoutMs,
      memoryLimitBytes: opts.memoryLimitBytes,
    });
  } catch (e) {
    throw new Error(`env audit run failed: ${(e as Error).message}`);
  }
  if (!out.ok && !out.ret) throw new Error(`env audit run failed: ${out.thrown ?? 'unknown'}`);

  let values: Record<string, unknown> = {};
  try {
    values = JSON.parse(out.ret ?? '{}');
  } catch {
    throw new Error('env audit result parse failed');
  }

  const failures: AuditFailure[] = [];
  let aligned = 0;
  let mismatch = 0;
  let error = 0;
  let highOpen = 0;
  let mediumOpen = 0;
  let lowOpen = 0;
  for (const k of KNOWLEDGE) {
    const v = values[k.id];
    if (v === true) {
      aligned++;
    } else {
      const kind: 'mismatch' | 'error' = v === 'ERROR' ? 'error' : 'mismatch';
      if (kind === 'mismatch') mismatch++;
      else error++;
      failures.push({ id: k.id, category: k.category, severity: k.severity, desc: k.desc, kind });
      if (k.severity === 'high') highOpen++;
      else if (k.severity === 'medium') mediumOpen++;
      else lowOpen++;
    }
  }
  return { total: KNOWLEDGE.length, aligned, mismatch, error, highOpen, mediumOpen, lowOpen, failures };
}
