import * as t from "@babel/types";
import { parseCode } from "@jsseal/ast";
import { describe, expect, it } from "vitest";

import type { BranchNode } from "../branch-anchor";
import {
  signatureOf,
  collectBranchNodes,
  matchAnchor,
  anchorOf,
  resolveForceIndex,
} from "../branch-anchor";

/** 解析单表达式 → 表达式节点（非表达式直判测试自身错误，不靠断言收窄） */
const parseTestExpression = (code: string): t.Expression => {
  const [statement] = parseCode(code).program.body;

  if (!t.isExpressionStatement(statement)) {
    throw new Error(`expected an expression statement: ${code}`);
  }

  return statement.expression;
};

/** 取二元表达式左操作数（用于比较字面量/标识符占位） */
const leftOperandOf = (expression: t.Expression): t.Node => {
  if (!t.isBinaryExpression(expression)) {
    throw new Error("expected a binary expression");
  }

  return expression.left;
};

/** 按谓词取唯一分支节点（缺失即测试失败，替代非空断言） */
const findBranchNode = (
  nodes: BranchNode[],
  predicate: (node: BranchNode) => boolean
): BranchNode => {
  const found = nodes.find(predicate);

  if (found === undefined) {
    throw new Error("branch node not found");
  }

  return found;
};

describe("signatureOf 形状签名稳定性", () => {
  it("字面量占位：0x10 与 16 同签名；格式化/命名无关", () => {
    const a = parseTestExpression("x > 0x10");
    const b = parseTestExpression("value > 16");

    expect(signatureOf(leftOperandOf(a))).toBe(signatureOf(leftOperandOf(b)));
    expect(signatureOf(a)).toBe(signatureOf(b));
    expect(signatureOf(a)).toBe("(>_,#)");
  });

  it("常量折叠改变形状（* 折成单字面量）——签名不同（保守失配）", () => {
    const a = parseTestExpression("x > 8 * 2");
    const b = parseTestExpression("x > 16");

    expect(signatureOf(a)).not.toBe(signatureOf(b));
  });

  it("重命名后签名不变（标识符统一占位）", () => {
    const a = parseTestExpression("a.b(1) > c");
    const b = parseTestExpression("zz.yy(99) > w");

    expect(signatureOf(a)).toBe(signatureOf(b));
  });
});

describe("matchAnchor 分层匹配", () => {
  const ast = parseCode(`
var r = '';
function f(x) { if (x > 10) { r += 'a'; } if (x > 20) { r += 'b'; } return r; }
function g(y) { if (y > 10) { r += 'c'; } return r; }
f(1); g(2);
`);

  const nodes = collectBranchNodes(ast);

  it("同 sig 双出现 + fnHint 精确区分（x>10 in f vs in g）", () => {
    const inF = findBranchNode(
      nodes,
      (node) => node.fnHint === "f" && node.sig === "If:(>_,#)"
    );

    const inG = findBranchNode(nodes, (node) => node.fnHint === "g");

    expect(matchAnchor(anchorOf(inF, 1), nodes).tier).toBe("exact");
    expect(matchAnchor(anchorOf(inG, 1), nodes).index).toBe(nodes.indexOf(inG));
  });

  it("fnHint 改名失配 → 降级 sig+occurrence", () => {
    const inF = findBranchNode(
      nodes,
      (node) => node.fnHint === "f" && node.sig === "If:(>_,#)"
    );

    const anchor = { ...anchorOf(inF, 1), fnHint: "renamed" };
    const m = matchAnchor(anchor, nodes);

    expect(m.tier).toBe("sig+occ");
    expect(m.index).toBe(nodes.indexOf(inF));
  });

  it("全部失配 → none（调用方回退哨兵）", () => {
    const m = matchAnchor(
      {
        sig: "If:(_)\\bogus",
        fnHint: "(top)",
        occurrence: 1,
        line: 0,
        execOccurrence: 1,
      },
      nodes
    );

    expect(m.index).toBeNull();
    expect(m.tier).toBe("none");
  });
});

describe("resolveForceIndex 执行序定位", () => {
  it("精确行匹配 + 执行出现次序（循环内多次执行）", () => {
    const ast = parseCode(
      "function f(n) {\n  var s = 0;\n  for (var i = 0; i < n; i++) {\n    if (i > 1) { s++; }\n  }\n  return s;\n}\nf(4);"
    );

    const nodes = collectBranchNodes(ast);

    expect(nodes).toHaveLength(2);

    const loop = findBranchNode(nodes, (node) => node.kind === "For");
    const inner = findBranchNode(nodes, (node) => node.kind === "If");

    // 多行代码下两分支不同行
    expect(inner.line).toBeGreaterThan(loop.line);

    // 模拟执行序列：For#1, If#1, For#2, If#2, For#3, If#3(真), For#4, If#4(真), For#5(假退)
    const lines: number[] = [];

    for (let i = 0; i < 4; i += 1) {
      lines.push(loop.line, inner.line);
    }

    lines.push(loop.line);
    // If 第 3 次执行 → 全序列第 6 个（1-based）
    expect(resolveForceIndex(anchorOf(inner, 3), nodes, lines)).toBe(6);
    // For 第 2 次执行 → 第 3 个
    expect(resolveForceIndex(anchorOf(loop, 2), nodes, lines)).toBe(3);
  });

  it("行号不含在 trace（分支未执行）→ null", () => {
    const ast = parseCode("if (a) { x(); }\nif (b) { y(); }");
    const nodes = collectBranchNodes(ast);
    const [, second] = nodes;

    expect(resolveForceIndex(anchorOf(second, 1), nodes, [1])).toBeNull();
  });
});
