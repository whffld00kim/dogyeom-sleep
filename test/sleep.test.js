// js/sleep.js 순수 함수 시험 — 짝짓기·자정 나누기·합계·나이. 시간대는 한국으로 고정한다
'use strict';
process.env.TZ = 'Asia/Seoul';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../js/sleep.js');

const H = 3600 * 1000, MIN = 60 * 1000;
const at = (y, m, d, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm).getTime();
const ev = (type, t) => ({ type, t });

test('수면 → 기상이 잠 한 번이고, 자정에 걸치면 날짜별로 나뉜다', () => {
  const events = { a: ev('sleep', at(2026, 10, 11, 21, 0)), b: ev('wake', at(2026, 10, 12, 7, 0)) };
  const sess = S.sessions(events, at(2026, 10, 12, 20, 0));
  assert.equal(sess.length, 1);
  assert.deepEqual([sess[0].sleepId, sess[0].wakeId, sess[0].open], ['a', 'b', false]);
  assert.equal(S.dayTotal(sess, at(2026, 10, 11)), 3 * 60);      // 21:00~24:00
  assert.equal(S.dayTotal(sess, at(2026, 10, 12)), 7 * 60);      // 00:00~07:00
  const p11 = S.dayPieces(sess, at(2026, 10, 11))[0], p12 = S.dayPieces(sess, at(2026, 10, 12))[0];
  assert.deepEqual([p11.from, p11.to, p11.cutS, p11.cutE], [21 * 60, 24 * 60, false, true]);
  assert.deepEqual([p12.from, p12.to, p12.cutS, p12.cutE], [0, 7 * 60, true, false]);
  assert.equal(S.dayPieces(sess, at(2026, 10, 13)).length, 0);
});

test('정확히 자정에 끝나거나 시작하는 잠은 길이 0 조각을 만들지 않는다', () => {
  const sess = S.sessions({ a: ev('sleep', at(2026, 10, 11, 22, 0)), b: ev('wake', at(2026, 10, 12, 0, 0)), c: ev('sleep', at(2026, 10, 12, 0, 0)), d: ev('wake', at(2026, 10, 12, 1, 0)) }, at(2026, 10, 12, 20));
  assert.equal(S.dayPieces(sess, at(2026, 10, 11)).length, 1);
  assert.equal(S.dayPieces(sess, at(2026, 10, 12)).length, 1);
  assert.equal(S.dayTotal(sess, at(2026, 10, 11)), 120);
  assert.equal(S.dayTotal(sess, at(2026, 10, 12)), 60);
});

test('수면 뒤 수면이면 앞의 것을 버리고, 기상 뒤 기상·수면 없는 기상은 잠으로 치지 않는다', () => {
  const events = {
    w0: ev('wake', at(2026, 10, 11, 6, 0)),            // 앞 수면 없음 → 무시
    s1: ev('sleep', at(2026, 10, 11, 20, 0)),          // 기상 빠짐 → 버림
    s2: ev('sleep', at(2026, 10, 11, 21, 0)),
    w1: ev('wake', at(2026, 10, 12, 7, 0)),
    w2: ev('wake', at(2026, 10, 12, 7, 5))             // 기상 뒤 기상 → 무시
  };
  const sess = S.sessions(events, at(2026, 10, 12, 20));
  assert.equal(sess.length, 1);
  assert.deepEqual([sess[0].sleepId, sess[0].wakeId], ['s2', 'w1']);
});

test('기상을 안 누른 잠: 18시간 전까지는 자는 중, 넘으면 길이 0 으로 합계에서 뺀다', () => {
  const s = at(2026, 10, 11, 21, 0);
  const events = { a: ev('sleep', s) };
  const live = S.sessions(events, s + 9 * H)[0];
  assert.deepEqual([live.open, live.stale, live.e], [true, false, s + 9 * H]);
  assert.equal(S.dayTotal(S.sessions(events, s + 9 * H), at(2026, 10, 12)), 6 * 60);
  const stale = S.sessions(events, s + S.STALE_H * H + MIN)[0];
  assert.deepEqual([stale.open, stale.stale, stale.e], [true, true, s]);
  assert.equal(S.dayTotal(S.sessions(events, s + S.STALE_H * H + MIN), at(2026, 10, 11)), 0);
  assert.equal(S.dayPieces(S.sessions(events, s + S.STALE_H * H + MIN), at(2026, 10, 12)).length, 0);
  // 앞으로의 시각(기기 시계 차이)이면 길이 0 — 음수가 되지 않는다
  assert.equal(S.sessions({ a: ev('sleep', s) }, s - 3 * MIN)[0].e, s);
});

test('잘못된 값은 걸러낸다: 문자열 t 는 숫자로, type 이 다르거나 t 가 없으면 제외', () => {
  const sess = S.sessions({
    a: { type: 'sleep', t: String(at(2026, 10, 11, 21)) }, b: { type: 'wake', t: at(2026, 10, 12, 7) },
    c: { type: 'nap', t: at(2026, 10, 12, 8) }, d: { type: 'sleep' }, e: { type: 'wake', t: 0 }
  }, at(2026, 10, 12, 20));
  assert.equal(sess.length, 1);
  assert.equal(sess[0].s, at(2026, 10, 11, 21));
  assert.deepEqual(S.sessions(null, 0), []);
});

test('하루 합계는 밤잠 조각과 낮잠을 더하고, 표시는 시간·분으로 나눈다', () => {
  const sess = S.sessions({
    a: ev('sleep', at(2026, 10, 10, 21, 0)), b: ev('wake', at(2026, 10, 11, 7, 0)),
    c: ev('sleep', at(2026, 10, 11, 13, 0)), d: ev('wake', at(2026, 10, 11, 14, 30)),
    e: ev('sleep', at(2026, 10, 11, 21, 10)), f: ev('wake', at(2026, 10, 12, 6, 50))
  }, at(2026, 10, 12, 20));
  assert.equal(S.dayTotal(sess, at(2026, 10, 11)), 7 * 60 + 90 + 170);
  assert.deepEqual(S.fmtDur2(7 * 60 + 90 + 170), { h: 11, m: 20 });
  assert.equal(S.fmtDur(90), '1시간 30분');
  assert.equal(S.fmtDur(120), '2시간');
  assert.equal(S.fmtDur(59.6), '1시간');
});

/* ---------- 밤잠·낮잠 나누기 (2026-10-14) ---------- */
const sessOf = (pairs, now = at(2026, 10, 20)) => {
  const events = {};
  pairs.forEach(([a, b], i) => { events['s' + i] = ev('sleep', a); if (b) events['w' + i] = ev('wake', b); });
  return S.sessions(events, now);
};

test('밤잠은 일어난 날(아침 날짜)에, 낮잠은 잠든 날에 붙는다', () => {
  const sp = S.splitSleeps(sessOf([
    [at(2026, 10, 10, 21, 0), at(2026, 10, 11, 7, 0)],
    [at(2026, 10, 11, 13, 0), at(2026, 10, 11, 14, 30)],
    [at(2026, 10, 11, 21, 10), at(2026, 10, 12, 6, 50)]
  ]));
  assert.deepEqual([sp.nights.length, sp.naps.length, sp.bad.length], [2, 1, 0]);
  const d11 = S.daySleep(sp, at(2026, 10, 11)), d12 = S.daySleep(sp, at(2026, 10, 12));
  assert.deepEqual([d11.night, d11.nap, d11.napCount, d11.wakes], [10 * 60, 90, 1, 0]);
  assert.deepEqual([d12.night, d12.nap, d12.napCount], [9 * 60 + 40, 0, 0]);
  assert.equal(S.daySleep(sp, at(2026, 10, 10)).night, null);
  assert.equal(S.fmtHM(9 * 60 + 40), '9:40');
  assert.equal(S.fmtHM(65), '1:05');
});

test('저녁 일찍 자고 밤 10시 전에 깬 잠은 낮잠 — 같은 날 밤잠이 둘로 잡히지 않는다', () => {
  const sp = S.splitSleeps(sessOf([
    [at(2026, 10, 11, 18, 55), at(2026, 10, 11, 21, 25)],   // 2.5시간 저녁잠 (2022-08-29 사례)
    [at(2026, 10, 11, 23, 0), at(2026, 10, 12, 8, 0)],
    [at(2026, 10, 12, 16, 45), at(2026, 10, 12, 22, 5)],    // 5시간이어도 자정 전에 깨면 낮잠 (2022-12-28 사례)
    [at(2026, 10, 13, 0, 30), at(2026, 10, 13, 8, 0)]
  ]));
  assert.equal(S.daySleep(sp, at(2026, 10, 12)).night, 9 * 60);
  assert.equal(S.daySleep(sp, at(2026, 10, 11)).nap, 150);
  assert.equal(S.daySleep(sp, at(2026, 10, 12)).nap, 5 * 60 + 20);
  assert.equal(S.daySleep(sp, at(2026, 10, 13)).night, 7 * 60 + 30);   // 00:30에 잠들어도 밤잠
});

test('밤중에 깼다 다시 잔 잠은 한 밤으로 묶고 깬 횟수를 센다 (깨어 있던 시간은 빼고)', () => {
  const sp = S.splitSleeps(sessOf([
    [at(2026, 10, 11, 20, 0), at(2026, 10, 11, 20, 40)],    // 잠들었다 깸 → 50분 뒤 다시 (앞쪽 90분)
    [at(2026, 10, 11, 21, 30), at(2026, 10, 12, 2, 20)],
    [at(2026, 10, 12, 5, 20), at(2026, 10, 12, 9, 20)]      // 3시간 뒤 07시 전 다시 (뒤쪽 3시간 30분, 2022-08-28 사례)
  ]));
  const d = S.daySleep(sp, at(2026, 10, 12));
  assert.deepEqual([sp.nights.length, d.wakes, d.night, d.napCount], [1, 2, 40 + 290 + 240, 0]);
});

test('13시 넘어 깬 긴 잠은 낮잠이 아니라 밤잠으로 (2023-01-15·12-17 사례) — 13시 기준', () => {
  const sp = S.splitSleeps(sessOf([[at(2026, 10, 11, 23, 5), at(2026, 10, 12, 12, 5)], [at(2026, 10, 13, 4, 20), at(2026, 10, 13, 12, 10)]]));
  assert.equal(S.daySleep(sp, at(2026, 10, 12)).night, 13 * 60);
  assert.equal(S.daySleep(sp, at(2026, 10, 13)).night, 7 * 60 + 50);
});

test('16시간 넘는 잠은 기상 누락으로 보고 합계에서 빼고, 덮인 날에 표시한다', () => {
  const sp = S.splitSleeps(sessOf([[at(2026, 5, 21, 23, 50), at(2026, 5, 23, 8, 45)]]));
  assert.deepEqual([sp.nights.length, sp.naps.length, sp.bad.length], [0, 0, 1]);
  assert.deepEqual([S.daySleep(sp, at(2026, 5, 21)).bad, S.daySleep(sp, at(2026, 5, 22)).bad, S.daySleep(sp, at(2026, 5, 23)).bad], [false, true, true]);
  assert.equal(S.daySleep(sp, at(2026, 5, 23)).night, null);
});

test('자는 중: 밤에 잠들었으면 다음 날 아침 몫의 밤잠, 낮에 잠들었으면 낮잠. 18시간 넘으면 뺀다', () => {
  let sp = S.splitSleeps(sessOf([[at(2026, 10, 11, 21, 0)]], at(2026, 10, 12, 2, 0)));
  let d = S.daySleep(sp, at(2026, 10, 12));
  assert.deepEqual([d.night, d.nightOpen], [5 * 60, true]);
  sp = S.splitSleeps(sessOf([[at(2026, 10, 12, 0, 40)]], at(2026, 10, 12, 1, 0)));     // 자정 넘어 잠든 중 → 같은 날 아침
  assert.deepEqual([S.daySleep(sp, at(2026, 10, 12)).night, S.daySleep(sp, at(2026, 10, 12)).nightOpen], [20, true]);
  sp = S.splitSleeps(sessOf([[at(2026, 10, 12, 13, 0)]], at(2026, 10, 12, 13, 30)));
  d = S.daySleep(sp, at(2026, 10, 12));
  assert.deepEqual([d.night, d.nap, d.napOpen], [null, 30, true]);
  sp = S.splitSleeps(sessOf([[at(2026, 10, 11, 21, 0)]], at(2026, 10, 12, 21, 0)));    // 24시간째 = 기상 안 누름
  assert.deepEqual([sp.nights.length, sp.naps.length], [0, 0]);
});

test('만 나이·주 시작·날짜 문자열', () => {
  assert.equal(S.age(at(2026, 10, 13)), '6세 4개월 24일');
  assert.equal(S.age(at(2026, 3, 1)), '5세 9개월 10일');     // 전달(2월 28일) 을 빌려 센다
  assert.equal(S.age(at(2026, 5, 19)), '6세 0개월 0일');
  assert.equal(S.weekStart(at(2026, 10, 13, 15)), at(2026, 10, 11));   // 화 → 그 주 일요일
  assert.equal(S.weekStart(at(2026, 10, 11)), at(2026, 10, 11));
  assert.equal(S.ymd(at(2026, 10, 5, 23, 59)), '2026-10-05');
  assert.equal(S.parseYmd('2026-10-05'), at(2026, 10, 5));
  assert.equal(S.addDays(at(2026, 10, 31), 1), at(2026, 11, 1));
  assert.equal(Math.round((S.dayStart(at(2026, 10, 13)) - S.BIRTH.getTime()) / S.DAY), 2338);
});
