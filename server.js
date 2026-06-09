import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Game } from './src/game.js';

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

function broadcast(code) {
  const room = rooms.get(code);
  if (!room) return;
  const { game } = room;
  for (const p of game.players) {
    io.to(p.socketId || '').emit('state', game.getStateFor(p.id));
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
    broadcast(code);
    if (game.hand && game.hand.phase === 'handComplete') scheduleNextHand(code);
    else maybeBotAct(code);
  }, delay);
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
    broadcast(code);
    if (res.ok) {
      scheduleNextHand(code);
      maybeBotAct(code);
    }
  }, 1300);
}

io.on('connection', (socket) => {
  let roomCode = null;
  let playerId = socket.id;

  socket.on('create', ({ name, settings }, cb) => {
    const code = makeRoomCode();
    const game = new Game({
      startingChips: clampInt(settings?.startingChips, 500, 100000, 1500),
      handsPerLevel: clampInt(settings?.handsPerLevel, 2, 50, 8),
    });
    game.addPlayer(playerId, name);
    game.getPlayer(playerId).socketId = socket.id;
    rooms.set(code, { game, hostId: playerId });
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
    broadcast(roomCode);
    scheduleNextHand(roomCode);
    maybeBotAct(roomCode);
  });

  socket.on('addBot', (_d, cb) => {
    const room = rooms.get(roomCode);
    if (!room) return cb?.({ ok: false, error: '방 없음' });
    if (room.hostId !== playerId) return cb?.({ ok: false, error: '방장만 추가할 수 있습니다' });
    if (room.game.started) return cb?.({ ok: false, error: '이미 시작됨' });
    if (room.game.players.length >= 9) return cb?.({ ok: false, error: '가득 찼습니다' });
    const n = room.game.players.filter((p) => p.isBot).length + 1;
    room.game.addPlayer('bot_' + Date.now() + '_' + n, `🤖 Bot ${n}`, true);
    cb?.({ ok: true });
    broadcast(roomCode);
  });

  socket.on('action', ({ type, amount }, cb) => {
    const room = rooms.get(roomCode);
    if (!room) return cb?.({ ok: false, error: '방 없음' });
    const r = room.game.handleAction(playerId, type, amount);
    cb?.(r);
    if (r.ok) {
      broadcast(roomCode);
      scheduleNextHand(roomCode);
      maybeBotAct(roomCode);
    }
  });

  socket.on('chat', ({ text }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    const p = room.game.getPlayer(playerId);
    if (!p || !text) return;
    io.to(roomCode).emit('chat', { name: p.name, text: String(text).slice(0, 200), t: Date.now() });
  });

  socket.on('disconnect', () => {
    const room = rooms.get(roomCode);
    if (!room) return;
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
        if (room.timer) clearTimeout(room.timer);
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

httpServer.listen(PORT, () => {
  console.log(`🎲 Dice 서버 실행: http://localhost:${PORT}`);
});
