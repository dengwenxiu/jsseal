/**
 * LLM 驱动改写提案（"LLM 提案，governor 裁决"——POSITIONING §4.4 的实现）：
 *
 * 与 llm-rename 的分工：
 * - llm-rename：LLM 只建议名字，AST 操作全确定性（结构 1:1）
 * - llm-rewrite：LLM **直接提案改写后的函数代码**——解锁高层变换
 *   （结构重组/表达式简化/控制流清理），等价性不靠信任 LLM，
 *   靠 governor 锚库逐条重放裁决：行为恒等才提交，失败回滚。
 *
 * 安全设计：
 * - 逐函数分块（顶层函数声明）：prompt 小、失败隔离、回滚粒度细
 * - LLM 输出必须可解析且仍是函数声明，否则跳过该块
 * - provider 异常 / 超时 / 空输出 → no-op（管线其余部分不受影响）
 * - 变换标记 unsafe：governor 在锚库上验证整个提案
 *
 * 后端：mock（确定性文本级恒等简化，可测试）/ openai / anthropic / ollama
 */

import * as t from '@babel/types';
import { parseCode, printCode, traverse } from '@jsseal/ast';
import { result, type Transform } from './types';
import type { LLMProvider } from './llm-rename';

export interface LLMRewriteOptions {
  provider: LLMProvider | 'custom';
  /** 自定义 provider（接入任意 LLM 服务；测试注入恶意提案验证裁决） */
  custom?: (code: string) => Promise<string>;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** 每次调用最多改写的函数数（默认 8） */
  maxFunctions?: number;
  /** 附加指令（如"合并重复表达式"） */
  instructions?: string;
}

/* ======================== Mock Provider（确定性恒等简化） ======================== */

/** `x = x + 1;` → `x += 1;`（文本级恒等；演示"提案-裁决"闭环） */
function mockRewrite(code: string): string {
  return code.replace(/([A-Za-z_$][\w$]*)\s*=\s*\1\s*([+-])\s*(\d+)\s*;/g, '$1 $2= $3;');
}

/* ======================== Provider 调用 ======================== */

const SYSTEM_PROMPT =
  'You are a JavaScript deobfuscation expert. Rewrite the given function for maximum readability ' +
  '(simplify expressions, clean control flow, use clear names). You MUST preserve EXACT runtime behavior — ' +
  'every observable effect identical. Output ONLY the rewritten function code. ' +
  'No markdown fences, no explanations, no comments about your changes.';

async function callProvider(code: string, opts: LLMRewriteOptions): Promise<string> {
  const user = (opts.instructions ? opts.instructions + '\n\n' : '') + code;
  if (opts.provider === 'custom') {
    if (!opts.custom) throw new Error('custom provider requires opts.custom');
    return opts.custom(code);
  }
  if (opts.provider === 'mock') return mockRewrite(code);
  if (opts.provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey ?? ''}` },
      body: JSON.stringify({
        model: opts.model ?? 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: user },
        ],
        temperature: 0,
      }),
    });
    if (!res.ok) throw new Error(`OpenAI API ${res.status}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? '';
  }
  if (opts.provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': opts.apiKey ?? '', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: opts.model ?? 'claude-sonnet-4-20250514',
        max_tokens: 8192,
        messages: [{ role: 'user', content: `${SYSTEM_PROMPT}\n\n${user}` }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    return data.content?.[0]?.text ?? '';
  }
  // ollama
  const res = await fetch(`${opts.baseUrl ?? 'http://localhost:11434'}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: opts.model ?? 'qwen2.5-coder', prompt: `${SYSTEM_PROMPT}\n\n${user}`, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama API ${res.status}`);
  const data = (await res.json()) as { response?: string };
  return data.response ?? '';
}

/** 剥 markdown 围栏（LLM 常见行为） */
function stripFences(text: string): string {
  const m = /```(?:javascript|js)?\s*([\s\S]*?)```/.exec(text);
  return (m ? m[1] : text).trim();
}

/* ======================== 变换工厂 ======================== */

export function createLLMRewriteTransform(opts: LLMRewriteOptions) {
  const maxFunctions = opts.maxFunctions ?? 8;

  const transform: Transform = {
    name: 'llm-rewrite',
    risk: 'unsafe', // LLM 直接产码——等价性由 governor 锚库裁决（提案即验证）
    async run(ast) {
      // ---------- 1) 分块：模块顶层函数声明 ----------
      const chunks: Array<{ path: import('@babel/traverse').NodePath<t.FunctionDeclaration>; name: string; code: string }> = [];
      traverse(ast, {
        FunctionDeclaration(path) {
          if (chunks.length >= maxFunctions) return;
          if (!path.parentPath?.isProgram() || !path.node.id || !path.node.start || !path.node.end) return;
          chunks.push({
            path,
            name: path.node.id.name,
            code: printCode(path.node),
          });
        },
      });
      if (chunks.length === 0) return result(false, ['no top-level functions']);

      // ---------- 2) 逐块提案（失败隔离） ----------
      let proposed = 0;
      let applied = 0;
      const failures: string[] = [];
      for (const chunk of chunks) {
        let rewritten: string;
        try {
          rewritten = stripFences(await callProvider(chunk.code, opts));
        } catch (e) {
          failures.push(`provider:${(e as Error).message.slice(0, 40)}`);
          continue;
        }
        if (!rewritten || rewritten === chunk.code) continue;
        proposed++;
        // ---------- 3) 形态校验 + 应用（真正的裁决在 governor 锚库） ----------
        try {
          const parsed = parseCode(rewritten);
          const fn = parsed.program.body[0];
          if (!t.isFunctionDeclaration(fn) || parsed.program.body.length !== 1) {
            failures.push(`${chunk.name}: not a single function`);
            continue;
          }
          chunk.path.replaceWith(fn);
          applied++;
        } catch {
          failures.push(`${chunk.name}: parse error`);
        }
      }
      if (applied === 0) {
        return result(false, [`proposed=${proposed} applied=0`, ...failures.slice(0, 3)]);
      }
      return result(true, [
        `proposed=${proposed}`,
        `applied=${applied}`,
        `provider=${opts.provider}`,
        ...failures.slice(0, 3),
      ]);
    },
  };
  return transform;
}
