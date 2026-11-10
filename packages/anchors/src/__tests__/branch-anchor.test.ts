import { describe, expect, it } from 'vitest';
import { parseCode } from '@jsseal/ast';
import { shapeSig, collectBranchNodes, matchAnchor, anchorOf, resolveForceIndex } from '../branch-anchor';
import * as t from '@babel/types';

describe('shapeSig 形状签名稳定性', () => {
  it('字面量占位：0x10 与 16 同签名；格式化/命名无关', () => {
    const a = parseCode('x > 0x10').program.body[0] as t.ExpressionStatement;
    const b = parseCode('value > 16').program.body[0] as t.ExpressionStatement;
    expect(shapeSig((a.expression as t.BinaryExpression).left)).toBe(shapeSig((b.expression as t.BinaryExpression).left));
    expect(shapeSig(a.expression)).toBe(shapeSig(b.expression));
    expect(shapeSig(a.expression)).toBe('(>_,#)');
  });

  it('常量折叠改变形状（* 折成单字面量）——签名不同（保守失配）', () => {
    const a = parseCode('x > 8 * 2').program.body[0] as t.ExpressionStatement;
    const b = parseCode('x > 16').program.body[0] as t.ExpressionStatement;
    expect(shapeSig(a.expression)).not.toBe(shapeSig(b.expression));
  });

  it('重命名后签名不变（标识符统一占位）', () => {
    const a = parseCode('a.b(1) > c').program.body[0] as t.ExpressionStatement;
    const b = parseCode('zz.yy(99) > w').program.body[0] as t.ExpressionStatement;
    expect(shapeSig(a.expression)).toBe(shapeSig(b.expression));
  });
});

describe('matchAnchor 分层匹配', () => {
  const ast = parseCode(`
var r = '';
function f(x) { if (x > 10) { r += 'a'; } if (x > 20) { r += 'b'; } return r; }
function g(y) { if (y > 10) { r += 'c'; } return r; }
f(1); g(2);
`);
  const nodes = collectBranchNodes(ast);

  it('同 sig 双出现 + fnHint 精确区分（x>10 in f vs in g）', () => {
    const inF = nodes.find((n) => n.fnHint === 'f' && n.sig === 'If:(>_,#)')!;
    const inG = nodes.find((n) => n.fnHint === 'g')!;
    expect(matchAnchor(anchorOf(inF, 1), nodes).tier).toBe('exact');
    expect(matchAnchor(anchorOf(inG, 1), nodes).index).toBe(nodes.indexOf(inG));
  });

  it('fnHint 改名失配 → 降级 sig+occurrence', () => {
    const inF = nodes.find((n) => n.fnHint === 'f' && n.sig === 'If:(>_,#)')!;
    const anchor = { ...anchorOf(inF, 1), fnHint: 'renamed' };
    const m = matchAnchor(anchor, nodes);
    expect(m.tier).toBe('sig+occ');
    expect(m.index).toBe(nodes.indexOf(inF));
  });

  it('全部失配 → none（调用方回退哨兵）', () => {
    const m = matchAnchor({ sig: 'If:(_)\\bogus', fnHint: '(top)', occurrence: 1, line: 0, execOccurrence: 1 }, nodes);
    expect(m.index).toBeNull();
    expect(m.tier).toBe('none');
  });
});

describe('resolveForceIndex 执行序定位', () => {
  it('精确行匹配 + 执行出现次序（循环内多次执行）', () => {
    const ast = parseCode('function f(n) {\n  var s = 0;\n  for (var i = 0; i < n; i++) {\n    if (i > 1) { s++; }\n  }\n  return s;\n}\nf(4);');
    const nodes = collectBranchNodes(ast);
    expect(nodes.length).toBe(2);
    const loop = nodes.find((n) => n.kind === 'For')!;
    const inner = nodes.find((n) => n.kind === 'If')!;
    expect(inner.line).toBeGreaterThan(loop.line); // 多行代码下两分支不同行
    // 模拟执行序列：For#1, If#1, For#2, If#2, For#3, If#3(真), For#4, If#4(真), For#5(假退)
    const lines: number[] = [];
    for (let i = 0; i < 4; i++) { lines.push(loop.line, inner.line); }
    lines.push(loop.line);
    // If 第 3 次执行 → 全序列第 6 个（1-based）
    expect(resolveForceIndex(anchorOf(inner, 3), nodes, lines)).toBe(6);
    // For 第 2 次执行 → 第 3 个
    expect(resolveForceIndex(anchorOf(loop, 2), nodes, lines)).toBe(3);
  });

  it('行号不含在 trace（分支未执行）→ null', () => {
    const ast = parseCode('if (a) { x(); }\nif (b) { y(); }');
    const nodes = collectBranchNodes(ast);
    const second = nodes[1];
    expect(resolveForceIndex(anchorOf(second, 1), nodes, [1])).toBeNull();
  });
});
