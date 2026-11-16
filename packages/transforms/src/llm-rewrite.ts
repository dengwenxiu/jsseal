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

import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { parseCode, printCode, traverse } from "@jsseal/ast";

import type { LLMProvider } from "./llm-rename";
import { result } from "./types";
import type { Transform } from "./types";

export interface LLMRewriteOptions {
  provider: LLMProvider | "custom";
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
const mockRewrite = (code: string): string =>
  code.replaceAll(
    // oxlint-disable-next-line sonarjs/super-linear-regex -- 识别 `x = x + 1` 自赋值必须用反向引用 \k<target>；拆成两个独立 group + 回调比对会改变匹配推进位置（相邻/重叠自赋值匹配结果不同），故保留反向引用（输入为单函数级代码块，长度有界）
    /(?<target>[A-Za-z_$][\w$]*)\s*=\s*\k<target>\s*(?<op>[+-])\s*(?<num>\d+)\s*;/gu,
    "$1 $2= $3;"
  );

/* ======================== Provider 调用 ======================== */

const SYSTEM_PROMPT =
  "You are a JavaScript deobfuscation expert. Rewrite the given function for maximum readability " +
  "(simplify expressions, clean control flow, use clear names). You MUST preserve EXACT runtime behavior — " +
  "every observable effect identical. Output ONLY the rewritten function code. " +
  "No markdown fences, no explanations, no comments about your changes.";

interface OpenAICompletion {
  choices?: { message?: { content?: string } }[];
}

interface AnthropicCompletion {
  content?: { text?: string }[];
}

interface OllamaCompletion {
  response?: string;
}

const callOpenAI = async (
  user: string,
  opts: LLMRewriteOptions
): Promise<string> => {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey ?? ""}`,
    },
    body: JSON.stringify({
      model: opts.model ?? "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: user },
      ],
      temperature: 0,
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenAI API ${res.status}`);
  }

  // SAFETY: 响应体是外部 HTTP JSON；下方逐层 `?.` + `?? ""` 兜住所有缺失字段，
  // 窄化只用于描述期望形状，不引入任何运行时分支
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 外部 JSON 无法在不新增校验分支（会改变 provider 失败路径）的前提下窄化
  const data = (await res.json()) as OpenAICompletion;

  return data.choices?.[0]?.message?.content ?? "";
};

const callAnthropic = async (
  user: string,
  opts: LLMRewriteOptions
): Promise<string> => {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": opts.apiKey ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: opts.model ?? "claude-sonnet-4-20250514",
      max_tokens: 8192,
      messages: [{ role: "user", content: `${SYSTEM_PROMPT}\n\n${user}` }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}`);
  }

  // SAFETY: 响应体是外部 HTTP JSON；下方逐层 `?.` + `?? ""` 兜住所有缺失字段，
  // 窄化只用于描述期望形状，不引入任何运行时分支
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 外部 JSON 无法在不新增校验分支（会改变 provider 失败路径）的前提下窄化
  const data = (await res.json()) as AnthropicCompletion;

  return data.content?.[0]?.text ?? "";
};

const callOllama = async (
  user: string,
  opts: LLMRewriteOptions
): Promise<string> => {
  const res = await fetch(
    `${opts.baseUrl ?? "http://localhost:11434"}/api/generate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: opts.model ?? "qwen2.5-coder",
        prompt: `${SYSTEM_PROMPT}\n\n${user}`,
        stream: false,
      }),
    }
  );

  if (!res.ok) {
    throw new Error(`Ollama API ${res.status}`);
  }

  // SAFETY: 响应体是外部 HTTP JSON；下方逐层 `?.` + `?? ""` 兜住所有缺失字段，
  // 窄化只用于描述期望形状，不引入任何运行时分支
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 外部 JSON 无法在不新增校验分支（会改变 provider 失败路径）的前提下窄化
  const data = (await res.json()) as OllamaCompletion;

  return data.response ?? "";
};

const callProvider = async (
  code: string,
  opts: LLMRewriteOptions
): Promise<string> => {
  const instructions = opts.instructions ?? "";
  const user = (instructions === "" ? "" : `${instructions}\n\n`) + code;

  if (opts.provider === "custom") {
    if (!opts.custom) {
      throw new Error("custom provider requires opts.custom");
    }

    return await opts.custom(code);
  }

  if (opts.provider === "mock") {
    return mockRewrite(code);
  }

  if (opts.provider === "openai") {
    return await callOpenAI(user, opts);
  }

  if (opts.provider === "anthropic") {
    return await callAnthropic(user, opts);
  }

  return await callOllama(user, opts);
};

/** 剥 markdown 围栏（LLM 常见行为） */
const stripFences = (text: string): string => {
  const m = /```(?:javascript|js)?(?<body>[\s\S]*?)```/u.exec(text);

  return (m ? m[1] : text).trim();
};

/* ======================== 变换工厂 ======================== */

interface Chunk {
  path: NodePath<t.FunctionDeclaration>;
  name: string;
  code: string;
}

/** 函数块必须带非零 start/end（0-based 偏移；0 视为缺失，与既有分块集合一致） */
const hasPrintOffsets = (node: t.Node): boolean =>
  Boolean(node.start) && Boolean(node.end);

/** 调 provider 取提案；异常收敛为 failures 记录并返回 null（失败隔离） */
const proposeRewrite = async (
  code: string,
  opts: LLMRewriteOptions,
  failures: string[]
): Promise<string | null> => {
  try {
    return stripFences(await callProvider(code, opts));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    failures.push(`provider:${message.slice(0, 40)}`);

    return null;
  }
};

/** 形态校验（必须是单个函数声明）+ 应用；失败记入 failures */
const applyRewrite = (
  chunk: Chunk,
  rewritten: string,
  failures: string[]
): boolean => {
  try {
    const parsed = parseCode(rewritten);
    const [fn] = parsed.program.body;

    if (!t.isFunctionDeclaration(fn) || parsed.program.body.length !== 1) {
      failures.push(`${chunk.name}: not a single function`);

      return false;
    }

    chunk.path.replaceWith(fn);

    return true;
  } catch {
    failures.push(`${chunk.name}: parse error`);

    return false;
  }
};

export const createLLMRewriteTransform = (
  opts: LLMRewriteOptions
): Transform => {
  const maxFunctions = opts.maxFunctions ?? 8;

  const transform: Transform = {
    name: "llm-rewrite",
    // LLM 直接产码——等价性由 governor 锚库裁决（提案即验证）
    risk: "unsafe",
    async run(ast) {
      // ---------- 1) 分块：模块顶层函数声明 ----------
      const chunks: Chunk[] = [];

      traverse(ast, {
        // oxlint-disable-next-line sonarjs/function-name -- 键名即 Babel traverse 的 visitor 类型名（大写驼峰），改名后不再是 visitFunctionDeclaration 的别名
        FunctionDeclaration(path) {
          if (chunks.length >= maxFunctions) {
            return;
          }

          if (
            !path.parentPath?.isProgram() ||
            !path.node.id ||
            !hasPrintOffsets(path.node)
          ) {
            return;
          }

          chunks.push({
            path,
            name: path.node.id.name,
            code: printCode(path.node),
          });
        },
      });

      if (chunks.length === 0) {
        return result(false, ["no top-level functions"]);
      }

      // ---------- 2) 逐块提案（失败隔离） ----------
      let proposed = 0;
      let applied = 0;
      const failures: string[] = [];

      for (const chunk of chunks) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- 逐块串行提案是设计：单个 prompt 小、失败逐块隔离、provider 调用序确定（Promise.all 会打乱顺序并把一个块的异常扩散到整批）
        const rewritten = await proposeRewrite(chunk.code, opts, failures);

        if (
          rewritten === null ||
          rewritten === "" ||
          rewritten === chunk.code
        ) {
          continue;
        }

        proposed += 1;

        // ---------- 3) 形态校验 + 应用（真正的裁决在 governor 锚库） ----------
        if (applyRewrite(chunk, rewritten, failures)) {
          applied += 1;
        }
      }

      if (applied === 0) {
        return result(false, [
          `proposed=${proposed} applied=0`,
          ...failures.slice(0, 3),
        ]);
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
};
