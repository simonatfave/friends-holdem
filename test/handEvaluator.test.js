import { evaluate7, compareScore, handName } from '../src/handEvaluator.js';

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (a === b) { pass++; }
  else { fail++; console.error(`✗ ${msg}: expected ${b}, got ${a}`); }
}
function ok(cond, msg) {
  if (cond) pass++; else { fail++; console.error(`✗ ${msg}`); }
}
const C = (s) => {
  // "As Kd Th 2c" 형식 파서
  const rmap = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
  return s.split(/\s+/).map((tok) => {
    const r = rmap[tok[0]] || parseInt(tok.slice(0, tok.length - 1), 10);
    return { r, s: tok[tok.length - 1] };
  });
};

// 카테고리 인식
eq(handName(evaluate7(C('As Ks Qs Js Ts 2c 3d')), 'en'), 'Straight Flush', '로열/스트레이트 플러시');
eq(handName(evaluate7(C('9h 9d 9s 9c 2h 3d 4c')), 'en'), 'Four of a Kind', '포카드');
eq(handName(evaluate7(C('Kh Kd Ks 7c 7h 2d 3c')), 'en'), 'Full House', '풀하우스');
eq(handName(evaluate7(C('2h 5h 8h Jh Kh 3d 4c')), 'en'), 'Flush', '플러시');
eq(handName(evaluate7(C('5h 6d 7s 8c 9h 2d Ac')), 'en'), 'Straight', '스트레이트');
eq(handName(evaluate7(C('Ah 5d 4s 3c 2h 9d Kc')), 'en'), 'Straight', '휠 스트레이트(A-5)');
eq(handName(evaluate7(C('Qh Qd Qs 4c 7h 9d Kc')), 'en'), 'Three of a Kind', '트리플');
eq(handName(evaluate7(C('Jh Jd 4s 4c 7h 9d Kc')), 'en'), 'Two Pair', '투페어');
eq(handName(evaluate7(C('Th Td 4s 8c 7h 9d Kc')), 'en'), 'One Pair', '원페어');
eq(handName(evaluate7(C('2h 4d 6s 8c Th Qd Kc')), 'en'), 'High Card', '하이카드');

// 비교: 더 높은 풀하우스 vs 낮은 풀하우스
const fhHigh = evaluate7(C('Ah Ad As Kc Kh 2d 3c'));
const fhLow = evaluate7(C('Kh Kd Ks Qc Qh 2d 3c'));
ok(compareScore(fhHigh, fhLow) > 0, 'AAA KK > KKK QQ');

// 키커 비교: 같은 페어, 다른 키커
const pA = evaluate7(C('9h 9d Ah 5d 4s 3c 2h'));
const pB = evaluate7(C('9s 9c Kh 5h 4d 3s 2c'));
ok(compareScore(pA, pB) > 0, '99 A키커 > 99 K키커');

// 플러시 키커
const flA = evaluate7(C('Ah Qh 9h 5h 2h 3d 4c'));
const flB = evaluate7(C('Kh Qh 9h 5h 2h 3d 4c'));
ok(compareScore(flA, flB) > 0, 'A하이 플러시 > K하이 플러시');

// 동점(타이)
const t1 = evaluate7(C('Ah Kd Qs Jc Th 2d 3c'));
const t2 = evaluate7(C('As Kh Qd Js Tc 4d 5c'));
ok(compareScore(t1, t2) === 0, '같은 브로드웨이 스트레이트 = 타이');

// 스트레이트 vs 플러시 우열
ok(compareScore(evaluate7(C('2h 5h 8h Jh Kh 3d 4c')), evaluate7(C('5h 6d 7s 8c 9h 2d Ac'))) > 0,
  '플러시 > 스트레이트');

console.log(`\n핸드 평가기 테스트: ${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
