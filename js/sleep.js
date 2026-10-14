/* =============================================
   수면 계산 — 화면과 무관한 순수 함수 (브라우저·Node 공용)

   저장 단위는 "사건"이다: { type: 'sleep' | 'wake', t: epoch ms }.
   원래 쓰던 앱(피요로그)과 같은 방식이라 기록 탭에 사건이 그대로 줄로 보인다.
   잠 한 번 = 수면 사건 → 다음 기상 사건. 계산은 여기서만 한다.
============================================= */
(function (root) {
  'use strict';
  const MIN = 60 * 1000, DAY = 24 * 60 * MIN;
  const BIRTH = new Date(2020, 4, 19);   // 도겸 2020-05-19

  // 사건 목록 → 잠 목록 [{s, e, sleepId, wakeId, open}]
  //  - 수면 뒤 수면(기상 빠짐): 앞의 것을 버리고 뒤의 것부터 센다 (잘못 누른 경우가 대부분)
  //  - 기상 뒤 기상(수면 빠짐): 앞 수면이 없으니 잠으로 치지 않는다
  //  - 끝에 남은 수면: 자는 중 (open) — e는 now.
  //    단 STALE_H 시간이 넘도록 기상이 없으면 "기상을 안 누른 것"으로 보고 길이 0(stale)으로 둔다 —
  //    안 그러면 며칠 뒤까지 매일 24시간 잠으로 합산된다 (2026-09-30)
  const STALE_H = 18;
  function sessions(events, now) {
    const list = Object.entries(events || {})
      .map(([id, v]) => ({ id, type: v.type, t: Number(v.t) }))
      .filter(v => v.t && (v.type === 'sleep' || v.type === 'wake'))
      .sort((a, b) => a.t - b.t);
    const out = [];
    let open = null;
    for (const ev of list) {
      if (ev.type === 'sleep') open = ev;
      else if (open) { out.push({ s: open.t, e: ev.t, sleepId: open.id, wakeId: ev.id, open: false }); open = null; }
    }
    if (open) {
      const e = Math.max(open.t, now || Date.now());
      const stale = e - open.t > STALE_H * 60 * MIN;
      out.push({ s: open.t, e: stale ? open.t : e, sleepId: open.id, wakeId: null, open: true, stale });
    }
    return out;
  }

  function dayStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); }
  function addDays(ms, n) { const x = new Date(ms); x.setDate(x.getDate() + n); return x.getTime(); }

  // 그날(자정~자정) 안에 들어온 조각들 [{from, to, open, cutS, cutE}] — 분 단위 (0~1440)
  // cutS/cutE: 자정에 잘린 쪽 (잠든·일어난 시각이 이 날이 아니라 전날·다음 날에 있다, 2026-10-03)
  function dayPieces(sess, day0) {
    const day1 = addDays(day0, 1);   // 서머타임 없음. 그래도 날짜 연산으로 둔다
    const out = [];
    for (const x of sess) {
      const a = Math.max(x.s, day0), b = Math.min(x.e, day1);
      if (b > a) out.push({ from: (a - day0) / MIN, to: (b - day0) / MIN, open: x.open, cutS: a !== x.s, cutE: b !== x.e });
    }
    return out;
  }
  function dayTotal(sess, day0) { return dayPieces(sess, day0).reduce((n, p) => n + (p.to - p.from), 0); }

  // 밤잠·낮잠 나누기 (2026-10-14 사용자 요청 — 날짜 밑에 "전날 저녁~그날 아침에 몇 시간 잤나").
  // 자정으로 자르지 않고 잠 한 번을 통째로 본다. 기준은 피요로그 4년치(잠 2,022회)로 맞췄다 —
  // 아침 날짜 1,551일 중 1,541일에 밤잠이 딱 하나, 둘인 날 0, 없는 날 10(기상 누락 6건과 기록 빈칸 1일).
  //  - 밤잠: 3시간 이상이고 13시 전에 깼으며, 자정을 넘겼거나 06시 전에 잠든 잠
  //    (저녁 일찍 2~5시간 자고 밤 10시 전에 깬 잠은 낮잠 — 처음 기준으로는 이게 밤잠 둘을 만들었다)
  //  - 같은 밤으로 묶기: 앞쪽은 18시 이후 잠들어 90분 안에 이어진 잠, 뒤쪽은 3시간 30분 안에 07시 전 다시 잠든 잠 (깬 횟수로 센다)
  //  - 16시간 넘는 잠은 기상 누락으로 보고 합계에서 뺀다 (피요로그 원본에 21~33시간 잠 6건)
  //  - 자는 중인 잠: 18~06시에 잠들었으면 밤잠으로 미리 센다(12시 이후에 잠들었으면 다음 날 아침 몫)
  // 밤잠은 일어난 날(아침 날짜)에, 낮잠은 잠든 날에 붙는다
  const NIGHT_MIN = 3 * 60, WAKE_BY_H = 13, EARLY_H = 6, BAD_H = 16, EVE_H = 18, BACK_GAP = 90, FWD_GAP = 210, RESLEEP_H = 7;
  function hourOf(ms) { const d = new Date(ms); return d.getHours() + d.getMinutes() / 60; }
  function splitSleeps(sess) {
    const items = sess.filter(x => !x.stale && x.e > x.s).map(x => {
      const len = (x.e - x.s) / MIN;
      let kind;
      if (!x.open && len >= BAD_H * 60) kind = 'bad';
      else if (x.open) kind = (hourOf(x.s) >= EVE_H || hourOf(x.s) < EARLY_H) ? 'night' : 'nap';
      else kind = len >= NIGHT_MIN && hourOf(x.e) < WAKE_BY_H && (dayStart(x.e) > dayStart(x.s) || hourOf(x.s) < EARLY_H) ? 'night' : 'nap';
      return { s: x.s, e: x.e, open: x.open, kind };
    });
    const used = new Set(), nights = [];
    items.forEach((x, i) => {
      if (x.kind !== 'night' || used.has(i)) return;
      used.add(i);
      const n = { s: x.s, e: x.e, sleep: (x.e - x.s) / MIN, wakes: 0, open: x.open };
      for (let j = i - 1; j >= 0; j--) {
        const y = items[j];
        if (used.has(j) || y.kind !== 'nap' || hourOf(y.s) < EVE_H || (n.s - y.e) / MIN > BACK_GAP) break;
        n.s = y.s; n.sleep += (y.e - y.s) / MIN; n.wakes++; used.add(j);
      }
      for (let j = i + 1; j < items.length; j++) {
        const y = items[j];
        if (y.kind === 'bad' || (y.s - n.e) / MIN > FWD_GAP) break;
        if (!(hourOf(y.s) < RESLEEP_H || (dayStart(y.s) === dayStart(n.s) && hourOf(y.s) >= EVE_H))) break;
        n.e = y.e; n.sleep += (y.e - y.s) / MIN; n.wakes++; n.open = y.open; used.add(j);
      }
      // 자는 중이면 아직 안 깼으니 잠든 시각으로 아침 날짜를 정한다
      n.day = n.open ? (hourOf(n.s) >= 12 ? addDays(dayStart(n.s), 1) : dayStart(n.s)) : dayStart(n.e);
      nights.push(n);
    });
    const naps = items.filter((x, i) => !used.has(i) && x.kind === 'nap').map(x => ({ s: x.s, e: x.e, open: x.open, day: dayStart(x.s) }));
    const bad = items.filter(x => x.kind === 'bad');
    return { nights, naps, bad };
  }
  // 그 날짜의 밤잠(그날 아침에 깬 잠)과 낮잠 — {night: 분|null, nightOpen, wakes, nap: 분, napCount, napOpen, bad}
  // bad: 기상 누락 잠이 이 날의 밤을 덮었다 (잠든 다음 날부터 깬 날까지)
  function daySleep(split, day0) {
    const ns = split.nights.filter(n => n.day === day0), ps = split.naps.filter(p => p.day === day0);
    return {
      night: ns.length ? ns.reduce((a, n) => a + n.sleep, 0) : null,
      nightOpen: ns.some(n => n.open),
      wakes: ns.reduce((a, n) => a + n.wakes, 0),
      nap: ps.reduce((a, p) => a + (p.e - p.s) / MIN, 0),
      napCount: ps.length,
      napOpen: ps.some(p => p.open),
      bad: split.bad.some(b => day0 > dayStart(b.s) && day0 <= dayStart(b.e))
    };
  }
  function fmtHM(min) { min = Math.round(min); return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`; }

  function fmtDur(min) {
    min = Math.round(min);
    const h = Math.floor(min / 60), m = min % 60;
    return `${h}시간${m ? ' ' + m + '분' : ''}`;
  }
  function fmtDur2(min) { min = Math.round(min); return { h: Math.floor(min / 60), m: min % 60 }; }

  // 만 나이 "6세 4개월 9일"
  function age(dateMs) {
    const d = new Date(dateMs);
    let y = d.getFullYear() - BIRTH.getFullYear();
    let m = d.getMonth() - BIRTH.getMonth();
    let dd = d.getDate() - BIRTH.getDate();
    if (dd < 0) { m -= 1; dd += new Date(d.getFullYear(), d.getMonth(), 0).getDate(); }
    if (m < 0) { y -= 1; m += 12; }
    return `${y}세 ${m}개월 ${dd}일`;
  }

  // 그 날짜가 든 주의 일요일
  function weekStart(ms) { const d = new Date(dayStart(ms)); d.setDate(d.getDate() - d.getDay()); return d.getTime(); }

  function ymd(ms) { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
  function parseYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getTime(); }

  const api = { MIN, DAY, BIRTH, STALE_H, sessions, dayStart, addDays, dayPieces, dayTotal, splitSleeps, daySleep, fmtDur, fmtDur2, fmtHM, age, weekStart, ymd, parseYmd };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Sleep = api;
})(typeof window !== 'undefined' ? window : globalThis);
