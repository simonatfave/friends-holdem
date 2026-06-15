const socket = io();
let myId = null;
let myName = '';
let isHost = false;
let lastState = null;
let isSpectator = false;
let prevSnap = null;        // 직전 상태 스냅샷 (애니메이션/사운드 diff용)
let _dealNewHand = false;   // 이번 렌더에서 홀카드 딜링 애니 적용?
let _newCommFrom = 99;      // 이 인덱스부터의 커뮤니티 카드는 새 카드(플립 애니)

// 로그인 세션 토큰(재접속·새로고침에도 로그인 유지)
let myToken = null;
try { myToken = localStorage.getItem('dice_token') || null; } catch (e) {}
function setToken(t) {
  myToken = t || null;
  try { t ? localStorage.setItem('dice_token', t) : localStorage.removeItem('dice_token'); } catch (e) {}
}
let _everConnected = false;
// 접속/재접속 시: 토큰으로 세션 복구 → 진행 중이던 방 재합류
socket.on('connect', () => {
  if (myToken) {
    socket.emit('resume', { token: myToken }, (res) => {
      if (res && res.ok) {
        setToken(res.token || myToken);
        const onGate = $('gate') && !$('gate').classList.contains('hidden');
        if (!myProfile || onGate) { onLoggedIn(res.profile); } // 새로고침/첫 진입 → 자동 로그인
        else { myProfile = res.profile; updateMeDisplay(); }
        if (myRoomCode && myName) socket.emit('join', { code: myRoomCode, name: myName }, (r) => { if (r && r.ok) myId = r.youId; });
      } else {
        setToken(null);
        if (_everConnected) sessionLost(); // 복구 불가(첫 로드 제외) → 재로그인 안내
      }
      _everConnected = true;
    });
  } else {
    if (myRoomCode && myName) socket.emit('join', { code: myRoomCode, name: myName }, (res) => { if (res && res.ok) myId = res.youId; });
    _everConnected = true;
  }
});
// 세션이 끊겨 복구 불가 → 알림 후 로그인 화면으로
function sessionLost() {
  setToken(null); myProfile = null; myName = ''; myRoomCode = '';
  ['accountPanel', 'signupPanel', 'onlinePanel', 'settingsPanel', 'timerPopup', 'finalScreen', 'game', 'waiting', 'lobby'].forEach((id) => { try { hide(id); } catch (e) {} });
  try { show('gate'); } catch (e) {}
  toast('서버와의 연결이 끊겨 로그인 세션이 종료되었습니다. 다시 로그인해 주세요.', 'error');
}

const $ = (id) => document.getElementById(id);
const show = (id) => { const el = $(id); el.classList.remove('hidden'); triggerLogoAnim(el); };
const hide = (id) => $(id).classList.add('hidden');
// 시작 페이지 로고 등장 애니메이션 재시작(리플로우로 매번 재생)
function triggerLogoAnim(el) {
  const logo = el && el.querySelector && el.querySelector('.brand-logo');
  if (!logo) return;
  logo.classList.remove('logo-anim');
  void logo.offsetWidth;
  logo.classList.add('logo-anim');
}
// 첫 로드시 보이는 화면의 로고도 한 번 재생
setTimeout(() => {
  const v = document.querySelector('.screen:not(.hidden) .brand-logo, #gate:not(.hidden) .brand-logo');
  if (v) { v.classList.remove('logo-anim'); void v.offsetWidth; v.classList.add('logo-anim'); }
}, 40);

// 인라인 토스트(브라우저 alert 대체)
let _appToastTimer = null;
function toast(text, kind) {
  let t = document.getElementById('appToast');
  if (!t) { t = document.createElement('div'); t.id = 'appToast'; document.body.appendChild(t); }
  t.className = 'app-toast' + (kind === 'error' ? ' error' : kind === 'ok' ? ' ok' : '');
  t.textContent = text;
  void t.offsetWidth; t.classList.add('show');
  clearTimeout(_appToastTimer);
  _appToastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// 콜드 스타트(무료 서버 잠듦) 안내: 연결이 2.5초 내 안 되면 깨우는 중 안내
const _coldTimer = setTimeout(() => {
  if (!socket.connected) toast('서버를 깨우는 중입니다… 최대 1분 정도 걸릴 수 있어요');
}, 2500);
socket.on('connect', () => clearTimeout(_coldTimer));

// 모달 ESC로 닫기(게임 진행에 영향 없는 오버레이만)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  ['accountPanel', 'signupPanel', 'onlinePanel', 'settingsPanel', 'timerPopup', 'leaderboardPanel', 'logPanel', 'oppProfilePanel', 'patchPanel'].forEach((id) => {
    const el = $(id); if (el && !el.classList.contains('hidden')) hide(id);
  });
});

// 배포 버전 표시 (client.js?v=NN 에서 자동 추출)
(function showVersion() {
  const s = document.querySelector('script[src*="client.js"]');
  const m = s && s.src.match(/[?&]v=(\d+)/);
  const el = $('versionBadge');
  if (el) el.textContent = 'v.' + (m ? m[1] : '?');
})();

// ---------- 효과음 (Web Audio, 에셋 없이 생성) + 설정 ----------
function loadSound() {
  const prefRM = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const base = { master: true, turn: true, fx: true, bbUnits: false, reduceMotion: prefRM, volume: 1, theme: 'green', lefty: false };
  try { return Object.assign(base, JSON.parse(localStorage.getItem('dice_sound') || '{}')); }
  catch (e) { return base; }
}
// 연출 최소화 여부(무거운 애니메이션 가드용)
const lowFx = () => soundSettings.reduceMotion;
function applyMotionPref() { document.body.classList.toggle('reduce-motion', !!soundSettings.reduceMotion); }
// 금액 표기: BB 단위 토글에 따라 칩 수 또는 'NBB'
function fmtAmt(n) {
  if (!soundSettings.bbUnits) return String(n);
  const bb = (lastState && lastState.blinds && lastState.blinds.bb) || 0;
  if (!bb) return String(n);
  const r = Math.round((n / bb) * 10) / 10;
  return (Number.isInteger(r) ? r : r.toFixed(1)) + 'BB';
}
function saveSound() { try { localStorage.setItem('dice_sound', JSON.stringify(soundSettings)); } catch (e) {} }
const soundSettings = loadSound();
applyMotionPref();
function applyTheme() { document.body.dataset.theme = soundSettings.theme || 'green'; }
applyTheme();
// 왼손 모드: 모바일 액션 버튼 좌우 반전
function applyLefty() { document.body.classList.toggle('lefty', !!soundSettings.lefty); }
applyLefty();
let audioCtx = null;
function ac() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
// 모바일(iOS 등): 오디오는 첫 사용자 제스처에서만 잠금 해제됨 → 터치/클릭 시 컨텍스트 resume + 무음 버퍼 재생
let _audioUnlocked = false;
function unlockAudio() {
  const c = ac(); if (!c) return;
  if (c.state === 'suspended') c.resume();
  if (!_audioUnlocked) {
    try { const b = c.createBuffer(1, 1, 22050); const s = c.createBufferSource(); s.buffer = b; s.connect(c.destination); s.start(0); _audioUnlocked = true; } catch (e) {}
  }
}
['touchend', 'pointerdown', 'mousedown', 'keydown'].forEach((ev) => document.addEventListener(ev, unlockAudio, { passive: true }));
const volMul = () => (soundSettings.volume == null ? 1 : Math.max(0, Math.min(1, soundSettings.volume)));
function tone(freq, dur, type = 'sine', vol = 0.15, when = 0) {
  if (!soundSettings.master) return;
  vol *= volMul(); if (vol <= 0.0002) return;
  const c = ac(); if (!c) return;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.value = freq;
  o.connect(g); g.connect(c.destination);
  const t = c.currentTime + when;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.start(t); o.stop(t + dur + 0.02);
}
// 화이트노이즈 버스트(필터+엔벨로프) — 실제 카드/칩 질감 합성
function noise(dur, vol, when = 0, filterType = 'highpass', freq = 2000, q = 0) {
  if (!soundSettings.master) return;
  vol *= volMul(); if (vol <= 0.0002) return;
  const c = ac(); if (!c) return;
  const len = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource(); src.buffer = buf;
  const filt = c.createBiquadFilter(); filt.type = filterType; filt.frequency.value = freq; if (q) filt.Q.value = q;
  const g = c.createGain();
  const t = c.currentTime + when;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filt); filt.connect(g); g.connect(c.destination);
  src.start(t); src.stop(t + dur + 0.02);
}
// 칩 하나 부딪히는 소리(밴드패스 노이즈 + 짧은 금속 링)
function chipClink(when = 0, vol = 0.09) {
  noise(0.035, vol, when, 'bandpass', 2500 + Math.random() * 1500, 9);
  tone(2200 + Math.random() * 1000, 0.028, 'triangle', vol * 0.3, when);
}
// 카드 한 장 '슥' 슬라이드(하이패스 노이즈 스위시)
function cardFlick(when = 0, vol = 0.12) {
  noise(0.09, vol, when, 'highpass', 1100 + Math.random() * 700, 0.7);
}
// fx 카테고리(카드·칩·승리)
const sfxDeal = () => { if (!soundSettings.fx) return; cardFlick(0, 0.12); cardFlick(0.055, 0.085); };
const sfxChip = () => { if (!soundSettings.fx) return; chipClink(0, 0.09); chipClink(0.045, 0.07); };
const sfxWin = () => { if (!soundSettings.fx) return; [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.26, 'triangle', 0.13, i * 0.09)); };
const sfxAllIn = () => { if (!soundSettings.fx) return; [180, 280, 400, 560, 820].forEach((f, i) => tone(f, 0.16, 'sawtooth', 0.11, i * 0.05)); tone(90, 0.55, 'sine', 0.2, 0.04); };
const sfxBust = () => { if (!soundSettings.fx) return; [540, 410, 300, 200, 130].forEach((f, i) => tone(f, 0.2, 'triangle', 0.12, i * 0.08)); };
// 베팅 칩이 쏟아지는 '차르르' — 금액(BB 단위)이 클수록 더 길게(약 0.3~1초)
const sfxChipRiffle = (amount) => {
  if (!soundSettings.fx) return;
  const bb = (lastState && lastState.blinds && lastState.blinds.bb) || 2;
  const units = Math.max(0, amount) / bb;
  // 칩 개수↔길이: 약 0.4초(작은 베팅)~1초(큰 베팅)
  const n = Math.max(7, Math.min(18, Math.round(7 + units * 1.0)));
  for (let i = 0; i < n; i++) chipClink(i * 0.052, 0.055 + Math.random() * 0.03);
};
// 핸드 종료 팟 수집 '차르륵' — 팟 크기 3단계(작음/중간/큼)로 길이 차등
const sfxPotCollect = (amount) => {
  if (!soundSettings.fx) return;
  const bb = (lastState && lastState.blinds && lastState.blinds.bb) || 2;
  const units = Math.max(0, amount) / bb;
  const n = units < 8 ? 8 : units < 24 ? 14 : 22;
  for (let i = 0; i < n; i++) chipClink(i * 0.046, 0.06 + Math.random() * 0.03);
};
const sfxFanfare = () => {
  if (!soundSettings.fx) return;
  const seq = [523, 659, 784, 1046, 988, 1046, 1318];
  seq.forEach((f, i) => tone(f, 0.32, 'triangle', 0.15, i * 0.14));
  [262, 330, 392].forEach((f) => tone(f, 1.0, 'sine', 0.08, 0.9));
};
// 족보 등급별 효과음(쇼다운) — 강할수록 화려
const sfxRank = (tier) => {
  if (!soundSettings.fx) return;
  if (tier >= 5) { [523, 659, 784, 1046, 1318, 1568].forEach((f, i) => tone(f, 0.3, 'triangle', 0.14, i * 0.1)); tone(120, 0.6, 'sine', 0.16, 0.05); }
  else if (tier === 4) { [392, 523, 659, 880].forEach((f, i) => tone(f, 0.26, 'triangle', 0.13, i * 0.09)); }
  else if (tier === 3) { [440, 587, 740].forEach((f, i) => tone(f, 0.22, 'triangle', 0.12, i * 0.08)); }
  else { tone(523, 0.18, 'sine', 0.1); }
};
// turn 카테고리(내 차례 알림)
const sfxTurn = () => { if (soundSettings.turn) tone(680, 0.13, 'sine', 0.16); };
const sfxTick = (urgent) => { if (soundSettings.turn) tone(urgent ? 1200 : 820, 0.06, 'square', 0.1); };
const sfxEmoji = () => { if (soundSettings.fx) tone(740, 0.06, 'sine', 0.08); };

document.addEventListener('pointerdown', () => ac(), { once: true });

// 빠른 음소거(전체 소리) 토글
function syncMuteIcon() { $('muteBtn').textContent = soundSettings.master ? '🔊' : '🔇'; }
$('muteBtn').onclick = () => { soundSettings.master = !soundSettings.master; saveSound(); syncMuteIcon(); if (soundSettings.master) sfxChip(); };
syncMuteIcon();

// 설정 패널
$('settingsBtn').onclick = () => {
  $('optMaster').checked = soundSettings.master;
  $('optTurn').checked = soundSettings.turn;
  $('optFx').checked = soundSettings.fx;
  if ($('optReduceMotion')) $('optReduceMotion').checked = !!soundSettings.reduceMotion;
  if ($('optLefty')) $('optLefty').checked = !!soundSettings.lefty;
  if ($('optVolume')) $('optVolume').value = Math.round((soundSettings.volume == null ? 1 : soundSettings.volume) * 100);
  show('settingsPanel');
};
$('settingsClose').onclick = () => hide('settingsPanel');
// 테이블 색상 테마
if ($('themeSwatches')) {
  $('themeSwatches').querySelectorAll('.sw').forEach((b) => {
    b.classList.toggle('active', b.dataset.theme === (soundSettings.theme || 'green'));
    b.onclick = () => {
      soundSettings.theme = b.dataset.theme; saveSound(); applyTheme();
      $('themeSwatches').querySelectorAll('.sw').forEach((x) => x.classList.toggle('active', x === b));
    };
  });
}
$('optMaster').onchange = (e) => { soundSettings.master = e.target.checked; saveSound(); syncMuteIcon(); };
$('optTurn').onchange = (e) => { soundSettings.turn = e.target.checked; saveSound(); };
$('optFx').onchange = (e) => { soundSettings.fx = e.target.checked; saveSound(); };
if ($('optReduceMotion')) $('optReduceMotion').onchange = (e) => { soundSettings.reduceMotion = e.target.checked; saveSound(); applyMotionPref(); };
if ($('optVolume')) {
  let _volSfxT = null;
  $('optVolume').oninput = (e) => {
    soundSettings.volume = Math.max(0, Math.min(1, Number(e.target.value) / 100));
    saveSound();
    clearTimeout(_volSfxT); _volSfxT = setTimeout(() => { if (soundSettings.master) sfxChip(); }, 120); // 미리듣기
  };
}
$('optBBUnits').checked = !!soundSettings.bbUnits;
$('optBBUnits').onchange = (e) => { soundSettings.bbUnits = e.target.checked; saveSound(); if (lastState) renderGame(lastState); };
if ($('optLefty')) { $('optLefty').checked = !!soundSettings.lefty;
  $('optLefty').onchange = (e) => { soundSettings.lefty = e.target.checked; saveSound(); applyLefty(); }; }
// 자리 비움 토글(상단바 버튼) — 현재 상태는 _amSittingOut에 보관
let _amSittingOut = false;
$('sitOutBtn').onclick = () => {
  socket.emit('sitOut', { out: !_amSittingOut }, (r) => {
    if (!r || !r.ok) { if (r && r.error) toast(r.error, 'error'); return; }
    _amSittingOut = !!r.sittingOut;
    updateSitOutBtn();
    toast(_amSittingOut ? '자리를 비웠습니다 (다음 핸드 쉼)' : '복귀했습니다', 'ok');
  });
};
function updateSitOutBtn() {
  const btn = $('sitOutBtn');
  if (!btn) return;
  btn.innerHTML = _amSittingOut ? '▶<span class="tb-lbl"> 복귀하기</span>' : '💺<span class="tb-lbl"> 자리비움</span>';
  btn.classList.toggle('sitout-on', _amSittingOut);
}

// PWA 서비스워커 등록
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// ---------- 이모지 리액션 ----------
let _reactCooldownUntil = 0; // 이모지 연타 도배 방지
const EMOJIS = ['😎', '🔥', '😱', '😂', '😭', '👍', '🤔', '🎉'];
(function buildEmojiBar() {
  const bar = $('emojiBar');
  if (!bar) return;
  EMOJIS.forEach((e) => {
    const b = document.createElement('button');
    b.className = 'emoji-btn'; b.textContent = e;
    b.onclick = () => {
      if (isSpectator) return;
      const now = Date.now();
      if (now < _reactCooldownUntil) return; // 연타 도배 방지(0.8초)
      _reactCooldownUntil = now + 800;
      socket.emit('react', { emoji: e });
    };
    bar.appendChild(b);
  });
})();
// 이모지 → 감정별 좌석 반응 효과(흔들림·글로우 등)
const EMOTION_FX = {
  '😎': 'fx-cool', '🔥': 'fx-fire', '😱': 'fx-shock', '😂': 'fx-laugh',
  '😭': 'fx-cry', '👍': 'fx-good', '🤔': 'fx-think', '🎉': 'fx-party',
};
const FX_CLASSES = Object.values(EMOTION_FX);
socket.on('reaction', ({ id, emoji }) => {
  const seat = document.querySelector(`.seat[data-pid="${cssEsc(id)}"]`);
  if (!seat) return;
  const inner = seat.querySelector('.seat-inner') || seat;
  // 1) 캐릭터 위로 큰 이모지 팝업
  const el = document.createElement('div');
  el.className = 'emoji-pop';
  el.textContent = emoji;
  seat.appendChild(el);
  setTimeout(() => el.remove(), 2000);
  // 2) 좌석 감정 반응(흔들림·글로우)
  const fx = EMOTION_FX[emoji] || 'fx-good';
  inner.classList.remove(...FX_CLASSES);
  void inner.offsetWidth; // 리플로우 → 같은 이모지 연타해도 애니메이션 재시작
  inner.classList.add(fx);
  setTimeout(() => inner.classList.remove(fx), 1500);
  sfxEmoji();
  // 3) 짧은 시간에 같은 이모지가 몰리면 → 화면에 이모지 비
  noteReactionStorm(emoji);
});
// 리액션 폭주 감지 → 이모지 비
let _reactWindow = [];
let _rainUntil = 0;
function noteReactionStorm(emoji) {
  const now = Date.now();
  _reactWindow = _reactWindow.filter((r) => now - r.t < 2500);
  _reactWindow.push({ emoji, t: now });
  const cnt = _reactWindow.filter((r) => r.emoji === emoji).length;
  if (cnt >= 3 && now > _rainUntil) { _rainUntil = now + 3000; emojiRain(emoji); }
}
function emojiRain(emoji) {
  if (lowFx()) return;
  for (let i = 0; i < 18; i++) {
    const el = document.createElement('div');
    el.className = 'emoji-rain';
    el.textContent = emoji;
    el.style.left = (Math.random() * 100) + 'vw';
    el.style.fontSize = (22 + Math.random() * 26) + 'px';
    el.style.animationDuration = (1.8 + Math.random() * 1.6) + 's';
    el.style.animationDelay = (Math.random() * 0.6) + 's';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3800);
  }
}

// 카드 상수(SUIT_SYM·isRedSuit·RANK_LBL·rankLabel)는 util.js에 정의됨

// ---------- 로그인 / 회원가입 / 계정 ----------
let myProfile = null;
// 초대 링크로 들어온 경우 방 코드 파싱
let _inviteCode = null;
try {
  const r = new URL(location.href).searchParams.get('room');
  if (r) { _inviteCode = r.toUpperCase().slice(0, 8); history.replaceState({}, '', location.pathname); }
} catch (e) {}
function openLobby() {
  hide('gate'); show('lobby'); showLobbyPane('home');
  if (_inviteCode) { const c = _inviteCode; _inviteCode = null; setTimeout(() => tryInviteJoin(c), 200); }
}
// 초대 링크 자동 입장(진행 중/가득참이면 관전으로)
function tryInviteJoin(code) {
  if (!myName) return;
  socket.emit('join', { code, name: myName }, (res) => {
    if (res && res.ok) {
      myId = res.youId; enterWaiting(code);
      if (res.lateJoin) setTimeout(() => toast('진행 중인 게임에 합류했습니다. 다음 핸드부터 참여합니다.', 'ok'), 200);
    } else {
      socket.emit('spectate', { code, name: myName }, (r2) => {
        if (r2 && r2.ok) { myId = r2.youId; isSpectator = true; myRoomCode = code; hide('lobby'); }
        else toast('초대받은 방에 입장하지 못했습니다', 'error');
      });
    }
  });
}
function updateMeDisplay() {
  if (!myProfile) return;
  $('meNick').textContent = myProfile.nick;
  $('meBalance').textContent = myProfile.balance;
  paintAvatar($('meAvatar'), myProfile.avatar, myProfile.nick);
}
// 아바타 이미지를 보여주는 헬퍼 (data URL 있으면 <img>, 없으면 이모지/이니셜)
function paintAvatar(el, avatar, nick) {
  if (!el) return;
  if (avatar) {
    el.style.backgroundImage = `url("${avatar}")`;
    el.classList.add('has-img');
    el.textContent = '';
  } else {
    el.style.backgroundImage = '';
    el.classList.remove('has-img');
    el.textContent = nick ? nick.trim().charAt(0).toUpperCase() : '🙂';
  }
}
// 파일 → 정사각형 128px data URL(JPEG)로 리사이즈
function fileToAvatar(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) return reject(new Error('이미지 파일을 선택하세요'));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('파일을 읽지 못했습니다'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('이미지를 불러오지 못했습니다'));
      img.onload = () => {
        const S = 128;
        const canvas = document.createElement('canvas');
        canvas.width = S; canvas.height = S;
        const ctx = canvas.getContext('2d');
        // 가운데를 정사각형으로 크롭
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2, sy = (img.height - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, S, S);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function onLoggedIn(profile) {
  myProfile = profile;
  myName = profile.nick;
  try { localStorage.setItem('dice_lastnick', profile.nick); } catch (e) {} // 다음 로그인 시 자동 채움
  const ni = $('nameInput'); if (ni) ni.value = profile.nick;
  updateMeDisplay();
  identify();
  openLobby();
  resetIdle(); // 비활동 자동 로그아웃 타이머 시작
}

// 30분 동안 사용자 입력이 없으면 자동 로그아웃
let _idleTimer = null;
function resetIdle() {
  clearTimeout(_idleTimer);
  if (!myProfile) return;
  _idleTimer = setTimeout(() => {
    socket.emit('logout', {}, () => {});
    logoutToGate();
    toast('30분 동안 활동이 없어 자동 로그아웃되었습니다', 'error');
  }, 30 * 60 * 1000);
}
['pointerdown', 'keydown', 'touchstart'].forEach((e) => document.addEventListener(e, resetIdle, { passive: true }));

// 다른 기기에서 로그인 → 이 기기 강제 로그아웃
socket.on('forceLogout', ({ reason } = {}) => {
  logoutToGate();
  toast(reason || '다른 기기에서 로그인되어 로그아웃되었습니다', 'error');
});

// 비밀번호 표시/숨김 토글
$('authPwToggle').onclick = () => {
  const inp = $('authPw');
  inp.type = inp.type === 'password' ? 'text' : 'password';
  $('authPwToggle').style.opacity = inp.type === 'text' ? '1' : '.6';
};
// 마지막 닉네임 자동 채움
try { const ln = localStorage.getItem('dice_lastnick'); if (ln && $('authNick')) $('authNick').value = ln; } catch (e) {}
function shakeInput(id) { const el = $(id); if (!el) return; el.classList.remove('input-error'); void el.offsetWidth; el.classList.add('input-error'); }
function clearAuthError() { $('gateError').textContent = ''; ['authNick', 'authPw'].forEach((id) => $(id) && $(id).classList.remove('input-error')); }
function authFail(msg, markNick, markPw) { $('gateError').textContent = msg; if (markNick) shakeInput('authNick'); if (markPw) shakeInput('authPw'); }
function setLoginLoading(on) { ['loginBtn', 'signupBtn'].forEach((id) => { const b = $(id); if (b) { b.classList.toggle('btn-loading', on); b.disabled = on; } }); }
function doAuth(kind) {
  const nick = $('authNick').value.trim();
  const password = $('authPw').value;
  clearAuthError();
  if (!nick || !password) { return authFail('닉네임과 비밀번호를 입력하세요', !nick, !password); }
  setLoginLoading(true);
  socket.emit(kind, { nick, password }, (res) => {
    setLoginLoading(false);
    if (!res || !res.ok) { return authFail((res && res.error) || '실패했습니다', true, true); }
    setToken(res.token);
    onLoggedIn(res.profile);
  });
}
$('loginBtn').onclick = () => doAuth('login');
$('authPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAuth('login'); });
$('authNick').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('authPw').focus(); });
['authNick', 'authPw'].forEach((id) => $(id) && $(id).addEventListener('input', () => $(id).classList.remove('input-error')));
setTimeout(() => $('authNick') && $('authNick').focus(), 50);

// ---------- 회원가입 모달 ----------
let suAvatar = null; // 가입 시 선택한 아바타 data URL
function openSignup() {
  $('suNick').value = $('authNick').value.trim();
  $('suPw').value = ''; $('suPw2').value = '';
  $('suError').textContent = '';
  suAvatar = null;
  paintAvatar($('suAvatarPreview'), null, $('suNick').value);
  $('suClearAvatar').classList.add('hidden');
  show('signupPanel');
  setTimeout(() => $('suNick').focus(), 50);
}
$('signupBtn').onclick = openSignup;
$('suCancel').onclick = () => hide('signupPanel');
$('suPickAvatar').onclick = () => $('suAvatarFile').click();
$('suAvatarFile').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    suAvatar = await fileToAvatar(file);
    paintAvatar($('suAvatarPreview'), suAvatar, $('suNick').value);
    $('suClearAvatar').classList.remove('hidden');
  } catch (err) { $('suError').textContent = err.message || '이미지 처리 실패'; }
});
$('suClearAvatar').onclick = () => {
  suAvatar = null;
  paintAvatar($('suAvatarPreview'), null, $('suNick').value);
  $('suClearAvatar').classList.add('hidden');
};
$('suNick').addEventListener('input', () => { if (!suAvatar) paintAvatar($('suAvatarPreview'), null, $('suNick').value); });
function submitSignup() {
  const nick = $('suNick').value.trim();
  const pw = $('suPw').value, pw2 = $('suPw2').value;
  if (nick.length < 2) { $('suError').textContent = '닉네임은 2자 이상이어야 합니다'; return; }
  if (pw.length < 4) { $('suError').textContent = '비밀번호는 4자 이상이어야 합니다'; return; }
  if (pw !== pw2) { $('suError').textContent = '비밀번호가 일치하지 않습니다'; return; }
  $('suError').textContent = '';
  socket.emit('signup', { nick, password: pw, avatar: suAvatar }, (res) => {
    if (!res || !res.ok) { $('suError').textContent = (res && res.error) || '가입에 실패했습니다'; return; }
    setToken(res.token);
    hide('signupPanel');
    onLoggedIn(res.profile);
  });
}
$('suSubmit').onclick = submitSignup;
$('suPw2').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitSignup(); });

// 게임 종료 후 서버가 보내는 프로필 갱신
socket.on('profile', (p) => { myProfile = p; updateMeDisplay(); if (!$('accountPanel').classList.contains('hidden')) renderAccount(); });

// 리더보드
$('lbBtn').onclick = () => {
  socket.emit('leaderboard', {}, (res) => {
    if (!res || !res.ok) { toast('리더보드를 불러오지 못했습니다', 'error'); return; }
    renderLeaderboard(res.top || []);
    show('leaderboardPanel');
  });
};
$('lbClose').onclick = () => hide('leaderboardPanel');
function renderLeaderboard(top) {
  const box = $('lbList');
  if (!top.length) { box.innerHTML = '<div class="room-empty">아직 기록이 없어요</div>'; return; }
  box.innerHTML = '';
  top.forEach((u, i) => {
    const row = document.createElement('div');
    row.className = 'lb-row' + (myProfile && u.nick.toLowerCase() === myProfile.nick.toLowerCase() ? ' me' : '');
    const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1);
    const av = document.createElement('span');
    av.className = 'avatar-pic sm'; paintAvatar(av, u.avatar, u.nick);
    row.innerHTML = `<span class="lb-rank">${rank}</span>`;
    const id = document.createElement('span'); id.className = 'lb-id';
    id.appendChild(av);
    const nm = document.createElement('span'); nm.className = 'lb-nick'; nm.textContent = u.nick; id.appendChild(nm);
    row.appendChild(id);
    const w = document.createElement('span'); w.className = 'lb-wins'; w.textContent = u.wins; row.appendChild(w);
    const b = document.createElement('span'); b.className = 'lb-bal'; b.textContent = u.balance; row.appendChild(b);
    row.style.cursor = 'pointer';
    row.onclick = () => openOppProfile(u.nick);
    box.appendChild(row);
  });
}

// 내 계정 보기
$('accBtn').onclick = () => { renderAccount(); show('accountPanel'); };
$('accClose').onclick = () => hide('accountPanel');
// 계정 화면에서 프로필 이미지 변경/제거
$('accPickAvatar').onclick = () => $('accAvatarFile').click();
$('accAvatarFile').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let dataUrl;
  try { dataUrl = await fileToAvatar(file); }
  catch (err) { toast(err.message || '이미지 처리 실패', 'error'); return; }
  socket.emit('setAvatar', { avatar: dataUrl }, (res) => {
    if (!res || !res.ok) { toast((res && res.error) || '변경 실패', 'error'); return; }
    myProfile = res.profile; updateMeDisplay(); renderAccount();
  });
});
$('accClearAvatar').onclick = () => {
  socket.emit('setAvatar', { avatar: null }, (res) => {
    if (!res || !res.ok) { toast((res && res.error) || '제거 실패', 'error'); return; }
    myProfile = res.profile; updateMeDisplay(); renderAccount();
  });
};
// 비밀번호 변경
$('accChangePw').onclick = () => { $('pwChangeRow').classList.toggle('hidden'); $('pwOld').value = ''; $('pwNew').value = ''; };
$('pwSave').onclick = () => {
  const oldPassword = $('pwOld').value, newPassword = $('pwNew').value;
  if (!oldPassword || !newPassword) { toast('현재/새 비밀번호를 입력하세요', 'error'); return; }
  socket.emit('changePassword', { oldPassword, newPassword }, (r) => {
    if (!r || !r.ok) { toast((r && r.error) || '변경 실패', 'error'); return; }
    setToken(r.token); $('pwOld').value = ''; $('pwNew').value = '';
    $('pwChangeRow').classList.add('hidden');
    toast('비밀번호가 변경되었습니다', 'ok');
  });
};
// 로그인 화면으로 되돌리기(세션 종료 공통)
function logoutToGate() {
  clearTimeout(_idleTimer);
  setToken(null); myProfile = null; myName = ''; myRoomCode = '';
  document.body.classList.remove('waiting-mode', 'my-turn-glow');
  ['accountPanel', 'game', 'waiting', 'lobby', 'finalScreen', 'signupPanel', 'onlinePanel', 'settingsPanel', 'leaderboardPanel'].forEach((id) => { try { hide(id); } catch (e) {} });
  show('gate');
  $('authNick').value = ''; $('authPw').value = ''; $('gateError').textContent = '';
  setTimeout(() => $('authNick') && $('authNick').focus(), 50);
}
// 로그아웃
$('accLogout').onclick = () => {
  if (!confirm('로그아웃할까요?')) return;
  socket.emit('logout', {}, () => logoutToGate());
};
function renderAccount() {
  if (!myProfile) return;
  $('accNick').textContent = myProfile.nick;
  $('accBalance').textContent = myProfile.balance;
  paintAvatar($('accAvatar'), myProfile.avatar, myProfile.nick);
  $('accClearAvatar').classList.toggle('hidden', !myProfile.avatar);
  const st = myProfile.stats || {};
  const rows = [
    ['게임 수', st.games || 0], ['우승', st.wins || 0],
    ['승률', (st.games ? Math.round((st.wins / st.games) * 100) : 0) + '%'],
    ['핸드 승', st.handsWon || 0], ['최고 순위', st.bestPlace ? st.bestPlace + '위' : '-'],
    ['최대 팟', st.biggestPot || 0],
  ];
  $('accStats').innerHTML = rows.map(([k, v]) => `<div class="acc-stat"><span class="acc-k">${k}</span><span class="acc-v">${v}</span></div>`).join('');
  const hist = myProfile.history || [];
  $('accHistory').innerHTML = hist.length
    ? hist.map((h) => {
        const d = new Date(h.at);
        const dt = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        return `<div class="acc-hist-row ${h.win ? 'win' : ''}"><span>${dt}</span><span>${h.players}인</span><span>${h.place}위${h.win ? ' 🏆' : ''}</span></div>`;
      }).join('')
    : '<div class="room-empty">아직 게임 기록이 없어요</div>';
}

// ---------- 로비 화면 전환 (시작 / 방만들기 / 참여하기) ----------
function showLobbyPane(which) {
  $('lobbyHome').classList.toggle('hidden', which !== 'home');
  $('createPane').classList.toggle('hidden', which !== 'create');
  $('joinPane').classList.toggle('hidden', which !== 'join');
  $('lobbyError').textContent = '';
  const lob = $('lobby'); if (lob) lob.dataset.pane = which; // 모바일 화면 압축용
}
$('goCreate').onclick = () => { const n = getName(); if (!n) return; myName = n; identify(); showLobbyPane('create'); };
$('goJoin').onclick = () => { const n = getName(); if (!n) return; myName = n; identify(); showLobbyPane('join'); refreshRooms(); };
// 닉네임을 입력하면 '로그인 완료'로 집계(타이핑 멈추면 반영)
let _idTimer = null;
$('nameInput').addEventListener('input', () => {
  clearTimeout(_idTimer);
  _idTimer = setTimeout(() => { myName = $('nameInput').value.trim(); socket.emit('identify', myName); }, 500);
});
document.querySelectorAll('[data-back]').forEach((b) => (b.onclick = () => showLobbyPane('home')));

// 세그먼트 토글: 최대 인원 / 공개 설정
let createMax = 6, createSecret = false;
$('segMax').querySelectorAll('.seg-btn').forEach((b) => (b.onclick = () => {
  $('segMax').querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active'));
  b.classList.add('active'); createMax = Number(b.dataset.max);
}));
$('segVis').querySelectorAll('.seg-btn').forEach((b) => (b.onclick = () => {
  $('segVis').querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active'));
  b.classList.add('active'); createSecret = b.dataset.secret === '1';
  $('secretCodeRow').classList.toggle('hidden', !createSecret);
}));
// 시작 스택 미리보기 갱신
function updateStackPreview() {
  const sp = $('stackPreview'); if (!sp) return;
  const bb = parseInt($('startStackBB') && $('startStackBB').value, 10) || 160;
  sp.textContent = bb + 'BB';
}
if ($('startStackBB')) $('startStackBB').addEventListener('input', updateStackPreview);
// 봇 난이도 세그먼트
let createBotLevel = 'normal';
$('segBotLevel') && $('segBotLevel').querySelectorAll('.seg-btn').forEach((b) => (b.onclick = () => {
  $('segBotLevel').querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active'));
  b.classList.add('active'); createBotLevel = b.dataset.bot;
}));
// 블라인드 속도 프리셋: 선택 시 세션 구조와 액션 시간을 한 번에 세팅
let createPreset = 'normal';
function presetSessions(kind, startBB) {
  let bb = Math.max(2, parseInt(startBB, 10) || 2);
  const conf = kind === 'turbo' ? { n: 6, min: 3, mul: 2 } : kind === 'slow' ? { n: 8, min: 8, mul: 1.5 } : { n: 6, min: 5, mul: 2 };
  const out = [];
  for (let i = 0; i < conf.n; i++) { out.push({ minutes: conf.min, bb: Math.round(bb) }); bb *= conf.mul; }
  return out;
}
$('segBlindPreset') && $('segBlindPreset').querySelectorAll('.seg-btn').forEach((b) => (b.onclick = () => {
  $('segBlindPreset').querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active'));
  b.classList.add('active'); createPreset = b.dataset.preset;
  sessions = presetSessions(createPreset, $('startBB').value);
  timerSettings.actionSeconds = createPreset === 'turbo' ? 8 : createPreset === 'slow' ? 15 : 10;
}));

// 타이머 / 세션별 블라인드 설정 팝업
const timerSettings = { actionSeconds: 10 };
let sessions = [];
function defaultSessions(startBB) {
  let bb = Math.max(2, parseInt(startBB, 10) || 2);
  const out = [];
  for (let i = 0; i < 6; i++) { out.push({ minutes: 5, bb }); bb *= 2; }
  return out;
}
function renderSessions() {
  const box = $('sessList'); box.innerHTML = '';
  sessions.forEach((sx, i) => {
    const row = document.createElement('div'); row.className = 'sess-row';
    row.innerHTML =
      `<span class="sess-i">${i + 1}</span>` +
      `<input type="number" class="sess-min" min="1" max="240" value="${sx.minutes}">` +
      `<input type="number" class="sess-bb" min="2" value="${sx.bb}">` +
      `<button type="button" class="sess-del"${sessions.length <= 1 ? ' disabled' : ''}>×</button>`;
    row.querySelector('.sess-min').oninput = (e) => (sx.minutes = e.target.value);
    row.querySelector('.sess-bb').oninput = (e) => (sx.bb = e.target.value);
    row.querySelector('.sess-del').onclick = () => { if (sessions.length > 1) { sessions.splice(i, 1); renderSessions(); } };
    box.appendChild(row);
  });
}
$('openTimer').onclick = () => {
  if (!sessions.length) sessions = defaultSessions($('startBB').value);
  $('actionSeconds').value = timerSettings.actionSeconds;
  renderSessions();
  show('timerPopup');
};
$('addSess').onclick = () => {
  const last = sessions[sessions.length - 1] || { minutes: 5, bb: 2 };
  sessions.push({ minutes: parseInt(last.minutes, 10) || 5, bb: (parseInt(last.bb, 10) || 2) * 2 });
  renderSessions();
};
$('timerClose').onclick = () => { timerSettings.actionSeconds = $('actionSeconds').value; hide('timerPopup'); };

// 접속 인원 표시(봇 제외) + 클릭 시 아바타 목록 패널
function identify() { if (myName) socket.emit('identify', myName); }
let onlineUsers = [];
// 접속자 상태 배지(게임 중 / 대기 / 관전 / 자리 비움 / 로비)
function onlineStatusMeta(status) {
  switch (status) {
    case 'playing': return { label: '게임 중', cls: 'st-playing' };
    case 'waiting': return { label: '대기 중', cls: 'st-waiting' };
    case 'spectating': return { label: '관전', cls: 'st-spec' };
    case 'away': return { label: '자리 비움', cls: 'st-away' };
    default: return { label: '온라인', cls: 'st-lobby' };
  }
}
function statusBadge(status) {
  const m = onlineStatusMeta(status);
  const s = document.createElement('span');
  s.className = 'st-badge ' + m.cls;
  s.innerHTML = `<span class="st-dot"></span>${m.label}`;
  return s;
}
function renderOnlineList() {
  $('onlinePanelCount').textContent = onlineUsers.length;
  const box = $('onlineUserList');
  if (!onlineUsers.length) { box.innerHTML = '<div class="room-empty">접속 중인 사용자가 없어요</div>'; return; }
  box.innerHTML = '';
  onlineUsers.forEach((u) => {
    const row = document.createElement('div');
    row.className = 'online-user' + (myProfile && u.nick.toLowerCase() === myProfile.nick.toLowerCase() ? ' me' : '');
    const av = document.createElement('div');
    av.className = 'avatar-pic sm';
    paintAvatar(av, u.avatar, u.nick);
    const nm = document.createElement('span');
    nm.className = 'ou-nick'; nm.textContent = u.nick;
    row.appendChild(av); row.appendChild(nm);
    if (myProfile && u.nick.toLowerCase() === myProfile.nick.toLowerCase()) {
      const tag = document.createElement('span'); tag.className = 'ou-me'; tag.textContent = '나'; row.appendChild(tag);
    }
    row.appendChild(statusBadge(u.status));
    row.style.cursor = 'pointer';
    row.onclick = () => openOppProfile(u.nick);
    box.appendChild(row);
  });
}
// 호버 팝오버(데스크탑): 접속자 목록을 마우스 오버로 표시
function renderOnlinePop() {
  const pop = $('onlinePop'); if (!pop) return;
  if (!onlineUsers.length) { pop.innerHTML = '<div class="room-empty" style="padding:8px">접속 중인 사용자가 없어요</div>'; return; }
  pop.innerHTML = '';
  onlineUsers.forEach((u) => {
    const row = document.createElement('div'); row.className = 'op-row';
    const av = document.createElement('span'); av.className = 'avatar-pic sm'; paintAvatar(av, u.avatar, u.nick);
    const nm = document.createElement('span'); nm.className = 'op-nick'; nm.textContent = u.nick
      + (myProfile && u.nick.toLowerCase() === myProfile.nick.toLowerCase() ? ' (나)' : '');
    row.appendChild(av); row.appendChild(nm);
    row.appendChild(statusBadge(u.status));
    pop.appendChild(row);
  });
}
socket.on('online', (d) => {
  const count = (d && typeof d === 'object') ? d.count : d;
  onlineUsers = (d && d.users) || ((d && d.names) ? d.names.map((n) => ({ nick: n, avatar: null })) : []);
  const cEl = $('onlineCount'); if (cEl) cEl.textContent = count;
  renderOnlinePop();
  if (!$('onlinePanel').classList.contains('hidden')) renderOnlineList();
});
// 클릭은 모바일(터치)용 모달 — 데스크탑은 호버 팝오버로 표시
$('onlineLine').onclick = () => { renderOnlineList(); show('onlinePanel'); };
$('onlineClose').onclick = () => hide('onlinePanel');

// ---------- 패치 노트 (버전 배지 클릭 시 팝업) ----------
const PATCH_NOTES = [
  ['v119', ['로그인 로고 주사위가 계속 회전', '로그인 실패 시 입력칸 빨간 테두리·흔들림', '로그인 버튼 스피너', '모바일 상대 좌석 화면 안쪽으로 보정', '내 차례에 내 좌석 하단 잘림 수정', '게임 나가기 확인을 게임 UI 모달로 변경']],
  ['v118', ['관리자 페이지에 전체 데이터 초기화(계정·방 전부 삭제) 버튼 추가(DELETE 확인 필요)']],
  ['v117', ['전용 관리자 페이지(/admin) + 관리자 계정 로그인(admin/dice1234, 환경변수로 변경 권장)']],
  ['v116', ['관리자: 전체 접속 현황 탭(상태·방·최근활동), 사용자 로그(게임 기록·통계) 보기, 계정 닉네임 변경·비밀번호 초기화 추가']],
  ['v115', ['모바일: 사운드 미출력 수정(첫 터치에 오디오 잠금 해제)', '모바일: 커뮤니티 카드 탭하면 크게 보기', '핸드 승리 시 팟에서 승자에게 칩 날아가는 효과 모바일에도 표시']],
  ['v114', ['관리자 기능 추가(ADMIN_PASSWORD 인증): 방 관리(강제종료·강퇴), 계정·칩 관리(잔액수정·차단·강제로그아웃·삭제), 전체 공지 — 주소 끝에 #admin']],
  ['v113', ['모바일 내 좌석 전체 20% 확대']],
  ['v112', ['접속 상태 정확도 개선: 재접속·자동호출은 활동에서 제외, 계정 기준으로 방치 판정 → 방치 사용자는 자리비움/자동로그아웃 정상 처리', '모바일 상대 좌석 10% 확대(가독성)']],
  ['v111', ['아이폰(iOS)에서 올인 연출 시 화면이 작아지며 좌하단으로 밀리던 버그 수정(올인 링 클립)']],
  ['v110', ['모바일에서 내 카드 크기 10% 추가 확대']],
  ['v109', ['모바일 상단바 높이 고정(42px) → 대기/플레이 상단 영역 동일 → 테이블 크기·위치 완전 일치']],
  ['v108', ['접속자 목록에 상태 배지 추가(게임 중·대기 중·관전·자리 비움·온라인)', '로그인 페이지 로고: 왼쪽 주사위만 굴러 들어오는 효과(텍스트는 고정)']],
  ['v107', ['서버측 비활동 자동 로그아웃 추가 → 로그인 상태로 30분간 액션 없으면(백그라운드 탭 포함) 강제 로그아웃·접속자 목록에서 제거']],
  ['v106', ['로고 등장 효과를 미니멀하게(부드러운 페이드) 변경 → 화면 딸깍거림 제거']],
  ['v105', ['시작 페이지 DICE 로고 가운데 정렬', '로고가 통통 튀며 등장하는 애니메이션 + 주사위 점 순차 등장']],
  ['v104', ['시작하기 버튼을 테이블 정중앙에 정확히 배치(테이블 기준 절대배치)', '대기 좌석에도 카드 뒷면 표시 → 시작 전후 좌석 높이·테이블 모습 동일']],
  ['v103', ['적은 인원(헤즈업 등)에서 내 좌석이 너무 커서 하단 액션 스트립과 겹치던 문제 수정(크기·위치 조정)']],
  ['v102', ['상단바·하단바 공간 유지를 전체 화면폭에 적용 → 대기/플레이 테이블 크기·위치 고정 강화']],
  ['v101', ['대기 화면 좌석 배치를 플레이 화면과 완전히 동일하게(아래 중앙=나, 나머지는 같은 호·같은 크기)', '시작 전후 좌석 위치·크기 일치']],
  ['v100', ['시작 버튼 폭 더 축소 → 양옆 좌석과 안 겹침', '대기 좌석을 좌우로 더 벌려 사이드 여백 활용', '대기/플레이 테이블 크기·위치 완전 고정(상단바·하단바 공간 유지)']],
  ['v99', ['대기 화면 중앙은 컴팩트한 "시작하기" 버튼만(좌석 + 클릭 통과)', '나가기 버튼은 우상단 작게 이동', '방 코드·초대는 토글로만 표시']],
  ['v98', ['시작 화면 테이블을 키워 상단 여백 최소화(꽉 찬 배치)', '테이블 크기·위치를 모든 단계에서 동일하게 고정', '대기 팝업은 시작/나가기만, 방 코드·초대는 클릭 시 펼침']],
  ['v97', ['하단 버튼 크기 미세 조정 → 서로 겹치지 않게', '대기 안내(방코드)·시작/나가기를 테이블 중앙 팝업으로', '테이블 크기·위치를 대기/플레이 어느 상황에서나 고정']],
  ['v96', ['자주 쓰는 버튼(체크/콜·레이즈)을 오른쪽, 폴드는 왼쪽으로 분리', '설정에 왼손 모드(버튼 좌우 반전) 추가', '결과·몬스터팟 메시지를 커뮤니티 카드 위로, 팟 개수는 아래로']],
  ['v88~95', ['접속자 목록 호버 팝오버 · 버전 클릭 시 패치 노트', '방 만들기에 시작 스택(BB) 설정 추가', '모바일 좌석 균등 분산 · 테이블 위치/크기 조정', '현재 차례 좌석이 살짝 커지는 강조 애니메이션', '쇼다운 승리배너를 보드 아래로 이동(카드 안 가림)', '모바일 액션 버튼을 카드 양옆 오버레이로 → 턴 무관 테이블 크기 고정', '참여하기 방코드 입력칸 표시 수정']],
  ['v83~87', ['로그인 30분 자동 로그아웃 · 중복 로그인 차단', '아이폰 화면 잘림(safe-area·100dvh) 수정', '상단바 컨트롤(나가기 등) 모바일 고정', '타이머를 외곽선 카운트다운 테두리로', '칩 스택 보유 BB 반영 표시']],
  ['v78~82', ['한판 더(리매치) · 블라인드 프리셋 · 봇 난이도', '모바일 채팅/기록 하단 드로어', '방 코드 대신 방장 이름 표시', '게임 로그 스크롤백']],
  ['v71~77', ['봇 랜덤 이름 · 방 초대 링크 · 베팅 단축키(F/C/R)', '테이블 색상 테마', '빠른 채팅 · 볼륨 슬라이더 · 상대 프로필 보기', '게임 기록에 보드/쇼다운 카드 표기']],
  ['v63~70', ['프로필 이미지 · 회원가입 모달 · 리더보드 · 타임뱅크', '세션 토큰 재접속 유지 · 진행중 게임 중간참여', '방 상태 DB 영속화 · 턴 중 끊김 자동 처리']],
];
function openPatchNotes() {
  const box = $('patchList');
  box.innerHTML = PATCH_NOTES.map(([ver, items]) =>
    `<div class="patch-item"><div class="patch-ver">${esc(ver)}</div><ul>${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>`
  ).join('');
  show('patchPanel');
}
$('patchClose').onclick = () => hide('patchPanel');
(function wireVersionBadge() {
  const vb = $('versionBadge'); if (!vb) return;
  vb.style.cursor = 'pointer'; vb.title = '패치 노트 보기';
  vb.onclick = openPatchNotes;
})();

// 시스템 안내(관전 입장 등) 토스트
let _noticeTimer = null;
socket.on('notice', (text) => {
  let t = document.getElementById('noticeToast');
  if (!t) { t = document.createElement('div'); t.id = 'noticeToast'; t.className = 'recap-toast notice-toast'; document.body.appendChild(t); }
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(_noticeTimer);
  _noticeTimer = setTimeout(() => t.classList.remove('show'), 3500);
});

// ---------- 방 목록 ----------
$('refreshRooms').onclick = refreshRooms;
function refreshRooms() {
  socket.emit('listRooms', {}, (res) => {
    const box = $('roomList');
    if (!res || !res.ok) { box.innerHTML = '<div class="room-empty">불러오기 실패</div>'; return; }
    if (!res.rooms.length) { box.innerHTML = '<div class="room-empty">열려 있는 공개 방이 없습니다.</div>'; return; }
    box.innerHTML = '';
    res.rooms.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'room-row';
      const statusCls = r.finished ? '' : (r.started ? 'play' : 'wait');
      const statusTxt = r.finished ? '종료' : (r.started ? '진행중' : '대기중');
      const seatTxt = `${r.total}/${r.maxPlayers}명${r.full ? ' · 가득참' : ''}`;
      const sub = r.started ? `${seatTxt} · 핸드 #${r.handNumber}` : `${seatTxt} · 대기 중`;
      // 공개방은 코드 대신 방장 이름을 방 제목으로 표시
      row.innerHTML =
        `<span class="rinfo">` +
          `<span class="rtitle">${esc(r.hostName)}님의 방 <span class="rstat ${statusCls}">${statusTxt}</span></span>` +
          `<span class="rsub">${sub}</span>` +
        `</span>`;
      const btnWrap = document.createElement('div');
      btnWrap.style.cssText = 'display:flex;flex-direction:column;gap:6px';
      if (!r.finished) {
        if (!r.started && !r.full) {
          // 대기방: 바로 참여
          const j = document.createElement('button');
          j.className = 'join-btn'; j.textContent = '참여';
          j.onclick = () => joinRoom(r.code, false);
          btnWrap.appendChild(j);
        } else {
          // 진행 중(또는 가득 찬) 방: 먼저 관전으로 입장 → 테이블에서 [➕ 참여] 버튼으로 합류
          const sp = document.createElement('button');
          sp.className = 'spec-btn';
          sp.textContent = (r.started && !r.full) ? '입장 (관전→참여)' : '관전';
          sp.onclick = () => spectateRoom(r.code);
          btnWrap.appendChild(sp);
        }
      }
      row.appendChild(btnWrap);
      box.appendChild(row);
    });
  });
}
function joinRoom(code, started) {
  const name = getName(); if (!name) return;
  myName = name;
  socket.emit('join', { code, name }, (res) => {
    if (!res.ok) return ($('lobbyError').textContent = res.error);
    myId = res.youId;
    enterWaiting(code);
    if (res.lateJoin || started) {
      isSpectator = false;
      // 다음 핸드부터 합류된다는 안내(게임 화면은 state 수신 시 자동 표시)
      setTimeout(() => toast('진행 중인 게임에 합류했습니다. 다음 핸드부터 참여합니다.', 'ok'), 200);
    }
  });
}
function spectateRoom(code) {
  const name = $('nameInput').value.trim() || '관전자';
  myName = $('nameInput').value.trim() || myName;
  socket.emit('spectate', { code, name }, (res) => {
    if (!res.ok) return ($('lobbyError').textContent = res.error);
    myId = res.youId; isSpectator = true; myRoomCode = code;
    hide('lobby');
  });
}

function getName() {
  const n = $('nameInput').value.trim();
  if (!n) { $('lobbyError').textContent = '닉네임을 입력하세요'; return null; }
  return n;
}

$('createBtn').onclick = () => {
  const name = getName(); if (!name) return;
  const sc = ($('secretCode').value || '').replace(/\D/g, '');
  if (createSecret && sc.length !== 4) return ($('lobbyError').textContent = '비밀방 코드는 숫자 4자리로 입력하세요');
  myName = name;
  const bs = (sessions.length ? sessions : defaultSessions($('startBB').value))
    .map((sx) => ({ minutes: parseInt(sx.minutes, 10) || 5, bb: parseInt(sx.bb, 10) || 2 }));
  socket.emit('create', {
    name,
    settings: {
      maxPlayers: createMax,
      botLevel: createBotLevel,
      startStackBB: parseInt($('startStackBB').value, 10) || 160,
      startBB: $('startBB').value,
      secret: createSecret,
      password: createSecret ? sc : '',
      actionSeconds: timerSettings.actionSeconds,
      blindStructure: bs,
    },
  }, (res) => {
    if (!res.ok) return ($('lobbyError').textContent = res.error);
    myId = res.youId; isHost = true;
    enterWaiting(res.code);
  });
};

// 코드로 입장 (비밀방 / 공개방 모두)
$('joinByCode').onclick = () => {
  const name = getName(); if (!name) return;
  myName = name;
  const code = $('codeInput').value.trim().toUpperCase();
  if (!code) return ($('lobbyError').textContent = '코드를 입력하세요');
  socket.emit('join', { code, name }, (res) => {
    if (!res.ok) return ($('lobbyError').textContent = res.error);
    myId = res.youId;
    enterWaiting(code);
  });
};

let myRoomCode = '';
function enterWaiting(code) {
  myRoomCode = code;
  hide('lobby');
  // 별도 대기실 화면 대신, 게임 테이블이 '대기 모드'로 표시됨(state 수신 시 렌더)
}

$('copyCode').onclick = () => {
  navigator.clipboard?.writeText($('roomCode').textContent);
  $('copyCode').textContent = '복사됨!';
  setTimeout(() => ($('copyCode').textContent = '복사'), 1500);
};

$('startBtn').onclick = () => {
  socket.emit('start', {}, (res) => {
    if (!res.ok) toast(res.error, 'error');
  });
};

// 대기 테이블 배너의 시작/복사 버튼
$('wbStart').onclick = () => {
  socket.emit('start', {}, (res) => { if (!res.ok) toast(res.error, 'error'); });
};
// 방 코드/초대 정보: 기본 숨김, 클릭 시에만 펼침(툴팁)
if ($('wbInfoToggle')) $('wbInfoToggle').onclick = () => {
  const open = $('wbInfo').classList.toggle('hidden');
  $('wbInfoToggle').classList.toggle('open', !open);
};
$('wbCopy').onclick = () => {
  navigator.clipboard?.writeText(myRoomCode);
  $('wbCopy').textContent = '복사됨!';
  setTimeout(() => ($('wbCopy').textContent = '복사'), 1500);
};
$('wbInvite').onclick = () => {
  const url = location.origin + location.pathname + '?room=' + encodeURIComponent(myRoomCode);
  navigator.clipboard?.writeText(url);
  toast('초대 링크를 복사했습니다', 'ok');
};
// 베팅 키보드 단축키 (F=폴드, C=체크/콜, R=레이즈) — 채팅 입력 중이 아닐 때만
document.addEventListener('keydown', (e) => {
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if (!$('game') || $('game').classList.contains('hidden')) return;
  const k = e.key.toLowerCase();
  if (k === 'f') { const b = document.querySelector('.btn-fold'); if (b) { e.preventDefault(); b.click(); } }
  else if (k === 'c') { const b = document.querySelector('.btn-check') || document.querySelector('.btn-call'); if (b) { e.preventDefault(); b.click(); } }
  else if (k === 'r') { const b = document.querySelector('.btn-raise'); if (b) { e.preventDefault(); b.click(); } }
});
function resetToLobby() {
  document.body.classList.remove('waiting-mode', 'my-turn-glow', 'chat-open');
  $('waitBanner').classList.add('hidden');
  if (typeof clearTimeAlert === 'function') clearTimeAlert();
  lastState = null; prevSnap = null; myRoomCode = ''; isHost = false; isSpectator = false;
  _seatSig = ''; _commSig = ''; _seenPlayerIds = new Set(); _playersInit = false;
  _recentJoiners.clear(); _recentAllIn.clear(); _recentBust.clear();
  $('leaveBtn').classList.add('hidden'); $('sitOutBtn').classList.add('hidden');
  hide('finalScreen'); hide('game'); hide('waiting'); show('lobby'); showLobbyPane('home');
  $('versionBadge').classList.remove('hidden');
  if (myProfile) socket.emit('getProfile', {}, (r) => { if (r && r.ok) { myProfile = r.profile; updateMeDisplay(); } });
}
// 게임 UI 확인 모달(시스템 alert 대체)
function uiConfirm(message, opts = {}) {
  return new Promise((resolve) => {
    const ov = $('confirmModal'); if (!ov) { resolve(window.confirm(message)); return; }
    $('confirmMsg').textContent = message;
    const ok = $('confirmOk'), cancel = $('confirmCancel');
    ok.textContent = opts.okText || '확인'; ok.className = 'primary' + (opts.danger ? ' danger' : '');
    cancel.textContent = opts.cancelText || '취소';
    show('confirmModal');
    const done = (v) => { hide('confirmModal'); ok.onclick = cancel.onclick = ov.onclick = null; resolve(v); };
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
    ov.onclick = (e) => { if (e.target === ov) done(false); }; // 배경 클릭 = 취소
  });
}
async function doLeaveToLobby(confirmMsg) {
  if (confirmMsg && !(await uiConfirm(confirmMsg))) return;
  socket.emit('leave', {}, () => resetToLobby());
}
// 진행 중이던 핸드가 끝나 서버가 로비로 보낼 때
socket.on('leftToLobby', () => { resetToLobby(); toast('로비로 나왔습니다', 'ok'); });
// 최종 화면: '로비로 이동'(로그인 세션 유지, 새로고침 없음)
$('finalToLobby').onclick = () => doLeaveToLobby();
$('wbLeave').onclick = () => doLeaveToLobby('대기 중인 방에서 나갈까요?');
$('leaveBtn').onclick = async () => {
  if (isSpectator) { doLeaveToLobby('관전을 종료할까요?'); return; } // 관전자는 바로 로비로
  // 플레이어 나가기: 전적 기록 후, 진행 중이면 이번 핸드 끝나고 로비로(세션 유지)
  if (!(await uiConfirm('게임에서 나가시겠어요? 진행 중이면 이번 핸드가 끝난 뒤 로비로 나갑니다.', { okText: '나가기', danger: true }))) return;
  socket.emit('leaveGame', {}, (r) => {
    if (r && r.profile) { myProfile = r.profile; updateMeDisplay(); }
    if (r && r.deferred) toast('이번 핸드가 끝나면 로비로 나갑니다', 'ok');
    else resetToLobby();
  });
};
// 관전 중 게임 참여
$('specJoinBtn').onclick = () => {
  let name = myName || ($('nameInput') ? $('nameInput').value.trim() : '');
  if (!name) name = (prompt('참여할 닉네임을 입력하세요') || '').trim();
  if (!name) return;
  myName = name;
  socket.emit('join', { code: myRoomCode, name }, (res) => {
    if (!res || !res.ok) { toast(res ? res.error : '참여 실패', 'error'); return; }
    myId = res.youId; isSpectator = false; // 다음 state부터 플레이어로 렌더
  });
};

let currentBotCount = 0;
let currentHumanCount = 1;
function setBots(n) {
  n = Math.max(0, Math.min(n, 9 - currentHumanCount));
  socket.emit('setBots', { count: n }, (res) => {
    if (!res.ok) toast(res.error, 'error');
  });
}
$('botMinus').onclick = () => setBots(currentBotCount - 1);
$('botPlus').onclick = () => setBots(currentBotCount + 1);

// ---------- 상태 수신 ----------
let blindDeadline = null;
socket.on('state', (s) => {
  lastState = s;
  myId = s.youId;
  isSpectator = !!s.spectator; // 서버 기준(관전→참여 전환 시 false로 갱신)
  // 블라인드 상승 타이머 기준시각
  blindDeadline = (s.timedBlinds && s.secondsToNextLevel != null)
    ? Date.now() + s.secondsToNextLevel * 1000 : null;
  if (!s.started) { renderWaitingTable(s); return; }
  document.body.classList.remove('waiting-mode');
  $('waitBanner').classList.add('hidden');
  hide('lobby'); hide('waiting'); show('game');
  $('versionBadge').classList.add('hidden'); // 게임 중엔 숨김(시작 화면에만 표시)
  renderGame(s);
  const meNow = s.players.find((p) => p.id === myId);
  const amBusted = !!(meNow && meNow.eliminated);
  // 나가기 버튼: 게임 진행/대기 중엔 누구나(관전·탈락·플레이어) 표시(종료 화면 제외)
  $('leaveBtn').classList.toggle('hidden', !!s.finished);
  $('specJoinBtn').classList.toggle('hidden', !(isSpectator && !s.finished && s.players.length < (s.maxPlayers || 9)));
  // 자리 비움 버튼: 진행 중 게임의 활성 플레이어에게만 표시
  const canSitOut = !!(meNow && !amBusted && !isSpectator && s.started && !s.finished);
  $('sitOutBtn').classList.toggle('hidden', !canSitOut);
  if (meNow) { _amSittingOut = !!meNow.sittingOut; updateSitOutBtn(); }
});

// 타이머 틱 (액션 제한 바 + 블라인드 카운트다운)
function tickTimers() {
  const s = lastState;
  const at = $('actionTimer');
  if (!s || !s.started || s.finished) { if (at) at.classList.add('hidden'); clearTimeAlert(); return; }
  // 블라인드 상승 카운트다운
  if (s.timedBlinds && blindDeadline) {
    $('levelBadge').textContent = `레벨 ${s.level} · 블라인드↑ ${fmtTime((blindDeadline - Date.now()) / 1000)}`;
  }
  // 턴 시간 제한 — 현재 차례 캐릭터 아래 타임 바만 사용(전체폭 바는 제거)
  if (at) at.classList.add('hidden');
  if (s.actionDeadline && s.actionLimit && s.toActId) {
    const rem = s.actionDeadline - Date.now();
    const frac = Math.max(0, Math.min(1, rem / s.actionLimit));
    const rect = document.querySelector('.seat.active .seat-ring-rect');
    if (rect) {
      rect.style.strokeDashoffset = ((1 - frac) * 100).toFixed(1); // 외곽선이 시간에 따라 줄어듦
      rect.classList.toggle('warn', frac < 0.34);
    }
    // 내 차례 마지막 구간 째깍 소리 + 전체 화면 빨간 경고
    if (s.toActId === myId && rem > 0) {
      const sec = Math.ceil(rem / 1000);
      if (sec <= 5 && sec !== lastTickSec) { lastTickSec = sec; sfxTick(sec <= 2); }
      document.body.classList.toggle('time-critical', frac < 0.34);
      document.body.classList.toggle('time-critical-strong', frac < 0.15);
    } else {
      lastTickSec = null;
      clearTimeAlert();
    }
  } else {
    lastTickSec = null;
    clearTimeAlert();
  }
}
function clearTimeAlert() {
  document.body.classList.remove('time-critical', 'time-critical-strong');
}
let lastTickSec = null;
setInterval(tickTimers, 250);

socket.on('chat', ({ name, text, system }) => {
  const box = $('chatMessages');
  const div = document.createElement('div');
  if (system) {
    div.className = 'chat-sys';
    div.innerHTML = `<span class="chat-sys-dot">•</span> ${esc(text)}`;
  } else {
    div.innerHTML = `<span class="cname">${esc(name)}:</span> ${esc(text)}`;
  }
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  if (!system && !document.body.classList.contains('chat-open')) {
    const ct = $('chatToggle'); if (ct) ct.classList.add('has-unread');
  }
});

// ---------- 대기 모드: 게임 테이블을 그대로 띄우고 빈 자리에서 봇 추가 ----------
function renderWaitingTable(s) {
  document.body.classList.add('waiting-mode');
  hide('lobby'); hide('waiting'); show('game');
  $('versionBadge').classList.remove('hidden');
  $('waitBanner').classList.remove('hidden'); // 배너(방코드/시작/나가기) 표시
  isHost = !!s.isHost;
  const n = s.players.length;
  // 상단 배너: 방 코드 / 시작 버튼 / 안내
  $('wbCode').textContent = myRoomCode || '----';
  $('wbStart').classList.toggle('hidden', !isHost);
  $('wbStart').textContent = '시작하기';
  $('wbHint').textContent = !isHost
    ? '방장이 게임을 시작하기를 기다리는 중...'
    : '빈 자리의 +로 봇을 추가하거나, 친구가 방 코드로 참여할 수 있어요. 준비되면 시작하세요.';
  renderWaitingSeats(s);
}

function renderWaitingSeats(s) {
  const seatsEl = $('seats');
  seatsEl.innerHTML = '';
  const TOTAL = s.maxPlayers || 9; // 방 최대 인원만큼 좌석 표시(6 또는 9)
  const n = TOTAL;
  // 플레이 화면과 '동일한' 좌석 스케일·배치(아래 중앙=나, 나머지는 호) → 시작 전후 일치
  seatsEl.style.setProperty('--seat-scale', n <= 3 ? '1' : n <= 5 ? '0.84' : n <= 7 ? '0.72' : '0.62');
  seatsEl.style.setProperty('--me-scale', n <= 4 ? '0.88' : n <= 6 ? '0.85' : '0.8');
  const me = s.players.find((p) => p.id === myId);
  const mySeat = me ? me.chair : 0;
  const opos = othersPositions(TOTAL - 1); // 나(아래 중앙) 제외 나머지 좌석
  const meTop = (window.innerWidth <= 640) ? (n <= 4 ? 80 : 82) : 88;
  const bySeat = {};
  s.players.forEach((p) => { bySeat[p.chair] = p; });
  for (let seatIdx = 0; seatIdx < TOTAL; seatIdx++) {
    // 내 자리를 항상 화면 아래 중앙(visual 0)에 오도록 회전
    const visual = (seatIdx - mySeat + TOTAL) % TOTAL;
    const isMeSlot = visual === 0;
    const pos = isMeSlot ? { x: 50, y: meTop } : (opos[visual - 1] || { x: 50, y: 20 });
    const seat = document.createElement('div');
    seat.className = 'seat wait-seat';
    seat.style.left = pos.x + '%';
    seat.style.top = pos.y + '%';
    const p = bySeat[seatIdx];
    if (p) {
      const isMe = p.id === myId;
      if (isMe) seat.classList.add('me-seat');
      seat.innerHTML = `
        <div class="seat-inner">
          <div class="pname">${esc(p.name)} ${isMe ? '<span class="tag you">나</span>' : ''} ${p.isBot ? '<span class="tag">봇</span>' : ''}</div>
          <div class="pchips"><span class="chip-mini"></span><span class="amt">${p.chips}</span></div>
          <div class="phole"><div class="card sm back"></div><div class="card sm back"></div></div>
          ${(isHost && p.isBot) ? `<button class="bot-x" data-bot="${esc(p.id)}" title="봇 제거">×</button>` : ''}
        </div>`;
    } else {
      seat.classList.add('empty');
      seat.innerHTML = isHost
        ? `<button class="seat-add" data-seat="${seatIdx}" title="봇 추가">+</button>`
        : '<div class="seat-empty-ph">빈 자리</div>';
    }
    seatsEl.appendChild(seat);
  }
  seatsEl.querySelectorAll('.seat-add').forEach((b) => {
    b.onclick = () => socket.emit('addBot', { seat: Number(b.dataset.seat) }, (r) => { if (!r.ok) toast(r.error, 'error'); });
  });
  seatsEl.querySelectorAll('.bot-x').forEach((b) => {
    b.onclick = () => socket.emit('removeBot', { id: b.dataset.bot }, (r) => { if (!r.ok) toast(r.error, 'error'); });
  });
}

let _potChipsFrom = 0;
let _winCards = new Set();
let _winStreak = new Map(); // pid -> 연속 핸드 승리 수
let _streakHand = -1;

// ---------- 게임 렌더 ----------
function renderGame(s) {
  // 직전 상태와 비교해 애니메이션/사운드 트리거 계산
  const prev = prevSnap;
  _dealNewHand = !prev || prev.handNumber !== s.handNumber;
  _newCommFrom = (prev && prev.handNumber === s.handNumber) ? prev.commCount : 0;
  _potChipsFrom = (prev && prev.handNumber === s.handNumber) ? potChipCount(prev.pot) : 0;
  // 쇼다운: 승자의 베스트5 카드 하이라이트 키
  _winCards = new Set();
  if (s.results && s.phase === 'handComplete') {
    (s.results.reveal || []).filter((r) => r.isWinner).forEach((r) =>
      (r.best || []).forEach((c) => _winCards.add(c.r + '-' + c.s)));
  }
  // 연승 스트릭: 쇼다운마다 1회 갱신(승자 +1, 참여했는데 못 따면 0으로)
  if (s.phase === 'handComplete' && s.results && _streakHand !== s.handNumber) {
    _streakHand = s.handNumber;
    const winIds = new Set();
    (s.results.awards || []).forEach((a) => a.winners.forEach((w) => winIds.add(w.id)));
    s.players.forEach((p) => {
      const played = p.hole && !p.sittingOut && !p.eliminated;
      if (winIds.has(p.id)) _winStreak.set(p.id, (_winStreak.get(p.id) || 0) + 1);
      else if (played) _winStreak.set(p.id, 0);
    });
  }

  $('handBadge').textContent = `${isSpectator ? '👁 관전 · ' : ''}핸드 #${s.handNumber}`;
  $('blindBadge').textContent = `블라인드 ${s.blinds.sb}/${s.blinds.bb}${s.blinds.ante ? ` (앤티 ${s.blinds.ante})` : ''}`;
  $('levelBadge').textContent = s.timedBlinds
    ? `레벨 ${s.level}`
    : `레벨 ${s.level} · 다음까지 ${s.nextLevelIn + 1}핸드`;
  $('potBadge').textContent = `팟 ${fmtAmt(s.pot)}`;

  // 커뮤니티 카드: 5칸 고정(중앙 정렬), 왼쪽부터 공개. 빈 칸은 자리만 유지 → 카드 위치 안 흔들림
  const comm = $('community');
  const inHand = !!s.phase; // 핸드 진행 중이면 5칸 표시
  const commSig = s.handNumber + '|' + s.phase + '|' + s.community.map((c) => c.r + '-' + c.s).join(',');
  if (commSig !== _commSig) {
    _commSig = commSig;
    comm.innerHTML = '';
    if (inHand) {
      for (let idx = 0; idx < 5; idx++) {
        if (idx < s.community.length) {
          const el = cardEl(s.community[idx]);
          if (idx >= _newCommFrom) {
            // 리버(5번째 카드)는 한 장만 새로 열릴 때 슬로우모션으로 긴장감
            if (idx === 4 && s.community.length === 5 && _newCommFrom === 4) {
              el.classList.add('river-slow');
            } else {
              el.classList.add('flip-in');
              el.style.animationDelay = ((idx - _newCommFrom) * 0.12) + 's';
            }
          }
          comm.appendChild(el);
        } else {
          const ph = document.createElement('div');
          ph.className = 'card cc-slot'; // 빈 슬롯(자리 유지)
          comm.appendChild(ph);
        }
      }
    }
  }
  $('potDisplay').textContent = s.pot > 0 ? `팟: ${fmtAmt(s.pot)}` : '';

  _revealFlip = s.phase === 'handComplete' && _newHandPhasePrev !== 'handComplete'; // 쇼다운 첫 진입에 상대 카드 플립
  renderSeats(s);
  animateChips(s, prev ? prev.chips : null);
  renderActions(s);
  renderLog(s);
  renderWinner(s);
  // 내 패 힌트
  const hint = $('myHandHint');
  if (hint) { hint.textContent = s.myHand ? `내 패: ${s.myHand}` : ''; hint.classList.toggle('hidden', !s.myHand); }
  // 내 차례 화면 가장자리 글로우 / 몬스터 팟 / 헤드업 승률 바
  document.body.classList.toggle('my-turn-glow', s.toActId === myId && !s.finished && !!s.phase && !isSpectator);
  toggleMonsterPot(s);
  updateEquityBar(s);
  updateTimeBankBtn(s);

  handleFx(s, prev);
  _newHandPhasePrev = s.phase;
  prevSnap = {
    handNumber: s.handNumber,
    commCount: s.community.length,
    phase: s.phase,
    pot: s.pot,
    toActId: s.toActId,
    chips: chipMap(s),
    bets: betMap(s),
    lastActions: lastActionMap(s),
    level: s.level,
    buttonId: (s.players.find((p) => p.isButton) || {}).id,
    allInIds: s.players.filter((p) => p.allIn).map((p) => p.id),
    bustIds: s.players.filter((p) => p.eliminated).map((p) => p.id),
  };

  if (s.finished && s.finalResults) renderFinal(s);
  else if (!s.finished) { hide('finalScreen'); finalShown = false; } // 리매치 등 새 게임 시작 시 종료화면 정리
}
let _revealFlip = false;
let _newHandPhasePrev = null;
function chipMap(s) {
  const m = {};
  s.players.forEach((p) => (m[p.id] = p.chips));
  return m;
}
function betMap(s) { const m = {}; s.players.forEach((p) => (m[p.id] = p.bet || 0)); return m; }
function actKey(la) { return la ? la.type + (la.allIn ? '!' : '') + (la.amount || '') : ''; }
function lastActionMap(s) { const m = {}; s.players.forEach((p) => (m[p.id] = actKey(p.lastAction))); return m; }

// 팟 칩 더미: 가치별 칩으로 분해 (검정 10, 빨강 5, 녹색 1)
const POT_DENOM = [[10, '#23262d'], [5, '#e25555'], [1, '#3ec97a']];
const DENOM_CAP = 12; // 가치별 시각적 칩 상한
function potChips(pot) {
  const chips = [];
  let amt = pot;
  for (const [v, color] of POT_DENOM) {
    let c = Math.floor(amt / v);
    amt -= c * v;
    c = Math.min(c, DENOM_CAP);
    for (let i = 0; i < c; i++) chips.push(color);
  }
  return chips;
}
function potChipCount(pot) { return pot > 0 ? potChips(pot).length : 0; }
function renderPotStack(s) {
  const el = $('potStack');
  el.innerHTML = '';
  const chips = potChips(s.pot);
  if (!chips.length) return;
  let idx = 0, i = 0;
  while (i < chips.length) {
    const color = chips[i];
    const col = document.createElement('div');
    col.className = 'chip-col';
    let r = 0;
    while (i < chips.length && chips[i] === color && r < 6) {
      const chip = document.createElement('div');
      chip.className = 'chip-s';
      chip.style.bottom = (r * 5) + 'px';
      chip.style.setProperty('--cc', color);
      chip.style.zIndex = r;
      if (idx >= _potChipsFrom) {
        chip.classList.add('drop');
        chip.style.animationDelay = ((idx - _potChipsFrom) * 0.04) + 's';
      }
      col.appendChild(chip);
      r++; i++; idx++;
    }
    if (col.lastChild) col.lastChild.classList.add('top');
    col.style.height = (r * 5 + 16) + 'px';
    el.appendChild(col);
  }
}

// 보유 칩 숫자 롤링 애니메이션
function animateChips(s, prevChips) {
  if (!prevChips) return;
  s.players.forEach((p) => {
    if (p.eliminated) return;
    const from = prevChips[p.id];
    if (from === undefined || from === p.chips) return;
    const seat = document.querySelector(`.seat[data-pid="${cssEsc(p.id)}"] .pchips .amt`);
    if (seat) rollNumber(seat, from, p.chips);
  });
}
function rollNumber(el, from, to, dur = 600) {
  const start = performance.now();
  const diff = to - from;
  function step(t) {
    const k = Math.min(1, (t - start) / dur);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = fmtAmt(Math.round(from + diff * eased));
    if (k < 1) requestAnimationFrame(step);
    else el.textContent = fmtAmt(to);
  }
  requestAnimationFrame(step);
}

// 사운드 + 효과 트리거
function handleFx(s, prev) {
  if (!prev) return; // 첫 렌더는 조용히
  const newHand = s.handNumber !== prev.handNumber;
  if (newHand) {
    showShuffle();                                   // 중앙에서 카드 셔플
    setTimeout(() => { sfxDeal(); dealCardsFromDeck(s); }, 450); // 셔플 후 딜링
    if (_lastHandRecap) showRecapToast(_lastHandRecap);
  } else if (s.community.length > prev.commCount) sfxDeal();
  // 딜러 버튼 슬라이드 이동(이전 좌석 → 새 좌석)
  const newBtnId = (s.players.find((p) => p.isButton) || {}).id;
  if (newBtnId && prev.buttonId && newBtnId !== prev.buttonId) {
    setTimeout(() => slideDealerButton(prev.buttonId, newBtnId), newHand ? 500 : 0);
  }

  if (s.pot > prev.pot && !newHand) {
    bump($('potBadge'));
    bump($('potDisplay'));
    sfxChipRiffle(s.pot - prev.pot); // 베팅 금액 비례 칩 차르르
  }
  if (s.toActId === myId && prev.toActId !== myId) { sfxTurn(); notifyMyTurn(); }
  if (s.toActId !== myId) stopTitleBlink();

  // 베팅 칩이 팟으로 슬라이드 + 마지막 액션 라벨
  const pb = prev.bets || {}, pla = prev.lastActions || {};
  s.players.forEach((p) => {
    const nb = p.bet || 0;
    if (!newHand && nb > (pb[p.id] || 0)) flyBetToPot(p.id); // 베팅 증가 → 칩 슬라이드
    if (p.lastAction && actKey(p.lastAction) !== (pla[p.id] || '')) {
      showActionLabel(p.id, p.lastAction);
      if (p.lastAction.type === 'fold') muckFold(p.id); // 폴드 → 카드 던지기
    }
  });

  // 블라인드(세션) 상승 알림
  if (prev.level != null && s.level > prev.level && s.blinds) {
    showBlindToast(`⬆ 블라인드 상승 ${s.blinds.sb}/${s.blinds.bb}`);
  }

  if (s.phase === 'handComplete' && prev.phase !== 'handComplete' && s.results) {
    sfxWin();
    const potTotal = (s.results.awards || []).reduce((a, x) => a + (x.amount || 0), 0);
    setTimeout(() => sfxPotCollect(potTotal), 280); // 팟 크기 비례 차르륵(승리음과 살짝 텀)
    flyPotToWinners(s);
    // 족보 대형 팝업(실제 쇼다운, 2인 이상 공개 시) + 강한 족보엔 화면 흔들림
    const revealed = (s.results.reveal || []).length;
    const topAward = (s.results.awards || []).find((a) => a.handName) || (s.results.awards || [])[0];
    const hn = topAward && topAward.handName;
    if (hn && revealed >= 2) {
      const tier = rankTier(hn);
      setTimeout(() => { showHandRankPopup(hn, tier); sfxRank(tier); }, 360);
      if (tier >= 4) setTimeout(() => screenShake('hard'), 360);
      else if (tier >= 3) setTimeout(() => screenShake('soft'), 360);
    }
    // 큰 팟이 굳으면 가볍게 흔들림(쇼다운 없는 경우 포함)
    if (potTotal >= (s.blinds ? s.blinds.bb * 30 : 60)) screenShake('soft');
    // 직전 핸드 요약 저장 → 다음 핸드 시작 시 토스트로 표시
    _lastHandRecap = (s.results.awards || []).map((a) =>
      `${a.winners.map((w) => esc(w.name)).join(', ')} +${fmtAmt(a.amount)}${a.handName ? ' · ' + esc(a.handName) : ''}`
    ).join(' / ');
  }

  // 올인 전환 감지 → 강렬 연출
  const prevAllIn = new Set(prev.allInIds || []);
  s.players.forEach((p) => {
    if (p.allIn && !prevAllIn.has(p.id)) {
      _recentAllIn.set(p.id, Date.now() + 1500);
      showAllInFx(p.name);
      sfxAllIn();
      screenShake('soft');
    }
  });
  // 칩 소진(탈락) 전환 감지 → 탈락 연출
  const prevBust = new Set(prev.bustIds || []);
  s.players.forEach((p) => {
    if (p.eliminated && !prevBust.has(p.id)) {
      _recentBust.set(p.id, Date.now() + 2000);
      showBustToast(p.name);
      sfxBust();
    }
  });

  // 헤드업(2인) 올인 성립 → 아주 특별한 VS 배틀 연출
  if (s.phase === 'runout' && prev.phase !== 'runout') {
    const conts = s.players.filter((p) => s.equity && s.equity[p.id] != null);
    if (conts.length === 2) { showHeadsUpBattle(conts[0], conts[1]); screenShake('hard'); }
  }
}

// 올인 전체화면 연출
let _allinTimer = null;
function showAllInFx(name) {
  // 화면 전체가 아니라 '게임 테이블' 중앙에 표시
  const host = document.querySelector('.poker-table') || document.body;
  let ov = document.getElementById('allinFx');
  if (!ov) { ov = document.createElement('div'); ov.id = 'allinFx'; }
  if (ov.parentElement !== host) host.appendChild(ov);
  ov.innerHTML = `<span class="allin-ring"></span><div class="allin-text"><div class="big">ALL-IN</div><div class="who">${esc(name)}</div></div>`;
  ov.classList.remove('show'); void ov.offsetWidth; ov.classList.add('show');
  clearTimeout(_allinTimer);
  _allinTimer = setTimeout(() => ov.classList.remove('show'), 1700);
}
// 탈락 토스트
let _bustTimer = null;
function showBustToast(name) {
  let t = document.getElementById('bustToast');
  if (!t) { t = document.createElement('div'); t.id = 'bustToast'; t.className = 'recap-toast bust-toast'; document.body.appendChild(t); }
  t.innerHTML = `<span class="bust-label">💀 탈락</span> ${esc(name)} 님이 칩을 모두 잃었습니다`;
  t.classList.add('show');
  clearTimeout(_bustTimer);
  _bustTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

// 헤드업 올인 VS 배틀 전체화면 연출
let _battleTimer = null;
function showHeadsUpBattle(a, b) {
  let ov = document.getElementById('battleFx');
  if (!ov) { ov = document.createElement('div'); ov.id = 'battleFx'; document.body.appendChild(ov); }
  const side = (p, cls) => `<div class="battle-side ${cls}">
      <div class="battle-name">${esc(p.name)}</div>
      <div class="battle-cards">${(p.hole || []).filter((c) => !c.hidden).map(peekCardBig).join('')}</div>
    </div>`;
  ov.innerHTML = `${side(a, 'left')}<div class="battle-vs">VS</div>${side(b, 'right')}<div class="battle-flash"></div>`;
  ov.classList.remove('show'); void ov.offsetWidth; ov.classList.add('show');
  sfxAllIn();
  clearTimeout(_battleTimer);
  _battleTimer = setTimeout(() => ov.classList.remove('show'), 2400);
}

// 지난 핸드 요약 토스트
let _lastHandRecap = '';
let _recapTimer = null;
function showRecapToast(text) {
  let t = document.getElementById('recapToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'recapToast';
    t.className = 'recap-toast';
    document.body.appendChild(t);
  }
  t.innerHTML = `<span class="recap-label">지난 핸드</span> ${text}`;
  t.classList.add('show');
  clearTimeout(_recapTimer);
  _recapTimer = setTimeout(() => t.classList.remove('show'), 4000);
}

// 화면(테이블) 흔들림 — 올인·대형 팟의 타격감
let _shakeTimer = null;
function screenShake(level = 'soft') {
  if (lowFx()) return;
  const t = document.querySelector('.poker-table');
  if (!t) return;
  t.classList.remove('shake-soft', 'shake-hard');
  void t.offsetWidth; // 리플로우 → 연속 흔들림 재시작
  t.classList.add(level === 'hard' ? 'shake-hard' : 'shake-soft');
  clearTimeout(_shakeTimer);
  _shakeTimer = setTimeout(() => t.classList.remove('shake-soft', 'shake-hard'), level === 'hard' ? 540 : 380);
}
// 족보 등급(1~5) — 팝업 강도/색상 결정
function rankTier(name) {
  if (!name) return 0;
  if (name.includes('스트레이트 플러시')) return 5;
  if (name.includes('포카드')) return 4;
  if (name.includes('풀 하우스')) return 4;
  if (name.includes('플러시')) return 3;
  if (name.includes('스트레이트')) return 3;
  if (name.includes('투 페어')) return 2;
  if (name.includes('트리플')) return 2;
  return 1; // 원 페어 / 하이 카드
}
// 족보 대형 팝업 — 쇼다운에서 화면 중앙에 등급별 색·강도로 등장
let _rankTimer = null;
function showHandRankPopup(name, tier) {
  const host = document.querySelector('.poker-table') || document.body;
  let ov = document.getElementById('rankFx');
  if (!ov) { ov = document.createElement('div'); ov.id = 'rankFx'; }
  if (ov.parentElement !== host) host.appendChild(ov);
  ov.className = 'rank-fx tier' + tier;
  ov.innerHTML = `<div class="rank-name">${esc(name)}!</div>`;
  ov.classList.remove('show'); void ov.offsetWidth; ov.classList.add('show');
  clearTimeout(_rankTimer);
  _rankTimer = setTimeout(() => ov.classList.remove('show'), 2200);
}

// 게임 중 새 플레이어 합류 토스트
let _joinTimer = null;
function showJoinToast(name) {
  let t = document.getElementById('joinToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'joinToast';
    t.className = 'recap-toast join-toast';
    document.body.appendChild(t);
  }
  t.innerHTML = `<span class="join-label">🎉 참가</span> ${esc(name)} 님이 합류했어요!`;
  t.classList.add('show');
  clearTimeout(_joinTimer);
  _joinTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

// 내 차례 알림: 모바일 진동 + (백그라운드 탭일 때) 제목 깜빡임
let _titleBlink = null;
const TITLE_DEFAULT = '🎲 Dice — 친구들과 포커';
function notifyMyTurn() {
  if (navigator.vibrate) { try { navigator.vibrate([120, 60, 120]); } catch (e) {} }
  if (document.hidden) startTitleBlink();
}
function startTitleBlink() {
  if (_titleBlink) return;
  let on = false;
  _titleBlink = setInterval(() => {
    document.title = on ? '🔔 당신 차례입니다!' : '🎲 Dice';
    on = !on;
  }, 900);
}
function stopTitleBlink() {
  if (_titleBlink) { clearInterval(_titleBlink); _titleBlink = null; }
  document.title = TITLE_DEFAULT;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) stopTitleBlink(); });

function bump(el) {
  if (!el) return;
  el.classList.remove('bump');
  void el.offsetWidth; // 리플로우로 애니 재시작
  el.classList.add('bump');
}

// 팟이 승자 좌석으로 날아가는 칩 효과
function flyPotToWinners(s) {
  const table = document.querySelector('.poker-table');
  if (!table || !s.results) return;
  const tr = table.getBoundingClientRect();
  const cx = tr.left + tr.width / 2, cy = tr.top + tr.height / 2;
  const ids = new Set();
  s.results.awards.forEach((a) => a.winners.forEach((w) => ids.add(w.id)));
  ids.forEach((id) => {
    const seat = document.querySelector(`.seat[data-pid="${cssEsc(id)}"]`);
    if (!seat) return;
    const sr = seat.getBoundingClientRect();
    const dx = sr.left + sr.width / 2 - cx;
    const dy = sr.top + sr.height / 2 - cy;
    for (let k = 0; k < 5; k++) {
      const chip = document.createElement('div');
      chip.className = 'fly-chip';
      chip.style.left = cx + 'px';
      chip.style.top = cy + 'px';
      chip.style.transform = 'translate(-50%,-50%)';
      document.body.appendChild(chip);
      requestAnimationFrame(() => {
        chip.style.transition = `transform .6s cubic-bezier(.3,.7,.3,1) ${k * 0.06}s, opacity .6s ${k * 0.06}s`;
        chip.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.75)`;
        chip.style.opacity = '0.2';
      });
      setTimeout(() => chip.remove(), 1000 + k * 70);
    }
  });
}

// 몬스터 팟 배지: 팟이 BB의 40배 이상이면 표시
function toggleMonsterPot(s) {
  const table = document.querySelector('.poker-table');
  if (!table) return;
  let el = document.getElementById('monsterPot');
  const bb = (s.blinds && s.blinds.bb) || 2;
  const on = !!s.phase && !s.finished && s.pot >= bb * 40;
  if (on) {
    if (!el) { el = document.createElement('div'); el.id = 'monsterPot'; el.className = 'monster-pot'; el.textContent = '💰 MONSTER POT'; table.appendChild(el); }
    el.classList.add('show');
  } else if (el) { el.classList.remove('show'); }
}
// 헤드업 올인 승률 바: 런아웃 중 2인 승률을 가로 막대로 표시
function updateEquityBar(s) {
  const host = document.querySelector('.poker-table');
  let bar = document.getElementById('equityBar');
  const conts = (s.equity && s.phase === 'runout') ? s.players.filter((p) => s.equity[p.id] != null && !p.folded) : [];
  if (conts.length !== 2 || !host) { if (bar) bar.classList.remove('show'); return; }
  if (!bar) {
    bar = document.createElement('div'); bar.id = 'equityBar'; bar.className = 'equity-bar';
    bar.innerHTML = '<div class="eqb-track"><div class="eqb-fill-l"></div><div class="eqb-fill-r"></div></div><div class="eqb-labels"><span class="eqb-lbl-l"></span><span class="eqb-lbl-r"></span></div>';
    host.appendChild(bar);
  }
  const [a, b] = conts;
  const ea = s.equity[a.id] || 0, eb = s.equity[b.id] || 0;
  bar.querySelector('.eqb-fill-l').style.width = ea + '%';
  bar.querySelector('.eqb-fill-r').style.width = eb + '%';
  bar.querySelector('.eqb-lbl-l').textContent = `${a.name} ${ea}%`;
  bar.querySelector('.eqb-lbl-r').textContent = `${eb}% ${b.name}`;
  bar.classList.add('show');
}
// 좌석 앞 칩 스택(상대 비교) — 칩 많을수록 높게
let _maxChips = 1;
let _seatCount = 0;
function seatChipStackHtml(p) {
  if (p.eliminated || !(p.chips > 0)) return '';
  // 보유 칩을 BB 단위로 환산해 칩 더미로 표시(스택 약 8BB당 1칩, 최대 10칩)
  const bb = (lastState && lastState.blinds && lastState.blinds.bb) || 2;
  const discs = Math.max(1, Math.min(10, Math.round(p.chips / bb / 8)));
  let s = '';
  for (let i = 0; i < discs; i++) s += '<span class="cs-disc"></span>';
  return `<div class="chip-stack" title="${fmtAmt(p.chips)}">${s}</div>`;
}
// 현재 차례 좌석 둘레의 카운트다운 테두리(회전 대신 외곽선이 줄어듦)
function seatRingSvg() {
  return '<svg class="seat-ring" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">'
    + '<rect class="seat-ring-rect" x="2.5" y="2.5" width="95" height="95" rx="9" ry="9" pathLength="100"></rect></svg>';
}

// 핸드 시작: 중앙에서 카드를 셔플(리플)하는 모션
function showShuffle() {
  if (lowFx()) return;
  const table = document.querySelector('.poker-table');
  if (!table) return;
  const tr = table.getBoundingClientRect();
  const cx = tr.left + tr.width / 2, cy = tr.top + tr.height * 0.4;
  const wrap = document.createElement('div');
  wrap.className = 'shuffle-fx';
  wrap.style.left = cx + 'px'; wrap.style.top = cy + 'px';
  for (let i = 0; i < 6; i++) {
    const c = document.createElement('div');
    c.className = 'shuffle-card';
    c.style.setProperty('--i', i);
    wrap.appendChild(c);
  }
  document.body.appendChild(wrap);
  setTimeout(() => wrap.remove(), 950);
}
// 딜러 버튼이 이전 좌석에서 새 좌석으로 슬라이드 이동
function slideDealerButton(fromId, toId) {
  const toSeat = document.querySelector(`.seat[data-pid="${cssEsc(toId)}"]`);
  if (!toSeat) return;
  const tr = toSeat.getBoundingClientRect();
  const tx = tr.left + tr.width / 2, ty = tr.top + 10;
  let sx = tx, sy = ty;
  const fromSeat = document.querySelector(`.seat[data-pid="${cssEsc(fromId)}"]`);
  if (fromSeat) { const fr = fromSeat.getBoundingClientRect(); sx = fr.left + fr.width / 2; sy = fr.top + 10; }
  const d = document.createElement('div');
  d.className = 'dealer-fly'; d.textContent = 'D';
  d.style.left = sx + 'px'; d.style.top = sy + 'px';
  d.style.transform = 'translate(-50%,-50%)';
  document.body.appendChild(d);
  requestAnimationFrame(() => {
    d.style.transition = 'transform .5s cubic-bezier(.45,.05,.25,1)';
    d.style.transform = `translate(calc(-50% + ${tx - sx}px), calc(-50% + ${ty - sy}px))`;
  });
  setTimeout(() => d.remove(), 560);
}
// 핸드 시작: 중앙 덱에서 각 좌석으로 카드가 날아가 꽂히는 딜링 모션
function dealCardsFromDeck(s) {
  if (lowFx()) return;
  const table = document.querySelector('.poker-table');
  if (!table) return;
  const tr = table.getBoundingClientRect();
  const cx = tr.left + tr.width / 2, cy = tr.top + tr.height * 0.4; // 덱 위치(중앙 살짝 위)
  const players = s.players.filter((p) => !p.eliminated && !p.folded && !p.sittingOut);
  if (!players.length) return;
  let k = 0;
  for (let round = 0; round < 2; round++) {
    players.forEach((p) => {
      const seat = document.querySelector(`.seat[data-pid="${cssEsc(p.id)}"]`);
      if (!seat) return;
      const sr = seat.getBoundingClientRect();
      const dx = sr.left + sr.width / 2 - cx, dy = sr.top + sr.height / 2 - cy;
      const card = document.createElement('div');
      card.className = 'deal-card-fly';
      card.style.left = cx + 'px'; card.style.top = cy + 'px';
      card.style.transform = 'translate(-50%,-50%) scale(.5)';
      document.body.appendChild(card);
      const delay = k * 0.05;
      requestAnimationFrame(() => {
        card.style.transition = `transform .4s cubic-bezier(.3,.7,.3,1) ${delay}s, opacity .18s ${delay + 0.3}s`;
        card.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.72) rotate(${(Math.random() * 24 - 12) | 0}deg)`;
        card.style.opacity = '0';
      });
      setTimeout(() => card.remove(), (delay + 0.65) * 1000);
      k++;
    });
  }
}
// 폴드: 카드가 빙글 돌며 중앙으로 던져져(머크) 사라짐
function muckFold(id) {
  if (lowFx() || id === myId) return; // 내 카드는 이미 보임
  const table = document.querySelector('.poker-table');
  const seat = document.querySelector(`.seat[data-pid="${cssEsc(id)}"]`);
  if (!table || !seat) return;
  const tr = table.getBoundingClientRect();
  const cx = tr.left + tr.width / 2, cy = tr.top + tr.height * 0.45;
  const sr = seat.getBoundingClientRect();
  const sx = sr.left + sr.width / 2, sy = sr.top + sr.height / 2;
  for (let k = 0; k < 2; k++) {
    const card = document.createElement('div');
    card.className = 'deal-card-fly muck';
    card.style.left = sx + 'px'; card.style.top = sy + 'px';
    card.style.transform = 'translate(-50%,-50%)';
    document.body.appendChild(card);
    requestAnimationFrame(() => {
      card.style.transition = `transform .4s ease-in ${k * 0.05}s, opacity .4s ${k * 0.05}s`;
      card.style.transform = `translate(calc(-50% + ${cx - sx}px), calc(-50% + ${cy - sy}px)) scale(.55) rotate(${(Math.random() * 200 - 100) | 0}deg)`;
      card.style.opacity = '0';
    });
    setTimeout(() => card.remove(), 600);
  }
}

// 베팅 칩이 좌석 → 중앙(팟)으로 슬라이드
function flyBetToPot(id) {
  const table = document.querySelector('.poker-table');
  const seat = document.querySelector(`.seat[data-pid="${cssEsc(id)}"]`);
  if (!table || !seat) return;
  const tr = table.getBoundingClientRect();
  const cx = tr.left + tr.width / 2, cy = tr.top + tr.height / 2;
  const sr = seat.getBoundingClientRect();
  const sx = sr.left + sr.width / 2, sy = sr.top + sr.height / 2;
  for (let k = 0; k < 2; k++) {
    const chip = document.createElement('div');
    chip.className = 'bet-fly';
    chip.style.left = sx + 'px'; chip.style.top = sy + 'px';
    chip.style.transform = 'translate(-50%,-50%)';
    document.body.appendChild(chip);
    requestAnimationFrame(() => {
      chip.style.transition = `transform .42s cubic-bezier(.3,.7,.3,1) ${k * 0.05}s, opacity .42s ${k * 0.05}s`;
      chip.style.transform = `translate(calc(-50% + ${cx - sx}px), calc(-50% + ${cy - sy}px)) scale(.7)`;
      chip.style.opacity = '0.1';
    });
    setTimeout(() => chip.remove(), 560 + k * 60);
  }
}

// 플레이어 마지막 액션 라벨(좌석 위로 잠깐 표시)
const ACT_LABEL = { fold: '폴드', check: '체크', call: '콜', bet: '벳', raise: '레이즈' };
function showActionLabel(id, la) {
  const seat = document.querySelector(`.seat[data-pid="${cssEsc(id)}"]`);
  if (!seat) return;
  const el = document.createElement('div');
  el.className = 'act-label ' + (la.allIn ? 'allin' : la.type);
  el.textContent = la.allIn ? '올인!' : (ACT_LABEL[la.type] || la.type);
  seat.appendChild(el);
  setTimeout(() => el.remove(), 1400);
}

// 블라인드 상승 토스트
let _blindTimer = null;
function showBlindToast(text) {
  let t = document.getElementById('blindToast');
  if (!t) { t = document.createElement('div'); t.id = 'blindToast'; t.className = 'recap-toast blind-toast'; document.body.appendChild(t); }
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(_blindTimer);
  _blindTimer = setTimeout(() => t.classList.remove('show'), 3000);
}


let _seatSig = '';
let _commSig = '';
let _seenPlayerIds = new Set();
let _playersInit = false;
const _recentJoiners = new Map(); // id -> 애니 만료시각
const _recentAllIn = new Map();   // id -> 올인 연출 만료시각
const _recentBust = new Map();    // id -> 탈락 연출 만료시각
function renderSeats(s) {
  const seatsEl = $('seats');
  const players = s.players;
  const n = players.length;
  _maxChips = Math.max(1, ...players.map((p) => p.chips || 0)); // 칩 스택 상대 비교 기준
  _seatCount = n;
  // 인원이 많을수록 좌석을 축소해 겹침 방지
  // 인원 많을수록 더 적극적으로 축소 → 겹침 방지
  seatsEl.style.setProperty('--seat-scale', n <= 3 ? '1' : n <= 5 ? '0.84' : n <= 7 ? '0.72' : '0.62');
  seatsEl.style.setProperty('--me-scale', n <= 4 ? '0.88' : n <= 6 ? '0.85' : '0.8');
  // 나를 맨 아래(6시 방향)에 배치, 나머지는 아래 중앙을 비운 위쪽 호에 균등 배치(겹침 방지)
  const hasMe = players.some((p) => p.id === myId); // 관전자는 내 자리 없음
  const meIdx = Math.max(0, players.findIndex((p) => p.id === myId));
  const opos = hasMe ? othersPositions(n - 1) : ovalPositions(n);
  // 게임 도중 새로 합류한 플레이어 감지 → 등장 애니 + 토스트
  const currentIds = players.map((p) => p.id);
  if (_playersInit) {
    currentIds.forEach((id) => {
      if (!_seenPlayerIds.has(id)) {
        _recentJoiners.set(id, Date.now() + 4500); // 신규 입장 빨간 강조 표시 시간
        const jp = players.find((p) => p.id === id);
        if (jp && id !== myId) showJoinToast(jp.name);
      }
    });
  }
  currentIds.forEach((id) => _seenPlayerIds.add(id));
  _playersInit = true;
  // 카드/구조가 바뀌는 경우(인원·핸드·페이즈·쇼다운)에만 전체 재생성 → 베팅 중 클릭마다 깜빡임 방지
  const order = [];
  for (let i = 0; i < n; i++) order.push(players[(meIdx + i) % n].id);
  const sig = order.join(',') + '|' + n + '|' + s.handNumber + '|' + s.phase + '|' + (s.results ? '1' : '0');
  const full = sig !== _seatSig || _dealNewHand;
  if (full) { _seatSig = sig; seatsEl.innerHTML = ''; }

  for (let i = 0; i < n; i++) {
    const p = players[(meIdx + i) % n];
    const isMe = hasMe && p.id === myId;
    let seat = full ? null : seatsEl.querySelector(`.seat[data-pid="${cssEsc(p.id)}"]`);
    if (!seat) {
      // 신규 생성(전체 재생성 또는 새 좌석)
      seat = document.createElement('div');
      seat.dataset.pid = p.id;
      const pos = isMe ? null : (hasMe ? (opos[i - 1] || { x: 50, y: 20 }) : opos[i]);
      const meTop = (window.innerWidth <= 640) ? (n <= 4 ? 80 : 82) : 88; // 적은 인원(큰 내 좌석)일 때 살짝 더 위로 → 하단 스트립과 겹침 방지
      seat.style.left = (isMe ? 50 : pos.x) + '%';
      seat.style.top = (isMe ? meTop : pos.y) + '%';
      const result = s.results?.reveal?.find((r) => r.id === p.id);
      seat.innerHTML = `
        <div class="seat-inner">
          ${p.isButton ? '<div class="pbadges"><span class="dealer-btn">D</span></div>' : ''}
          <div class="pname">${seatAvatarHtml(p)}${seatNameTags(p)}</div>
          <div class="pchips">${p.eliminated ? '탈락' : `<span class="chip-mini"></span><span class="amt">${fmtAmt(p.chips)}</span>`}</div>
          ${seatChipStackHtml(p)}
          ${p.isToAct ? seatRingSvg() : ''}
          <div class="phole">${renderHole(p, i)}</div>
          <div class="hand-result">${result ? esc(result.handName) : ''}</div>
          ${seatResultBadge(s, p)}
          ${seatEquityHtml(s, p)}
          ${p.eliminated ? '<div class="out-stamp">OUT</div>' : ''}
          ${p.bet > 0 ? `<div class="bet-chip">${fmtAmt(p.bet)}</div>` : ''}
        </div>`;
      seatsEl.appendChild(seat);
    } else {
      // 같은 핸드 내 베팅 갱신: DOM을 헐지 않고 변한 부분만 갱신(애니메이션 재생 방지)
      updateSeatInPlace(seat, p, s);
    }
    seat.className = seatClasses(s, p, isMe);
  }
}

function seatAvatarHtml(p) {
  if (p.avatar) return `<span class="seat-av avatar-pic has-img" style="background-image:url('${p.avatar}')"></span>`;
  const initial = (p.name || '?').trim().charAt(0).toUpperCase();
  return `<span class="seat-av avatar-pic">${esc(initial)}</span>`;
}
function seatNameTags(p) {
  const streak = _winStreak.get(p.id) || 0;
  const streakTag = (streak >= 2 && !p.eliminated) ? `<span class="tag streak">🔥${streak}</span>` : '';
  return `${esc(p.name)} ${p.isBot ? '<span class="tag">봇</span>' : ''} ${streakTag} ${(!p.connected && !p.isBot) ? '<span class="tag off">끊김</span>' : ''} ${(p.sittingOut && !p.eliminated) ? '<span class="tag sitout">자리비움</span>' : ''} ${(p.penaltyShort && !p.eliminated) ? '<span class="tag short">⏱단축</span>' : ''} ${p.allIn ? '<span class="tag allin">ALL-IN</span>' : ''}`;
}
function seatClasses(s, p, isMe) {
  const done = s.phase === 'handComplete' && s.results;
  const isWinner = done && s.results.awards?.some((a) => a.winners.some((w) => w.id === p.id));
  const isLoser = done && !isWinner && s.results.reveal?.some((r) => r.id === p.id);
  return 'seat'
    + (p.isToAct ? ' active' : '')
    + (p.isToAct && isMe ? ' myturn' : '')
    + (isMe ? ' me-seat' : '')
    + (p.folded ? ' folded' : '')
    + (p.eliminated ? ' eliminated' : '')
    + ((!p.connected && !p.isBot && !p.eliminated) ? ' disconnected' : '')
    + ((p.sittingOut && !p.eliminated) ? ' sitting-out' : '')
    + ((_recentJoiners.get(p.id) || 0) > Date.now() ? ' seat-joining' : '')
    + ((_recentAllIn.get(p.id) || 0) > Date.now() ? ' allin-fx' : '')
    + ((_recentBust.get(p.id) || 0) > Date.now() ? ' bust-fx' : '')
    + (isWinner ? ' winner' : '')
    + (isLoser ? ' loser' : '');
}
function seatResultBadge(s, p) {
  if (s.phase !== 'handComplete' || !s.results) return '';
  const isWin = s.results.awards?.some((a) => a.winners.some((w) => w.id === p.id));
  if (isWin) return '<div class="result-badge win">WIN 🏆</div>';
  if (s.results.reveal?.some((r) => r.id === p.id)) return '<div class="result-badge lose">LOSE</div>';
  return '';
}
function seatEquityHtml(s, p) {
  if (!s.equity || p.folded || s.equity[p.id] == null) return '';
  const v = s.equity[p.id];
  return `<div class="eq-badge${v >= 50 ? ' lead' : ''}">${v}%</div>`;
}
function updateSeatInPlace(seat, p, s) {
  const inner = seat.querySelector('.seat-inner');
  if (!inner) return;
  // 올인 승률 배지 갱신(런아웃 중 보드가 바뀌면 값 변경)
  let eq = inner.querySelector('.eq-badge');
  const eqVal = (s && s.equity && !p.folded) ? s.equity[p.id] : null;
  if (eqVal != null) {
    if (!eq) { eq = document.createElement('div'); eq.className = 'eq-badge'; inner.appendChild(eq); }
    eq.textContent = eqVal + '%';
    eq.classList.toggle('lead', eqVal >= 50);
  } else if (eq) {
    eq.remove();
  }
  // 이름/태그(올인·끊김) — 애니메이션 없음
  const pname = inner.querySelector('.pname');
  if (pname) pname.innerHTML = seatAvatarHtml(p) + seatNameTags(p);
  // 카운트다운 테두리: 차례일 때만 표시(추가/제거 시 애니 자연 재시작)
  let ring = inner.querySelector('.seat-ring');
  if (p.isToAct && !ring) { inner.insertAdjacentHTML('afterbegin', seatRingSvg()); }
  else if (!p.isToAct && ring) ring.remove();
  // 베팅 칩: 값이 바뀔 때만 갱신(매 렌더 chipPop 재생 방지)
  let chip = inner.querySelector('.bet-chip');
  if (p.bet > 0) {
    const txt = fmtAmt(p.bet);
    if (!chip) { chip = document.createElement('div'); chip.className = 'bet-chip'; chip.textContent = txt; inner.appendChild(chip); }
    else if (chip.textContent !== txt) chip.textContent = txt;
  } else if (chip) {
    chip.remove();
  }
  // 칩 수량은 animateChips()가 롤링 처리
}

function renderHole(p, seatIdx = 0) {
  if (!p.hole) return '';
  const showdownReveal = _revealFlip && p.id !== myId && !p.folded; // 쇼다운 시 상대 카드 플립
  return p.hole.map((c, ci) => {
    let extra = '', style = '';
    if (_dealNewHand) {
      extra = 'deal-in';
      // 셔플 연출이 끝난 뒤 카드가 등장하도록 기본 딜레이를 둠
      const delay = (0.5 + seatIdx * 0.12 + ci * 0.07).toFixed(2);
      style = `style="animation-delay:${delay}s"`;
    } else if (showdownReveal && !c.hidden) {
      extra = 'flip-in';
      style = `style="animation-delay:${(ci * 0.12).toFixed(2)}s"`;
    }
    if (c.hidden) return cardHtml(null, true, p.folded, extra, style);
    return cardHtml(c, false, p.folded, extra, style);
  }).join('');
}

function ovalPositions(n) {
  // 타원 둘레에 좌석 배치. index0 = 6시(아래 중앙)
  const out = [];
  // 모바일(세로형 테이블)은 가로 반경을 줄이고 세로 반경을 키워 좌석이 테이블에 맞게
  const mobile = window.innerWidth <= 640;
  const cx = 50, cy = mobile ? 44 : 49, rx = mobile ? 46 : 48, ry = mobile ? 42 : 37; // 모바일: 좌석을 사이드로 더 벌림
  for (let i = 0; i < n; i++) {
    const angle = Math.PI / 2 + (2 * Math.PI * i) / n; // 90도(아래)에서 시작
    out.push({
      x: cx + rx * Math.cos(angle),
      y: cy + ry * Math.sin(angle),
    });
  }
  return out;
}

// 내 자리(아래 중앙)를 비우고 나머지 k명을 위쪽 호에 균등 배치 → 큰 내 카드와 안 겹침
function othersPositions(k) {
  if (k <= 0) return [];
  const mobile = window.innerWidth <= 640;
  // 아래 중앙(내 자리)만 비우고 나머지는 테두리를 따라 균등 배치. 모바일은 테두리로 더 밀고 위로 올림
  const cx = 50, cy = mobile ? 42 : 47;
  const rx = mobile ? 45 : 48, ry = mobile ? 43 : 37; // 모바일: 좌석이 화면 밖으로 안 나가게 살짝 안쪽
  const gap = mobile ? 0.72 : 0.62; // 아래 중앙 양옆으로 비우는 반각(라디안)
  const span = 2 * Math.PI - 2 * gap;
  const out = [];
  for (let j = 0; j < k; j++) {
    const a = Math.PI / 2 + gap + span * ((j + 0.5) / k); // 아래 직후부터 시계방향으로 한 바퀴(아래 비움)
    out.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
  }
  return out;
}

function renderActions(s) {
  const bar = $('actionbar');
  bar.innerHTML = '';
  bar.classList.toggle('myturn', !!(s.legal && !s.finished && !s.paused)); // 내 차례 강조
  if (s.finished) return;
  if (s.paused) {
    bar.innerHTML = '<span class="waiting-turn">자리 비움으로 대기 중 — 인원이 모이면 자동 재개됩니다</span>';
    return;
  }
  const me = s.players.find((p) => p.id === myId);
  if (!me || me.eliminated || me.chips <= 0) {
    // 관전 중이고 빈 자리가 있으면 크고 명확한 '참여하기' 버튼 표시
    if (isSpectator && !s.finished && s.players.length < (s.maxPlayers || 9)) {
      const b = document.createElement('button');
      b.className = 'btn-join-table';
      b.textContent = '➕ 이 게임에 참여하기';
      b.onclick = () => $('specJoinBtn').click();
      bar.appendChild(b);
    } else {
      bar.innerHTML = '<span class="waiting-turn">관전 중...</span>';
    }
    return;
  }

  if (!s.legal) {
    const who = s.players.find((p) => p.id === s.toActId);
    bar.innerHTML = `<span class="waiting-turn">${who ? esc(who.name) + ' 차례...' : '다음 핸드 준비 중...'}</span>`;
    return;
  }

  const callAct = s.legal.find((a) => a.type === 'call');
  const checkAct = s.legal.find((a) => a.type === 'check');
  const raiseAct = s.legal.find((a) => a.type === 'raise' || a.type === 'bet');

  // 사이징 행은 항상 만들어 공간을 유지(레이즈 불가 시 빈 채로 자리만 차지)
  const raiseRow = document.createElement('div');
  raiseRow.className = 'action-raise';
  const mainRow = document.createElement('div');
  mainRow.className = 'action-main';

  // 폴드: 잘 안 쓰는 버튼 → 카드 한쪽(기본 왼쪽). 오작동 방지 겸 격리
  mainRow.appendChild(btn('btn-fold', '폴드', () => act('fold')));
  // 자주 쓰는 액션(체크/콜·레이즈)을 한 묶음으로 반대쪽(기본 오른쪽, 오른손 엄지)
  const proceedGrp = document.createElement('div');
  proceedGrp.className = 'action-proceed';
  if (checkAct) proceedGrp.appendChild(btn('btn-check', '체크', () => act('check')));
  else if (callAct) proceedGrp.appendChild(btn('btn-call', `콜 ${fmtAmt(callAct.amount)}`, () => act('call')));
  mainRow.appendChild(proceedGrp);

  // 레이즈/벳 — 사이징 행(슬라이더·퀵벳) 위, 메인 버튼 아래
  if (raiseAct) {
    const min = raiseAct.min, max = raiseAct.max;
    const label = raiseAct.type === 'bet' ? '벳' : '레이즈';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = min; slider.max = max; slider.value = min; slider.step = Math.max(1, s.blinds.sb);
    const amt = document.createElement('span');
    amt.className = 'raise-amount';
    amt.textContent = fmtAmt(min);

    const goBtn = btn('btn-raise', `${label} ${fmtAmt(min)}`, () => act('raise', parseInt(slider.value, 10)));
    const setVal = (v) => {
      v = Math.max(min, Math.min(max, Math.floor(v)));
      slider.value = v; amt.textContent = fmtAmt(v); goBtn.textContent = `${label} ${fmtAmt(v)}`;
    };
    slider.oninput = () => setVal(slider.value);

    // 팟 기준 베팅 금액 계산 (콜 후 팟 대비 비율)
    const myBet = me.bet || 0;
    const toCall = callAct ? callAct.amount : 0;
    const currentBet = myBet + toCall;
    const potAfterCall = s.pot + toCall;
    const potBet = (frac) => Math.max(min, Math.min(max, currentBet + Math.round(frac * potAfterCall)));

    // ½팟 / ⅔팟 / 팟 — 누르면 즉시 레이즈. 버튼에 베팅(레이즈 to) 금액 표시
    const quick = document.createElement('div');
    quick.className = 'quick-bets';
    quick.appendChild(qbtn('½팟', potBet(0.5), () => act('raise', potBet(0.5))));
    quick.appendChild(qbtn('⅔팟', potBet(2 / 3), () => act('raise', potBet(2 / 3))));
    quick.appendChild(qbtn('팟', potBet(1), () => act('raise', potBet(1))));
    if (max > potBet(1)) quick.appendChild(qbtn('올인', max, () => act('raise', max)));

    raiseRow.appendChild(quick);
    raiseRow.appendChild(slider);
    raiseRow.appendChild(amt);
    proceedGrp.appendChild(goBtn); // 레이즈: 체크/콜과 같은 묶음(많이 쓰는 쪽)
  } else {
    raiseRow.classList.add('empty'); // 공간만 유지
  }

  bar.appendChild(raiseRow);
  bar.appendChild(mainRow);
}

function btn(cls, label, fn) {
  const b = document.createElement('button');
  b.className = cls; b.textContent = label; b.onclick = fn;
  return b;
}
function qbtn(label, amount, fn) {
  const b = document.createElement('button');
  b.className = 'qb';
  b.innerHTML = `<span class="qb-lbl">${label}</span><span class="qb-amt">${fmtAmt(amount)}</span>`;
  b.onclick = fn;
  return b;
}

function act(type, amount) {
  socket.emit('action', { type, amount }, (res) => {
    if (!res.ok) flashError(res.error);
  });
}

function renderLog(s) {
  const log = $('log');
  // 사용자가 위로 스크롤해 과거 기록을 보고 있으면 자동으로 끌어내리지 않음(스크롤백 유지)
  const nearBottom = (log.scrollHeight - log.scrollTop - log.clientHeight) < 48;
  log.innerHTML = (s.log || []).map((l) => `<div>${esc(l.msg)}</div>`).join('');
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

function renderWinner(s) {
  const banner = $('winnerBanner');
  if (s.results && s.phase === 'handComplete') {
    // 같은 승자(들)가 메인·사이드 팟을 모두 이기면 한 줄로 금액 합산
    const merged = new Map();
    for (const a of s.results.awards) {
      const key = a.winners.map((w) => w.id || w.name).join('|');
      const m = merged.get(key) || { winners: a.winners, amount: 0, handName: a.handName };
      m.amount += a.amount || 0;
      if (!m.handName && a.handName) m.handName = a.handName;
      merged.set(key, m);
    }
    const lines = [...merged.values()].map((a) =>
      `<span class="wb-title">🏆 ${a.winners.map((w) => esc(w.name)).join(', ')} 승리!</span>` +
      `<span class="wb-sub"><span class="wb-amt">+${fmtAmt(a.amount)}</span>` +
      (a.handName ? ` <span class="wb-hand">· ${esc(a.handName)}</span>` : '') + `</span>`
    );
    banner.innerHTML = lines.join('<hr class="wb-div">');
    banner.classList.remove('hidden');
    banner.classList.remove('pop'); void banner.offsetWidth; banner.classList.add('pop');
  } else {
    banner.classList.add('hidden');
  }
}

let finalShown = false;
function renderFinal(s) {
  const ranked = [...s.finalResults].sort((a, b) => a.place - b.place);
  const champ = ranked.find((r) => r.place === 1);
  $('champName').textContent = champ ? champ.name : '';
  const ol = $('finalRanks');
  const medal = (p) => (p === 1 ? '🥇' : p === 2 ? '🥈' : p === 3 ? '🥉' : '🏷️');
  ol.innerHTML = ranked.map((r) => {
    const isMe = r.id === myId;
    const placeTxt = r.place === 1 ? '우승 🏆' : `${r.place}위 · 탈락`;
    return `<li class="rank-row ${r.place === 1 ? 'first' : ''} ${isMe ? 'mine' : ''}">
      <span class="rank-medal">${medal(r.place)}</span>
      <span class="rank-name">${esc(r.name)}${isMe ? ' <span class="tag you">나</span>' : ''}</span>
      <span class="rank-place">${placeTxt}</span>
    </li>`;
  }).join('');
  // 방장에게만 리매치 버튼
  $('rematchBtn').classList.toggle('hidden', !s.isHost);
  show('finalScreen');
  if (!finalShown) {
    finalShown = true;
    launchConfetti();
    sfxFanfare();
  }
}
$('rematchBtn').onclick = () => {
  socket.emit('rematch', {}, (r) => {
    if (!r || !r.ok) { toast((r && r.error) || '다시 시작하지 못했습니다', 'error'); return; }
    finalShown = false; hide('finalScreen');
  });
};

function launchConfetti() {
  const c = $('confetti');
  c.innerHTML = '';
  const colors = ['#e8c466', '#e25555', '#3ec97a', '#4a8cff', '#9b59b6', '#ffffff'];
  for (let i = 0; i < 130; i++) {
    const p = document.createElement('div');
    p.className = 'confetti-piece';
    p.style.left = Math.random() * 100 + '%';
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = (Math.random() * 1.2) + 's';
    p.style.animationDuration = (2.4 + Math.random() * 1.8) + 's';
    if (Math.random() < 0.5) p.style.borderRadius = '50%';
    p.style.width = (6 + Math.random() * 6) + 'px';
    p.style.height = (10 + Math.random() * 8) + 'px';
    c.appendChild(p);
  }
  // 반복 발사 (3회) 로 풍성하게
  let bursts = 0;
  const iv = setInterval(() => {
    if (++bursts >= 3) { clearInterval(iv); return; }
    for (let i = 0; i < 60; i++) {
      const p = document.createElement('div');
      p.className = 'confetti-piece';
      p.style.left = Math.random() * 100 + '%';
      p.style.background = colors[i % colors.length];
      p.style.animationDuration = (2.4 + Math.random() * 1.8) + 's';
      if (Math.random() < 0.5) p.style.borderRadius = '50%';
      c.appendChild(p);
    }
  }, 1100);
}

// ---------- 카드 렌더 (실제 트럼프 카드 레이아웃) ----------
function faceMarkup(c) {
  const sym = SUIT_SYM[c.s];
  const rl = rankLabel(c.r);
  return `<div class="corner tl"><span class="r">${rl}</span><span class="s">${sym}</span></div>` +
    `<div class="pip">${sym}</div>` +
    `<div class="corner br"><span class="r">${rl}</span><span class="s">${sym}</span></div>`;
}
function cardHtml(c, back, muck, extra = '', style = '') {
  if (back || !c) return `<div class="card sm back ${extra}" ${style}></div>`;
  const red = isRedSuit(c.s);
  const win = _winCards.has(c.r + '-' + c.s) ? 'win' : '';
  return `<div class="card sm ${red ? 'red' : 'black'} ${muck ? 'muck' : ''} ${win} ${extra}" ${style}>${faceMarkup(c)}</div>`;
}
// 커뮤니티 카드 (큰 사이즈)
function cardEl(c) {
  const tmp = document.createElement('div');
  const red = isRedSuit(c.s);
  const win = _winCards.has(c.r + '-' + c.s) ? 'win' : '';
  tmp.innerHTML = `<div class="card ${red ? 'red' : 'black'} ${win}">${faceMarkup(c)}</div>`;
  return tmp.firstElementChild;
}

// ---------- 내 카드 크게 보기(피크): 내 카드 탭하면 확대 ----------
function peekCardBig(c) {
  const red = isRedSuit(c.s);
  return `<div class="card ${red ? 'red' : 'black'}">${faceMarkup(c)}</div>`;
}
function showCardPeek() {
  const me = lastState?.players.find((p) => p.id === myId);
  if (!me || !me.hole || me.hole.some((c) => c.hidden)) return; // 공개된 내 카드일 때만
  let ov = document.getElementById('cardPeek');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'cardPeek';
    ov.className = 'card-peek-overlay';
    ov.onclick = () => ov.classList.remove('show');
    document.body.appendChild(ov);
  }
  ov.innerHTML = `<div class="card-peek-cards">${me.hole.map(peekCardBig).join('')}</div><div class="card-peek-hint">탭하여 닫기</div>`;
  ov.classList.add('show');
}
$('seats').addEventListener('click', (e) => {
  const seat = e.target.closest('.seat.me-seat');
  if (seat && e.target.closest('.phole')) showCardPeek();
});
// 커뮤니티(보드) 카드 탭 → 크게 보기
function showCommunityPeek() {
  const board = (lastState && lastState.community) || [];
  if (!board.length) return;
  let ov = document.getElementById('cardPeek');
  if (!ov) { ov = document.createElement('div'); ov.id = 'cardPeek'; ov.className = 'card-peek-overlay'; ov.onclick = () => ov.classList.remove('show'); document.body.appendChild(ov); }
  ov.innerHTML = `<div class="card-peek-cards board">${board.map(peekCardBig).join('')}</div><div class="card-peek-hint">탭하여 닫기</div>`;
  ov.classList.add('show');
}
$('community').addEventListener('click', () => showCommunityPeek());

// ---------- 채팅 ----------
$('chatSend').onclick = sendChat;
// 한글 IME 조합 중 Enter는 무시(조합 중 전송되면 마지막 글자가 중복됨)
$('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) sendChat();
});

// 빠른 채팅 프리셋
const QUICK_CHATS = ['gg', '굿럭', '나이스!', '한판 더', '아쉽다', 'ㅋㅋㅋ'];
(function buildQuickChat() {
  const box = $('quickChat'); if (!box) return;
  QUICK_CHATS.forEach((t) => {
    const b = document.createElement('button');
    b.className = 'qchat-btn'; b.textContent = t;
    b.onclick = () => socket.emit('chat', { text: t });
    box.appendChild(b);
  });
})();

// 게임 기록 복사 / 전체 보기
function gameLogText() { return ($('log').innerText || '').trim(); }
$('logCopy').onclick = () => { navigator.clipboard?.writeText(gameLogText()); toast('기록을 복사했습니다', 'ok'); };
$('logView').onclick = () => { $('logFull').textContent = gameLogText() || '아직 기록이 없습니다'; show('logPanel'); };
$('logClose').onclick = () => hide('logPanel');
$('logFullCopy').onclick = () => { navigator.clipboard?.writeText(gameLogText()); toast('기록을 복사했습니다', 'ok'); };

// 상대 프로필 보기
function openOppProfile(nick) {
  if (!nick) return;
  socket.emit('profileByNick', { nick }, (r) => {
    if (!r || !r.ok) { toast('프로필을 찾을 수 없습니다', 'error'); return; }
    const p = r.profile, st = p.stats || {};
    $('oppNick').textContent = p.nick;
    $('oppBalance').textContent = p.balance;
    paintAvatar($('oppAvatar'), p.avatar, p.nick);
    const rows = [
      ['게임 수', st.games || 0], ['우승', st.wins || 0],
      ['승률', (st.games ? Math.round((st.wins / st.games) * 100) : 0) + '%'],
      ['핸드 승', st.handsWon || 0], ['최고 순위', st.bestPlace ? st.bestPlace + '위' : '-'], ['최대 팟', st.biggestPot || 0],
    ];
    $('oppStats').innerHTML = rows.map(([k, v]) => `<div class="acc-stat"><span class="acc-k">${k}</span><span class="acc-v">${v}</span></div>`).join('');
    show('oppProfilePanel');
  });
}
$('oppClose').onclick = () => hide('oppProfilePanel');

// 모바일 채팅/기록 드로어 토글
$('chatToggle').onclick = () => {
  document.body.classList.toggle('chat-open');
  $('chatToggle').classList.remove('has-unread');
  if (document.body.classList.contains('chat-open')) {
    const cm = $('chatMessages'); if (cm) cm.scrollTop = cm.scrollHeight;
  }
};
$('chatDrawerClose').onclick = () => document.body.classList.remove('chat-open');
function sendChat() {
  const t = $('chatInput').value.trim();
  if (!t) return;
  socket.emit('chat', { text: t });
  $('chatInput').value = '';
}

// 타임뱅크: 내 차례에 추가 시간 사용
function updateTimeBankBtn(s) {
  const btn = $('timeBankBtn');
  if (!btn) return;
  const me = s.players && s.players.find((p) => p.id === myId);
  const myTurn = s.toActId === myId && !s.finished && !!s.phase && !isSpectator;
  const bank = me ? (me.timeBank || 0) : 0;
  const visible = myTurn && bank >= 1000 && !!s.actionLimit;
  btn.classList.toggle('hidden', !visible);
  if (visible) {
    const mobile = window.innerWidth <= 640;
    btn.textContent = mobile ? '⏱' : `⏱ 시간 추가 +15s (잔여 ${Math.round(bank / 1000)}s)`;
    btn.title = `시간 추가 +15초 (잔여 ${Math.round(bank / 1000)}초)`;
  }
}
$('timeBankBtn').onclick = () => {
  socket.emit('useTimeBank', {}, (r) => {
    if (!r || !r.ok) { if (r && r.error) toast(r.error, 'error'); return; }
    toast('시간을 추가했습니다 (+15초)', 'ok');
  });
};

// ---------- 유틸 ----------
// esc()는 util.js에 정의됨
let errTimer;
function flashError(msg) {
  let el = $('errToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'errToast';
    el.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#e25555;color:#fff;padding:10px 18px;border-radius:10px;z-index:200;font-size:14px';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(errTimer);
  errTimer = setTimeout(() => (el.style.display = 'none'), 2500);
}

// ---------- 관리자 패널 (#admin 으로 열기, ADMIN_PASSWORD 인증) ----------
let _adminData = null, _adminTab = 'status', _adminAuthed = false;
function fmtAgo(ts, nowTs) {
  if (!ts) return '기록 없음';
  const s = Math.max(0, Math.floor(((nowTs || Date.now()) - ts) / 1000));
  if (s < 60) return s + '초 전';
  if (s < 3600) return Math.floor(s / 60) + '분 전';
  if (s < 86400) return Math.floor(s / 3600) + '시간 전';
  return Math.floor(s / 86400) + '일 전';
}
function openAdmin() {
  show('adminPanel');
  if (_adminAuthed) { $('adminAuth').classList.add('hidden'); $('adminMain').classList.remove('hidden'); adminCall('admin:overview').then(renderAdmin); }
  else { $('adminAuth').classList.remove('hidden'); $('adminMain').classList.add('hidden'); setTimeout(() => $('adminPw').focus(), 60); }
}
function adminCall(event, payload) {
  return new Promise((res) => socket.emit(event, payload || {}, (r) => {
    if (r && r.ok && r.data) _adminData = r.data;
    if (!r || !r.ok) toast((r && r.error) || '실패했습니다', 'error');
    res(r || { ok: false });
  }));
}
if ($('adminLogin')) {
  $('adminLogin').onclick = async () => {
    const r = await adminCall('admin:auth', { password: $('adminPw').value });
    if (r.ok) { _adminAuthed = true; $('adminPw').value = ''; $('adminAuthErr').textContent = ''; $('adminAuth').classList.add('hidden'); $('adminMain').classList.remove('hidden'); renderAdmin(); }
    else { $('adminAuthErr').textContent = r.error || '인증 실패'; }
  };
  $('adminPw').onkeydown = (e) => { if (e.key === 'Enter') $('adminLogin').click(); };
  $('adminCloseA').onclick = () => hide('adminPanel');
  $('adminCloseB').onclick = () => hide('adminPanel');
  document.querySelectorAll('.admin-tab').forEach((b) => b.onclick = () => {
    _adminTab = b.dataset.tab;
    document.querySelectorAll('.admin-tab').forEach((x) => x.classList.toggle('active', x === b));
    renderAdmin();
  });
}
function renderAdmin() {
  const box = $('adminBody'); if (!box) return;
  if (!_adminData) { box.innerHTML = '<div class="room-empty">불러오는 중...</div>'; return; }
  if (_adminTab === 'status') renderAdminStatus(box);
  else if (_adminTab === 'rooms') renderAdminRooms(box);
  else if (_adminTab === 'accounts') renderAdminAccounts(box);
  else renderAdminNotice(box);
}
const ADMIN_ST = { playing: ['게임 중', 'st-playing'], waiting: ['대기 중', 'st-waiting'], spectating: ['관전', 'st-spec'], away: ['자리 비움', 'st-away'], lobby: ['로비', 'st-lobby'] };
function renderAdminStatus(box) {
  const accts = (_adminData.accounts || []).filter((a) => a.online);
  const now = _adminData.serverTime || Date.now();
  box.innerHTML = `<div class="admin-summary">접속 중 <b>${accts.length}</b>명 · 열린 방 <b>${(_adminData.rooms || []).length}</b>개</div>`;
  if (!accts.length) { box.innerHTML += '<div class="room-empty">접속 중인 사용자가 없습니다</div>'; return; }
  accts.forEach((a) => {
    const meta = ADMIN_ST[a.status] || ADMIN_ST.lobby;
    const row = document.createElement('div'); row.className = 'admin-item admin-st-row';
    row.innerHTML = `<div class="ai-head"><b>${esc(a.nick)}</b> <span class="st-badge ${meta[1]}"><span class="st-dot"></span>${meta[0]}</span>${a.room ? `<span class="ai-sub"> · 방 ${esc(a.room)}</span>` : ''}</div><div class="ai-sub">최근 활동 ${fmtAgo(a.lastActive, now)} · 잔액 ${a.balance}</div>`;
    const log = document.createElement('button'); log.className = 'ghost ai-mini'; log.textContent = '로그';
    log.onclick = () => openUserDetail(a.nick);
    row.appendChild(log);
    box.appendChild(row);
  });
}
function renderAdminRooms(box) {
  const rooms = _adminData.rooms || [];
  if (!rooms.length) { box.innerHTML = '<div class="room-empty">열린 방이 없습니다</div>'; return; }
  box.innerHTML = '';
  rooms.forEach((rm) => {
    const humans = rm.players.filter((p) => !p.isBot);
    const card = document.createElement('div'); card.className = 'admin-item';
    card.innerHTML = `<div class="ai-head"><b>${esc(rm.code)}</b><span class="ai-sub"> ${rm.started ? '게임중' : '대기'} · 핸드 ${rm.hand} · ${humans.length}명${rm.spectators ? (' · 관전 ' + rm.spectators) : ''}</span></div>`;
    const plist = document.createElement('div'); plist.className = 'ai-plist';
    rm.players.forEach((p) => {
      const chip = document.createElement('span'); chip.className = 'ai-chip';
      chip.textContent = `${p.isBot ? '🤖 ' : ''}${p.name} (${p.chips})`;
      if (!p.isBot) { const k = document.createElement('button'); k.className = 'ai-x'; k.textContent = '강퇴'; k.onclick = async () => { await adminCall('admin:kick', { code: rm.code, pid: p.id }); renderAdmin(); }; chip.appendChild(k); }
      plist.appendChild(chip);
    });
    card.appendChild(plist);
    const close = document.createElement('button'); close.className = 'ai-danger'; close.textContent = '방 강제 종료';
    close.onclick = async () => { if (!confirm(rm.code + ' 방을 종료할까요?')) return; await adminCall('admin:closeRoom', { code: rm.code }); renderAdmin(); };
    card.appendChild(close);
    box.appendChild(card);
  });
}
function renderAdminAccounts(box) {
  const accts = _adminData.accounts || [];
  box.innerHTML = '';
  const search = document.createElement('input'); search.className = 'admin-search'; search.placeholder = `닉네임 검색 (총 ${accts.length}명)`;
  box.appendChild(search);
  const list = document.createElement('div'); box.appendChild(list);
  const draw = (f) => {
    list.innerHTML = '';
    accts.filter((a) => !f || a.nick.toLowerCase().includes(f)).slice(0, 200).forEach((a) => {
      const row = document.createElement('div'); row.className = 'admin-item';
      row.innerHTML = `<div class="ai-head"><b>${esc(a.nick)}</b>${a.online ? ' <span class="st-badge st-playing"><span class="st-dot"></span>온라인</span>' : ''}${a.banned ? ' <span class="ai-ban">차단됨</span>' : ''}<span class="ai-sub"> · ${a.games}전 ${a.wins}승</span></div>`;
      const bal = document.createElement('div'); bal.className = 'ai-bal';
      const inp = document.createElement('input'); inp.type = 'number'; inp.value = a.balance; inp.className = 'ai-bal-input';
      const setb = document.createElement('button'); setb.className = 'ghost'; setb.textContent = '💰 저장';
      setb.onclick = async () => { await adminCall('admin:setBalance', { nick: a.nick, balance: Number(inp.value) }); renderAdmin(); };
      bal.appendChild(inp); bal.appendChild(setb); row.appendChild(bal);
      const acts = document.createElement('div'); acts.className = 'ai-acts';
      const logb = document.createElement('button'); logb.className = 'ghost'; logb.textContent = '로그'; logb.onclick = () => openUserDetail(a.nick);
      const ren = document.createElement('button'); ren.className = 'ghost'; ren.textContent = '이름변경'; ren.onclick = async () => { const nn = prompt('새 닉네임 (2~16자)', a.nick); if (nn == null) return; await adminCall('admin:rename', { nick: a.nick, newNick: nn }); renderAdmin(); };
      const rpw = document.createElement('button'); rpw.className = 'ghost'; rpw.textContent = '비번초기화'; rpw.onclick = async () => { const pw = prompt(a.nick + ' 새 비밀번호 (4자 이상)'); if (!pw) return; const r = await adminCall('admin:resetPassword', { nick: a.nick, newPassword: pw }); if (r.ok) toast('비밀번호를 변경했습니다', 'ok'); renderAdmin(); };
      const fo = document.createElement('button'); fo.className = 'ghost'; fo.textContent = '로그아웃'; fo.onclick = async () => { await adminCall('admin:forceLogout', { nick: a.nick }); renderAdmin(); };
      const ban = document.createElement('button'); ban.className = 'ghost'; ban.textContent = a.banned ? '차단해제' : '차단'; ban.onclick = async () => { await adminCall(a.banned ? 'admin:unban' : 'admin:ban', { nick: a.nick }); renderAdmin(); };
      const del = document.createElement('button'); del.className = 'ai-danger sm'; del.textContent = '삭제'; del.onclick = async () => { if (!confirm(a.nick + ' 계정을 삭제할까요? 되돌릴 수 없습니다.')) return; await adminCall('admin:deleteAccount', { nick: a.nick }); renderAdmin(); };
      acts.appendChild(logb); acts.appendChild(ren); acts.appendChild(rpw); acts.appendChild(fo); acts.appendChild(ban); acts.appendChild(del); row.appendChild(acts);
      list.appendChild(row);
    });
  };
  draw(''); search.oninput = () => draw(search.value.trim().toLowerCase());
}
function renderAdminNotice(box) {
  box.innerHTML = '';
  const ta = document.createElement('textarea'); ta.className = 'admin-notice-input'; ta.placeholder = '전체 접속자에게 보낼 공지 내용...'; ta.maxLength = 300;
  const send = document.createElement('button'); send.className = 'primary'; send.textContent = '📢 전체 공지 보내기';
  send.onclick = async () => { const t = ta.value.trim(); if (!t) return; const r = await adminCall('admin:broadcast', { text: t }); if (r.ok) { toast('공지를 보냈습니다', 'ok'); ta.value = ''; } };
  box.appendChild(ta); box.appendChild(send);
}
// 사용자 상세/로그 보기
async function openUserDetail(nick) {
  const r = await new Promise((res) => socket.emit('admin:userDetail', { nick }, res));
  if (!r || !r.ok) { toast((r && r.error) || '불러오기 실패', 'error'); return; }
  renderAdminDetail(r.detail);
}
function fmtHist(h, nowTs) {
  if (typeof h === 'string') return h;
  const date = h.at ? new Date(h.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const place = (h.place != null) ? `${h.place}위` : '';
  const res = h.win ? '🏆 우승' : place;
  return [date, h.code ? ('방 ' + h.code) : '', (h.players != null ? h.players + '명' : ''), res].filter(Boolean).join(' · ');
}
function renderAdminDetail(d) {
  const box = $('adminBody'); if (!box) return;
  const now = d.serverTime || Date.now(); const st = d.stats || {};
  box.innerHTML = '';
  const back = document.createElement('button'); back.className = 'ghost admin-back'; back.textContent = '← 목록으로'; back.onclick = renderAdmin;
  box.appendChild(back);
  const head = document.createElement('div'); head.className = 'admin-item';
  head.innerHTML = `<div class="ai-head"><b>${esc(d.nick)}</b>${d.online ? ' <span class="st-badge st-playing"><span class="st-dot"></span>온라인</span>' : ''}${d.banned ? ' <span class="ai-ban">차단됨</span>' : ''}</div>
    <div class="ai-sub">잔액 ${d.balance} · 가입 ${d.createdAt ? fmtAgo(d.createdAt, now) : '-'} · 최근 활동 ${fmtAgo(d.lastActive, now)}</div>
    <div class="ai-sub">게임 ${st.games || 0} · 우승 ${st.wins || 0} · 핸드승 ${st.handsWon || 0} · 최고 팟 ${st.biggestPot || 0}</div>`;
  box.appendChild(head);
  const hist = d.history || [];
  const hbox = document.createElement('div'); hbox.className = 'admin-item';
  hbox.innerHTML = '<div class="ai-head" style="margin-bottom:6px">게임 기록 (최근 ' + hist.length + '건)</div>' +
    (hist.length ? hist.map((h) => `<div class="admin-log-row">${esc(fmtHist(h, now))}</div>`).join('') : '<div class="ai-sub">기록이 없습니다</div>');
  box.appendChild(hbox);
}
// 공지 수신(모든 사용자에게 배너 표시)
socket.on('announce', ({ text } = {}) => {
  if (!text) return;
  let el = document.getElementById('announceBanner');
  if (!el) { el = document.createElement('div'); el.id = 'announceBanner'; el.className = 'announce-banner'; document.body.appendChild(el); }
  el.innerHTML = '<span class="ab-ico">📢</span><span class="ab-text"></span><button class="ab-x">✕</button>';
  el.querySelector('.ab-text').textContent = text;
  el.classList.add('show');
  el.querySelector('.ab-x').onclick = () => el.classList.remove('show');
  clearTimeout(window._annTimer); window._annTimer = setTimeout(() => el.classList.remove('show'), 15000);
});
socket.on('balanceUpdate', ({ balance } = {}) => {
  if (myProfile && typeof balance === 'number') { myProfile.balance = balance; if (typeof updateMeDisplay === 'function') updateMeDisplay(); }
});
function checkAdminHash() { if (location.hash === '#admin') openAdmin(); }
window.addEventListener('hashchange', checkAdminHash);
checkAdminHash();
