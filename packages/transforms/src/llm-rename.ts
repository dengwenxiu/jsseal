/**
 * LLM 辅助标识符重命名（"LLM only suggests names" 原则的实现）：
 *
 * 1. 收集所有 _0x 样式标识符及其使用上下文（前后各 N 行代码）
 * 2. 批量发送到 LLM 请求命名建议
 * 3. LLM 返回 JSON 格式 `[{old, new}]`，Babel scope.rename 执行（结构 1:1）
 * 4. 锚库逐条验证——重命名是恒等变换（只改名字不改逻辑），通过才提交
 *
 * 后端：mock（确定性启发式）/ openai / anthropic / ollama
 * 原则：LLM 绝不触碰代码结构——只输出名字建议，AST 操作全部由确定性代码执行。
 */

import type { Binding, Scope } from "@babel/traverse";
import type * as t from "@babel/types";
import { traverse } from "@jsseal/ast";

import { result } from "./types";
import type { Transform } from "./types";

const MANGLED = /^_?0x[0-9a-fA-F]{3,}$/u;

/** LLM 建议名必须是合法标识符（小写字母开头，其余为 `\w`） */
const VALID_NEW_NAME = /^[a-z]\w*$/u;

const RESERVED = new Set([
  "undefined",
  "null",
  "true",
  "false",
  "this",
  "arguments",
]);

export type LLMProvider = "mock" | "openai" | "anthropic" | "ollama";

export interface LLMRenameOptions {
  provider: LLMProvider;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  maxNames?: number;
  contextLines?: number;
}

interface RenameSuggestion {
  old: string;
  new: string;
}

/** 待重命名标识符及其使用上下文 */
interface NameCandidate {
  name: string;
  context: string;
}

/* ======================== Mock Provider（确定性启发式） ======================== */

/** 使用模式 → 语义名（按数组顺序首匹配，等价于原 if 链的优先级） */
const HEURISTIC_RULES: readonly {
  needles: readonly string[];
  name: string;
}[] = [
  { needles: [".length", ".size"], name: "count" },
  { needles: ["charcodeat", "fromcharcode", "charat"], name: "charBuf" },
  { needles: ["parseint", "tostring", "number("], name: "numVal" },
  { needles: ["string(", "tostring", "concat"], name: "strBuf" },
  { needles: ["push(", "pop("], name: "stack" },
  { needles: ["split(", "join("], name: "parts" },
  { needles: ["indexof", "slice("], name: "source" },
  { needles: ["atob", "btoa", "decode"], name: "decoded" },
  { needles: ["encode", "encrypt"], name: "encoded" },
  { needles: ["replace(", "match("], name: "text" },
  { needles: ["json", "stringify", "parse("], name: "jsonData" },
  { needles: ["key", "secret"], name: "key" },
  { needles: ["cookie", "token"], name: "token" },
  { needles: ["url", "href"], name: "url" },
  { needles: ["timeout", "delay"], name: "delayMs" },
  { needles: ["callback", "handler"], name: "callback" },
  { needles: ["error", "catch"], name: "err" },
  { needles: ["result", "return"], name: "result" },
  { needles: ["index", "position"], name: "idx" },
  { needles: ["loop", "iterate", "for("], name: "i" },
  { needles: ["array", "list"], name: "items" },
  { needles: ["object", "props"], name: "config" },
  { needles: ["function", "=>"], name: "fn" },
  { needles: ["get", "fetch"], name: "getter" },
  { needles: ["set", "put"], name: "setter" },
  // 默认：根据声明位置推断
  { needles: ["var ", "let ", "const "], name: "value" },
  { needles: ["function "], name: "fn" },
];

/** 根据使用模式推断语义名（无需 API，可测试） */
const heuristicName = (_name: string, usage: string): string => {
  const u = usage.toLowerCase();

  for (const rule of HEURISTIC_RULES) {
    if (rule.needles.some((needle) => u.includes(needle))) {
      return rule.name;
    }
  }

  return "v";
};

// oxlint-disable-next-line eslint/require-await -- mock 与三个真实 provider 共用同一 Promise 契约（工厂内统一 await 调度）；去掉 async 会让 mock 分支同步求值，与真实 provider 的微任务时序不一致
const callMock = async (
  names: NameCandidate[]
): Promise<RenameSuggestion[]> => {
  const used = new Set<string>();

  return names.map(({ name, context }) => {
    const base = heuristicName(name, context);
    let final = base;
    let suffix = 2;

    while (used.has(final)) {
      final = base + suffix;
      suffix += 1;
    }

    used.add(final);

    return { old: name, new: final };
  });
};

/* ======================== LLM Provider 接口 ======================== */

interface OpenAICompletion {
  choices?: { message?: { content?: string } }[];
}

interface AnthropicCompletion {
  content?: { text?: string }[];
}

interface OllamaCompletion {
  response?: string;
}

const buildPrompt = (names: NameCandidate[]): string =>
  names
    .map(({ name, context }) => `Variable "${name}" used in:\n${context}\n`)
    .join("\n---\n\n");

/** LLM 建议的运行时形态校验（字段存在性） */
const isRenameSuggestion = (value: unknown): value is RenameSuggestion =>
  typeof value === "object" &&
  value !== null &&
  "old" in value &&
  "new" in value;

const parseLLMResponse = (text: string): RenameSuggestion[] => {
  // 提取 JSON 数组（LLM 可能包裹 markdown）：首个 '[' 到最后一个 ']'
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");

  if (start === -1 || end < start) {
    return [];
  }

  try {
    const arr: unknown = JSON.parse(text.slice(start, end + 1));

    if (!Array.isArray(arr)) {
      return [];
    }

    return arr.filter(isRenameSuggestion);
  } catch {
    return [];
  }
};

const callOpenAI = async (
  names: NameCandidate[],
  opts: { apiKey: string; model: string }
): Promise<RenameSuggestion[]> => {
  const prompt = buildPrompt(names);

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      messages: [
        {
          role: "system",
          content:
            'You are a code analyst. Suggest descriptive variable names. Respond ONLY with JSON array [{"old":"_0xabc","new":"descriptiveName"}]. No markdown.',
        },
        { role: "user", content: prompt },
      ],
      temperature: 0,
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenAI API ${res.status}`);
  }

  // SAFETY: 响应体是外部 HTTP JSON；下游 `?.` + `?? "[]"` 兜住所有缺失字段，
  // 窄化只用于描述期望形状，不引入任何运行时分支
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 外部 JSON 无法在不新增校验分支（会改变 provider 失败路径）的前提下窄化
  const data = (await res.json()) as OpenAICompletion;

  return parseLLMResponse(data.choices?.[0]?.message?.content ?? "[]");
};

const callAnthropic = async (
  names: NameCandidate[],
  opts: { apiKey: string; model: string }
): Promise<RenameSuggestion[]> => {
  const prompt = buildPrompt(names);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": opts.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: `Suggest descriptive variable names. Respond ONLY with JSON array [{"old":"_0xabc","new":"name"}]. No markdown.\n\n${prompt}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}`);
  }

  // SAFETY: 响应体是外部 HTTP JSON；下游 `?.` + `?? "[]"` 兜住所有缺失字段，
  // 窄化只用于描述期望形状，不引入任何运行时分支
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 外部 JSON 无法在不新增校验分支（会改变 provider 失败路径）的前提下窄化
  const data = (await res.json()) as AnthropicCompletion;

  return parseLLMResponse(data.content?.[0]?.text ?? "[]");
};

const callOllama = async (
  names: NameCandidate[],
  opts: { baseUrl: string; model: string }
): Promise<RenameSuggestion[]> => {
  const prompt = buildPrompt(names);

  const res = await fetch(`${opts.baseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: opts.model,
      prompt: `Suggest descriptive variable names. Respond ONLY with JSON array [{"old":"_0xabc","new":"name"}]. No markdown.\n\n${prompt}`,
      stream: false,
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama API ${res.status}`);
  }

  // SAFETY: 响应体是外部 HTTP JSON；下游 `?.` + `?? "[]"` 兜住所有缺失字段，
  // 窄化只用于描述期望形状，不引入任何运行时分支
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 外部 JSON 无法在不新增校验分支（会改变 provider 失败路径）的前提下窄化
  const data = (await res.json()) as OllamaCompletion;

  return parseLLMResponse(data.response ?? "[]");
};

/* ======================== 变换 ======================== */

/** 逐 scope 收集 _0x 标识符及其上下文（达到 maxNames 即停） */
const collectCandidates = (
  ast: t.File,
  code: string,
  maxNames: number,
  contextLines: number
): NameCandidate[] => {
  const candidates: NameCandidate[] = [];
  const seen = new Set<string>();
  const lines = code.split("\n");

  const collect = (name: string, binding: Binding): void => {
    if (candidates.length >= maxNames) {
      return;
    }

    if (!MANGLED.test(name) || seen.has(name) || RESERVED.has(name)) {
      return;
    }

    // oxlint-disable-next-line typescript/strict-boolean-expressions -- NodePath.node 在 path.remove() 后为 null（类型声明为非空对象，TS2367 禁止与 null 比较），只能用真值判断
    if (!binding.path.node) {
      return;
    }

    seen.add(name);

    const [firstRef] = binding.referencePaths;

    // oxlint-disable-next-line typescript/strict-boolean-expressions -- referencePaths[0] 类型上非空、运行时可空（TS2367 禁止与 undefined 比较），只能用真值判断
    if (!firstRef || !firstRef.node.loc) {
      return;
    }

    const { line } = firstRef.node.loc.start;
    const from = Math.max(0, line - contextLines);
    const to = Math.min(lines.length, line + contextLines);

    candidates.push({ name, context: lines.slice(from, to).join("\n") });
  };

  // 逐 scope 收集（Program + 所有嵌套函数 scope）
  traverse(ast, {
    // oxlint-disable-next-line sonarjs/function-name -- 键名即 Babel traverse 的 visitor 类型名（大写驼峰），改名后不再是 visitScopable 的别名
    Scopable(path) {
      for (const [name, binding] of Object.entries(path.scope.bindings)) {
        collect(name, binding);
      }

      // 函数声明名在父 scope——补查
      if (
        path.parentPath?.scope &&
        path.isFunctionDeclaration?.() &&
        path.node.id
      ) {
        const parentBinding = path.parentPath.scope.getBinding(
          path.node.id.name
        );

        if (parentBinding) {
          collect(path.node.id.name, parentBinding);
        }
      }
    },
  });

  return candidates;
};

/** 建议名是否可用（合法标识符、非保留字、不是原名） */
const isValidSuggestion = (sug: RenameSuggestion): boolean => {
  const formatOk = MANGLED.test(sug.old) && VALID_NEW_NAME.test(sug.new);

  const nameOk =
    !RESERVED.has(sug.new) && sug.new.length > 1 && sug.new !== sug.old;

  return formatOk && nameOk;
};

/** 单个 scope 上的重命名尝试："conflict" 表示名字已被占用（调用方应停止换 scope） */
type ScopeRenameAttempt = "renamed" | "conflict" | "skip";

const renameInScope = (
  scope: Scope,
  sug: RenameSuggestion,
  appliedNames: Set<string>
): ScopeRenameAttempt => {
  try {
    const binding = scope.getBinding(sug.old);

    // oxlint-disable-next-line typescript/strict-boolean-expressions -- NodePath.node 在 path.remove() 后为 null（类型声明为非空对象，TS2367 禁止与 null 比较），只能用真值判断
    if (!binding || !binding.path.node) {
      return "skip";
    }

    if (scope.hasBinding(sug.new) || appliedNames.has(sug.new)) {
      return "conflict";
    }

    appliedNames.add(sug.new);
    scope.rename(sug.old, sug.new);

    return "renamed";
  } catch {
    return "skip";
  }
};

/** 把一条建议落到首个可用 scope 上；成功则记录 renamePair */
const applySuggestion = (
  sug: RenameSuggestion,
  allScopes: readonly Scope[],
  appliedNames: Set<string>,
  renamePairs: { from: string; to: string }[]
): boolean => {
  if (appliedNames.has(sug.new)) {
    // 已用过
    return false;
  }

  for (const scope of allScopes) {
    const attempt = renameInScope(scope, sug, appliedNames);

    if (attempt === "renamed") {
      renamePairs.push({ from: sug.old, to: sug.new });

      return true;
    }

    if (attempt === "conflict") {
      return false;
    }
  }

  return false;
};

export const createLLMRenameTransform = (opts: LLMRenameOptions): Transform => {
  const maxNames = opts.maxNames ?? 50;
  const contextLines = opts.contextLines ?? 3;

  /** 调用所选 provider；未知 provider 返回 undefined（诊断由调用方给出） */
  const requestSuggestions = (
    candidates: NameCandidate[]
  ): Promise<RenameSuggestion[]> | undefined => {
    switch (opts.provider) {
      case "mock": {
        return callMock(candidates);
      }

      case "openai": {
        return callOpenAI(candidates, {
          apiKey: opts.apiKey ?? "",
          model: opts.model ?? "gpt-4o-mini",
        });
      }

      case "anthropic": {
        return callAnthropic(candidates, {
          apiKey: opts.apiKey ?? "",
          model: opts.model ?? "claude-sonnet-4-20250514",
        });
      }

      case "ollama": {
        return callOllama(candidates, {
          baseUrl: opts.baseUrl ?? "http://localhost:11434",
          model: opts.model ?? "qwen2.5-coder",
        });
      }

      default: {
        return undefined;
      }
    }
  };

  const transform: Transform = {
    name: "llm-rename",
    // 名字变更（锚库验证把关——重命名是恒等变换）
    risk: "unsafe",
    async run(ast, ctx) {
      // ---------- 1) 收集待重命名标识符（含上下文） ----------
      const candidates = collectCandidates(
        ast,
        ctx.code,
        maxNames,
        contextLines
      );

      if (candidates.length === 0) {
        return result(false, ["no mangled identifiers"]);
      }

      // ---------- 2) 调用 LLM（或 mock） ----------
      let suggestions: RenameSuggestion[];

      try {
        const pending = requestSuggestions(candidates);

        if (pending === undefined) {
          return result(false, [`unknown provider: ${opts.provider}`]);
        }

        suggestions = await pending;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        return result(false, [`LLM call failed: ${message}`]);
      }

      // ---------- 3) 过滤有效建议并应用 ----------
      const validSuggestions = suggestions.filter(isValidSuggestion);

      if (validSuggestions.length === 0) {
        return result(false, [
          `0 valid suggestions (${suggestions.length} raw)`,
        ]);
      }

      // 一次性收集所有 scope（避免 rename 后 scope 失效）
      const allScopes: Scope[] = [];

      traverse(ast, {
        // oxlint-disable-next-line sonarjs/function-name -- 键名即 Babel traverse 的 visitor 类型名（大写驼峰），改名后不再是 visitScopable 的别名
        Scopable(path) {
          allScopes.push(path.scope);
        },
      });

      const appliedNames = new Set<string>();
      const renamePairs: { from: string; to: string }[] = [];
      let renamed = 0;

      for (const sug of validSuggestions) {
        if (applySuggestion(sug, allScopes, appliedNames, renamePairs)) {
          renamed += 1;
        }
      }

      if (renamed === 0) {
        return result(false, ["no renames applied"]);
      }

      return result(
        true,
        [
          `renamed=${renamed}`,
          `provider=${opts.provider}`,
          ...renamePairs.slice(0, 5).map((p) => `${p.from}→${p.to}`),
        ],
        renamePairs
      );
    },
  };

  return transform;
};
