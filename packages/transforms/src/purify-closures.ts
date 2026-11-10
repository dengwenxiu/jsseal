/**
 * 局部函数纯化（POSITIONING §5.1：纯函数封闭是文件级的，局部函数可能因
 * 闭包捕获而不纯——把依赖显式化，纯化越多可优化的面越大）。
 *
 * 两条策略：
 * - **提升（hoist）**：捕获变量是单赋值（binding.constant）且初始化
 *   "位置无关纯"（字面量数组/对象/模块级引用的四则组合）→ 把声明提升到
 *   模块顶层，函数也一并提升——依赖只剩模块级绑定 + 参数 = **top-pure**。
 *   这正是"通过提升变量作用域消除不纯"。
 * - **参数化（param）**：捕获变量会被重赋值（值随时间变化）→ 作为前导
 *   参数显式化：`F(a,b)` → `F(v,a,b)`（调用点传当前值——与闭包按引用
 *   在调用时刻读值语义一致）。
 *
 * 安全栅栏（全部满足才动，governor 锚库再兜底）：
 * - 捕获变量在 F 内只读（无赋值/自增/解构目标）
 * - F 的名字引用全部是直接调用（不逃逸：无 return F / 回调 / 属性引用）
 * - F 体内不引用 `arguments`（加前导参数会改变 arguments.length）与 `this`
 *   （提升改变 this 归属）
 * - 参数化时每个调用点对捕获名解析到同一绑定（调用点局部 shadow 视为
 *   不同绑定 → 弃，防"闭包看外层、实参传 shadow"的错位）
 * - 递归自调用同样改写：F 体内自调用传的是（新）参数名——值经参数流过，
 *   语义一致
 */

import * as t from '@babel/types';
import { traverse } from '@jsseal/ast';
import { result, type Transform } from './types';
import type { NodePath, Scope } from '@babel/traverse';

/** 初始化是否"位置无关纯"：提前到模块顶层执行，可观测行为不变 */
function isPureInit(node: t.Node, programScope: Scope): boolean {
  if (t.isLiteral(node)) return true;
  if (t.isArrayExpression(node)) return node.elements.every((e) => e === null || isPureInit(e, programScope));
  if (t.isObjectExpression(node)) {
    return node.properties.every((p) => t.isObjectProperty(p) && !p.computed && isPureInit(p.value, programScope));
  }
  if (t.isIdentifier(node)) {
    const b = programScope.getBinding(node.name);
    return !!b && b.scope.block.type === 'Program';
  }
  if (t.isUnaryExpression(node) && ['!', '-', '+', '~'].includes(node.operator)) return isPureInit(node.argument, programScope);
  if (t.isBinaryExpression(node)) return isPureInit(node.left, programScope) && isPureInit(node.right, programScope);
  return false;
}

/** Identifier 节点是否处于"被引用"位置（排除非计算属性键/标签等非引用位置） */
function isRefPosition(node: t.Identifier, parent: t.Node | null): boolean {
  if (!parent) return true;
  if (t.isMemberExpression(parent) && !parent.computed && parent.property === node) return false;
  if (t.isObjectProperty(parent) && !parent.shorthand && parent.key === node) return false;
  if (t.isObjectMethod(parent) && parent.key === node && !parent.computed) return false;
  if ((t.isLabeledStatement(parent) || t.isBreakStatement(parent) || t.isContinueStatement(parent)) && parent.label === node) return false;
  return true;
}

/** 通用子树遍历（key 值为 AST 节点/数组即下钻） */
function walk(node: t.Node, visit: (n: t.Node, parent: t.Node | null) => void, parent: t.Node | null = null): void {
  if (!node || typeof node !== 'object') return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
    const v = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c === 'object' && 'type' in c && walk(c as t.Node, visit, node));
    else if (v && typeof v === 'object' && 'type' in v) walk(v as t.Node, visit, node);
  }
}

/** F 体内被赋值（写）的标识符集合 */
function mutatedNames(fn: t.FunctionDeclaration): Set<string> {
  const names = new Set<string>();
  const checkTarget = (pat: t.Node | null | undefined): void => {
    if (!pat) return;
    if (t.isIdentifier(pat)) names.add(pat.name);
    else if (t.isRestElement(pat)) checkTarget(pat.argument);
    else if (t.isAssignmentPattern(pat)) checkTarget(pat.left);
    else if (t.isArrayPattern(pat)) pat.elements.forEach((e) => checkTarget(e));
    else if (t.isObjectPattern(pat)) pat.properties.forEach((p) => checkTarget(t.isRestElement(p) ? p : p.value));
  };
  walk(fn, (n) => {
    if (t.isAssignmentExpression(n)) checkTarget(n.left);
    else if (t.isUpdateExpression(n)) checkTarget(n.argument);
    else if (t.isForInStatement(n) || t.isForOfStatement(n)) checkTarget(n.left);
  });
  return names;
}

interface Capture {
  name: string;
  strategy: 'hoist' | 'param';
  binding: import('@babel/traverse').Binding;
}

interface Job {
  fnPath: NodePath<t.FunctionDeclaration>;
  fnName: string;
  fnNode: t.FunctionDeclaration;
  fnBinding: import('@babel/traverse').Binding;
  captures: Capture[];
  hoistFn: boolean;
}

function scopeIsAncestorOf(anc: Scope | undefined, desc: Scope): boolean {
  let s: Scope | null = desc;
  while (s) {
    if (s === anc) return true;
    s = s.parent;
  }
  return false;
}

/** 找第一个可纯化的嵌套函数（不在 skip 集中） */
function findCandidate(ast: t.File, skip: Set<string>): Job | null {
  let found: Job | null = null;
  traverse(ast, {
    FunctionDeclaration(path) {
      if (found || !path.node.id) return;
      const fn = path.node;
      const fnName = path.node.id.name;
      const key = `${fnName}@${fn.start}`;
      if (skip.has(key)) return;
      // 必须嵌套在函数内（模块顶层函数已天然接近 top-pure）
      let sc: Scope | null = path.scope.parent;
      let insideFunction = false;
      while (sc) {
        if (t.isFunction(sc.block)) { insideFunction = true; break; }
        if (sc.block.type === 'Program') break;
        sc = sc.parent;
      }
      if (!insideFunction) return;

      // F 体内禁用 arguments / this
      let usesArguments = false;
      let usesThis = false;
      walk(fn, (n) => {
        if (t.isIdentifier(n) && n.name === 'arguments') usesArguments = true;
        if (t.isThisExpression(n)) usesThis = true;
      });
      if (usesArguments || usesThis) { skip.add(key); return; }

      const fnBinding = path.scope.parent.getBinding(fnName);
      if (!fnBinding) { skip.add(key); return; }

      // 自由变量分类：函数作用域捕获 → hoist/param；块作用域捕获/其他 → 弃
      const fScope = path.scope;
      const mutated = mutatedNames(fn);
      const freeNames = new Set<string>();
      const fnId = fn.id;
      walk(fn, (n, parent) => {
        // 排除自身名字：递归自引用解析到 F 的声明（binding.scope 为祖先函数
        // 作用域），会被误判成"兄弟函数捕获"→ 同一节点被 remove 两次（踩坑实测）
        if (t.isIdentifier(n) && isRefPosition(n, parent) && n !== fnId && n.name !== fnName && n.name !== 'arguments') freeNames.add(n.name);
      });
      const captures: Capture[] = [];
      for (const name of freeNames) {
        const b = fScope.getBinding(name);
        if (!b) continue; // 未定义全局：留给环境探针
        if (b.scope === fScope || scopeIsAncestorOf(fScope, b.scope)) continue; // F 自身/内部声明
        if (b.scope.block.type === 'Program') continue; // 模块级：已 top-pure
        if (!scopeIsAncestorOf(b.scope, fScope)) { skip.add(key); return; } // 非祖先（异常）→ 弃
        if (!t.isFunction(b.scope.block)) { skip.add(key); return; } // 祖先是块作用域 → Phase 1 弃
        if (mutated.has(name)) { skip.add(key); return; } // F 内写捕获 → 弃
        // 分类
        if (t.isVariableDeclarator(b.path.node) && b.constant && b.path.node.init) {
          captures.push({ name, strategy: 'hoist', binding: b });
        } else if (t.isFunctionDeclaration(b.path.node) && b.constant) {
          captures.push({ name, strategy: 'hoist', binding: b }); // 兄弟函数：整函数提升
        } else {
          captures.push({ name, strategy: 'param', binding: b });
        }
      }
      if (captures.length === 0) { skip.add(key); return; }

      // 逃逸检查：F 的全部名字引用必须是直接调用（可解析到同一绑定）
      const program = path.scope.getProgramParent();
      let callsites: NodePath<t.Identifier>[] = [];
      let escaped = false;
      traverse(ast, {
        Identifier(ip) {
          if (ip.node.name !== fnName || !isRefPosition(ip.node, ip.parent)) return;
          if (ip.isBindingIdentifier?.()) {
            // 声明处 id 与函数形参不算调用点
            if ((t.isFunctionDeclaration(ip.parent) && ip.parent.id === ip.node)) return;
          }
          if (ip.scope.getBinding(fnName) !== fnBinding) return; // 同名其他绑定
          const p = ip.parent;
          if (t.isCallExpression(p) && p.callee === ip.node) {
            callsites.push(ip);
          } else {
            escaped = true;
          }
        },
      });
      if (escaped || callsites.length === 0) { skip.add(key); return; }

      // 参数化可行性：每个调用点对每个 param 捕获名解析到同一绑定
      //（F 体内的自调用豁免——其内部将引用新参数）
      for (const c of captures) {
        if (c.strategy !== 'param') continue;
        for (const cs of callsites) {
          if (cs.find((n) => n.node === fn)) continue; // F 体内自调用
          if (cs.scope.getBinding(c.name) !== c.binding) { skip.add(key); return; }
        }
      }

      // F 是否可整体提升：直接声明在（某个）函数体的语句层
      const hoistFn = t.isBlockStatement(path.parent) && t.isFunction(path.parentPath?.parent);
      found = { fnPath: path, fnName, fnNode: fn, fnBinding, captures, hoistFn };
    },
  });
  return found;
}

function applyJob(ast: t.File, job: Job): boolean {
  let programPath: NodePath<t.Program> | undefined;
  traverse(ast, { Program(path) { programPath = path; path.stop(); } });
  if (!programPath) return false;

  // ---------- 1) 提升类捕获：声明/函数搬移到模块顶层 ----------
  for (const c of job.captures) {
    if (c.strategy !== 'hoist') continue;
    let name = c.name;
    if (programPath.scope.hasBinding(name, true)) {
      const newName = `${name}_lift`;
      c.binding.scope.rename(name, newName);
      name = newName;
    }
    const declPath = c.binding.path;
    if (declPath === job.fnPath) continue; // 防御：捕获即 F 自身（自引用漏网）
    if (t.isVariableDeclarator(declPath.node)) {
      const init = declPath.node.init;
      if (!init) return false;
      const stmt = t.variableDeclaration('var', [t.variableDeclarator(t.identifier(name), t.cloneNode(init, true))]);
      declPath.remove();
      programPath.node.body.unshift(stmt);
    } else if (t.isFunctionDeclaration(declPath.node)) {
      const fnNode = declPath.node;
      declPath.remove();
      programPath.node.body.unshift(t.cloneNode(fnNode, true));
    } else {
      return false;
    }
  }

  // ---------- 2) 参数化捕获：前导参数 + 调用点改写 ----------
  const paramCaptures = job.captures.filter((c) => c.strategy === 'param');
  if (paramCaptures.length > 0) {
    job.fnNode.params.unshift(...paramCaptures.map((c) => t.identifier(c.name)));
    traverse(ast, {
      CallExpression(cp) {
        const callee = cp.node.callee;
        if (!t.isIdentifier(callee) || callee.name !== job.fnName) return;
        if (cp.scope.getBinding(job.fnName) !== job.fnBinding) return;
        // F 体内自调用：传（新）参数名；外部调用点：传当前值（同绑定已验证）
        cp.node.arguments.unshift(...paramCaptures.map((c) => t.identifier(c.name)));
      },
    });
  }

  // ---------- 3) F 整体提升 ----------
  if (job.hoistFn) {
    let name = job.fnName;
    if (programPath.scope.hasBinding(name, true) && programPath.scope.getBinding(name) !== job.fnBinding) {
      const newName = `${name}_lift`;
      job.fnBinding.scope.rename(name, newName);
      name = newName;
    }
    job.fnPath.remove();
    programPath.node.body.push(job.fnNode);
  }
  return true;
}

export const purifyClosures: Transform = {
  name: 'purify-closures',
  risk: 'unsafe',
  async run(ast) {
    const skip = new Set<string>();
    let purified = 0;
    let hoistedVars = 0;
    let paramed = 0;
    // 每次处理后重新遍历（scope 全新）；一次调用最多处理 8 个，更多靠 governor 轮次
    for (let i = 0; i < 8; i++) {
      const job = findCandidate(ast, skip);
      if (!job) break;
      const key = `${job.fnName}@${job.fnNode.start}`;
      if (!applyJob(ast, job)) { skip.add(key); continue; }
      purified++;
      hoistedVars += job.captures.filter((c) => c.strategy === 'hoist').length;
      paramed += job.captures.filter((c) => c.strategy === 'param').length;
    }
    if (purified === 0) return result(false, ['no purification sites']);
    const notes = [`functions=${purified}`];
    if (hoistedVars > 0) notes.push(`hoisted=${hoistedVars}`);
    if (paramed > 0) notes.push(`param=${paramed}`);
    return result(true, notes);
  },
};
