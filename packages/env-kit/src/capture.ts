/**
 * 真机采集脚本生成器：从认知库派生（单一事实源）——在真实浏览器控制台粘贴
 * 执行，下载该环境下全部认知键的快照 JSON。
 *
 * 快照用途：
 * 1. 认知库维护：新浏览器/新平台的真实值录入（"不停维护认知库"的机制化）
 * 2. 环境对齐开发：把快照值灌进 stub 配置，缩小审计缺口
 * 3. 回归基线：同一浏览器版本升级前后对比，感知检测面变化
 */

import { KNOWLEDGE } from './knowledge';

/** 生成可在浏览器控制台直接粘贴执行的采集脚本 */
export function buildCaptureScript(profileName = 'browser'): string {
  const entries = KNOWLEDGE.map(
    (k) => `  ${JSON.stringify(k.id)}: (function(){ try { var v = (${k.capture}); return v === undefined ? null : v; } catch (e) { return 'CAPTURE_ERROR'; } })(),`,
  );
  return [
    `(function () {`,
    `  var snapshot = {`,
    `    __profile: ${JSON.stringify(profileName)},`,
    `    __ua: navigator.userAgent,`,
    `    __capturedAt: new Date().toISOString(),`,
    ...entries,
    `  };`,
    `  var blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });`,
    `  var a = document.createElement('a');`,
    `  a.href = URL.createObjectURL(blob);`,
    `  a.download = 'env-snapshot-' + ${JSON.stringify(profileName)} + '.json';`,
    `  a.click();`,
    `  console.log('env snapshot downloaded:', snapshot.__profile);`,
    `})();`,
  ].join('\n');
}
