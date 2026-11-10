/**
 * @jsseal/env-kit — 环境对齐认知库与审计器
 *
 * 环境即封闭边界：风控 SDK 对环境感知敏感，异常环境 → 非预期分支 →
 * 锚库采样走偏 → 优化跟着走偏。环境的正常性不可证明，只能持续维护
 * 认知库（knowledge.ts）——每条认知可机器校验（audit）、可真机采集
 * （capture）、带风控语义与泄漏分级。
 */

export { KNOWLEDGE, KNOWLEDGE_BY_ID } from './knowledge';
export type { EnvCheck, EnvCategory, Severity } from './knowledge';
export { auditEnv } from './audit';
export type { AuditReport, AuditFailure, AuditOptions, AuditKind } from './audit';
export { buildCaptureScript } from './capture';
