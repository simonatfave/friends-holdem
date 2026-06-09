// 무작위 봇으로 토너먼트를 끝까지 돌려 크래시/칩 보존 오류를 검증한다.
import { Game } from '../src/game.js';

function randomAction(game, id) {
  const legal = game.legalActions(id);
  if (!legal) return false;
  const r = Math.random();
  const raise = legal.find((a) => a.type === 'raise' || a.type === 'bet');
  const call = legal.find((a) => a.type === 'call');
  const check = legal.find((a) => a.type === 'check');
  if (raise && r < 0.25) {
    const amt = Math.floor(raise.min + Math.random() * (raise.max - raise.min));
    return game.handleAction(id, 'raise', amt);
  }
  if (check && r < 0.85) return game.handleAction(id, 'check');
  if (call && r < 0.8) return game.handleAction(id, 'call');
  return game.handleAction(id, 'fold');
}

let totalGames = 200, errors = 0, chipErrors = 0;
for (let g = 0; g < totalGames; g++) {
  const nPlayers = 2 + Math.floor(Math.random() * 8); // 2~9명
  const game = new Game({ startingChips: 1500, handsPerLevel: 4 });
  for (let i = 0; i < nPlayers; i++) game.addPlayer('p' + i, 'P' + i);
  const totalChips = nPlayers * 1500;
  game.start();

  let guard = 0;
  while (!game.finished && guard++ < 5000) {
    const h = game.hand;
    if (!h) break;
    if (h.phase === 'runout') {
      // 올인 런아웃: 끝까지 단계 진행
      let g2 = 0;
      while (!game.runoutStep() && g2++ < 10) {}
      continue;
    }
    if (h.phase === 'handComplete') {
      // 칩 보존 확인
      const sum = game.players.reduce((a, p) => a + p.chips, 0);
      if (sum !== totalChips) { chipErrors++; console.error(`칩 불일치 게임${g}: ${sum} != ${totalChips}`); break; }
      game.nextHand();
      continue;
    }
    const id = h.seats[h.toActIndex]?.id;
    if (!id) { errors++; console.error(`행동자 없음 게임${g}`); break; }
    const res = randomAction(game, id);
    if (res && !res.ok) {
      // 잘못된 액션이면 폴드로 강제
      const f = game.handleAction(id, 'fold');
      if (!f.ok) { errors++; console.error(`액션 막힘 게임${g}: ${res.error}`); break; }
    }
  }
  if (guard >= 5000) { errors++; console.error(`게임${g} 무한루프 의심`); }
  // 종료 후 우승자 1명 + 칩 보존
  if (game.finished) {
    const sum = game.players.reduce((a, p) => a + p.chips, 0);
    if (sum !== totalChips) { chipErrors++; console.error(`종료후 칩 불일치 게임${g}: ${sum}`); }
    const alive = game.players.filter((p) => p.chips > 0);
    if (alive.length !== 1) { errors++; console.error(`우승자 수 이상 게임${g}: ${alive.length}`); }
  }
}

console.log(`\n시뮬레이션 ${totalGames}게임: 오류 ${errors}, 칩보존오류 ${chipErrors}`);
process.exit(errors || chipErrors ? 1 : 0);
