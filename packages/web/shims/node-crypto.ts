/* oxlint-disable no-bitwise, unicorn/prefer-code-point -- 这是 FNV-1a 哈希本体：位混流（>>>/^）+ 按 UTF-16 code unit 取值是算法定义，换 codePointAt 会改变哈希值 */
/**
 * node:crypto 浏览器替代：\@jsseal/ast 仅用 sha256 生成 16-hex 缓存键，
 * FNV-1a 64 位（双 32 位拼）足够——同输入同输出，无安全语义。
 */
const fnv1a = (input: string): string => {
  let hi = 0x81_1c_9d_c5;
  let lo = 0x01_00_01_93;

  for (let i = 0; i < input.length; i += 1) {
    lo = (lo ^ input.charCodeAt(i)) >>> 0;
    lo = Math.imul(lo, 0x01_00_01_93) >>> 0;
    hi = (hi ^ lo) >>> 0;
    hi = (hi + Math.imul(hi, 2_246_822_507)) >>> 0;
  }

  return (
    hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0")
  ).slice(0, 16);
};

export interface HashLike {
  digest: () => string;
  update: (v: string) => HashLike;
}

export const createHash = (): HashLike => {
  let acc = "";

  const h: HashLike = {
    digest: (): string => fnv1a(acc),
    update: (v: string) => {
      acc += v;

      return h;
    },
  };

  return h;
};
