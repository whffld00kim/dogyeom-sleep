// Playwright 로 index.html 을 열되, www.gstatic.com 의 Firebase 스크립트를 가짜(fake-firebase.js)로 바꿔 끼운다.
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { start } = require('./server');

const FAKE_SRC = fs.readFileSync(path.join(__dirname, 'fake-firebase.js'), 'utf8');
// 공개 저장소 — 실제 uid·이메일·가구 id 를 쓰지 않는다
const UID = 'uid-test-a', UID2 = 'uid-test-b', HID = 'hid-test', EMAIL = 'test-a@example.com';
const H = 3600 * 1000, MIN = 60 * 1000;
// 한국 시각(KST, UTC+9) → epoch ms. 시험 프로세스의 시간대와 무관하게 쓰려고
const kst = (y, m, d, hh = 0, mm = 0) => Date.UTC(y, m - 1, d, hh, mm) - 9 * H;

function baseServer(extra = {}) {
  return {
    users: { [UID]: { householdId: HID }, [UID2]: { householdId: HID } },
    households: { [HID]: { members: { [UID]: true, [UID2]: true } } },
    'dogyeom-sleep': { [HID]: { events: {}, memos: {} } },
    ...extra
  };
}
// 2026-10-12(월) 을 '오늘'로 보는 예시 기록: 10-10 21:00 → 10-11 07:00, 10-11 낮잠 13:00~14:30(피요로그), 10-11 21:10 → 10-12 06:50
function sampleEvents() {
  return {
    'e-s1': { type: 'sleep', t: kst(2026, 10, 10, 21, 0), by: UID, at: 1 },
    'e-w1': { type: 'wake', t: kst(2026, 10, 11, 7, 0), by: UID, at: 1 },
    'e-n1': { type: 'sleep', t: kst(2026, 10, 11, 13, 0), by: UID, at: 1, src: 'piyolog' },
    'e-n2': { type: 'wake', t: kst(2026, 10, 11, 14, 30), by: UID, at: 1, src: 'piyolog' },
    'e-s2': { type: 'sleep', t: kst(2026, 10, 11, 21, 10), by: UID2, at: 1 },
    'e-w2': { type: 'wake', t: kst(2026, 10, 12, 6, 50), by: UID2, at: 1 }
  };
}
const NOW = '2026-10-12T20:00:00+09:00';   // 대부분의 시험이 '지금'으로 보는 시각

async function launch() {
  const srv = await start();
  // gstatic 은 바로 실패하게 (서비스워커가 CDN 을 받으러 갈 때 기다리지 않게). page.route 는 DNS 전에 가로채므로 영향 없다
  const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP www.gstatic.com ~NOTFOUND'] });
  return { srv, browser, close: async () => { await browser.close(); await srv.close(); } };
}

// fake: window.__FAKE 설정. clock: 가짜 시계 시작 시각. query: '?demo=1' 등
async function openApp(env, { fake, query = '', viewport = { width: 360, height: 780 }, serviceWorkers = 'block', clock = NOW, timezoneId = 'Asia/Seoul' } = {}) {
  const context = await env.browser.newContext({ viewport, timezoneId, locale: 'ko-KR', serviceWorkers });
  const page = await context.newPage();
  page.on('pageerror', e => { page.__errors = (page.__errors || []).concat(String(e)); });
  if (clock) await page.clock.install({ time: clock });
  if (fake) await page.addInitScript(cfg => { window.__FAKE = cfg; }, fake);
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({
    status: 200, contentType: 'text/javascript',
    body: route.request().url().endsWith('firebase-app-compat.js') ? FAKE_SRC : '// 가짜 — app-compat 에 다 들어 있다'
  }));
  await page.goto(env.srv.base + '/' + query);
  return { context, page };
}

const waitApp = page => page.waitForSelector('#app:not(.hidden)', { timeout: 5000 });
const settle = page => page.waitForFunction(() => window.__fake && window.__fake.db.pending() === 0, null, { timeout: 5000 });
async function toastText(page) {
  await page.waitForFunction(() => !document.getElementById('toast').classList.contains('hidden'), null, { timeout: 3000 });
  return page.textContent('#toast');
}
const serverEvents = page => page.evaluate(h => (((window.__fake.db.server()['dogyeom-sleep'] || {})[h] || {}).events) || {}, HID);

module.exports = { launch, openApp, waitApp, settle, toastText, serverEvents, baseServer, sampleEvents, kst, UID, UID2, HID, EMAIL, H, MIN, NOW };
