// Local stand-in for Vercel:  npm run dev   ->  http://localhost:3000
// Serves public/ and runs the api/*.js functions the same way Vercel does. Reads .env.local if present.
// Not used on Vercel itself (Vercel serves public/ and api/ directly).
// npm run dev runs it with --watch: the api/*.js modules are loaded once and kept, so without a restart a changed
// api file keeps its old code while public/ (read on every request) is already new. Memory storage resets with it.
import { createServer } from 'node:http';
import { readFile, access } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 3000);

try {
  for (const line of (await readFile(join(root, '.env.local'), 'utf8')).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  /* no .env.local: fine */
}

const types = { '.html': 'text/html', '.png': 'image/png', '.js': 'text/javascript', '.mp3': 'audio/mpeg', '.css': 'text/css', '.json': 'application/json' };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let path = url.pathname;

  if (path.startsWith('/api/')) {
    const file = join(root, 'api', `${path.slice(5)}.js`);
    try {
      await access(file);
      const mod = await import(pathToFileURL(file).href);
      let raw = '';
      for await (const chunk of req) raw += chunk;
      req.query = Object.fromEntries(url.searchParams);
      req.body = raw ? (() => { try { return JSON.parse(raw); } catch { return raw; } })() : undefined;
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
      await mod.default(req, res);
    } catch (e) {
      res.statusCode = e.code === 'ENOENT' ? 404 : 500;
      res.end(JSON.stringify({ error: String(e.message ?? e) }));
    }
    return;
  }

  if (path === '/') path = '/index.html';
  const file = normalize(join(root, 'public', path));
  if (!file.startsWith(join(root, 'public'))) { res.statusCode = 403; return res.end(); }
  try {
    const data = await readFile(file);
    res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
}).listen(port, () => console.log(`VEXNET field control (local) on http://localhost:${port}  - storage: ${process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL ? 'redis' : 'memory'}`));
