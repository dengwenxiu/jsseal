/**
 * 动态控制流还原（执行序探针，"静态失败 → 运行时事实"的实例）：
 *
 * 静态 unflatten-cff 依赖顺序串可静态求值（'a|b|c'.split 或常量成员）。
 * 顺序串来自函数调用/计算时（自定义混淆器常见），静态失败 → 本变换接管：
 *
 *  1. 识别"truthy while + switch(seq[i++])"分发器（seq 声明不可静态求值）
 *  2. 全锚点采样 br trace（函数名过滤），goto 序列落在被命中 case 的行区间
 *     → case 命中序
 *  3. 保守条件：序列无相邻重复（无内层循环）、跨锚点完全一致
 *  4. 按命中序重排 case 块（恒等变换，锚库逐条验证）
 */

import * as t from '@babel/types';
import { printCode, traverse } from '@jsseal/ast';
import { runSealed } from '@jsseal/runtime';
import { result, type Transform } from './types';

function truthyLike(test: t.Expression): boolean {
  if (t.isBooleanLiteral(test)) return test.value;
  if (t.isUnaryExpression(test) && test.operator === '!') {
    const a = test.argument;
    if (t.isUnaryExpression(a) && a.operator === '!' && (t.isArrayExpression(a.argument) || t.isObjectExpression(a.argument))) {
      return true;
    }
  }
  return false;
}

/** 函数名（含匿名 → '(anonymous)'） */
function enclosingFnName(path: import('@babel/traverse').NodePath): string {
  let p: import('@babel/traverse').NodePath | null = path;
  while (p) {
    const n = p.node;
    if (t.isFunctionDeclaration(n) && n.id) return n.id.name;
    if (t.isFunctionExpression(n) || t.isArrowFunctionExpression(n)) {
      const parent = p.parentPath?.node;
      if (t.isVariableDeclarator(parent) && t.isIdentifier(parent.id)) return parent.id.name;
      if (t.isObjectProperty(parent)) {
        const k = parent.key;
        return t.isIdentifier(k) ? k.name : t.isStringLiteral(k) ? k.value : '(anonymous)';
      }
      return '(anonymous)';
    }
    p = p.parentPath;
  }
  return '(anonymous)';
}

export const unflattenCffDynamic: Transform = {
  name: 'unflatten-cff-dynamic',
  risk: 'unsafe', // 运行时采样 + 结构重排（锚库验证把关）
  async run(ast, ctx) {
    if (ctx.backend !== 'native') return result(false, ['native backend only']);
    if (!ctx.corpus || ctx.corpus.samples.length === 0) return result(false, ['no corpus']);

    const candidate = printCode(ast); // 行号基准（beautified 当前码）
    const lines = candidate.split('\n').length;

    // ---------- 1) 识别静态失败的分发器 ----------
    interface Dispatcher {
      whilePath: import('@babel/traverse').NodePath<t.WhileStatement>;
      sw: t.SwitchStatement;
      seqName: string;
      fnName: string;
    }
    const dispatchers: Dispatcher[] = [];

    traverse(ast, {
      WhileStatement(path) {
        if (!truthyLike(path.node.test as t.Expression)) return;
        const body = path.node.body;
        const stmts = t.isBlockStatement(body) ? body.body : [body];
        const sw = stmts.find((s) => t.isSwitchStatement(s)) as t.SwitchStatement | undefined;
        if (!sw || stmts.filter((s) => s !== sw).some((s) => !t.isBreakStatement(s))) return;
        const d = sw.discriminant;
        if (!t.isMemberExpression(d) || !d.computed || !t.isIdentifier(d.object)) return;
        if (!t.isUpdateExpression(d.property) || !t.isIdentifier(d.property.argument)) return;
        const seqName = d.object.name;

        // 静态可解？（可静态求值则让静态版处理）
        let staticallySolvable = false;
        for (let p: import('@babel/traverse').NodePath | null = path.parentPath; p; p = p.parentPath) {
          p.traverse({
            VariableDeclarator(dp) {
              if (staticallySolvable) return;
              const id = dp.node.id;
              if (!t.isIdentifier(id) || id.name !== seqName) return;
              const init = dp.node.init;
              if (!init || !t.isCallExpression(init)) return;
              const callee = init.callee;
              if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.property) || callee.property.name !== 'split') return;
              const obj = callee.object;
              if (t.isStringLiteral(obj)) staticallySolvable = true;
            },
          });
          if (staticallySolvable) break;
        }
        if (staticallySolvable) return;

        dispatchers.push({ whilePath: path, sw, seqName, fnName: enclosingFnName(path) });
      },
    });
    if (dispatchers.length === 0) return result(false, ['no dynamic dispatcher']);

    // ---------- 2) 全锚点采样 case 命中序 ----------
    let orders: string[][] | null = null;
    for (const sample of ctx.corpus.samples) {
      let out;
      try {
        out = await runSealed({
          code: candidate,
          mode: 'replay',
          tapes: sample.tapes,
          backend: 'native',
          trace: { branches: true, cretFns: [dispatchers[0].fnName] },
          timeoutMs: ctx.timeoutMs,
          memoryLimitBytes: ctx.memoryLimitBytes,
        });
      } catch {
        return result(false, ['probe fault']);
      }
      if (out.flags.tapeExhausted || out.flags.timeout || out.flags.oom) {
        return result(false, [`probe fault: ${JSON.stringify(out.flags)}`]);
      }
      /* 只用无条件 goto（switch 查找表与 continue）——条件跳转会污染命中序分析 */
      const brLines = (out.trace?.events ?? []).filter((e) => e.k === 'go' && typeof e.l === 'number').map((e) => e.l as number);
      if (out.trace?.truncated) return result(false, ['probe trace truncated']);

      const thisOrders: string[][] = [];
      for (const d of dispatchers) {
        // case 行区间表
        const swPath = (() => {
          let found: import('@babel/traverse').NodePath<t.SwitchStatement> | null = null;
          d.whilePath.traverse({
            SwitchStatement(p) {
              if (p.node === d.sw && !found) found = p;
            },
          });
          return found;
        })();
        if (!swPath) return result(false, ['switch path lost']);
        const caseRanges: Array<{ key: string; from: number; to: number }> = [];
        for (const c of d.sw.cases) {
          if (!c.test || !t.isStringLiteral(c.test)) continue;
          const from = c.test.loc?.start.line ?? -1;
          caseRanges.push({ key: c.test.value, from, to: lines + 1 });
        }
        caseRanges.sort((a, b) => a.from - b.from);
        for (let i = 0; i < caseRanges.length - 1; i++) caseRanges[i].to = caseRanges[i + 1].from;

        // 循环体行范围（探测窗口）
        const loopFrom = d.whilePath.node.loc?.start.line ?? 1;
        const loopTo = d.whilePath.node.loc?.end.line ?? lines;
        const lineToCase = new Map<number, string>();
        for (const r of caseRanges) {
          for (let l = r.from; l < r.to; l++) lineToCase.set(l, r.key);
        }

        // goto 序 → case 命中序（相邻去重校验）
        const seq: string[] = [];
        let raw: string[] = [];
        for (const l of brLines) {
          if (l < loopFrom || l > loopTo) continue;
          const c = lineToCase.get(l);
          if (!c) continue;
          raw.push(c);
          if (seq.length === 0 || seq[seq.length - 1] !== c) seq.push(c);
        }
        if (raw.some((c, i) => i > 0 && raw[i - 1] === c)) {
          return result(false, [`dispatcher@${d.fnName}: 重复迭代（疑似内层循环），保守放弃`]);
        }
        if (seq.length !== caseRanges.length) {
          return result(false, [`dispatcher@${d.fnName}: 命中数(${seq.length}) != case 数(${caseRanges.length})，保守放弃`]);
        }
        thisOrders.push(seq);
      }
      if (orders === null) orders = thisOrders;
      else if (JSON.stringify(orders) !== JSON.stringify(thisOrders)) {
        return result(false, ['跨锚点命中序不一致（输入依赖），保守放弃']);
      }
    }

    // ---------- 3) 重排 ----------
    const notes: string[] = [];
    let count = 0;
    dispatchers.forEach((d, di) => {
      const order = orders![di];
      const caseMap = new Map<string, t.Statement[]>();
      for (const c of d.sw.cases) {
        if (!c.test || !t.isStringLiteral(c.test)) return;
        const stmts = [...c.consequent];
        const last = stmts[stmts.length - 1];
        if (last && t.isContinueStatement(last) && !last.label) stmts.pop();
        caseMap.set(c.test.value, stmts);
      }
      const out: t.Statement[] = [];
      for (const key of order) {
        const stmts = caseMap.get(key);
        if (!stmts) return;
        out.push(...stmts);
      }
      d.whilePath.replaceWith(t.blockStatement(out));
      count++;
      notes.push(`${d.fnName}:${order.join('>')}`);
    });

    // 清理 seq/idx 声明（deferred：replaceWith 后路径失效，重新遍历删 declarator）
    // v1: 保留死变量（dead-code/fold 后续无害）
    return count > 0 ? result(true, [`unflattened=${count}`, ...notes]) : result(false, notes);
  },
};
