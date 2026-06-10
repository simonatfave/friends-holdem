import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
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

function stateFor(room, viewerId) {
  const st = room.game.getStateFor(viewerId);
  st.actionDeadline = room.actionDeadline || null;
  st.actionLimit = room.actionLimit || null;
  st.spectator = room.spectators ? room.spectators.has(viewerId) : false;
  st.isHost = room.hostId === viewerId;
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
  const step = () => {
    room.runoutTimer = null;
    if (!rooms.has(code)) return;
    const gg = room.game;
    if (!gg.hand || gg.hand.phase !== 'runout') { broadcast(code); return; }
    const done = gg.runoutStep();
    broadcast(code);
    if (done) scheduleNextHand(code);
    else room.runoutTimer = setTimeout(step, 1100);
  };
  room.runoutTimer = setTimeout(step, 900);
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
  room.actionDeadline = Date.now() + room.actionLimit;
  room.actionTimer = setTimeout(() => {
    if (!rooms.has(code)) return;
    const legal = g.legalActions(seat.id);
    if (!legal) return;
    const check = legal.find((a) => a.type === 'check');
    const res = g.handleAction(seat.id, check ? 'check' : 'fold');
    if (res.ok) {
      startActionTimer(code);
      broadcast(code);
      scheduleNextHand(code);
      maybeBotAct(code);
      driveRunout(code);
    }
  }, room.actionLimit);
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
    const check = legal.find((a) => a.type === 'check');
    const call = legal.find((a) => a.type === 'call');
    const raise = legal.find((a) => a.type === 'raise' || a.type === 'bet');
    const r = Math.random();
    let action;
    if (raise && r < 0.12) action = { type: 'raise', amount: raise.min };
    else if (check) action = { type: 'check' };
    else if (call) action = { type: 'call' };
    else action = { type: 'fold' };
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

  socket.on('create', ({ name, settings }, cb) => {
    const code = makeRoomCode();
    const levelMinutes = clampInt(settings?.levelMinutes, 1, 60, 3);
    // 방장이 정한 시작 빅블라인드로 블라인드 곡선 스케일
    const startBB = clampInt(settings?.startBB, 2, 1000, 2);
    const sb1 = Math.max(1, Math.round(startBB / 2));
    const ratio = startBB / 2; // 기본 곡선 레벨1 BB=2 기준
    const blindSchedule = defaultBlindSchedule().map((l, i) =>
      i === 0
        ? { sb: sb1, bb: startBB, ante: 0 }
        : {
            sb: Math.max(1, Math.round(l.sb * ratio)),
            bb: Math.max(2, Math.round(l.bb * ratio)),
            ante: Math.round(l.ante * ratio),
          }
    );
    const game = new Game({
      startingChips: 320, // 친목용: 블랙20·레드20·그린20 고정
      levelDurationSec: levelMinutes * 60, // 시간 기반 블라인드 상승
      blindSchedule,
    });
    game.addPlayer(playerId, name);
    game.getPlayer(playerId).socketId = socket.id;
    const actionSec = clampInt(settings?.actionSeconds, 0, 120, 25);
    rooms.set(code, { game, hostId: playerId, actionLimit: actionSec > 0 ? actionSec * 1000 : 0 });
    roomCode = code;
    socket.join(code);
    cb?.({ ok: true, code, youId: playerId });
    broadcast(code);
  });

  socket.on('join', ({ code, name }, cb) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: '방을 찾을 수 없습니다' });
    const { game } = room;
    if (game.started) {
      // 재접속 처리: 같은 이름이 끊겨있으면 자리 인수
      const seat = game.players.find((p) => p.name === name && !p.connected && !p.eliminated);
      if (seat) {
        seat.connected = true;
        seat.socketId = socket.id;
        playerId = seat.id;
        roomCode = code;
        socket.join(code);
        cb?.({ ok: true, code, youId: playerId });
        broadcast(code);
        return;
      }
      return cb?.({ ok: false, error: '이미 시작된 게임입니다' });
    }
    if (game.players.length >= 9) return cb?.({ ok: false, error: '방이 가득 찼습니다 (최대 9명)' });
    game.addPlayer(playerId, name);
    game.getPlayer(playerId).socketId = socket.id;
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
    target = Math.max(0, Math.min(target, 9 - humans)); // 전체 최대 9명
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
    if (g.players.length >= 9) return cb?.({ ok: false, error: '자리가 가득 찼습니다 (최대 9명)' });
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
    const r = room.game.handleAction(playerId, type, amount);
    cb?.(r);
    if (r.ok) {
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
      const g = room.game;
      list.push({
        code,
        humans: g.players.filter((p) => !p.isBot).length,
        total: g.players.length,
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
  socket.on('spectate', ({ code }, cb) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: '방을 찾을 수 없습니다' });
    roomCode = code;
    if (!room.spectators) room.spectators = new Set();
    room.spectators.add(socket.id);
    socket.join(code);
    cb?.({ ok: true, code, youId: socket.id, spectator: true });
    io.to(socket.id).emit('state', stateFor(room, socket.id));
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
    if (!anyConnected && !anySpec) {
      clearRoomTimers(room);
      rooms.delete(code);
    }
  }
}, 60000);

httpServer.listen(PORT, () => {
  console.log(`🎲 Dice 서버 실행: http://localhost:${PORT}`);
});
