/* 가짜 Firebase compat SDK (시험 전용) — www.gstatic.com 의 firebase-app-compat.js 자리에 끼워 넣는다.
   앱(js/app.js)이 쓰는 표면만 흉내 낸다: initializeApp · auth() · database().ref().

   실제 RTDB 처럼 동작하게 한 부분
   - 쓰기(set/update/remove/push/transaction)는 **먼저 로컬에 반영**해 on('value') 를 바로 울리고,
     서버 반영은 다음 틱에 한다. 오프라인이면 큐에 쌓여 멈추고(약속이 풀리지 않음), goOnline() 때 순서대로 보낸다.
   - 서버 반영 때 규칙을 검사한다 (사용자 설명의 요지):
       dogyeom-sleep/$hid  읽기·쓰기 = 로그인 + households/$hid/members/$uid == true
       my-sleep/$uid       본인 uid 만
       users/$uid          본인 uid 만 읽기
       events/$id          type(sleep|wake)·t(숫자, 1.5e12 < t < 4e12) 필수
       memos/$date         키 YYYY-MM-DD, text 문자열 5000자 이하
     거부되면 로컬 반영을 되돌리고 약속을 PERMISSION_DENIED 로 깨뜨린다.
   - 상대방(다른 기기)의 쓰기는 __fake.db.serverSet(path, value) 로 흉내 낸다. 오프라인인 동안은 이 기기에 보이지 않는다.
   - get() 은 온라인일 때만 답한다 (오프라인이면 연결될 때까지 대기 — 실제 SDK 와 같음).
   - 캐시가 없을 때(오프라인 첫 구독) on('value') 는 연결될 때까지 울리지 않는다.

   설정은 window.__FAKE 로 받는다: { user: {uid,email}|null, authDelay: ms, accounts: [{email,pw,uid}], googleUser, server: {...}, online: true, deny: ['경로 접두어'] }
   시험에서 쓰는 손잡이: window.__fake = { db: { server(), local(), goOffline(), goOnline(), serverSet(), pending(), log }, auth: { setUser() } } */
(function () {
  'use strict';
  const cfg = window.__FAKE || {};
  const clone = v => v === undefined || v === null ? null : JSON.parse(JSON.stringify(v));
  const norm = p => String(p).split('/').filter(Boolean);
  const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
  // RTDB 처럼 null·빈 객체는 "없음"
  function clean(v) {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'object') return v;
    const out = {};
    for (const k of Object.keys(v)) { const c = clean(v[k]); if (c !== null) out[k] = c; }
    return Object.keys(out).length ? out : null;
  }
  function getAt(node, parts) { let c = node; for (const k of parts) { if (c === null || typeof c !== 'object') return null; c = c[k]; } return c === undefined ? null : c; }
  function setAt(node, parts, val) {
    if (!parts.length) return clean(val);
    const base = node && typeof node === 'object' ? { ...node } : {};
    const nv = setAt(base[parts[0]] === undefined ? null : base[parts[0]], parts.slice(1), val);
    if (nv === null) delete base[parts[0]]; else base[parts[0]] = nv;
    return Object.keys(base).length ? base : null;
  }
  const mkErr = (code, msg) => { const e = new Error(msg || code); e.code = code; return e; };

  /* ---------- 규칙 ---------- */
  let server = clean(cfg.server || {});
  const db = { uid: cfg.user ? cfg.user.uid : null, online: cfg.online !== false };
  const isMember = (hid, uid) => !!uid && getAt(server, ['households', hid, 'members', uid]) === true;
  const denied = parts => (cfg.deny || []).some(d => ('/' + parts.join('/') + '/').startsWith('/' + norm(d).join('/') + '/'));   // 시험용: 강제 거부 경로
  function canRead(parts) {
    if (denied(parts)) return false;
    if (parts[0] === 'users') return !!db.uid && parts[1] === db.uid;
    if (parts[0] === 'dogyeom-sleep') return isMember(parts[1], db.uid);
    if (parts[0] === 'my-sleep') return !!db.uid && parts[1] === db.uid;
    return false;
  }
  function canWrite(parts) {
    if (denied(parts)) return false;
    if (parts[0] === 'dogyeom-sleep') return isMember(parts[1], db.uid);
    if (parts[0] === 'my-sleep') return !!db.uid && parts[1] === db.uid;
    return false;
  }
  const validEvent = v => v !== null && typeof v === 'object' && (v.type === 'sleep' || v.type === 'wake') && typeof v.t === 'number' && v.t > 1500000000000 && v.t < 4000000000000;
  const validMemo = (k, v) => /^\d{4}-\d{2}-\d{2}$/.test(k) && v !== null && typeof v === 'object' && typeof v.text === 'string' && v.text.length <= 5000;
  // 쓰기 경로 아래·위에 걸린 events/$id · memos/$date 노드를 모두 검사한다
  function validate(tree, parts) {
    if (!canWrite(parts)) return 'PERMISSION_DENIED';
    const root = parts.slice(0, 2);
    const check = (kind, ids) => {
      for (const id of ids) {
        const v = getAt(tree, [...root, kind, id]);
        if (v === null) continue;                                   // 지운 것은 검사 대상이 아니다
        if (kind === 'events' && !validEvent(v)) return 'PERMISSION_DENIED';
        if (kind === 'memos' && !validMemo(id, v)) return 'PERMISSION_DENIED';
      }
      return null;
    };
    for (const kind of ['events', 'memos']) {
      if (parts.length <= 2 || (parts.length === 3 && parts[2] === kind)) {
        const all = getAt(tree, [...root, kind]);
        const r = check(kind, all && typeof all === 'object' ? Object.keys(all) : []); if (r) return r;
      } else if (parts[2] === kind) { const r = check(kind, [parts[3]]); if (r) return r; }
    }
    return null;
  }

  /* ---------- 로컬 사본·구독 ---------- */
  let seen = clone(server);           // 이 기기가 마지막으로 본 서버 상태 (오프라인이면 낡는다)
  const pending = [];                 // 서버로 못 보낸 쓰기 (순서대로)
  const listeners = [];               // { parts, cb, errCb, started, last }
  const waitingGets = [];
  const log = { sent: [], rejected: [], aborted: [] };

  function applyOp(tree, op) {
    if (op.kind === 'set') return setAt(tree, op.parts, op.value);
    if (op.kind === 'update') { let t = tree; for (const k of Object.keys(op.value)) t = setAt(t, [...op.parts, ...norm(k)], op.value[k]); return t; }
    if (op.kind === 'txn') return setAt(tree, op.parts, op.result);
    return tree;
  }
  function local() { let t = clone(seen); for (const op of pending) t = applyOp(t, op); return t; }
  function snap(v, key) { v = clone(v); return { key, val: () => clone(v), exists: () => v !== null }; }
  function fire() {
    if (db.online) seen = clone(server);
    const view = local();
    for (const l of listeners.slice()) {
      if (!l.started) {
        if (!db.online) continue;
        l.started = true;
        if (!canRead(l.parts)) { listeners.splice(listeners.indexOf(l), 1); if (l.errCb) l.errCb(mkErr('PERMISSION_DENIED', 'permission_denied at /' + l.parts.join('/'))); continue; }
        l.last = clone(getAt(view, l.parts)); l.cb(snap(l.last, l.parts[l.parts.length - 1] || null)); continue;
      }
      const v = getAt(view, l.parts);
      if (!same(v, l.last)) { l.last = clone(v); l.cb(snap(v, l.parts[l.parts.length - 1] || null)); }
    }
    if (db.online) for (const g of waitingGets.splice(0)) g();
  }
  function flush() {
    while (db.online && pending.length) {
      const op = pending.shift();
      let tree, outcome = 'ok';
      if (op.kind === 'txn') {
        const cur = getAt(server, op.parts);
        if (!same(cur, op.base)) {                     // 서버가 달라졌다 → 다시 계산 (실제 SDK 의 재시도)
          const r = op.fn(clone(cur));
          if (r === undefined) { outcome = 'aborted'; log.aborted.push({ path: op.path }); fire(); op.resolve({ committed: false, snapshot: snap(cur, op.key) }); continue; }
          op.result = clean(r);
        }
        tree = setAt(server, op.parts, op.result);
      } else tree = applyOp(server, op);
      const err = validate(tree, op.parts);
      if (err) { outcome = 'rejected'; log.rejected.push({ kind: op.kind, path: op.path, value: op.value === undefined ? op.result : op.value, err }); fire(); op.reject(mkErr(err, err + ': Permission denied')); continue; }
      server = tree; log.sent.push({ kind: op.kind, path: op.path });
      fire();
      op.resolve(op.kind === 'txn' ? { committed: true, snapshot: snap(getAt(server, op.parts), op.key) } : undefined);
    }
  }
  function enqueue(op) {
    const p = new Promise((res, rej) => { op.resolve = res; op.reject = rej; });
    pending.push(op); fire();
    setTimeout(flush, 0);
    return p;
  }

  let pushN = 0;
  function makeRef(path) {
    const parts = norm(path), key = parts.length ? parts[parts.length - 1] : null;
    const self = {
      key,
      toString: () => '/' + parts.join('/'),
      child: p => makeRef(parts.concat(norm(p)).join('/')),
      get() {
        return new Promise((res, rej) => {
          const run = () => { if (!canRead(parts)) return rej(mkErr('PERMISSION_DENIED', 'permission_denied at /' + parts.join('/'))); res(snap(getAt(server, parts), key)); };
          if (db.online) setTimeout(run, 0); else waitingGets.push(run);
        });
      },
      on(type, cb, errCb) { if (type !== 'value') throw new Error('fake: on(' + type + ')'); listeners.push({ parts, cb, errCb, started: false, last: null }); setTimeout(fire, 0); return cb; },
      off() { for (let i = listeners.length - 1; i >= 0; i--) if (listeners[i].parts.join('/') === parts.join('/')) listeners.splice(i, 1); },
      set: v => enqueue({ kind: 'set', parts, path: '/' + parts.join('/'), value: clean(v) }),
      update: v => enqueue({ kind: 'update', parts, path: '/' + parts.join('/'), value: v }),
      remove: () => enqueue({ kind: 'set', parts, path: '/' + parts.join('/'), value: null }),
      push(v) {
        const id = '-fake' + String(++pushN).padStart(4, '0');
        const r = makeRef(parts.concat(id).join('/'));
        if (v === undefined) return r;
        const p = r.set(v);
        r.then = p.then.bind(p); r.catch = p.catch.bind(p);
        return r;
      },
      transaction(fn) {
        const base = clone(getAt(local(), parts));
        const r = fn(clone(base));
        if (r === undefined) return Promise.resolve({ committed: false, snapshot: snap(base, key) });
        return enqueue({ kind: 'txn', parts, path: '/' + parts.join('/'), fn, base, result: clean(r), key });
      }
    };
    return self;
  }

  /* ---------- 인증 ---------- */
  const authCbs = []; let user = cfg.user || null;
  const mkAuthErr = code => mkErr(code, code);
  function setUser(u) { user = u; db.uid = u ? u.uid : null; for (const cb of authCbs) cb(u); }
  const auth = {
    setPersistence: () => Promise.resolve(),
    onAuthStateChanged(cb) { authCbs.push(cb); setTimeout(() => cb(user), cfg.authDelay || 0); return () => {}; },   // authDelay: 로그인 복원이 늦는 폰 흉내 (2026-10-16)
    async signInWithEmailAndPassword(email, pw) {
      const a = (cfg.accounts || []).find(x => x.email === email && x.pw === pw);
      if (!a) throw mkAuthErr('auth/invalid-credential');
      setUser({ uid: a.uid, email });
    },
    async signInWithPopup() { if (cfg.popupError) throw mkAuthErr(cfg.popupError); if (!cfg.googleUser) throw mkAuthErr('auth/admin-restricted-operation'); setUser(cfg.googleUser); },
    async signInWithRedirect() { throw mkAuthErr('auth/operation-not-supported-in-this-environment'); },
    async signOut() { setUser(null); },
    get currentUser() { return user; }
  };
  const database = { ref: p => makeRef(p || '') };
  const firebase = {
    initializeApp: () => ({}),
    auth: () => auth,
    database: () => database
  };
  firebase.auth.Auth = { Persistence: { LOCAL: 'local' } };
  firebase.auth.GoogleAuthProvider = class { setCustomParameters() {} };
  window.firebase = firebase;
  window.__fake = {
    db: {
      server: () => clone(server), local, log, pending: () => pending.length, uid: () => db.uid, online: () => db.online,
      goOffline() { db.online = false; },
      goOnline() { db.online = true; fire(); flush(); },
      // 상대방 기기의 쓰기 — 서버에 바로 반영. 이 기기는 온라인일 때만 알게 된다
      serverSet(path, value) { server = setAt(server, norm(path), value); if (db.online) fire(); }
    },
    auth: { setUser }
  };
})();
