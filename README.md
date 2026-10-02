# 도겸 수면

도겸이 잔 시각·일어난 시각을 부부가 같이 기록하는 웹앱 (2026-09-30).
https://whffld00kim.github.io/dogyeom-sleep/

- **기록** 탭: 날짜별 수면·기상 사건, 그날 총 수면시간, 성장 메모. 줄을 누르면 시각 수정·삭제
- 수면·기상 버튼은 **기기 시계만** 뜨고 「설정」이 곧 저장이다 (2026-10-02). 날짜 바꾸기·삭제는 기록 줄을 눌러 들어오는 전체 창에서. 시계를 취소하면 그대로 닫힌다(취소 신호가 안 오는 브라우저에서만 빈 곳을 한 번 누른다)
- **메모** 버튼(수면·기상 옆): 성장 메모 모아 보기 — 달별 목록(화살표 · 가운데 눌러 연도·달 고르기), 검색은 전체 기간(띄어쓰기로 여러 낱말 AND), 메모를 누르면 그날 기록으로
- **정리표** 탭: 주간 막대그래프(자정 기준으로 날짜별로 나눔). 가운데 날짜를 누르면 연·월 → 주 선택
- 태블릿 가로(폭 900px 이상)에서는 두 탭이 나란히 보인다

## 데이터

Firebase `minsung-buboo2` RTDB (부부가계부·우리집 가계부와 같은 프로젝트)

```
dogyeom-sleep/{hid}/events/{id} = { type: 'sleep' | 'wake', t: epoch ms, by: uid, at, src? }
dogyeom-sleep/{hid}/memos/{YYYY-MM-DD} = { text, by, at }
```

- 잠 한 번 = 수면 사건 → 다음 기상 사건 (`js/sleep.js`의 `sessions`). 기상 없이 수면이 두 번이면 앞의 것은 버린다
- 권한은 부부가계부 가구 멤버십(`households/{hid}/members/{uid}`). 규칙 원본은 `minsung-buboo2/database.rules.json`
- 가구 id는 코드에 두지 않는다 — 로그인한 계정의 `users/{uid}/householdId`에서 읽는다
- 로그인은 **이메일·비밀번호가 기본**(부부가계부와 같은 계정), 구글 로그인은 보조. 아내 계정은 네이버 메일 + 비밀번호라 구글 로그인이 안 된다(프로젝트가 새 계정 만들기를 막아 `auth/admin-restricted-operation`) — 2026-10-01
- 사건 하나씩 쓰므로 두 사람이 동시에 눌러도 서로 덮지 않는다
- `src: 'piyolog'`은 옛 앱(피요로그) 화면 녹화에서 옮긴 기록 (±5분)

## 시험

`?demo=1` — Firebase 없이 예시 데이터로 뜬다 (저장 안 됨). `&tab=sum`이면 정리표부터.

## 배포

`git push`면 GitHub Pages가 갱신된다. `index.html`이 부르는 파일을 바꾸면 `?v=`와 `sw.js`의 `CACHE`·`OWN`을 같이 올린다.
