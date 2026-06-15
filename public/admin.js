// Dice 관리자 페이지 (독립 실행) — 게임 클라이언트와 별개로 admin:* 이벤트만 사용
const $ = (id) => document.getElementById(id);
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
let _toastT = null;
function toast(msg, type) {
  let el = $('adminToast');
  if (!el) { el = document.createElement('div'); el.id = 'adminToast'; el.className = 'admin-toast'; document.body.appendChild(el); }
  el.textContent = msg; el.className = 'admin-toast ' + (type || '') + ' show';
  clearTimeout(_toastT); _toastT = setTimeout(() => el.classList.remove('show'), 2200);
}
const socket = io();

let _adminData = null, _adminTab = 'status';
function fmtAgo(ts, nowTs) {
  if (!ts) return '기록 없음';
  const s = Math.max(0, Math.floor(((nowTs || Date.now()) - ts) / 1000));
  if (s < 60) return s + '초 전';
  if (s < 3600) return Math.floor(s / 60) + '분 전';
  if (s < 86400) return Math.floor(s / 3600) + '시간 전';
  return Math.floor(s / 86400) + '일 전';
}
function adminCall(event, payload) {
  return new Promise((res) => socket.emit(event, payload || {}, (r) => {
    if (r && r.ok && r.data) _adminData = r.data;
    if (!r || !r.ok) toast((r && r.error) || '실패했습니다', 'error');
    res(r || { ok: false });
  }));
}

// 로그인
$('adminLogin').onclick = async () => {
  const r = await adminCall('admin:auth', { user: $('adminUser').value.trim(), password: $('adminPw').value });
  if (r.ok) { $('adminPw').value = ''; $('adminAuthErr').textContent = ''; $('adminAuth').classList.add('hidden'); $('adminMain').classList.remove('hidden'); renderAdmin(); }
  else { $('adminAuthErr').textContent = r.error || '인증 실패'; }
};
$('adminPw').onkeydown = (e) => { if (e.key === 'Enter') $('adminLogin').click(); };
$('adminUser').onkeydown = (e) => { if (e.key === 'Enter') $('adminPw').focus(); };
$('adminRefresh').onclick = async () => { await adminCall('admin:overview'); renderAdmin(); };
$('adminLogoutBtn').onclick = () => location.reload();
document.querySelectorAll('.admin-tab').forEach((b) => b.onclick = () => {
  _adminTab = b.dataset.tab;
  document.querySelectorAll('.admin-tab').forEach((x) => x.classList.toggle('active', x === b));
  renderAdmin();
});
setTimeout(() => $('adminUser').focus(), 60);

function renderAdmin() {
  const box = $('adminBody'); if (!box) return;
  if (!_adminData) { box.innerHTML = '<div class="room-empty">불러오는 중...</div>'; return; }
  if (_adminTab === 'status') renderAdminStatus(box);
  else if (_adminTab === 'rooms') renderAdminRooms(box);
  else if (_adminTab === 'accounts') renderAdminAccounts(box);
  else renderAdminNotice(box);
}
const ADMIN_ST = { playing: ['게임 중', 'st-playing'], waiting: ['대기 중', 'st-waiting'], spectating: ['관전', 'st-spec'], away: ['자리 비움', 'st-away'], lobby: ['로비', 'st-lobby'] };
function renderAdminStatus(box) {
  const accts = (_adminData.accounts || []).filter((a) => a.online);
  const now = _adminData.serverTime || Date.now();
  box.innerHTML = `<div class="admin-summary">접속 중 <b>${accts.length}</b>명 · 열린 방 <b>${(_adminData.rooms || []).length}</b>개</div>`;
  if (!accts.length) { box.innerHTML += '<div class="room-empty">접속 중인 사용자가 없습니다</div>'; return; }
  accts.forEach((a) => {
    const meta = ADMIN_ST[a.status] || ADMIN_ST.lobby;
    const row = document.createElement('div'); row.className = 'admin-item admin-st-row';
    row.innerHTML = `<div class="ai-head"><b>${esc(a.nick)}</b> <span class="st-badge ${meta[1]}"><span class="st-dot"></span>${meta[0]}</span>${a.room ? `<span class="ai-sub"> · 방 ${esc(a.room)}</span>` : ''}</div><div class="ai-sub">최근 활동 ${fmtAgo(a.lastActive, now)} · 잔액 ${a.balance}</div>`;
    const log = document.createElement('button'); log.className = 'ghost ai-mini'; log.textContent = '로그';
    log.onclick = () => openUserDetail(a.nick);
    row.appendChild(log);
    box.appendChild(row);
  });
}
function renderAdminRooms(box) {
  const rooms = _adminData.rooms || [];
  if (!rooms.length) { box.innerHTML = '<div class="room-empty">열린 방이 없습니다</div>'; return; }
  box.innerHTML = '';
  rooms.forEach((rm) => {
    const humans = rm.players.filter((p) => !p.isBot);
    const card = document.createElement('div'); card.className = 'admin-item';
    card.innerHTML = `<div class="ai-head"><b>${esc(rm.code)}</b><span class="ai-sub"> ${rm.started ? '게임중' : '대기'} · 핸드 ${rm.hand} · ${humans.length}명${rm.spectators ? (' · 관전 ' + rm.spectators) : ''}</span></div>`;
    const plist = document.createElement('div'); plist.className = 'ai-plist';
    rm.players.forEach((p) => {
      const chip = document.createElement('span'); chip.className = 'ai-chip';
      chip.textContent = `${p.isBot ? '🤖 ' : ''}${p.name} (${p.chips})`;
      if (!p.isBot) { const k = document.createElement('button'); k.className = 'ai-x'; k.textContent = '강퇴'; k.onclick = async () => { await adminCall('admin:kick', { code: rm.code, pid: p.id }); renderAdmin(); }; chip.appendChild(k); }
      plist.appendChild(chip);
    });
    card.appendChild(plist);
    const close = document.createElement('button'); close.className = 'ai-danger'; close.textContent = '방 강제 종료';
    close.onclick = async () => { if (!confirm(rm.code + ' 방을 종료할까요?')) return; await adminCall('admin:closeRoom', { code: rm.code }); renderAdmin(); };
    card.appendChild(close);
    box.appendChild(card);
  });
}
function renderAdminAccounts(box) {
  const accts = _adminData.accounts || [];
  box.innerHTML = '';
  const search = document.createElement('input'); search.className = 'admin-search'; search.placeholder = `닉네임 검색 (총 ${accts.length}명)`;
  box.appendChild(search);
  const list = document.createElement('div'); box.appendChild(list);
  const draw = (f) => {
    list.innerHTML = '';
    accts.filter((a) => !f || a.nick.toLowerCase().includes(f)).slice(0, 200).forEach((a) => {
      const row = document.createElement('div'); row.className = 'admin-item';
      row.innerHTML = `<div class="ai-head"><b>${esc(a.nick)}</b>${a.online ? ' <span class="st-badge st-playing"><span class="st-dot"></span>온라인</span>' : ''}${a.banned ? ' <span class="ai-ban">차단됨</span>' : ''}<span class="ai-sub"> · ${a.games}전 ${a.wins}승</span></div>`;
      const bal = document.createElement('div'); bal.className = 'ai-bal';
      const inp = document.createElement('input'); inp.type = 'number'; inp.value = a.balance; inp.className = 'ai-bal-input';
      const setb = document.createElement('button'); setb.className = 'ghost'; setb.textContent = '💰 저장';
      setb.onclick = async () => { await adminCall('admin:setBalance', { nick: a.nick, balance: Number(inp.value) }); renderAdmin(); };
      bal.appendChild(inp); bal.appendChild(setb); row.appendChild(bal);
      const acts = document.createElement('div'); acts.className = 'ai-acts';
      const logb = document.createElement('button'); logb.className = 'ghost'; logb.textContent = '로그'; logb.onclick = () => openUserDetail(a.nick);
      const ren = document.createElement('button'); ren.className = 'ghost'; ren.textContent = '이름변경'; ren.onclick = async () => { const nn = prompt('새 닉네임 (2~16자)', a.nick); if (nn == null) return; await adminCall('admin:rename', { nick: a.nick, newNick: nn }); renderAdmin(); };
      const rpw = document.createElement('button'); rpw.className = 'ghost'; rpw.textContent = '비번초기화'; rpw.onclick = async () => { const pw = prompt(a.nick + ' 새 비밀번호 (4자 이상)'); if (!pw) return; const r = await adminCall('admin:resetPassword', { nick: a.nick, newPassword: pw }); if (r.ok) toast('비밀번호를 변경했습니다', 'ok'); renderAdmin(); };
      const fo = document.createElement('button'); fo.className = 'ghost'; fo.textContent = '로그아웃'; fo.onclick = async () => { await adminCall('admin:forceLogout', { nick: a.nick }); renderAdmin(); };
      const ban = document.createElement('button'); ban.className = 'ghost'; ban.textContent = a.banned ? '차단해제' : '차단'; ban.onclick = async () => { await adminCall(a.banned ? 'admin:unban' : 'admin:ban', { nick: a.nick }); renderAdmin(); };
      const del = document.createElement('button'); del.className = 'ai-danger sm'; del.textContent = '삭제'; del.onclick = async () => { if (!confirm(a.nick + ' 계정을 삭제할까요? 되돌릴 수 없습니다.')) return; await adminCall('admin:deleteAccount', { nick: a.nick }); renderAdmin(); };
      acts.appendChild(logb); acts.appendChild(ren); acts.appendChild(rpw); acts.appendChild(fo); acts.appendChild(ban); acts.appendChild(del); row.appendChild(acts);
      list.appendChild(row);
    });
  };
  draw(''); search.oninput = () => draw(search.value.trim().toLowerCase());
}
function renderAdminNotice(box) {
  box.innerHTML = '';
  const ta = document.createElement('textarea'); ta.className = 'admin-notice-input'; ta.placeholder = '전체 접속자에게 보낼 공지 내용...'; ta.maxLength = 300;
  const send = document.createElement('button'); send.className = 'primary'; send.textContent = '📢 전체 공지 보내기'; send.style.width = '100%';
  send.onclick = async () => { const t = ta.value.trim(); if (!t) return; const r = await adminCall('admin:broadcast', { text: t }); if (r.ok) { toast('공지를 보냈습니다', 'ok'); ta.value = ''; } };
  box.appendChild(ta); box.appendChild(send);
}
async function openUserDetail(nick) {
  const r = await new Promise((res) => socket.emit('admin:userDetail', { nick }, res));
  if (!r || !r.ok) { toast((r && r.error) || '불러오기 실패', 'error'); return; }
  renderAdminDetail(r.detail);
}
function fmtHist(h, nowTs) {
  if (typeof h === 'string') return h;
  const date = h.at ? new Date(h.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const place = (h.place != null) ? `${h.place}위` : '';
  const res = h.win ? '🏆 우승' : place;
  return [date, h.code ? ('방 ' + h.code) : '', (h.players != null ? h.players + '명' : ''), res].filter(Boolean).join(' · ');
}
function renderAdminDetail(d) {
  const box = $('adminBody'); if (!box) return;
  const now = d.serverTime || Date.now(); const st = d.stats || {};
  box.innerHTML = '';
  const back = document.createElement('button'); back.className = 'ghost admin-back'; back.textContent = '← 목록으로'; back.onclick = renderAdmin;
  box.appendChild(back);
  const head = document.createElement('div'); head.className = 'admin-item';
  head.innerHTML = `<div class="ai-head"><b>${esc(d.nick)}</b>${d.online ? ' <span class="st-badge st-playing"><span class="st-dot"></span>온라인</span>' : ''}${d.banned ? ' <span class="ai-ban">차단됨</span>' : ''}</div>
    <div class="ai-sub">잔액 ${d.balance} · 가입 ${d.createdAt ? fmtAgo(d.createdAt, now) : '-'} · 최근 활동 ${fmtAgo(d.lastActive, now)}</div>
    <div class="ai-sub">게임 ${st.games || 0} · 우승 ${st.wins || 0} · 핸드승 ${st.handsWon || 0} · 최고 팟 ${st.biggestPot || 0}</div>`;
  box.appendChild(head);
  const hist = d.history || [];
  const hbox = document.createElement('div'); hbox.className = 'admin-item';
  hbox.innerHTML = '<div class="ai-head" style="margin-bottom:6px">게임 기록 (최근 ' + hist.length + '건)</div>' +
    (hist.length ? hist.map((h) => `<div class="admin-log-row">${esc(fmtHist(h, now))}</div>`).join('') : '<div class="ai-sub">기록이 없습니다</div>');
  box.appendChild(hbox);
}
