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
const DB_URL = process.env.DATABASE_URL; // 설정되면 PostgreSQL 영구 저장, 없으면 파일
const users = new Map(); // nickLower -> account
let pool = null;
const _dirtyUsers = new Set(); // 변경된 계정(nickLower)

async function initDb() {
  if (!DB_URL) return false;
  let pg;
  try { pg = await import('pg'); }
  catch (e) { console.error('pg 모듈 없음, 파일 저장 사용:', e.message); return false; }
  // SSL 사용/미사용 둘 다 시도(외부=SSL 필요, Render 내부=SSL 미지원일 수 있음)
  for (const ssl of [{ rejectUnauthorized: false }, false]) {
    try {
      pool = new pg.default.Pool({ connectionString: DB_URL, ssl, max: 4, connectionTimeoutMillis: 8000 });
      await pool.query('CREATE TABLE IF NOT EXISTS accounts (nick text primary key, data jsonb)');
      await pool.query('CREATE TABLE IF NOT EXISTS room_states (code text primary key, data jsonb)');
      console.log(`DB 연결 OK — 계정·방 영구 저장 (ssl=${ssl ? 'on' : 'off'})`);
      return true;
    } catch (e) {
      try { await pool?.end(); } catch (_) {}
      pool = null;
      if (ssl) { console.warn('SSL 연결 실패, SSL 없이 재시도...'); continue; }
      console.error('DB 연결 실패, 파일 저장으로 폴백:', e.message);
      return false;
    }
  }
  return false;
}
async function loadUsers() {
  if (await initDb()) {
    try {
      const { rows } = await pool.query('SELECT data FROM accounts');
      for (const r of rows) { const a = r.data; users.set(a.nick.toLowerCase(), a); }
      indexAllTokens();
      console.log(`DB 계정 ${users.size}개 로드`);
      return;
    } catch (e) { console.error('DB 계정 로드 실패:', e.message); }
  }
  try { // 파일 폴백
    if (!existsSync(USERS_FILE)) return;
    const data = JSON.parse(readFileSync(USERS_FILE, 'utf8'));
    for (const u of data) users.set(u.nick.toLowerCase(), u);
    indexAllTokens();
    console.log(`파일 계정 ${users.size}개 로드`);
  } catch (e) { console.error('계정 로드 실패:', e.message); }
}
let _usersTimer = null;
function saveUser(acc) { _dirtyUsers.add(acc.nick.toLowerCase()); saveUsersSoon(); }
function saveUsersSoon() {
  if (_usersTimer) return;
  _usersTimer = setTimeout(async () => {
    _usersTimer = null;
    if (pool) {
      const dirty = [..._dirtyUsers]; _dirtyUsers.clear();
      try {
        for (const nl of dirty) {
          const acc = users.get(nl); if (!acc) continue;
          await pool.query('INSERT INTO accounts(nick,data) VALUES($1,$2) ON CONFLICT(nick) DO UPDATE SET data=$2', [nl, acc]);
        }
      } catch (e) { console.error('DB 계정 저장 실패:', e.message); }
    } else {
      try { writeFileSync(USERS_FILE, JSON.stringify([...users.values()])); }
      catch (e) { console.error('계정 저장 실패:', e.message); }
    }
  }, 1000);
}
function hashPw(pw, salt) { return scryptSync(String(pw), salt, 32).toString('hex'); }
function makeAccount(nick, pw) {
  const salt = randomBytes(12).toString('hex');
  return {
    nick, salt, hash: hashPw(pw, salt), createdAt: Date.now(),
    avatar: null, // 프로필 이미지(data URL, 작게 리사이즈됨)
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
  return { nick: acc.nick, avatar: acc.avatar || null, balance: acc.balance, stats: acc.stats, history: acc.history.slice(0, 20) };
}
// 프로필 이미지 검증(작은 data URL만 허용)
const AVATAR_MAX = 200000; // ~200KB
function validAvatar(av) {
  return typeof av === 'string' && av.length <= AVATAR_MAX && /^data:image\/(png|jpeg|webp);base64,/.test(av);
}
// 로그인 세션 토큰: 재접속(네트워크 끊김·재배포)에도 로그인 유지. 계정에 저장되어 영구 보존
const tokenIndex = new Map(); // token -> nickLower
function indexAllTokens() {
  for (const acc of users.values()) if (acc.loginToken) tokenIndex.set(acc.loginToken, acc.nick.toLowerCase());
}
const TOKEN_TTL = 30 * 24 * 60 * 60 * 1000; // 세션 토큰 30일 만료
function ensureToken(acc) {
  if (!acc.loginToken) { acc.loginToken = randomBytes(18).toString('hex'); acc.loginTokenAt = Date.now(); saveUser(acc); }
  if (!acc.loginTokenAt) { acc.loginTokenAt = Date.now(); saveUser(acc); }
  tokenIndex.set(acc.loginToken, acc.nick.toLowerCase());
  return acc.loginToken;
}
function revokeToken(acc) {
  if (acc.loginToken) tokenIndex.delete(acc.loginToken);
  acc.loginToken = null; acc.loginTokenAt = null;
}
// 간단한 요청 속도 제한(소켓 단위 도배 방지)
const _rate = new Map(); // key -> 마지막 허용 시각
function rateOk(key, ms) {
  const now = Date.now();
  if (now - (_rate.get(key) || 0) < ms) return false;
  _rate.set(key, now);
  return true;
}
// 계정당 활성 세션 1개 — 중복 로그인 시 기존 기기를 강제 로그아웃
const activeSessions = new Map(); // nickLower -> socketId
function claimSession(socket, nick) {
  const nl = String(nick).toLowerCase();
  const prev = activeSessions.get(nl);
  if (prev && prev !== socket.id) {
    io.to(prev).emit('forceLogout', { reason: '다른 기기에서 로그인되어 이 기기는 로그아웃됩니다' });
    const ps = io.sockets.sockets.get(prev);
    if (ps) { ps.account = null; userNames.delete(prev); }
  }
  activeSessions.set(nl, socket.id);
}
function releaseSession(socket) {
  if (socket.account) {
    const nl = socket.account.toLowerCase();
    if (activeSessions.get(nl) === socket.id) activeSessions.delete(nl);
  }
}

// ---------- 방 관리 ----------
const rooms = new Map(); // code -> { game, hostId, timer, settings }

// 봇에게 줄 흔한 이름 풀(중복 안 되게 골라서 부여)
const BOT_NAMES = ['데이빗', '빌리', '제임스', '마이크', '존', '토니', '케빈', '스티브', '크리스', '라이언', '제이크', '폴', '마크', '루크', '네이슨', '에릭', '샘', '조던', '대니', '오스카', '헨리', '레오', '맥스', '아담'];
function botName(g) {
  const used = new Set(g.players.filter((p) => p.isBot).map((p) => p.name.replace(/^🤖\s*/, '')));
  const avail = BOT_NAMES.filter((n) => !used.has(n));
  const pick = avail.length ? avail[Math.floor(Math.random() * avail.length)] : '봇' + Math.floor(Math.random() * 1000);
  return '🤖 ' + pick;
}

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
  _saveTimer = setTimeout(async () => {
    _saveTimer = null;
    const list = serializeRooms();
    if (pool) {
      try {
        const codes = list.map((r) => r.code);
        if (codes.length) await pool.query('DELETE FROM room_states WHERE code <> ALL($1)', [codes]);
        else await pool.query('DELETE FROM room_states');
        for (const r of list) {
          await pool.query('INSERT INTO room_states(code,data) VALUES($1,$2) ON CONFLICT(code) DO UPDATE SET data=$2', [r.code, r]);
        }
      } catch (e) { console.error('방 상태 DB 저장 실패:', e.message); }
    } else {
      try { writeFileSync(SAVE_FILE, JSON.stringify(list)); }
      catch (e) { console.error('상태 저장 실패:', e.message); }
    }
  }, 1500);
}
// 직렬화된 방 데이터 1건 → 메모리 복구
function reconstructRoom(r) {
  const rg = r.game;
  const g = new Game({
    startingChips: rg.startingChips,
    levelDurationSec: rg.levelDurationSec,
    levelDurations: rg.levelDurations,
    handsPerLevel: rg.handsPerLevel,
    blindSchedule: rg.blindSchedule,
  });
  g.players = rg.players.map((p) => ({ ...p, connected: false, socketId: null }));
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
      startActionTimer(r.code);
      scheduleNextHand(r.code);
      maybeBotAct(r.code);
      driveRunout(r.code);
    } else {
      g.paused = true;
    }
  }
}
async function loadRooms() {
  try {
    let data = null;
    if (pool) {
      try { const { rows } = await pool.query('SELECT data FROM room_states'); data = rows.map((r) => r.data); }
      catch (e) { console.error('방 상태 DB 로드 실패:', e.message); }
    }
    if (!data) {
      if (!existsSync(SAVE_FILE)) return;
      data = JSON.parse(readFileSync(SAVE_FILE, 'utf8'));
    }
    for (const r of data) reconstructRoom(r);
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
  // 좌석에 프로필 아바타 + 타임뱅크 잔량 표시
  if (st.players) {
    for (const p of st.players) {
      const gp = room.game.getPlayer(p.id);
      if (gp) { gp.timeBank = gp.timeBank ?? 30000; p.timeBank = gp.timeBank; }
      if (p.isBot) continue;
      const acc = users.get(String(p.name || '').toLowerCase());
      if (acc && acc.avatar) p.avatar = acc.avatar;
    }
  }
  return st;
}
// 입퇴장 등 시스템 안내를 채팅창에 표시
function sysChat(code, text) {
  io.to(code).emit('chat', { name: '', text, system: true });
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
  // 같은 닉네임(여러 기기) 중복 제거, 아바타 포함
  const seen = new Set();
  const list = [];
  for (const nm of userNames.values()) {
    if (!nm) continue;
    const key = nm.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const acc = users.get(key);
    list.push({ nick: nm, avatar: (acc && acc.avatar) || null });
  }
  io.emit('online', { count: list.length, users: list, names: list.map((u) => u.nick) });
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
    saveUser(acc);
  }
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

// 자진 퇴장 전적 기록(진행 중 & 살아있는 플레이어 1회) → 프로필 반환
function recordForfeit(code, pid) {
  const room = rooms.get(code);
  if (!room) return null;
  const g = room.game;
  const p = g.getPlayer(pid);
  if (!p || p.isBot || p.forfeitRecorded) return null;
  if (!(g.started && !p.eliminated)) return null;
  const acc = users.get(String(p.name).toLowerCase());
  if (!acc) return null;
  const humanCount = g.players.filter((x) => !x.isBot).length;
  const aliveAfter = g.players.filter((x) => !x.eliminated && x.id !== pid).length;
  const place = Math.max(2, aliveAfter + 1);
  acc.stats.games++;
  acc.balance = Math.max(0, acc.balance - 50);
  acc.history.unshift({ at: Date.now(), code, place, players: humanCount, win: false });
  if (acc.history.length > 50) acc.history.length = 50;
  saveUser(acc);
  p.forfeitRecorded = true;
  return profileOf(acc);
}
// 플레이어를 게임에서 제거(방장 위임·빈 방 정리 포함)
function finalizeLeave(code, pid) {
  const room = rooms.get(code);
  if (!room) return;
  const g = room.game;
  const btnId = g.players[g.button] ? g.players[g.button].id : null;
  // 자진 퇴장은 시작 후에도 좌석에서 완전히 제거(removePlayer는 시작 후 connected=false만 하므로 직접 제거)
  g.players = g.players.filter((x) => x.id !== pid);
  if (btnId != null && btnId !== pid) g.button = Math.max(0, g.players.findIndex((x) => x.id === btnId));
  if (room.hostId === pid && g.players.length) room.hostId = (g.players.find((x) => !x.isBot) || g.players[0]).id;
  if (g.players.filter((x) => !x.isBot).length === 0) { clearRoomTimers(room); rooms.delete(code); return; }
  broadcast(code);
  saveRoomsSoon();
}
// 이번 핸드 종료 시점: '이번 핸드 후 나가기' 표시된 플레이어를 로비로 보내고 제거
function processPendingLeaves(code) {
  const room = rooms.get(code);
  if (!room) return;
  const g = room.game;
  const leaving = g.players.filter((p) => p.pendingLeave);
  if (!leaving.length) return;
  for (const p of leaving) { if (p.socketId) io.to(p.socketId).emit('leftToLobby'); }
  const btnId = g.players[g.button] ? g.players[g.button].id : null;
  const leavingIds = new Set(leaving.map((p) => p.id));
  g.players = g.players.filter((p) => !p.pendingLeave);
  if (btnId != null && !leavingIds.has(btnId)) g.button = Math.max(0, g.players.findIndex((x) => x.id === btnId));
  if (g.players.filter((x) => !x.isBot).length === 0) { clearRoomTimers(room); rooms.delete(code); }
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
    processPendingLeaves(code); // '이번 핸드 후 나가기' 처리
    if (!rooms.has(code)) return; // 모두 나가 방이 정리됐으면 종료
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
  if (!p.connected) {
    // 끊긴 플레이어가 차례면: 유예(기본 18초) 후 자동 체크/폴드 + 자리비움 → 테이블 진행
    const grace = 18000;
    room.actionLimitEffective = grace;
    room.actionDeadline = Date.now() + grace;
    room.actionTimer = setTimeout(() => {
      if (!rooms.has(code)) return;
      const pp = g.getPlayer(seat.id);
      if (!pp) return;
      if (pp.connected) { startActionTimer(code); broadcast(code); return; } // 그 사이 복귀 → 정상 타이머
      const legal = g.legalActions(seat.id);
      if (!legal) return;
      const check = legal.find((a) => a.type === 'check');
      const res = g.handleAction(seat.id, check ? 'check' : 'fold');
      if (res.ok) {
        pp.sittingOut = true; // 돌아올 때까지 다음 핸드 자동 스킵
        g.pushLog(`${pp.name} 님이 연결 끊김으로 자동 ${check ? '체크' : '폴드'} 되었습니다`);
        startActionTimer(code);
        broadcast(code);
        scheduleNextHand(code);
        maybeBotAct(code);
        driveRunout(code);
      }
    }, grace);
    return;
  }
  // '이번 핸드 후 나가기' 표시 플레이어는 차례가 오면 짧게(2초) 자동 폴드 → 핸드 진행
  if (p.pendingLeave) {
    room.actionLimitEffective = 2000;
    room.actionDeadline = Date.now() + 2000;
    room.actionTimer = setTimeout(() => fireActionTimeout(code, seat.id), 2000);
    return;
  }
  // 직전에 무액션 타임아웃한 플레이어는 이번 차례 시간 1/3(최소 3초)
  const limit = p.penaltyShort ? Math.max(3000, Math.round(room.actionLimit / 3)) : room.actionLimit;
  room.actionLimitEffective = limit;
  room.actionDeadline = Date.now() + limit;
  room.actionTimer = setTimeout(() => fireActionTimeout(code, seat.id), limit);
}
// 액션 제한 시간 만료 → 자동 체크/폴드(타임뱅크 연장도 이 콜백을 재사용)
function fireActionTimeout(code, seatId) {
  if (!rooms.has(code)) return;
  const room = rooms.get(code);
  const g = room.game;
  const pp = g.getPlayer(seatId);
  if (!pp || !pp.connected) return; // 그 사이 끊겼으면 자동 행동 안 함
  const legal = g.legalActions(seatId);
  if (!legal) return;
  const check = legal.find((a) => a.type === 'check');
  const res = g.handleAction(seatId, check ? 'check' : 'fold');
  if (res.ok) {
    pp.penaltyShort = true; // 무액션 타임아웃 → 다음 차례 시간 단축
    startActionTimer(code);
    broadcast(code);
    scheduleNextHand(code);
    maybeBotAct(code);
    driveRunout(code);
  }
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
    const action = g.botDecision(seat.id, room.botLevel || 'normal'); // 난이도 반영 의사결정
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
  socket.lastActivity = Date.now(); // 마지막 사용자 액션 시각(비활동 자동 로그아웃용)
  // 모든 이벤트 핸들러를 try/catch로 감싸 한 곳의 예외가 전체를 막지 않도록 + 활동 시각 갱신
  const _on = socket.on.bind(socket);
  socket.on = (event, handler) => _on(event, function (...args) {
    socket.lastActivity = Date.now(); // 어떤 이벤트든 들어오면 활동으로 간주
    const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
    try { return handler.apply(this, args); }
    catch (e) { console.error(`[${event}] 처리 오류:`, e); if (cb) try { cb({ ok: false, error: '서버 오류가 발생했습니다' }); } catch (_) {} }
  });
  // 실제 클라이언트 IP(프록시 뒤에서는 x-forwarded-for 우선) — 레이트리밋 키
  const clientIp = String(socket.handshake.headers['x-forwarded-for'] || '').split(',')[0].trim() || socket.handshake.address || socket.id;
  broadcastOnline(); // 새 접속 → 인원 수 갱신(닉네임 입력자 기준)
  // 닉네임 등록(로비에서 닉 입력 후) → 접속자 목록에 반영
  socket.on('identify', (name) => {
    const nm = String(name || '').slice(0, 16).trim();
    if (nm) userNames.set(socket.id, nm);
    else userNames.delete(socket.id); // 닉네임 비우면 집계 제외
    broadcastOnline();
  });

  // ---------- 회원가입 / 로그인 / 프로필 ----------
  socket.on('signup', ({ nick, password, avatar } = {}, cb) => {
    if (!rateOk('signup:' + clientIp, 5000)) return cb?.({ ok: false, error: '잠시 후 다시 시도하세요' });
    nick = String(nick || '').trim().slice(0, 16);
    if (nick.length < 2) return cb?.({ ok: false, error: '닉네임은 2자 이상이어야 합니다' });
    if (!password || String(password).length < 4) return cb?.({ ok: false, error: '비밀번호는 4자 이상이어야 합니다' });
    if (users.has(nick.toLowerCase())) return cb?.({ ok: false, error: '이미 사용 중인 닉네임입니다' });
    const acc = makeAccount(nick, password);
    if (avatar && validAvatar(avatar)) acc.avatar = avatar;
    users.set(nick.toLowerCase(), acc);
    saveUser(acc);
    socket.account = nick;
    claimSession(socket, nick);
    userNames.set(socket.id, nick); broadcastOnline();
    cb?.({ ok: true, profile: profileOf(acc), token: ensureToken(acc) });
  });
  socket.on('login', ({ nick, password } = {}, cb) => {
    nick = String(nick || '').trim();
    const acc = users.get(nick.toLowerCase());
    if (!acc || !verifyPw(acc, password)) return cb?.({ ok: false, error: '닉네임 또는 비밀번호가 올바르지 않습니다' });
    socket.account = acc.nick;
    claimSession(socket, acc.nick);
    userNames.set(socket.id, acc.nick); broadcastOnline();
    cb?.({ ok: true, profile: profileOf(acc), token: ensureToken(acc) });
  });
  // 재접속 세션 복구: 토큰으로 로그인 상태 회복(비밀번호 재입력 없이)
  socket.on('resume', ({ token } = {}, cb) => {
    const nl = token && tokenIndex.get(token);
    const acc = nl && users.get(nl);
    if (!acc) return cb?.({ ok: false });
    if (acc.loginTokenAt && Date.now() - acc.loginTokenAt > TOKEN_TTL) { // 만료된 토큰
      revokeToken(acc); saveUser(acc);
      return cb?.({ ok: false, error: '세션이 만료되었습니다. 다시 로그인해 주세요' });
    }
    socket.account = acc.nick;
    claimSession(socket, acc.nick);
    userNames.set(socket.id, acc.nick); broadcastOnline();
    cb?.({ ok: true, profile: profileOf(acc), token: acc.loginToken });
  });
  // 로그아웃: 토큰 무효화
  socket.on('logout', (_d, cb) => {
    const acc = socket.account && users.get(socket.account.toLowerCase());
    if (acc) { revokeToken(acc); saveUser(acc); }
    releaseSession(socket);
    socket.account = null;
    userNames.delete(socket.id); broadcastOnline();
    cb?.({ ok: true });
  });
  // 비밀번호 변경(현재 비번 확인 후, 기존 토큰 모두 무효화)
  socket.on('changePassword', ({ oldPassword, newPassword } = {}, cb) => {
    const acc = socket.account && users.get(socket.account.toLowerCase());
    if (!acc) return cb?.({ ok: false, error: '로그인이 필요합니다' });
    if (!verifyPw(acc, oldPassword)) return cb?.({ ok: false, error: '현재 비밀번호가 올바르지 않습니다' });
    if (!newPassword || String(newPassword).length < 4) return cb?.({ ok: false, error: '새 비밀번호는 4자 이상이어야 합니다' });
    const salt = randomBytes(12).toString('hex');
    acc.salt = salt; acc.hash = hashPw(newPassword, salt);
    revokeToken(acc); // 다른 기기 세션 만료
    saveUser(acc);
    cb?.({ ok: true, token: ensureToken(acc) });
  });
  socket.on('getProfile', (_d, cb) => {
    const acc = socket.account && users.get(socket.account.toLowerCase());
    cb?.(acc ? { ok: true, profile: profileOf(acc) } : { ok: false });
  });
  // 프로필 이미지 등록/변경/삭제(로그인 후)
  socket.on('setAvatar', ({ avatar } = {}, cb) => {
    if (!rateOk('avatar:' + socket.id, 2000)) return cb?.({ ok: false, error: '잠시 후 다시 시도하세요' });
    const acc = socket.account && users.get(socket.account.toLowerCase());
    if (!acc) return cb?.({ ok: false, error: '로그인이 필요합니다' });
    if (avatar == null || avatar === '') {
      acc.avatar = null;
    } else if (validAvatar(avatar)) {
      acc.avatar = avatar;
    } else {
      return cb?.({ ok: false, error: '이미지 형식이 올바르지 않거나 너무 큽니다' });
    }
    saveUser(acc);
    broadcastOnline();
    cb?.({ ok: true, profile: profileOf(acc) });
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
    // 시작 스택: 방장이 BB 단위로 지정(기본 160BB). startingChips = startStackBB × 첫 BB
    const firstBB = (blindSchedule[0] && blindSchedule[0].bb) || 2;
    const startStackBB = clampInt(settings?.startStackBB, 10, 100000, 160);
    const game = new Game({
      startingChips: startStackBB * firstBB,
      levelDurationSec,
      levelDurations,
      blindSchedule,
    });
    game.addPlayer(playerId, name);
    game.getPlayer(playerId).socketId = socket.id;
    const actionSec = clampInt(settings?.actionSeconds, 0, 120, 10);
    const maxPlayers = settings?.maxPlayers === 6 ? 6 : 9; // 최대 인원 6 또는 9
    const botLevel = ['easy', 'normal', 'hard'].includes(settings?.botLevel) ? settings.botLevel : 'normal';
    rooms.set(code, {
      game, hostId: playerId,
      actionLimit: actionSec > 0 ? actionSec * 1000 : 0,
      maxPlayers, secret, botLevel,
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
        if (seat.sittingOut) seat.sittingOut = false; // 끊김 자동 자리비움에서 복귀
        playerId = seat.id;
        roomCode = code;
        if (room.spectators) room.spectators.delete(socket.id);
        socket.join(code);
        sysChat(code, `🔄 ${seat.name} 님이 다시 연결되었습니다`);
        cb?.({ ok: true, code, youId: playerId });
        broadcast(code);
        startActionTimer(code); // 복귀 시 본인 차례면 타이머 재가동
        maybeBotAct(code);
        return;
      }
      // 게임 진행 중 신규 합류 → 다음 핸드부터 참여
      if (game.finished) return cb?.({ ok: false, error: '이미 종료된 게임입니다' });
      // 같은 이름이 살아있으면 중복 방지(탈락한 이름은 재참여 허용)
      if (game.players.some((p) => p.name === name && !p.eliminated)) {
        return cb?.({ ok: false, error: '이미 참여 중인 이름입니다. 다른 닉네임을 쓰세요' });
      }
      // 활성(비탈락) 인원 기준으로 자리 판단 → 탈락으로 빈 자리는 새로 채울 수 있음
      const activeCount = game.players.filter((p) => !p.eliminated).length;
      if (activeCount >= cap) return cb?.({ ok: false, error: '활성 좌석이 가득 찼습니다. 관전만 가능합니다' });
      const btnId = game.players[game.button]?.id; // 좌석 정렬로 버튼 인덱스가 밀리지 않게 보존
      // cap 범위 내 빈 의자 확보(없으면 탈락자 1명을 제거해 의자 회수 — 순위는 이미 results에 기록됨)
      const usedChairs = new Set(game.players.map((p) => p.chair));
      let freeChair = null;
      for (let c = 0; c < cap; c++) { if (!usedChairs.has(c)) { freeChair = c; break; } }
      if (freeChair == null) {
        const di = game.players.findIndex((p) => p.eliminated);
        if (di >= 0) { freeChair = game.players[di].chair; game.players.splice(di, 1); }
      }
      game.addPlayer(playerId, name, false, freeChair);
      if (btnId != null) game.button = game.players.findIndex((p) => p.id === btnId);
      game.getPlayer(playerId).socketId = socket.id;
      roomCode = code;
      if (room.spectators) room.spectators.delete(socket.id); // 관전 → 참여 전환
      socket.join(code);
      game.pushLog(`${name} 님이 참여했습니다 (다음 핸드부터)`);
      sysChat(code, `➕ ${name} 님이 중간 합류했습니다 (다음 핸드부터)`);
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
    sysChat(code, `➕ ${name} 님이 입장했습니다`);
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

  // 토너먼트 종료 후 같은 멤버로 다시 시작(리매치)
  socket.on('rematch', (_d, cb) => {
    const room = rooms.get(roomCode);
    if (!room) return cb?.({ ok: false, error: '방 없음' });
    if (room.hostId !== playerId) return cb?.({ ok: false, error: '방장만 다시 시작할 수 있습니다' });
    const old = room.game;
    if (!old.finished) return cb?.({ ok: false, error: '게임이 끝난 뒤에 가능합니다' });
    const g = new Game({
      startingChips: old.startingChips, levelDurationSec: old.levelDurationSec,
      levelDurations: old.levelDurations, handsPerLevel: old.handsPerLevel, blindSchedule: old.blindSchedule,
    });
    for (const p of old.players) {
      if (p.isBot) g.addPlayer(p.id, p.name, true, p.chair);
      else if (p.connected) { g.addPlayer(p.id, p.name, false, p.chair); const np = g.getPlayer(p.id); if (np) np.socketId = p.socketId; }
    }
    if (g.players.length < 2) return cb?.({ ok: false, error: '다시 시작하려면 2명 이상이어야 합니다' });
    room.game = g;
    if (!g.getPlayer(room.hostId)) room.hostId = (g.players.find((x) => !x.isBot) || g.players[0]).id;
    clearRoomTimers(room);
    const r = g.start();
    sysChat(roomCode, '🔄 같은 멤버로 한판 더 시작!');
    cb?.(r);
    startActionTimer(roomCode); broadcast(roomCode); scheduleNextHand(roomCode); maybeBotAct(roomCode); driveRunout(roomCode);
    saveRoomsSoon();
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
    // 부족분 추가(흔한 이름 랜덤 부여)
    let i = 0;
    while (g.players.filter((p) => p.isBot).length < target) {
      i++;
      g.addPlayer('bot_' + Date.now() + '_' + i, botName(g), true);
    }
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
    g.addPlayer('bot_' + Date.now() + '_' + Math.floor(Math.random() * 1000), botName(g), true, chair);
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
      // 진행 중이면 탈락자를 제외한 활성 인원으로 자리 계산(탈락으로 빈 자리는 참여 가능)
      const occupied = g.started ? g.players.filter((p) => !p.eliminated).length : g.players.length;
      list.push({
        code,
        humans: g.players.filter((p) => !p.isBot).length,
        total: occupied,
        maxPlayers: cap,
        full: occupied >= cap,
        started: g.started,
        finished: g.finished,
        handNumber: g.handNumber,
        hostName: (g.players.find((p) => p.id === room.hostId) || g.players.find((p) => !p.isBot) || g.players[0] || {}).name || '방장',
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
    sysChat(code, `👀 ${socket.specName} 님이 관전을 시작했습니다`);
  });

  // 이모지 리액션
  const ALLOWED_EMOJI = ['😎', '🔥', '😱', '😂', '😭', '👍', '🤔', '🎉'];
  // 타임뱅크: 내 차례에 추가 시간(최대 15초) 사용
  socket.on('useTimeBank', (_d, cb) => {
    const room = rooms.get(roomCode);
    if (!room || !room.actionLimit) return cb?.({ ok: false });
    const g = room.game;
    if (!g.hand || g.hand.phase === 'handComplete' || g.hand.phase === 'showdown') return cb?.({ ok: false });
    const seat = g.hand.seats[g.hand.toActIndex];
    if (!seat || seat.id !== playerId) return cb?.({ ok: false, error: '내 차례가 아닙니다' });
    const p = g.getPlayer(playerId);
    if (!p) return cb?.({ ok: false });
    p.timeBank = p.timeBank ?? 30000;
    if (p.timeBank < 1000) return cb?.({ ok: false, error: '타임뱅크가 없습니다' });
    const add = Math.min(p.timeBank, 15000);
    p.timeBank -= add;
    const remaining = Math.max(0, (room.actionDeadline || Date.now()) - Date.now()) + add;
    if (room.actionTimer) clearTimeout(room.actionTimer);
    room.actionDeadline = Date.now() + remaining;
    room.actionLimitEffective = (room.actionLimitEffective || 0) + add;
    room.actionTimer = setTimeout(() => fireActionTimeout(roomCode, seat.id), remaining);
    broadcast(roomCode);
    cb?.({ ok: true, timeBank: p.timeBank });
  });
  // 리더보드: 전체 계정 랭킹(우승 → 잔고 → 핸드승 순)
  socket.on('leaderboard', (_d, cb) => {
    const list = [...users.values()].map((a) => ({
      nick: a.nick, avatar: a.avatar || null,
      wins: (a.stats && a.stats.wins) || 0,
      games: (a.stats && a.stats.games) || 0,
      handsWon: (a.stats && a.stats.handsWon) || 0,
      balance: a.balance || 0,
    }));
    list.sort((a, b) => b.wins - a.wins || b.balance - a.balance || b.handsWon - a.handsWon);
    cb?.({ ok: true, top: list.slice(0, 50) });
  });
  // 상대 프로필 보기(공개 정보만 — 히스토리 제외)
  socket.on('profileByNick', ({ nick } = {}, cb) => {
    const acc = nick && users.get(String(nick).toLowerCase());
    if (!acc) return cb?.({ ok: false });
    cb?.({ ok: true, profile: { nick: acc.nick, avatar: acc.avatar || null, balance: acc.balance || 0, stats: acc.stats || {} } });
  });
  socket.on('react', ({ emoji }) => {
    if (!rateOk('react:' + socket.id, 500)) return; // 도배 방지
    const room = rooms.get(roomCode);
    if (!room) return;
    const p = room.game.getPlayer(playerId);
    if (!p || !ALLOWED_EMOJI.includes(emoji)) return;
    io.to(roomCode).emit('reaction', { id: playerId, emoji });
  });

  socket.on('chat', ({ text }) => {
    const room = rooms.get(roomCode);
    if (!room || !text) return;
    const p = room.game.getPlayer(playerId);
    const isSpec = room.spectators && room.spectators.has(socket.id);
    if (!p && !isSpec) return; // 방의 플레이어 또는 관전자만 채팅 가능
    const name = p ? p.name : (socket.specName || '관전자');
    io.to(roomCode).emit('chat', { name: p ? name : `👀 ${name}`, text: String(text).slice(0, 200), t: Date.now() });
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
    const wasSpec = room.spectators && room.spectators.has(socket.id);
    const leaver = game.getPlayer(playerId);
    if (wasSpec) sysChat(roomCode, `👋 ${socket.specName || '관전자'} 님이 관전을 종료했습니다`);
    else if (leaver) sysChat(roomCode, `👋 ${leaver.name} 님이 방을 나갔습니다`);
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

  // 플레이어 '나가기': 전적 기록 후, 진행 중이면 이번 핸드 종료 시 로비로(로그인 세션은 유지)
  socket.on('leaveGame', (_d, cb) => {
    const room = rooms.get(roomCode);
    if (!room) { roomCode = null; return cb?.({ ok: true, deferred: false }); }
    const g = room.game;
    const p = g.getPlayer(playerId);
    // 진행 중 핸드에 참여 중인 살아있는 플레이어 → 이번 핸드 끝나고 퇴장
    const inLiveHand = g.started && g.hand && g.hand.phase !== 'handComplete' && p && !p.eliminated && !p.isBot;
    const profile = recordForfeit(roomCode, playerId);
    if (inLiveHand) {
      p.pendingLeave = true; p.sittingOut = true;
      sysChat(roomCode, `👋 ${p.name} 님이 이번 핸드 후 나갑니다`);
      // 현재 턴이면 즉시 폴드시켜 핸드 진행
      const seat = g.hand.seats[g.hand.toActIndex];
      if (seat && seat.id === playerId) { g.handleAction(playerId, 'fold'); startActionTimer(roomCode); }
      broadcast(roomCode);
      scheduleNextHand(roomCode);
      return cb?.({ ok: true, deferred: true, profile });
    }
    // 대기 중이거나 핸드 사이 → 즉시 퇴장
    if (p) sysChat(roomCode, `👋 ${p.name} 님이 방을 나갔습니다`);
    finalizeLeave(roomCode, playerId);
    socket.leave(roomCode);
    roomCode = null;
    cb?.({ ok: true, deferred: false, profile });
  });

  socket.on('disconnect', () => {
    userNames.delete(socket.id);
    releaseSession(socket); // 활성 세션 해제(같은 소켓일 때만)
    setTimeout(broadcastOnline, 50); // 접속 종료 → 인원 수 갱신(모든 경우)
    const room = rooms.get(roomCode);
    if (!room) return;
    // 관전자였으면 제거 후 종료
    if (room.spectators && room.spectators.has(socket.id)) {
      room.spectators.delete(socket.id);
      sysChat(roomCode, `👋 ${socket.specName || '관전자'} 님이 관전을 종료했습니다`);
      if (!room.game.getPlayer(playerId)) return;
    }
    const { game } = room;
    const p = game.getPlayer(playerId);
    if (p) {
      p.connected = false;
      if (game.started) sysChat(roomCode, `🔌 ${p.name} 님의 연결이 끊겼습니다`);
    }
    // 자기 차례에 끊겼으면 유예 타이머로 전환(테이블이 멈추지 않도록)
    if (p && game.started && game.hand && game.hand.phase !== 'handComplete') {
      const seat = game.hand.seats[game.hand.toActIndex];
      if (seat && seat.id === playerId) startActionTimer(roomCode);
    }
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

// 비활동 자동 로그아웃: 로그인 상태로 30분간 어떤 액션도 없으면 세션 종료(서버 강제)
const IDLE_LOGOUT_MS = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [, socket] of io.sockets.sockets) {
    if (!socket.account) continue; // 로그인 상태만 대상
    if (now - (socket.lastActivity || now) < IDLE_LOGOUT_MS) continue;
    try {
      const acc = users.get(socket.account.toLowerCase());
      if (acc) { revokeToken(acc); saveUser(acc); } // 토큰 무효화 → 자동 재로그인 방지
      releaseSession(socket);
      socket.account = null;
      userNames.delete(socket.id);
      socket.emit('forceLogout', { reason: '30분 동안 활동이 없어 자동 로그아웃되었습니다' });
      changed = true;
    } catch (e) { console.error('idle logout 오류:', e); }
  }
  if (changed) broadcastOnline();
}, 60 * 1000);

httpServer.listen(PORT, () => {
  console.log(`🎲 Dice 서버 실행: http://localhost:${PORT}`);
});
(async () => {
  await loadUsers(); // 계정 로드(+DB 연결 초기화)
  await loadRooms(); // 이전 방 상태 복구(DB 우선)
})();
