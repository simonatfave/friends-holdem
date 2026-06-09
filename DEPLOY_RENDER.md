# Render 배포 가이드 (무료)

상시 켜진 서버에 올려서 친구들과 인터넷으로 플레이하는 방법입니다.
총 10분이면 됩니다. 카드 등록 필요 없음(무료 플랜).

---

## 0. 준비물
- GitHub 계정 ([github.com](https://github.com) — 무료)
- Render 계정 ([render.com](https://render.com) — GitHub으로 가입하면 편함)
- 컴퓨터에 git 설치 (`git --version`으로 확인)

---

## 1. 코드를 GitHub에 올리기

`poker` 폴더에서 터미널을 열고 아래를 그대로 실행하세요.
(`node_modules`는 `.gitignore`에 있어서 자동 제외됩니다.)

```bash
cd poker
git init
git add .
git commit -m "Friends Hold'em"
```

그다음 GitHub에서 **새 저장소(New repository)** 를 만듭니다.
- 이름: 예) `friends-holdem`
- Public/Private 아무거나 OK
- README 등 체크 없이 빈 저장소로 생성

만들면 나오는 주소로 푸시합니다 (`<당신주소>` 부분만 교체):

```bash
git remote add origin https://github.com/<당신아이디>/friends-holdem.git
git branch -M main
git push -u origin main
```

---

## 2. Render에서 배포

### 방법 A — Blueprint (가장 쉬움, render.yaml 자동 인식)

1. [dashboard.render.com](https://dashboard.render.com) 접속
2. 우상단 **New +** → **Blueprint**
3. 방금 만든 GitHub 저장소 선택 → **Connect**
4. Render가 `render.yaml`을 읽어 설정을 자동으로 채웁니다 → **Apply / Create**
5. 빌드가 끝나면(2~4분) 상단에 `https://friends-holdem-xxxx.onrender.com` 형태의 URL이 생깁니다

### 방법 B — 수동 (Blueprint이 안 보일 때)

1. **New +** → **Web Service**
2. GitHub 저장소 연결
3. 설정 입력:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
4. **Create Web Service** → 빌드 대기

---

## 3. 테스트

1. 발급된 URL을 브라우저에서 열기
2. 닉네임 입력 → **방 만들기** → 4자리 코드 확인
3. 같은 URL을 친구들에게 공유 → 친구는 **방 참여**에 코드 입력
4. 방장이 **게임 시작** (최소 2명)

배포가 잘 됐는지 빠른 확인: `https://<당신URL>/health` 열었을 때
`{"ok":true,...}` 가 보이면 정상입니다.

---

## 무료 플랜 참고사항

- **콜드 스타트**: 15분간 아무도 접속 안 하면 서버가 잠들고, 다음 접속 때
  깨어나는 데 약 50초가 걸립니다. 첫 화면이 잠깐 안 뜨면 30~60초 기다리면 됩니다.
- **상태 보존 안 됨**: 서버가 잠들거나 재시작하면 진행 중이던 방은 사라집니다.
  (친구끼리 한 판씩 즐기는 용도로는 충분합니다.)
- 코드를 수정한 뒤 `git push` 하면 Render가 자동으로 다시 배포합니다.

---

## 자주 막히는 부분

- **빌드 실패 "node version"**: `render.yaml`의 `NODE_VERSION`이 18 이상인지 확인 (현재 20).
- **화면은 뜨는데 게임이 안 됨**: 브라우저 콘솔에 소켓 오류가 있는지 확인.
  Render는 WebSocket을 기본 지원하므로 추가 설정은 필요 없습니다.
- **친구가 "방을 찾을 수 없음"**: 같은 배포 URL을 쓰고 있는지, 코드 4자리를
  정확히(대문자) 입력했는지 확인.
