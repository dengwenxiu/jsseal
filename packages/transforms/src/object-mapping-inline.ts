/**
 * 对象键映射还原（obfuscator.io 对象映射代理）：
 *
 *   var m = {'k1': function (a, b) { return a + b; }, 'k2': 'const'};
 *   m['k1'](x, y)      → x + y
 *   m['k2']            → 'const'
 *
 * 条件：映射对象为 const 局部对象字面量；函数属性为单 return 且仅用形参；
 * 实参为字面量/标识符，或每个形参在体内恰好使用一次（避免重复求值改变语义）。
 * 全部引用替换后删除声明。
 */

import * as t from '@babel/types';
import { traverse } from '@jsseal/ast';
import type { NodePath } from '@babel/traverse';
import { result, type Transform } from './types';

interface MappingFn {
  params: t.Identifier[];
  body: t.Expression;
}
type PropValue = { kind: 'fn'; fn: MappingFn } | { kind: 'lit'; node: t.Expression };

/** 成员访问的静态键：m['k'] 或 m.k；动态键返回 null */
function memberKey(m: t.MemberExpression): string | null {
  if (m.computed) {
    return t.isStringLiteral(m.property) ? m.property.value : null;
  }
  return t.isIdentifier(m.property) ? m.property.name : null;
}

function isSimpleArg(a: t.Node): boolean {
  return t.isIdentifier(a) || t.isLiteral(a);
}

/** 统计 Identifier 在表达式中的出现次数 */
function countUses(expr: t.Expression, name: string): number {
  let n = 0;
  const walk = (node: t.Node): void => {
    if (!node || typeof node !== 'object') return;
    if (t.isIdentifier(node) && node.name === name) {
      n++;
      return;
    }
    if (t.isFunction(node) || t.isClass(node)) return; // 内层作用域不看
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
      const v = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c === 'object' && 'type' in c && walk(c as t.Node));
      else if (v && typeof v === 'object' && 'type' in (v as object)) walk(v as t.Node);
    }
  };
  walk(expr);
  return n;
}

export const inlineObjectMapping: Transform = {
  name: 'inline-object-mapping',
  risk: 'unsafe',
  async run(ast) {
    let replacedCalls = 0;
    let replacedValues = 0;
    let removedDecls = 0;

    // 收集映射对象声明：var m = { 全是函数(单return)或字面量 }
    const mappings = new Map<string, Map<string, PropValue>>();
    const declPaths = new Map<string, NodePath<t.VariableDeclarator>>();

    traverse(ast, {
      VariableDeclarator(path) {
        const id = path.node.id;
        const init = path.node.init;
        if (!t.isIdentifier(id) || !t.isObjectExpression(init) || init.properties.length === 0) return;
        const binding = path.scope.getBinding(id.name);
        if (!binding || binding.constantViolations.length > 0) return; // 声明后不可重赋值
        const props = new Map<string, PropValue>();
        let ok = true;
        for (const prop of init.properties) {
          if (!t.isObjectProperty(prop) || prop.computed) {
            ok = false;
            break;
          }
          const key = t.isStringLiteral(prop.key) ? prop.key.value : t.isIdentifier(prop.key) ? prop.key.name : null;
          if (key === null) {
            ok = false;
            break;
          }
          const v = prop.value;
          if (t.isFunctionExpression(v) && !v.id) {
            const bodyStmts = v.body.body.filter((s) => !t.isEmptyStatement(s));
            if (bodyStmts.length !== 1 || !t.isReturnStatement(bodyStmts[0]) || !bodyStmts[0].argument) {
              ok = false;
              break;
            }
            if (!v.params.every((p) => t.isIdentifier(p))) {
              ok = false;
              break;
            }
            // 体内不允许 this/arguments（手工 walker，避免对裸节点 traverse）
            let bad = false;
            const body = bodyStmts[0].argument;
            const scan = (node: t.Node): void => {
              if (bad || !node || typeof node !== 'object') return;
              if (t.isThisExpression(node) || t.isIdentifier(node, { name: 'arguments' })) {
                bad = true;
                return;
              }
              if (t.isFunction(node) || t.isClass(node)) return;
              for (const key of Object.keys(node)) {
                if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
                const v = (node as unknown as Record<string, unknown>)[key];
                if (Array.isArray(v)) v.forEach((c) => c && typeof c === 'object' && 'type' in c && scan(c as t.Node));
                else if (v && typeof v === 'object' && 'type' in (v as object)) scan(v as t.Node);
              }
            };
            scan(body);
            if (bad) {
              ok = false;
              break;
            }
            props.set(key, { kind: 'fn', fn: { params: v.params as t.Identifier[], body } });
          } else if (t.isStringLiteral(v) || t.isNumericLiteral(v) || t.isBooleanLiteral(v)) {
            props.set(key, { kind: 'lit', node: v });
          } else {
            ok = false;
            break;
          }
        }
        if (!ok || props.size === 0) return;
        mappings.set(id.name, props);
        declPaths.set(id.name, path);
      },
    });

    if (mappings.size === 0) return result(false, ['no mapping objects']);

    // 替换调用点：m['k'](a, b) → 函数体代入
    const callJobs: Array<{ path: NodePath; name: string; key: string; args: t.Expression[] }> = [];
    traverse(ast, {
      CallExpression(path) {
        const callee = path.node.callee;
        if (!t.isMemberExpression(callee)) return;
        if (!t.isIdentifier(callee.object)) return;
        const props = mappings.get(callee.object.name);
        if (!props) return;
        const key = memberKey(callee);
        if (key === null) return;
        const prop = props.get(key);
        if (!prop || prop.kind !== 'fn') return;
        const args = path.node.arguments;
        if (args.length !== prop.fn.params.length) return;
        if (!args.every((a) => t.isExpression(a) && (isSimpleArg(a) || prop.fn.params.every((p, i) => countUses(prop.fn.body, p.name) <= 1)))) {
          if (!args.every((a) => t.isExpression(a) && isSimpleArg(a))) {
            // 复杂实参：仅当每个形参恰好用一次才允许代入
            const everyOnce = prop.fn.params.every((p) => countUses(prop.fn.body, p.name) <= 1);
            if (!everyOnce) return;
          }
        }
        callJobs.push({ path, name: callee.object.name, key, args: args as t.Expression[] });
      },
    });

    for (const job of callJobs) {
      const props = mappings.get(job.name)!;
      const prop = props.get(job.key)!;
      if (prop.kind !== 'fn') continue;
      const { params, body } = prop.fn;
      let expr = t.cloneNode(body);
      for (let i = 0; i < params.length; i++) {
        expr = substitute(expr, params[i].name, t.cloneNode(job.args[i]));
      }
      try {
        job.path.replaceWith(expr);
        replacedCalls++;
      } catch {
        /* skip */
      }
    }

    // 替换纯值引用：m['k2'] → 字面量（未被调用的字面量属性）
    traverse(ast, {
      MemberExpression(path) {
        const node = path.node;
        if (!t.isIdentifier(node.object)) return;
        const props = mappings.get(node.object.name);
        if (!props) return;
        const key = memberKey(node);
        if (key === null) return;
        const prop = props.get(key);
        if (!prop || prop.kind !== 'lit') return;
        // 调用位置（m['k'](...)）跳过
        const parent = path.parentPath?.node;
        if (t.isCallExpression(parent) && parent.callee === node) return;
        path.replaceWith(t.cloneNode(prop.node));
        replacedValues++;
      },
    });

    // 声明清理：无引用则删
    for (const [name, dp] of declPaths) {
      let refs = 0;
      traverse(ast, {
        ReferencedIdentifier(rp) {
          if (rp.node.name === name) refs++;
        },
      });
      if (refs === 0 && dp.node) {
        dp.remove();
        removedDecls++;
      }
    }

    return result(replacedCalls + replacedValues > 0, [
      `calls=${replacedCalls}`,
      `values=${replacedValues}`,
      `decls-removed=${removedDecls}`,
    ]);
  },
};

/** 标识符代入（在克隆的表达式上把引用标识符替换为实参） */
function substitute(expr: t.Expression, name: string, arg: t.Expression): t.Expression {
  const file = t.file(t.program([t.expressionStatement(t.cloneNode(expr))]));
  traverse(file, {
    ReferencedIdentifier(ip) {
      if (ip.node.name === name) {
        ip.replaceWith(t.cloneNode(arg));
      }
    },
  });
  const stmt = file.program.body[0];
  return (stmt as t.ExpressionStatement).expression;
}
