const socket = io();
let myId = null;
let myName = '';
let isHost = false;
let lastState = null;

const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove('hidden');
const hide = (id) => $(id).classList.add('hidden');

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
  };
});

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
      handsPerLevel: $('handsPerLevel').value,
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

$('addBotBtn').onclick = () => {
  socket.emit('addBot', {}, (res) => {
    if (!res.ok) alert(res.error);
  });
};

// ---------- 상태 수신 ----------
socket.on('state', (s) => {
  lastState = s;
  myId = s.youId;
  if (!s.started) { renderWaiting(s); return; }
  hide('lobby'); hide('waiting'); show('game');
  renderGame(s);
});

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
  $('startBtn').classList.toggle('hidden', !isHost);
  $('addBotBtn').classList.toggle('hidden', !isHost || s.players.length >= 9);
  $('waitHint').textContent = !isHost
    ? '방장이 시작하기를 기다리는 중...'
    : (s.players.length < 2
      ? '혼자 시작하면 테스트용 봇이 자동으로 들어옵니다. (봇 추가로 더 늘릴 수 있어요)'
      : '준비되면 게임을 시작하세요.');
}

// ---------- 게임 렌더 ----------
function renderGame(s) {
  $('handBadge').textContent = `핸드 #${s.handNumber}`;
  $('blindBadge').textContent = `블라인드 ${s.blinds.sb}/${s.blinds.bb}${s.blinds.ante ? ` (앤티 ${s.blinds.ante})` : ''}`;
  $('levelBadge').textContent = `레벨 ${s.level} · 다음까지 ${s.nextLevelIn + 1}핸드`;
  $('potBadge').textContent = `팟 ${s.pot}`;

  // 커뮤니티 카드
  const comm = $('community');
  comm.innerHTML = '';
  for (const c of s.community) comm.appendChild(cardEl(c));
  $('potDisplay').textContent = s.pot > 0 ? `팟: ${s.pot}` : '';

  renderSeats(s);
  renderActions(s);
  renderLog(s);
  renderWinner(s);

  if (s.finished && s.finalResults) renderFinal(s);
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
    if (p.isToAct) seat.classList.add('active');
    if (p.folded) seat.classList.add('folded');
    if (p.eliminated) seat.classList.add('eliminated');
    seat.style.left = pos.x + '%';
    seat.style.top = pos.y + '%';

    const result = s.results?.reveal?.find((r) => r.id === p.id);
    seat.innerHTML = `
      <div class="seat-inner">
        ${p.isButton ? '<div class="pbadges"><span class="dealer-btn">D</span></div>' : ''}
        <div class="pname">${esc(p.name)} ${p.id === myId ? '<span class="tag you">나</span>' : ''} ${p.isBot ? '<span class="tag">봇</span>' : ''} ${p.allIn ? '<span class="tag allin">ALL-IN</span>' : ''}</div>
        <div class="pchips">${p.eliminated ? '탈락' : '💰 ' + p.chips}</div>
        <div class="phole">${renderHole(p)}</div>
        <div class="hand-result">${result ? esc(result.handName) : ''}</div>
        ${p.bet > 0 ? `<div class="bet-chip">${p.bet}</div>` : ''}
      </div>`;
    seatsEl.appendChild(seat);
  }
}

function renderHole(p) {
  if (!p.hole) return '';
  return p.hole.map((c) => {
    if (c.hidden) return cardHtml(null, true, p.folded);
    return cardHtml(c, false, p.folded);
  }).join('');
}

function ovalPositions(n) {
  // 타원 둘레에 좌석 배치. index0 = 6시(아래 중앙)
  const out = [];
  const cx = 50, cy = 50, rx = 46, ry = 44;
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
  if (!me || me.eliminated) { bar.innerHTML = '<span class="waiting-turn">관전 중...</span>'; return; }

  if (!s.legal) {
    const who = s.players.find((p) => p.id === s.toActId);
    bar.innerHTML = `<span class="waiting-turn">${who ? esc(who.name) + ' 차례...' : '다음 핸드 준비 중...'}</span>`;
    return;
  }

  const callAct = s.legal.find((a) => a.type === 'call');
  const raiseAct = s.legal.find((a) => a.type === 'raise' || a.type === 'bet');

  // 폴드
  const fold = btn('btn-fold', '폴드', () => act('fold'));
  bar.appendChild(fold);

  // 체크/콜
  if (s.legal.find((a) => a.type === 'check')) {
    bar.appendChild(btn('btn-check', '체크', () => act('check')));
  } else if (callAct) {
    bar.appendChild(btn('btn-call', `콜 ${callAct.amount}`, () => act('call')));
  }

  // 레이즈/벳
  if (raiseAct) {
    const wrap = document.createElement('div');
    wrap.className = 'raise-controls';
    const min = raiseAct.min, max = raiseAct.max;
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = min; slider.max = max; slider.value = min; slider.step = Math.max(1, s.blinds.sb);
    const amt = document.createElement('span');
    amt.className = 'raise-amount';
    amt.textContent = min;
    slider.oninput = () => (amt.textContent = slider.value);

    const pot = s.pot;
    const quick = document.createElement('div');
    quick.className = 'quick-bets';
    const setVal = (v) => { v = Math.max(min, Math.min(max, Math.floor(v))); slider.value = v; amt.textContent = v; };
    quick.appendChild(qbtn('½팟', () => setVal(pot * 0.5)));
    quick.appendChild(qbtn('팟', () => setVal(pot)));
    quick.appendChild(qbtn('올인', () => setVal(max)));

    const label = raiseAct.type === 'bet' ? '벳' : '레이즈';
    const goBtn = btn('btn-raise', label, () => act('raise', parseInt(slider.value, 10)));

    wrap.appendChild(slider);
    wrap.appendChild(amt);
    wrap.appendChild(quick);
    wrap.appendChild(goBtn);
    bar.appendChild(wrap);
  }
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

function renderFinal(s) {
  const ol = $('finalRanks');
  const ranked = [...s.finalResults].sort((a, b) => a.place - b.place);
  ol.innerHTML = ranked.map((r) =>
    `<li class="${r.place === 1 ? 'first' : ''}">${r.place}위 — ${esc(r.name)} ${r.place === 1 ? '🏆' : ''}</li>`
  ).join('');
  show('finalScreen');
}

// ---------- 카드 렌더 ----------
function cardHtml(c, back, muck) {
  if (back || !c) return `<div class="card sm back"></div>`;
  const red = isRedSuit(c.s);
  return `<div class="card sm ${red ? 'red' : 'black'} ${muck ? 'muck' : ''}">
    <span class="rank">${rankLabel(c.r)}</span><span class="suit">${SUIT_SYM[c.s]}</span>
  </div>`;
}

// 커뮤니티 카드는 큰 사이즈
function cardEl(c) {
  const tmp = document.createElement('div');
  const red = isRedSuit(c.s);
  tmp.innerHTML = `<div class="card ${red ? 'red' : 'black'}">
    <span class="rank">${rankLabel(c.r)}</span><span class="suit">${SUIT_SYM[c.s]}</span></div>`;
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
