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
  assert.equal((await page.textContent('#rec-total')).replace(/\s/g, ''), '밤9시간40분');   // 0~24시 합(6시간 50분)이 아니라 어젯밤 21:10~06:50 (2026-10-14)
  assert.equal(await page.evaluate(() => localStorage.getItem('dsleep_signed_in')), '1');
}));

test('정리표 날짜 밑: 윗줄 밤잠(그날 아침에 깬 잠)·아랫줄 낮잠, 폰은 9:40 · 넓은 화면은 9시간 40분 (2026-10-14)', async () => {
  for (const [viewport, n11, n12, nap] of [
    [{ width: 360, height: 780 }, '🌙10:00', '🌙9:40', '☀️1:30'],
    [{ width: 1280, height: 800 }, '🌙10시간', '🌙9시간 40분', '☀️1시간 30분']
  ]) {
    await run({ fake: signedIn(), viewport }, async page => {
      await waitApp(page);
      if (viewport.width < 900) await page.click('.tab[data-page="summary"]');
      const xl = page.locator('#x-labels .xl small');
      const vis = async i => (await xl.nth(i).locator('b').evaluateAll(bs => bs.map(b => [...b.childNodes].filter(n => n.nodeType === 3 || getComputedStyle(n).display !== 'none').map(n => n.textContent).join('')))).join('|');
      assert.equal(await vis(0), `${n11}|${nap}`);          // 10-11(일): 10-10 21:00→07:00, 낮잠 13:00~14:30
      assert.equal(await vis(1), n12);                      // 10-12(월, 오늘): 21:10→06:50
      assert.equal((await xl.nth(2).textContent()).trim(), '');   // 내일부터는 빈칸
      assert.equal(await page.textContent('#sum-meta'), '밤잠 평균 9시간 50분 (2일) · 낮잠 1일, 평균 1시간 30분');
    });
  }
});

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

const journal = page => page.evaluate(() => JSON.parse(localStorage.getItem('dsleep_pending') || 'null'));
// 앱을 닫았다 다시 여는 것 — 같은 context 라 localStorage 는 남고, 가짜 서버는 넘겨준 상태로 다시 시작한다
async function reopen(page, server) { await page.addInitScript(st => { window.__FAKE.server = st; }, server); await page.reload(); await waitApp(page); await settle(page); }
const serverState = page => page.evaluate(() => window.__fake.db.server());

test('오프라인: 누른 기록은 화면에 바로 보이고 서버엔 아직 없다. 연결되면 저장되고 저널에서 지워진다', () => run({ fake: signedIn() }, async page => {
  await waitApp(page);
  await page.evaluate(() => window.__fake.db.goOffline());
  await openNew(page, 'sleep'); await page.click('#tm-ok');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#rec-events .ev').count(), 2, '로컬 반영으로 줄이 보인다');
  assert.equal(Object.keys(await serverEvents(page)).length, 6, '서버엔 아직 없다');
  assert.equal(await page.evaluate(() => window.__fake.db.pending()), 1);
  assert.equal((await journal(page)).length, 1, '못 보낸 쓰기가 기기에 적혀 있다');
  await page.evaluate(() => window.__fake.db.goOnline()); await settle(page);
  assert.equal(Object.keys(await serverEvents(page)).length, 7);
  assert.equal(await journal(page), null, '서버가 받으면 저널에서 지운다');
}));

test('오프라인에서 누른 기록은 앱을 닫아도 다음에 열 때 같은 키로 저장되고, 또 열어도 두 건이 되지 않는다', () => run({ fake: signedIn() }, async page => {
  await waitApp(page);
  await page.evaluate(() => window.__fake.db.goOffline());
  await openNew(page, 'sleep'); await page.click('#tm-ok'); await page.waitForTimeout(200);
  const [entry] = await journal(page);
  assert.equal(entry.kind, 'set'); assert.match(entry.path, new RegExp(`^${EV}/-fake`)); assert.equal(entry.value.type, 'sleep');
  const before = await serverState(page);
  await reopen(page, before);                                            // 꺼졌다 켜짐 — 서버는 그 기록을 모른다
  const evs = await serverEvents(page);
  assert.equal(Object.keys(evs).length, 7);
  assert.deepEqual([evs[entry.path.split('/').pop()].type, evs[entry.path.split('/').pop()].t], ['sleep', entry.value.t], '같은 키·같은 값');
  assert.equal(await journal(page), null);
  assert.match(await page.textContent('#toast'), /못 보낸 기록 1건을 저장했습니다/);
  await reopen(page, await serverState(page));                           // 한 번 더 열어도
  assert.equal(Object.keys(await serverEvents(page)).length, 7, '두 건이 되지 않는다');
  assert.equal(await page.isHidden('#toast'), true);
}));

test('오프라인에서 한 수정·삭제·메모도 다음에 열 때 반영된다', () => run({ fake: signedIn() }, async page => {
  await waitApp(page);
  page.on('dialog', d => d.accept());
  await page.evaluate(() => window.__fake.db.goOffline());
  await page.click('#rec-events .ev[data-id="e-w2"]'); await page.waitForSelector('#time-modal:not(.hidden)'); await page.click('#tm-del');   // 삭제
  await page.click('#rec-prev');
  await page.click('#rec-events .ev[data-id="e-n1"]'); await page.waitForSelector('#time-modal:not(.hidden)'); await page.click('#tm-am'); await page.click('#tm-ok');   // 13:00 → 01:00
  await page.click('#memo-edit'); await page.fill('#memo-input', '오프라인 메모'); await page.click('#memo-ok');
  await page.waitForTimeout(200);
  assert.deepEqual((await journal(page)).map(x => x.kind), ['remove', 'edit', 'set']);
  await reopen(page, await serverState(page));
  const evs = await serverEvents(page);
  assert.equal('e-w2' in evs, false, '삭제');
  assert.deepEqual([evs['e-n1'].type, evs['e-n1'].t, 'src' in evs['e-n1']], ['sleep', kst(2026, 10, 11, 1, 0), false], '수정 — type 유지, src 제거');
  assert.equal((await page.evaluate(h => window.__fake.db.server()['dogyeom-sleep'][h].memos['2026-10-11'].text, HID)), '오프라인 메모');
  assert.equal(await journal(page), null);
  assert.match(await page.textContent('#toast'), /못 보낸 기록 3건/);
}));

test('되살릴 때 상대가 이미 지운 기록의 수정은 조각을 만들지 않고 조용히 건너뛴다', () => run({ fake: signedIn() }, async page => {
  await waitApp(page);
  await page.evaluate(() => window.__fake.db.goOffline());
  await page.click('#rec-events .ev[data-id="e-w2"]'); await page.waitForSelector('#time-modal:not(.hidden)'); await page.click('#tm-am'); await page.click('#tm-ok');
  await page.waitForTimeout(200);
  const st = await serverState(page); delete st['dogyeom-sleep'][HID].events['e-w2'];   // 그사이 상대가 지움
  await reopen(page, st);
  assert.equal('e-w2' in await serverEvents(page), false, '유령 기록 없음');
  assert.equal((await page.evaluate(() => window.__fake.db.log)).rejected.length, 0);
  assert.equal(await journal(page), null);
  assert.equal(await page.isHidden('#toast'), true, '건너뛴 것은 알리지 않는다');
}));

test('온라인 저장이 끝나면 저널은 비고, 규칙에 막힌 쓰기도 저널에서 지워져 다시 보내지 않는다', () => run({ fake: signedIn() }, async page => {
  await waitApp(page);
  await openNew(page, 'sleep'); await page.click('#tm-ok'); await settle(page);
  assert.equal(await journal(page), null);
  await page.click('#memo-edit'); await page.fill('#memo-input', 'x'.repeat(5001)); await page.click('#memo-ok');
  assert.match(await toastText(page), /저장 실패: PERMISSION_DENIED/);
  await settle(page);
  assert.equal(await journal(page), null);
  assert.equal(await page.isHidden('#memo-text'), true, '규칙에 막힌 메모는 화면에서도 되돌아간다');
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

/* ---------- 폰 사본으로 먼저 열기 (2026-10-15) ---------- */
// 한 번 온라인으로 열어 사본을 남긴 뒤, 같은 기기에서 서버가 늦는(오프라인) 상태로 다시 연다
async function reopenFromCache(page, fakeOverride) {
  await page.waitForFunction(() => !!localStorage.getItem('dsleep_cache_v1'), null, { timeout: 5000 });
  await page.addInitScript(cfg => { window.__FAKE = cfg; }, fakeOverride);
  await page.reload();
}

test('폰 사본: 다음에 열면 서버를 기다리지 않고 사본으로 바로 보이고, 서버 값이 오기 전엔 기록 버튼을 막는다', () => run({ fake: signedIn() }, async page => {
  await waitApp(page);
  await reopenFromCache(page, signedIn({ online: false }));
  await waitApp(page);                                                                   // 서버(오프라인)를 안 기다리고 열렸다
  assert.equal(await page.locator('#rec-events .ev').count(), 1, '사본의 10-12 기상 기록이 보인다');
  assert.equal(await page.evaluate(() => document.body.classList.contains('stale')), true);
  assert.match(await page.textContent('#sync-badge'), /최신 기록 확인 중/);
  await page.click('.act[data-type="sleep"]');
  assert.match(await toastText(page), /확인하는 중/);
  assert.equal(await page.isHidden('#time-modal'), true, '시각 창이 열리지 않는다');
  await page.evaluate(() => window.__fake.db.goOnline());
  await page.waitForFunction(() => !document.body.classList.contains('stale'), null, { timeout: 5000 });
  assert.equal(await page.isHidden('#sync-badge'), true);
  await page.click('.act[data-type="sleep"]');
  assert.equal(await page.isVisible('#time-modal'), true, '서버 값이 온 뒤엔 기록할 수 있다');
}));

test('폰 사본: 연 사이 다른 기기에서 넣은 기록은 서버 값이 오면 반영되고, 사본도 새 값으로 바뀐다', () => run({ fake: signedIn() }, async page => {
  await waitApp(page);
  await reopenFromCache(page, signedIn({ online: false }));
  await waitApp(page);
  await page.evaluate(([p, t]) => window.__fake.db.serverSet(p, { type: 'sleep', t, by: 'uid-test-b', at: 2 }), [`${EV}/e-x1`, kst(2026, 10, 12, 13, 0)]);
  assert.equal(await page.locator('#rec-events .ev').count(), 1, '오프라인이라 아직 안 보인다');
  await page.evaluate(() => window.__fake.db.goOnline());
  await page.waitForFunction(() => document.querySelectorAll('#rec-events .ev').length === 2, null, { timeout: 5000 });
  await page.waitForFunction(() => /e-x1/.test(localStorage.getItem('dsleep_cache_v1') || ''), null, { timeout: 5000 });
}));

test('폰 사본: 가구 번호를 사본에서 쓰고, 로그아웃되면 사본을 지우고 로그인 화면으로', () => run({ fake: signedIn() }, async page => {
  await waitApp(page);
  await page.waitForFunction(() => !!localStorage.getItem('dsleep_cache_v1'), null, { timeout: 5000 });
  const c = JSON.parse(await page.evaluate(() => localStorage.getItem('dsleep_cache_v1')));
  assert.equal(c.uid, UID); assert.equal(c.hid, HID);
  await page.evaluate(() => window.__fake.auth.setUser(null));
  await page.waitForSelector('#auth-screen:not(.hidden)', { timeout: 5000 });
  assert.equal(await page.evaluate(() => localStorage.getItem('dsleep_cache_v1')), null);
}));

test('폰 사본: 다른 계정의 사본이면 쓰지 않는다', () => run({ fake: signedIn() }, async page => {
  await waitApp(page);
  await page.waitForFunction(() => !!localStorage.getItem('dsleep_cache_v1'), null, { timeout: 5000 });
  await page.evaluate(() => { const c = JSON.parse(localStorage.getItem('dsleep_cache_v1')); c.uid = 'uid-someone-else'; localStorage.setItem('dsleep_cache_v1', JSON.stringify(c)); });
  await page.reload();
  await waitApp(page);   // 남의 사본을 버리고 다시 열어 내 기록으로 (사본도 내 것으로 바뀐다)
  await page.waitForFunction(u => JSON.parse(localStorage.getItem('dsleep_cache_v1') || '{}').uid === u, UID, { timeout: 5000 });
  assert.equal(await page.locator('#rec-events .ev').count(), 1);
}));
