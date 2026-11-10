/**
 * @jsseal/transforms — 恒等变换集
 *
 * 变换本身不做验证；governor（@jsseal/core）负责锚库逐条验证与提交/回滚。
 * 顺序原则：先便宜后昂贵、先解码后结构（CFF 依赖解码产物字面量）。
 */

export * from './types';
export { foldConstants } from './fold-constants';
export { memberNormalize } from './member-normalize';
export { deadCode } from './dead-code';
export { splitSequences } from './sequences';
export { inlineProxyFunctions } from './proxy-inline';
export { unflattenCff } from './unflatten-cff';
export { inlineDecoder } from './inline-decoder';
export { stripAntitamper } from './strip-antitamper';
export { demangleNames } from './demangle';
export { inlineObjectMapping } from './object-mapping-inline';
export { decoderLookupTable } from './decoder-lookup-table';
export { freezeStringArray } from './freeze-string-array';
export { unflattenCffDynamic } from './unflatten-cff-dynamic';
export { unfoldEval } from './unfold-eval';
export { unfoldCtorChain } from './unfold-ctor-chain';
export { foldJsfuck } from './fold-jsfuck';
export { jsconfuserUnfold } from './jsconfuser';
export { jsconfuserStrings } from './jsconfuser-strings';
export { jsconfuserCff } from './jsconfuser-cff';
export { pruneDeadPool } from './prune-dead-pool';
export { purifyClosures } from './purify-closures';
export { foldPureCalls } from './fold-pure-calls';
export { extractBranchFingerprints, buildMigration, matchFingerprint } from './branch-fingerprint';
export type { BranchFingerprint, ForcedAnchorMigration } from './branch-fingerprint';

import type { Transform } from './types';
import { foldConstants } from './fold-constants';
import { memberNormalize } from './member-normalize';
import { deadCode } from './dead-code';
import { splitSequences } from './sequences';
import { inlineProxyFunctions } from './proxy-inline';
import { unflattenCff } from './unflatten-cff';
import { inlineDecoder } from './inline-decoder';
import { stripAntitamper } from './strip-antitamper';
import { demangleNames } from './demangle';
import { inlineObjectMapping } from './object-mapping-inline';
import { decoderLookupTable } from './decoder-lookup-table';
import { freezeStringArray } from './freeze-string-array';
import { unflattenCffDynamic } from './unflatten-cff-dynamic';
import { unfoldEval } from './unfold-eval';
import { unfoldCtorChain } from './unfold-ctor-chain';
import { foldJsfuck } from './fold-jsfuck';
import { jsconfuserUnfold } from './jsconfuser';
import { jsconfuserStrings } from './jsconfuser-strings';
import { jsconfuserCff } from './jsconfuser-cff';
import { pruneDeadPool } from './prune-dead-pool';
import { purifyClosures } from './purify-closures';
import { foldPureCalls } from './fold-pure-calls';

/** 默认管线顺序（governor 按此逐条应用+验证，迭代至不动点） */
/**
 * 默认管线顺序（governor 按此逐条应用+验证，迭代至不动点）。
 * strip-antitamper 必须最先：selfDefending 等反篡改的匿名函数无法被 AST 级
 * toString pins 覆盖，beautify 会触发惩罚分支污染所有后续验证。
 */
export const defaultPipeline: Transform[] = [
  stripAntitamper,
  foldJsfuck,
  unfoldEval,
  unfoldCtorChain,
  jsconfuserStrings,
  jsconfuserUnfold,
  jsconfuserCff,
  foldConstants,
  memberNormalize,
  freezeStringArray,
  inlineDecoder,
  pruneDeadPool,
  decoderLookupTable,
  inlineObjectMapping,
  deadCode,
  splitSequences,
  inlineProxyFunctions,
  unflattenCff,
  unflattenCffDynamic,
  purifyClosures,
  foldPureCalls,
  demangleNames,
];
