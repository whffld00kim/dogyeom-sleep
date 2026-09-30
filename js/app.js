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
============================================= */
(function () {
  'use strict';
  const S = window.Sleep;
  const $ = id => document.getElementById(id);
  const DEMO = new URLSearchParams(location.search).has('demo');

  const firebaseConfig = {
    apiKey: 'AIzaSyAPXiob8XeDunXpDMsLod_TwClqg2JL260',
    authDomain: 'minsung-buboo2.firebaseapp.com',
    databaseURL: 'https://minsung-buboo2-default-rtdb.asia-southeast1.firebasedatabase.app',
    projectId: 'minsung-buboo2',
    storageBucket: 'minsung-buboo2.firebasestorage.app',
    messagingSenderId: '318424534715',
    appId: '1:318424534715:web:50a3b43ea5c5325ee5239e'
  };

  let uid = null, ref = null;
  let events = {}, memos = {};
  let sess = [];
  let recDay = S.dayStart(Date.now());
  let sumWeek = S.weekStart(Date.now());
  let editing = null;   // { id?, type }
  let memoMonth = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); })();

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

  function recompute() { sess = S.sessions(events, Date.now()); }
  function render() { recompute(); renderRecord(); renderSummary(); }

  /* ---------- 기록 ---------- */
  function renderRecord() {
    const d = new Date(recDay);
    $('rec-date').textContent = `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${WD[d.getDay()]})`;
    $('rec-age').textContent = S.age(recDay);
    $('rec-since').textContent = Math.round((recDay - new Date(2020, 4, 19).getTime()) / S.DAY);
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

    // 그날 합계
    const tot = S.fmtDur2(S.dayTotal(sess, recDay));
    $('rec-total').innerHTML = `${tot.h}<small>시간</small><br>${tot.m}<small>분</small>`;

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
      if (v.type === 'sleep' && bySleep[v.id] && bySleep[v.id].open) extra = `<span class="dur live">자는 중 ${S.fmtDur((Date.now() - v.t) / S.MIN)}</span>`;
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

    let cols = '', labels = '', sum = 0, days = 0;
    const today = S.dayStart(Date.now());
    for (let k = 0; k < 7; k++) {
      const d0 = S.addDays(w0, k), d = new Date(d0);
      const pieces = S.dayPieces(sess, d0);
      const tot = pieces.reduce((n, p) => n + p.to - p.from, 0);
      if (tot > 0 && d0 < today) { sum += tot; days++; }
      cols += `<button class="col${k % 2 ? ' alt' : ''}" data-day="${d0}">` +
        pieces.map(p => `<div class="bar${p.open ? ' open' : ''}" style="top:${p.from / 14.4}%;height:${(p.to - p.from) / 14.4}%"></div>`).join('') +
        `</button>`;
      const f = S.fmtDur2(tot);
      const cls = d.getDay() === 0 ? 'sun' : d.getDay() === 6 ? 'sat' : '';
      labels += `<div class="xl"><span class="${cls}"><i class="long">${d.getMonth() + 1}월 ${d.getDate()}일</i><i class="short">${d.getMonth() + 1}/${d.getDate()}</i></span>` +
        // 오늘까지는 기록이 없어도 0시간 0분을 적는다 (2026-09-30 사용자 요청 — 날짜 밑 총 시간이 늘 보이게)
        (d0 <= today ? `<small class="${tot ? '' : 'zero'}">${f.h}시간<br>${f.m}분</small>` : `<small>&nbsp;<br>&nbsp;</small>`) + `</div>`;
    }
    let grid = '';
    // 1시간마다 점선, 3시간마다 실선, 정오는 굵게 (피요로그와 같게, 2026-09-30)
    for (let i = 1; i < 24; i++) grid += `<div class="gl${i % 3 === 0 ? ' major' : ''}${i === 12 ? ' mid' : ''}" style="top:${i / 24 * 100}%"></div>`;
    $('chart').innerHTML = grid + cols;
    $('x-labels').innerHTML = labels;
    $('sum-meta').textContent = days ? `하루 평균 ${S.fmtDur(sum / days)} · 지난 날 ${days}일 기준` : '';
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
    $('week-modal').classList.remove('hidden');
  }
  function fillWeeks() {
    const yy = +$('wk-year').value, mm = +$('wk-month').value;
    const first = new Date(yy, mm - 1, 1).getTime(), last = new Date(yy, mm, 0).getTime();
    let w = S.weekStart(first), html = '';
    const nowW = S.weekStart(Date.now());
    while (w <= last) {
      const a = new Date(w), b = new Date(S.addDays(w, 6));
      let tot = 0, n = 0;
      for (let k = 0; k < 7; k++) { const t = S.dayTotal(sess, S.addDays(w, k)); if (t) { tot += t; n++; } }
      html += `<button class="wk${w === sumWeek ? ' on' : ''}" data-w="${w}" ${w > nowW ? 'disabled' : ''}>
        <span>${a.getMonth() + 1}/${a.getDate()} ~ ${b.getMonth() + 1}/${b.getDate()}</span>
        <small>${n ? '평균 ' + S.fmtDur(tot / n) : '기록 없음'}</small></button>`;
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
    const hl = t => { let h = esc(t); for (const w of words) h = h.replace(new RegExp(reEsc(esc(w)), 'gi'), s => `<mark>${s}</mark>`); return h; };
    $('memos-list').innerHTML = list.length ? list.map(x => {
      const d = new Date(S.parseYmd(x.key));
      return `<button class="mcard" data-key="${x.key}"><div class="md">${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${WD[d.getDay()]})<small>${S.age(d.getTime())}</small></div><div class="mt">${hl(x.text)}</div></button>`;
    }).join('') : `<div class="empty">${q ? '찾는 메모가 없습니다' : '이 달에 쓴 메모가 없습니다'}</div>`;
  }
  function openMemos() {
    const d = new Date(recDay); memoMonth = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    $('memos-screen').classList.remove('hidden'); renderMemos();
  }
  function shiftMonth(n) { const d = new Date(memoMonth); memoMonth = new Date(d.getFullYear(), d.getMonth() + n, 1).getTime(); renderMemos(); }
  function openMonthPicker() {
    const y = $('mo-year'), thisYear = new Date().getFullYear();
    y.innerHTML = ''; for (let yy = 2020; yy <= thisYear; yy++) y.innerHTML += `<option value="${yy}">${yy}년</option>`;
    y.value = new Date(memoMonth).getFullYear(); fillMonths();
    $('month-modal').classList.remove('hidden');
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
  function openTime(type, ev) {
    editing = ev ? { id: ev.id, type: ev.type } : { type };
    const t = editing.type;
    $('tm-title').textContent = t === 'sleep' ? '수면' : '기상';
    for (const id of ['tm-icon', 'tm-icon2']) { $(id).className = 'ev-icon ' + t; $(id).textContent = t === 'sleep' ? '🌙' : '☀️'; }
    let when;
    if (ev) when = ev.t;
    else if (recDay === S.dayStart(Date.now())) when = Date.now();
    else when = recDay + (t === 'sleep' ? 21 : 7) * 3600 * 1000;   // 지난 날짜면 그럴듯한 시각으로
    $('tm-time').value = hhmm(when);
    $('tm-date').value = S.ymd(when);
    $('tm-del').classList.toggle('hidden', !ev);
    $('time-modal').classList.remove('hidden');
    setTimeout(() => { try { $('tm-time').showPicker && !ev && $('tm-time').showPicker(); } catch (e) {} }, 50);
  }
  function closeModals() { for (const id of ['time-modal', 'memo-modal', 'week-modal', 'month-modal']) $(id).classList.add('hidden'); editing = null; }

  async function saveTime() {
    const [hh, mi] = ($('tm-time').value || '').split(':').map(Number);
    if (isNaN(hh)) return toast('시각을 넣어 주세요');
    const base = S.parseYmd($('tm-date').value || S.ymd(recDay));
    const t = base + (hh * 60 + mi) * S.MIN;
    if (t > Date.now() + 5 * S.MIN) return toast('앞으로의 시각은 넣을 수 없습니다');
    const rec = { type: editing.type, t, by: uid || 'demo', at: Date.now() };
    const id = editing.id;
    closeModals();
    if (DEMO) { events[id || 'd' + Date.now()] = { ...(events[id] || {}), ...rec }; render(); return; }
    recDay = S.dayStart(t); renderRecord();   // RTDB 로컬 이벤트가 await보다 먼저 그리므로 날짜를 먼저 옮긴다
    try {
      // 사람이 손댄 피요로그 기록은 수동 기록으로 승격(src 제거) — 다시 가져오기(import-piyolog.js)가 덮거나 이중 등록하지 않게
      if (id) await ref.child('events/' + id).update({ t, by: rec.by, at: rec.at, src: null });
      else await ref.child('events').push(rec);
    } catch (e) { toast('저장 실패: ' + (e.code || e.message)); }
  }
  async function deleteEvent() {
    const id = editing && editing.id; if (!id) return;
    if (!confirm('이 기록을 지울까요?')) return;
    closeModals();
    if (DEMO) { delete events[id]; render(); return; }
    try { await ref.child('events/' + id).remove(); } catch (e) { toast('삭제 실패: ' + (e.code || e.message)); }
  }
  async function saveMemo() {
    const text = $('memo-input').value.trim(), key = S.ymd(recDay);
    closeModals();
    if (DEMO) { memos[key] = text ? { text } : undefined; render(); return; }
    try {
      if (text) await ref.child('memos/' + key).set({ text, by: uid, at: Date.now() });
      else await ref.child('memos/' + key).remove();
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
    $('memos-back').onclick = () => $('memos-screen').classList.add('hidden');
    $('mm-prev').onclick = () => shiftMonth(-1);
    $('mm-next').onclick = () => shiftMonth(1);
    $('mm-month').onclick = openMonthPicker;
    $('mo-year').onchange = fillMonths;
    $('mo-grid').onclick = e => { const b = e.target.closest('.mo'); if (b && !b.disabled) { memoMonth = +b.dataset.t; closeModals(); renderMemos(); } };
    $('mo-cancel').onclick = closeModals;
    $('mm-search').oninput = renderMemos;
    $('memos-list').onclick = e => { const c = e.target.closest('.mcard'); if (c) { recDay = S.parseYmd(c.dataset.key); $('memos-screen').classList.add('hidden'); show('record'); renderRecord(); } };
    $('rec-events').onclick = e => { if (recentlySwiped($('page-record'))) return; const r = e.target.closest('.ev'); if (r) openTime(null, { id: r.dataset.id, ...events[r.dataset.id] }); };
    $('memo-edit').onclick = () => { const m = memos[S.ymd(recDay)]; $('memo-input').value = m ? m.text : ''; $('memo-modal').classList.remove('hidden'); $('memo-input').focus(); };
    $('memo-text').onclick = () => $('memo-edit').onclick();
    $('tm-ok').onclick = saveTime; $('tm-cancel').onclick = closeModals; $('tm-del').onclick = deleteEvent;
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
    swipe($('page-record'), () => $('rec-prev').click(), () => { if (!$('rec-next').disabled) $('rec-next').click(); });
    swipe($('page-summary'), () => $('sum-prev').click(), () => { if (!$('sum-next').disabled) $('sum-next').click(); });
    document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) closeModals(); }));
    // 자는 중 시간이 흐르도록 1분마다 다시 그림
    setInterval(() => { if (!document.hidden) render(); }, 60 * 1000);
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
  }

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

    $('btn-google').onclick = async () => {
      setError(''); setStatus('구글 로그인 창을 여는 중…');
      try { await auth.signInWithPopup(provider); }
      catch (e) {
        if (['auth/popup-blocked', 'auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/operation-not-supported-in-this-environment'].includes(e.code)) {
          try { await auth.signInWithRedirect(provider); return; } catch (e2) { e = e2; }
        }
        setStatus(''); setError('로그인 실패: ' + (e.code || e.message));
      }
    };

    auth.onAuthStateChanged(async user => {
      if (!user) {
        try { localStorage.removeItem('dsleep_signed_in'); } catch (e) {}
        $('auth-screen').classList.remove('resuming', 'hidden'); $('app').classList.add('hidden'); setStatus(''); return;
      }
      uid = user.uid;
      setStatus('불러오는 중…');
      try {
        const hid = (await firebase.database().ref('users/' + uid + '/householdId').get()).val();
        if (!hid) throw new Error('no-household');
        ref = firebase.database().ref('dogyeom-sleep/' + hid);
        let first = true;
        ref.child('events').on('value', s => { events = s.val() || {}; render(); if (first) { first = false; showApp(); setStatus(''); } },
          e => { $('auth-screen').classList.remove('resuming'); setStatus(''); setError('불러오기 실패: ' + (e.code || e.message)); auth.signOut(); });
        ref.child('memos').on('value', s => { memos = s.val() || {}; renderRecord(); renderMemos(); });
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
    for (let k = 9; k >= 1; k--) {
      const day = S.addDays(d, -k);
      events['s' + n++] = { type: 'sleep', t: day + 22 * H + (k % 3) * 20 * 60 * 1000 };
      events['w' + n++] = { type: 'wake', t: S.addDays(day, 1) + 7 * H + 30 * 60 * 1000 + (k % 4) * 10 * 60 * 1000 };
      if (k % 2) { events['n' + n++] = { type: 'sleep', t: day + 13 * H }; events['m' + n++] = { type: 'wake', t: day + 14 * H + 25 * 60 * 1000 }; }
    }
    memos[S.ymd(S.addDays(d, -1))] = { text: '처음으로 혼자 양치했다.' };
    memos[S.ymd(S.addDays(d, -5))] = { text: '태권도에서 발차기를 칭찬받았다.\n저녁에 뺄셈 게임 1000 단계 성공.' };
    memos['2026-08-15'] = { text: '할머니 댁에서 혼자 양치하고 잤다.' };
    render(); showApp();
  }

  bind();
  if (DEMO) { demo(); const tab = new URLSearchParams(location.search).get('tab'); if (tab === 'sum') show('summary'); if (tab === 'memo') openMemos(); if (tab === 'memoq') { openMemos(); $('mm-search').value = '양치'; renderMemos(); } } else initFirebase();
})();
