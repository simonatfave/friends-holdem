import { makeDeck, shuffle } from './deck.js';
import { evaluate7, compareScore, handName, evaluate7WithCards } from './handEvaluator.js';

// 토너먼트 블라인드 스케줄 생성 (스택 대비 적당히 가파른 곡선)
// 시작 스택 320 (블랙20·레드20·그린20) 기준의 가벼운 블라인드 곡선
export function defaultBlindSchedule() {
  return [
    { sb: 1, bb: 2, ante: 0 },
    { sb: 2, bb: 4, ante: 0 },
    { sb: 3, bb: 6, ante: 0 },
    { sb: 5, bb: 10, ante: 0 },
    { sb: 8, bb: 16, ante: 0 },
    { sb: 10, bb: 20, ante: 0 },
    { sb: 15, bb: 30, ante: 0 },
    { sb: 25, bb: 50, ante: 0 },
    { sb: 40, bb: 80, ante: 0 },
    { sb: 60, bb: 120, ante: 0 },
    { sb: 100, bb: 200, ante: 0 },
  ];
}

const PHASES = ['preflop', 'flop', 'turn', 'river', 'showdown'];

export class Game {
  constructor(opts = {}) {
    this.startingChips = opts.startingChips ?? 320; // 블랙20·레드20·그린20
    this.handsPerLevel = opts.handsPerLevel ?? 8;
    this.levelDurationSec = opts.levelDurationSec ?? 0; // >0 이면 시간 기반 블라인드 상승(단일)
    this.levelDurations = Array.isArray(opts.levelDurations) && opts.levelDurations.length ? opts.levelDurations : null; // 세션별 시간(초)
    this.blindSchedule = opts.blindSchedule ?? defaultBlindSchedule();
    this.actionTimeout = opts.actionTimeout ?? 0; // ms, 0=무제한
    this.startedAt = null;

    this.players = []; // { id, name, chips, connected, sittingOut }
    this.started = false;
    this.finished = false;
    this.paused = false; // 자리 비움 등으로 진행 인원이 1명 이하일 때 일시정지
    this.button = -1;
    this.level = 0;
    this.handNumber = 0;
    this.results = []; // 탈락/우승 순위 (finishing order, 우승이 마지막)
    this.hand = null; // 현재 핸드 상태
    this.log = [];
  }

  // ---------- 플레이어 관리 ----------
  addPlayer(id, name, isBot = false, chair = null) {
    if (this.players.find((p) => p.id === id)) return false;
    // 좌석(chair) 0~8 배정: 지정 자리가 비어있으면 그 자리, 아니면 가장 낮은 빈 자리
    const used = new Set(this.players.map((p) => p.chair));
    let c = (typeof chair === 'number' && chair >= 0 && chair < 9 && !used.has(chair)) ? chair : null;
    if (c == null) { c = 0; while (used.has(c)) c++; }
    this.players.push({
      id,
      name: name?.slice(0, 16) || 'Player',
      chips: this.startingChips,
      connected: true,
      sittingOut: false,
      eliminated: false,
      isBot,
      chair: c,
      penaltyShort: false, // 직전 무액션 타임아웃 → 다음 차례 시간 1/3
    });
    // 좌석 순서대로 정렬(시계방향 진행 순서 유지)
    this.players.sort((a, b) => a.chair - b.chair);
    return true;
  }

  getPlayer(id) {
    return this.players.find((p) => p.id === id);
  }

  setConnected(id, val) {
    const p = this.getPlayer(id);
    if (p) p.connected = val;
  }

  removePlayer(id) {
    // 게임 시작 전에만 완전 제거. 시작 후엔 sittingOut 처리.
    if (!this.started) {
      this.players = this.players.filter((p) => p.id !== id);
    } else {
      const p = this.getPlayer(id);
      if (p) p.connected = false;
    }
  }

  activePlayers() {
    return this.players.filter((p) => !p.eliminated);
  }

  pushLog(msg) {
    this.log.push({ t: Date.now(), msg });
    if (this.log.length > 60) this.log.shift();
  }

  // 시간 기반 블라인드인가 (세션별 또는 단일)
  isTimed() { return !!(this.levelDurations || this.levelDurationSec > 0); }
  // 경과 시간(초)으로 현재 레벨 인덱스
  levelAt(elapsed) {
    if (this.levelDurations) {
      let acc = 0;
      for (let i = 0; i < this.levelDurations.length; i++) {
        acc += this.levelDurations[i];
        if (elapsed < acc) return i;
      }
      return this.levelDurations.length - 1; // 마지막 세션 유지
    }
    return Math.floor(elapsed / (this.levelDurationSec || 1e9));
  }
  // 다음 레벨까지 남은 초 (마지막이면 null)
  secondsToNext(elapsed) {
    if (this.levelDurations) {
      let acc = 0;
      for (let i = 0; i < this.levelDurations.length; i++) {
        acc += this.levelDurations[i];
        if (elapsed < acc) return Math.max(0, Math.ceil(acc - elapsed));
      }
      return null;
    }
    if (this.levelDurationSec > 0) return Math.max(0, Math.ceil(this.levelDurationSec - (elapsed % this.levelDurationSec)));
    return null;
  }

  // ---------- 토너먼트 시작 ----------
  start() {
    if (this.started) return { ok: false, error: '이미 시작됨' };
    if (this.players.length < 1) return { ok: false, error: '플레이어가 없습니다' };
    // 혼자면 테스트용 봇 1명을 자동 추가해 헤즈업으로 진행
    if (this.players.length === 1) {
      this.addPlayer('bot_' + Date.now(), '🤖 Bot', true);
    }
    this.started = true;
    this.startedAt = Date.now();
    this.button = Math.floor(Math.random() * this.players.length);
    this.pushLog(`토너먼트 시작! 시작 스택 ${this.startingChips}`);
    this.startHand();
    return { ok: true };
  }

  currentBlinds() {
    const idx = Math.min(this.level, this.blindSchedule.length - 1);
    return this.blindSchedule[idx];
  }

  // ---------- 새 핸드 시작 ----------
  startHand() {
    const alive = this.activePlayers().filter((p) => p.chips > 0);
    if (alive.length <= 1) {
      this.finishTournament();
      return;
    }
    // 자리 비움 제외 후 진행 가능 인원이 1명 이하면 일시정지(토너먼트 종료 아님)
    const playable = alive.filter((p) => !p.sittingOut);
    if (playable.length <= 1) {
      this.paused = true;
      this.hand = null;
      return;
    }
    this.paused = false;
    this.handNumber++;
    // 레벨 업: 시간 기반(세션별/단일) 또는 핸드 기반
    if (this.isTimed() && this.startedAt) {
      const elapsed = (Date.now() - this.startedAt) / 1000;
      this.level = Math.min(this.levelAt(elapsed), this.blindSchedule.length - 1);
    } else {
      this.level = Math.min(
        Math.floor((this.handNumber - 1) / this.handsPerLevel),
        this.blindSchedule.length - 1
      );
    }
    const blinds = this.currentBlinds();

    // 버튼 이동 (살아있는 플레이어 중 다음으로)
    this.button = this.nextAliveSeat(this.button);

    const order = this.seatOrderFrom(this.button); // 버튼부터 시계방향
    const deck = shuffle(makeDeck());

    // 핸드에 참여하는 플레이어(칩 보유)
    const seats = order
      .map((i) => this.players[i])
      .filter((p) => !p.eliminated && p.chips > 0 && !p.sittingOut);

    const hand = {
      blinds,
      deck,
      seats, // 이번 핸드 좌석 순서 (버튼 다음부터가 아니라 버튼 포함, index 0 = 버튼)
      community: [],
      pot: 0,
      phase: 'preflop',
      bets: {}, // 이번 라운드 베팅액
      committed: {}, // 핸드 전체 누적 (사이드팟용)
      folded: {},
      allIn: {},
      holes: {}, // id -> [card,card]
      currentBet: 0,
      minRaise: blinds.bb,
      toActIndex: 0,
      hasActed: {},
      lastAct: {}, // id -> { type, amount } 마지막 액션(라벨용)
      lastAggressor: null,
      results: null,
    };

    for (const p of seats) {
      hand.bets[p.id] = 0;
      hand.committed[p.id] = 0;
      hand.folded[p.id] = false;
      hand.allIn[p.id] = false;
      hand.hasActed[p.id] = false;
      hand.holes[p.id] = [deck.pop(), deck.pop()];
    }

    this.hand = hand;
    this.pushLog(`핸드 #${this.handNumber} (블라인드 ${blinds.sb}/${blinds.bb}${blinds.ante ? `, 앤티 ${blinds.ante}` : ''})`);

    // 앤티 징수
    if (blinds.ante > 0) {
      for (const p of seats) this.postChips(p, blinds.ante, true);
    }

    // 블라인드 포스팅
    // 헤즈업(2인): 버튼=SB, 상대=BB. 3인 이상: 버튼 다음=SB, 그다음=BB
    let sbSeat, bbSeat, firstToAct;
    if (seats.length === 2) {
      sbSeat = 0; // 버튼
      bbSeat = 1;
      firstToAct = 0; // 프리플랍은 버튼(SB)부터
    } else {
      sbSeat = 1;
      bbSeat = 2;
      firstToAct = 3 % seats.length;
    }
    this.postBlind(seats[sbSeat], blinds.sb);
    this.postBlind(seats[bbSeat], blinds.bb);
    hand.currentBet = blinds.bb;
    hand.minRaise = blinds.bb;
    hand.lastAggressor = seats[bbSeat].id;
    hand.toActIndex = firstToAct;
    // 빅블라인드는 아직 '액션'한 것이 아님(옵션 보유)
    hand.bigBlindId = seats[bbSeat].id;

    this.ensureActable();
  }

  postChips(player, amount, isAnte = false) {
    const pay = Math.min(amount, player.chips);
    player.chips -= pay;
    this.hand.committed[player.id] += pay;
    this.hand.pot += pay;
    if (player.chips === 0) this.hand.allIn[player.id] = true;
    return pay;
  }

  postBlind(player, amount) {
    const pay = Math.min(amount, player.chips);
    player.chips -= pay;
    this.hand.bets[player.id] += pay;
    this.hand.committed[player.id] += pay;
    this.hand.pot += pay;
    if (player.chips === 0) this.hand.allIn[player.id] = true;
  }

  // ---------- 좌석 순서 유틸 ----------
  nextAliveSeat(from) {
    const n = this.players.length;
    for (let k = 1; k <= n; k++) {
      const i = (from + k) % n;
      const p = this.players[i];
      if (!p.eliminated && p.chips > 0 && !p.sittingOut) return i;
    }
    return from;
  }

  seatOrderFrom(start) {
    const n = this.players.length;
    const order = [];
    for (let k = 0; k < n; k++) order.push((start + k) % n);
    return order;
  }

  // ---------- 액션 처리 ----------
  // action: 'fold' | 'check' | 'call' | 'raise' | 'allin'
  // amount: raise일 때 '레이즈 후 총 베팅액(to)' 또는 추가액. 여기선 to(목표 총액)로 받음.
  handleAction(playerId, action, amount) {
    const h = this.hand;
    if (!h || h.phase === 'showdown' || h.phase === 'handComplete') {
      return { ok: false, error: '지금은 액션할 수 없습니다' };
    }
    const seat = h.seats[h.toActIndex];
    if (!seat || seat.id !== playerId) {
      return { ok: false, error: '당신의 차례가 아닙니다' };
    }
    const p = seat;
    const toCall = h.currentBet - h.bets[p.id];

    if (action === 'fold') {
      h.folded[p.id] = true;
      h.hasActed[p.id] = true;
      h.lastAct[p.id] = { type: 'fold' };
      this.pushLog(`${p.name} 폴드`);
    } else if (action === 'check') {
      if (toCall > 0) return { ok: false, error: '체크할 수 없습니다 (콜 필요)' };
      h.hasActed[p.id] = true;
      h.lastAct[p.id] = { type: 'check' };
      this.pushLog(`${p.name} 체크`);
    } else if (action === 'call') {
      if (toCall <= 0) return { ok: false, error: '콜할 게 없습니다' };
      const pay = Math.min(toCall, p.chips);
      this.commitBet(p, pay);
      h.hasActed[p.id] = true;
      h.lastAct[p.id] = { type: 'call', amount: pay, allIn: p.chips === 0 };
      this.pushLog(`${p.name} 콜 ${pay}`);
    } else if (action === 'raise' || action === 'bet') {
      // amount = 목표 총 베팅액(to)
      let target = Math.floor(amount);
      const maxTo = h.bets[p.id] + p.chips; // 올인 시 최대
      if (target > maxTo) target = maxTo;
      const raiseBy = target - h.currentBet;
      const minTarget = h.currentBet + h.minRaise;
      const isAllIn = target === maxTo;
      // 최소 레이즈 미달은 올인일 때만 허용
      if (target <= h.currentBet) return { ok: false, error: '레이즈 금액이 부족합니다' };
      if (target < minTarget && !isAllIn) {
        return { ok: false, error: `최소 ${minTarget}까지 올려야 합니다` };
      }
      const pay = target - h.bets[p.id];
      this.commitBet(p, pay);
      if (raiseBy >= h.minRaise) h.minRaise = raiseBy; // 정상 레이즈면 minRaise 갱신
      h.currentBet = Math.max(h.currentBet, target);
      h.lastAggressor = p.id;
      // 레이즈 시 다른 플레이어 액션 리셋
      for (const s of h.seats) {
        if (!h.folded[s.id] && !h.allIn[s.id] && s.id !== p.id) h.hasActed[s.id] = false;
      }
      h.hasActed[p.id] = true;
      h.lastAct[p.id] = { type: toCall === 0 ? 'bet' : 'raise', amount: target, allIn: isAllIn };
      this.pushLog(`${p.name} ${h.bets[p.id] === pay && toCall === 0 ? '벳' : '레이즈'} → ${target}`);
    } else {
      return { ok: false, error: '알 수 없는 액션' };
    }

    this.afterAction();
    return { ok: true };
  }

  commitBet(player, pay) {
    const h = this.hand;
    pay = Math.min(pay, player.chips);
    player.chips -= pay;
    h.bets[player.id] += pay;
    h.committed[player.id] += pay;
    h.pot += pay;
    if (player.chips === 0) h.allIn[player.id] = true;
  }

  // 라운드/핸드 진행
  afterAction() {
    const h = this.hand;
    const contestants = h.seats.filter((s) => !h.folded[s.id]);

    // 한 명 빼고 다 폴드 → 즉시 종료
    if (contestants.length === 1) {
      this.endHandUncontested(contestants[0]);
      return;
    }

    // 베팅 가능한(폴드X, 올인X) 플레이어
    const canAct = h.seats.filter((s) => !h.folded[s.id] && !h.allIn[s.id]);

    // 라운드 종료 조건: 액션 가능한 모두가 행동했고 베팅이 동일
    const allActed = canAct.every((s) => h.hasActed[s.id] && h.bets[s.id] === h.currentBet);

    if (canAct.length <= 1) {
      // 더 이상 베팅 불가 → 보드 끝까지 돌리고 쇼다운
      if (allActedOrNoBet(h, canAct)) {
        this.runOutAndShowdown();
        return;
      }
    }

    if (allActed) {
      this.advancePhase();
      return;
    }

    // 다음 행동할 사람으로 이동
    this.advanceToNext();
  }

  advanceToNext() {
    const h = this.hand;
    const n = h.seats.length;
    for (let k = 1; k <= n; k++) {
      const idx = (h.toActIndex + k) % n;
      const s = h.seats[idx];
      if (!h.folded[s.id] && !h.allIn[s.id]) {
        h.toActIndex = idx;
        return;
      }
    }
  }

  ensureActable() {
    const h = this.hand;
    const s = h.seats[h.toActIndex];
    if (!s || h.folded[s.id] || h.allIn[s.id]) this.advanceToNext();
  }

  advancePhase() {
    const h = this.hand;
    // 라운드 정산: bets 초기화
    for (const s of h.seats) {
      h.bets[s.id] = 0;
      h.hasActed[s.id] = false;
    }
    h.currentBet = 0;
    h.minRaise = h.blinds.bb;
    h.lastAggressor = null;

    const cur = PHASES.indexOf(h.phase);
    const next = PHASES[cur + 1];

    if (next === 'flop') {
      h.deck.pop(); // 번 카드
      h.community.push(h.deck.pop(), h.deck.pop(), h.deck.pop());
    } else if (next === 'turn' || next === 'river') {
      h.deck.pop();
      h.community.push(h.deck.pop());
    }
    h.phase = next;
    this.pushLog(`-- ${phaseLabel(next)} --`);

    if (next === 'showdown') {
      this.doShowdown();
      return;
    }

    // 포스트플랍 첫 행동: 버튼 다음(살아있는) — 헤즈업이면 BB(버튼 아닌 쪽)부터
    h.toActIndex = this.firstToActPostflop();
    // 액션 가능한 사람이 1명 이하면 바로 다음
    const canAct = h.seats.filter((s) => !h.folded[s.id] && !h.allIn[s.id]);
    if (canAct.length <= 1) {
      this.runOutAndShowdown();
    } else {
      this.ensureActable();
    }
  }

  firstToActPostflop() {
    const h = this.hand;
    const n = h.seats.length;
    // 좌석 0 = 버튼. 버튼 다음부터 첫 액션
    for (let k = 1; k <= n; k++) {
      const idx = k % n;
      const s = h.seats[idx];
      if (!h.folded[s.id] && !h.allIn[s.id]) return idx;
    }
    return 0;
  }

  // 더 이상 베팅 불가(올인 등) → 런아웃 모드. 카드 공개, 서버가 한 장씩 진행.
  runOutAndShowdown() {
    const h = this.hand;
    h.runout = true;
    h.revealAll = true;
    h.phase = 'runout';
    h.equity = this.computeEquity(); // 올인 시점 승률
  }

  // 런아웃 한 단계 진행 (서버가 딜레이를 두고 반복 호출). 끝나면 true.
  runoutStep() {
    const h = this.hand;
    if (!h) return true;
    if (h.community.length >= 5) {
      h.phase = 'showdown';
      h.equity = null;
      this.doShowdown();
      return true;
    }
    if (h.community.length === 0) {
      h.deck.pop();
      h.community.push(h.deck.pop(), h.deck.pop(), h.deck.pop());
      this.pushLog('-- 플랍 (올인) --');
    } else {
      h.deck.pop();
      h.community.push(h.deck.pop());
      this.pushLog(`-- ${h.community.length === 4 ? '턴' : '리버'} (올인) --`);
    }
    h.equity = this.computeEquity(); // 보드가 바뀔 때마다 승률 갱신
    return false;
  }

  // 올인 런아웃 승률(에쿼티) 계산: 남은 컨텐더들의 승리 확률(%)
  computeEquity() {
    const h = this.hand;
    if (!h) return null;
    const contenders = h.seats.filter((s) => !h.folded[s.id]);
    if (contenders.length < 2) return null;
    const toCome = 5 - h.community.length;
    const key = (c) => c.r * 4 + c.s;
    const known = new Set();
    for (const s of h.seats) for (const c of (h.holes[s.id] || [])) known.add(key(c));
    for (const c of h.community) known.add(key(c));
    const pool = [];
    for (let su = 0; su < 4; su++) for (let r = 2; r <= 14; r++) {
      if (!known.has(r * 4 + su)) pool.push({ r, s: su });
    }
    const wins = {};
    contenders.forEach((s) => (wins[s.id] = 0));
    let trials = 0;
    const evalBoard = (extra) => {
      const board = h.community.concat(extra);
      let bestScore = null;
      let bestIds = [];
      for (const s of contenders) {
        const sc = evaluate7(h.holes[s.id].concat(board));
        const cmp = bestScore ? compareScore(sc, bestScore) : 1;
        if (cmp > 0) { bestScore = sc; bestIds = [s.id]; }
        else if (cmp === 0) bestIds.push(s.id);
      }
      const share = 1 / bestIds.length;
      for (const id of bestIds) wins[id] += share;
      trials++;
    };
    if (toCome <= 0) {
      evalBoard([]);
    } else {
      const comb = (n, k) => { let c = 1; for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1); return c; };
      if (comb(pool.length, toCome) <= 2600) {
        // 완전 탐색 (남은 카드 1~2장)
        const rec = (start, chosen) => {
          if (chosen.length === toCome) { evalBoard(chosen); return; }
          for (let i = start; i < pool.length; i++) { chosen.push(pool[i]); rec(i + 1, chosen); chosen.pop(); }
        };
        rec(0, []);
      } else {
        // 몬테카를로 샘플링
        const N = 1800;
        for (let t = 0; t < N; t++) {
          const picked = [];
          const used = new Set();
          while (picked.length < toCome) {
            const i = Math.floor(Math.random() * pool.length);
            if (used.has(i)) continue;
            used.add(i);
            picked.push(pool[i]);
          }
          evalBoard(picked);
        }
      }
    }
    const eq = {};
    for (const s of contenders) eq[s.id] = Math.round((wins[s.id] / trials) * 100);
    return eq;
  }

  // ---------- 봇 의사결정 (핸드 강도 + 팟오즈 기반) ----------
  preflopStrength(hole) {
    if (!hole || hole.length < 2) return 0.3;
    const [a, b] = hole;
    const hi = Math.max(a.r, b.r), lo = Math.min(a.r, b.r);
    const pair = a.r === b.r, suited = a.s === b.s, gap = hi - lo;
    let s;
    if (pair) {
      s = 0.5 + ((hi - 2) / 12) * 0.5; // 22~AA → 0.5~1.0
    } else {
      s = ((hi - 2) / 12) * 0.45 + ((lo - 2) / 12) * 0.2;
      if (suited) s += 0.08;
      if (gap === 1) s += 0.06;
      else if (gap === 2) s += 0.03;
      else if (gap > 4) s -= 0.05;
      if (hi === 14) s += 0.05;
    }
    return Math.max(0.05, Math.min(1, s));
  }
  postflopStrength(hole, community) {
    const score = evaluate7(hole.concat(community));
    const base = [0.18, 0.40, 0.55, 0.70, 0.82, 0.90, 0.95, 0.98, 1.0];
    return base[score[0]] ?? 0.3;
  }
  botDecision(id) {
    const h = this.hand;
    const legal = this.legalActions(id);
    if (!legal) return { type: 'fold' };
    const check = legal.find((a) => a.type === 'check');
    const call = legal.find((a) => a.type === 'call');
    const raise = legal.find((a) => a.type === 'raise' || a.type === 'bet');
    const toCall = call ? call.amount : 0;
    const pot = Math.max(1, h.pot || 1);
    const strength = h.community.length === 0
      ? this.preflopStrength(h.holes[id])
      : this.postflopStrength(h.holes[id], h.community);
    const rnd = Math.random();
    const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
    const clampRaise = (frac) => Math.min(raise.max, Math.max(raise.min, Math.round(pot * frac)));
    if (check) {
      // 베팅 없음: 강하면 밸류벳, 가끔 블러프
      if (raise && (strength > 0.62 || rnd < 0.08)) return { type: 'raise', amount: clampRaise(strength > 0.8 ? 0.75 : 0.5) };
      return { type: 'check' };
    }
    // 베팅에 직면
    if (raise && strength > 0.8 && rnd < 0.7) return { type: 'raise', amount: clampRaise(0.7) };
    if (call) {
      if (strength >= potOdds + 0.08 || (strength > 0.45 && potOdds < 0.3)) return { type: 'call' };
      if (rnd < 0.1 && potOdds < 0.25) return { type: 'call' }; // 가끔 콜
      return { type: 'fold' };
    }
    return { type: 'fold' };
  }

  // ---------- 쇼다운 & 사이드팟 ----------
  doShowdown() {
    const h = this.hand;
    const contenders = h.seats.filter((s) => !h.folded[s.id]);

    // 각 플레이어 패 점수 + 베스트5(하이라이트용)
    const scores = {};
    const bests = {};
    for (const s of contenders) {
      const r = evaluate7WithCards([...h.holes[s.id], ...h.community]);
      scores[s.id] = r.score;
      bests[s.id] = r.cards.map((c) => ({ r: c.r, s: c.s }));
    }

    // 사이드팟 분배
    const awards = this.distributePots(contenders, scores);

    const winnerIds = new Set();
    awards.forEach((a) => a.winners.forEach((w) => winnerIds.add(w.id)));

    const reveal = contenders.map((s) => ({
      id: s.id,
      name: s.name,
      hole: h.holes[s.id],
      score: scores[s.id],
      handName: handName(scores[s.id], 'ko'),
      best: bests[s.id],
      isWinner: winnerIds.has(s.id),
    }));

    h.results = { awards, reveal };
    h.phase = 'handComplete';
    for (const a of awards) {
      this.pushLog(`${a.winners.map((w) => w.name).join(', ')} 팟 ${a.amount} 획득 (${a.handName || ''})`);
    }
    this.markEliminations();
  }

  distributePots(contenders, scores) {
    const h = this.hand;
    // committed: 모든 핸드 참가자(폴드 포함)의 누적 기여
    const contrib = {};
    for (const s of h.seats) contrib[s.id] = h.committed[s.id];

    const awards = [];
    // 기여가 남아있는 동안 레이어별로 분배
    let guard = 0;
    while (guard++ < 50) {
      const positive = h.seats.filter((s) => contrib[s.id] > 0);
      if (positive.length === 0) break;
      const layer = Math.min(...positive.map((s) => contrib[s.id]));
      let potAmount = 0;
      for (const s of positive) {
        contrib[s.id] -= layer;
        potAmount += layer;
      }
      // 이 팟의 자격자 = 폴드 안 한 contenders 중 이 레이어에 기여한 사람
      const eligible = contenders.filter((s) =>
        positive.includes(s)
      );
      if (eligible.length === 0) {
        // 이 레이어에 자격 있는(폴드 안 한) 기여자가 없음 = 콜되지 않은 베팅(언콜드 벳).
        // 칩을 잃지 않도록 기여자 본인에게 환급한다. (정상 플레이에선 기여자 1명)
        for (const s of positive) s.chips += layer;
        continue;
      }
      // 최고 패 찾기
      let best = null;
      for (const s of eligible) {
        if (!best || compareScore(scores[s.id], scores[best.id]) > 0) best = s;
      }
      const winners = eligible.filter(
        (s) => compareScore(scores[s.id], scores[best.id]) === 0
      );
      const share = Math.floor(potAmount / winners.length);
      let remainder = potAmount - share * winners.length;
      const winInfo = [];
      for (const w of winners) {
        let amt = share;
        if (remainder > 0) {
          amt += 1;
          remainder -= 1;
        }
        w.chips += amt;
        winInfo.push({ id: w.id, name: w.name, amount: amt });
      }
      awards.push({
        amount: potAmount,
        winners: winInfo,
        handName: handName(scores[best.id], 'ko'),
      });
    }
    return awards;
  }

  endHandUncontested(winner) {
    const h = this.hand;
    winner.chips += h.pot;
    h.results = {
      awards: [{ amount: h.pot, winners: [{ id: winner.id, name: winner.name, amount: h.pot }], handName: null }],
      reveal: [], // 패 공개 안 함
    };
    h.phase = 'handComplete';
    this.pushLog(`${winner.name} 팟 ${h.pot} 획득 (전원 폴드)`);
    this.markEliminations();
  }

  markEliminations() {
    // 칩 0 → 탈락. 이번 핸드에서 탈락한 사람들 순위 기록.
    const busted = this.activePlayers().filter((p) => p.chips <= 0);
    if (busted.length) {
      // 탈락 시점 칩이 적었던 순(=먼저 올인 짐)으로 정렬은 단순화: 그대로 기록
      for (const p of busted) {
        p.eliminated = true;
      }
      const remaining = this.activePlayers().length;
      for (const p of busted) {
        this.results.unshift({ id: p.id, name: p.name, place: remaining + busted.length });
        this.pushLog(`${p.name} 탈락! (${remaining + 1}위)`);
      }
    }
  }

  // 다음 핸드로 (서버가 딜레이 후 호출)
  nextHand() {
    if (this.finished) return;
    const alive = this.activePlayers().filter((p) => p.chips > 0);
    if (alive.length <= 1) {
      this.finishTournament();
      return;
    }
    this.startHand();
  }

  finishTournament() {
    this.finished = true;
    const winner = this.activePlayers().find((p) => p.chips > 0);
    if (winner) {
      this.results.unshift({ id: winner.id, name: winner.name, place: 1 });
      this.pushLog(`🏆 우승: ${winner.name}!`);
    }
    this.hand = null;
  }

  // ---------- 상태 직렬화 ----------
  legalActions(playerId) {
    const h = this.hand;
    if (!h || h.phase === 'showdown' || h.phase === 'handComplete' || h.phase === 'runout') return null;
    const seat = h.seats[h.toActIndex];
    if (!seat || seat.id !== playerId) return null;
    const p = seat;
    const toCall = h.currentBet - h.bets[p.id];
    const acts = [];
    acts.push({ type: 'fold' });
    if (toCall <= 0) acts.push({ type: 'check' });
    else acts.push({ type: 'call', amount: Math.min(toCall, p.chips) });
    // 레이즈/벳 가능 여부
    const maxTo = h.bets[p.id] + p.chips;
    if (maxTo > h.currentBet) {
      const minTo = Math.min(h.currentBet + h.minRaise, maxTo);
      acts.push({
        type: h.currentBet === 0 ? 'bet' : 'raise',
        min: minTo,
        max: maxTo,
      });
    }
    return acts;
  }

  getStateFor(viewerId) {
    const blinds = this.started && !this.finished ? this.currentBlinds() : (this.hand?.blinds ?? this.currentBlinds());
    const h = this.hand;
    const toActId = h && (h.phase !== 'showdown' && h.phase !== 'handComplete' && h.phase !== 'runout')
      ? h.seats[h.toActIndex]?.id
      : null;

    const players = this.players.map((p) => {
      const inHand = h ? h.seats.some((s) => s.id === p.id) : false;
      const showHole =
        h && inHand &&
        (p.id === viewerId ||
          (h.revealAll && !h.folded[p.id]) ||
          (h.phase === 'handComplete' && h.results?.reveal?.some((r) => r.id === p.id)));
      return {
        id: p.id,
        name: p.name,
        chips: p.chips,
        chair: p.chair,
        connected: p.connected,
        eliminated: p.eliminated,
        sittingOut: p.sittingOut,
        penaltyShort: p.penaltyShort,
        isBot: p.isBot,
        inHand,
        folded: h ? !!h.folded[p.id] : false,
        allIn: h ? !!h.allIn[p.id] : false,
        bet: h ? (h.bets[p.id] ?? 0) : 0,
        lastAction: h ? (h.lastAct[p.id] || null) : null,
        isButton: h ? h.seats[0]?.id === p.id : false,
        isToAct: p.id === toActId,
        hole: showHole ? h.holes[p.id] : (inHand ? [{ hidden: true }, { hidden: true }] : null),
      };
    });

    // 뷰어의 현재 최선 족보(플랍 이후, 폴드 안 했을 때)
    let myHand = null;
    if (h && h.holes[viewerId] && !h.folded[viewerId] && h.community.length >= 3
        && h.seats.some((s) => s.id === viewerId)) {
      myHand = handName(evaluate7([...h.holes[viewerId], ...h.community]), 'ko');
    }

    // 시간 기반 블라인드일 때 다음 레벨까지 남은 초
    let secondsToNextLevel = null;
    if (this.isTimed() && this.startedAt && this.started && !this.finished
        && this.level < this.blindSchedule.length - 1) {
      const elapsed = (Date.now() - this.startedAt) / 1000;
      secondsToNextLevel = this.secondsToNext(elapsed);
    }

    return {
      started: this.started,
      finished: this.finished,
      paused: this.paused,
      handNumber: this.handNumber,
      level: this.level + 1,
      blinds,
      nextLevelIn: this.handsPerLevel - ((this.handNumber - 1) % this.handsPerLevel) - 1,
      timedBlinds: this.isTimed(),
      myHand,
      secondsToNextLevel,
      runout: !!h?.runout,
      equity: h?.equity ?? null,
      pot: h?.pot ?? 0,
      community: h?.community ?? [],
      phase: h?.phase ?? null,
      toActId,
      players,
      legal: this.legalActions(viewerId),
      results: h?.results ?? null,
      finalResults: this.finished ? this.results : null,
      log: this.log.slice(-12),
      youId: viewerId,
    };
  }
}

function phaseLabel(phase) {
  return { preflop: '프리플랍', flop: '플랍', turn: '턴', river: '리버', showdown: '쇼다운' }[phase] || phase;
}

function allActedOrNoBet(h, canAct) {
  // 베팅 라운드가 끝났는지(올인 정리 상황) — 남은 액터들이 모두 콜/체크 완료
  return canAct.every((s) => h.hasActed[s.id] && h.bets[s.id] === h.currentBet);
}
