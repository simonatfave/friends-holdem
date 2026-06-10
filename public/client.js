const socket = io();
let myId = null;
let myName = '';
let isHost = false;
let lastState = null;
let isSpectator = false;
let prevSnap = null;        // 직전 상태 스냅샷 (애니메이션/사운드 diff용)
let _dealNewHand = false;   // 이번 렌더에서 홀카드 딜링 애니 적용?
let _newCommFrom = 99;      // 이 인덱스부터의 커뮤니티 카드는 새 카드(플립 애니)

// 서버 재시작/네트워크 끊김 후 자동 재접속 시, 진행 중이던 방에 다시 합류
socket.on('connect', () => {
  if (myRoomCode && myName) {
    socket.emit('join', { code: myRoomCode, name: myName }, (res) => {
      if (res && res.ok) myId = res.youId;
    });
  }
});

const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove('hidden');
const hide = (id) => $(id).classList.add('hidden');

// 배포 버전 표시 (client.js?v=NN 에서 자동 추출)
(function showVersion() {
  const s = document.querySelector('script[src*="client.js"]');
  const m = s && s.src.match(/[?&]v=(\d+)/);
  const el = $('versionBadge');
  if (el) el.textContent = 'v.' + (m ? m[1] : '?');
})();

// ---------- 효과음 (Web Audio, 에셋 없이 생성) + 설정 ----------
function loadSound() {
  try { return Object.assign({ master: true, turn: true, fx: true }, JSON.parse(localStorage.getItem('dice_sound') || '{}')); }
  catch (e) { return { master: true, turn: true, fx: true }; }
}
function saveSound() { try { localStorage.setItem('dice_sound', JSON.stringify(soundSettings)); } catch (e) {} }
const soundSettings = loadSound();
let audioCtx = null;
function ac() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
function tone(freq, dur, type = 'sine', vol = 0.15, when = 0) {
  if (!soundSettings.master) return;
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
// fx 카테고리(카드·칩·승리)
const sfxDeal = () => { if (!soundSettings.fx) return; tone(520, 0.08, 'triangle', 0.12); tone(360, 0.08, 'triangle', 0.1, 0.04); };
const sfxChip = () => { if (!soundSettings.fx) return; tone(900, 0.05, 'square', 0.07); tone(1250, 0.05, 'square', 0.05, 0.03); };
const sfxWin = () => { if (!soundSettings.fx) return; [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.26, 'triangle', 0.13, i * 0.09)); };
const sfxAllIn = () => { if (!soundSettings.fx) return; [180, 280, 400, 560, 820].forEach((f, i) => tone(f, 0.16, 'sawtooth', 0.11, i * 0.05)); tone(90, 0.55, 'sine', 0.2, 0.04); };
const sfxBust = () => { if (!soundSettings.fx) return; [540, 410, 300, 200, 130].forEach((f, i) => tone(f, 0.2, 'triangle', 0.12, i * 0.08)); };
const sfxFanfare = () => {
  if (!soundSettings.fx) return;
  const seq = [523, 659, 784, 1046, 988, 1046, 1318];
  seq.forEach((f, i) => tone(f, 0.32, 'triangle', 0.15, i * 0.14));
  [262, 330, 392].forEach((f) => tone(f, 1.0, 'sine', 0.08, 0.9));
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
  show('settingsPanel');
};
$('settingsClose').onclick = () => hide('settingsPanel');
$('optMaster').onchange = (e) => { soundSettings.master = e.target.checked; saveSound(); syncMuteIcon(); };
$('optTurn').onchange = (e) => { soundSettings.turn = e.target.checked; saveSound(); };
$('optFx').onchange = (e) => { soundSettings.fx = e.target.checked; saveSound(); };
$('optSitOut').onchange = (e) => {
  socket.emit('sitOut', { out: e.target.checked }, (r) => {
    if (!r || !r.ok) { e.target.checked = !e.target.checked; if (r && r.error) alert(r.error); }
  });
};

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
});

// 서버는 무늬를 숫자 0~3으로 보냄: 0=♠,1=♥,2=♦,3=♣
const SUIT_SYM = ['♠', '♥', '♦', '♣'];
const isRedSuit = (s) => s === 1 || s === 2;
const RANK_LBL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 10: '10' };
const rankLabel = (r) => RANK_LBL[r] || String(r);

// ---------- 입장 비밀번호 게이트 ----------
const GATE_PW = '0110';
function openLobby() { hide('gate'); show('lobby'); setTimeout(() => $('nameInput') && $('nameInput').focus(), 50); }
function submitGate() {
  if ($('gatePw').value.trim() === GATE_PW) {
    try { sessionStorage.setItem('dice_auth', '1'); } catch (e) {}
    openLobby();
  } else {
    $('gateError').textContent = '비밀번호가 올바르지 않습니다';
    $('gatePw').value = '';
    $('gatePw').focus();
  }
}
$('gateBtn').onclick = submitGate;
$('gatePw').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitGate(); });
try { if (sessionStorage.getItem('dice_auth') === '1') openLobby(); else $('gatePw').focus(); } catch (e) { $('gatePw').focus(); }

// ---------- 로비 탭 ----------
document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    const tab = t.dataset.tab;
    $('createPane').classList.toggle('hidden', tab !== 'create');
    $('joinPane').classList.toggle('hidden', tab !== 'join');
    $('roomsPane').classList.toggle('hidden', tab !== 'rooms');
    if (tab === 'rooms') refreshRooms();
  };
});

// ---------- 방 목록 ----------
$('refreshRooms').onclick = refreshRooms;
function refreshRooms() {
  socket.emit('listRooms', {}, (res) => {
    const box = $('roomList');
    if (!res || !res.ok) { box.innerHTML = '<div class="room-empty">불러오기 실패</div>'; return; }
    if (!res.rooms.length) { box.innerHTML = '<div class="room-empty">열려 있는 방이 없습니다. 새로 만들어 보세요!</div>'; return; }
    box.innerHTML = '';
    res.rooms.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'room-row';
      const statusCls = r.started ? (r.finished ? '' : 'play') : 'wait';
      const statusTxt = r.finished ? '종료' : (r.started ? '진행중' : '대기중');
      const info = r.started
        ? `${r.humans}명 · 핸드 #${r.handNumber}${r.blinds ? ` · 블라인드 ${r.blinds.sb}/${r.blinds.bb}` : ''}`
        : `${r.humans}명 대기 · 방장 ${esc(r.hostName)}`;
      row.innerHTML =
        `<span class="rc">${r.code}</span>` +
        `<span class="rinfo"><span class="rstat ${statusCls}">${statusTxt}</span><br>${info}</span>`;
      const btnWrap = document.createElement('div');
      if (!r.started) {
        const b = document.createElement('button');
        b.className = 'join-btn'; b.textContent = '참여';
        b.onclick = () => joinRoom(r.code);
        btnWrap.appendChild(b);
      } else if (!r.finished) {
        const b = document.createElement('button');
        b.className = 'spec-btn'; b.textContent = '관전';
        b.onclick = () => spectateRoom(r.code);
        btnWrap.appendChild(b);
      }
      row.appendChild(btnWrap);
      box.appendChild(row);
    });
  });
}
function joinRoom(code) {
  const name = getName(); if (!name) return;
  myName = name;
  socket.emit('join', { code, name }, (res) => {
    if (!res.ok) return ($('lobbyError').textContent = res.error);
    myId = res.youId;
    enterWaiting(code);
  });
}
function spectateRoom(code) {
  socket.emit('spectate', { code }, (res) => {
    if (!res.ok) return ($('lobbyError').textContent = res.error);
    myId = res.youId; isSpectator = true;
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
  myName = name;
  socket.emit('create', {
    name,
    settings: {
      levelMinutes: $('levelMinutes').value,
      actionSeconds: $('actionSeconds').value,
      startBB: $('startBB').value,
    },
  }, (res) => {
    if (!res.ok) return ($('lobbyError').textContent = res.error);
    myId = res.youId; isHost = true;
    enterWaiting(res.code);
  });
};

$('joinBtn').onclick = () => {
  const name = getName(); if (!name) return;
  myName = name;
  const code = $('codeInput').value.trim().toUpperCase();
  if (!code) return ($('lobbyError').textContent = '방 코드를 입력하세요');
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
    if (!res.ok) alert(res.error);
  });
};

// 대기 테이블 배너의 시작/복사 버튼
$('wbStart').onclick = () => {
  socket.emit('start', {}, (res) => { if (!res.ok) alert(res.error); });
};
$('wbCopy').onclick = () => {
  navigator.clipboard?.writeText(myRoomCode);
  $('wbCopy').textContent = '복사됨!';
  setTimeout(() => ($('wbCopy').textContent = '복사'), 1500);
};
$('wbLeave').onclick = () => {
  if (!confirm('대기 중인 방에서 나갈까요?')) return;
  socket.emit('leave', {}, () => {
    document.body.classList.remove('waiting-mode');
    $('waitBanner').classList.add('hidden');
    lastState = null; prevSnap = null; myRoomCode = ''; isHost = false; isSpectator = false;
    _seatSig = ''; _commSig = ''; _seenPlayerIds = new Set(); _playersInit = false;
    _recentJoiners.clear(); _recentAllIn.clear(); _recentBust.clear();
    hide('game'); hide('waiting'); show('lobby');
  });
};

let currentBotCount = 0;
let currentHumanCount = 1;
function setBots(n) {
  n = Math.max(0, Math.min(n, 9 - currentHumanCount));
  socket.emit('setBots', { count: n }, (res) => {
    if (!res.ok) alert(res.error);
  });
}
$('botMinus').onclick = () => setBots(currentBotCount - 1);
$('botPlus').onclick = () => setBots(currentBotCount + 1);

// ---------- 상태 수신 ----------
let blindDeadline = null;
socket.on('state', (s) => {
  lastState = s;
  myId = s.youId;
  if (s.spectator) isSpectator = true;
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
  if (meNow) $('optSitOut').checked = !!meNow.sittingOut; // 자리 비움 토글 상태 반영
});

// 타이머 틱 (액션 제한 바 + 블라인드 카운트다운)
function fmtTime(sec) {
  sec = Math.max(0, Math.ceil(sec));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}
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
    const bar = document.querySelector('.seat.active .seat-timerbar-fill');
    if (bar) {
      bar.style.width = (frac * 100) + '%';
      bar.classList.toggle('warn', frac < 0.34);
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

socket.on('chat', ({ name, text }) => {
  const box = $('chatMessages');
  const div = document.createElement('div');
  div.innerHTML = `<span class="cname">${esc(name)}:</span> ${esc(text)}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
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
  $('wbStart').textContent = n <= 1 ? '혼자 시작 (봇 1명 자동)' : '게임 시작';
  $('wbHint').textContent = !isHost
    ? '방장이 게임을 시작하기를 기다리는 중...'
    : '빈 자리의 +로 봇을 추가하거나, 친구가 방 코드로 참여할 수 있어요. 준비되면 시작하세요.';
  renderWaitingSeats(s);
}

function renderWaitingSeats(s) {
  const seatsEl = $('seats');
  seatsEl.innerHTML = '';
  const TOTAL = 9; // 9-max 좌석을 모두 표시
  seatsEl.style.setProperty('--seat-scale', '0.72');
  const positions = ovalPositions(TOTAL);
  const me = s.players.find((p) => p.id === myId);
  const mySeat = me ? me.chair : 0;
  const bySeat = {};
  s.players.forEach((p) => { bySeat[p.chair] = p; });
  for (let seatIdx = 0; seatIdx < TOTAL; seatIdx++) {
    // 내 자리를 항상 화면 아래 중앙(visual 0)에 오도록 회전
    const visual = (seatIdx - mySeat + TOTAL) % TOTAL;
    const pos = positions[visual];
    const seat = document.createElement('div');
    seat.className = 'seat wait-seat';
    seat.style.left = pos.x + '%';
    seat.style.top = pos.y + '%';
    const p = bySeat[seatIdx];
    if (p) {
      const isMe = p.id === myId;
      seat.innerHTML = `
        <div class="seat-inner">
          <div class="pname">${esc(p.name)} ${isMe ? '<span class="tag you">나</span>' : ''} ${p.isBot ? '<span class="tag">봇</span>' : ''}</div>
          <div class="pchips"><span class="chip-mini"></span><span class="amt">${p.chips}</span></div>
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
    b.onclick = () => socket.emit('addBot', { seat: Number(b.dataset.seat) }, (r) => { if (!r.ok) alert(r.error); });
  });
  seatsEl.querySelectorAll('.bot-x').forEach((b) => {
    b.onclick = () => socket.emit('removeBot', { id: b.dataset.bot }, (r) => { if (!r.ok) alert(r.error); });
  });
}

let _potChipsFrom = 0;
let _winCards = new Set();

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

  $('handBadge').textContent = `${isSpectator ? '👁 관전 · ' : ''}핸드 #${s.handNumber}`;
  $('blindBadge').textContent = `블라인드 ${s.blinds.sb}/${s.blinds.bb}${s.blinds.ante ? ` (앤티 ${s.blinds.ante})` : ''}`;
  $('levelBadge').textContent = s.timedBlinds
    ? `레벨 ${s.level}`
    : `레벨 ${s.level} · 다음까지 ${s.nextLevelIn + 1}핸드`;
  $('potBadge').textContent = `팟 ${s.pot}`;

  // 커뮤니티 카드 (새로 깔린 카드는 플립 인 애니). 변화 없을 땐 DOM 유지 → 클릭마다 깜빡임 방지
  const comm = $('community');
  const commSig = s.handNumber + '|' + s.community.map((c) => c.r + '-' + c.s).join(',');
  if (commSig !== _commSig) {
    _commSig = commSig;
    comm.innerHTML = '';
    s.community.forEach((c, idx) => {
      const el = cardEl(c);
      if (idx >= _newCommFrom) {
        el.classList.add('flip-in');
        el.style.animationDelay = ((idx - _newCommFrom) * 0.12) + 's';
      }
      comm.appendChild(el);
    });
  }
  $('potDisplay').textContent = s.pot > 0 ? `팟: ${s.pot}` : '';
  renderPotStack(s);

  renderSeats(s);
  animateChips(s, prev ? prev.chips : null);
  renderActions(s);
  renderLog(s);
  renderWinner(s);

  handleFx(s, prev);
  prevSnap = {
    handNumber: s.handNumber,
    commCount: s.community.length,
    phase: s.phase,
    pot: s.pot,
    toActId: s.toActId,
    chips: chipMap(s),
    allInIds: s.players.filter((p) => p.allIn).map((p) => p.id),
    bustIds: s.players.filter((p) => p.eliminated).map((p) => p.id),
  };

  if (s.finished && s.finalResults) renderFinal(s);
}

function chipMap(s) {
  const m = {};
  s.players.forEach((p) => (m[p.id] = p.chips));
  return m;
}

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
    el.textContent = Math.round(from + diff * eased);
    if (k < 1) requestAnimationFrame(step);
    else el.textContent = to;
  }
  requestAnimationFrame(step);
}

// 사운드 + 효과 트리거
function handleFx(s, prev) {
  if (!prev) return; // 첫 렌더는 조용히
  const newHand = s.handNumber !== prev.handNumber;
  if (newHand) { sfxDeal(); if (_lastHandRecap) showRecapToast(_lastHandRecap); }
  else if (s.community.length > prev.commCount) sfxDeal();

  if (s.pot > prev.pot && !newHand) {
    bump($('potBadge'));
    bump($('potDisplay'));
    sfxChip();
  }
  if (s.toActId === myId && prev.toActId !== myId) { sfxTurn(); notifyMyTurn(); }
  if (s.toActId !== myId) stopTitleBlink();

  if (s.phase === 'handComplete' && prev.phase !== 'handComplete' && s.results) {
    sfxWin();
    flyPotToWinners(s);
    // 직전 핸드 요약 저장 → 다음 핸드 시작 시 토스트로 표시
    _lastHandRecap = (s.results.awards || []).map((a) =>
      `${a.winners.map((w) => esc(w.name)).join(', ')} +${a.amount}${a.handName ? ' · ' + esc(a.handName) : ''}`
    ).join(' / ');
  }

  // 올인 전환 감지 → 강렬 연출
  const prevAllIn = new Set(prev.allInIds || []);
  s.players.forEach((p) => {
    if (p.allIn && !prevAllIn.has(p.id)) {
      _recentAllIn.set(p.id, Date.now() + 1500);
      showAllInFx(p.name);
      sfxAllIn();
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
    if (conts.length === 2) showHeadsUpBattle(conts[0], conts[1]);
  }
}

// 올인 전체화면 연출
let _allinTimer = null;
function showAllInFx(name) {
  let ov = document.getElementById('allinFx');
  if (!ov) { ov = document.createElement('div'); ov.id = 'allinFx'; document.body.appendChild(ov); }
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
function cssEsc(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
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
  // 인원이 많을수록 좌석을 축소해 겹침 방지
  seatsEl.style.setProperty('--seat-scale', n <= 4 ? '1' : n <= 6 ? '0.86' : '0.74');
  // 나를 맨 아래(6시 방향)에 배치
  const meIdx = Math.max(0, players.findIndex((p) => p.id === myId));
  const positions = ovalPositions(n);
  // 게임 도중 새로 합류한 플레이어 감지 → 등장 애니 + 토스트
  const currentIds = players.map((p) => p.id);
  if (_playersInit) {
    currentIds.forEach((id) => {
      if (!_seenPlayerIds.has(id)) {
        _recentJoiners.set(id, Date.now() + 1500);
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
    const isMe = p.id === myId;
    let seat = full ? null : seatsEl.querySelector(`.seat[data-pid="${cssEsc(p.id)}"]`);
    if (!seat) {
      // 신규 생성(전체 재생성 또는 새 좌석)
      seat = document.createElement('div');
      seat.dataset.pid = p.id;
      const pos = positions[i];
      seat.style.left = (isMe ? 50 : pos.x) + '%';
      seat.style.top = (isMe ? 88 : pos.y) + '%';
      const result = s.results?.reveal?.find((r) => r.id === p.id);
      seat.innerHTML = `
        <div class="seat-inner">
          ${p.isButton ? '<div class="pbadges"><span class="dealer-btn">D</span></div>' : ''}
          <div class="pname">${seatNameTags(p)}</div>
          <div class="pchips">${p.eliminated ? '탈락' : `<span class="chip-mini"></span><span class="amt">${p.chips}</span>`}</div>
          ${p.isToAct ? '<div class="seat-timerbar"><div class="seat-timerbar-fill"></div></div>' : ''}
          <div class="phole">${renderHole(p, i)}</div>
          <div class="hand-result">${result ? esc(result.handName) : ''}</div>
          ${seatEquityHtml(s, p)}
          ${p.bet > 0 ? `<div class="bet-chip">${p.bet}</div>` : ''}
        </div>`;
      seatsEl.appendChild(seat);
    } else {
      // 같은 핸드 내 베팅 갱신: DOM을 헐지 않고 변한 부분만 갱신(애니메이션 재생 방지)
      updateSeatInPlace(seat, p, s);
    }
    seat.className = seatClasses(s, p, isMe);
  }
}

function seatNameTags(p) {
  return `${esc(p.name)} ${p.id === myId ? '<span class="tag you">나</span>' : ''} ${p.isBot ? '<span class="tag">봇</span>' : ''} ${(!p.connected && !p.isBot) ? '<span class="tag off">끊김</span>' : ''} ${(p.sittingOut && !p.eliminated) ? '<span class="tag sitout">자리비움</span>' : ''} ${(p.penaltyShort && !p.eliminated) ? '<span class="tag short">⏱단축</span>' : ''} ${p.allIn ? '<span class="tag allin">ALL-IN</span>' : ''}`;
}
function seatClasses(s, p, isMe) {
  const isWinner = s.results && s.phase === 'handComplete' &&
    s.results.awards?.some((a) => a.winners.some((w) => w.id === p.id));
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
    + (isWinner ? ' winner' : '');
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
  if (pname) pname.innerHTML = seatNameTags(p);
  // 타임바: 차례일 때만 표시
  let tb = inner.querySelector('.seat-timerbar');
  if (p.isToAct && !tb) {
    tb = document.createElement('div');
    tb.className = 'seat-timerbar';
    tb.innerHTML = '<div class="seat-timerbar-fill"></div>';
    inner.querySelector('.phole').before(tb);
  } else if (!p.isToAct && tb) {
    tb.remove();
  }
  // 베팅 칩: 값이 바뀔 때만 갱신(매 렌더 chipPop 재생 방지)
  let chip = inner.querySelector('.bet-chip');
  if (p.bet > 0) {
    if (!chip) { chip = document.createElement('div'); chip.className = 'bet-chip'; chip.textContent = p.bet; inner.appendChild(chip); }
    else if (chip.textContent !== String(p.bet)) chip.textContent = p.bet;
  } else if (chip) {
    chip.remove();
  }
  // 칩 수량은 animateChips()가 롤링 처리
}

function renderHole(p, seatIdx = 0) {
  if (!p.hole) return '';
  return p.hole.map((c, ci) => {
    let extra = '', style = '';
    if (_dealNewHand) {
      extra = 'deal-in';
      const delay = (seatIdx * 0.12 + ci * 0.07).toFixed(2);
      style = `style="animation-delay:${delay}s"`;
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
  const cx = 50, cy = 49, rx = mobile ? 39 : 48, ry = mobile ? 43 : 37;
  for (let i = 0; i < n; i++) {
    const angle = Math.PI / 2 + (2 * Math.PI * i) / n; // 90도(아래)에서 시작
    out.push({
      x: cx + rx * Math.cos(angle),
      y: cy + ry * Math.sin(angle),
    });
  }
  return out;
}

function renderActions(s) {
  const bar = $('actionbar');
  bar.innerHTML = '';
  if (s.finished) return;
  if (s.paused) {
    bar.innerHTML = '<span class="waiting-turn">자리 비움으로 대기 중 — 인원이 모이면 자동 재개됩니다</span>';
    return;
  }
  const me = s.players.find((p) => p.id === myId);
  if (!me || me.eliminated || me.chips <= 0) {
    bar.innerHTML = '<span class="waiting-turn">관전 중...</span>';
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

  // 폴드
  mainRow.appendChild(btn('btn-fold', '폴드', () => act('fold')));

  // 체크 / 콜
  if (checkAct) mainRow.appendChild(btn('btn-check', '체크', () => act('check')));
  else if (callAct) mainRow.appendChild(btn('btn-call', `콜 ${callAct.amount}`, () => act('call')));

  // 레이즈/벳 — 사이징 행(슬라이더·퀵벳) 위, 메인 버튼 아래
  if (raiseAct) {
    const min = raiseAct.min, max = raiseAct.max;
    const label = raiseAct.type === 'bet' ? '벳' : '레이즈';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = min; slider.max = max; slider.value = min; slider.step = Math.max(1, s.blinds.sb);
    const amt = document.createElement('span');
    amt.className = 'raise-amount';
    amt.textContent = min;

    const goBtn = btn('btn-raise', `${label} ${min}`, () => act('raise', parseInt(slider.value, 10)));
    const setVal = (v) => {
      v = Math.max(min, Math.min(max, Math.floor(v)));
      slider.value = v; amt.textContent = v; goBtn.textContent = `${label} ${v}`;
    };
    slider.oninput = () => setVal(slider.value);

    // 팟 기준 베팅 금액 계산 (콜 후 팟 대비 비율)
    const myBet = me.bet || 0;
    const toCall = callAct ? callAct.amount : 0;
    const currentBet = myBet + toCall;
    const potAfterCall = s.pot + toCall;
    const potBet = (frac) => Math.max(min, Math.min(max, currentBet + Math.round(frac * potAfterCall)));

    // ½팟 / ⅔팟 / 팟 — 누르면 즉시 레이즈
    const quick = document.createElement('div');
    quick.className = 'quick-bets';
    quick.appendChild(qbtn('½팟', () => act('raise', potBet(0.5))));
    quick.appendChild(qbtn('⅔팟', () => act('raise', potBet(2 / 3))));
    quick.appendChild(qbtn('팟', () => act('raise', potBet(1))));

    raiseRow.appendChild(quick);
    raiseRow.appendChild(slider);
    raiseRow.appendChild(amt);
    mainRow.appendChild(goBtn); // 레이즈 버튼: 슬라이더로 금액 조절 후 사용
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
function qbtn(label, fn) {
  const b = document.createElement('button'); b.textContent = label; b.onclick = fn; return b;
}

function act(type, amount) {
  socket.emit('action', { type, amount }, (res) => {
    if (!res.ok) flashError(res.error);
  });
}

function renderLog(s) {
  const log = $('log');
  log.innerHTML = (s.log || []).map((l) => `<div>${esc(l.msg)}</div>`).join('');
  log.scrollTop = log.scrollHeight;
}

function renderWinner(s) {
  const banner = $('winnerBanner');
  if (s.results && s.phase === 'handComplete') {
    const lines = s.results.awards.map((a) =>
      `${a.winners.map((w) => esc(w.name)).join(', ')} +${a.amount}${a.handName ? ' · ' + esc(a.handName) : ''}`
    );
    banner.innerHTML = lines.join('<br>');
    banner.classList.remove('hidden');
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
  ol.innerHTML = ranked.map((r) =>
    `<li class="${r.place === 1 ? 'first' : ''}">${r.place}위 — ${esc(r.name)} ${r.place === 1 ? '🏆' : ''}</li>`
  ).join('');
  show('finalScreen');
  if (!finalShown) {
    finalShown = true;
    launchConfetti();
    sfxFanfare();
  }
}

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

// ---------- 채팅 ----------
$('chatSend').onclick = sendChat;
$('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
function sendChat() {
  const t = $('chatInput').value.trim();
  if (!t) return;
  socket.emit('chat', { text: t });
  $('chatInput').value = '';
}

// ---------- 유틸 ----------
function esc(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
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
