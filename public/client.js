const socket = io();
let myId = null;
let myName = '';
let isHost = false;
let lastState = null;
let isSpectator = false;
let prevSnap = null;        // 직전 상태 스냅샷 (애니메이션/사운드 diff용)
let _dealNewHand = false;   // 이번 렌더에서 홀카드 딜링 애니 적용?
let _newCommFrom = 99;      // 이 인덱스부터의 커뮤니티 카드는 새 카드(플립 애니)

const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove('hidden');
const hide = (id) => $(id).classList.add('hidden');

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

// PWA 서비스워커 등록
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// ---------- 이모지 리액션 ----------
const EMOJIS = ['😎', '🔥', '😱', '😂', '😭', '👍', '🤔', '🎉'];
(function buildEmojiBar() {
  const bar = $('emojiBar');
  if (!bar) return;
  EMOJIS.forEach((e) => {
    const b = document.createElement('button');
    b.className = 'emoji-btn'; b.textContent = e;
    b.onclick = () => { if (!isSpectator) socket.emit('react', { emoji: e }); };
    bar.appendChild(b);
  });
})();
socket.on('reaction', ({ id, emoji }) => {
  const seat = document.querySelector(`.seat[data-pid="${cssEsc(id)}"]`);
  if (!seat) return;
  const el = document.createElement('div');
  el.className = 'reaction-float';
  el.textContent = emoji;
  seat.appendChild(el);
  setTimeout(() => el.remove(), 1700);
  sfxEmoji();
});

// 서버는 무늬를 숫자 0~3으로 보냄: 0=♠,1=♥,2=♦,3=♣
const SUIT_SYM = ['♠', '♥', '♦', '♣'];
const isRedSuit = (s) => s === 1 || s === 2;
const RANK_LBL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 10: '10' };
const rankLabel = (r) => RANK_LBL[r] || String(r);

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
      startingChips: $('startingChips').value,
      levelMinutes: $('levelMinutes').value,
      actionSeconds: $('actionSeconds').value,
      rebuy: $('rebuyOpt').checked,
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

function enterWaiting(code) {
  hide('lobby');
  show('waiting');
  $('roomCode').textContent = code;
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
  if (!s.started) { renderWaiting(s); return; }
  hide('lobby'); hide('waiting'); show('game');
  renderGame(s);
});

// 타이머 틱 (액션 제한 바 + 블라인드 카운트다운)
function fmtTime(sec) {
  sec = Math.max(0, Math.ceil(sec));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}
function tickTimers() {
  const s = lastState;
  const at = $('actionTimer');
  if (!s || !s.started || s.finished) { if (at) at.classList.add('hidden'); return; }
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
    // 내 차례 마지막 구간 째깍 소리 (음소거 토글로 끌 수 있음)
    if (s.toActId === myId && rem > 0) {
      const sec = Math.ceil(rem / 1000);
      if (sec <= 5 && sec !== lastTickSec) { lastTickSec = sec; sfxTick(sec <= 2); }
    } else {
      lastTickSec = null;
    }
  } else {
    lastTickSec = null;
  }
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

function renderWaiting(s) {
  const ul = $('waitingPlayers');
  ul.innerHTML = '';
  s.players.forEach((p, i) => {
    const li = document.createElement('li');
    const tag = p.id === myId ? '<span class="tag you">나</span>' : (p.isBot ? '<span class="tag">봇</span>' : '');
    li.innerHTML = `<span>${esc(p.name)} ${tag}</span>` +
      (i === 0 ? '<span class="host-tag">방장</span>' : '');
    ul.appendChild(li);
  });
  isHost = s.players[0]?.id === myId;
  currentBotCount = s.players.filter((p) => p.isBot).length;
  currentHumanCount = s.players.filter((p) => !p.isBot).length;
  $('startBtn').classList.toggle('hidden', !isHost);

  $('botControl').classList.toggle('hidden', !isHost);
  $('botCount').textContent = currentBotCount;
  $('botMinus').disabled = currentBotCount <= 0;
  $('botPlus').disabled = s.players.length >= 9;

  $('waitHint').textContent = !isHost
    ? '방장이 시작하기를 기다리는 중...'
    : (s.players.length < 2
      ? '봇 수를 정하거나, 혼자 시작하면 테스트 봇이 자동으로 1명 들어옵니다.'
      : '준비되면 게임을 시작하세요.');
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

  // 커뮤니티 카드 (새로 깔린 카드는 플립 인 애니)
  const comm = $('community');
  comm.innerHTML = '';
  s.community.forEach((c, idx) => {
    const el = cardEl(c);
    if (idx >= _newCommFrom) {
      el.classList.add('flip-in');
      el.style.animationDelay = ((idx - _newCommFrom) * 0.12) + 's';
    }
    comm.appendChild(el);
  });
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
  };

  if (s.finished && s.finalResults) renderFinal(s);
}

function chipMap(s) {
  const m = {};
  s.players.forEach((p) => (m[p.id] = p.chips));
  return m;
}

// 팟 칩 더미: 팟 크기에 비례해 칩 개수 계산 후 컬럼으로 쌓기
const CHIP_COLORS = ['#e25555', '#3ec97a', '#4a8cff', '#2b2f36', '#e8c466', '#9b59b6'];
function potChipCount(pot) {
  if (pot <= 0) return 0;
  return Math.min(30, Math.max(1, Math.round(pot / 25)));
}
function renderPotStack(s) {
  const el = $('potStack');
  el.innerHTML = '';
  const count = potChipCount(s.pot);
  if (!count) return;
  const perCol = 6;
  const cols = Math.ceil(count / perCol);
  let idx = 0;
  for (let c = 0; c < cols; c++) {
    const col = document.createElement('div');
    col.className = 'chip-col';
    const n = Math.min(perCol, count - c * perCol);
    col.style.height = (n * 6 + 13) + 'px';
    for (let r = 0; r < n; r++) {
      const chip = document.createElement('div');
      chip.className = 'chip-s';
      chip.style.bottom = (r * 6) + 'px';
      chip.style.setProperty('--cc', CHIP_COLORS[(idx) % CHIP_COLORS.length]);
      chip.style.zIndex = r;
      if (idx >= _potChipsFrom) {
        chip.classList.add('drop');
        chip.style.animationDelay = ((idx - _potChipsFrom) * 0.04) + 's';
      }
      col.appendChild(chip);
      idx++;
    }
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
  if (newHand) sfxDeal();
  else if (s.community.length > prev.commCount) sfxDeal();

  if (s.pot > prev.pot && !newHand) {
    bump($('potBadge'));
    bump($('potDisplay'));
    sfxChip();
  }
  if (s.toActId === myId && prev.toActId !== myId) sfxTurn();

  if (s.phase === 'handComplete' && prev.phase !== 'handComplete' && s.results) {
    sfxWin();
    flyPotToWinners(s);
  }
}

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

function renderSeats(s) {
  const seatsEl = $('seats');
  seatsEl.innerHTML = '';
  const players = s.players;
  const n = players.length;
  // 나를 맨 아래(6시 방향)에 배치
  const meIdx = Math.max(0, players.findIndex((p) => p.id === myId));
  const positions = ovalPositions(n);
  for (let i = 0; i < n; i++) {
    const p = players[(meIdx + i) % n];
    const pos = positions[i];
    const seat = document.createElement('div');
    seat.className = 'seat';
    seat.dataset.pid = p.id;
    if (p.isToAct) seat.classList.add('active');
    if (p.isToAct && p.id === myId) seat.classList.add('myturn');
    if (p.folded) seat.classList.add('folded');
    if (p.eliminated) seat.classList.add('eliminated');
    if (!p.connected && !p.isBot && !p.eliminated) seat.classList.add('disconnected');
    const isWinner = s.results && s.phase === 'handComplete' &&
      s.results.awards?.some((a) => a.winners.some((w) => w.id === p.id));
    if (isWinner) seat.classList.add('winner');
    seat.style.left = pos.x + '%';
    seat.style.top = pos.y + '%';

    const result = s.results?.reveal?.find((r) => r.id === p.id);
    seat.innerHTML = `
      <div class="seat-inner">
        ${p.isButton ? '<div class="pbadges"><span class="dealer-btn">D</span></div>' : ''}
        <div class="pname">${esc(p.name)} ${p.id === myId ? '<span class="tag you">나</span>' : ''} ${p.isBot ? '<span class="tag">봇</span>' : ''} ${(!p.connected && !p.isBot) ? '<span class="tag off">끊김</span>' : ''} ${p.allIn ? '<span class="tag allin">ALL-IN</span>' : ''}</div>
        <div class="pchips">${p.eliminated ? '탈락' : `<span class="chip-mini"></span><span class="amt">${p.chips}</span>`}</div>
        ${p.isToAct ? '<div class="seat-timerbar"><div class="seat-timerbar-fill"></div></div>' : ''}
        <div class="phole">${renderHole(p, i)}</div>
        <div class="hand-result">${result ? esc(result.handName) : ''}</div>
        ${p.bet > 0 ? `<div class="bet-chip">${p.bet}</div>` : ''}
      </div>`;
    seatsEl.appendChild(seat);
  }
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
  const cx = 50, cy = 49, rx = 46, ry = 37;
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
  const me = s.players.find((p) => p.id === myId);
  if (!me || me.eliminated || me.chips <= 0) {
    bar.innerHTML = '';
    if (s.canRebuy) {
      bar.appendChild(btn('btn-call', `🔄 리바이 +${s.startingChips}`, doRebuy));
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

    const pot = s.pot;
    const quick = document.createElement('div');
    quick.className = 'quick-bets';
    quick.appendChild(qbtn('½팟', () => setVal(pot * 0.5)));
    quick.appendChild(qbtn('팟', () => setVal(pot)));
    quick.appendChild(qbtn('올인', () => setVal(max)));

    raiseRow.appendChild(quick);
    raiseRow.appendChild(slider);
    raiseRow.appendChild(amt);
    mainRow.appendChild(goBtn);
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
function doRebuy() {
  socket.emit('rebuy', {}, (res) => { if (!res.ok) flashError(res.error); });
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
