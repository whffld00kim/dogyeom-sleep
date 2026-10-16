/* =============================================
   도겸 수면 (2026-09-30)

   ── 구조 ──────────────────────────────────────
   Firebase 프로젝트는 부부가계부·우리집 가계부와 같은 `minsung-buboo2`.
   RTDB  dogyeom-sleep/{hid}/events/{id} = { type: 'sleep'|'wake', t, by, at, src? }
         dogyeom-sleep/{hid}/memos/{YYYY-MM-DD} = { text, by, at }
   권한은 부부가계부 가구 멤버십 그대로 (households/{hid}/members/{uid} == true) — 규칙은
   minsung-buboo2/database.rules.json. 가구 id는 코드에 두지 않고 users/{uid}/householdId에서 읽는다.

   우리집 가계부와 달리 문서 통째가 아니라 **사건 하나씩** 쓴다. 두 사람이 동시에 눌러도
   서로 덮지 않는다. 대신 실시간 구독(on value)으로 받아 화면을 다시 그린다.

   `?demo=1` 은 Firebase 없이 예시 데이터로 뜬다 (화면 시험용, 저장 안 됨).

   ── 「나」 프로필 (2026-10-05) ──────────────────
   같은 앱으로 내 수면도 적는다. 데이터는 가구가 아니라 **내 계정 밑** `my-sleep/{uid}`(규칙: 본인 uid만) —
   같은 가구의 다른 사람에겐 보이지 않는다. 「나」 전환은 기본 숨김: 이 기기에서 머리글 이름을 **길게 눌러** 켜거나
   `?me=1`로 연다(localStorage `dsleep_me`). 켜면 머리글 이름을 눌러 도겸 ↔ 나. 「나」에선 나이·생후·성장 메모 표기를 뺀다.
============================================= */
(function () {
  'use strict';
  const S = window.Sleep;
  const $ = id => document.getElementById(id);
  const QS = new URLSearchParams(location.search);
  const DEMO = QS.has('demo');
  const LS = { get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} } };
  if (QS.get('me') === '1') LS.set('dsleep_me', '1');
  let meOn = LS.get('dsleep_me') === '1';                 // 이 기기에서 「나」 전환을 보일지
  let who = meOn && LS.get('dsleep_who') === 'me' ? 'me' : 'dogyeom';

  const firebaseConfig = {
    apiKey: 'AIzaSyAPXiob8XeDunXpDMsLod_TwClqg2JL260',
    authDomain: 'minsung-buboo2.firebaseapp.com',
    databaseURL: 'https://minsung-buboo2-default-rtdb.asia-southeast1.firebasedatabase.app',
    projectId: 'minsung-buboo2',
    storageBucket: 'minsung-buboo2.firebasestorage.app',
    messagingSenderId: '318424534715',
    appId: '1:318424534715:web:50a3b43ea5c5325ee5239e'
  };

  let uid = null, ref = null, path = null;
  const refs = {}, paths = {};                            // { dogyeom: RTDB ref, me: RTDB ref } / 같은 것의 경로 문자열
  const store = { dogyeom: { events: {}, memos: {} }, me: { events: {}, memos: {} } };   // 프로필별 사본 — 전환이 즉시 되게 둘 다 구독
  let events = store[who].events, memos = store[who].memos;
  let sess = [], split = { nights: [], naps: [], bad: [] };
  let recDay = S.dayStart(Date.now());
  let sumWeek = S.weekStart(Date.now());
  let editing = null;   // { id?, type }
  let memoMonth = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); })();

  /* ---------- 폰 사본으로 먼저 열기 (2026-10-15) ----------
     전엔 열 때마다 로그인 확인 → 가구 번호(서버 왕복) → 기록 전체(약 480KB)를 다 받은 뒤에야 화면을 보였다.
     이제 지난번에 받은 사본(localStorage)으로 바로 그리고, 서버 값이 오면 다시 그린다. 가구 번호도 사본에 둬 왕복 하나를 뺀다.
     사본은 계정(uid) 하나분, 로그아웃되면 지운다. 원본은 늘 서버 — 사본이 깨지거나 지워져도 예전처럼 서버를 기다릴 뿐이다.
     ?nocache=1 은 사본을 안 쓰고 열기(비교용), ?perf=1 은 걸린 시간을 화면 아래에 잠깐 보인다

     ── 서버 확인 전에 누른 새 기록 (2026-10-16) ──
     10/15엔 서버 값이 오기 전엔 기록을 막았다. 그런데 로그인 확인 → DB 연결 → 기록 전체 수신이 줄줄이라 폰에서 1~5초를
     못 눌렀다(아이가 잠들 때 열자마자 누르는 앱인데). 이제 수면·기상 새 기록은 그 사이에도 받는다: 화면에 바로 그리고
     못 보낸 쓰기 저널(dsleep_pending)에 `blind` 표시로 적어 두었다가, 서버 값이 처음 오면 **사본에 없던 새 기록 중
     같은 종류가 1시간 안에 연달아 있으면**(상대가 방금 같은 순간을 눌렀다) 버리고 알리고, 아니면 보낸다(settleHeld).
     기록 수정·삭제·메모는 지금처럼 서버 값이 온 뒤에만 — 남이 고친 것을 모른 채 덮지 않게 */
  const CACHE_KEY = 'dsleep_cache_v1';
  const NOCACHE = QS.has('nocache'), PERF = QS.has('perf');
  function readCache() {
    if (NOCACHE) return null;
    try { const c = JSON.parse(LS.get(CACHE_KEY) || 'null'); return c && c.uid && c.hid && c.dogyeom ? c : null; } catch (e) { return null; }
  }
  let cacheT = 0, cacheHid = null, cacheDirty = false;
  function saveCacheNow() {
    if (!cacheDirty || !uid || !cacheHid) return;
    cacheDirty = false;
    LS.set(CACHE_KEY, JSON.stringify({ uid, hid: cacheHid, at: Date.now(), dogyeom: store.dogyeom, me: store.me }));
  }
  // 사본 저장(약 560KB 직렬화)은 0.8초 뒤, 그것도 한가할 때 — 막 누른 손과 겹치면 멈칫한다 (2026-10-16). 화면을 떠날 땐 바로
  function saveCacheSoon() {
    if (DEMO || !uid || !cacheHid) return;
    cacheDirty = true;
    clearTimeout(cacheT);
    cacheT = setTimeout(() => window.requestIdleCallback ? requestIdleCallback(saveCacheNow, { timeout: 3000 }) : saveCacheNow(), 800);
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveCacheNow(); });
  function dropCache() { clearTimeout(cacheT); cacheDirty = false; LS.set(CACHE_KEY, null); }
  // 두 기록 묶음이 같은지 — 서버 값이 사본과 같으면 다시 그리지도, 사본을 다시 쓰지도 않는다 (4천 건이라도 1ms 안쪽)
  function sameEvents(a, b) {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    for (const k of ka) {
      const x = a[k], y = b[k];
      if (!y || x.type !== y.type || x.t !== y.t || x.at !== y.at || x.by !== y.by || x.src !== y.src) return false;
    }
    return true;
  }
  // RTDB push 키와 같은 모양(시각 8자 + 무작위 12자) — 로그인 확인 전엔 SDK 의 push() 를 부르지 않으려고
  const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
  function pushKey() {
    let now = Date.now(), s = '';
    for (let i = 0; i < 8; i++) { s = PUSH_CHARS.charAt(now % 64) + s; now = Math.floor(now / 64); }
    for (let i = 0; i < 12; i++) s += PUSH_CHARS.charAt(Math.floor(Math.random() * 64));
    return s;
  }
  const marks = [];
  function mark(name) {
    if (!PERF) return;
    marks.push(name + ' ' + (performance.now() / 1000).toFixed(1) + '초');
    let el = $('perf'); if (!el) { el = document.createElement('div'); el.id = 'perf'; el.className = 'perf'; document.body.appendChild(el); }
    el.textContent = marks.join(' · ');
  }
  // 서버 값을 아직 못 받은 프로필이면 true — 기록 버튼 위 작은 표시 (버튼은 그대로 눌린다, 2026-10-16)
  let staleT = 0;
  function updateStale() {
    const stale = !DEMO && !loaded[who];
    document.body.classList.toggle('stale', stale);
    const b = $('sync-badge');
    b.classList.toggle('hidden', !stale);
    clearTimeout(staleT);
    if (stale) { b.textContent = '최신 기록 확인 중…'; staleT = setTimeout(() => { b.textContent = '연결을 기다리는 중 — 누른 기록은 연결되면 보냅니다'; }, 6000); }
  }
  // 수정·삭제·메모만 막는다 (새 기록은 위 「서버 확인 전에 누른 새 기록」)
  function notReady() {
    if (DEMO || loaded[who]) return false;
    toast('최신 기록을 확인하는 중이에요. 잠시 뒤에 다시 눌러 주세요');
    return true;
  }

  /* ---------- 공통 ---------- */
  function toast(msg) {
    const el = $('toast'); el.textContent = msg; el.classList.remove('hidden');
    clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.add('hidden'), 2200);
  }
  const WD = ['일', '월', '화', '수', '목', '금', '토'];
  function hm(ms) {
    const d = new Date(ms); let h = d.getHours(); const m = String(d.getMinutes()).padStart(2, '0');
    const ap = h < 12 ? '오전' : '오후'; h = h % 12 || 12;
    return { ap, text: `${h}:${m}` };
  }
  function hhmm(ms) { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
  function hourLabel(i) { const h = i % 12; return h === 0 ? 12 : h; }

  function recompute() { sess = S.sessions(events, Date.now()); split = S.splitSleeps(sess); }
  // 정리표가 안 보이면 그리지 않는다 — 폰은 탭을 열 때(show), 태블릿 가로는 늘 보인다 (2026-10-16)
  const WIDE = window.matchMedia('(min-width: 900px) and (orientation: landscape)');
  const sumVisible = () => WIDE.matches || $('page-summary').classList.contains('active');
  let drawn = false;
  function render() { drawn = true; recompute(); renderRecord(); if (sumVisible()) renderSummary(); }

  // 자정을 넘기면 「오늘」·「이번 주」를 보던 화면은 새 날·새 주로 따라간다 (2026-10-13).
  // 그대로 두면 밤새 켜 둔 태블릿이나 배경에 살아 있던 폰이 아침에도 전날 머리글을 보이고, 기상 시계가
  // 「전날 7시」에서 시작해 전날로 저장됐다(밤잠은 「자는 중」으로 남음). 일부러 다른 날을 보고 있었다면 그대로 둔다
  let today = S.dayStart(Date.now());
  function followToday() {
    const t = S.dayStart(Date.now());
    if (t === today) return false;
    if (recDay === today) recDay = t;
    if (sumWeek === S.weekStart(today)) sumWeek = S.weekStart(t);
    today = t;
    return true;
  }

  /* ---------- 프로필 (2026-10-05) ---------- */
  const ME = who => who === 'me';
  function applyWho() {
    document.body.classList.toggle('me', ME(who));
    document.body.classList.toggle('me-on', meOn);
    // 켜진 기기: 알약 두 칸(A안, 2026-10-05) / 안 켠 기기: 이름 글자만
    const seg = w => `<span class="seg${who === w ? ' on' : ''}" data-w="${w}">${w === 'me' ? '나 <span class="face">🙂</span>' : '도겸 <span class="face">🧒</span>'}</span>`;
    const name = meOn ? seg('dogyeom') + seg('me') : (ME(who) ? '나 <span class="face">🙂</span>' : '도겸 <span class="face">🧒</span>');
    for (const id of ['rec-who', 'sum-who']) $(id).innerHTML = name;
    const memoTitle = ME(who) ? '📖 메모' : '📖 성장 메모';
    for (const id of ['memo-title', 'memos-title', 'memo-modal-title']) $(id).textContent = memoTitle;
    $('memo-input').placeholder = ME(who) ? '오늘 메모' : '오늘 도겸이 이야기';
    document.title = ME(who) ? '내 수면' : '도겸 수면';
    events = store[who].events; memos = store[who].memos; ref = refs[who] || null; path = paths[who] || null;
    updateStale();
  }
  function switchWho(w) {
    if (w === who) return;
    who = w; LS.set('dsleep_who', who);
    applyWho(); render(); renderMemos();
  }
  function setMeOn(on) {
    meOn = on; LS.set('dsleep_me', on ? '1' : null);
    if (!on && ME(who)) { who = 'dogyeom'; LS.set('dsleep_who', null); }
    applyWho(); render(); renderMemos();
    toast(on ? '「나」 기록을 켰습니다 — 위 버튼으로 바꿉니다' : '「나」 기록을 숨겼습니다');
  }
  // 머리글 이름: 켜져 있으면 알약 두 칸을 눌러 전환, 길게 누르면(1.2초) 켜기·끄기 — 「나」는 기본 숨김(2026-10-05 사용자 결정)
  function bindWho(el) {
    let tm = 0, long = false;
    const start = () => { long = false; clearTimeout(tm); tm = setTimeout(() => {
      long = true;
      if (!meOn) { if (confirm('이 기기에서 「나」 수면 기록을 켤까요?\n(내 계정에만 저장되고 다른 가족에겐 보이지 않습니다)')) setMeOn(true); }
      else if (confirm('「나」 기록을 이 기기에서 숨길까요?\n(기록은 지워지지 않습니다)')) setMeOn(false);
    }, 1200); };
    const end = () => { clearTimeout(tm); };
    el.addEventListener('pointerdown', start);
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end); el.addEventListener('pointerleave', end);
    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener('click', e => { if (long) { long = false; return; } if (!meOn) return; const s = e.target.closest('.seg'); if (s) switchWho(s.dataset.w); });
  }

  /* ---------- 기록 ---------- */
  function renderRecord() {
    const d = new Date(recDay);
    $('rec-date').textContent = `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${WD[d.getDay()]})`;
    $('rec-age').textContent = S.age(recDay);
    $('rec-since').textContent = Math.round((recDay - S.BIRTH.getTime()) / S.DAY);
    $('rec-next').disabled = recDay >= S.dayStart(Date.now());
    $('rec-today').classList.toggle('off', recDay === S.dayStart(Date.now()));   // 오늘을 보고 있으면 숨김

    // 왼쪽 24시간 띠
    const strip = $('rec-strip');
    let html = '';
    for (let i = 0; i < 24; i++) html += `<div class="hr"><span>${hourLabel(i)}</span></div>`;
    for (const p of S.dayPieces(sess, recDay)) {
      html += `<div class="fill${p.open ? ' open' : ''}" style="top:${p.from / 14.4}%;height:${(p.to - p.from) / 14.4}%"></div>`;
    }
    strip.innerHTML = html;

    // 그날 합계 — 0~24시 합이 아니라 어젯밤(전날 저녁~이날 아침) 밤잠과 이날 낮잠을 따로 (2026-10-14)
    const ds = S.daySleep(split, recDay);
    const hmDur = m => { const f = S.fmtDur2(m); return `${f.h ? f.h + '<small>시간</small> ' : ''}${f.m}<small>분</small>`; };
    let night;
    if (ds.night != null) night = `밤 ${hmDur(ds.night)}${ds.nightOpen ? ' <span class="live">자는 중</span>' : ''}${ds.wakes ? ` <span class="sub">· ${ds.wakes}번 깸</span>` : ''}`;
    else night = ds.bad ? '밤 <span class="warn">기상 누락? (합계에서 뺌)</span>' : '밤 <span class="sub">기록 없음</span>';
    $('rec-total').innerHTML = night + (ds.napCount ? `<br>낮잠 ${hmDur(ds.nap)}${ds.napOpen ? ' <span class="live">자는 중</span>' : ''}` : '');

    // 사건 목록 (시각 오름차순)
    const day1 = S.addDays(recDay, 1);
    const list = Object.entries(events).map(([id, v]) => ({ id, ...v }))
      .filter(v => v.t >= recDay && v.t < day1).sort((a, b) => a.t - b.t);
    const byWake = {}, bySleep = {};
    for (const x of sess) { if (x.wakeId) byWake[x.wakeId] = x; bySleep[x.sleepId] = x; }
    $('rec-events').innerHTML = list.length ? list.map(v => {
      const t = hm(v.t);
      let extra = '';
      if (v.type === 'wake' && byWake[v.id]) extra = `<span class="dur">${S.fmtDur((byWake[v.id].e - byWake[v.id].s) / S.MIN)}</span>`;
      if (v.type === 'sleep' && bySleep[v.id] && bySleep[v.id].open) {
        extra = bySleep[v.id].stale
          ? `<span class="dur live">기상을 안 눌렀어요 — ${S.fmtDur((Date.now() - v.t) / S.MIN)}째 (합계에서 뺌)</span>`
          : `<span class="dur live">자는 중 ${S.fmtDur((Date.now() - v.t) / S.MIN)}</span>`;
      }
      return `<button class="row ev" data-id="${v.id}">
        <span class="time"><small>${t.ap}</small>${t.text}</span>
        <span class="ev-icon ${v.type}">${v.type === 'sleep' ? '🌙' : '☀️'}</span>
        <span class="ev-name">${v.type === 'sleep' ? '수면' : '기상'}</span>${extra}
      </button>`;
    }).join('') : '<div class="empty">아직 기록이 없습니다</div>';

    const memo = memos[S.ymd(recDay)];
    $('memo-text').textContent = memo && memo.text ? memo.text : '';
    $('memo-text').classList.toggle('hidden', !(memo && memo.text));
  }

  /* ---------- 정리표 ---------- */
  function renderSummary() {
    const w0 = sumWeek, w6 = S.addDays(w0, 6);
    const a = new Date(w0), b = new Date(w6);
    $('sum-range').textContent = `${a.getFullYear()}년 ${a.getMonth() + 1}월 ${a.getDate()}일 ~ ${b.getFullYear() !== a.getFullYear() ? b.getFullYear() + '년 ' : ''}${b.getMonth() + 1}월 ${b.getDate()}일`;
    $('sum-age').textContent = S.age(Math.min(w6, Date.now()));
    $('sum-next').disabled = w0 >= S.weekStart(Date.now());
    $('sum-today').classList.toggle('off', w0 === S.weekStart(Date.now()));

    let y = '';
    for (let i = 0; i <= 8; i++) y += `<span style="top:${i * 12.5}%">${[12, 3, 6, 9][i % 4]}</span>`;
    $('y-axis').innerHTML = y;

    let cols = '', labels = '', nSum = 0, nDays = 0, napSum = 0, napDays = 0;
    const today = S.dayStart(Date.now());
    // 1분이 몇 px인지 — 막대 바깥에 두는 시각 글자(두 줄 ≈ 22px)가 그래프 위·아래 끝을 넘으면 안쪽으로 넣는다.
    // 정리표가 숨어 있으면 0이라 1px/분으로 어림
    const pxm = ($('chart').clientHeight || 1440) / 1440;
    for (let k = 0; k < 7; k++) {
      const d0 = S.addDays(w0, k), d = new Date(d0);
      const pieces = S.dayPieces(sess, d0);
      // 시각 글자 자리 정하기 (2026-10-03). 기본은 막대 바깥(위·아래). 그래프 끝에 닿으면 안쪽(.in).
      // 잠깐 깼다 다시 잔 날은 앞 막대의 일어난 시각과 뒤 막대의 잠든 시각이 같은 틈에 들어가 겹친다(9/14 사례) →
      // 틈이 두 줄(2×22px)보다 좁으면 막대가 글자보다 긴 쪽은 안쪽으로, 짧은 쪽은 틈이 한 줄이면 바깥에 두고 아니면 뺀다
      const LBL = 22;
      for (const p of pieces) { p.sIn = p.from * pxm < LBL; p.eIn = (1440 - p.to) * pxm < LBL; p.sHide = false; p.eHide = false; }
      for (let i = 0; i + 1 < pieces.length; i++) {
        const a = pieces[i], b = pieces[i + 1], gap = (b.from - a.to) * pxm;
        if (gap >= LBL * 2 + 2) continue;
        const aFits = (a.to - a.from) * pxm >= LBL + 4, bFits = (b.to - b.from) * pxm >= LBL + 4;
        if (aFits) a.eIn = true; else if (gap < LBL) a.eHide = true;
        if (bFits) b.sIn = true; else if (gap < LBL || !a.eIn) b.sHide = true;   // 틈을 앞 글자가 쓰면 못 넣는다
      }
      // 날짜 밑 숫자는 그날 아침에 깬 밤잠(전날 저녁~이날 아침)과 이날 낮잠 (2026-10-14). 막대는 그대로 0~24시
      const ds = S.daySleep(split, d0);
      if (ds.night != null && !ds.nightOpen) { nSum += ds.night; nDays++; }
      if (ds.napCount && !ds.napOpen) { napSum += ds.nap; napDays++; }
      cols += `<button class="col${k % 2 ? ' alt' : ''}" data-day="${d0}">` +
        pieces.map(p => {
          // 막대 바로 위에 잠든 시각, 바로 아래에 일어난 시각 — 막대 바깥이라 짧은 낮잠에도 붙는다 (2026-10-03 사용자 요청,
          // 처음엔 안쪽에 넣었다가 짧은 막대엔 못 넣어 바깥으로). 자정에 잘린 쪽·자는 중인 끝은 안 적는다.
          // 안쪽(.in)·숨김은 위에서 정했다
          const len = p.to - p.from, s = hm(d0 + p.from * S.MIN), e = hm(d0 + p.to * S.MIN);
          const top = !p.cutS && !p.sHide ? `<i class="bt bt-s${p.sIn ? ' in' : ''}"><small>${s.ap}</small>${s.text}</i>` : '';
          const bot = !p.cutE && !p.open && !p.eHide ? `<i class="bt bt-e${p.eIn ? ' in' : ''}"><small>${e.ap}</small>${e.text}</i>` : '';
          return `<div class="bar${p.open ? ' open' : ''}" style="top:${p.from / 14.4}%;height:${len / 14.4}%">${top}${bot}</div>`;
        }).join('') +
        `</button>`;
      const cls = d.getDay() === 0 ? 'sun' : d.getDay() === 6 ? 'sat' : '';
      labels += `<div class="xl"><span class="${cls}"><i class="long">${d.getMonth() + 1}월 ${d.getDate()}일</i><i class="short">${d.getMonth() + 1}/${d.getDate()}</i></span>` +
        // 오늘까지는 기록이 없어도 칸을 채운다 (2026-09-30 사용자 요청 — 날짜 밑 숫자가 늘 보이게). 폰은 9:40, 넓은 화면은 9시간 40분
        (d0 <= today ? `<small>${nightLabel(ds)}<br>${ds.napCount ? `<b class="np${ds.napOpen ? ' live' : ''}"><i class="ico">☀️</i>${durLabel(ds.nap)}</b>` : '&nbsp;'}</small>` : `<small>&nbsp;<br>&nbsp;</small>`) + `</div>`;
    }
    let grid = '';
    // 1시간마다 점선, 3시간마다 실선, 정오는 굵게 (피요로그와 같게, 2026-09-30)
    for (let i = 1; i < 24; i++) grid += `<div class="gl${i % 3 === 0 ? ' major' : ''}${i === 12 ? ' mid' : ''}" style="top:${i / 24 * 100}%"></div>`;
    $('chart').innerHTML = grid + cols;
    $('x-labels').innerHTML = labels;
    $('sum-meta').textContent = nDays ? `밤잠 평균 ${S.fmtDur(nSum / nDays)} (${nDays}일) · ${napDays ? `낮잠 ${napDays}일, 평균 ${S.fmtDur(napSum / napDays)}` : '낮잠 없음'}` : '';
  }

  function durLabel(m) { return `<i class="long">${Math.round(m) < 60 ? Math.round(m) + '분' : S.fmtDur(m)}</i><i class="short">${S.fmtHM(m)}</i>`; }   // 1시간 안 되는 낮잠은 「0시간 45분」 대신 「45분」
  function nightLabel(ds) {
    if (ds.night != null) return `<b class="nt${ds.nightOpen ? ' live' : ''}"><i class="ico">🌙</i>${durLabel(ds.night)}</b>`;
    return ds.bad ? '<b class="nt warn">기상 누락?</b>' : '<b class="nt zero"><i class="ico">🌙</i>-</b>';
  }

  /* ---------- 주 고르기 ---------- */
  function openWeekPicker() {
    const cur = new Date(sumWeek + 3 * S.DAY);   // 목요일이 든 달로 본다
    const yearSel = $('wk-year'), monSel = $('wk-month');
    const thisYear = new Date().getFullYear();
    yearSel.innerHTML = '';
    for (let yy = 2020; yy <= thisYear; yy++) yearSel.innerHTML += `<option value="${yy}">${yy}년</option>`;
    monSel.innerHTML = '';
    for (let mm = 1; mm <= 12; mm++) monSel.innerHTML += `<option value="${mm}">${mm}월</option>`;
    yearSel.value = cur.getFullYear(); monSel.value = cur.getMonth() + 1;
    fillWeeks();
    $('week-modal').classList.remove('hidden'); pushLayer('modal');
  }
  function fillWeeks() {
    const yy = +$('wk-year').value, mm = +$('wk-month').value;
    const first = new Date(yy, mm - 1, 1).getTime(), last = new Date(yy, mm, 0).getTime();
    let w = S.weekStart(first), html = '';
    const nowW = S.weekStart(Date.now());
    while (w <= last) {
      const a = new Date(w), b = new Date(S.addDays(w, 6));
      let tot = 0, n = 0;
      for (let k = 0; k < 7; k++) { const ds = S.daySleep(split, S.addDays(w, k)); if (ds.night != null && !ds.nightOpen) { tot += ds.night; n++; } }
      html += `<button class="wk${w === sumWeek ? ' on' : ''}" data-w="${w}" ${w > nowW ? 'disabled' : ''}>
        <span>${a.getMonth() + 1}/${a.getDate()} ~ ${b.getMonth() + 1}/${b.getDate()}</span>
        <small>${n ? '밤잠 평균 ' + S.fmtDur(tot / n) : '기록 없음'}</small></button>`;
      w = S.addDays(w, 7);
    }
    $('wk-list').innerHTML = html;
  }

  /* ---------- 성장 메모 모아 보기 ---------- */
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function reEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function memoList() {
    return Object.entries(memos).filter(([, v]) => v && v.text).map(([k, v]) => ({ key: k, text: v.text }))
      .sort((a, b) => b.key.localeCompare(a.key));
  }
  function renderMemos() {
    if ($('memos-screen').classList.contains('hidden')) return;
    const q = $('mm-search').value.trim();
    const all = memoList();
    const m = new Date(memoMonth);
    $('mm-month').textContent = `${m.getFullYear()}년 ${m.getMonth() + 1}월`;
    const nowM = new Date(); $('mm-next').disabled = memoMonth >= new Date(nowM.getFullYear(), nowM.getMonth(), 1).getTime();
    // 검색 중엔 전체 기간, 아니면 고른 달
    $('memos-nav').classList.toggle('dim', !!q);
    const prefix = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const list = q ? all.filter(x => words.every(w => x.text.toLowerCase().includes(w))) : all.filter(x => x.key.startsWith(prefix));
    $('memos-count').textContent = q ? `검색 ${list.length}건 / 전체 ${all.length}건` : `이 달 ${list.length}건 · 전체 ${all.length}건`;
    // 원문을 낱말로 먼저 자른 뒤 조각마다 escape — escape된 엔티티나 앞서 넣은 <mark> 안에서 다시 매칭되지 않게
    const hlRe = words.length ? new RegExp('(' + words.map(reEsc).join('|') + ')', 'gi') : null;
    const hl = t => hlRe ? t.split(hlRe).map((s, i) => i % 2 ? `<mark>${esc(s)}</mark>` : esc(s)).join('') : esc(t);
    $('memos-list').innerHTML = list.length ? list.map(x => {
      const d = new Date(S.parseYmd(x.key));
      return `<button class="mcard" data-key="${x.key}"><div class="md">${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${WD[d.getDay()]})<small>${S.age(d.getTime())}</small></div><div class="mt">${hl(x.text)}</div></button>`;
    }).join('') : `<div class="empty">${q ? '찾는 메모가 없습니다' : '이 달에 쓴 메모가 없습니다'}</div>`;
  }
  function openMemos() {
    const d = new Date(recDay); memoMonth = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    $('memos-screen').classList.remove('hidden'); pushLayer('screen'); renderMemos();
  }
  function shiftMonth(n) { const d = new Date(memoMonth); memoMonth = new Date(d.getFullYear(), d.getMonth() + n, 1).getTime(); renderMemos(); }
  function openMonthPicker() {
    const y = $('mo-year'), thisYear = new Date().getFullYear();
    y.innerHTML = ''; for (let yy = 2020; yy <= thisYear; yy++) y.innerHTML += `<option value="${yy}">${yy}년</option>`;
    y.value = new Date(memoMonth).getFullYear(); fillMonths();
    $('month-modal').classList.remove('hidden'); pushLayer('modal');
  }
  function fillMonths() {
    const yy = +$('mo-year').value, now = new Date(), cnt = {};
    for (const x of memoList()) { const k = x.key.slice(0, 7); cnt[k] = (cnt[k] || 0) + 1; }
    let h = '';
    for (let mm = 1; mm <= 12; mm++) {
      const t = new Date(yy, mm - 1, 1).getTime(), k = `${yy}-${String(mm).padStart(2, '0')}`;
      h += `<button class="mo${t === memoMonth ? ' on' : ''}" data-t="${t}" ${t > now.getTime() ? 'disabled' : ''}>${mm}월<small>${cnt[k] ? cnt[k] + '건' : ''}</small></button>`;
    }
    $('mo-grid').innerHTML = h;
  }

  /* ---------- 입력 ---------- */
  // 원형 시계 (2026-10-02) — 기기 시계는 취소·삭제를 앱이 못 다뤄 앱 안에 직접 그린다.
  // 시를 고르고 손을 떼면 분으로 넘어간다. 값은 #tm-time(HH:MM)에 두고 saveTime이 읽는다
  const clk = { h: 7, m: 30, mode: 'h' };
  const p2 = n => String(n).padStart(2, '0');
  function drawClock() {
    $('tm-time').value = p2(clk.h) + ':' + p2(clk.m);
    $('tm-h').textContent = clk.h % 12 || 12; $('tm-m').textContent = p2(clk.m);
    $('tm-h').classList.toggle('on', clk.mode === 'h'); $('tm-m').classList.toggle('on', clk.mode === 'm');
    $('tm-am').classList.toggle('on', clk.h < 12); $('tm-pm').classList.toggle('on', clk.h >= 12);
    const R = 125, rN = 99, val = clk.mode === 'h' ? clk.h % 12 : clk.m;
    const rad = ((clk.mode === 'h' ? val * 30 : val * 6) - 90) * Math.PI / 180;
    const x = R + rN * Math.cos(rad), y = R + rN * Math.sin(rad);
    let s = `<circle cx="${R}" cy="${R}" r="${R}" fill="#444"/><line x1="${R}" y1="${R}" x2="${x}" y2="${y}" stroke="var(--acc)" stroke-width="2"/>`
      + `<circle cx="${R}" cy="${R}" r="4" fill="var(--acc)"/><circle cx="${x}" cy="${y}" r="21" fill="var(--acc)"/>`;
    for (let i = 0; i < 12; i++) {
      const a = (i * 30 - 90) * Math.PI / 180, hit = clk.mode === 'h' ? val === i : val === i * 5;
      s += `<text x="${R + rN * Math.cos(a)}" y="${R + rN * Math.sin(a)}"${hit ? ' class="hit"' : ''}>${clk.mode === 'h' ? (i || 12) : p2(i * 5)}</text>`;
    }
    if (clk.mode === 'm' && val % 5) s += `<circle cx="${x}" cy="${y}" r="3" fill="#222"/>`;
    $('tm-dial').innerHTML = s;
  }
  function pickClock(e) {
    const b = $('tm-dial').getBoundingClientRect();
    let deg = Math.atan2(e.clientY - b.top - b.height / 2, e.clientX - b.left - b.width / 2) * 180 / Math.PI + 90;
    if (deg < 0) deg += 360;
    if (clk.mode === 'h') clk.h = (Math.round(deg / 30) % 12) + (clk.h >= 12 ? 12 : 0);
    else clk.m = Math.round(deg / 6) % 60;
    drawClock();
  }
  function bindClock() {
    const d = $('tm-dial'); let down = false;
    d.addEventListener('pointerdown', e => { down = true; d.setPointerCapture(e.pointerId); pickClock(e); });
    d.addEventListener('pointermove', e => { if (down) pickClock(e); });
    d.addEventListener('pointerup', () => { if (!down) return; down = false; if (clk.mode === 'h') { clk.mode = 'm'; drawClock(); } });
    d.addEventListener('pointercancel', () => { down = false; });
    $('tm-h').onclick = () => { clk.mode = 'h'; drawClock(); };
    $('tm-m').onclick = () => { clk.mode = 'm'; drawClock(); };
    $('tm-am').onclick = () => { if (clk.h >= 12) clk.h -= 12; drawClock(); };
    $('tm-pm').onclick = () => { if (clk.h < 12) clk.h += 12; drawClock(); };
  }

  function openTime(type, ev) {
    if (ev && notReady()) return;   // 새 기록은 서버 확인 전에도 받는다 (2026-10-16)
    if (!ev && followToday()) renderRecord();   // 자정 직후 1분 안(다시 그리기 전)에 눌러도 새 날 기준
    editing = ev ? { id: ev.id, type: ev.type } : { type };
    const t = editing.type;
    $('tm-title').textContent = t === 'sleep' ? '수면' : '기상';
    for (const id of ['tm-icon', 'tm-icon2']) { $(id).className = 'ev-icon ' + t; $(id).textContent = t === 'sleep' ? '🌙' : '☀️'; }
    let when;
    if (ev) when = ev.t;
    else if (recDay === S.dayStart(Date.now())) when = Date.now();
    else when = recDay + (t === 'sleep' ? (ME(who) ? 22 : 21) : (ME(who) ? 5 : 7)) * 3600 * 1000;   // 지난 날짜면 그럴듯한 시각으로 (나: 22시·5시)
    // 날짜는 고르지 않는다(2026-10-02 사용자 결정) — 새 기록은 보고 있는 날, 수정은 그 기록의 날 그대로
    const w = new Date(when); clk.h = w.getHours(); clk.m = w.getMinutes(); clk.mode = 'h';
    $('tm-date').value = S.ymd(when);
    $('tm-del').classList.toggle('hidden', !ev);
    $('time-modal').classList.toggle('sleep', t === 'sleep');
    drawClock();
    $('time-modal').classList.remove('hidden'); pushLayer('modal');
  }
  function hideModals() { for (const id of ['time-modal', 'memo-modal', 'week-modal', 'month-modal']) $(id).classList.add('hidden'); editing = null; }
  function closeModals() { hideModals(); dropLayer('modal'); }
  function closeMemos() { $('memos-screen').classList.add('hidden'); dropLayer('screen'); }

  /* ---------- 뒤로 버튼 (2026-10-02) ----------
     창·메모 화면을 열 때 방문 기록을 한 칸 쌓아, 폰의 뒤로 버튼이 앱을 끄지 않고 그 창만 닫게 한다.
     버튼(취소·저장 등)으로 닫을 때는 쌓은 칸을 되돌린다 — 이때 오는 popstate는 무시(skipPop) */
  const layers = []; let skipPop = 0;
  function pushLayer(k) { if (layers[layers.length - 1] === k) return; layers.push(k); history.pushState({ layer: layers.length }, ''); }
  function dropLayer(k) {
    const i = layers.lastIndexOf(k); if (i < 0) return;
    const n = layers.length - i; layers.length = i; skipPop++; history.go(-n);
  }
  window.addEventListener('popstate', () => {
    if (skipPop) { skipPop--; return; }
    const k = layers.pop();
    if (k === 'modal') hideModals();
    else if (k === 'screen') $('memos-screen').classList.add('hidden');
  });

  /* ---------- 못 보낸 쓰기 되살리기 (2026-10-13) ----------
     RTDB 웹 SDK 는 오프라인 쓰기를 메모리에만 두므로, 연결되기 전에 앱이 꺼지면(안드로이드가 탭을 정리하면) 조용히 사라진다.
     쓰기 전에 localStorage(dsleep_pending)에 적어 두고, 서버가 받으면(또는 규칙에 막혀 실패하면) 지운다. 다음에 열 때
     남은 것을 같은 경로·같은 값으로 다시 보낸다 — 새 기록은 push 키를 미리 받아 set 하므로 두 번 가도 한 건이고,
     수정은 transaction(없으면 중단), 삭제·메모는 원래 여러 번 해도 같다. 기록 모양(RTDB)은 그대로다 */
  const PENDING = 'dsleep_pending';
  const inflight = new Set();                              // 지금 이 화면에서 보내는 중인 것 — 되살리기와 겹치지 않게
  const loaded = { dogyeom: false, me: false };            // 수정(transaction)은 그 프로필의 기록이 한 번 온 뒤에 보낸다
  const pendingList = () => { try { return JSON.parse(LS.get(PENDING) || '[]'); } catch (e) { return []; } };
  const pendingSave = list => LS.set(PENDING, list.length ? JSON.stringify(list) : null);
  function perform(op) {
    const r = firebase.database().ref(op.path);
    if (op.kind === 'set') return r.set(op.value);
    if (op.kind === 'remove') return r.remove();
    // edit: 사람이 손댄 피요로그 기록은 수동 기록으로 승격(src 제거) — 다시 가져오기(import-piyolog.js)가 덮거나 이중 등록하지 않게.
    // transaction 으로: 수정 창을 연 사이 상대가 이 기록을 지웠으면(오프라인이었다가 연결될 때 포함) 되살리지도,
    // type 없는 조각을 만들어 규칙에 막히지도 않고 중단한다
    return r.transaction(cur => { if (!cur) return; const next = { ...cur, ...op.value }; delete next.src; return next; });
  }
  // op: { uid, path, kind: 'set'|'edit'|'remove', value? } — 연결될 때까지 멈추는 약속을 돌려준다 (실패하면 던짐)
  async function write(op) {
    op.id = op.id || 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    pendingSave(pendingList().filter(x => x.id !== op.id).concat([op]));
    inflight.add(op.id);
    try { return await perform(op); }
    finally { inflight.delete(op.id); pendingSave(pendingList().filter(x => x.id !== op.id)); }
  }
  let replaying = Promise.resolve();
  function replayPending() { replaying = replaying.then(replayNow); }   // 두 프로필이 잇달아 와도 한 번에 하나씩 (안내도 한 번)
  async function replayNow() {
    const mine = pendingList().filter(x => x.uid === uid && !inflight.has(x.id) && loaded[x.path.startsWith('my-sleep/') ? 'me' : 'dogyeom']);
    let n = 0;
    for (const op of mine) {
      if (inflight.has(op.id) || !pendingList().some(x => x.id === op.id)) continue;   // 다른 되살리기가 먼저 보냈다
      try { const r = await write(op); if ((!r || r.committed !== false) && !heldHere.has(op.id)) n++; }   // 수정인데 그사이 지워진 기록이면 조용히 건너뜀
      catch (e) { toast('저장 실패: ' + (e.code || e.message)); }
    }
    if (n) toast(`못 보낸 기록 ${n}건을 저장했습니다`);   // 방금 이 화면에서 누른 것(heldHere)은 세지 않는다 — 누를 때마다 뜨면 시끄럽다
  }

  /* ---------- 서버 확인 전에 누른 새 기록 (2026-10-16, 위 「폰 사본」 절 설명) ---------- */
  const heldHere = new Set();                              // 이 화면에서 서버 확인 전에 받아 둔 쓰기
  const DUP_WIN = 60 * 60 * 1000;
  const isEventSet = (op, w) => op.kind === 'set' && op.uid === uid && op.path.startsWith(paths[w] + '/events/');
  function holdNew(w, op) {
    op.id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    op.blind = 1;
    pendingSave(pendingList().concat([op]));
    heldHere.add(op.id);
    store[w].events = { ...store[w].events, [op.path.split('/').pop()]: op.value };
    if (w === who) { events = store[w].events; render(); }
    saveCacheSoon();
  }
  // 서버 값이 처음 왔을 때: before = 지금까지 보던 것(사본 + 받아 둔 것), server = 서버 값.
  // 받아 둔 새 기록마다, 이 기기가 못 보던 서버 기록 중 같은 종류가 1시간 안에 사이에 다른 종류 없이 있으면 같은 순간을 두 번 누른 것 → 버린다
  function settleHeld(w, before, server) {
    const held = pendingList().filter(op => op.blind && isEventSet(op, w) && !(op.path.split('/').pop() in server));
    if (!held.length) return;
    const all = Object.values(server);
    const fresh = Object.keys(server).filter(k => !(k in before)).map(k => server[k]);
    const drop = [];
    for (const op of held) {
      const mine = op.value;
      const dup = fresh.find(f => f.type === mine.type && Math.abs(f.t - mine.t) <= DUP_WIN &&
        !all.some(x => x.type !== mine.type && x.t > Math.min(f.t, mine.t) && x.t < Math.max(f.t, mine.t)));
      if (dup) { drop.push(op.id); const t = hm(dup.t); toast(`다른 기기에서 이미 ${t.ap} ${t.text} ${dup.type === 'sleep' ? '수면' : '기상'}을 기록해서, 방금 누른 것은 넣지 않았어요`); }
    }
    if (drop.length) pendingSave(pendingList().filter(x => !drop.includes(x.id)));
  }
  // 아직 서버에 안 간 새 기록은 서버 값에 없어도 보이게 (서버 확인 전에 누른 것, 지난번에 못 보낸 것)
  function withPending(w, server) {
    let out = server;
    for (const op of pendingList()) {
      if (!isEventSet(op, w) || !op.value || inflight.has(op.id)) continue;   // 보내는 중인 것은 SDK 가 보여 주고, 규칙에 막히면 SDK 가 거둔다
      const k = op.path.split('/').pop();
      if (!(k in out)) { if (out === server) out = { ...server }; out[k] = op.value; }
    }
    return out;
  }

  async function saveTime() {
    // 값이 비면 날짜 계산이 NaN이 된다 — 2026-10-02 기기 시계의 「삭제」로 화면 날짜가 NaN으로 깨진 일
    const m = /^(\d{2}):(\d{2})$/.exec($('tm-time').value || '');
    if (!m) return toast('시각을 넣어 주세요');
    const hh = +m[1], mi = +m[2];
    const base = S.parseYmd($('tm-date').value || S.ymd(recDay));
    const t = base + (hh * 60 + mi) * S.MIN;
    if (!isFinite(t)) return toast('시각을 넣어 주세요');
    if (t > Date.now() + 5 * S.MIN) return toast('앞으로의 시각은 넣을 수 없습니다');
    const rec = { type: editing.type, t, by: uid || 'demo', at: Date.now() };
    const id = editing.id;
    closeModals();
    if (DEMO) { events[id || 'd' + Date.now()] = { ...(events[id] || {}), ...rec }; render(); return; }
    if (!path) return toast('저장할 곳이 아직 준비되지 않았습니다');
    recDay = S.dayStart(t); renderRecord();   // RTDB 로컬 이벤트가 await보다 먼저 그리므로 날짜를 먼저 옮긴다
    try {
      if (id) {
        const r = await write({ uid, path: path + '/events/' + id, kind: 'edit', value: { t, by: rec.by, at: rec.at } });
        if (!r.committed) toast('이미 지워진 기록입니다');
      } else {
        // push 키만 미리 받는다 (쓰기 없음). 로그인 확인 전(ref 없음)엔 같은 모양으로 직접 만든다
        const op = { uid, path: path + '/events/' + (ref ? ref.child('events').push().key : pushKey()), kind: 'set', value: rec };
        if (!loaded[who]) holdNew(who, op);   // 서버 확인 전 — 받아 두고 서버 값이 오면 보낸다
        else await write(op);
      }
    } catch (e) { toast('저장 실패: ' + (e.code || e.message)); }
  }
  async function deleteEvent() {
    const id = editing && editing.id; if (!id) return;
    if (!confirm('이 기록을 지울까요?')) return;
    closeModals();
    if (DEMO) { delete events[id]; render(); return; }
    if (!ref) return;
    try { await write({ uid, path: path + '/events/' + id, kind: 'remove' }); } catch (e) { toast('삭제 실패: ' + (e.code || e.message)); }
  }
  async function saveMemo() {
    const text = $('memo-input').value.trim(), key = S.ymd(recDay);
    closeModals();
    if (DEMO) { memos[key] = text ? { text } : undefined; render(); return; }
    if (!ref) return;
    try {
      if (text) await write({ uid, path: path + '/memos/' + key, kind: 'set', value: { text, by: uid, at: Date.now() } });
      else await write({ uid, path: path + '/memos/' + key, kind: 'remove' });
    } catch (e) { toast('저장 실패: ' + (e.code || e.message)); }
  }

  /* ---------- 이벤트 연결 ---------- */
  function bind() {
    $('rec-prev').onclick = () => { recDay = S.addDays(recDay, -1); renderRecord(); };
    $('rec-next').onclick = () => { recDay = S.addDays(recDay, 1); renderRecord(); };
    $('rec-date').onclick = () => { const i = $('rec-date-input'); i.value = S.ymd(recDay); try { i.showPicker(); } catch (e) { i.click(); } };
    $('rec-date-input').onchange = e => { if (e.target.value) { recDay = S.parseYmd(e.target.value); renderRecord(); } };
    document.querySelectorAll('.act[data-type]').forEach(b => b.onclick = () => openTime(b.dataset.type));
    $('open-memos').onclick = openMemos;
    $('memos-back').onclick = closeMemos;
    $('mm-prev').onclick = () => shiftMonth(-1);
    $('mm-next').onclick = () => shiftMonth(1);
    $('mm-month').onclick = openMonthPicker;
    $('mo-year').onchange = fillMonths;
    $('mo-grid').onclick = e => { const b = e.target.closest('.mo'); if (b && !b.disabled) { memoMonth = +b.dataset.t; closeModals(); renderMemos(); } };
    $('mo-cancel').onclick = closeModals;
    $('mm-search').oninput = renderMemos;
    $('memos-list').onclick = e => { const c = e.target.closest('.mcard'); if (c) { recDay = S.parseYmd(c.dataset.key); closeMemos(); show('record'); renderRecord(); } };
    $('rec-events').onclick = e => { if (recentlySwiped($('page-record'))) return; const r = e.target.closest('.ev'); if (r) openTime(null, { id: r.dataset.id, ...events[r.dataset.id] }); };
    $('memo-edit').onclick = () => { if (notReady()) return; const m = memos[S.ymd(recDay)]; $('memo-input').value = m ? m.text : ''; $('memo-modal').classList.remove('hidden'); pushLayer('modal'); $('memo-input').focus(); };
    $('memo-text').onclick = () => $('memo-edit').onclick();
    $('tm-ok').onclick = saveTime; $('tm-cancel').onclick = closeModals; $('tm-del').onclick = deleteEvent;
    bindClock();
    $('memo-ok').onclick = saveMemo; $('memo-cancel').onclick = closeModals;

    $('sum-prev').onclick = () => { sumWeek = S.addDays(sumWeek, -7); renderSummary(); };
    $('sum-next').onclick = () => { sumWeek = S.addDays(sumWeek, 7); renderSummary(); };
    $('sum-range').onclick = openWeekPicker;
    // 오늘·이번 주로 바로 (2026-09-30)
    $('rec-today').onclick = () => { recDay = S.dayStart(Date.now()); renderRecord(); };
    $('sum-today').onclick = () => { sumWeek = S.weekStart(Date.now()); renderSummary(); };
    $('wk-year').onchange = fillWeeks; $('wk-month').onchange = fillWeeks;
    $('wk-list').onclick = e => { const b = e.target.closest('.wk'); if (b && !b.disabled) { sumWeek = +b.dataset.w; closeModals(); renderSummary(); } };
    $('wk-cancel').onclick = closeModals;
    $('chart').onclick = e => { if (recentlySwiped($('page-summary'))) return; const c = e.target.closest('.col'); if (c) { recDay = +c.dataset.day; show('record'); renderRecord(); } };

    document.querySelectorAll('.tab').forEach(b => b.onclick = () => show(b.dataset.page));
    bindWho($('rec-who')); bindWho($('sum-who'));
    swipe($('page-record'), () => $('rec-prev').click(), () => { if (!$('rec-next').disabled) $('rec-next').click(); });
    swipe($('page-summary'), () => $('sum-prev').click(), () => { if (!$('sum-next').disabled) $('sum-next').click(); });
    document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) closeModals(); }));
    // 자는 중 시간이 흐르도록 1분마다 다시 그림. 배경에서 돌아올 때도(타이머는 배경에서 멈춘다) 바로 다시 그린다
    // 자는 중인 기록이 없으면 날이 바뀔 때만 (4천 건 다시 계산을 매분 하지 않게, 2026-10-16)
    const tick = () => { if (document.hidden) return; const nd = followToday(); if (nd || sess.some(x => x.open)) render(); };
    setInterval(tick, 60 * 1000);
    document.addEventListener('visibilitychange', tick);
  }
  // 좌우 스와이프 (2026-09-30) — 기록은 하루, 정리표는 한 주. 왼쪽으로 밀면 다음, 오른쪽으로 밀면 이전.
  // 세로 스크롤과 헷갈리지 않게 가로 60px 이상 · 가로가 세로의 1.5배 이상일 때만
  function swipe(el, onPrev, onNext) {
    let x0 = null, y0 = 0, t0 = 0;
    el.addEventListener('touchstart', e => { if (e.touches.length !== 1) { x0 = null; return; } x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now(); }, { passive: true });
    el.addEventListener('touchend', e => {
      if (x0 === null) return;
      const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0; x0 = null;
      if (Date.now() - t0 > 800 || Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      el.dataset.swiped = String(Date.now());          // 스와이프 끝의 탭(막대 누르기 등)을 무시하려고
      (dx < 0 ? onNext : onPrev)();
    }, { passive: true });
  }
  function recentlySwiped(el) { return Date.now() - Number(el.dataset.swiped || 0) < 400; }

  function show(page) {
    document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + page));
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.page === page));
    if (page === 'summary') renderSummary();   // 숨긴 채 그린 정리표는 막대 높이를 몰라 시각 글자를 못 가렸다 — 보일 때 다시 (2026-10-03)
  }
  let rsT = 0;
  window.addEventListener('resize', () => { clearTimeout(rsT); rsT = setTimeout(() => { if (sumVisible()) renderSummary(); }, 150); });   // 회전하면 막대 높이가 바뀐다 (태블릿을 가로로 돌리면 이때 보이게 된다)

  function showApp() { $('auth-screen').classList.add('hidden'); $('app').classList.remove('hidden'); }

  /* ---------- 로그인·데이터 ---------- */
  function initFirebase() {
    firebase.initializeApp(firebaseConfig);
    const auth = firebase.auth();
    auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const setStatus = m => $('auth-status').textContent = m || '';
    const setError = m => $('auth-error').textContent = m || '';

    // 부부가계부처럼 이메일·비밀번호로 (아내 계정은 네이버 메일이라 구글 로그인이 안 된다 — 2026-10-01)
    $('auth-form').onsubmit = async ev => {
      ev.preventDefault();
      setError(''); setStatus('로그인 중…');
      try { await auth.signInWithEmailAndPassword($('auth-email').value.trim(), $('auth-pw').value); }
      catch (e) {
        setStatus('');
        const m = { 'auth/invalid-credential': '이메일 또는 비밀번호가 맞지 않습니다', 'auth/wrong-password': '비밀번호가 맞지 않습니다',
          'auth/user-not-found': '등록되지 않은 이메일입니다', 'auth/invalid-email': '이메일 형식이 아닙니다', 'auth/too-many-requests': '시도가 많아 잠시 막혔습니다. 조금 뒤에 다시 해 주세요' };
        setError('로그인 실패: ' + (m[e.code] || e.code || e.message));
      }
    };

    $('btn-google').onclick = async () => {
      setError(''); setStatus('구글 로그인 창을 여는 중…');
      try { await auth.signInWithPopup(provider); }
      catch (e) {
        if (['auth/popup-blocked', 'auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/operation-not-supported-in-this-environment'].includes(e.code)) {
          try { await auth.signInWithRedirect(provider); return; } catch (e2) { e = e2; }
        }
        setStatus(''); setError(e.code === 'auth/admin-restricted-operation' ? '이 구글 계정은 부부가계부에 없습니다. 위에서 부부가계부 이메일·비밀번호로 로그인해 주세요.' : '로그인 실패: ' + (e.code || e.message));
      }
    };

    auth.onAuthStateChanged(async user => {
      if (!user) {
        try { localStorage.removeItem('dsleep_signed_in'); } catch (e) {}
        dropCache();
        $('auth-screen').classList.remove('resuming', 'hidden'); $('app').classList.add('hidden'); setStatus(''); return;
      }
      mark('로그인');
      if (cached && cached.uid !== user.uid) { dropCache(); location.reload(); return; }   // 다른 계정의 사본이 보이고 있었다
      uid = user.uid;
      setStatus('불러오는 중…');
      try {
        // 가구 번호: 사본에 있으면 기다리지 않고 쓰고, 서버 값은 뒤에서 대조 — 바뀌었으면(가구를 옮김·빠짐) 사본을 버리고 처음부터
        const hidP = firebase.database().ref('users/' + uid + '/householdId').get().then(s => s.val());
        let hid = cached ? cached.hid : null;
        if (hid) hidP.then(v => { if (v !== hid) { dropCache(); location.reload(); } }, () => {});
        else hid = await hidP;
        if (!hid) throw new Error('no-household');
        cacheHid = hid; mark('가구');
        paths.dogyeom = 'dogyeom-sleep/' + hid; paths.me = 'my-sleep/' + uid;   // 「나」는 본인만 읽고 쓴다 (규칙)
        for (const w of ['dogyeom', 'me']) refs[w] = firebase.database().ref(paths[w]);
        applyWho();
        let first = true;
        const onErr = e => { $('auth-screen').classList.remove('resuming'); setStatus(''); setError('불러오기 실패: ' + (e.code || e.message)); auth.signOut(); };
        // 두 프로필을 다 구독해 둔다 — 전환이 즉시 되고, 내 기록은 작아서 부담이 없다
        for (const w of ['dogyeom', 'me']) {
          refs[w].child('events').on('value', s => {
            const server = s.val() || {};
            if (!loaded[w]) settleHeld(w, store[w].events, server);   // 서버 확인 전에 누른 것 중 상대가 먼저 넣은 같은 기록은 버린다
            const next = withPending(w, server);
            const same = sameEvents(store[w].events, next);           // 사본과 같으면 다시 그리지 않는다 (2026-10-16)
            store[w].events = next;
            if (w === who) { events = next; if (!same || !drawn) render(); }
            if (first && w === 'dogyeom') { first = false; showApp(); setStatus(''); mark('기록'); }
            if (!loaded[w]) { loaded[w] = true; updateStale(); replayPending(); }   // 지난번에 못 보낸 쓰기·방금 받아 둔 쓰기를 지금
            if (!same) saveCacheSoon();
          }, w === 'dogyeom' ? onErr : () => {});
          refs[w].child('memos').on('value', s => { store[w].memos = s.val() || {}; if (w === who) { memos = store[w].memos; renderRecord(); renderMemos(); } saveCacheSoon(); });
        }
        try { localStorage.setItem('dsleep_signed_in', '1'); } catch (e) {}
      } catch (e) {
        setStatus('');
        $('auth-screen').classList.remove('resuming');
        if (e.message === 'no-household') setError(`이 계정은 가구에 속해 있지 않습니다.\n부부가계부 앱에서 초대코드로 먼저 참여해 주세요.\n(${user.email})`);
        else setError(`접근 권한이 없습니다 (${user.email}): ` + (e.code || e.message));
        await auth.signOut();
      }
    });
  }

  function demo() {
    const d = S.dayStart(Date.now()), H = 3600 * 1000;
    let n = 0;
    // 「나」 예시: 22시 전후 취침·5시 전후 기상 (휴직 일정표 틀)
    for (let k = 8; k >= 1; k--) {
      const day = S.addDays(d, -k);
      store.me.events['ms' + k] = { type: 'sleep', t: day + 22 * H + (k % 2) * 25 * 60 * 1000 };
      store.me.events['mw' + k] = { type: 'wake', t: S.addDays(day, 1) + 5 * H + (k % 3) * 15 * 60 * 1000 };
    }
    store.me.memos[S.ymd(S.addDays(d, -2))] = { text: '밤에 폰을 안 봤더니 금방 잠들었다.' };
    events = store.dogyeom.events; memos = store.dogyeom.memos;   // 아래 예시는 도겸 쪽
    for (let k = 9; k >= 1; k--) {
      const day = S.addDays(d, -k);
      events['s' + n++] = { type: 'sleep', t: day + 22 * H + (k % 3) * 20 * 60 * 1000 };
      events['w' + n++] = { type: 'wake', t: S.addDays(day, 1) + 7 * H + 30 * 60 * 1000 + (k % 4) * 10 * 60 * 1000 };
      if (k % 2) { events['n' + n++] = { type: 'sleep', t: day + 13 * H }; events['m' + n++] = { type: 'wake', t: day + 14 * H + 25 * 60 * 1000 }; }
      if (k === 4) { events['r' + n++] = { type: 'sleep', t: S.addDays(day, 1) + 8 * H + 20 * 60 * 1000 }; events['q' + n++] = { type: 'wake', t: S.addDays(day, 1) + 9 * H + 45 * 60 * 1000 }; }   // 깼다 다시 잠 — 시각 글자 겹침 시험
    }
    memos[S.ymd(S.addDays(d, -1))] = { text: '처음으로 혼자 양치했다.' };
    memos[S.ymd(S.addDays(d, -5))] = { text: '태권도에서 발차기를 칭찬받았다.\n저녁에 뺄셈 게임 1000 단계 성공.' };
    memos['2026-08-15'] = { text: '할머니 댁에서 혼자 양치하고 잤다.' };
    applyWho(); render(); showApp();
  }

  bind();
  // 로그인했던 기기 + 사본이 있으면 서버를 기다리지 않고 바로 그린다 (위 「폰 사본으로 먼저 열기」)
  const cached = !DEMO && LS.get('dsleep_signed_in') === '1' ? readCache() : null;
  if (cached) {
    uid = cached.uid; cacheHid = cached.hid;
    paths.dogyeom = 'dogyeom-sleep/' + cached.hid; paths.me = 'my-sleep/' + cached.uid;   // 로그인 확인 전에도 누른 기록을 적어 둘 곳 (2026-10-16)
    for (const w of ['dogyeom', 'me']) { const c = cached[w] || {}; store[w].events = withPending(w, c.events || {}); store[w].memos = c.memos || {}; }
    applyWho(); render(); renderMemos(); showApp(); mark('사본');
  }
  if (DEMO) { demo(); const tab = new URLSearchParams(location.search).get('tab'); if (tab === 'sum') show('summary'); if (tab === 'memo') openMemos(); if (tab === 'memoq') { openMemos(); $('mm-search').value = '양치'; renderMemos(); } } else initFirebase();
})();
