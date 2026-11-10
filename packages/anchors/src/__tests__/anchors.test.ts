import { describe, expect, it } from 'vitest';
import { buildCorpus, compareOutputs, validateCorpus } from '../index';

const seeded = `
function mk() { return 'id-' + Math.random().toString(36).slice(2, 8) + '-' + Date.now(); }
var a = mk();
console.log(a);
console.log(mk());
`;

describe('anchors · 锚库', () => {
  it('采样造锚：多样本各自冻结，自检通过', async () => {
    const corpus = await buildCorpus({ code: seeded, samples: 3 });
    expect(corpus.samples.length).toBe(3);
    expect(corpus.degraded).toBe(false);
    // 不同预跑天然熵不同 → 磁带不同（样本多样性）
    const t0 = corpus.samples[0].tapes.random.join(',');
    const t1 = corpus.samples[1].tapes.random.join(',');
    expect(t0).not.toBe(t1);
  });

  it('原代码重放 → 全部锚点通过', async () => {
    const corpus = await buildCorpus({ code: seeded, samples: 2 });
    const v = await validateCorpus(corpus, seeded);
    expect(v.pass).toBe(true);
  });

  it('语义改变（偷改输出）→ 锚点失败', async () => {
    const corpus = await buildCorpus({ code: seeded, samples: 2 });
    const mutated = seeded.replace("return 'id-'", "return 'ID2-'");
    expect(mutated).not.toBe(seeded);
    const v = await validateCorpus(corpus, mutated);
    expect(v.pass).toBe(false);
    expect(v.failures.some((f) => f.kind === 'diff')).toBe(true);
  });

  it('恒等变换（重排空格/重命名）→ 锚点通过', async () => {
    const corpus = await buildCorpus({ code: seeded, samples: 2 });
    const renamed = `
function mk2() { return 'id-' + Math.random().toString(36).slice(2, 8) + '-' + Date.now(); }
var a = mk2();
console.log(a);
console.log(mk2());
`;
    const v = await validateCorpus(corpus, renamed);
    expect(v.pass).toBe(true);
  });

  it('屏障破坏（删除一次种子调用）→ consumed 计数暴露失败', async () => {
    const code = `console.log(Math.random()); console.log(Math.random()); console.log('done');`;
    const corpus = await buildCorpus({ code, samples: 2 });
    // 少消费一个种子：不会触发磁带越界，但 consumed 计数不一致 → 判失败
    const violated = `console.log(Math.random()); console.log('done');`;
    const v = await validateCorpus(corpus, violated);
    expect(v.pass).toBe(false);
    expect(v.failures.some((f) => f.detail.includes('consumed.random'))).toBe(true);
  });

  it('屏障破坏（新增一次种子调用）→ 磁带越界判失败', async () => {
    const code = `console.log(Math.random()); console.log('done');`;
    const corpus = await buildCorpus({ code, samples: 2 });
    const violated = `console.log(Math.random()); console.log(Math.random()); console.log('done');`;
    const v = await validateCorpus(corpus, violated);
    expect(v.pass).toBe(false);
    expect(v.failures.some((f) => f.detail.includes('barrier violation'))).toBe(true);
  });

  it('compareOutputs 字段级 diff', () => {
    const a = {
      ok: true, console: [{ level: 'log', text: '"x"' }], storage: {},
      consumed: { random: 1, date: 0, time: 0, crypto: 0 },
      tapes: { random: [], date: [], time: [], crypto: [] }, flags: {},
    };
    const b = {
      ok: true, console: [{ level: 'log', text: '"y"' }], storage: {},
      consumed: { random: 1, date: 0, time: 0, crypto: 0 },
      tapes: { random: [], date: [], time: [], crypto: [] }, flags: {},
    };
    const { equal, diffs } = compareOutputs(a as never, b as never);
    expect(equal).toBe(false);
    expect(diffs[0].field).toBe('console');
  });
});
