// 저장소 루트를 그대로 내보내는 작은 정적 서버 (시험 전용).
// 서비스워커 시험을 위해 파일 내용을 바꿔치기(override)할 수 있고, 요청 수를 센다.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function start() {
  const overrides = new Map();          // '/sw.js' → 문자열 (서비스워커 갱신 시험)
  const hits = [];                      // { url, mode }  — 어떤 요청이 몇 번 왔나
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let p = decodeURIComponent(u.pathname);
    hits.push({ url: req.url, pathname: p, mode: req.headers['sec-fetch-mode'] || '', dest: req.headers['sec-fetch-dest'] || '' });
    if (p.endsWith('/')) p += 'index.html';
    const headers = { 'Cache-Control': 'no-store' };
    if (overrides.has(p)) {
      res.writeHead(200, { ...headers, 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
      return res.end(overrides.get(p));
    }
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, headers); return res.end('not found'); }
    res.writeHead(200, { ...headers, 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ base, hits, overrides, close: () => new Promise(r => server.close(r)) });
  }));
}
module.exports = { start, ROOT };
