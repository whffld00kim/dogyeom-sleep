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
  //  - 끝에 남은 수면: 자는 중 (open) — e는 now
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
    if (open) out.push({ s: open.t, e: Math.max(open.t, now || Date.now()), sleepId: open.id, wakeId: null, open: true });
    return out;
  }

  function dayStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); }
  function addDays(ms, n) { const x = new Date(ms); x.setDate(x.getDate() + n); return x.getTime(); }

  // 그날(자정~자정) 안에 들어온 조각들 [{from, to}] — 분 단위 (0~1440)
  function dayPieces(sess, day0) {
    const day1 = addDays(day0, 1);   // 서머타임 없음. 그래도 날짜 연산으로 둔다
    const out = [];
    for (const x of sess) {
      const a = Math.max(x.s, day0), b = Math.min(x.e, day1);
      if (b > a) out.push({ from: (a - day0) / MIN, to: (b - day0) / MIN, open: x.open });
    }
    return out;
  }
  function dayTotal(sess, day0) { return dayPieces(sess, day0).reduce((n, p) => n + (p.to - p.from), 0); }

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

  const api = { MIN, DAY, sessions, dayStart, addDays, dayPieces, dayTotal, fmtDur, fmtDur2, age, weekStart, ymd, parseYmd };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Sleep = api;
})(typeof window !== 'undefined' ? window : globalThis);
