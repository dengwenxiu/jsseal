#!/usr/bin/env node
/* oxlint-disable typescript/no-unsafe-call, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-argument, typescript/no-unsafe-return, typescript/strict-boolean-expressions -- packages/web 无 tsconfig（不参与 tsc -b），类型感知检查解析不到 node: 内置模块类型，本文件的 http/fs/path 调用一律被当作 error 类型；这是静态服务器的既有形态，修它需要新增 tsconfig，超出反混淆器源码范围 */
import { readFile } from "node:fs/promises";
/** 零依赖静态服务器：packages/web/dist → http://127.0.0.1:8642 */
import { createServer } from "node:http";
import path from "node:path";

const INDEX_HTML = "index.html";
const DEFAULT_PORT = 8642;

const dir = path.resolve(import.meta.dirname, "dist");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

const envPort = process.env.PORT;

/** 端口：PORT 未设或为空串时回落默认（Number("") === 0 不是想要的默认值） */
const PORT =
  envPort === undefined || envPort === "" ? DEFAULT_PORT : Number(envPort);

/** 回落到 index.html（请求路径不存在时） */
const readIndexHtml = async () => await readFile(path.join(dir, INDEX_HTML));

const handleRequest = async (req, res) => {
  try {
    // oxlint-disable-next-line sonarjs/no-clear-text-protocols -- 这里的 http://x 只是 URL 解析用的占位 base（只取其 pathname），不发请求
    const url = new URL(req.url, "http://x");

    let filePath = path.join(
      dir,
      url.pathname === "/" ? INDEX_HTML : url.pathname
    );

    if (!filePath.startsWith(dir)) {
      filePath = path.join(dir, INDEX_HTML);
    }

    const data = await readFile(filePath).catch(readIndexHtml);

    res.writeHead(200, {
      "content-type":
        MIME[path.extname(filePath)] ?? "application/octet-stream",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
};

createServer((req, res) => {
  void handleRequest(req, res);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`jsseal playground → http://127.0.0.1:${PORT}`);
});
