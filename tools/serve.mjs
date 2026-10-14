#!/usr/bin/env node
/*
 * serve.mjs - tiny zero-dependency static server for the web port.
 *
 * Redirects "/" to "/solo.html", sends correct Content-Types (Unity warns loudly
 * about a wrong one for .wasm) and honours Range requests, which the in-game
 * video player uses.
 *
 * Usage: node tools/serve.mjs [port] [directory]
 *        defaults: port 8000, directory ./game
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || process.env.PORT || 8000);
const root = path.resolve(process.argv[3] || path.join(repoRoot, 'game'));
const entry = '/solo.html';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.bundle': 'application/octet-stream',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.hash': 'text/plain; charset=utf-8'
};

function typeFor(file) {
  if (/\.part\d+$/.test(file)) return 'application/octet-stream';
  return TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/' || url === '') {
    res.writeHead(302, { location: entry });
    res.end();
    return;
  }

  const file = path.join(root, path.normalize(url));
  if (!file.startsWith(root + path.sep) && file !== root) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  let stat;
  try { stat = fs.statSync(file); } catch { res.writeHead(404); res.end('not found'); return; }
  if (stat.isDirectory()) {
    res.writeHead(302, { location: path.posix.join(url.replace(/\/$/, ''), 'solo.html') });
    res.end();
    return;
  }

  const headers = {
    'content-type': typeFor(file),
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache'
  };

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (req.method === 'HEAD') {
    headers['content-length'] = String(stat.size);
    res.writeHead(200, headers);
    res.end();
    return;
  }

  if (range && (range[1] !== '' || range[2] !== '')) {
    const start = range[1] === '' ? Math.max(0, stat.size - Number(range[2])) : Number(range[1]);
    const end = range[1] === '' || range[2] === '' ? stat.size - 1 : Math.min(Number(range[2]), stat.size - 1);
    if (start >= stat.size || start > end) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
    headers['content-length'] = String(end - start + 1);
    res.writeHead(206, headers);
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }

  headers['content-length'] = String(stat.size);
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`serving ${root}`);
  console.log(`  http://0.0.0.0:${port}/  ->  ${entry}`);
});
