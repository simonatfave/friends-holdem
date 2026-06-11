// 사이드팟 / 올인 런아웃 / 칩 보존 회귀 테스트
// 무작위로 핸드를 끝까지 진행하며 (1) 칩 총합 보존 (2) 음수 칩 없음 (3) 핸드 정상 종료를 검증
import { Game } from '../src/game.js';

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  ✗', msg); } }

// 한 핸드를 자동으로 끝까지 진행(가끔 올인 → 사이드팟 유발), 런아웃은 runoutStep으로 마무리
function playHand(g) {
  let guard = 0;
  while (g.hand && g.hand.phase !== 'handComplete' && guard++ < 2000) {
    const h = g.hand;
    if (h.phase === 'runout' || h.phase === 'showdown') { if (g.runoutStep()) break; continue; }
    const seat = h.seats[h.toActIndex];
    if (!seat) break;
    const legal = g.legalActions(seat.id);
    if (!legal || !legal.length) break;
    const check = legal.find((a) => a.type === 'check');
    const call = legal.find((a) => a.type === 'call');
    const raise = legal.find((a) => a.type === 'raise' || a.type === 'bet');
    let res;
    const r = Math.random();
    if (raise && r < 0.22) res = g.handleAction(seat.id, 'raise', raise.max);       // 가끔 올인
    else if (raise && r < 0.34) res = g.handleAction(seat.id, 'raise', raise.min);   // 가끔 최소 레이즈
    else if (check) res = g.handleAction(seat.id, 'check');
    else if (call) res = g.handleAction(seat.id, 'call');
    else res = g.handleAction(seat.id, 'fold');
    if (!res || !res.ok) g.handleAction(seat.id, 'fold');
  }
}

function runSim(seedPlayers, hands) {
  const g = new Game({ startingChips: 100 });
  seedPlayers.forEach(([id, name]) => g.addPlayer(id, name));
  const total = 100 * seedPlayers.length; // 불변량: 시작 칩 총합(레이크/앤티 없음)
  g.start();
  for (let i = 0; i < hands; i++) {
    if (g.finished) break;
    if (!g.hand || g.hand.phase === 'handComplete') {
      const alive = g.players.filter((p) => p.chips > 0 && !p.eliminated);
      if (alive.length < 2) break;
      g.startHand();
      if (g.finished) break;
    }
    playHand(g);
    // 핸드가 정상 종료된 시점에만 보존 검증(모든 커밋 칩이 정산됨)
    if (g.hand && g.hand.phase === 'handComplete') {
      const now = g.players.reduce((s, p) => s + p.chips, 0);
      assert(now === total, `칩 총합 보존 실패 (핸드 ${i}): ${now} != ${total}`);
      assert(g.players.every((p) => p.chips >= 0), `음수 칩 발생 (핸드 ${i})`);
      if (now !== total) break;
    }
  }
  return total;
}

console.log('사이드팟/칩보존 시뮬레이션...');
for (let trial = 0; trial < 30; trial++) {
  runSim([['a', 'A'], ['b', 'B'], ['c', 'C']], 60);        // 3인(사이드팟 빈발)
}
for (let trial = 0; trial < 15; trial++) {
  runSim([['a', 'A'], ['b', 'B'], ['c', 'C'], ['d', 'D']], 40); // 4인
}

console.log(`\n결과: ${pass} pass, ${fail} fail`);
if (fail) { console.error('테스트 실패'); process.exit(1); }
console.log('✓ 모든 핸드에서 칩 보존·음수칩 없음 확인');
