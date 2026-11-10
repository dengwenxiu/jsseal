/**
 * node:crypto 浏览器替代：@jsseal/ast 仅用 sha256 生成 16-hex 缓存键，
 * FNV-1a 64 位（双 32 位拼）足够——同输入同输出，无安全语义。
 */
function fnv1a(input: string): string {
  let hi = 0x811c9dc5;
  let lo = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    lo = (lo ^ input.charCodeAt(i)) >>> 0;
    lo = Math.imul(lo, 0x01000193) >>> 0;
    hi = (hi ^ lo) >>> 0;
    hi = (hi + Math.imul(hi, 2246822507)) >>> 0;
  }
  return (hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0')).slice(0, 16);
}

export interface HashLike {
  update(v: string): HashLike;
  digest(): string;
}

export function createHash(): HashLike {
  let acc = '';
  const h: HashLike = {
    update(v: string) {
      acc += v;
      return h;
    },
    digest(): string {
      return fnv1a(acc);
    },
  };
  return h;
}
