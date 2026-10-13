// 서비스워커 — 캐시 목록과 index.html 의 ?v= 가 맞는지, 첫 설치 때 새로 고치지 않는지, 새 버전이 오면 한 번만 새로 고치는지
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { launch, openApp } = require('./helpers/browser');
const { ROOT } = require('./helpers/server');

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

test('sw.js 의 CACHE·OWN 과 index.html 의 ?v= 가 같다', () => {
  const refs = [...html.matchAll(/(?:href|src)="((?:css|js)\/[^"?]+\?v=([^"]+))"/g)].map(m => ({ url: './' + m[1], v: m[2] }));
  assert.ok(refs.length >= 3, 'index.html 이 css/js 를 ?v= 로 부른다');
  const own = JSON.parse(sw.match(/const OWN = (\[[\s\S]*?\]);/)[1]);
  const cache = sw.match(/const CACHE = '([^']+)'/)[1];
  for (const r of refs) assert.ok(own.includes(r.url), `OWN 에 ${r.url} 이 없다 (있는 것: ${own.filter(u => u.includes('?v=')).join(', ')})`);
  const versions = new Set(refs.map(r => r.v));
  assert.equal(versions.size, 1, '?v= 가 한 값이어야 한다: ' + [...versions].join(', '));
  assert.equal(cache, 'dsleep-v' + [...versions][0], 'CACHE 버전이 ?v= 와 같아야 한다');
  for (const u of own.filter(u => u.includes('?v='))) assert.ok(refs.some(r => r.url === u), `OWN 의 ${u} 는 index.html 이 부르지 않는 옛 파일이다`);
});

test('첫 설치 때 페이지를 새로 고치지 않고, 새 sw.js 가 오면 한 번만 새로 고친다', async t => {
  const env = await launch();
  try {
    const { page, context } = await openApp(env, { serviceWorkers: 'allow', clock: null });
    let navs = 0; page.on('framenavigated', f => { if (f === page.mainFrame()) navs++; });
    await page.waitForFunction(() => navigator.serviceWorker.ready.then(() => true));
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 });
    await page.waitForTimeout(1500);
    assert.equal(navs, 0, '첫 설치가 끝나도 페이지가 새로 고쳐지면 안 된다 (입력 중이던 로그인 칸이 지워진다)');

    // 미리 받아 둔 캐시에 index.html 이 부르는 파일이 다 있는지 (OWN 과 ?v= 가 맞아야 통과)
    const missing = await page.evaluate(async () => {
      const want = [...document.querySelectorAll('link[rel=stylesheet][href], script[src]')].map(e => e.href || e.src).filter(u => u.startsWith(location.origin));
      const names = (await caches.keys()).filter(k => k.startsWith('dsleep-'));
      const have = new Set();
      for (const n of names) for (const r of await (await caches.open(n)).keys()) have.add(r.url);
      return want.filter(u => !have.has(u));
    });
    assert.deepEqual(missing, [], '캐시에 없는 파일');

    // 새 버전: sw.js 의 CACHE 만 바꿔 다시 받게 하면, 설치 → 활성 → controllerchange → 새로 고침 한 번
    const sw2 = sw.replace(/const CACHE = '[^']+'/, "const CACHE = 'dsleep-vTEST2'");
    assert.notEqual(sw2, sw);
    env.srv.overrides.set('/sw.js', sw2);
    const before = navs;
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r.update()));
    await page.waitForTimeout(3000);
    assert.equal(navs - before, 1, '새 버전 적용 때 새로 고침은 정확히 한 번');
    const keys = await page.evaluate(() => caches.keys().then(k => k.filter(x => x.startsWith('dsleep-'))));
    assert.deepEqual(keys, ['dsleep-vTEST2'], '옛 캐시는 지워지고 새 캐시만 남는다');
    await context.close();
  } finally { await env.close(); }
});
