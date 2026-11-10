#!/usr/bin/env node
/** 零依赖静态服务器：packages/web/dist → http://127.0.0.1:8642 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), 'dist');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

const PORT = Number(process.env.PORT || 8642);
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let path = join(dir, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!path.startsWith(dir)) path = join(dir, 'index.html');
    const data = await readFile(path).catch(() => readFile(join(dir, 'index.html')));
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`jsseal playground → http://127.0.0.1:${PORT}`);
});
