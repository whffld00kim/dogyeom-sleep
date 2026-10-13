// 앱 동작 시험 — 가짜 Firebase 위에서 로그인·시작, 저장·수정·삭제(온라인/오프라인/상대와 동시), 자정 넘김, XSS, 「나」, 세 화면 폭
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { launch, openApp, waitApp, settle, toastText, serverEvents, baseServer, sampleEvents, kst, UID, UID2, HID, EMAIL, MIN } = require('./helpers/browser');

let env;
test.before(async () => { env = await launch(); });
test.after(async () => { await env.close(); });

const signedIn = (extra = {}) => ({ user: { uid: UID, email: EMAIL }, server: baseServer({ 'dogyeom-sleep': { [HID]: { events: sampleEvents(), memos: {} } } }), ...extra });
const EV = `dogyeom-sleep/${HID}/events`;

async function run(opts, fn) {
  const { page, context } = await openApp(env, opts);
  try { await fn(page); assert.deepEqual(page.__errors || [], [], '페이지 오류'); }
  finally { await context.close(); }
}

/* ---------- 로그인·시작 ---------- */
test('로그인된 기기: 가구를 읽고 기록을 구독해 앱을 보인다', () => run({ fake: signedIn() }, async page => {
  await waitApp(page);
  assert.equal(await page.isHidden('#auth-screen'), true);
  assert.equal(await page.textContent('#rec-date'), '2026년 10월 12일 (월)');
  assert.equal(await page.locator('#rec-events .ev').count(), 1);                       // 10-12 엔 06:50 기상만
  assert.match(await page.locator('#rec-events .ev .dur').textContent(), /9시간 40분/);  // 21:10 → 06:50
  assert.equal((await page.textContent('#rec-total')).replace(/\s/g, ''), '6시간50분');
  assert.equal(await page.evaluate(() => localStorage.getItem('dsleep_signed_in')), '1');
}));

test('가구가 없는 계정: 안내를 보이고 로그아웃한다 (기기 표시만 지워지고 「나」 설정은 남는다)', () => run({
  fake: { user: { uid: 'uid-nohouse', email: 'nohouse@example.com' }, server: baseServer({ users: {} }) }
}, async page => {
  await page.evaluate(() => localStorage.setItem('dsleep_me', '1'));
  await page.waitForFunction(() => document.getElementById('auth-error').textContent.includes('가구'));
  assert.match(await page.textContent('#auth-error'), /가구에 속해 있지 않습니다[\s\S]*nohouse@example.com/);
  assert.equal(await page.isVisible('#auth-form'), true, '로그인 폼이 다시 보인다');
  assert.equal(await page.isHidden('#app'), true);
  assert.equal(await page.evaluate(() => localStorage.getItem('dsleep_signed_in')), null);
  assert.equal(await page.evaluate(() => localStorage.getItem('dsleep_me')), '1');
}));

test('users 읽기 권한이 없으면 「접근 권한이 없습니다」 뒤 로그아웃', () => run({ fake: signedIn({ deny: ['users/' + UID] }) }, async page => {
  await page.waitForFunction(() => document.getElementById('auth-error').textContent.includes('접근 권한'));
  assert.match(await page.textContent('#auth-error'), /접근 권한이 없습니다 \(test-a@example.com\): PERMISSION_DENIED/);
  assert.equal(await page.isVisible('#btn-email'), true);
}));

test('가구 멤버가 아니라 구독이 거부되면 「불러오기 실패」 뒤 로그아웃', () => run({
  fake: { user: { uid: UID, email: EMAIL }, server: baseServer({ households: { [HID]: { members: { [UID2]: true } } } }) }
}, async page => {
  await page.waitForFunction(() => document.getElementById('auth-error').textContent.includes('불러오기 실패'));
  assert.equal(await page.isHidden('#app'), true);
  assert.equal(await page.evaluate(() => localStorage.getItem('dsleep_signed_in')), null);
}));

test('이메일·비밀번호 로그인: 틀리면 한국어 안내, 맞으면 들어간다', () => run({
  fake: { user: null, accounts: [{ email: EMAIL, pw: 'pw-test', uid: UID }], server: baseServer() }
}, async page => {
  await page.waitForSelector('#btn-email');
  await page.fill('#auth-email', EMAIL); await page.fill('#auth-pw', 'wrong'); await page.click('#btn-email');
  await page.waitForFunction(() => document.getElementById('auth-error').textContent.length > 0);
  assert.equal(await page.textContent('#auth-error'), '로그인 실패: 이메일 또는 비밀번호가 맞지 않습니다');
  await page.fill('#auth-pw', 'pw-test'); await page.click('#btn-email');
  await waitApp(page);
  assert.equal(await page.textContent('#auth-error'), '');
}));

test('구글 로그인: 프로젝트에 없는 계정이면 이메일 로그인 안내', () => run({ fake: { user: null, server: baseServer() } }, async page => {
  await page.click('#btn-google');
  await page.waitForFunction(() => document.getElementById('auth-error').textContent.length > 0);
  assert.match(await page.textContent('#auth-error'), /부부가계부 이메일·비밀번호로 로그인/);
}));

test('오프라인에서 열면 「불러오는 중…」에 머물고, 연결되면 들어간다 (SDK 의 get 은 연결될 때까지 기다린다)', () => run({ fake: signedIn({ online: false }) }, async page => {
  await page.evaluate(() => localStorage.setItem('dsleep_signed_in', '1'));
  await page.waitForTimeout(600);
  assert.equal(await page.isHidden('#app'), true);
  assert.equal(await page.textContent('#auth-status'), '불러오는 중…');
  await page.evaluate(() => window.__fake.db.goOnline());
  await waitApp(page);
}));

/* ---------- 저장·수정·삭제 ---------- */
async function openNew(page, type) { await page.click(`.act[data-type=${type}]`); await page.waitForSelector('#time-modal:not(.hidden)'); }
async function modalTime(page) { return { date: await page.inputValue('#tm-date'), time: await page.inputValue('#tm-time') }; }

test('수면 저장: 보고 있는 날 + 시계 시각으로 push 되고 by·at 이 붙는다', () => run({ fake: signedIn() }, async page => {
  await waitApp(page);
  await openNew(page, 'sleep');
  const { date, time } = await modalTime(page);
  assert.equal(date, '2026-10-12');
  assert.equal(await page.textContent('#tm-title'), '수면');
  await page.click('#tm-ok');
  await settle(page);
  const evs = await serverEvents(page);
  const added = Object.entries(evs).filter(([k]) => k.startsWith('-fake'));
  assert.equal(added.length, 1);
  const [hh, mm] = time.split(':').map(Number);
  assert.deepEqual([added[0][1].type, added[0][1].t, added[0][1].by], ['sleep', kst(2026, 10, 12, hh, mm), UID]);
  assert.equal(typeof added[0][1].at, 'number');
  assert.equal(await page.locator('#rec-events .ev').count(), 2);
  assert.match(await page.locator('#rec-events .ev').last().textContent(), /수면[\s\S]*자는 중/);
}));

test('지난 날에 새 기록: 기본 시각 수면 21:00·기상 07:00, 그 날짜로 저장', () => run({ fake: signedIn() }, async page => {
  await waitApp(page);
  await page.click('#rec-prev'); await page.click('#rec-prev');          // 10-10
  assert.equal(await page.textContent('#rec-date'), '2026년 10월 10일 (토)');
  await openNew(page, 'wake');
  assert.deepEqual(await modalTime(page), { date: '2026-10-10', time: '07:00' });
  await page.click('#tm-cancel');
  await openNew(page, 'sleep');
  assert.deepEqual(await modalTime(page), { date: '2026-10-10', time: '21:00' });
  await page.click('#tm-pm');                                             // 이미 오후 — 그대로
  await page.click('#tm-ok'); await settle(page);
  const added = Object.values(await serverEvents(page)).find(v => v.t === kst(2026, 10, 10, 21, 0) && v.type === 'sleep' && v.at !== 1);
  assert.ok(added, '10-10 21:00 수면이 저장된다');
}));

test('앞으로의 시각은 막는다', () => run({ fake: signedIn() }, async page => {
  await waitApp(page);
  await openNew(page, 'sleep');                                           // 지금 20:00 → 오전으로 바꾸면 08:00 (과거), 다시 오후 11시로
  await page.click('#tm-h');
  await page.evaluate(() => { const d = document.getElementById('tm-dial').getBoundingClientRect(); const e = { clientX: d.left + d.width * 0.3, clientY: d.top + d.height * 0.17 }; return e; });
  // 다이얼 11시 자리(왼쪽 위)를 눌러 23:00 으로
  const b = await page.locator('#tm-dial').boundingBox();
  const ang = (11 * 30 - 90) * Math.PI / 180, r = b.width * 99 / 250;
  await page.mouse.click(b.x + b.width / 2 + r * Math.cos(ang), b.y + b.height / 2 + r * Math.sin(ang));
  assert.equal((await modalTime(page)).time, '23:00');
  await page.click('#tm-ok');
  assert.equal(await toastText(page), '앞으로의 시각은 넣을 수 없습니다');
  assert.equal(Object.keys(await serverEvents(page)).length, 6);
}));

test('오프라인: 누른 기록은 화면에 바로 보이지만 서버엔 없고, 연결되면 그때 저장된다 (그 전에 앱이 꺼지면 사라진다)', () => run({ fake: signedIn() }, async page => {
  await waitApp(page);
  await page.evaluate(() => window.__fake.db.goOffline());
  await openNew(page, 'sleep'); await page.click('#tm-ok');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#rec-events .ev').count(), 2, '로컬 반영으로 줄이 보인다');
  assert.equal(Object.keys(await serverEvents(page)).length, 6, '서버엔 아직 없다');
  assert.equal(await page.evaluate(() => window.__fake.db.pending()), 1);
  assert.equal(await page.isHidden('#toast'), true, '실패도 성공도 아무 안내가 없다');
  await page.evaluate(() => window.__fake.db.goOnline()); await settle(page);
  assert.equal(Object.keys(await serverEvents(page)).length, 7);
}));

test('피요로그 기록을 고치면 type 은 남고 src 는 지워져 사람 기록이 된다', () => run({ fake: signedIn() }, async page => {
  await waitApp(page);
  await page.click('#rec-prev');                                          // 10-11
  const row = page.locator('#rec-events .ev[data-id="e-n1"]');            // 13:00 낮잠 (피요로그)
  await row.click(); await page.waitForSelector('#time-modal:not(.hidden)');
  assert.deepEqual(await modalTime(page), { date: '2026-10-11', time: '13:00' });
  assert.equal(await page.isVisible('#tm-del'), true, '수정 창엔 삭제가 있다');
  await page.click('#tm-am');                                             // 01:00
  await page.click('#tm-ok'); await settle(page);
  const v = (await serverEvents(page))['e-n1'];
  assert.deepEqual([v.type, v.t, v.by, 'src' in v], ['sleep', kst(2026, 10, 11, 1, 0), UID, false]);
  assert.equal(await page.textContent('#rec-date'), '2026년 10월 11일 (일)', '저장 뒤 그 기록의 날을 본다');
}));

test('삭제: 확인 뒤 remove', () => run({ fake: signedIn() }, async page => {
  await waitApp(page);
  page.on('dialog', d => d.accept());
  await page.click('#rec-events .ev[data-id="e-w2"]'); await page.waitForSelector('#time-modal:not(.hidden)');
  await page.click('#tm-del'); await settle(page);
  assert.equal('e-w2' in await serverEvents(page), false);
  assert.equal(await page.locator('#rec-events .empty').count(), 1);
}));

test('두 사람이 거의 동시에 수면을 누르면 둘 다 남고(덮지 않음), 합계는 뒤의 것부터 센다', () => run({ fake: signedIn() }, async page => {
  await waitApp(page);
  await openNew(page, 'sleep'); await page.click('#tm-ok'); await settle(page);
  await page.evaluate(([p, t]) => window.__fake.db.serverSet(p + '/e-other', { type: 'sleep', t: t, by: 'uid-test-b', at: 2 }), [EV, kst(2026, 10, 12, 20, 0) + 20 * 1000]);
  assert.equal(await page.locator('#rec-events .ev').count(), 3);
  assert.equal(await page.locator('#rec-events .dur.live').count(), 1, '자는 중 표시는 하나');
  assert.equal(await page.locator('#rec-strip .fill').count(), 1);
}));

test('수정 창을 연 사이 상대가 그 기록을 지우면: 되살리지도, type 없는 조각을 만들지도 않고 알려 준다', () => run({ fake: signedIn() }, async page => {
  await waitApp(page);
  await page.click('#rec-events .ev[data-id="e-w2"]'); await page.waitForSelector('#time-modal:not(.hidden)');
  await page.evaluate(p => window.__fake.db.serverSet(p + '/e-w2', null), EV);       // 상대가 지움 — 구독으로 줄이 사라진다
  assert.equal(await page.locator('#rec-events .ev[data-id="e-w2"]').count(), 0);
  await page.click('#tm-am'); await page.click('#tm-ok');
  const msg = await toastText(page);
  await settle(page);
  const log = await page.evaluate(() => window.__fake.db.log);
  assert.equal(log.rejected.length, 0, '규칙에 막히는 쓰기(type 없는 조각)를 보내지 않는다: ' + JSON.stringify(log.rejected));
  assert.equal('e-w2' in await serverEvents(page), false, '지운 기록을 되살리지 않는다');
  assert.match(msg, /지워진 기록/, '사용자에게 지워진 기록임을 알린다 (받은 안내: ' + msg + ')');
}));

test('오프라인에서 수정 → 그사이 상대가 지움 → 연결: 조각을 만들지 않고 알려 준다', () => run({ fake: signedIn() }, async page => {
  await waitApp(page);
  await page.evaluate(() => window.__fake.db.goOffline());
  await page.click('#rec-events .ev[data-id="e-w2"]'); await page.waitForSelector('#time-modal:not(.hidden)');
  await page.evaluate(p => window.__fake.db.serverSet(p + '/e-w2', null), EV);       // 이 기기는 아직 모른다
  await page.click('#tm-am'); await page.click('#tm-ok');
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__fake.db.goOnline());
  const msg = await toastText(page);
  await settle(page);
  const log = await page.evaluate(() => window.__fake.db.log);
  assert.equal(log.rejected.length, 0, '규칙에 막히는 쓰기를 보내지 않는다: ' + JSON.stringify(log.rejected));
  assert.equal('e-w2' in await serverEvents(page), false);
  assert.match(msg, /지워진 기록/);
  assert.equal(await page.locator('#rec-events .ev[data-id="e-w2"]').count(), 0, '화면에도 남지 않는다');
}));

test('메모 저장·삭제와 상대 메모 반영', () => run({ fake: signedIn() }, async page => {
  await waitApp(page);
  await page.click('#memo-edit'); await page.fill('#memo-input', '  오늘 처음 혼자 양치  '); await page.click('#memo-ok'); await settle(page);
  const memos = () => page.evaluate(h => window.__fake.db.server()['dogyeom-sleep'][h].memos || {}, HID);
  assert.deepEqual((await memos())['2026-10-12'].text, '오늘 처음 혼자 양치');
  assert.equal(await page.textContent('#memo-text'), '오늘 처음 혼자 양치');
  await page.evaluate(h => window.__fake.db.serverSet(`dogyeom-sleep/${h}/memos/2026-10-11`, { text: '상대가 쓴 메모', by: 'uid-test-b', at: 3 }), HID);
  await page.click('#rec-prev');
  assert.equal(await page.textContent('#memo-text'), '상대가 쓴 메모');
  await page.click('#memo-edit'); await page.fill('#memo-input', ''); await page.click('#memo-ok'); await settle(page);
  assert.equal('2026-10-11' in await memos(), false);
}));

/* ---------- 자정 넘김 ---------- */
test('자정을 넘기면 「오늘」을 보던 기록 화면은 새 날로 가고, 기상 시계는 전날 7시가 아니라 지금 시각에서 시작한다', () => run({ fake: signedIn(), clock: '2026-10-12T23:59:00+09:00' }, async page => {
  await waitApp(page);
  assert.equal(await page.textContent('#rec-date'), '2026년 10월 12일 (월)');
  await page.clock.pauseAt('2026-10-13T00:00:30+09:00');
  // 화면이 켜져 있던 기기: 1분 간격 다시 그림 / 배경에서 돌아온 기기: visibilitychange
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.clock.runFor(60 * 1000);
  assert.equal(await page.textContent('#rec-date'), '2026년 10월 13일 (화)');
  await openNew(page, 'wake');
  assert.deepEqual(await modalTime(page), { date: '2026-10-13', time: '00:01' });
  await page.click('#tm-ok'); await page.clock.runFor(50);
  const added = Object.values(await serverEvents(page)).find(v => v.at !== 1);
  assert.deepEqual([added.type, added.t], ['wake', kst(2026, 10, 13, 0, 1)]);
}));

test('자정 직후 다시 그려지기 전에 눌러도 새 날 기준이고, 다른 날을 보고 있었다면 그대로 둔다', () => run({ fake: signedIn(), clock: '2026-10-12T23:59:50+09:00' }, async page => {
  await waitApp(page);
  await page.clock.pauseAt('2026-10-13T00:00:05+09:00');
  await openNew(page, 'sleep');
  assert.deepEqual(await modalTime(page), { date: '2026-10-13', time: '00:00' });
  await page.click('#tm-cancel');
  await page.click('#rec-prev');                                          // 10-12 를 일부러 본다
  await page.clock.runFor(60 * 1000);
  assert.equal(await page.textContent('#rec-date'), '2026년 10월 12일 (월)');
  await openNew(page, 'sleep');
  assert.deepEqual(await modalTime(page), { date: '2026-10-12', time: '21:00' });
}));

test('주가 바뀌는 자정: 「이번 주」를 보던 정리표도 새 주로', () => run({ fake: signedIn(), clock: '2026-10-17T23:59:00+09:00', viewport: { width: 1280, height: 800 } }, async page => {
  await waitApp(page);
  assert.match(await page.textContent('#sum-range'), /^2026년 10월 11일/);
  await page.clock.pauseAt('2026-10-18T00:00:30+09:00');
  await page.clock.runFor(60 * 1000);
  assert.match(await page.textContent('#sum-range'), /^2026년 10월 18일/);
}));

/* ---------- XSS ---------- */
test('메모 글·검색 강조는 HTML 로 해석되지 않는다', () => run({ fake: signedIn() }, async page => {
  await waitApp(page);
  const evil = '<img src=x onerror="window.__xss=1"> &lt;b&gt;굵게&lt;/b&gt; <script>window.__xss=2</script>';
  await page.evaluate(([h, t]) => window.__fake.db.serverSet(`dogyeom-sleep/${h}/memos/2026-10-12`, { text: t, by: 'uid-test-b', at: 3 }), [HID, evil]);
  assert.equal(await page.textContent('#memo-text'), evil);
  await page.click('#open-memos'); await page.waitForSelector('#memos-screen:not(.hidden)');
  assert.equal(await page.locator('#memos-list img, #memos-list script').count(), 0);
  assert.equal(await page.locator('#memos-list .mt').textContent(), evil);
  await page.fill('#mm-search', '<img onerror');
  assert.equal(await page.locator('#memos-list mark').count(), 2, '낱말마다 강조');
  assert.equal(await page.locator('#memos-list img').count(), 0);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
}));

/* ---------- 「나」 프로필 ---------- */
test('?me=1 로 켜면 알약 두 칸이 보이고, 「나」의 기록은 my-sleep/{uid} 에 저장된다', () => run({ fake: signedIn(), query: '?me=1' }, async page => {
  await waitApp(page);
  assert.equal(await page.locator('#rec-who .seg').count(), 2);
  await page.click('#rec-who .seg[data-w=me]');
  assert.equal(await page.title(), '내 수면');
  assert.equal(await page.locator('#rec-events .ev').count(), 0, '「나」는 아직 기록이 없다');
  await openNew(page, 'sleep');
  assert.equal((await modalTime(page)).date, '2026-10-12');
  await page.click('#tm-ok'); await settle(page);
  const mine = await page.evaluate(u => window.__fake.db.server()['my-sleep'][u].events, UID);
  assert.equal(Object.keys(mine).length, 1);
  assert.equal(Object.keys(await serverEvents(page)).length, 6, '도겸 기록엔 안 들어간다');
  await page.click('#rec-who .seg[data-w=dogyeom]');
  assert.equal(await page.locator('#rec-events .ev').count(), 1);
  assert.equal(await page.evaluate(() => localStorage.getItem('dsleep_who')), 'dogyeom');
}));

/* ---------- 세 화면 폭 ---------- */
for (const [name, viewport] of [['360 폰 접은 화면', { width: 360, height: 780 }], ['750 폴드 펼친 화면', { width: 750, height: 1000 }], ['1280 태블릿 가로', { width: 1280, height: 800 }]]) {
  test(`화면 ${name}: 가로 넘침 없이 뜬다 (demo)`, () => run({ query: '?demo=1', viewport, clock: null }, async page => {
    await waitApp(page);
    for (const tab of ['record', 'summary']) {
      if (viewport.width < 900) await page.click(`.tab[data-page=${tab}]`);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(over <= 0, `${tab} 가로 넘침 ${over}px`);
      assert.equal(await page.isVisible(tab === 'record' ? '#rec-strip .fill' : '#chart .bar'), true, `${tab} 화면이 보인다`);
      await page.screenshot({ path: path.join(__dirname, 'out', `${viewport.width}-${tab}.png`) });
    }
  }));
}
