// util.js — 상태에 의존하지 않는 순수 헬퍼 (client.js보다 먼저 로드되는 클래식 스크립트)
// 점진적 모듈 분리 1단계: 카드 상수·문자열 이스케이프·시간 포맷 등 부수효과 없는 함수만 추출.

// 서버는 무늬를 숫자 0~3으로 보냄: 0=♠,1=♥,2=♦,3=♣
const SUIT_SYM = ['♠', '♥', '♦', '♣'];
const isRedSuit = (s) => s === 1 || s === 2;
const RANK_LBL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 10: '10' };
const rankLabel = (r) => RANK_LBL[r] || String(r);

// HTML 이스케이프(XSS 방지)
function esc(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
// CSS 선택자 이스케이프
function cssEsc(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
}
// 초 → m:ss
function fmtTime(sec) {
  sec = Math.max(0, Math.ceil(sec));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}
