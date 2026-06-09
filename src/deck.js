// 카드 표현: { r: 2..14, s: 0..3 }
// r: 11=J, 12=Q, 13=K, 14=A
// s: 0=♠(spades), 1=♥(hearts), 2=♦(diamonds), 3=♣(clubs)

export const SUITS = ['s', 'h', 'd', 'c'];
export const RANK_LABELS = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};

export function makeDeck() {
  const deck = [];
  for (let s = 0; s < 4; s++) {
    for (let r = 2; r <= 14; r++) {
      deck.push({ r, s });
    }
  }
  return deck;
}

// Fisher-Yates 셔플 (crypto 기반)
import { randomInt } from 'crypto';
export function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function cardCode(card) {
  return RANK_LABELS[card.r] + SUITS[card.s];
}
