/**
 * LLM 辅助标识符重命名（"LLM only suggests names" 原则的实现）：
 *
 * 1. 收集所有 _0x 样式标识符及其使用上下文（前后各 N 行代码）
 * 2. 批量发送到 LLM 请求命名建议
 * 3. LLM 返回 JSON 格式 [{old, new}]，Babel scope.rename 执行（结构 1:1）
 * 4. 锚库逐条验证——重命名是恒等变换（只改名字不改逻辑），通过才提交
 *
 * 后端：mock（确定性启发式）/ openai / anthropic / ollama
 * 原则：LLM 绝不触碰代码结构——只输出名字建议，AST 操作全部由确定性代码执行。
 */

import * as t from '@babel/types';
import { printCode, traverse } from '@jsseal/ast';
import { result, type Transform, type TransformContext } from './types';

const MANGLED = /^_?0x[0-9a-fA-F]{3,}$/;
const RESERVED = new Set(['undefined', 'null', 'true', 'false', 'this', 'arguments']);

export type LLMProvider = 'mock' | 'openai' | 'anthropic' | 'ollama';

export interface LLMRenameOptions {
  provider: LLMProvider;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  maxNames?: number;
  contextLines?: number;
}

/* ======================== Mock Provider（确定性启发式） ======================== */

/** 根据使用模式推断语义名（无需 API，可测试） */
function heuristicName(name: string, usage: string): string {
  const u = usage.toLowerCase();
  // 常见模式匹配
  if (u.includes('.length') || u.includes('.size')) return 'count';
  if (u.includes('charcodeat') || u.includes('fromcharcode') || u.includes('charat')) return 'charBuf';
  if (u.includes('parseint') || u.includes('tostring') || u.includes('number(')) return 'numVal';
  if (u.includes('string(') || u.includes('tostring') || u.includes('concat')) return 'strBuf';
  if (u.includes('push(') || u.includes('pop(')) return 'stack';
  if (u.includes('split(') || u.includes('join(')) return 'parts';
  if (u.includes('indexof') || u.includes('slice(')) return 'source';
  if (u.includes('atob') || u.includes('btoa') || u.includes('decode')) return 'decoded';
  if (u.includes('encode') || u.includes('encrypt')) return 'encoded';
  if (u.includes('replace(') || u.includes('match(')) return 'text';
  if (u.includes('json') || u.includes('stringify') || u.includes('parse(')) return 'jsonData';
  if (u.includes('key') || u.includes('secret')) return 'key';
  if (u.includes('cookie') || u.includes('token')) return 'token';
  if (u.includes('url') || u.includes('href')) return 'url';
  if (u.includes('timeout') || u.includes('delay')) return 'delayMs';
  if (u.includes('callback') || u.includes('handler')) return 'callback';
  if (u.includes('error') || u.includes('catch')) return 'err';
  if (u.includes('result') || u.includes('return')) return 'result';
  if (u.includes('index') || u.includes('position')) return 'idx';
  if (u.includes('loop') || u.includes('iterate') || u.includes('for(')) return 'i';
  if (u.includes('array') || u.includes('list')) return 'items';
  if (u.includes('object') || u.includes('props')) return 'config';
  if (u.includes('function') || u.includes('=>')) return 'fn';
  if (u.includes('get') || u.includes('fetch')) return 'getter';
  if (u.includes('set') || u.includes('put')) return 'setter';
  // 默认：根据声明位置推断
  if (u.includes('var ') || u.includes('let ') || u.includes('const ')) return 'value';
  if (u.includes('function ')) return 'fn';
  return 'v';
}

/* ======================== LLM Provider 接口 ======================== */

interface RenameSuggestion {
  old: string;
  new: string;
}

async function callMock(names: Array<{ name: string; context: string }>): Promise<RenameSuggestion[]> {
  const used = new Set<string>();
  return names.map(({ name, context }) => {
    let base = heuristicName(name, context);
    let final = base;
    let suffix = 2;
    while (used.has(final)) {
      final = base + suffix;
      suffix++;
    }
    used.add(final);
    return { old: name, new: final };
  });
}

async function callOpenAI(
  names: Array<{ name: string; context: string }>,
  opts: { apiKey: string; model: string },
): Promise<RenameSuggestion[]> {
  const prompt = buildPrompt(names);
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      messages: [
        { role: 'system', content: 'You are a code analyst. Suggest descriptive variable names. Respond ONLY with JSON array [{"old":"_0xabc","new":"descriptiveName"}]. No markdown.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI API ${res.status}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return parseLLMResponse(data.choices?.[0]?.message?.content ?? '[]');
}

async function callAnthropic(
  names: Array<{ name: string; context: string }>,
  opts: { apiKey: string; model: string },
): Promise<RenameSuggestion[]> {
  const prompt = buildPrompt(names);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': opts.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: 4096,
      messages: [
        { role: 'user', content: `Suggest descriptive variable names. Respond ONLY with JSON array [{"old":"_0xabc","new":"name"}]. No markdown.\n\n${prompt}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
  const data = (await res.json()) as { content?: Array<{ text?: string }> };
  return parseLLMResponse(data.content?.[0]?.text ?? '[]');
}

async function callOllama(
  names: Array<{ name: string; context: string }>,
  opts: { baseUrl: string; model: string },
): Promise<RenameSuggestion[]> {
  const prompt = buildPrompt(names);
  const res = await fetch(`${opts.baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model,
      prompt: `Suggest descriptive variable names. Respond ONLY with JSON array [{"old":"_0xabc","new":"name"}]. No markdown.\n\n${prompt}`,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`Ollama API ${res.status}`);
  const data = (await res.json()) as { response?: string };
  return parseLLMResponse(data.response ?? '[]');
}

function buildPrompt(names: Array<{ name: string; context: string }>): string {
  return names
    .map(({ name, context }) => `Variable "${name}" used in:\n${context}\n`)
    .join('\n---\n\n');
}

function parseLLMResponse(text: string): RenameSuggestion[] {
  // 提取 JSON 数组（LLM 可能包裹 markdown）
  const match = /\[[\s\S]*\]/.exec(text);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]);
    return arr.filter((x: unknown): x is RenameSuggestion =>
      typeof x === 'object' && x !== null && 'old' in x && 'new' in x,
    );
  } catch {
    return [];
  }
}

/* ======================== 变换 ======================== */

export function createLLMRenameTransform(opts: LLMRenameOptions) {
  const maxNames = opts.maxNames ?? 50;
  const contextLines = opts.contextLines ?? 3;

  const transform: Transform = {
    name: 'llm-rename',
    risk: 'unsafe', // 名字变更（锚库验证把关——重命名是恒等变换）
    async run(ast, ctx) {
      // ---------- 1) 收集待重命名标识符（含上下文） ----------
      const candidates: Array<{ name: string; context: string }> = [];
      const seen = new Set<string>();

      const lines = ctx.code.split('\n');

      const collect = (name: string, binding: import('@babel/traverse').Binding): void => {
        if (candidates.length >= maxNames) return;
        if (!MANGLED.test(name) || seen.has(name) || RESERVED.has(name)) return;
        if (!binding.path.node) return;
        seen.add(name);
        const firstRef = binding.referencePaths[0];
        if (!firstRef || !firstRef.node.loc) return;
        const line = firstRef.node.loc.start.line;
        const from = Math.max(0, line - contextLines);
        const to = Math.min(lines.length, line + contextLines);
        candidates.push({ name, context: lines.slice(from, to).join('\n') });
      };

      // 逐 scope 收集（Program + 所有嵌套函数 scope）
      traverse(ast, {
        Scopable(path) {
          for (const [name, binding] of Object.entries(path.scope.bindings)) {
            collect(name, binding as import('@babel/traverse').Binding);
          }
          // 函数声明名在父 scope——补查
          if (path.parentPath?.scope && path.isFunctionDeclaration?.() && path.node.id) {
            const parentBinding = path.parentPath.scope.getBinding(path.node.id.name);
            if (parentBinding) collect(path.node.id.name, parentBinding);
          }
        },
      });

      if (candidates.length === 0) return result(false, ['no mangled identifiers']);

      // ---------- 2) 调用 LLM（或 mock） ----------
      let suggestions: RenameSuggestion[];
      try {
        switch (opts.provider) {
          case 'mock':
            suggestions = await callMock(candidates);
            break;
          case 'openai':
            suggestions = await callOpenAI(candidates, {
              apiKey: opts.apiKey ?? '',
              model: opts.model ?? 'gpt-4o-mini',
            });
            break;
          case 'anthropic':
            suggestions = await callAnthropic(candidates, {
              apiKey: opts.apiKey ?? '',
              model: opts.model ?? 'claude-sonnet-4-20250514',
            });
            break;
          case 'ollama':
            suggestions = await callOllama(candidates, {
              baseUrl: opts.baseUrl ?? 'http://localhost:11434',
              model: opts.model ?? 'qwen2.5-coder',
            });
            break;
          default:
            return result(false, [`unknown provider: ${opts.provider}`]);
        }
      } catch (e) {
        return result(false, [`LLM call failed: ${(e as Error).message}`]);
      }

      // ---------- 3) 过滤有效建议并应用 ----------
      const validSuggestions = suggestions.filter(
        (s) =>
          MANGLED.test(s.old) &&
          /^[a-z][a-zA-Z0-9_]*$/.test(s.new) && // 合法标识符
          !RESERVED.has(s.new) &&
          s.new.length > 1 &&
          s.new !== s.old,
      );

      if (validSuggestions.length === 0) return result(false, [`0 valid suggestions (${suggestions.length} raw)`]);

      let renamed = 0;
      const renamePairs: Array<{ from: string; to: string }> = [];
      // 一次性收集所有 scope（避免 rename 后 scope 失效）
      const allScopes: Array<import('@babel/traverse').Scope> = [];
      traverse(ast, {
        Scopable(path) {
          allScopes.push(path.scope);
        },
      });
      const appliedNames = new Set<string>();
      for (const sug of validSuggestions) {
        if (appliedNames.has(sug.new)) continue; // 已用过
        for (const scope of allScopes) {
          try {
            const binding = scope.getBinding(sug.old);
            if (!binding || !binding.path.node) continue;
            if (scope.hasBinding(sug.new) || appliedNames.has(sug.new)) break; // 冲突
            appliedNames.add(sug.new);
            scope.rename(sug.old, sug.new);
            renamePairs.push({ from: sug.old, to: sug.new });
            renamed++;
            break;
          } catch {
            /* skip */
          }
        }
      }

      return renamed > 0
        ? result(true, [`renamed=${renamed}`, `provider=${opts.provider}`, ...renamePairs.slice(0, 5).map((p) => `${p.from}→${p.to}`)], renamePairs)
        : result(false, ['no renames applied']);
    },
  };

  return transform;
}
