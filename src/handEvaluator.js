// 7장 중 최고의 5장 패를 평가한다.
// 반환값: 비교 가능한 정수 배열 [category, ...kickers]
// category: 8=스트레이트플러시, 7=포카드, 6=풀하우스, 5=플러시,
//           4=스트레이트, 3=트리플, 2=투페어, 1=원페어, 0=하이카드
// 두 배열은 사전식(lexicographic) 비교로 우열을 가린다.

export const CATEGORY_NAMES = {
  8: 'Straight Flush',
  7: 'Four of a Kind',
  6: 'Full House',
  5: 'Flush',
  4: 'Straight',
  3: 'Three of a Kind',
  2: 'Two Pair',
  1: 'One Pair',
  0: 'High Card',
};

export const CATEGORY_NAMES_KO = {
  8: '스트레이트 플러시',
  7: '포카드',
  6: '풀 하우스',
  5: '플러시',
  4: '스트레이트',
  3: '트리플',
  2: '투 페어',
  1: '원 페어',
  0: '하이 카드',
};

// 5장짜리 패 점수 계산
function score5(cards) {
  const ranks = cards.map((c) => c.r).sort((a, b) => b - a);
  const suits = cards.map((c) => c.s);
  const isFlush = suits.every((s) => s === suits[0]);

  // 랭크별 개수
  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  // [개수, 랭크] 내림차순 정렬
  const groups = Object.entries(counts)
    .map(([r, c]) => [c, Number(r)])
    .sort((a, b) => b[0] - a[0] || b[1] - a[1]);

  // 스트레이트 판정 (A-5 휠 포함)
  const uniq = [...new Set(ranks)].sort((a, b) => b - a);
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    // 휠 A,5,4,3,2
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHigh = 5;
  }

  if (isFlush && straightHigh) return [8, straightHigh];
  if (groups[0][0] === 4) return [7, groups[0][1], groups[1][1]];
  if (groups[0][0] === 3 && groups[1][0] === 2) return [6, groups[0][1], groups[1][1]];
  if (isFlush) return [5, ...ranks];
  if (straightHigh) return [4, straightHigh];
  if (groups[0][0] === 3) {
    const kickers = ranks.filter((r) => r !== groups[0][1]);
    return [3, groups[0][1], ...kickers];
  }
  if (groups[0][0] === 2 && groups[1][0] === 2) {
    const high = Math.max(groups[0][1], groups[1][1]);
    const low = Math.min(groups[0][1], groups[1][1]);
    const kicker = ranks.find((r) => r !== high && r !== low);
    return [2, high, low, kicker];
  }
  if (groups[0][0] === 2) {
    const kickers = ranks.filter((r) => r !== groups[0][1]);
    return [1, groups[0][1], ...kickers];
  }
  return [0, ...ranks];
}

// 배열 사전식 비교: a>b면 양수, a<b면 음수, 같으면 0
export function compareScore(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// 7장(또는 그 이상)에서 최고 점수 찾기
export function evaluate7(cards) {
  if (cards.length < 5) throw new Error('카드가 5장 이상 필요합니다');
  let best = null;
  const n = cards.length;
  // 5장 조합 전부 탐색
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) {
            const s = score5([cards[a], cards[b], cards[c], cards[d], cards[e]]);
            if (!best || compareScore(s, best) > 0) best = s;
          }
  return best;
}

export function handName(score, lang = 'ko') {
  return (lang === 'ko' ? CATEGORY_NAMES_KO : CATEGORY_NAMES)[score[0]];
}

// 7장에서 최고 점수와 그 점수를 만드는 5장을 함께 반환 (하이라이트용)
export function evaluate7WithCards(cards) {
  if (cards.length < 5) throw new Error('카드가 5장 이상 필요합니다');
  let best = null, bestCards = null;
  const n = cards.length;
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) {
            const combo = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const s = score5(combo);
            if (!best || compareScore(s, best) > 0) { best = s; bestCards = combo; }
          }
  return { score: best, cards: bestCards };
}
