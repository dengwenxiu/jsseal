/**
 * 解码器查找表替换（trace 驱动的恒等变换，"动态产生事实、静态执行改写"的 M2.4 实例）：
 *
 *  1. 在全部锚点样本上重放当前代码并开启 cret trace（call 实参+返回值）
 *  2. 聚合每个解码函数的 (args → 返回值) 表；同 args 出现不同返回值 → 判非确定，放弃
 *  3. 把解码函数体替换为：
 *
 *       function dec(a, b) {
 *         switch ('' + a + '|' + b) {      // 运行时查表（fast path）
 *           case '448|kEwV': return 'SECRET_KEY_123';
 *           ...
 *           default: return dec__orig(a, b);  // 未观测输入 → 原实现（保守恒等）
 *         }
 *       }
 *       function dec__orig(a, b) { ...原函数体... }
 *
 *  语义：已观测输入走表，未观测输入走原逻辑——对纯函数（种子零消费前提）恒等，
 *  由锚库逐条验证把关。价值：全部解码明文变成代码中可见的常量（覆盖静态
 *  inline-decoder 处理不了的非字面量参数调用点）。
 */

import * as t from '@babel/types';
import { traverse } from '@jsseal/ast';
import { runSealed } from '@jsseal/runtime';
import { result, type Transform } from './types';

const MAX_TABLE_ENTRIES = 50000;

/** 与生成代码的键表达式（'' + a + '|' + b）保持一致的键生成 */
function keyOf(args: unknown[]): string {
  return args.map((x) => `${x}`).join('|');
}

export const decoderLookupTable: Transform = {
  name: 'decoder-lookup-table',
  risk: 'unsafe', // 执行求值采样 + 函数体替换（锚库验证把关）
  async run(ast, ctx) {
    const plan = ctx.detection.obfuscatorIO;
    if (!plan || plan.decoderNames.length === 0) return result(false, ['no decoder plan']);
    if (ctx.backend !== 'native') return result(false, ['native backend only']);
    if (!ctx.corpus || ctx.corpus.samples.length === 0) return result(false, ['no corpus']);

    // ---------- 1) 锚点采样：聚合 (fn → argsKey → v) ----------
    // 冲突语义（sojson v7 教训）：同实参不同返回多为【时间性】——自检轮转前后
    // 解码值不同。逐键冲突跳过（该键走 fallback 原实现，自检路径不受影响），
    // 稳定键进表；只有函数无任何稳定键时才整体放弃。
    const tables = new Map<string, Map<string, unknown>>();
    const conflictedKeys = new Set<string>(); // "fn|key"
    const conflicted = new Set<string>();
    const decoderSet = new Set(plan.decoderNames);
    let taintedSkipped = 0;
    let conflictSkipped = 0;

    const observe = (fn: string, key: string, v: unknown): void => {
      let tbl = tables.get(fn);
      if (!tbl) {
        tbl = new Map();
        tables.set(fn, tbl);
      }
      if (tbl.has(key)) {
        if (JSON.stringify(tbl.get(key)) !== JSON.stringify(v)) {
          tbl.delete(key);
          conflictedKeys.add(`${fn}|${key}`);
          conflictSkipped++;
        }
      } else if (!conflictedKeys.has(`${fn}|${key}`)) {
        if (tbl.size >= MAX_TABLE_ENTRIES) {
          conflicted.add(fn);
          return;
        }
        tbl.set(key, v);
      }
    };

    for (const sample of ctx.corpus.samples) {
      if (sample.forceIndex !== undefined) continue;
      let out;
      try {
        out = await runSealed({
          code: ctx.code,
          mode: 'replay',
          tapes: sample.tapes,
          backend: 'native',
          trace: { callArgs: true, cretFns: plan.decoderNames },
          timeoutMs: ctx.timeoutMs,
          memoryLimitBytes: ctx.memoryLimitBytes,
        });
      } catch {
        continue;
      }
      if (out.flags.tapeExhausted || out.flags.timeout || out.flags.oom) continue;
      for (const ev of out.trace?.events ?? []) {
        if (ev.k !== 'cret' || !ev.a || !decoderSet.has(ev.fn)) continue;
        if (conflicted.has(ev.fn)) continue;
        // 污点：输出感染种子（不稳定变量）→ 该条目不可常量化，跳过
        if (ev.t) {
          taintedSkipped++;
          continue;
        }
        const v = ev.v;
        if (v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) {
          observe(ev.fn, keyOf(ev.a), v);
        }
      }
    }

    // ---------- 2) 找到解码函数声明并替换体 ----------
    const notes: string[] = [];
    let replaced = 0;
    const handled = new Set<string>();

    traverse(ast, {
      FunctionDeclaration(path) {
        const name = path.node.id?.name;
        if (!name || handled.has(name)) return;
        const tbl = tables.get(name);
        if (!tbl || tbl.size === 0 || conflicted.has(name)) return;
        const params = path.node.params;
        if (!params.every((p) => t.isIdentifier(p))) return;
        const paramNames = params.map((p) => (p as t.Identifier).name);
        if (paramNames.length === 0 || paramNames.length > 3) return;

        // 键表达式：'' + a + '|' + b（与 keyOf 一致）
        let keyExpr: t.Expression = t.binaryExpression('+', t.stringLiteral(''), t.identifier(paramNames[0]));
        for (let i = 1; i < paramNames.length; i++) {
          keyExpr = t.binaryExpression('+', keyExpr, t.binaryExpression('+', t.stringLiteral('|'), t.identifier(paramNames[i])));
        }

        // fallback 原函数（重命名保留）
        const origName = `${name}__orig`;
        const origFn = t.functionDeclaration(t.identifier(origName), path.node.params, path.node.body);
        // 注意：params 被复用——克隆避免 AST 节点共享
        origFn.params = params.map((p) => t.cloneNode(p));

        // 表体：小表用 switch（可读），大表（>128 条，如 sojson 5000+）用对象映射（避免巨型 switch）
        let dispatcher: t.Statement;
        if (tbl.size <= 128) {
          const cases: t.SwitchCase[] = [];
          for (const [key, v] of tbl) {
            cases.push(
              t.switchCase(t.stringLiteral(key), [t.returnStatement(t.valueToNode(v))]),
            );
          }
          cases.push(
            t.switchCase(null, [
              t.returnStatement(
                t.callExpression(
                  t.identifier(origName),
                  paramNames.map((n) => t.identifier(n)),
                ),
              ),
            ]),
          );
          dispatcher = t.switchStatement(keyExpr, cases);
        } else {
          const props: t.ObjectProperty[] = [];
          for (const [key, v] of tbl) {
            props.push(t.objectProperty(t.stringLiteral(key), t.valueToNode(v)));
          }
          const tblVar = path.scope.generateUidIdentifier('decTbl');
          dispatcher = t.blockStatement([
            t.variableDeclaration('var', [t.variableDeclarator(tblVar, t.objectExpression(props))]),
            t.ifStatement(
              t.binaryExpression('in', keyExpr, t.identifier(tblVar.name)),
              t.returnStatement(t.memberExpression(t.identifier(tblVar.name), keyExpr, true)),
              t.returnStatement(
                t.callExpression(
                  t.identifier(origName),
                  paramNames.map((n) => t.identifier(n)),
                ),
              ),
            ),
          ]);
        }

        const newBody = t.blockStatement([
          dispatcher,
          t.functionDeclaration(t.identifier(origName), origFn.params, origFn.body),
        ]);
        path.replaceWith(t.functionDeclaration(t.identifier(name), params.map((p) => t.cloneNode(p)), newBody));
        handled.add(name);
        replaced++;
        notes.push(`${name}:${tbl.size}`);
      },
    });

    if (taintedSkipped > 0) notes.push(`tainted-skipped=${taintedSkipped}`);
    if (conflictSkipped > 0) notes.push(`conflict-keys-skipped=${conflictSkipped}`);
    if (replaced === 0) {
      return result(false, [
        conflicted.size > 0 ? `conflicted=${[...conflicted].join(',')}` : 'no table',
        ...notes,
      ]);
    }
    return result(true, [`tables=${replaced}`, ...notes]);
  },
};
