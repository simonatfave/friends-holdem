import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import { Game, defaultBlindSchedule } from './src/game.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

// 정적 파일은 항상 최신을 받도록 캐시 비활성화 (업데이트 즉시 반영)
app.use(
  express.static(join(__dirname, 'public'), {
    etag: true,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  })
);
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const PORT = process.env.PORT || 3000;

// ---------- 계정 시스템 (파일 기반) ----------
const USERS_FILE = process.env.USERS_FILE || join(__dirname, 'users.json');
const users = new Map(); // nickLower -> account
function loadUsers() {
  try {
    if (!existsSync(USERS_FILE)) return;
    const data = JSON.parse(readFileSync(USERS_FILE, 'utf8'));
    for (const u of data) users.set(u.nick.toLowerCase(), u);
    console.log(`계정 ${users.size}개 로드`);
  } catch (e) { console.error('계정 로드 실패:', e.message); }
}
let _usersTimer = null;
function saveUsersSoon() {
  if (_usersTimer) return;
  _usersTimer = setTimeout(() => {
    _usersTimer = null;
    try { writeFileSync(USERS_FILE, JSON.stringify([...users.values()])); }
    catch (e) { console.error('계정 저장 실패:', e.message); }
  }, 1000);
}
function hashPw(pw, salt) { return scryptSync(String(pw), salt, 32).toString('hex'); }
function makeAccount(nick, pw) {
  const salt = randomBytes(12).toString('hex');
  return {
    nick, salt, hash: hashPw(pw, salt), createdAt: Date.now(),
    balance: 1000, // 시작 포인트(밸런스)
    stats: { games: 0, wins: 0, handsWon: 0, biggestPot: 0, bestPlace: null },
    history: [], // 최근 게임 결과(최신이 앞)
  };
}
function verifyPw(acc, pw) {
  try {
    const a = Buffer.from(acc.hash, 'hex');
    const b = scryptSync(String(pw), acc.salt, 32);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch (e) { return false; }
}
function profileOf(acc) {
  return { nick: acc.nick, balance: acc.balance, stats: acc.stats, history: acc.history.slice(0, 20) };
}

// ---------- 방 관리 ----------
const rooms = new Map(); // code -> { game, hostId, timer, settings }

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

// ---------- 상태 영속화 (재시작/재배포에도 진행 중 게임 복구) ----------
const SAVE_FILE = process.env.SAVE_FILE || join(__dirname, 'rooms.json');

// 칩 보존: 베팅 진행 중이면 chips+committed(핸드 전 스택), 정산 후면 chips 그대로
function settledChips(g, p) {
  if (g.hand && g.hand.phase !== 'handComplete') {
    return p.chips + ((g.hand.committed && g.hand.committed[p.id]) || 0);
  }
  return p.chips;
}
function serializeRooms() {
  const out = [];
  for (const [code, room] of rooms) {
    const g = room.game;
    if (g.finished) continue; // 끝난 게임은 저장 안 함
    out.push({
      code,
      hostId: room.hostId,
      actionLimit: room.actionLimit,
      maxPlayers: room.maxPlayers || 9,
      secret: !!room.secret,
      game: {
        startingChips: g.startingChips,
        levelDurationSec: g.levelDurationSec,
        levelDurations: g.levelDurations,
        handsPerLevel: g.handsPerLevel,
        blindSchedule: g.blindSchedule,
        started: g.started,
        button: g.button,
        level: g.level,
        handNumber: g.handNumber,
        startedAt: g.startedAt,
        results: g.results,
        players: g.players.map((p) => ({
          id: p.id, name: p.name, chips: settledChips(g, p), chair: p.chair,
          isBot: p.isBot, eliminated: p.eliminated, sittingOut: p.sittingOut,
        })),
      },
    });
  }
  return out;
}
let _saveTimer = null;
function saveRoomsSoon() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try { writeFileSync(SAVE_FILE, JSON.stringify(serializeRooms())); }
    catch (e) { console.error('상태 저장 실패:', e.message); }
  }, 1500);
}
function loadRooms() {
  try {
    if (!existsSync(SAVE_FILE)) return;
    const data = JSON.parse(readFileSync(SAVE_FILE, 'utf8'));
    for (const r of data) {
      const rg = r.game;
      const g = new Game({
        startingChips: rg.startingChips,
        levelDurationSec: rg.levelDurationSec,
        levelDurations: rg.levelDurations,
        handsPerLevel: rg.handsPerLevel,
        blindSchedule: rg.blindSchedule,
      });
      g.players = rg.players.map((p) => ({
        ...p, connected: false, socketId: null,
      }));
      g.button = rg.button ?? -1;
      g.level = rg.level ?? 0;
      g.handNumber = rg.handNumber ?? 0;
      g.startedAt = rg.startedAt ?? null;
      g.started = !!rg.started;
      g.finished = false;
      g.results = rg.results || [];
      const room = { game: g, hostId: r.hostId, actionLimit: r.actionLimit, maxPlayers: r.maxPlayers || 9, secret: !!r.secret, restoredAt: Date.now() };
      rooms.set(r.code, room);
      // 진행 중이었으면 새 핸드로 재개(중단된 핸드는 버림, 칩은 핸드 전 스택으로 보존)
      if (g.started) {
        const playable = g.players.filter((p) => !p.eliminated && p.chips > 0 && !p.sittingOut);
        if (playable.length >= 2) {
          g.startHand();
          startActionTimer(r.code); // 끊긴 플레이어는 타이머가 자동 폴드하지 않음(대기)
          scheduleNextHand(r.code);
          maybeBotAct(r.code);
          driveRunout(r.code);
        } else {
          g.paused = true;
        }
      }
    }
    if (rooms.size) console.log(`이전 상태 복구: ${rooms.size}개 방`);
  } catch (e) { console.error('상태 복구 실패:', e.message); }
}

function stateFor(room, viewerId) {
  const st = room.game.getStateFor(viewerId);
  st.actionDeadline = room.actionDeadline || null;
  st.actionLimit = room.actionLimitEffective || room.actionLimit || null;
  st.spectator = room.spectators ? room.spectators.has(viewerId) : false;
  st.isHost = room.hostId === viewerId;
  st.maxPlayers = room.maxPlayers || 9;
  st.secret = !!room.secret;
  return st;
}
function broadcast(code) {
  const room = rooms.get(code);
  if (!room) return;
  const { game } = room;
  for (const p of game.players) {
    if (p.socketId) io.to(p.socketId).emit('state', stateFor(room, p.id));
  }
  if (room.spectators) {
    for (const sid of room.spectators) io.to(sid).emit('state', stateFor(room, sid));
  }
  tallyHand(code);          // 핸드 승자 통계 누적
  recordGameResults(code);  // 토너먼트 종료 시 계정 기록
  saveRoomsSoon(); // 상태 변화 시 디스크에 스냅샷(디바운스)
}
// 닉네임을 입력해 '로그인 완료'한 사람만 접속 수로 집계 (봇 제외)
const userNames = new Map(); // socketId -> 닉네임
function broadcastOnline() {
  const names = [...userNames.values()].filter(Boolean);
  io.emit('online', { count: names.length, names });
}
// 핸드 종료 시 승자 통계 누적(중복 방지)
function tallyHand(code) {
  const room = rooms.get(code);
  if (!room) return;
  const g = room.game, h = g.hand;
  if (!h || h.phase !== 'handComplete' || !h.results) return;
  if (room.lastTalliedHand === g.handNumber) return;
  room.lastTalliedHand = g.handNumber;
  room.tally = room.tally || {};
  for (const a of h.results.awards || []) {
    for (const w of a.winners) {
      const t = (room.tally[w.name] = room.tally[w.name] || { handsWon: 0, biggestPot: 0 });
      t.handsWon++;
      t.biggestPot = Math.max(t.biggestPot, a.amount || 0);
    }
  }
}
// 토너먼트 종료 시 계정에 결과 기록(한 번만)
function recordGameResults(code) {
  const room = rooms.get(code);
  if (!room || room.recorded || !room.game.finished) return;
  room.recorded = true;
  const g = room.game;
  const humanCount = g.players.filter((p) => !p.isBot).length;
  for (const r of g.results || []) {
    const acc = users.get(String(r.name).toLowerCase());
    if (!acc) continue;
    acc.stats.games++;
    if (r.place === 1) { acc.stats.wins++; acc.balance += 100 * Math.max(1, humanCount - 1); }
    else acc.balance = Math.max(0, acc.balance - 50);
    if (acc.stats.bestPlace == null || r.place < acc.stats.bestPlace) acc.stats.bestPlace = r.place;
    const t = room.tally && room.tally[r.name];
    if (t) { acc.stats.handsWon += t.handsWon || 0; acc.stats.biggestPot = Math.max(acc.stats.biggestPot, t.biggestPot || 0); }
    acc.history.unshift({ at: Date.now(), code, place: r.place, players: humanCount, win: r.place === 1 });
    if (acc.history.length > 50) acc.history.length = 50;
  }
  saveUsersSoon();
  for (const p of g.players) {
    if (p.isBot || !p.socketId) continue;
    const acc = users.get(String(p.name).toLowerCase());
    if (acc) io.to(p.socketId).emit('profile', profileOf(acc));
  }
}

// 자리 비움/합류 후 진행 인원이 다시 충분해지면 일시정지 해제하고 새 핸드 시작
function resumePausedGame(code) {
  const room = rooms.get(code);
  if (!room) return;
  const g = room.game;
  if (!g.started || g.finished || !g.paused) { broadcast(code); return; }
  const playable = g.players.filter((p) => !p.eliminated && p.chips > 0 && !p.sittingOut);
  if (playable.length >= 2) {
    g.startHand();
    startActionTimer(code);
    broadcast(code);
    scheduleNextHand(code);
    maybeBotAct(code);
    driveRunout(code);
  } else {
    broadcast(code);
  }
}

// 핸드 종료 후 자동 진행
function scheduleNextHand(code) {
  const room = rooms.get(code);
  if (!room) return;
  const { game } = room;
  if (!game.hand || game.hand.phase !== 'handComplete') return;
  if (room.timer) clearTimeout(room.timer);
  const delay = game.finished ? 0 : 6000;
  room.timer = setTimeout(() => {
    if (!rooms.has(code)) return;
    game.nextHand();
    startActionTimer(code);
    broadcast(code);
    if (game.hand && game.hand.phase === 'handComplete') scheduleNextHand(code);
    else { maybeBotAct(code); driveRunout(code); }
  }, delay);
}

// 올인 런아웃: 보드를 한 장씩 딜레이를 두고 공개
function driveRunout(code) {
  const room = rooms.get(code);
  if (!room) return;
  const g = room.game;
  if (!g.hand || g.hand.phase !== 'runout') return;
  if (room.runoutTimer) return; // 이미 진행 중
  // 헤드업(2인) 올인이면 카드 공개를 훨씬 느리게 → 긴장감
  const contenders = g.hand.seats.filter((s) => !g.hand.folded[s.id]).length;
  const headsUp = contenders === 2;
  const firstDelay = headsUp ? 1800 : 900;
  const stepDelay = headsUp ? 2700 : 1100;
  const step = () => {
    room.runoutTimer = null;
    if (!rooms.has(code)) return;
    const gg = room.game;
    if (!gg.hand || gg.hand.phase !== 'runout') { broadcast(code); return; }
    const done = gg.runoutStep();
    broadcast(code);
    if (done) scheduleNextHand(code);
    else room.runoutTimer = setTimeout(step, stepDelay);
  };
  room.runoutTimer = setTimeout(step, firstDelay);
}

// 턴 시간 제한: 사람 차례에 마감시간 설정, 초과 시 자동 체크/폴드
function startActionTimer(code) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.actionTimer) { clearTimeout(room.actionTimer); room.actionTimer = null; }
  room.actionDeadline = null;
  const g = room.game;
  if (!g.hand || g.finished) return;
  const h = g.hand;
  if (h.phase === 'handComplete' || h.phase === 'showdown') return;
  if (!room.actionLimit) return; // 0 = 무제한
  const seat = h.seats[h.toActIndex];
  if (!seat) return;
  const p = g.getPlayer(seat.id);
  if (!p || p.isBot) return; // 봇은 maybeBotAct가 처리
  if (!p.connected) return; // 끊긴/복구 직후 플레이어는 자동 폴드하지 않고 대기
  // 직전에 무액션 타임아웃한 플레이어는 이번 차례 시간 1/3(최소 3초)
  const limit = p.penaltyShort ? Math.max(3000, Math.round(room.actionLimit / 3)) : room.actionLimit;
  room.actionLimitEffective = limit;
  room.actionDeadline = Date.now() + limit;
  room.actionTimer = setTimeout(() => {
    if (!rooms.has(code)) return;
    const pp = g.getPlayer(seat.id);
    if (!pp || !pp.connected) return; // 그 사이 끊겼으면 자동 행동 안 함
    const legal = g.legalActions(seat.id);
    if (!legal) return;
    const check = legal.find((a) => a.type === 'check');
    const res = g.handleAction(seat.id, check ? 'check' : 'fold');
    if (res.ok) {
      pp.penaltyShort = true; // 무액션 타임아웃 → 다음 차례 시간 단축
      startActionTimer(code);
      broadcast(code);
      scheduleNextHand(code);
      maybeBotAct(code);
      driveRunout(code);
    }
  }, limit);
}

// 봇 차례면 잠시 뒤 자동으로 행동 (테스트용 간단 정책: 콜링 스테이션 + 가끔 레이즈)
function maybeBotAct(code) {
  const room = rooms.get(code);
  if (!room) return;
  const g = room.game;
  if (!g.hand || g.finished) return;
  const h = g.hand;
  if (h.phase === 'handComplete' || h.phase === 'showdown') return;
  const seat = h.seats[h.toActIndex];
  if (!seat) return;
  const p = g.getPlayer(seat.id);
  if (!p || !p.isBot) return;
  if (room.botTimer) clearTimeout(room.botTimer);
  room.botTimer = setTimeout(() => {
    if (!rooms.has(code)) return;
    const legal = g.legalActions(seat.id);
    if (!legal) return;
    const action = g.botDecision(seat.id); // 핸드 강도·팟오즈 기반 의사결정
    const res = g.handleAction(seat.id, action.type, action.amount);
    if (res.ok) {
      startActionTimer(code);
      broadcast(code);
      scheduleNextHand(code);
      maybeBotAct(code);
      driveRunout(code);
    } else {
      broadcast(code);
    }
  }, 1300);
}

io.on('connection', (socket) => {
  let roomCode = null;
  let playerId = socket.id;
  broadcastOnline(); // 새 접속 → 인원 수 갱신(닉네임 입력자 기준)
  // 닉네임 등록(로비에서 닉 입력 후) → 접속자 목록에 반영
  socket.on('identify', (name) => {
    const nm = String(name || '').slice(0, 16).trim();
    if (nm) userNames.set(socket.id, nm);
    else userNames.delete(socket.id); // 닉네임 비우면 집계 제외
    broadcastOnline();
  });

  // ---------- 회원가입 / 로그인 / 프로필 ----------
  socket.on('signup', ({ nick, password } = {}, cb) => {
    nick = String(nick || '').trim().slice(0, 16);
    if (nick.length < 2) return cb?.({ ok: false, error: '닉네임은 2자 이상이어야 합니다' });
    if (!password || String(password).length < 4) return cb?.({ ok: false, error: '비밀번호는 4자 이상이어야 합니다' });
    if (users.has(nick.toLowerCase())) return cb?.({ ok: false, error: '이미 사용 중인 닉네임입니다' });
    const acc = makeAccount(nick, password);
    users.set(nick.toLowerCase(), acc);
    saveUsersSoon();
    socket.account = nick;
    userNames.set(socket.id, nick); broadcastOnline();
    cb?.({ ok: true, profile: profileOf(acc) });
  });
  socket.on('login', ({ nick, password } = {}, cb) => {
    nick = String(nick || '').trim();
    const acc = users.get(nick.toLowerCase());
    if (!acc || !verifyPw(acc, password)) return cb?.({ ok: false, error: '닉네임 또는 비밀번호가 올바르지 않습니다' });
    socket.account = acc.nick;
    userNames.set(socket.id, acc.nick); broadcastOnline();
    cb?.({ ok: true, profile: profileOf(acc) });
  });
  socket.on('getProfile', (_d, cb) => {
    const acc = socket.account && users.get(socket.account.toLowerCase());
    cb?.(acc ? { ok: true, profile: profileOf(acc) } : { ok: false });
  });

  socket.on('create', ({ name, settings }, cb) => {
    const secret = !!settings?.secret;
    let code;
    if (secret) {
      // 비밀방: 호스트가 정한 4자리 숫자 코드가 곧 방 코드(입장 키)
      code = String(settings?.password || '').replace(/\D/g, '').slice(0, 4);
      if (code.length !== 4) return cb?.({ ok: false, error: '비밀방 코드는 숫자 4자리여야 합니다' });
      if (rooms.has(code)) return cb?.({ ok: false, error: '이미 사용 중인 코드입니다. 다른 코드를 쓰세요' });
    } else {
      code = makeRoomCode();
    }
    // 세션별 블라인드 구조 [{minutes, bb}] 우선, 없으면 시작BB+상승간격 폴백
    const struct = Array.isArray(settings?.blindStructure) ? settings.blindStructure.slice(0, 30) : null;
    let blindSchedule, levelDurations = null, levelDurationSec = 0;
    if (struct && struct.length) {
      blindSchedule = struct.map((s) => {
        const bb = clampInt(s.bb, 2, 1000000, 2);
        return { sb: Math.max(1, Math.round(bb / 2)), bb, ante: 0 };
      });
      levelDurations = struct.map((s) => clampInt(s.minutes, 1, 240, 5) * 60);
    } else {
      const levelMinutes = clampInt(settings?.levelMinutes, 1, 60, 3);
      const startBB = clampInt(settings?.startBB, 2, 1000, 2);
      const sb1 = Math.max(1, Math.round(startBB / 2));
      const ratio = startBB / 2;
      blindSchedule = defaultBlindSchedule().map((l, i) =>
        i === 0
          ? { sb: sb1, bb: startBB, ante: 0 }
          : {
              sb: Math.max(1, Math.round(l.sb * ratio)),
              bb: Math.max(2, Math.round(l.bb * ratio)),
              ante: Math.round(l.ante * ratio),
            }
      );
      levelDurationSec = levelMinutes * 60;
    }
    const game = new Game({
      startingChips: 320, // 친목용: 블랙20·레드20·그린20 고정
      levelDurationSec,
      levelDurations,
      blindSchedule,
    });
    game.addPlayer(playerId, name);
    game.getPlayer(playerId).socketId = socket.id;
    const actionSec = clampInt(settings?.actionSeconds, 0, 120, 10);
    const maxPlayers = settings?.maxPlayers === 6 ? 6 : 9; // 최대 인원 6 또는 9
    rooms.set(code, {
      game, hostId: playerId,
      actionLimit: actionSec > 0 ? actionSec * 1000 : 0,
      maxPlayers, secret,
    });
    roomCode = code;
    socket.join(code);
    cb?.({ ok: true, code, youId: playerId });
    broadcast(code);
    broadcastOnline();
  });

  socket.on('join', ({ code, name, password, seat } = {}, cb) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: '방을 찾을 수 없습니다' });
    const cap = room.maxPlayers || 9;
    const { game } = room;
    if (game.started) {
      // 재접속 처리: 같은 이름이 끊겨있으면 자리 인수(탈락자도 자기 자리로 복귀해 관전)
      const seat = game.players.find((p) => p.name === name && !p.connected);
      if (seat) {
        seat.connected = true;
        seat.socketId = socket.id;
        playerId = seat.id;
        roomCode = code;
        if (room.spectators) room.spectators.delete(socket.id);
        socket.join(code);
        cb?.({ ok: true, code, youId: playerId });
        broadcast(code);
        startActionTimer(code); // 복귀 시 본인 차례면 타이머 재가동
        maybeBotAct(code);
        return;
      }
      // 게임 진행 중 신규 합류 → 다음 핸드부터 참여
      if (game.finished) return cb?.({ ok: false, error: '이미 종료된 게임입니다' });
      // 같은 이름이 이미 있으면(탈락 포함) 신규 참여 불가 → 재바이인 방지
      if (game.players.some((p) => p.name === name)) {
        return cb?.({ ok: false, error: '이미 참여 중이거나 탈락한 이름입니다. 다른 닉네임을 쓰세요' });
      }
      if (game.players.length >= cap) return cb?.({ ok: false, error: '방이 가득 찼습니다. 관전만 가능합니다' });
      const btnId = game.players[game.button]?.id; // 좌석 정렬로 버튼 인덱스가 밀리지 않게 보존
      game.addPlayer(playerId, name);
      if (btnId != null) game.button = game.players.findIndex((p) => p.id === btnId);
      game.getPlayer(playerId).socketId = socket.id;
      roomCode = code;
      if (room.spectators) room.spectators.delete(socket.id); // 관전 → 참여 전환
      socket.join(code);
      game.pushLog(`${name} 님이 참여했습니다 (다음 핸드부터)`);
      cb?.({ ok: true, code, youId: playerId, lateJoin: true });
      if (game.paused) resumePausedGame(code); // 자리 비움으로 멈춰있었다면 재개
      else broadcast(code);
      return;
    }
    if (game.players.length >= cap) return cb?.({ ok: false, error: '방이 가득 찼습니다. 관전만 가능합니다' });
    // 대기방: 선택한 빈 자리(chair)에 앉히기(없으면 가장 낮은 빈 자리)
    const chair = (typeof seat === 'number') ? seat : null;
    game.addPlayer(playerId, name, false, chair);
    game.getPlayer(playerId).socketId = socket.id;
    if (room.spectators) room.spectators.delete(socket.id);
    roomCode = code;
    socket.join(code);
    cb?.({ ok: true, code, youId: playerId });
    broadcast(code);
  });

  socket.on('start', (_d, cb) => {
    const room = rooms.get(roomCode);
    if (!room) return cb?.({ ok: false, error: '방 없음' });
    if (room.hostId !== playerId) return cb?.({ ok: false, error: '방장만 시작할 수 있습니다' });
    const r = room.game.start();
    cb?.(r);
    startActionTimer(roomCode);
    broadcast(roomCode);
    scheduleNextHand(roomCode);
    maybeBotAct(roomCode);
    driveRunout(roomCode);
  });

  // 방장이 테스트 봇 수를 직접 설정 (목표 개수에 맞춰 추가/제거)
  socket.on('setBots', ({ count } = {}, cb) => {
    const room = rooms.get(roomCode);
    if (!room) return cb?.({ ok: false, error: '방 없음' });
    if (room.hostId !== playerId) return cb?.({ ok: false, error: '방장만 설정할 수 있습니다' });
    const g = room.game;
    if (g.started) return cb?.({ ok: false, error: '이미 시작됨' });
    const humans = g.players.filter((p) => !p.isBot).length;
    let target = parseInt(count, 10);
    if (Number.isNaN(target)) target = 0;
    target = Math.max(0, Math.min(target, (room.maxPlayers || 9) - humans)); // 방 최대 인원까지
    // 초과 봇 제거
    let bots = g.players.filter((p) => p.isBot);
    while (bots.length > target) {
      const b = bots.pop();
      g.players = g.players.filter((p) => p.id !== b.id);
    }
    // 부족분 추가
    let i = 0;
    while (g.players.filter((p) => p.isBot).length < target) {
      i++;
      g.addPlayer('bot_' + Date.now() + '_' + i, '🤖 Bot', true);
    }
    // 봇 번호 정리
    g.players.filter((p) => p.isBot).forEach((b, idx) => { b.name = `🤖 Bot ${idx + 1}`; });
    cb?.({ ok: true, count: target });
    broadcast(roomCode);
  });

  // 대기 테이블에서 빈 자리(+) 클릭 → 그 자리(chair)에 봇 1명 추가
  socket.on('addBot', ({ seat } = {}, cb) => {
    const room = rooms.get(roomCode);
    if (!room) return cb?.({ ok: false, error: '방 없음' });
    if (room.hostId !== playerId) return cb?.({ ok: false, error: '방장만 추가할 수 있습니다' });
    const g = room.game;
    if (g.started) return cb?.({ ok: false, error: '이미 시작됨' });
    if (g.players.length >= (room.maxPlayers || 9)) return cb?.({ ok: false, error: '자리가 가득 찼습니다' });
    const chair = (typeof seat === 'number') ? seat : null;
    g.addPlayer('bot_' + Date.now() + '_' + Math.floor(Math.random() * 1000), '🤖 Bot', true, chair);
    g.players.filter((p) => p.isBot).forEach((b, idx) => { b.name = `🤖 Bot ${idx + 1}`; });
    cb?.({ ok: true });
    broadcast(roomCode);
  });

  // 대기 테이블에서 봇 자리(×) 클릭 → 해당 봇 제거
  socket.on('removeBot', ({ id } = {}, cb) => {
    const room = rooms.get(roomCode);
    if (!room) return cb?.({ ok: false, error: '방 없음' });
    if (room.hostId !== playerId) return cb?.({ ok: false, error: '방장만 제거할 수 있습니다' });
    const g = room.game;
    if (g.started) return cb?.({ ok: false, error: '이미 시작됨' });
    const target = g.players.find((p) => p.id === id && p.isBot);
    if (!target) return cb?.({ ok: false, error: '봇을 찾을 수 없습니다' });
    g.players = g.players.filter((p) => p.id !== id);
    g.players.filter((p) => p.isBot).forEach((b, idx) => { b.name = `🤖 Bot ${idx + 1}`; });
    cb?.({ ok: true });
    broadcast(roomCode);
  });

  socket.on('action', ({ type, amount }, cb) => {
    const room = rooms.get(roomCode);
    if (!room) return cb?.({ ok: false, error: '방 없음' });
    const actor = room.game.getPlayer(playerId);
    const r = room.game.handleAction(playerId, type, amount);
    cb?.(r);
    if (r.ok) {
      if (actor) actor.penaltyShort = false; // 자발적 액션 → 시간 단축 패널티 해제
      startActionTimer(roomCode);
      broadcast(roomCode);
      scheduleNextHand(roomCode);
      maybeBotAct(roomCode);
      driveRunout(roomCode);
    }
  });

  // 현재 방 목록 조회
  socket.on('listRooms', (_d, cb) => {
    const list = [];
    for (const [code, room] of rooms) {
      if (room.secret) continue; // 비밀방은 목록에 노출하지 않음(코드로만 입장)
      const g = room.game;
      const cap = room.maxPlayers || 9;
      list.push({
        code,
        humans: g.players.filter((p) => !p.isBot).length,
        total: g.players.length,
        maxPlayers: cap,
        full: g.players.length >= cap,
        started: g.started,
        finished: g.finished,
        handNumber: g.handNumber,
        hostName: (g.players.find((p) => p.id === room.hostId) || {}).name || '',
        blinds: g.started && !g.finished ? g.currentBlinds() : null,
      });
    }
    // 대기중 → 진행중 → 종료 순
    list.sort((a, b) => (a.started ? 1 : 0) - (b.started ? 1 : 0) || a.code.localeCompare(b.code));
    cb?.({ ok: true, rooms: list });
  });

  // 진행중인 방 관전
  socket.on('spectate', ({ code, name } = {}, cb) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: '방을 찾을 수 없습니다' });
    roomCode = code;
    if (!room.spectators) room.spectators = new Set();
    room.spectators.add(socket.id);
    socket.specName = (name && String(name).slice(0, 16)) || '관전자';
    socket.join(code);
    cb?.({ ok: true, code, youId: socket.id, spectator: true });
    io.to(socket.id).emit('state', stateFor(room, socket.id));
    room.game.pushLog(`👀 ${socket.specName} 님이 관전을 시작했습니다`);
    io.to(code).emit('notice', `👀 ${socket.specName} 님이 방에 들어와 관전 중입니다`);
  });

  // 이모지 리액션
  const ALLOWED_EMOJI = ['😎', '🔥', '😱', '😂', '😭', '👍', '🤔', '🎉'];
  socket.on('react', ({ emoji }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    const p = room.game.getPlayer(playerId);
    if (!p || !ALLOWED_EMOJI.includes(emoji)) return;
    io.to(roomCode).emit('reaction', { id: playerId, emoji });
  });

  socket.on('chat', ({ text }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    const p = room.game.getPlayer(playerId);
    if (!p || !text) return;
    io.to(roomCode).emit('chat', { name: p.name, text: String(text).slice(0, 200), t: Date.now() });
  });

  // 자리 비움 / 복귀 (게임 중 나가지 않고 핸드 쉬기)
  socket.on('sitOut', ({ out } = {}, cb) => {
    const room = rooms.get(roomCode);
    if (!room) return cb?.({ ok: false, error: '방 없음' });
    const g = room.game;
    const p = g.getPlayer(playerId);
    if (!p) return cb?.({ ok: false, error: '플레이어 없음' });
    p.sittingOut = !!out;
    g.pushLog(`${p.name} 님이 ${p.sittingOut ? '자리를 비웠습니다' : '돌아왔습니다'}`);
    cb?.({ ok: true, sittingOut: p.sittingOut });
    // 복귀로 인원이 충분해지면 재개
    if (!p.sittingOut && g.started && !g.finished && g.paused) resumePausedGame(roomCode);
    else broadcast(roomCode);
  });

  // 대기/게임방에서 직접 나가기
  socket.on('leave', (_d, cb) => {
    const room = rooms.get(roomCode);
    if (!room) { roomCode = null; return cb?.({ ok: true }); }
    const { game } = room;
    if (room.spectators) room.spectators.delete(socket.id);
    if (!game.started) {
      game.removePlayer(playerId);
      if (room.hostId === playerId && game.players.length) room.hostId = game.players[0].id;
      if (game.players.filter((p) => !p.isBot).length === 0) {
        // 사람이 모두 나가면 방 정리
        clearRoomTimers(room);
        rooms.delete(roomCode);
      } else {
        broadcast(roomCode);
      }
    } else {
      const p = game.getPlayer(playerId);
      if (p) p.connected = false;
      broadcast(roomCode);
    }
    socket.leave(roomCode);
    roomCode = null;
    cb?.({ ok: true });
  });

  socket.on('disconnect', () => {
    userNames.delete(socket.id);
    setTimeout(broadcastOnline, 50); // 접속 종료 → 인원 수 갱신(모든 경우)
    const room = rooms.get(roomCode);
    if (!room) return;
    // 관전자였으면 제거 후 종료
    if (room.spectators && room.spectators.has(socket.id)) {
      room.spectators.delete(socket.id);
      if (!room.game.getPlayer(playerId)) return;
    }
    const { game } = room;
    const p = game.getPlayer(playerId);
    if (p) p.connected = false;
    if (!game.started) {
      game.removePlayer(playerId);
      // 방장이 나가면 다음 사람에게 위임
      if (room.hostId === playerId && game.players.length) {
        room.hostId = game.players[0].id;
      }
      if (game.players.length === 0) {
        clearRoomTimers(room);
        rooms.delete(roomCode);
        return;
      }
    }
    broadcast(roomCode);
  });
});

function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function clearRoomTimers(room) {
  for (const k of ['timer', 'actionTimer', 'botTimer', 'runoutTimer']) {
    if (room[k]) { clearTimeout(room[k]); room[k] = null; }
  }
}

// 빈 방(접속 인원·관전자 없음) 주기적 정리
setInterval(() => {
  for (const [code, room] of rooms) {
    const anyConnected = room.game.players.some((p) => !p.isBot && p.connected);
    const anySpec = room.spectators && room.spectators.size > 0;
    // 복구 직후 방은 재접속 유예(5분) — 새로고침/재접속 시간을 줌
    const inGrace = room.restoredAt && (Date.now() - room.restoredAt < 5 * 60 * 1000);
    if (!anyConnected && !anySpec && !inGrace) {
      clearRoomTimers(room);
      rooms.delete(code);
      saveRoomsSoon();
    }
  }
}, 60000);

loadUsers(); // 계정 로드
loadRooms(); // 이전 상태 복구
httpServer.listen(PORT, () => {
  console.log(`🎲 Dice 서버 실행: http://localhost:${PORT}`);
});
