const $ = s => document.querySelector(s);
const t = I18n.t;
const BUILTIN_LABEL = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' };
const BUILTIN_INITIAL = { claude: 'C', codex: 'X', cursor: 'U' };
// 名稱與縮寫跟著設定走（自訂 Agent 用自己取的名字）
const LABEL = new Proxy({}, { get: (_, a) => settings?.agents?.[a]?.name || BUILTIN_LABEL[a] || t('已刪除的 Agent') });
const INITIAL = new Proxy({}, { get: (_, a) => BUILTIN_INITIAL[a] || (settings?.agents?.[a]?.name || '?').trim().charAt(0).toUpperCase() });
const EFFORTS = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  cursor: ['low', 'medium', 'high', 'xhigh'],
};
// 強度選項：內建 Agent 用上表，自訂 Agent 用設定裡的「強度選項」（要有強度旗標）
const effortsOf = a => (settings?.agents[a]?.custom ? Presets.effortList(settings.agents[a]) : EFFORTS[a] || []);
const PERMS = {
  claude: [['default', '手動：改檔與指令都先問你'], ['acceptEdits', '接受編輯：自動改檔，指令先問你'], ['auto', '自動：由分類器判斷'], ['plan', '規劃：只規劃不動手'], ['bypassPermissions', '略過權限確認：全部放行']],
  codex: [['workspace-write', '可寫工作資料夾'], ['read-only', '唯讀'], ['danger-full-access', '完全存取（危險）']],
  cursor: [['force', '自動執行指令（--force）'], ['trust', '只信任資料夾，不自動跑指令'], ['ask', '唯讀問答（ask）'], ['plan', '只規劃（plan）']],
};

let settings, convList = [], current = null, agent = 'claude';
let pending = []; // 待送出的附件
const renderQueue = new Set();

marked.setOptions({ gfm: true, breaks: true });

// ---------- 工具 ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Agent 回覆與預覽的 Markdown 可能夾著原始 HTML：框架類的標籤一律改成純文字顯示。
// CSP 為了右側預覽開了 frame-src file:，不擋的話回覆裡的 <iframe src="file:..."> 會在主視窗裡載入沒有沙箱的本機頁面
const FRAME_TAG = /<\/?(?:iframe|frame|frameset|object|embed)\b[^>]*>/gi;
function md(text) { try { return marked.parse(text || '').replace(FRAME_TAG, m => esc(m)); } catch { return `<pre>${esc(text)}</pre>`; } }
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }
function dayLabel(ts) {
  const d = new Date(ts), now = new Date();
  const start = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (start(now) - start(d)) / 86400000;
  if (diff === 0) return t('今天'); if (diff === 1) return t('昨天'); if (diff < 7) return t('過去 7 天'); if (diff < 30) return t('過去 30 天');
  return `${d.getFullYear()}/${d.getMonth() + 1}`;
}
// 模型清單（id、顯示名稱）：Claude 啟動時就讀，Codex／Cursor 第一次用到才讀
const modelLists = {};
const modelName = (a, id) => modelLists[a]?.labels?.[id] || id;
// 這個對話實際用的設定：對話自己指定的模型／強度蓋過設定裡的預設
function effCfg(a, conv = current) {
  const c = { ...settings.agents[a] };
  const o = conv?.agentCfg?.[a] || {};
  if (typeof o.model === 'string') c.model = o.model;
  if (typeof o.effort === 'string') c.effort = o.effort;
  if (typeof o.permission === 'string') c.permission = o.permission;
  if (typeof o.sandbox === 'string') c.sandbox = o.sandbox;
  return c;
}
// 權限設定放哪個欄位：Codex 是 sandbox，Claude、Cursor 是 permission；自訂 Agent 沒有
const permKeyOf = a => (a === 'codex' ? 'sandbox' : 'permission');
// 權限的短名稱（卡片那一行用）：「手動：改檔與指令都先問你」→「手動」
function permShort(a, v) {
  const hit = PERMS[a]?.find(([k]) => k === v);
  return hit ? t(hit[1]).split(/[：:（(]/)[0].trim() : v;
}
function modelLine(a) {
  const c = effCfg(a);
  return [c.model ? modelName(a, c.model) : t('預設模型'), c.effort ? t('強度 {effort}', { effort: c.effort }) : null].filter(Boolean).join(' · ');
}
// 有安全疑慮的權限：卡片與選單用警告色、加 ⚠
const DANGER_PERMS = { claude: ['bypassPermissions'], codex: ['danger-full-access'] };
const isWorkConv = () => current?.mode === 'work';
// 這個對話實際用的權限（短名稱）；對話模式一律唯讀
function permLabel(a) {
  if (!PERMS[a]) return null;
  if (!isWorkConv()) return t('唯讀');
  return permShort(a, effCfg(a)[permKeyOf(a)] || PERMS[a][0][0]);
}
// 卡片上的權限按鈕：工作模式才有（只改這個對話）。對話模式不放，右欄上方寫一次「所有 Agent 唯讀」（#modeNote）；
// 留一個藏起來的按鈕佔位，refreshPermUi 換模式時才有東西可以換
function permBtnHtml(a) {
  if (!PERMS[a]) return '';
  if (!isWorkConv()) return '<button class="perm-btn hidden" disabled></button>';
  const v = effCfg(a)[permKeyOf(a)] || PERMS[a][0][0], danger = DANGER_PERMS[a]?.includes(v);
  return `<button class="perm-btn${danger ? ' danger' : ''}" data-perm="${a}" title="${esc(t('切換這個對話在工作模式的權限'))}"><span class="pi">${danger ? '⚠' : '🔒'}</span><span class="t">${esc(permLabel(a))}</span><span class="caret"></span></button>`;
}

// ---------- 側欄 ----------
// 分類方式（依日期／依專案＝工作資料夾）與專案收合狀態，各台電腦自己記
let sideView = 'date', collapsed = {}, showArchived = false;
try {
  sideView = localStorage.getItem('sideView') === 'project' ? 'project' : 'date';
  collapsed = JSON.parse(localStorage.getItem('collapsed') || '{}') || {};
} catch {}
function saveSide() { try { localStorage.setItem('sideView', sideView); localStorage.setItem('collapsed', JSON.stringify(collapsed)); } catch {} }
const projKey = p => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
const baseName = p => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p || '');

function convItem(c, sub) {
  const cls = ['conv', current?.id === c.id && 'on', c.archived && 'archived', sub && 'sub'].filter(Boolean).join(' ');
  const li = el(`<li class="${cls}" data-id="${c.id}" title="${esc(c.cwd)}">${c.running ? '<span class="dot"></span>' : ''}<span class="t">${esc(t(c.title))}</span></li>`);
  li.onclick = () => { if (!li.querySelector('.t[contenteditable="true"]')) openConv(c.id); };
  li.oncontextmenu = e => { e.preventDefault(); showConvMenu(c, e.clientX, e.clientY); };
  return li;
}

// 沒用過的新對話（主程序的 listConvs 標 blank：沒訊息、沒工作名、沒改名）：不是目前開著的、也沒有草稿，就不列出來
const isBlank = c => c.blank && !drafts[c.id];
function renderList() {
  const q = $('#search').value.trim().toLowerCase();
  const ul = $('#convList'); ul.innerHTML = '';
  for (const b of $('#viewToggle').children) b.classList.toggle('on', b.dataset.view === sideView);
  const match = c => (!isBlank(c) || c.id === current?.id) && (!q || c.title.toLowerCase().includes(q) || t(c.title).toLowerCase().includes(q));
  const live = convList.filter(c => !c.archived && match(c));
  const pinned = live.filter(c => c.pinned), rest = live.filter(c => !c.pinned);
  if (pinned.length) {
    ul.appendChild(el(`<li class="day">${esc(t('已釘選'))}</li>`));
    for (const c of pinned) ul.appendChild(convItem(c));
  }
  if (sideView === 'project') {
    const groups = new Map();
    for (const c of rest) {
      const k = projKey(c.cwd);
      if (!groups.has(k)) groups.set(k, { cwd: c.cwd, items: [] });
      groups.get(k).items.push(c);
    }
    for (const [k, g] of groups) {
      const off = !q && collapsed[k];
      const h = el(`<li class="proj${off ? ' off' : ''}" title="${esc(g.cwd)}"><span class="chev"></span><span class="t">${esc(baseName(g.cwd))}</span><button class="proj-new" title="${esc(t('在這個資料夾開新對話'))}">＋</button></li>`);
      h.onclick = e => {
        if (e.target.closest('.proj-new')) return newConvIn(g.cwd);
        if (collapsed[k]) delete collapsed[k]; else collapsed[k] = true;
        saveSide(); renderList();
      };
      ul.appendChild(h);
      if (!off) for (const c of g.items) ul.appendChild(convItem(c, true));
    }
  } else {
    let lastDay = null;
    for (const c of rest) {
      const day = dayLabel(c.updated);
      if (day !== lastDay) { ul.appendChild(el(`<li class="day">${day}</li>`)); lastDay = day; }
      ul.appendChild(convItem(c));
    }
  }
  const arch = convList.filter(c => c.archived && match(c));
  if (arch.length) {
    const h = el(`<li class="arch-toggle">${esc(showArchived ? t('隱藏已封存') : t('已封存（{n}）', { n: arch.length }))}</li>`);
    h.onclick = () => { showArchived = !showArchived; renderList(); };
    ul.appendChild(h);
    if (showArchived) for (const c of arch) ul.appendChild(convItem(c));
  }
}

// ---------- 對話的右鍵選單 ----------
let menuConv = null, menuMsg = null, menuSel = '';
function hideCtx() { $('#ctxMenu').classList.add('hidden'); menuConv = null; menuMsg = null; }
// 選單上按了哪一項：訊息的選單（showMsgMenu）走 msgAction，對話清單的走 convAction
const ctxPick = act => (menuMsg ? msgAction(act, menuMsg, menuSel) : convAction(act, menuConv));
// top：從頂列的「⋯」開的（目前這個對話），重新命名改在頂列的標題上
let menuTop = false;
function showConvMenu(c, x, y, top = false) {
  const items = c.archived
    ? [['unarchive', '取消封存', 'A'], ['rename', '重新命名', 'R'], ['delete', '刪除', 'D']]
    : [[c.pinned ? 'unpin' : 'pin', c.pinned ? '取消釘選' : '釘選', 'P'], ['rename', '重新命名', 'R'], ['archive', '封存', 'A'], ['delete', '刪除', 'D']];
  menuTop = top;
  const m = $('#ctxMenu');
  m.innerHTML = items.map(([act, label, key]) => `<button data-act="${act}" data-key="${key}"${act === 'delete' ? ' class="danger"' : ''}>${esc(t(label))}<kbd>${key}</kbd></button>`).join('');
  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 6)) + 'px';
  m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 6)) + 'px';
  menuConv = c;
}
async function convAction(act, c) {
  const top = menuTop;
  hideCtx();
  if (!c) return;
  if (act === 'pin' || act === 'unpin') await api.updateConv(c.id, { pinned: act === 'pin' });
  else if (act === 'archive' || act === 'unarchive') await api.updateConv(c.id, { archived: act === 'archive' });
  else if (act === 'rename') top && current?.id === c.id ? editTitle() : renameInList(c);
  else if (act === 'delete') await deleteConvById(c.id, c.title);
}
function renameInList(c) {
  const box = $(`#convList li[data-id="${c.id}"] .t`);
  if (!box) return;
  box.textContent = t(c.title);
  box.contentEditable = 'true'; box.focus();
  document.getSelection().selectAllChildren(box);
  let cancel = false;
  box.onkeydown = e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); box.blur(); }
    if (e.key === 'Escape') { cancel = true; box.blur(); }
  };
  box.onblur = async () => {
    box.contentEditable = 'false'; box.onblur = null;
    const title = box.textContent.trim();
    if (cancel || !title || title === t(c.title)) return renderList();
    if (current?.id === c.id) { current.title = title; $('#convTitle').textContent = title; }
    await api.updateConv(c.id, { title });
  };
}
$('#ctxMenu').onclick = e => { const b = e.target.closest('button'); if (b) ctxPick(b.dataset.act); };
document.addEventListener('mousedown', e => { if (!e.target.closest('#ctxMenu')) hideCtx(); }, true);
window.addEventListener('blur', hideCtx);
document.addEventListener('keydown', e => {
  if ($('#ctxMenu').classList.contains('hidden')) return;
  e.preventDefault(); e.stopPropagation();
  if (e.key === 'Escape') return hideCtx();
  const b = $(`#ctxMenu button[data-key="${e.key.toUpperCase()}"]`);
  if (b) ctxPick(b.dataset.act);
}, true);
$('#viewToggle').onclick = e => { const v = e.target.dataset.view; if (v && v !== sideView) { sideView = v; saveSide(); renderList(); } };

async function refreshList(list) { convList = list || await api.listConvs(); renderList(); }

// ---------- 對話 ----------
// ---------- 每個對話各自的草稿（輸入文字、待送附件、選的 Agent） ----------
let drafts = {};
try { drafts = JSON.parse(localStorage.getItem('drafts') || '{}') || {}; } catch {}
let draftTimer = null;
const draftId = () => current?.id || '_new';
function saveDraft() {
  const text = $('#input').value;
  if (text || pending.length || agent !== 'claude') drafts[draftId()] = { text, pending: pending.slice(), agent };
  else delete drafts[draftId()];
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => { try { localStorage.setItem('drafts', JSON.stringify(drafts)); } catch {} }, 300);
}
function loadDraft() {
  const d = drafts[draftId()] || {};
  $('#input').value = d.text || '';
  pending = Array.isArray(d.pending) ? d.pending.slice() : [];
  agent = settings?.agents[d.agent]?.enabled ? d.agent : 'claude';
  renderAttachBar();
  autoGrow();
}

async function openConv(id) {
  const next = await api.getConv(id);
  if (!next) return;
  if (current?.id !== next.id) saveDraft();
  current = next;
  loadDraft();
  renderConv();
  renderList();
  $('#input').focus();
}

// 已經有沒用過的新對話（目前這個優先）就沿用它、換到要的資料夾，不再多建一個
async function newConvIn(cwd) {
  cwd = cwd || settings.defaultCwd;
  const reuse = (current && !current.messages.length && convList.find(c => c.id === current.id && isBlank(c))) || convList.find(c => !c.archived && isBlank(c));
  if (reuse) {
    if (current?.id !== reuse.id) await openConv(reuse.id);
    if (current?.id === reuse.id) await setCwd(cwd);
    return;
  }
  const c = await api.createConv(cwd);
  await openConv(c.id);
}
const newConv = () => newConvIn(current?.cwd);
// 啟動時開最近的那一個（沒用過的新對話也算：上次就停在那裡）
const firstConv = () => convList.find(c => !c.archived) || convList[0];
// 刪掉對話後要開的那一個：先挑側欄看得到的（沒用過的新對話不列，見 isBlank）
const nextConv = () => convList.find(c => !c.archived && !isBlank(c)) || firstConv();

// 壓縮中（主程序在跑寫索引的那一輪，見 main.js 的 compress）：{ agent, from, to }，沒有就是 null
const compressState = () => (current && convList.find(c => c.id === current.id)?.compressing) || null;
// 回合在跑或正在壓縮：這段時間不能送訊息、換模式、重開 session，送出鈕變成停止
function isRunning() { return !!current && (!!compressState() || current.messages.some(m => m.role === 'assistant' && m.status === 'running')); }

function renderConv() {
  $('#convTitle').textContent = current ? t(current.title) : '';
  // 頂列只顯示資料夾名稱，點了在檔案總管開啟；換資料夾只在輸入框上方（還沒開始聊的對話）
  $('#cwdBtn').classList.toggle('hidden', !current);
  $('#cwdBtn .t').textContent = current ? baseName(current.cwd) : '';
  $('#cwdBtn').title = current ? t('工作資料夾：{cwd}\n點擊在檔案總管開啟', { cwd: current.cwd }) : '';
  $('#cwdPick').classList.toggle('hidden', !current || !!current.messages.length);
  $('#cwdPick .t').textContent = current ? baseName(current.cwd) : '';
  $('#cwdPickBtn').title = current ? current.cwd : '';
  // 還沒有訊息的對話：壓縮與「更多」用不到，先藏起來
  $('#compressBtn').classList.toggle('hidden', !current?.messages.length);
  $('#moreBtn').classList.toggle('hidden', !current?.messages.length);
  const box = $('#messages'); box.innerHTML = '';
  // 壓縮過的對話：在索引涵蓋到的那一則後面畫一條線，點了開啟索引檔
  const indexed = Math.min(current?.indexed || 0, current?.messages.length || 0);
  (current?.messages || []).forEach((m, i) => {
    box.appendChild(renderMsg(m));
    if (indexed && i === indexed - 1) box.appendChild(el(`<button class="idx-mark" title="${esc(t('這條線以上的內容已經寫進索引，Agent 之後只拿到索引與最近幾則原文；完整原文在逐字稿。\n點擊開啟索引檔'))}">${esc(t('以上 #1–#{n} 已壓縮成索引', { n: indexed }))}</button>`));
  });
  $('#empty').classList.toggle('hidden', !!current?.messages.length);
  updateComposer();
  if (settings) renderAgentPanel();
  refreshWork();
  refreshWorkList();
  box.scrollTop = box.scrollHeight;
  renderToBottom();
}

function renderMsg(m) {
  if (m.role === 'user') {
    const node = el(`<div class="msg user" data-id="${m.id}">${m.agent !== 'claude' ? `<div class="to-tag">→ ${LABEL[m.agent]}</div>` : ''}${m.attachments?.length ? `<div class="msg-atts">${m.attachments.map(attHtml).join('')}</div>` : ''}${m.text ? `<div class="bubble">${esc(m.text)}</div>` : ''}${msgFootHtml(m)}</div>`);
    node.querySelectorAll('.att[data-open]').forEach(x => x.onclick = () => openLocal(x.dataset.open));
    return node;
  }
  const node = el(`<div class="msg assistant" data-id="${m.id}"></div>`);
  fillAssistant(node, m);
  return node;
}

function fillAssistant(node, m) {
  const open = new Set([...node.querySelectorAll('details[open]')].map(d => d.dataset.key));
  let html = `<div class="who"><span class="badge ${m.agent}">${INITIAL[m.agent]}</span>${LABEL[m.agent]}${m.ctxChars ? `<span class="model ctx-note" title="${esc(t('這一輪附上的先前對話字數，會算進這個 Agent 的用量；可在設定調整附帶量'))}">${esc(t('附上先前對話 {n} 字', { n: m.ctxChars.toLocaleString() }))}</span>` : ''}${usageHtml(m.meta?.turn)}</div>`;
  html += renderParts(m.parts, m.id, m.status === 'running');
  if (m.status === 'running') html += `<div class="working"><span class="spinner"></span>${runningLabel(m)}</div>`;
  if (m.status === 'error' && m.error) html += `<div class="errbox">${esc(t(m.error))}</div>${reloginHtml(m.agent, m.error)}${pickModelHtml(m.agent, m.error)}`;
  if (m.status === 'stopped') html += `<div class="stopped">■ ${esc(t(m.error || '已停止'))}</div>`;
  // 對話模式下 Agent 想改檔：只在最後一則訊息上問，顯示與否由 renderMode 依目前模式決定
  if (m.needWork && current?.messages.at(-1)?.id === m.id) {
    html += `<div class="need-work hidden"><div class="nw-text">${esc(t('{name} 需要修改檔案，但對話模式是唯讀的。', { name: LABEL[m.agent] }))}</div>${m.needWork.denied?.length ? `<div class="nw-list">${m.needWork.denied.map(esc).join('<br>')}</div>` : ''}<button class="btn primary" data-act="toWork">${esc(t('切到工作模式並繼續'))}</button></div>`;
  }
  // 回覆最後給使用者選的回答：只在最後一則、沒有在執行時顯示成按鈕，按了直接送給同一個 Agent
  if (m.status === 'done' && m.choices?.length && current?.messages.at(-1)?.id === m.id) {
    html += `<div class="choices">${m.choices.map(c => `<button class="btn choice" data-choice="${esc(c)}" data-agent="${esc(m.agent)}">${esc(c)}</button>`).join('')}</div>`;
  }
  if (m.status !== 'running') html += msgFootHtml(m);
  node.innerHTML = html;
  const toWork = node.querySelector('.need-work [data-act="toWork"]');
  if (toWork) toWork.onclick = () => continueInWork(m.agent);
  for (const d of node.querySelectorAll('details')) if (open.has(d.dataset.key)) d.open = true;
  // 執行中的委派預設展開
  for (const d of node.querySelectorAll('details.delegate[data-running]')) if (!open.has(d.dataset.key) && !d.dataset.seen) d.open = true;
  enhanceCode(node);
  fixImages(node);
}

// ---------- 訊息下方的一列：時間、複製、從這裡分支（滑鼠移上去才顯示）；在訊息上按右鍵有同樣的功能 ----------
const ICON_COPY = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/></svg>';
const ICON_FORK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 2.5-7 1.5-7 4"/></svg>';
// 今天的只寫時間，其他日子加月日，不同年再加年份；完整的日期時間放在提示裡
function fmtMsgTime(ts) {
  const d = new Date(ts), now = new Date(), lang = settings?.uiLang || undefined;
  const time = { hour: 'numeric', minute: '2-digit' };
  const opt = d.toDateString() === now.toDateString() ? time
    : d.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric', ...time } : { year: 'numeric', month: 'short', day: 'numeric', ...time };
  try { return { text: new Intl.DateTimeFormat(lang, opt).format(d), full: d.toLocaleString(lang) }; }
  catch { return { text: d.toLocaleString(), full: d.toLocaleString() }; }
}
// 這一輪用了多少：總 tokens（輸入含快取＋輸出）與 CLI 回報的費用（API 牌價）；滑過看明細
function usageHtml(u) {
  if (!u?.total) return '';
  const tip = t('輸入 {input}（含快取）、輸出 {output} tokens', { input: u.input.toLocaleString(), output: u.output.toLocaleString() })
    + (u.cost ? '\n' + t('費用是 CLI 回報的 API 牌價，訂閱方案扣的是額度') : '');
  return `<span class="model use-note" title="${esc(tip)}">${esc(t('{n} tokens', { n: fmtTokens(u.total) }))}${u.cost ? ` · $${u.cost < 0.01 ? u.cost.toFixed(4) : u.cost.toFixed(2)}` : ''}</span>`;
}
// 這個對話加總（每則回覆和委派卡片上記的）；只算有回報的
function convUsage(c) {
  let total = 0, cost = 0, n = 0;
  const add = u => { if (u?.total) { total += u.total; cost += u.cost || 0; n++; } };
  for (const m of c?.messages || []) { add(m.meta?.turn); for (const p of m.parts || []) if (p.kind === 'delegate') add(p.usage); }
  return n ? { total, cost } : null;
}
function msgFootHtml(m) {
  const tm = m.ts ? fmtMsgTime(m.ts) : null;
  return `<div class="msg-foot">${tm ? `<span class="mt" title="${esc(tm.full)}">${esc(tm.text)}</span>` : ''}`
    + `<button data-mact="copy" title="${esc(t('複製'))}">${ICON_COPY}</button>`
    + (m.role === 'assistant' ? `<button data-mact="fork" title="${esc(t('從這裡分支：開一個新對話，帶著到這一則為止的內容；原本的對話不動'))}">${ICON_FORK}</button>` : '') + '</div>';
}
// 複製的是原文：使用者訊息的文字，或 Agent 回覆的文字段落（Markdown 原樣，不含動作與思考過程）
function msgCopyText(m) {
  if (m.role === 'user') return m.text || '';
  return (m.parts || []).filter(p => p.kind === 'text').map(p => Reduce.stripMark(p.text, false)).join('\n\n').trim();
}
async function msgAction(act, m, sel) {
  hideCtx();
  if (!m || !current) return;
  if (act === 'copy') return navigator.clipboard.writeText(msgCopyText(m));
  if (act === 'copySel') return navigator.clipboard.writeText(sel || '');
  if (act === 'fork') {
    const r = await api.forkConv(current.id, m.id);
    if (!r || r.error) return alertBox(t(r?.error || '找不到這則訊息'));
    await refreshList();
    await openConv(r.id);
  }
}
// sel：按右鍵時這則訊息裡選取的文字（沒有就是空字串）
function showMsgMenu(m, x, y, sel) {
  const items = [...(sel ? [['copySel', '複製選取的文字', 'S']] : []), ['copy', '複製訊息', 'C'],
    ...(m.role === 'assistant' && m.status !== 'running' ? [['fork', '從這裡分支', 'B']] : [])];
  const menu = $('#ctxMenu');
  menu.innerHTML = items.map(([act, label, key]) => `<button data-act="${act}" data-key="${key}">${esc(t(label))}<kbd>${key}</kbd></button>`).join('');
  menu.classList.remove('hidden');
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 6)) + 'px';
  menu.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 6)) + 'px';
  menuMsg = m; menuSel = sel || '';
}
$('#messages').addEventListener('click', e => {
  const b = e.target.closest('.msg-foot [data-mact]');
  const m = b && current?.messages.find(x => x.id === b.closest('.msg')?.dataset.id);
  if (!m) return;
  msgAction(b.dataset.mact, m);
  if (b.dataset.mact === 'copy') { b.classList.add('ok'); setTimeout(() => b.classList.remove('ok'), 1200); }
});
$('#messages').addEventListener('contextmenu', e => {
  const node = e.target.closest('.msg');
  const m = node && current?.messages.find(x => x.id === node.dataset.id);
  if (!m) return;
  e.preventDefault();
  const s = getSelection();
  showMsgMenu(m, e.clientX, e.clientY, s && !s.isCollapsed && node.contains(s.anchorNode) ? String(s) : '');
});

function runningLabel(m) {
  const d = [...m.parts].reverse().find(p => p.kind === 'delegate' && p.status === 'running');
  if (d) return t('{name} 執行中…', { name: LABEL[d.agent] });
  return t('{name} 處理中…', { name: LABEL[m.agent] });
}

// 連續的動作（工具呼叫，夾在中間的思考過程也算）有兩個以上時收成一行，點了才展開；那一行顯示最新的一個動作。
// 收合只是畫面上的事：動作照樣有做，花的 token 一樣
const STEP_ICON = { running: '●', error: '✕', done: '✓' };
const isStep = p => p.kind === 'tool' || p.kind === 'thinking';
function renderParts(parts, key, live) {
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    let j = i;
    while (j < parts.length && isStep(parts[j])) j++;
    const tools = parts.slice(i, j).filter(p => p.kind === 'tool');
    if (tools.length < 2) { html += partHtml(parts[i], `${key}-${i}`, live); continue; }
    // 收合那一行顯示最新的動作；有還在執行的（例如子代理）就顯示那一個，才看得到現在在做什麼
    const last = tools.findLast(p => p.status === 'running') || tools.at(-1), failed = tools.filter(p => p.status === 'error').length;
    const status = tools.some(p => p.status === 'running') ? 'running' : failed ? 'error' : 'done';
    html += `<details class="part tools" data-key="${key}-g${i}"><summary><span class="st ${status}">${STEP_ICON[status]}</span><span class="nm">${esc(t('{n} 個動作', { n: tools.length }))}${failed ? esc(t('（{n} 個失敗）', { n: failed })) : ''}</span><span class="dt">${esc(last.name)} ${esc(toolDt(last))}</span></summary>`
      + `<div class="tg">${parts.slice(i, j).map((p, n) => partHtml(p, `${key}-${i + n}`, live)).join('')}</div></details>`;
    i = j - 1;
  }
  return html;
}
// 工具那一行的說明；子代理（Task／Agent 工具）另外帶「第幾個動作、最新是什麼」，看得到它現在在做什麼
function toolDt(p) {
  if (!p.subSteps) return p.detail || '';
  const sub = t('子代理 {n} 個動作，最新：{last}', { n: p.subSteps, last: p.subLast || '' }) + (p.subErrors ? t('（{n} 個失敗）', { n: p.subErrors }) : '');
  return `${p.detail || ''} · ${sub}`;
}
function partHtml(p, k, live) {
  // 「需要工作模式」的標記不顯示（回合結束時也會從存檔拿掉）
  if (p.kind === 'text') return `<div class="part md">${md(Reduce.stripMark(p.text, live))}</div>`;
  if (p.kind === 'thinking') {
    if (!p.text?.trim()) return '';
    return `<details class="part think" data-key="${k}"><summary><span>💭</span><span>${t('思考過程')}</span></summary><div class="tx">${esc(p.text.trim())}</div></details>`;
  }
  if (p.kind === 'tool') {
    return `<details class="part tool" data-key="${k}"><summary><span class="st ${p.status}">${STEP_ICON[p.status] || STEP_ICON.done}</span><span class="nm">${esc(p.name)}</span><span class="dt">${esc(toolDt(p))}</span></summary>${p.output ? `<pre class="out">${esc(p.output)}</pre>` : ''}</details>`;
  }
  if (p.kind === 'notice') return `<div class="part notice">${esc(p.text)}</div>`;
  if (p.kind === 'approval') {
    if (p.status === 'pending') return `<div class="part approval"><div class="ap-q">${esc(t('要允許這個動作嗎？'))}</div><div class="ap-act"><b>${esc(p.tool)}</b> <code>${esc(p.detail)}</code></div>`
      + `<div class="ap-btns"><button class="btn primary" data-approve="${esc(p.id)}" data-allow="1">${esc(t('允許'))}</button><button class="btn" data-approve="${esc(p.id)}" data-allow="0">${esc(t('拒絕'))}</button></div></div>`;
    return `<div class="part approval done ${p.status}"><span class="st">${p.status === 'allowed' ? '✓' : '✕'}</span>${esc(t(p.status === 'allowed' ? '已允許' : '已拒絕'))} <b>${esc(p.tool)}</b> <span class="dt">${esc(p.detail)}</span></div>`;
  }
  if (p.kind === 'delegate') {
    const st = t({ running: '執行中…', done: '完成', error: '失敗', stopped: '已停止' }[p.status] || p.status);
    return `<details class="part delegate ${p.agent}" data-key="${k}" ${p.status === 'running' ? 'data-running' : ''}>
        <summary><span class="badge ${p.agent}">${INITIAL[p.agent]}</span><b>${esc(t('交給 {name}', { name: LABEL[p.agent] }))}</b><span class="dstate ${p.status}">${st}</span>${usageHtml(p.usage)}</summary>
        <div class="dbody"><div class="dprompt">${esc(p.prompt)}</div>${renderParts(p.parts, k, live)}${p.error && p.status !== 'stopped' ? `<div class="errbox">${esc(t(p.error))}</div>${reloginHtml(p.agent, p.error)}${pickModelHtml(p.agent, p.error)}` : ''}</div></details>`;
  }
  return '';
}

function enhanceCode(node) {
  for (const pre of node.querySelectorAll('.md pre')) {
    if (pre.querySelector('.copy')) continue;
    const b = el(`<button class="copy">${t('複製')}</button>`);
    b.onclick = () => { navigator.clipboard.writeText(pre.querySelector('code')?.innerText || pre.innerText); b.textContent = t('已複製'); setTimeout(() => b.textContent = t('複製'), 1200); };
    pre.appendChild(b);
  }
}

// 事件 → 更新資料 → 下一個畫格重畫該則訊息
api.on('chat:event', ({ convId, msgId, ev }) => {
  if (!current || current.id !== convId) return;
  const m = current.messages.find(x => x.id === msgId);
  if (!m) { api.getConv(convId).then(c => { if (current?.id === convId) { current = c; renderConv(); } }); return; }
  Reduce.applyEvent(m, ev);
  if (ev.type === 'status') refreshWork();   // 回合結束：Agent 可能改了進程檔
  if (!renderQueue.size) requestAnimationFrame(flush);
  renderQueue.add(msgId);
});

function flush() {
  const box = $('#messages');
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  for (const id of renderQueue) {
    const m = current?.messages.find(x => x.id === id);
    const node = box.querySelector(`.msg[data-id="${id}"]`);
    if (m && node) fillAssistant(node, m);
  }
  const changed = renderQueue.size > 0;
  renderQueue.clear();
  updateComposer();
  if (stick) box.scrollTop = box.scrollHeight;
  // 捲上去看舊訊息時有新內容：「回到最新」的按鈕亮起來
  else if (changed) $('#toBottom').classList.add('new');
  renderToBottom();
}

// ---------- 回到最新：捲上去離底部超過一段距離時，輸入框上方出現 ↓，按了捲回最下面 ----------
function renderToBottom() {
  const box = $('#messages'), away = box.scrollHeight - box.scrollTop - box.clientHeight > 240;
  $('#toBottom').classList.toggle('hidden', !away);
  if (!away) $('#toBottom').classList.remove('new');
}
$('#messages').addEventListener('scroll', renderToBottom, { passive: true });
$('#toBottom').onclick = () => { const box = $('#messages'); box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' }); $('#toBottom').classList.remove('new'); };

api.on('conv:changed', async list => {
  await refreshList(list);
  // 新開始的回合：重新取得這個對話（含新的訊息）
  if (current) {
    const fresh = await api.getConv(current.id);
    if (fresh && fresh.messages.length !== current.messages.length) { current = fresh; renderConv(); }
    else updateComposer();
  }
});
api.on('chat:error', ({ convId, error }) => { if (current?.id === convId) alertBox(t(error)); });

// ---------- 輸入 ----------
// 輸入框下方那一行：模型、強度、實際的權限（對話模式顯示唯讀），Claude 再加上可委派給誰
// 一行就好：模型 · 強度 · 權限；可委派給誰放在滑過的提示
function agentInfoText() {
  if (!settings) return '';
  const p = permLabel(agent), danger = isWorkConv() && DANGER_PERMS[agent]?.includes(effCfg(agent)[permKeyOf(agent)]);
  const b = agentStatus.billing, onApi = b?.mode === 'api' && b.agent === agent;
  return [onApi ? '💳 API' : null, modelLine(agent), p && (danger ? '⚠ ' : '🔒 ') + p].filter(Boolean).join(' · ');
}
function agentInfoTip() {
  if (!settings) return '';
  const helperNames = enabledAgents().filter(a => a !== 'claude' && settings.agents[a].delegate !== false).map(a => LABEL[a]);
  return agentInfoText() + (agent === 'claude' && settings.delegation && helperNames.length ? '\n' + t('可委派給 {names}', { names: helperNames.join(' / ') }) : '');
}
function renderAgentInfo() { $('#agentInfo').textContent = agentInfoText(); $('#agentInfo').title = agentInfoTip(); }
// 換了對話／工作模式：右欄卡片的權限按鈕、右欄上方的唯讀說明、輸入框下方那一行跟著變（renderMode 會呼叫）
function refreshPermUi() {
  for (const card of document.querySelectorAll('#agentCards .acard')) {
    const old = card.querySelector('.perm-btn');
    if (old) old.outerHTML = permBtnHtml(card.dataset.agent);
  }
  $('#modeNote').classList.toggle('hidden', !current || isWorkConv());
  renderAgentInfo();
}
function updateComposer() {
  const run = isRunning();
  const btn = $('#sendBtn');
  btn.classList.toggle('stop', !!run);
  btn.textContent = run ? '■' : '↑';
  btn.title = run ? t('停止') : t('送出');
  btn.disabled = !run && !$('#input').value.trim() && !pending.length;
  for (const b of $('#agentPicker').children) b.classList.toggle('on', b.dataset.agent === agent);
  renderAgentInfo();
  updateSuggestion();
  renderMode();
  renderCompress();
  renderCompressTip();
}

// ---------- 確認與提示視窗 ----------
// 畫在頁面裡，不用瀏覽器內建的 confirm／alert：在 Windows 上原生視窗關掉後，輸入框拿不回鍵盤焦點，
// 要把整個視窗縮到工作列再打開才能打字。cancel＝有沒有「取消」；回傳 Promise<boolean>。
// 一次只開一個，前一個還開著時後面的排隊。關掉後焦點回到原本的元素（設定頁開著時）或輸入框
let askChain = Promise.resolve();
function askBox(text, cancel) {
  const run = () => new Promise(resolve => {
    const m = $('#askModal'), yes = $('#askYes'), no = $('#askNo'), prev = document.activeElement;
    $('#askText').textContent = text;
    no.classList.toggle('hidden', !cancel);
    m.classList.remove('hidden');
    const done = v => {
      m.classList.add('hidden');
      m.onkeydown = m.onmousedown = yes.onclick = no.onclick = null;
      const back = !$('#settingsModal').classList.contains('hidden') && prev && document.contains(prev) ? prev : $('#input');
      back.focus();
      resolve(v);
    };
    yes.onclick = () => done(true);
    no.onclick = () => done(false);
    m.onmousedown = e => { if (e.target === m && cancel) done(false); };
    m.onkeydown = e => {
      e.stopPropagation();   // 設定頁等其他地方也聽 Esc：這個視窗開著時只關這個
      if (e.key === 'Escape') done(!cancel);
      else if (e.key === 'Tab') { e.preventDefault(); (cancel && document.activeElement === yes ? no : yes).focus(); }
    };
    yes.focus();
  });
  const p = askChain.then(run);
  askChain = p.catch(() => {});
  return p;
}
function confirmBox(text) { return askBox(text, true); }
function alertBox(text) { return askBox(text, false); }

// ---------- 頂列：壓縮 ----------
// 請目前選的 Agent 替還沒進索引的段落寫索引（主程序做，不進對話記錄），寫完各 Agent 的 session 會清掉，
// 之後每一輪只附索引與最近幾則原文；完整原文留在逐字稿
// 最近一次壓縮的結果那一行：{ id, at（當時的訊息數）, text }
let lastCompress = null;
function renderCompress() {
  const btn = $('#compressBtn'), st = compressState();
  const done = Math.min(current?.indexed || 0, current?.messages.length || 0), total = current?.messages.length || 0;
  btn.disabled = !current || isRunning() || total <= done;
  btn.classList.toggle('on', done > 0);
  btn.title = t('壓縮對話：請目前選的 Agent 替對話寫索引，之後清掉各 Agent 的 session，每一輪只附索引與最近幾則原文。對話很長、session 偏大時用。')
    + (done ? '\n' + t('已壓縮到 #{n}', { n: done }) : '');
  // 壓縮中顯示進度；剛壓完、對話還沒有新訊息時，同一行改顯示結果（寫了幾筆、AgentDesk 核對時改了什麼）
  const done2 = !st && lastCompress && lastCompress.id === current?.id && lastCompress.at === current?.messages.length ? lastCompress.text : '';
  $('#compressNote').classList.toggle('hidden', !st && !done2);
  $('#compressNote .spinner').classList.toggle('hidden', !st);
  if (st) $('#compressNote .t').textContent = t('壓縮中：{name} 正在替 #{from}–#{to} 寫索引…', { name: LABEL[st.agent] || st.agent, from: st.from, to: st.to })
    + (st.parts > 1 ? t('（第 {n}／{total} 批）', { n: st.part, total: st.parts }) : '');
  else if (done2) $('#compressNote .t').textContent = done2;
}
function compressSummary(r) {
  const out = [t('已壓縮 #{from}–#{to}，寫了 {n} 筆索引', { from: r.from, to: r.to, n: r.added })];
  if (r.noted) out.push(t('{n} 筆是對話時記的', { n: r.noted }));
  if (r.parts > 1) out.push(t('分 {n} 批寫', { n: r.parts }));
  if (r.dropped) out.push(t('拿掉 {n} 個逐字稿裡沒出現的檔案', { n: r.dropped }));
  if (r.gaps?.length) out.push(t('{list} 沒有索引，補了佔位', { list: r.gaps.map(([a, b]) => a === b ? `#${a}` : `#${a}–#${b}`).join(t('、')) }));
  if (r.overlaps) out.push(t('{n} 筆的範圍和前一筆重疊', { n: r.overlaps }));
  return out.join(t('；'));
}
// a：由誰寫索引。頂列的按鈕用輸入框下方選的 Agent，右欄卡片上的「壓縮」用那張卡片的 Agent
async function compressWith(a) {
  if (!current || isRunning()) return;
  const id = current.id, from = Math.min(current.indexed || 0, current.messages.length) + 1, to = current.messages.length;
  if (to < from) return;
  const info = await api.compressInfo(id, a).catch(() => null);
  // 對話時每輪都記了索引：不用請 Agent 寫、不花額度；記了一部分：只請它補沒記到的段落
  const ask = info?.parts === 0
    ? t('第 #{from} 到 #{to} 段在對話時都記了索引，直接整理，不用請 Agent 寫，也不花額度。\n整理完後各 Agent 的 session 會清掉，之後每一輪只附索引與最近幾則原文；完整原文留在逐字稿。', { from, to })
    : t('請 {name} 替第 #{from} 到 #{to} 段寫索引？\n寫完後各 Agent 的 session 會清掉，之後每一輪只附索引與最近幾則原文；完整原文留在逐字稿。\n寫索引會花 {name} 一輪的額度。', { name: LABEL[a], from, to })
      + (info?.noted ? '\n' + t('其中有些段落對話時已經記了索引，{name} 只要補沒記到的段落（{n} 批）。', { name: LABEL[a], n: info.parts }) : '')
      + (info && !info.resume && !info.noted ? '\n' + t('{name} 會開新的 session 來寫，AgentDesk 直接把要寫的段落交給它，不接續原本的 session（原本的 session 沒看過全部的段落，或接續比重新讀還貴）。', { name: LABEL[a] }) : '');
  if (!await confirmBox(ask)) return;
  const r = await api.compress(id, a).catch(err => ({ error: String(err.message || err) }));
  if (!r?.error) lastCompress = { id, at: to, text: compressSummary(r) };
  if (current?.id === id) { current = await api.getConv(id); renderConv(); }
  if (r?.error && r.error !== '已停止') alertBox(t(r.error));
}
$('#compressBtn').onclick = () => compressWith(agent);
$('#messages').addEventListener('click', async e => {
  if (!e.target.closest('.idx-mark') || !current) return;
  const info = await api.compressInfo(current.id);
  if (info?.index) openLocal(info.index);
});

// ---------- 輸入框左下：對話／工作模式（管的是目前開著的這個對話） ----------
// 對話＝唯讀，工作＝照右欄卡片的權限；每個對話各自記，執行中不能換（主程序也會擋）
// 一顆按鈕寫出目前的模式，點了開選單；選單裡每項有說明
function convMode(c) { return c?.mode === 'work' ? 'work' : 'chat'; }
const MODE_UI = { chat: ['💬', '對話'], work: ['🛠', '工作'] };
function closeModeMenu() { $('#modeMenu').classList.add('hidden'); $('#modeBtn').classList.remove('on'); }
function renderMode() {
  const box = $('#modeToggle');
  box.classList.toggle('hidden', !current);
  const run = !!isRunning(), m = convMode(current);
  for (const b of box.querySelectorAll('[data-mode]')) { b.classList.toggle('on', b.dataset.mode === m); b.disabled = run; }
  $('#modeBtn').disabled = run;
  $('#modeBtn .mi').textContent = MODE_UI[m][0];
  $('#modeBtn .t').textContent = t(MODE_UI[m][1]);
  $('#modeBtn').title = t(m === 'work' ? '工作模式：開發專案或需求，Agent 可以改檔（照設定的權限）' : '對話模式：問問題、討論、查資料，Agent 不會改檔') + '\n' + t('點擊切換');
  if (run) closeModeMenu();
  // 「切到工作模式並繼續」只在對話模式、沒有回合在跑時顯示
  for (const x of document.querySelectorAll('#messages .need-work')) x.classList.toggle('hidden', run || convMode(current) !== 'chat');
  // 工作模式且取了工作名：標題旁顯示工作名，點了開啟進程檔
  const chip = $('#workChip'), w = convMode(current) === 'work' ? current?.work : null;
  chip.classList.toggle('hidden', !w);
  if (w) { chip.textContent = w.name; chip.title = t('工作：{name}\n進程檔：{file}\n點擊開啟', { name: w.name, file: workFile() }); }
  refreshPermUi();
}
// 進程檔的完整路徑（conv.work.file 是相對工作資料夾的路徑，用 / 分隔）
function workFile(c = current) {
  const sep = c.cwd.includes('\\') ? '\\' : '/';
  return c.cwd.replace(/[\\/]+$/, '') + sep + c.work.file.split('/').join(sep);
}
$('#workChip').onclick = () => current?.work && openLocal(workFile());

// 切到工作模式時取工作名（進程檔的檔名）。then：存好之後要接著做的事（「切到工作模式並繼續」用）
let workPopThen = null;
// anchor：小視窗貼著哪顆按鈕開（預設頂列的切換鈕；按鈕在畫面下半部就往上開）
function openWorkPop(then, anchor) {
  workPopThen = then || null;
  const pop = $('#workPop'), r = (anchor || $('#modeToggle')).getBoundingClientRect();
  const up = r.top > window.innerHeight / 2;
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 346)) + 'px';
  pop.style.top = up ? 'auto' : r.bottom + 6 + 'px';
  pop.style.bottom = up ? window.innerHeight - r.top + 6 + 'px' : 'auto';
  $('#workName').value = current.title && current.title !== '新對話' ? current.title : '';
  $('#workStart').disabled = !$('#workName').value.trim();
  $('#workExisting').classList.add('hidden');
  pop.classList.remove('hidden');
  $('#workName').focus();
  $('#workName').select();
  // 這個資料夾裡現成的進程檔：可以直接選一個接著做
  const id = current.id;
  api.listWorks(id).then(items => {
    if (current?.id !== id || pop.classList.contains('hidden') || !items.length) return;
    $('#workItems').innerHTML = items.map(w => `<button data-work="${esc(w.name)}" title="${esc(w.status)}"><span class="nm">${esc(w.name)}</span>`
      + `<span class="st">${w.total ? `${w.done}/${w.total} · ` : ''}${esc(ago(w.mtime))}</span>${current.work?.name === w.name ? '<span class="ck">✓</span>' : ''}</button>`).join('');
    $('#workExisting').classList.remove('hidden');
  });
}
function closeWorkPop() { $('#workPop').classList.add('hidden'); workPopThen = null; }
// 切到工作模式。patch：{ work: 新的工作名 }＝建進程檔；{ workFile: 現成的進程檔 }＝接續；{}＝不建進程檔
async function applyWork(patch) {
  if (!current || isRunning()) return;
  const then = workPopThen;
  closeWorkPop();
  current = await api.updateConv(current.id, { mode: 'work', ...patch });
  renderMode();
  refreshWork();
  if (then) await then();
}
const startWork = () => { const name = $('#workName').value.trim(); if (name) applyWork({ work: name }); };
$('#workName').oninput = () => { $('#workStart').disabled = !$('#workName').value.trim(); };
$('#workName').onkeydown = e => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); startWork(); }
  if (e.key === 'Escape') { e.stopPropagation(); closeWorkPop(); }
};
$('#workStart').onclick = startWork;
$('#workSkip').onclick = () => applyWork({});
$('#workCancel').onclick = closeWorkPop;
$('#workItems').onclick = e => { const b = e.target.closest('button[data-work]'); if (b) applyWork({ workFile: b.dataset.work }); };
$('#workPickBtn').onclick = () => current && openWorkPop(null, $('#workPickBtn'));
document.addEventListener('click', e => { if (!e.target.closest('#workPop, #modeToggle, #workPickBtn, .need-work')) closeWorkPop(); });
document.addEventListener('click', e => { if (!e.target.closest('#modeToggle')) closeModeMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modeMenu').classList.contains('hidden')) closeModeMenu(); });

// ---------- 工作現況（右欄）與新對話的「接續工作」 ----------
// 進程檔由主程序讀（work:read）；開對話、回合結束、換工作時重讀，另外每 30 秒跟著右欄更新一次
let workInfo = null;   // { convId, name, path, exists, resume: [], tasks: [] }
async function refreshWork() {
  const id = current?.id;
  const data = id && current.work ? await api.readWork(id) : null;
  if (current?.id !== id) return;
  workInfo = data ? { ...data, convId: id } : null;
  renderWork();
}

// ---------- session 接近上限：輸入框上方建議壓縮 ----------
// 任何一個 Agent 的 session 用到模型上下文的 COMPRESS_AT（八成）就提示，寫出用了多少、為什麼要壓縮，按了等於頂列的 🗜（由那個 Agent 寫索引）。
// 按「先不要」之後，同一個 Agent 再多用一成才再提
const tipLater = new Map();   // `${對話 id}:${agent}` → 按「先不要」時用了幾成
function compressTipAgent() {
  if (!current?.messages.length || isRunning()) return null;
  let best = null;
  for (const a of Object.keys(current.sessions || {})) {
    const s = sessionOf(a), later = tipLater.get(`${current.id}:${a}`);
    if (!s?.big || !settings?.agents[a]?.enabled || (later !== undefined && s.pct < later + 10)) continue;
    if (!best || s.pct > best.s.pct) best = { a, s };
  }
  return best;
}
function renderCompressTip() {
  const hit = compressTipAgent();
  $('#compressTip').classList.toggle('hidden', !hit);
  if (!hit) return;
  const { a, s } = hit;
  $('#compressTip .t').textContent = t('{name} 的 session 已經用了上下文的 {pct}%（{n}／{win}）。再大下去，CLI 會自己摘要或塞不下，前面的細節容易丟掉。建議壓縮：之後每一輪只附索引與最近幾則原文，需要細節時 Agent 會回去讀原文。',
    { name: LABEL[a], pct: s.pct, n: fmtTokens(s.n), win: (s.guess ? '~' : '') + fmtTokens(s.win) });
  $('#compressTip [data-act="compress"]').dataset.agent = a;
}
$('#compressTip').onclick = e => {
  const b = e.target.closest('[data-act]');
  if (!b || !current) return;
  if (b.dataset.act === 'compress') return compressWith(b.dataset.agent);
  const hit = compressTipAgent();
  if (hit) tipLater.set(`${current.id}:${hit.a}`, hit.s.pct);
  renderCompressTip();
};
function renderWork() {
  const d = current?.work && workInfo?.convId === current.id && workInfo.name === current.work.name ? workInfo : null;
  $('#workSec').classList.toggle('hidden', !d);
  if (!d) return;
  const done = d.tasks.filter(x => x.done).length;
  let html = `<div class="wk-head"><button class="nm" title="${esc(d.path)}">${esc(d.name)}</button>${d.tasks.length ? `<span class="cnt">${esc(t('完成 {done}／{total}', { done, total: d.tasks.length }))}</span>` : ''}</div>`;
  if (!d.exists) html += `<div class="wk-note">${esc(t('進程檔還沒建立，送出第一則訊息後會建立。'))}</div>`;
  else {
    if (d.resume.length) html += `<ul class="wk-resume">${d.resume.slice(0, 4).map(x => `<li title="${esc(x)}">${esc(x)}</li>`).join('')}</ul>`;
    html += d.tasks.length
      ? `<ul class="wk-tasks">${d.tasks.map(x => `<li class="${x.done ? 'done' : ''}" title="${esc(x.title)}"><span class="n">${esc(x.id)}</span><span class="t">${esc(x.title)}</span><span class="s">${esc(x.status)}</span></li>`).join('')}</ul>`
      : `<div class="wk-note">${esc(t('還沒有任務清單'))}</div>`;
  }
  $('#workInfo').innerHTML = html;
}
$('#workInfo').onclick = e => { if (e.target.closest('.nm') && current?.work) openLocal(workFile()); };
// 還沒開始聊的對話：工作資料夾裡有進程檔，就在資料夾選單旁顯示「接續工作」
async function refreshWorkList() {
  const id = current?.id;
  const items = id && !current.messages.length ? await api.listWorks(id) : [];
  if (current?.id !== id) return;
  $('#workPickBtn').classList.toggle('hidden', !items.length);
  $('#workPickBtn .t').textContent = items.length ? t('接續工作（{n}）', { n: items.length }) : '';
}

// 使用者同意讓 Agent 改檔：切到工作模式，請同一個 Agent 接著做（同一個 session，主程序會補一句「可以修改檔案了」）
async function continueInWork(a) {
  if (!current || isRunning() || convMode(current) !== 'chat') return;
  const go = () => api.send(current.id, a, t('已切換到工作模式，請繼續剛才要做的修改。'), []);
  if (!current.work) return openWorkPop(go);
  current = await api.updateConv(current.id, { mode: 'work' });
  renderMode();
  await go();
}
$('#modeToggle').onclick = async e => {
  if (e.target.closest('#modeBtn')) {
    e.stopPropagation();
    if ($('#modeMenu').classList.contains('hidden') && current && !isRunning()) { $('#modeMenu').classList.remove('hidden'); $('#modeBtn').classList.add('on'); }
    else closeModeMenu();
    return;
  }
  const m = e.target.closest('button')?.dataset.mode;
  if (!m) return;
  closeModeMenu();
  if (!current || isRunning()) return;
  // 點的是目前的模式：不做事（已經在工作模式時再點一次，不要跳出取工作名的視窗）
  if (m === convMode(current)) return;
  // 切到工作模式、還沒取工作名：先問
  if (m === 'work' && !current.work) return openWorkPop();
  current = await api.updateConv(current.id, { mode: m });
  renderMode();
};

// 按選項：換到回覆的那個 Agent，把選項當成使用者的話送出
$('#messages').addEventListener('click', e => {
  const b = e.target.closest('[data-choice]');
  if (!b || isRunning() || !current) return;
  e.stopPropagation();
  if (settings.agents[b.dataset.agent]?.enabled) agent = b.dataset.agent;
  // 只送選項本身：輸入框裡打到一半的字和待送的附件都留著
  submit(b.dataset.choice);
});
// 輸入框的建議回覆：最後一則回覆有選項時，第一個就是建議；輸入框空著時顯示在提示字，按 Tab 填進去
let suggestion = '', inputHint = null;
function updateSuggestion() {
  const input = $('#input');
  if (inputHint === null) inputHint = input.placeholder;
  const last = current?.messages.at(-1);
  suggestion = !isRunning() && last?.role === 'assistant' && last.status === 'done' && last.choices?.[0] || '';
  input.placeholder = suggestion ? t('{text}　（Tab 套用）', { text: suggestion }) : inputHint;
  input.classList.toggle('suggest', !!suggestion);
}
$('#input').addEventListener('keydown', e => {
  if (e.key !== 'Tab' || e.shiftKey || !suggestion || $('#input').value) return;
  e.preventDefault();
  $('#input').value = suggestion;
  autoGrow();
});
// direct：直接送這段字（按回覆下面的選項），不動輸入框與待送的附件
async function submit(direct) {
  if (isRunning()) return api.stop(current.id);
  if (typeof direct !== 'string') direct = null;
  const text = direct ?? $('#input').value.trim();
  if (!text && (direct !== null || !pending.length)) return;
  if (!current) { const c = await api.createConv(settings.defaultCwd); current = c; }
  // 同一個資料夾已經有別的對話在工作模式執行：兩邊同時改檔可能互相蓋掉，先問（對話模式與壓縮只讀，不算）
  if (current.mode === 'work') {
    const key = p => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
    const other = (await api.listConvs()).find(c => c.id !== current.id && c.running && !c.compressing && c.mode === 'work' && key(c.cwd) === key(current.cwd));
    if (other && !await confirmBox(t('「{title}」也在這個資料夾用工作模式執行中，兩邊同時改檔可能互相蓋掉。仍要送出嗎？', { title: t(other.title) }))) return;
  }
  if (direct !== null) return api.send(current.id, agent, text, []);
  const atts = pending; pending = [];
  $('#input').value = '';
  delete drafts._new;
  renderAttachBar(); autoGrow();
  await api.send(current.id, agent, text, atts);
}

function autoGrow() { const t = $('#input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 280) + 'px'; updateComposer(); }

$('#input').addEventListener('input', () => { autoGrow(); saveDraft(); });
$('#input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!isRunning()) submit(); }
});
$('#sendBtn').onclick = submit;
$('#agentPicker').onclick = e => { const a = e.target.dataset.agent; if (a) { agent = a; updateComposer(); saveDraft(); $('#input').focus(); } };
$('#newConv').onclick = newConv;
$('#search').oninput = renderList;
document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newConv(); }
  if (e.ctrlKey && e.key.toLowerCase() === 'u') { e.preventDefault(); pickFiles(); }
  if (e.altKey && /^[1-9]$/.test(e.key) && enabledAgents()[+e.key - 1]) { agent = enabledAgents()[+e.key - 1]; updateComposer(); saveDraft(); }
});

// ---------- 附件 ----------
const fileUrl = p => 'file:///' + encodeURI(p.split('\\').join('/')).replace(/#/g, '%23').replace(/\?/g, '%3F');
function fmtSize(n) { if (!n && n !== 0) return ''; return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
function attHtml(a) {
  if (a.kind === 'image') return `<img src="${fileUrl(a.path)}" title="${esc(a.name)}" data-path="${esc(a.path)}">`;
  return `<div class="att" data-open="${esc(a.path)}" title="${esc(a.path)}"><span class="fi">${a.kind === 'folder' ? '📁' : '📄'}</span><span class="an">${esc(a.name)}</span></div>`;
}
function renderAttachBar() {
  const bar = $('#attachBar');
  bar.classList.toggle('hidden', !pending.length);
  bar.innerHTML = pending.map((a, i) => `<div class="att" title="${esc(a.path)}">${a.kind === 'image' ? `<img src="${fileUrl(a.path)}">` : `<span class="fi">${a.kind === 'folder' ? '📁' : '📄'}</span>`}<div style="min-width:0"><div class="an">${esc(a.name)}</div><div class="as">${a.kind === 'folder' ? t('資料夾') : fmtSize(a.size)}</div></div><button class="rm" data-i="${i}" title="${t('移除附件')}">✕</button></div>`).join('');
  bar.querySelectorAll('.rm').forEach(b => b.onclick = () => { pending.splice(+b.dataset.i, 1); renderAttachBar(); });
  saveDraft();
  updateComposer();
}
async function addFiles(fileList) {
  const items = [];
  for (const f of fileList) {
    const p = api.pathOf(f);
    if (p) items.push({ path: p });
    else {
      const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      const name = f.name && f.name !== 'image.png' ? f.name : `${t('貼上')}-${new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().replace(/\D/g, '').slice(0, 14)}.${ext}`;
      items.push({ name, data: await f.arrayBuffer() });
    }
  }
  if (!items.length) return;
  pending.push(...await api.addAttachments(items));
  renderAttachBar();
  $('#input').focus();
}
async function pickFiles() { closeMenu(); const r = await api.pickFiles(); if (r.length) { pending.push(...r); renderAttachBar(); } $('#input').focus(); }
async function pickAttachFolder() {
  closeMenu();
  const p = await api.pickFolder(current?.cwd || settings.defaultCwd);
  if (p) { pending.push(...await api.addAttachments([{ path: p }])); renderAttachBar(); }
  $('#input').focus();
}
function closeMenu() { $('#plusMenu').classList.add('hidden'); $('#plusBtn').classList.remove('on'); }
$('#plusBtn').onclick = e => { e.stopPropagation(); const m = $('#plusMenu'); m.classList.toggle('hidden'); $('#plusBtn').classList.toggle('on', !m.classList.contains('hidden')); };
$('#plusMenu').onclick = e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.act === 'files') pickFiles(); else pickAttachFolder(); };
document.addEventListener('click', e => { if (!e.target.closest('.plus-wrap')) closeMenu(); });
document.addEventListener('paste', e => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  addFiles(files);
});
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('#dropOverlay').classList.remove('hidden'); });
document.addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').classList.add('hidden'); } });
document.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; $('#dropOverlay').classList.add('hidden');
  if ($('#settingsModal').classList.contains('hidden')) addFiles([...(e.dataTransfer?.files || [])]);
});

// ---------- 登入過期 ----------
const AUTH_ERR = /log ?in|sign ?in|auth|oauth|token|expired|credential|unauthori[sz]ed|\b401\b|api key|未登入|登入/i;
function reloginHtml(agentId, error) {
  if (!error || !AUTH_ERR.test(error) || !settings?.agents[agentId]) return '';
  return `<button class="btn relogin" data-relogin="${agentId}">${esc(t('重新登入 {name}', { name: LABEL[agentId] }))}</button>`;
}
// 自訂 Agent 執行失敗、模型不在重讀的清單裡（agents.js 的 explainModel）：錯誤下面放「選擇模型」，打開右欄的模型選單
const MODEL_ERR_KEY = '模型 {model} 不在 {name} 目前的模型清單裡。請在右欄或設定裡重新選擇，AgentDesk 不會自動換模型。';
const MODEL_ERR = new RegExp([MODEL_ERR_KEY, I18n.EN[MODEL_ERR_KEY], I18n.CN[MODEL_ERR_KEY]].filter(Boolean)
  .map(s => s.replace(/\{(name|model)\}/g, '\0').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').split('\0').join('.+')).join('|'));
function pickModelHtml(agentId, error) {
  if (!error || !MODEL_ERR.test(error) || !canSwitchModel(settings?.agents[agentId])) return '';
  return `<button class="btn relogin" data-pickmodel="${agentId}">${esc(t('選擇 {name} 的模型', { name: LABEL[agentId] }))}</button>`;
}
$('#messages').addEventListener('click', e => {
  const b = e.target.closest('[data-approve]');
  if (!b) return;
  e.stopPropagation();
  b.parentElement.querySelectorAll('button').forEach(x => { x.disabled = true; });
  api.answerApproval(b.dataset.approve, b.dataset.allow === '1');
});
$('#messages').addEventListener('click', e => {
  const b = e.target.closest('[data-pickmodel]');
  if (!b) return;
  e.stopPropagation();
  const a = b.dataset.pickmodel;
  setPanel(true);
  const btn = document.querySelector(`.model-btn[data-model="${a}"]`);
  if (btn) showModelMenu(a, btn);
});
$('#messages').addEventListener('click', async e => {
  const b = e.target.closest('[data-relogin]');
  if (!b) return;
  const a = b.dataset.relogin;
  try { await api.cliLogin(a, settings.agents[a]); b.textContent = t('已開啟登入視窗，完成後回來重新送出。'); b.disabled = true; }
  catch (err) { alertBox(t(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))); }
});

// ---------- 右側預覽：Markdown 照訊息的樣式畫，HTML 用沙箱 iframe 開（不能碰 AgentDesk 本身） ----------
const PREVIEW_EXT = /\.(md|markdown|html?)$/i;
const preview = { path: '', mtime: null, timer: null };
async function openPreview(p) {
  preview.path = p;
  $('#previewPane').classList.remove('hidden');
  document.body.classList.add('previewing');
  $('#previewPane .pv-name').textContent = p.split(/[\\/]/).pop();
  $('#previewPane .pv-name').title = p;
  await renderPreview();
  clearInterval(preview.timer);
  // 檔案改了（例如 Agent 正在寫說明文件）就重畫
  preview.timer = setInterval(async () => {
    if (!preview.path) return;
    const m = await api.fileMtime(preview.path);
    if (m && m !== preview.mtime) renderPreview();
  }, 1500);
  fitTopbar();
}
async function renderPreview() {
  const p = preview.path, body = $('#previewPane .pv-body');
  const keep = body.scrollTop;
  if (/\.html?$/i.test(p)) {
    preview.mtime = await api.fileMtime(p);
    body.innerHTML = `<iframe sandbox="allow-scripts" src="${esc(fileUrl(p))}"></iframe>`;
    return;
  }
  const r = await api.readFile(p);
  if (r.error) { preview.mtime = null; body.innerHTML = `<div class="pv-msg">${esc(t('讀不到檔案：{path}', { path: p }))}</div>`; return; }
  preview.mtime = r.mtime;
  body.innerHTML = `<div class="md">${md(r.text)}</div>${r.cut ? `<div class="pv-msg">${esc(t('檔案太大，只顯示開頭的部分。'))}</div>` : ''}`;
  // 圖片與連結的相對路徑以這個檔案所在的資料夾為準
  fixImages(body, p.replace(/[\\/][^\\/]*$/, ''));
  body.scrollTop = keep;
}
function closePreview() {
  clearInterval(preview.timer);
  preview.path = ''; preview.mtime = null;
  $('#previewPane').classList.add('hidden');
  $('#previewPane .pv-body').innerHTML = '';
  document.body.classList.remove('previewing');
  fitTopbar();
}
// 本機檔案：Markdown、HTML 在右側預覽，圖片放大，其他用系統程式開
function openLocal(p) {
  if (PREVIEW_EXT.test(p)) openPreview(p);
  else if (IMG_EXT.test(p)) openLightboxPath(p);
  else api.openPath(p);
}
// 拖左緣調整預覽寬度，記住下次用（存的是像素寬；主欄的最小寬度由 style.css 擋）
try { const w = +localStorage.getItem('previewWidth'); if (w >= 300) $('#previewPane').style.flexBasis = w + 'px'; } catch {}
$('#previewPane .pv-grip').onmousedown = e => {
  e.preventDefault();
  const grip = e.target, startX = e.clientX, startW = $('#previewPane').getBoundingClientRect().width;
  grip.classList.add('on'); document.body.classList.add('pv-dragging');
  const move = ev => { $('#previewPane').style.flexBasis = Math.max(300, startW + (startX - ev.clientX)) + 'px'; fitTopbar(); };
  const up = () => {
    grip.classList.remove('on'); document.body.classList.remove('pv-dragging');
    removeEventListener('mousemove', move); removeEventListener('mouseup', up);
    try { localStorage.setItem('previewWidth', String(Math.round($('#previewPane').getBoundingClientRect().width))); } catch {}
  };
  addEventListener('mousemove', move); addEventListener('mouseup', up);
};
$('#previewPane .pv-head').onclick = e => {
  const act = e.target.closest('[data-pv]')?.dataset.pv;
  if (act === 'close') closePreview();
  else if (act === 'reload') renderPreview();
  else if (act === 'open' && preview.path) api.openPath(preview.path);
};
// 預覽裡的連結：頁內錨點捲過去，本機檔案照 openLocal，網址開瀏覽器
$('#previewPane .pv-body').addEventListener('click', e => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute('href') || '';
  if (href.startsWith('#')) { const el = document.getElementById(decodeURIComponent(href.slice(1))); if (el) el.scrollIntoView(); return; }
  if (/^https?:/i.test(href)) return api.openUrl(href);
  const p = a.dataset.path;
  if (p) openLocal(p);
});

// ---------- 圖片：本機路徑轉 file://，點擊放大 ----------
// Agent 寫的本機路徑（絕對、file://、相對於工作資料夾）→ Windows 絕對路徑；網址回 null
function localPath(raw, base = current?.cwd) {
  raw = (raw || '').trim();
  if (!raw || raw.startsWith('#') || /^(https?|data|mailto|blob|about):/i.test(raw)) return null;
  let p = raw.replace(/^<|>$/g, '');
  try { p = decodeURI(p); } catch {}
  if (/^file:/i.test(p)) p = p.replace(/^file:\/+/i, '');
  p = p.replace(/[?#].*$/, '').replace(/:(\d+)(:\d+)?$/, '');   // 去掉 ?query、#anchor、:行號
  const abs = /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
  if (!abs) {
    if (!base) return null;
    p = base.replace(/[\\/]+$/, '') + '\\' + p.replace(/^\.?[\\/]/, '');
  }
  return p.split('/').join('\\');
}
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i;

function fixImages(node, base) {
  for (const img of node.querySelectorAll('.md img')) {
    const p = localPath(img.getAttribute('src'), base);
    if (!p) continue;
    img.dataset.path = p;
    img.src = fileUrl(p);
  }
  for (const a of node.querySelectorAll('.md a[href]')) {
    const p = localPath(a.getAttribute('href'), base);
    if (p) { a.dataset.path = p; a.title = p; }
  }
}

// 連結一律攔下來：圖片開預覽、其他本機檔案用系統程式開、網址開瀏覽器，主視窗絕不跳頁
$('#messages').addEventListener('click', e => {
  const a = e.target.closest('a[href]');
  if (!a || e.target.closest('img')) return;
  e.preventDefault();
  const p = a.dataset.path || localPath(a.getAttribute('href'));
  if (!p) { const href = a.getAttribute('href') || ''; if (/^https?:/i.test(href)) api.openUrl(href); return; }
  openLocal(p);
});
function openLightboxPath(p) {
  lb.list = [{ src: fileUrl(p), dataset: { path: p } }];
  lb.i = 0;
  $('#lightbox').classList.remove('hidden');
  showLb();
}

const lb = { list: [], i: 0, scale: 1, x: 0, y: 0, fit: 1 };
const lbStage = () => document.querySelector('.lb-stage');
function openLightbox(img) {
  lb.list = [...document.querySelectorAll('#messages .md img, #messages .msg-atts img')];
  lb.i = Math.max(0, lb.list.indexOf(img));
  $('#lightbox').classList.remove('hidden');
  showLb();
}
function closeLightbox() { $('#lightbox').classList.add('hidden'); $('#lbImg').removeAttribute('src'); }
function stepLb(d) { if (lb.list.length > 1) { lb.i = (lb.i + d + lb.list.length) % lb.list.length; showLb(); } }
function showLb() {
  const src = lb.list[lb.i];
  if (!src) return closeLightbox();
  const im = $('#lbImg');
  im.onload = lbFit;
  im.src = src.currentSrc || src.src;
  const path = src.dataset.path || '';
  $('#lbName').textContent = `${lb.list.length > 1 ? `${lb.i + 1} / ${lb.list.length}　` : ''}${path || src.src}`;
  for (const b of document.querySelectorAll('[data-lb="open"], [data-lb="reveal"]')) b.classList.toggle('hidden', !path);
  for (const b of document.querySelectorAll('.lb-nav')) b.classList.toggle('hidden', lb.list.length < 2);
}
function lbApply() {
  const im = $('#lbImg');
  im.style.transform = `translate(${lb.x}px, ${lb.y}px) scale(${lb.scale})`;
  im.classList.toggle('pixel', lb.scale >= 2);
  $('#lbZoom').textContent = Math.round(lb.scale * 100) + '%';
}
function lbFit() {
  const im = $('#lbImg'), st = lbStage();
  const w = im.naturalWidth || 1, h = im.naturalHeight || 1;
  lb.fit = Math.min((st.clientWidth - 120) / w, (st.clientHeight - 40) / h);
  // 大圖縮進視窗；小圖（例如像素圖）用整數倍放大，最多 8 倍
  lb.scale = lb.fit < 1 ? lb.fit : Math.max(1, Math.min(8, Math.floor(lb.fit * 0.7)));
  lb.x = lb.y = 0; lbApply();
}
function lbZoomAt(factor, cx, cy) {
  const r = lbStage().getBoundingClientRect();
  const ox = cx - (r.left + r.width / 2), oy = cy - (r.top + r.height / 2);
  const next = Math.min(32, Math.max(0.05, lb.scale * factor));
  const k = next / lb.scale;
  lb.x = ox - (ox - lb.x) * k; lb.y = oy - (oy - lb.y) * k; lb.scale = next; lbApply();
}
$('#messages').addEventListener('click', e => {
  const img = e.target.closest('.md img, .msg-atts img');
  if (img) { e.preventDefault(); openLightbox(img); }
});
let lbMoved = false, lbDrag = null;
$('#lightbox').addEventListener('click', e => {
  if (lbMoved) { lbMoved = false; return; }
  if (e.target.closest('.lb-close') || e.target === lbStage()) return closeLightbox();
  if (e.target.closest('.lb-prev')) return stepLb(-1);
  if (e.target.closest('.lb-next')) return stepLb(1);
  const act = e.target.closest('[data-lb]')?.dataset.lb;
  const path = lb.list[lb.i]?.dataset.path;
  if (act === 'fit') lbFit();
  else if (act === 'orig') { lb.scale = 1; lb.x = lb.y = 0; lbApply(); }
  else if (act === 'open' && path) api.openPath(path);
  else if (act === 'reveal' && path) api.reveal(path);
});
lbStage().addEventListener('wheel', e => { e.preventDefault(); lbZoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY); }, { passive: false });
lbStage().addEventListener('dblclick', e => {
  if (Math.abs(lb.scale - 1) < 0.01) lbFit(); else lbZoomAt(1 / lb.scale, e.clientX, e.clientY);
});
lbStage().addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  lbDrag = { x: e.clientX - lb.x, y: e.clientY - lb.y, sx: e.clientX, sy: e.clientY };
  lbStage().classList.add('dragging');
});
window.addEventListener('mousemove', e => {
  if (!lbDrag) return;
  if (Math.abs(e.clientX - lbDrag.sx) + Math.abs(e.clientY - lbDrag.sy) > 3) lbMoved = true;
  lb.x = e.clientX - lbDrag.x; lb.y = e.clientY - lbDrag.y; lbApply();
});
window.addEventListener('mouseup', () => { lbDrag = null; lbStage().classList.remove('dragging'); });
document.addEventListener('keydown', e => {
  if ($('#lightbox').classList.contains('hidden')) return;
  if (e.key === 'Escape') { e.stopPropagation(); closeLightbox(); }
  else if (e.key === 'ArrowLeft') stepLb(-1);
  else if (e.key === 'ArrowRight') stepLb(1);
  else if (e.key === '+' || e.key === '=') lbZoomAt(1.25, innerWidth / 2, innerHeight / 2);
  else if (e.key === '-') lbZoomAt(1 / 1.25, innerWidth / 2, innerHeight / 2);
  else if (e.key === '0') lbFit();
}, true);
window.addEventListener('resize', () => { if (!$('#lightbox').classList.contains('hidden')) lbFit(); });

// ---------- 右欄：Agent 工作狀況 ----------
let agentStatus = { running: [], finished: [] };
function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? t('{s} 秒', { s }) : s < 3600 ? t('{m} 分 {s} 秒', { m: Math.floor(s / 60), s: s % 60 }) : t('{h} 時 {m} 分', { h: Math.floor(s / 3600), m: Math.floor(s % 3600 / 60) });
}
function ago(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  return s < 60 ? t('剛剛') : s < 3600 ? t('{m} 分鐘前', { m: Math.floor(s / 60) }) : s < 86400 ? t('{h} 小時前', { h: Math.floor(s / 3600) }) : new Date(ts).toLocaleDateString();
}
// 剩餘額度：Claude 每次回覆後更新、Codex 由 app-server 讀，Cursor CLI 沒有提供
const WIN_LABEL = { five_hour: '5 小時', seven_day: '每週', seven_day_overage_included: 'Fable 每週' };
// 只在這個對話的這個 Agent 用 Fable 時才顯示的額度（實測只有 Fable 的回合會回報，見 agents.js 的 claudeWindows）
const FABLE_WINS = ['seven_day_overage_included'];
const usesFable = a => /fable/i.test(`${effCfg(a).model || ''} ${modelName(a, effCfg(a).model || '')}`);
function untilText(sec) {
  const m = Math.max(0, Math.round((sec * 1000 - Date.now()) / 60000));
  return m < 60 ? t('{m} 分鐘後', { m }) : m < 1440 ? t('{h} 小時 {m} 分後', { h: Math.floor(m / 60), m: m % 60 }) : t('{d} 天 {h} 小時後', { d: Math.floor(m / 1440), h: Math.floor(m % 1440 / 60) });
}
function quotaHtml(a) {
  if (a === 'cursor') return `<div class="quota note">${t('Cursor CLI 不提供剩餘額度')}</div>`;
  const q = agentStatus.limits?.[a];
  if (!q?.windows?.length) return a === 'claude' ? `<div class="quota note">${t('額度：Claude 回覆一次後顯示')}</div>` : a === 'codex' ? `<div class="quota note">${t('額度：還沒讀到')}</div>` : '';
  const fable = usesFable(a);
  return `<div class="quota">${q.windows.filter(w => !FABLE_WINS.includes(w.kind) || fable).map(w => {
    const reset = w.resetsAt && w.resetsAt * 1000 < Date.now();   // 已過重置時間，舊數字不準，視為用量歸零
    const left = Math.max(0, 100 - (reset ? 0 : w.used));
    const tip = reset ? '' : w.resetsAt ? t('已用 {used}%，{when}重置', { used: w.used, when: untilText(w.resetsAt) }) : '';
    return `<div class="qrow" title="${esc(tip)}"><span class="ql">${esc(t(WIN_LABEL[w.kind] || w.kind))}</span><span class="qbar"><i class="${left < 20 ? 'low' : ''}" style="width:${left}%"></i></span><span class="qv">${t('剩 {n}%', { n: left })}</span></div>`;
  }).join('')}</div>`;
}
// Claude API 備用（主程序的 billing）：正在用 API 時，卡片上一塊提示：為什麼切、API 約剩多少、訂閱額度恢復了沒、切回訂閱。
// 用訂閱、但設了金鑰時只有一行「API 備用已設定」與「改用 API」
const money = v => '$' + (Math.round(v * 100) / 100).toFixed(2);
function billingLeft(b) {
  return typeof b.remaining === 'number' ? t('API 額度約剩 {money}', { money: money(b.remaining) })
    : t('API 已用 {money}（在設定填剩餘額度，就能算出還剩多少）', { money: money(b.spent || 0) });
}
function billingHtml(a) {
  const b = agentStatus.billing;
  if (!b || a !== b.agent) return '';
  if (b.mode === 'api') {
    const back = !!b.resetsAt && b.resetsAt <= Date.now();
    const why = b.reason === 'auto' ? t(b.hit === 'five_hour' ? '5 小時額度用完，自動改用 Claude API' : '每週額度用完，自動改用 Claude API') : t('手動改用 Claude API');
    const reset = b.resetsAt ? (back ? t('訂閱額度應該已經恢復，可以切回訂閱') : t('訂閱額度 {when}恢復', { when: untilText(b.resetsAt / 1000) })) : '';
    const low = typeof b.remaining === 'number' && b.remaining < 5;
    return `<div class="bill api${back ? ' back' : ''}"><div class="bl-t">💳 ${esc(t('正在用 Claude API'))}</div><div class="bl-d">${esc(why)}</div>`
      + `<div class="bl-m${low ? ' low' : ''}">${esc(billingLeft(b))}</div>${reset ? `<div class="bl-r">${esc(reset)}</div>` : ''}`
      + `<button class="btn bl-btn${back ? ' primary' : ''}" data-bill="sub">${esc(t('切回訂閱'))}</button></div>`;
  }
  if (!b.hasKey) return '';
  return `<div class="bill sub"><span class="t">${esc(t('API 備用已設定'))}${typeof b.remaining === 'number' ? ' · ' + esc(billingLeft(b)) : ''}</span>`
    + `<button class="bill-btn" data-bill="api" title="${esc(t('不等額度用完，現在就改用 Claude API'))}">${esc(t('改用 API'))}</button></div>`;
}
async function switchBilling(mode) {
  if (mode === 'api' && !await confirmBox(t('改用 Claude API？之後 Claude 每一輪都扣 API 額度，直到你切回訂閱。'))) return;
  const r = await api.setBilling({ mode });
  if (r?.error) return alertBox(t(r.error));
  agentStatus = await api.agentStatus();
  renderAgentPanel(); renderAgentInfo();
}
// session 大小：這個 Agent 在這個對話的 session 現在約多少 tokens（之後每一輪至少要重送這麼多），佔模型上下文的幾成。
// 主程序每輪跑完記在 conv.sizes（算法見 agents.js 的 sessionSize）；上下文大小 Claude 有回報（window），其他用 DEFAULT_WINDOW 估。
// 用到 COMPRESS_AT（八成）就提醒壓縮：再大下去 CLI 會自己摘要或塞不下
const DEFAULT_WINDOW = 200000, COMPRESS_AT = 0.8;
function fmtTokens(n) {
  return n < 1000 ? String(n) : n < 100000 ? (n / 1000).toFixed(1) + 'k' : n < 1e6 ? Math.round(n / 1000) + 'k' : (n / 1e6).toFixed(n % 1e6 ? 2 : 0) + 'M';
}
// 這個 Agent 的 session：{ n, win, pct, guess（上下文大小是估的）, big }；沒有 session 或大小未知回 null
function sessionOf(a, c = current) {
  const s = c?.sessions?.[a] && c.sizes?.[a];
  if (typeof s?.tokens !== 'number') return null;
  const win = s.window || DEFAULT_WINDOW;
  return { n: s.tokens, win, pct: Math.round(s.tokens / win * 100), guess: !s.window, big: s.tokens >= win * COMPRESS_AT };
}
function sessionHtml(a) {
  if (!current?.sessions?.[a]) return '';
  const s = sessionOf(a);
  // 回合在跑或正在壓縮時「壓縮」不能按（按了也不會動），壓灰
  const off = isRunning() ? 'disabled' : '';
  const tip = t('這個 Agent 在這個對話的 session 大小，之後每一輪至少要重送這麼多。Claude 的數字是準的，Codex、Cursor 是估的。')
    + (s?.guess ? '\n' + t('這個 CLI 沒有回報模型的上下文大小，以 {win} 估。', { win: fmtTokens(DEFAULT_WINDOW) }) : '');
  return `<div class="sess ${s?.big ? 'big' : ''}" title="${esc(tip)}">`
    + `<span class="t">${esc(s ? t('session {n}／{win}（{pct}%）', { n: fmtTokens(s.n), win: (s.guess ? '~' : '') + fmtTokens(s.win), pct: s.pct }) : t('session：大小未知'))}${s?.big ? ` · ${esc(t('接近上限，建議壓縮'))}` : ''}</span>`
    // 接近上限時多一顆「壓縮」：和頂列的 🗜 同一件事，由這張卡片的 Agent 寫索引
    + (s?.big ? `<button class="sess-compress" data-compress="${a}" ${off} title="${esc(t('壓縮對話：請 {name} 替對話寫索引，之後清掉各 Agent 的 session。寫索引會花 {name} 一輪的額度。', { name: LABEL[a] }))}">${esc(t('壓縮'))}</button>` : '')
    + '</div>';
}
api.on('conv:meta', ({ convId, sessions, sizes }) => {
  if (current?.id !== convId) return;
  current.sessions = sessions; current.sizes = sizes;
  renderAgentPanel(); renderCompressTip();
});
// 右欄只看目前這個對話的 Agent
function renderAgentPanel() {
  const cid = current?.id;
  const run = agentStatus.running.filter(j => j.convId === cid);
  $('#panelCount').textContent = run.length ? t('{n} 個工作中', { n: run.length }) : '';
  const cu = convUsage(current);
  $('#convUsage').textContent = cu ? t('這個對話：{n} tokens', { n: fmtTokens(cu.total) }) + (cu.cost ? ` · $${cu.cost.toFixed(2)}` : '') : '';
  $('#convUsage').title = cu ? t('每則回覆與委派回報的用量加總；費用只算有回報的（Claude），是 API 牌價') : '';
  $('#agentCards').innerHTML = enabledAgents().map(a => {
    const mine = run.filter(j => j.agent === a);
    const jobs = mine.map(j => `<div class="job" title="${esc(j.prompt)}">
        <div class="jt"><span class="role">${j.role === 'delegate' ? t('Claude 委派') : j.role === 'compress' ? t('壓縮') : t('主對話')}</span><span class="t">${esc(j.prompt)}</span><span class="tm">${elapsed(Date.now() - j.startedAt)}</span></div>
        <div class="act">${esc(t(j.activity))}</div></div>`).join('');
    const c = settings?.agents[a];
    const switchable = canSwitchModel(c);
    const model = !settings ? '' : switchable
      ? `<button class="model-btn" data-model="${a}" title="${esc(t('切換這個對話用的模型與強度'))}"><span class="t">${esc(modelLine(a))}</span><span class="caret"></span></button>`
      : `<div class="model">${esc(modelLine(a))}</div>`;
    return `<div class="acard ${mine.length ? 'busy' : ''}" data-agent="${a}">
      <div class="acard-head"><span class="badge ${a}">${INITIAL[a]}</span><span class="nm">${LABEL[a]}</span>
        <span class="st ${mine.length ? 'busy' : ''}">${mine.length ? (mine.length > 1 ? t('工作中 ×{n}', { n: mine.length }) : t('工作中')) : t('閒置')}</span></div>
      ${model}${permBtnHtml(a)}${billingHtml(a)}${sessionHtml(a)}${quotaHtml(a)}${jobs}</div>`;
  }).join('');
  const fin = agentStatus.finished.filter(j => j.convId === cid).slice(0, 12);
  const icon = { done: '✓', error: '✕', stopped: '■' };
  $('#recentJobs').innerHTML = fin.length ? fin.map(j => `<li title="${esc(j.prompt)}">
      <span class="ic ${j.status}">${icon[j.status] || '·'}</span>
      <div class="body"><div class="l1"><b>${LABEL[j.agent]}</b><span class="t">${esc(j.prompt)}</span></div>
      <div class="l2">${esc(t(j.activity))} · ${elapsed(j.endedAt - j.startedAt)} · ${ago(j.endedAt)}</div></div></li>`).join('')
    : `<li class="empty">${t('這個對話還沒有完成的工作')}</li>`;
}
api.on('agents:status', st => { agentStatus = st; renderAgentPanel(); renderAgentInfo(); });

// ---------- 右欄卡片：切換這個對話的模型與強度 ----------
let modelMenuAgent = null, modelMenuMore = false, modelMenuKind = 'model';   // kind：model（模型與強度）或 perm（權限）
const modelErrors = {};
function hideModelMenu() { $('#modelMenu').classList.add('hidden'); modelMenuAgent = null; }
async function loadModels(a) {
  if (modelLists[a]) return modelLists[a];
  const r = await api.listModels(a, settings.agents[a]);
  if (r.models?.length) { modelLists[a] = r; delete modelErrors[a]; } else modelErrors[a] = r.error || '讀不到模型清單';
  return r;
}
function renderModelMenu() {
  const a = modelMenuAgent, m = $('#modelMenu');
  if (!a || !current) return;
  const base = settings.agents[a], eff = effCfg(a), L = modelLists[a];
  const ck = on => on ? '<span class="ck">✓</span>' : '';
  // 清單讀到了、但設定或對話指定的模型不在裡面：標「尚未確認可用」，不當成清單裡的模型
  const known = L ? [...L.models, ...(L.more || [])] : null;
  const unc = id => !!(known && id && !known.includes(id));
  const shown = id => (unc(id) ? t('{model}（尚未確認可用）', { model: modelName(a, id) }) : modelName(a, id));
  const own = current.agentCfg?.[a] || {};
  // 打勾只看這個對話有沒有另外選：沒選就只勾「跟隨設定」，選了就只勾那一項
  const item = id => `<button data-m="${esc(id)}" title="${esc(id)}"><span class="nm${unc(id) ? ' unc' : ''}">${esc(shown(id))}</span>${ck(own.model === id)}</button>`;
  if (modelMenuKind === 'perm') { m.innerHTML = permMenuHtml(a, base, own, ck); return; }
  let html = `<div class="sec">${esc(t('模型（只套用在這個對話）'))}</div>
    <button data-m=""><span class="nm${unc(base.model) ? ' unc' : ''}">${esc(t('跟隨設定（{model}）', { model: base.model ? shown(base.model) : t('CLI 預設') }))}</span>${ck(typeof own.model !== 'string')}</button>
    <button data-cli><span class="nm">${esc(t('CLI 自己決定'))}</span>${ck(own.model === '')}</button>`;
  if (!L) html += `<div class="sec">${esc(modelErrors[a] ? t(modelErrors[a]) : t('讀取模型清單中…'))}</div>`;
  else {
    html += L.models.map(item).join('');
    if (L.more?.length) {
      html += `<button data-more class="more">${esc(t('更多模型'))}<span class="chev${modelMenuMore ? ' open' : ''}"></span></button>`;
      if (modelMenuMore) html += `<div class="sub">${L.more.map(item).join('')}</div>`;
    }
    if (own.model && !known.includes(own.model)) html += item(own.model);
  }
  if (a !== 'claude') html += `<button data-reload class="more">${esc(t('重新讀取模型清單'))}</button>`;
  if (effortsOf(a).length) {
    html += `<hr><div class="sec">${esc(t('強度'))}</div>
      <button data-e=""><span class="nm">${esc(t('跟隨設定（{model}）', { model: base.effort || t('CLI 預設') }))}</span>${ck(typeof own.effort !== 'string')}</button>`
      + effortsOf(a).map(e => `<button data-e="${e}"><span class="nm">${e}</span>${ck(typeof own.effort === 'string' && eff.effort === e)}</button>`).join('');
  }
  m.innerHTML = html;
}
// 權限選單：只套用在這個對話的工作模式。每一項上面是名稱、下面是說明；有安全疑慮的用警告色
function permMenuHtml(a, base, own, ck) {
  const pk = permKeyOf(a), mine = typeof own[pk] === 'string';
  const two = label => { const [name, ...rest] = t(label).split(/[：:]/); return `<span class="nm two"><span>${esc(name.trim())}</span>${rest.length ? `<span class="desc">${esc(rest.join('：').trim())}</span>` : ''}</span>`; };
  const cls = v => (DANGER_PERMS[a]?.includes(v) ? ' class="danger"' : '');
  return `<div class="sec">${esc(t('權限（只套用在這個對話的工作模式）'))}</div>
    <button data-p=""><span class="nm">${esc(t('跟隨設定（{model}）', { model: permShort(a, base[pk] || PERMS[a][0][0]) }))}</span>${ck(!mine)}</button>`
    + PERMS[a].map(([v, label]) => `<button data-p="${v}"${cls(v)}>${two(label)}${ck(mine && own[pk] === v)}</button>`).join('');
}
async function showModelMenu(a, btn, kind = 'model') {
  modelMenuAgent = a; modelMenuMore = false; modelMenuKind = kind;
  const m = $('#modelMenu');
  renderModelMenu();
  m.classList.remove('hidden');
  const r = btn.getBoundingClientRect();
  m.style.left = Math.max(6, Math.min(r.left, innerWidth - m.offsetWidth - 8)) + 'px';
  m.style.top = Math.max(6, Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 8)) + 'px';
  if (kind === 'model' && !modelLists[a]) { delete modelErrors[a]; await loadModels(a); if (modelMenuAgent === a) renderModelMenu(); }
}
async function setConvAgentCfg(a, patch) {
  if (!current) return;
  current = await api.updateConv(current.id, { agentCfg: { [a]: patch } });
  renderAgentPanel(); updateComposer();
}
$('#agentCards').addEventListener('click', e => {
  const bill = e.target.closest('[data-bill]');
  if (bill) return switchBilling(bill.dataset.bill);
  const comp = e.target.closest('.sess-compress');
  if (comp) return compressWith(comp.dataset.compress);
  const p = e.target.closest('.perm-btn[data-perm]');
  if (p) { e.stopPropagation(); return modelMenuAgent === p.dataset.perm && modelMenuKind === 'perm' ? hideModelMenu() : showModelMenu(p.dataset.perm, p, 'perm'); }
  const b = e.target.closest('.model-btn');
  if (!b) return;
  e.stopPropagation();
  if (modelMenuAgent === b.dataset.model && modelMenuKind === 'model') hideModelMenu(); else showModelMenu(b.dataset.model, b);
});
$('#modelMenu').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const a = modelMenuAgent;
  if ('more' in b.dataset) { modelMenuMore = !modelMenuMore; return renderModelMenu(); }
  if ('reload' in b.dataset) {
    // 重跑 CLI 的列模型指令，不用之前讀到的清單
    delete modelLists[a]; delete modelErrors[a]; renderModelMenu();
    return loadModels(a).then(() => { if (modelMenuAgent === a) renderModelMenu(); });
  }
  if ('cli' in b.dataset) setConvAgentCfg(a, { model: '' });
  else if ('m' in b.dataset) setConvAgentCfg(a, { model: b.dataset.m || null });
  else if ('e' in b.dataset) setConvAgentCfg(a, { effort: b.dataset.e || null });
  else if ('p' in b.dataset) setConvAgentCfg(a, { [permKeyOf(a)]: b.dataset.p || null });
  hideModelMenu();
});
document.addEventListener('mousedown', e => { if (!e.target.closest('#modelMenu, .model-btn, .perm-btn')) hideModelMenu(); }, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideModelMenu(); });
window.addEventListener('blur', hideModelMenu);
setInterval(() => { if (agentStatus.running.length && panelOn()) renderAgentPanel(); }, 1000);
setInterval(() => { if (panelOn()) { renderAgentPanel(); refreshWork(); } }, 30000);
// 右欄開關：使用者按 ▤ 的選擇記在 localStorage。視窗窄到主欄放不下（PANEL_AUTO 以下）時自動收起、不記；
// 拉寬回來再自動打開。窄的時候使用者自己按 ▤ 打開就照他的，直到視窗又變寬
const PANEL_AUTO = 1100;
let panelPref = true, panelAuto = false, panelForced = false;
try { panelPref = localStorage.getItem('agentPanel') !== '0'; } catch {}
const panelOn = () => !document.body.classList.contains('panel-off');
function setPanel(on) {
  panelPref = on;
  panelForced = innerWidth < PANEL_AUTO;
  panelAuto = false;
  document.body.classList.toggle('panel-off', !on);
  try { localStorage.setItem('agentPanel', on ? '1' : '0'); } catch {}
  fitTopbar();
  if (on) renderAgentPanel();
}
function autoPanel() {
  const narrow = document.body.clientWidth < PANEL_AUTO;
  if (!narrow) panelForced = false;
  const on = panelPref && (!narrow || panelForced);
  panelAuto = panelPref && !on;
  document.body.classList.toggle('panel-off', !on);
  $('#togglePanel').title = t(panelAuto ? '視窗太窄，Agent 工作狀況先收起來了；點擊顯示' : '顯示／隱藏 Agent 工作狀況');
}
$('#togglePanel').onclick = () => setPanel(!panelOn());
// 主欄很窄時頂列只留標題與圖示（樣式見 style.css 的 #topbar.tight），圖示才不會被擠出去蓋到右欄；
// 主欄不到 600 時輸入框也收緊（#main.narrow：模式只留圖示、藏資訊列）
function fitTopbar() {
  const w = $('#main').clientWidth;
  $('#topbar').classList.toggle('tight', w < 400);
  $('#main').classList.toggle('narrow', w < 600);
}
function fitLayout() { autoPanel(); fitTopbar(); }
window.addEventListener('resize', fitLayout);
fitLayout();

// ---------- 頂列 ----------
function editTitle() {
  if (!current) return;
  const box = $('#convTitle'); box.contentEditable = 'true'; box.focus();
  document.getSelection().selectAllChildren(box);
  const done = async () => { box.contentEditable = 'false'; box.onblur = null; current.title = box.textContent.trim() || current.title; await api.updateConv(current.id, { title: current.title }); };
  box.onblur = done;
  box.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); box.blur(); } if (e.key === 'Escape') { box.textContent = t(current.title); box.blur(); } };
}
$('#convTitle').ondblclick = editTitle;
async function setCwd(p) {
  if (!current || !p) return;
  if (projKey(p) !== projKey(current.cwd)) { current = await api.updateConv(current.id, { cwd: p }); renderConv(); }
  $('#input').focus();
}
$('#cwdBtn').onclick = () => current && api.openPath(current.cwd);
$('#moreBtn').onclick = e => {
  e.stopPropagation();
  const c = current && convList.find(x => x.id === current.id);
  if (!c) return;
  const r = $('#moreBtn').getBoundingClientRect();
  showConvMenu(c, r.right - 200, r.bottom + 4, true);
};

// ---------- 新對話：輸入框上方的資料夾選單 ----------
function recentDirs() {
  const seen = new Map();
  for (const c of [...convList].sort((a, b) => b.updated - a.updated)) if (c.cwd && !seen.has(projKey(c.cwd))) seen.set(projKey(c.cwd), c.cwd);
  const d = settings?.defaultCwd;
  if (d && !seen.has(projKey(d))) seen.set(projKey(d), d);
  return [...seen.values()].slice(0, 8);
}
function closeCwdMenu() { $('#cwdMenu').classList.add('hidden'); $('#cwdPickBtn').classList.remove('on'); }
function openCwdMenu() {
  const cur = projKey(current?.cwd);
  $('#cwdMenu').innerHTML = `<div class="sec">${esc(t('最近'))}</div>`
    + recentDirs().map(d => `<button data-dir="${esc(d)}" title="${esc(d)}"><span class="mi">📁</span><span class="nm">${esc(baseName(d))}</span>${projKey(d) === cur ? '<span class="ck">✓</span>' : ''}</button>`).join('')
    + `<hr><button data-act="browse"><span class="mi">…</span>${esc(t('開啟資料夾…'))}</button>`;
  $('#cwdMenu').classList.remove('hidden');
  $('#cwdPickBtn').classList.add('on');
}
$('#cwdPickBtn').onclick = e => { e.stopPropagation(); $('#cwdMenu').classList.contains('hidden') ? openCwdMenu() : closeCwdMenu(); };
$('#cwdMenu').onclick = async e => {
  const b = e.target.closest('button'); if (!b) return;
  closeCwdMenu();
  setCwd(b.dataset.act === 'browse' ? await api.pickFolder(current?.cwd || settings.defaultCwd) : b.dataset.dir);
};
document.addEventListener('click', e => { if (!e.target.closest('.cwd-pick')) closeCwdMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#cwdMenu').classList.contains('hidden')) closeCwdMenu(); });
async function deleteConvById(id, title) {
  if (!await confirmBox(t('刪除「{title}」？此動作無法復原。', { title: t(title) }))) return;
  await api.deleteConv(id);
  delete drafts[id];
  if (current?.id === id) { current = null; loadDraft(); }
  await refreshList();
  if (!current) { const next = nextConv(); if (next) openConv(next.id); else renderConv(); }
  else renderList();
}

// ---------- 自訂 Agent ----------
const CUSTOM_PRESETS = {
  antigravity: {
    title: 'Antigravity CLI（agy）', name: 'Antigravity', color: '#4f8ef7', cli: 'agy',
    args: '--output-format stream-json --input-format stream-json --dangerously-skip-permissions',
    promptMode: 'stream-json', promptFlag: '', format: 'antigravity', modelFlag: '--model', resumeFlag: '--conversation',
    ...Presets.ANTIGRAVITY, versionArgs: '--version', statusArgs: '', loginArgs: '*', installCmd: 'irm https://antigravity.google/cli/install.ps1 | iex',
    doc: 'https://antigravity.google/docs/cli/headless', description: 'Google Antigravity CLI (Gemini)',
  },
  claudejson: {
    title: 'Claude 相容格式（stream-json）', name: '自訂 Agent', color: '#e0a458', cli: '', args: '-p --output-format stream-json --verbose',
    promptMode: 'stdin', promptFlag: '', format: 'claude', modelFlag: '--model', resumeFlag: '--resume',
    versionArgs: '--version', statusArgs: '', loginArgs: '', installCmd: '', doc: '', description: '',
  },
  text: {
    title: '一般 CLI（純文字輸出）', name: '自訂 Agent', color: '#6cc28a', cli: '', args: '',
    promptMode: 'stdin', promptFlag: '', format: 'text', modelFlag: '', resumeFlag: '',
    versionArgs: '--version', statusArgs: '', loginArgs: '', installCmd: '', doc: '', description: '',
  },
};
// 自訂 Agent 有模型旗標、也設了列模型參數（舊設定由主程序的 upgradeCustom 補上），右欄才能切換模型
const hasModelList = c => !!String(c?.modelsArgs || '').trim();
const canSwitchModel = c => !!c && (!c.custom || (!!c.modelFlag?.trim() && hasModelList(c)));
// Gemini CLI 已由 Antigravity CLI 取代，不再列出；舊設定還在用的才顯示
const FORMATS = [['text', '純文字：stdout 直接當回覆（任何 CLI 都能用）'], ['claude', 'Claude 相容 stream-json（看得到工具與即時串流）'], ['antigravity', 'Antigravity CLI stream-json（agy）']];
const formatsFor = cur => cur === 'gemini' ? [...FORMATS, ['gemini', 'Gemini CLI stream-json']] : FORMATS;
// Codex、Cursor 預設不加入，跟自訂 Agent 一樣從「新增其他 CLI Agent」加
const BUILTIN_ADD = [['codex', 'Codex CLI（OpenAI）'], ['cursor', 'Cursor Agent CLI']];
const trOpts = list => list.map(([v, label]) => [v, t(label)]);
const safeColor = c => /^#[0-9a-f]{3,8}$/i.test(c || '') ? c : '#8a8a92';

function renderAgentStyles() {
  let css = '';
  for (const [id, c] of Object.entries(settings?.agents || {})) {
    if (!c.custom) continue;
    const col = safeColor(c.color);
    css += `.badge.${id}{background:${col}}.delegate.${id}{border-left-color:${col}}.seg button[data-agent="${id}"].on{box-shadow:inset 0 -2px 0 ${col}}`;
  }
  let tag = document.getElementById('agentStyles');
  if (!tag) { tag = document.createElement('style'); tag.id = 'agentStyles'; document.head.appendChild(tag); }
  tag.textContent = css;
}

function customSettingsHtml(a) {
  const c = form.agents[a];
  const v = k => esc(c[k] ?? '');
  const effs = Presets.effortList(c);
  const opt = (list, cur) => list.map(([val, t]) => `<option value="${val}" ${cur === val ? 'selected' : ''}>${t}</option>`).join('');
  return `<section class="set-group custom${foldCls(a)}" data-agent="${a}">
    <h3 class="fold-head" title="${esc(t('展開／收合這個 Agent 的設定'))}"><span class="chev"></span><span class="badge" style="background:${safeColor(c.color)}">${esc((c.name || '?').trim().charAt(0).toUpperCase())}</span>${esc(c.name || t('自訂 Agent'))}<span class="muted">${t('自訂')}</span><span class="spacer"></span>
      <button class="btn subtle" data-act="delete">${t('刪除')}</button></h3>
    <div class="conn-wrap" data-conn="${a}">${connHtml(a)}</div>
    <div class="ag-body">
    <label class="row"><span>${t('名稱／顏色')}</span><div class="inline"><input data-k="name" value="${v('name')}" placeholder="${t('顯示名稱')}"><input data-k="color" type="color" value="${safeColor(c.color)}" class="color"></div></label>
    <label class="row"><span>${t('CLI 指令')}</span><input data-k="cli" value="${v('cli')}" placeholder="${t('例如 gemini，或完整路徑')}"></label>
    <label class="row"><span>${t('額外參數')}</span><input data-k="args" value="${v('args')}" placeholder="${t('例如 --output-format stream-json --yolo')}"></label>
    <div class="hint">${t('以空白分隔，含空白的參數用雙引號包起來；<code>{cwd}</code> 會換成對話的工作資料夾。')}</div>
    <label class="row"><span>${t('Prompt 傳入')}</span><div class="inline">
      <select data-k="promptMode">${opt(trOpts([['stdin', '從 stdin 傳入'], ['arg', '接在參數最後'], ['stream-json', '一行 JSON 從 stdin 傳入（agy）']]), c.promptMode)}</select>
      <input data-k="promptFlag" value="${v('promptFlag')}" placeholder="${t('前面加的旗標，例如 -p（可空）')}"></div></label>
    <label class="row"><span>${t('輸出格式')}</span><select data-k="format">${opt(trOpts(formatsFor(c.format)), c.format)}</select></label>
    <label class="row"><span>${t('預設模型')}</span><div class="inline">${hasModelList(c) ? modelFieldHtml(a, c) : `<input data-k="model" value="${v('model')}" placeholder="${t('留空＝CLI 預設')}">`}<input data-k="modelFlag" value="${v('modelFlag')}" placeholder="${t('模型旗標，例如 -m')}" class="narrow"></div></label>
    <label class="row"><span>${t('強度')}</span><div class="inline">${effs.length
      ? `<select data-k="effort"><option value="">${t('預設（CLI 自己決定）')}</option>${[...(c.effort && !effs.includes(c.effort) ? [c.effort] : []), ...effs].map(e => `<option value="${esc(e)}" ${c.effort === e ? 'selected' : ''}>${esc(e)}</option>`).join('')}</select>`
      : `<input data-k="effort" value="${v('effort')}" placeholder="${t('留空＝CLI 預設')}">`}<input data-k="effortFlag" value="${v('effortFlag')}" placeholder="${t('強度旗標，例如 --effort')}" class="narrow"></div></label>
    <label class="row"><span>${t('接續 session 旗標')}</span><input data-k="resumeFlag" value="${v('resumeFlag')}" placeholder="${t('例如 --resume；留空＝每次重開，自動附上對話記錄')}"></label>
    <label class="row"><span>${t('給 Claude 的說明')}</span><input data-k="description" value="${v('description')}" placeholder="${t('它擅長什麼，Claude 決定要不要委派時參考')}"></label>
    <label class="row check"><input type="checkbox" data-k="delegate" ${c.delegate !== false ? 'checked' : ''}><span>${t('讓 Claude 可以委派工作給它')}</span></label>
    ${frugalRowHtml(c)}
    <details class="adv"><summary>${t('進階：偵測、安裝、登入')}</summary>
      <label class="row"><span>${t('版本參數')}</span><input data-k="versionArgs" value="${v('versionArgs')}" placeholder="--version"></label>
      <label class="row"><span>${t('登入狀態參數')}</span><input data-k="statusArgs" value="${v('statusArgs')}" placeholder="${t('例如 auth status（可空）')}"></label>
      <label class="row"><span>${t('列模型參數')}</span><input data-k="modelsArgs" value="${v('modelsArgs')}" placeholder="${t('例如 models（可空）；輸出一行一個模型')}"></label>
      <label class="row"><span>${t('強度選項')}</span><input data-k="efforts" value="${v('efforts')}" placeholder="${t('例如 low medium high（空白分隔，可空）')}"></label>
      <label class="row"><span>${t('登入參數')}</span><input data-k="loginArgs" value="${v('loginArgs')}" placeholder="${t('例如 login；填 * 代表直接開啟互動模式登入')}"></label>
      <label class="row"><span>${t('安裝指令')}</span><input data-k="installCmd" value="${v('installCmd')}" placeholder="${t('PowerShell 指令，例如 npm install -g …')}"></label>
      <label class="row"><span>${t('說明網址')}</span><input data-k="doc" value="${v('doc')}" placeholder="https://…"></label>
    </details>
    </div>
  </section>`;
}

function addCustomHtml() {
  return `<div class="add-custom">
    <span class="muted">${t('新增其他 CLI Agent：')}</span>
    <select id="customPreset">${BUILTIN_ADD.filter(([a]) => !form.agents[a]?.enabled).map(([a, title]) => `<option value="builtin:${a}">${t(title)}</option>`).join('')}${Object.entries(CUSTOM_PRESETS).map(([k, p]) => `<option value="${k}">${t(p.title)}</option>`).join('')}</select>
    <button class="btn primary" data-act="addCustom">${t('＋ 新增 Agent')}</button>
  </div>`;
}

function newCustomId() {
  let id;
  do { id = 'x' + Math.random().toString(16).slice(2, 7); } while (form.agents[id]);
  return id;
}

// ---------- 設定 ----------
const allAgents = () => Object.keys(settings?.agents || {});
const enabledAgents = () => allAgents().filter(a => settings?.agents[a]?.enabled);
let form = null;                 // 設定視窗裡尚未儲存的副本
const conn = {};                 // agent -> 偵測結果
const polls = {};                // agent -> 計時器

function connHtml(a) {
  const r = conn[a];
  let pill, btns = [];
  if (!r || r.checking) pill = `<span class="pill wait">${t('偵測中…')}</span>`;
  else if (!r.found) {
    pill = `<span class="pill bad">${t('找不到 CLI')}</span>`;
    if (r.install?.cmd) btns.push(`<button class="btn primary" data-act="install">${t('安裝')}</button>`);
  } else if (r.loggedIn === false) {
    pill = `<span class="pill warn">${t('已安裝，未登入')}</span>`;
    if (r.canLogin) btns.push(`<button class="btn primary" data-act="login">${t('登入')}</button>`);
  } else if (r.loggedIn === null) pill = `<span class="pill ok">${t('已找到 CLI')}</span>`;
  else pill = `<span class="pill ok">${r.account ? esc(t('已連結：{account}', { account: r.account })) : t('已連結')}</span>`;
  if (r?.found && r.loggedIn !== false && r.canLogin) btns.push(`<button class="btn" data-act="login">${t('重新登入')}</button>`);
  btns.push(`<button class="btn" data-act="check">${t('重新偵測')}</button>`, `<button class="btn" data-act="browse">${t('指定路徑…')}</button>`);
  if (r?.install?.doc) btns.push(`<button class="btn link" data-act="doc">${t('說明')}</button>`);
  const where = r?.found ? `<div class="conn-path" title="${esc(r.path)}">${esc(r.version)} · ${esc(r.path)}</div>`
    : r && !r.checking && r.install?.cmd ? `<div class="conn-path">${t('安裝指令：')}<code>${esc(r.install.cmd)}</code></div>` : '';
  const polling = polls[a] ? `<span class="muted">${t('等待完成…（每 4 秒自動偵測）')}</span>` : '';
  return `<div class="conn">${pill}${polling}<span class="spacer"></span>${btns.join('')}</div>${where}`;
}

function agentSettingsHtml(a) {
  const c = form.agents[a];
  if (c.custom) return customSettingsHtml(a);
  if (!c.enabled) return '';
  const effort = [`<option value="">${t('預設（CLI 自己決定）')}</option>`, ...EFFORTS[a].map(e => `<option ${c.effort === e ? 'selected' : ''}>${e}</option>`)].join('');
  const permKey = a === 'codex' ? 'sandbox' : 'permission';
  const perms = PERMS[a].map(([v, label]) => `<option value="${v}" ${c[permKey] === v ? 'selected' : ''}>${t(label)}</option>`).join('');
  return `<section class="set-group${foldCls(a)}" data-agent="${a}">
    <h3 class="fold-head" title="${esc(t('展開／收合這個 Agent 的設定'))}"><span class="chev"></span><span class="badge ${a}">${INITIAL[a]}</span>${LABEL[a]}${a === 'claude' ? `<span class="muted">${t('（主要對話，不能移除）')}</span>` : ''}<span class="spacer"></span>
      ${a === 'claude' ? '' : `<button class="btn subtle" data-act="disable">${t('移除')}</button>`}</h3>
    <div class="conn-wrap" data-conn="${a}">${connHtml(a)}</div>
    <div class="ag-body">
    <label class="row"><span>${t('CLI 指令')}</span><input data-k="cli" value="${esc(c.cli)}" placeholder="${a === 'cursor' ? 'agent' : a}"></label>
    <label class="row"><span>${t('預設模型')}</span><div class="inline">${modelFieldHtml(a, c)}</div></label>
    <label class="row"><span>${t('強度')}</span><select data-k="effort">${effort}</select></label>
    ${a === 'cursor' ? `<div class="hint">${t('Cursor 的強度會組成 模型[effort=…]；模型 id 本身已含強度（例如 -high）時不另外加。')}</div>` : ''}
    <label class="row"><span>${a === 'codex' ? t('沙箱') : t('權限')}</span><select data-k="${permKey}">${perms}</select></label>
    ${frugalRowHtml(c)}
    </div>
  </section>`;
}
// 設定頁每個 Agent 的表單預設收起來，只露出名稱與連線狀態；點標題展開。展開了哪些在這次開著設定頁時記住
let openSecs = new Set();
const foldCls = a => (openSecs.has(a) ? '' : ' folded');
// 每個 Agent 各自開關的「極度節省 token」規則（主程序在 prompt 裡附上，見 main.js 的 notesFor）
const FRUGAL_HINT = 'AgentDesk 會在每個 session 開頭把這條規則附給這個 Agent：不寫旁白、只在收尾回覆結果、不重述，壞消息與未驗證的事照常講。只在 AgentDesk 裡有效。';
function frugalRowHtml(c) {
  return `<label class="row check" title="${esc(t(FRUGAL_HINT))}"><input type="checkbox" data-k="frugal" ${c.frugal ? 'checked' : ''}><span>${t('附上「極度節省 token」規則')}</span></label>`;
}
// 剛在設定頁新增一個 CLI：問要不要替它加上規則。選是就勾起來（和其他欄位一樣，按「儲存」後生效）
async function offerFrugal(id, name) {
  if (!await confirmBox(t('要替 {name} 加上「極度節省 token」規則嗎？\nAgentDesk 會在每個 session 開頭把規則附給它：不寫旁白、只在收尾回覆結果、不重述，壞消息與未驗證的事照常講。\n之後可以在它的設定裡開關。', { name }))) return;
  if (!form?.agents[id]) return;
  form.agents[id].frugal = true;
  const box = document.querySelector(`#agentSettings section[data-agent="${id}"] [data-k="frugal"]`);
  if (box) box.checked = true;
}

// 有清單就用下拉選單（原本的 datalist 會依欄位內容過濾，只看得到目前那一個）；還沒讀過清單就先給輸入框
function modelFieldHtml(a, c) {
  const L = modelLists[a];
  if (!L) return `<input data-k="model" value="${esc(c.model)}" placeholder="${t('留空＝CLI 預設')}"><button class="btn" data-load="${a}">${t('讀取清單')}</button>`;
  const opt = id => `<option value="${esc(id)}" ${c.model === id ? 'selected' : ''}>${esc(L.labels?.[id] && L.labels[id] !== id ? `${L.labels[id]}（${id}）` : id)}</option>`;
  const known = [...L.models, ...(L.more || [])];
  // 設定的模型不在清單裡：標「尚未確認可用」
  const unconfirmed = c.model && !known.includes(c.model)
    ? `<option value="${esc(c.model)}" selected>${esc(t('{model}（尚未確認可用）', { model: c.model }))}</option>` : '';
  return `<select data-k="model"><option value="">${t('預設（CLI 自己決定）')}</option>${unconfirmed}
    <optgroup label="${esc(t(L.more ? '常用' : '可用模型'))}">${L.models.map(opt).join('')}</optgroup>
    ${L.more?.length ? `<optgroup label="${esc(t('更多模型'))}">${L.more.map(opt).join('')}</optgroup>` : ''}</select>
    ${a === 'claude' ? '' : `<button class="btn" data-load="${a}">${t('重新讀取')}</button>`}`;
}

function syncForm() {
  if (!form) return;
  form.language = $('#setLang').value;
  form.defaultCwd = $('#setCwd').value.trim() || form.defaultCwd;
  form.delegation = $('#setDelegation').checked;
  form.context = $('#setContext').value;
  form.claudeApi = { ...(form.claudeApi || {}), auto: $('#setApiAuto').checked, when: $('#setApiWhen').value };
  for (const sec of document.querySelectorAll('#agentSettings section')) {
    for (const f of sec.querySelectorAll('[data-k]')) form.agents[sec.dataset.agent][f.dataset.k] = f.type === 'checkbox' ? f.checked : f.value.trim();
  }
}
function renderAgentSettings() { $('#agentSettings').innerHTML = Object.keys(form.agents).map(agentSettingsHtml).join('') + addCustomHtml(); }
function renderConn(a) { const w = document.querySelector(`[data-conn="${a}"]`); if (w) w.innerHTML = connHtml(a); }

async function checkCli(a, force) {
  conn[a] = { ...(conn[a] || {}), checking: true }; renderConn(a);
  conn[a] = await api.cliCheck(a, form ? form.agents[a] : settings.agents[a], force);
  renderConn(a);
  return conn[a];
}
// 安裝或登入在外部視窗進行：每 4 秒偵測，直到達成或 3 分鐘
function pollUntil(a, done) {
  clearInterval(polls[a]);
  const until = Date.now() + 180000;
  polls[a] = setInterval(async () => {
    if ($('#settingsModal').classList.contains('hidden') || Date.now() > until) { clearInterval(polls[a]); delete polls[a]; renderConn(a); return; }
    const r = await api.cliCheck(a, form.agents[a], true);
    if (done(r)) { clearInterval(polls[a]); delete polls[a]; }
    conn[a] = r; renderConn(a);
  }, 4000);
  renderConn(a);
}

// 靜態 HTML 的文字與 title / placeholder：整段等於對照表的 key 才換
function translateDom(root) {
  if (I18n.getLang() === 'zh-TW') return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const k = n.nodeValue.trim();
    if (k && t(k) !== k) n.nodeValue = n.nodeValue.replace(k, t(k));
  }
  for (const el of root.querySelectorAll('[title], [placeholder]')) {
    for (const attr of ['title', 'placeholder']) {
      const v = el.getAttribute(attr);
      if (v && t(v) !== v) el.setAttribute(attr, t(v));
    }
  }
  document.documentElement.lang = { en: 'en', 'zh-CN': 'zh-Hans' }[I18n.getLang()] || 'zh-Hant';
}

function openSettings(note) {
  form = JSON.parse(JSON.stringify(settings));
  $('#setLang').value = form.language || 'auto';
  $('#setCwd').value = form.defaultCwd;
  $('#setDelegation').checked = form.delegation;
  $('#setContext').value = form.context || 'standard';
  renderApiGroup();
  openSecs = new Set();
  renderAgentSettings();
  $('#setMsg').textContent = note || '';
  $('#envResult').innerHTML = '';
  $('#settingsModal').classList.remove('hidden');
  for (const a of Object.keys(form.agents)) if (form.agents[a].enabled) checkCli(a);
}
function readSettingsForm() { syncForm(); return JSON.parse(JSON.stringify(form)); }

// ---------- 設定：Claude API（備用） ----------
// 金鑰和剩餘額度各有自己的按鈕、按了馬上存（金鑰不經過「儲存」整份設定，畫面也拿不到存好的金鑰）；
// 自動切換與切換時機跟著「儲存」
function renderApiGroup() {
  const c = { auto: true, when: 'weekly', ...(form?.claudeApi || settings.claudeApi || {}) };
  $('#apiKeyState').textContent = c.hasKey ? t('已設定（…{last4}）', { last4: c.last4 || '' }) : t('未設定');
  $('#setApiKey').value = '';
  $('#setApiAuto').checked = c.auto !== false;
  $('#setApiWhen').value = c.when === 'any' ? 'any' : 'weekly';
  const b = agentStatus.billing;
  $('#setApiBase').value = typeof b?.remaining === 'number' ? b.remaining.toFixed(2) : '';
  $('#clearApiKey').disabled = !c.hasKey;
}
// 存好金鑰後設定換成主程序回的版本：只換 claudeApi，其他還沒按「儲存」的欄位不動
function applyApiResult(r, msg) {
  if (r?.error) return alertBox(t(r.error));
  settings.claudeApi = r.claudeApi;
  if (form) form.claudeApi = { ...form.claudeApi, hasKey: r.claudeApi.hasKey, last4: r.claudeApi.last4 };
  if (agentStatus.billing) agentStatus.billing.hasKey = r.claudeApi.hasKey;
  renderApiGroup(); renderAgentPanel();
  $('#setMsg').textContent = msg;
}
$('#saveApiKey').onclick = async () => {
  const key = $('#setApiKey').value.trim();
  if (!key) return;
  applyApiResult(await api.setClaudeKey(key), t('已儲存 Claude API 金鑰'));
};
$('#clearApiKey').onclick = async () => {
  if (!await confirmBox(t('清除 Claude API 金鑰？正在用 API 的話會切回訂閱。'))) return;
  applyApiResult(await api.setClaudeKey(''), t('已清除 Claude API 金鑰'));
};
$('#saveApiBase').onclick = async () => {
  const raw = $('#setApiBase').value.trim(), v = Number(raw);
  if (raw && !(v >= 0)) return alertBox(t('請填 0 以上的金額'));
  const r = await api.setBilling({ base: raw ? v : null });
  if (r?.error) return alertBox(t(r.error));
  agentStatus = await api.agentStatus();
  renderApiGroup(); renderAgentPanel();
  $('#setMsg').textContent = raw ? t('已更新 API 剩餘額度：{money}', { money: money(v) }) : t('已清掉 API 剩餘額度');
};

$('#openSettings').onclick = () => openSettings();
$('#settingsModal').onclick = async e => {
  if (e.target === $('#settingsModal') || e.target.closest('[data-close]')) return $('#settingsModal').classList.add('hidden');
  const btn = e.target.closest('button');
  // 點 Agent 的標題（不是標題上的按鈕）：展開／收合那一段
  const head = !btn && e.target.closest('#agentSettings .fold-head');
  if (head) {
    const sec = head.closest('section'), id = sec.dataset.agent;
    sec.classList.toggle('folded');
    if (sec.classList.contains('folded')) openSecs.delete(id); else openSecs.add(id);
    return;
  }
  const a = btn?.closest('section')?.dataset.agent;
  const act = btn?.dataset.act;
  if (act === 'addCustom') {
    e.preventDefault();
    syncForm();
    const pick = $('#customPreset').value;
    if (pick.startsWith('builtin:')) {
      const b = pick.slice(8);
      form.agents[b].enabled = true;
      openSecs.add(b);
      renderAgentSettings();
      checkCli(b);
      document.querySelector(`section[data-agent="${b}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      $('#setMsg').textContent = t('已加入 {name}，按「儲存」後生效', { name: LABEL[b] });
      await offerFrugal(b, LABEL[b]);
      return;
    }
    const { title, ...preset } = CUSTOM_PRESETS[pick] || CUSTOM_PRESETS.text;
    const id = newCustomId();
    form.agents[id] = { ...preset, name: t(preset.name), custom: true, enabled: true, delegate: true };
    openSecs.add(id);
    renderAgentSettings();
    checkCli(id);
    const sec = document.querySelector(`section[data-agent="${id}"]`);
    sec?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    sec?.querySelector('[data-k="name"]')?.select();
    $('#setMsg').textContent = t('已新增「{name}」，填好後按「儲存」', { name: t(preset.name) });
    await offerFrugal(id, t(preset.name));
    return;
  }
  if (a && act === 'delete') {
    e.preventDefault();
    syncForm();
    if (!await confirmBox(t('刪除自訂 Agent「{name}」？（按「儲存」後生效，對話記錄保留）', { name: form.agents[a].name || a }))) return;
    delete form.agents[a];
    renderAgentSettings();
    $('#setMsg').textContent = t('已刪除，按「儲存」後生效');
    return;
  }
  if (a && act) {
    e.preventDefault();
    syncForm();
    if (act === 'enable' || act === 'disable') {
      form.agents[a].enabled = act === 'enable';
      renderAgentSettings();
      if (act === 'enable') checkCli(a);
      $('#setMsg').textContent = t(act === 'enable' ? '已加入 {name}，按「儲存」後生效' : '已移除 {name}，按「儲存」後生效', { name: LABEL[a] });
      if (act === 'enable') await offerFrugal(a, LABEL[a]);
    } else if (act === 'check') checkCli(a, true);
    else if (act === 'install') {
      const it = conn[a]?.install;
      if (it && await confirmBox(t('會開一個 PowerShell 視窗執行 {label} 的官方安裝指令：\n\n{cmd}\n\n要繼續嗎？', { label: it.label, cmd: it.cmd }))) {
        await api.cliInstall(a, form.agents[a]);
        pollUntil(a, r => r.found);
      }
    } else if (act === 'login') {
      try { await api.cliLogin(a, form.agents[a]); }
      catch (err) { $('#setMsg').textContent = t('{name}：{error}', { name: LABEL[a], error: t(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) }); return; }
      pollUntil(a, r => r.found && r.loggedIn !== false);
    } else if (act === 'browse') {
      const p = await api.cliBrowse();
      if (p) {
        form.agents[a].cli = p;
        const input = btn.closest('section').querySelector('[data-k="cli"]');
        if (input) input.value = p;
        checkCli(a);
      }
    } else if (act === 'doc' && conn[a]?.install?.doc) api.openUrl(conn[a].install.doc);
    return;
  }
  const la = e.target.dataset?.load;
  if (la) {
    e.preventDefault();
    const b = e.target; b.disabled = true; b.textContent = t('讀取中…');
    const r = await api.listModels(la, readSettingsForm().agents[la]);
    b.disabled = false; b.textContent = t('讀取清單');
    // 重讀失敗就不留之前的清單（跟右欄的「重新讀取模型清單」一樣）
    if (r.models?.length) modelLists[la] = r; else delete modelLists[la];
    renderAgentSettings();
    $('#setMsg').textContent = r.error ? t('{name}：{error}', { name: LABEL[la], error: t(r.error) }) : t('{name}：{n} 個模型，點模型欄位可選', { name: LABEL[la], n: r.models.length + (r.more?.length || 0) });
    document.querySelector(`section[data-agent="${la}"] [data-k="model"]`)?.focus();
  }
};
// 改了 CLI 指令欄就重新偵測
$('#agentSettings').addEventListener('change', e => {
  const k = e.target.dataset?.k;
  const a = e.target.closest('section')?.dataset.agent;
  if (!a) return;
  if (k === 'cli') { syncForm(); checkCli(a); }
  if (k === 'name' || k === 'color') {
    syncForm();
    const h = e.target.closest('section').querySelector('h3 .badge');
    if (h) { h.style.background = safeColor(form.agents[a].color); h.textContent = (form.agents[a].name || '?').trim().charAt(0).toUpperCase(); }
  }
});
$('#pickCwd').onclick = async e => { e.preventDefault(); const p = await api.pickFolder($('#setCwd').value); if (p) $('#setCwd').value = p; };
$('#saveSettings').onclick = async () => {
  const prevLang = settings.uiLang;
  settings = await api.setSettings(readSettingsForm());
  if (settings.uiLang !== prevLang) { saveDraft(); location.reload(); return; }
  $('#settingsModal').classList.add('hidden');
  if (!settings.agents[agent]?.enabled) agent = 'claude';
  renderAgentStyles();
  renderPicker();
  updateComposer();
  renderAgentPanel();
};
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#settingsModal').classList.add('hidden'); });

function renderPicker() {
  const list = enabledAgents();
  $('#agentPicker').innerHTML = list.map((a, i) => `<button data-agent="${a}" title="${esc(LABEL[a])}${i < 9 ? `（Alt+${i + 1}）` : ''}">${esc(LABEL[a])}</button>`).join('');
  $('#agentPicker').classList.toggle('hidden', list.length < 2);
  for (const b of $('#agentPicker').children) b.classList.toggle('on', b.dataset.agent === agent);
}

// 設定頁「環境檢查」：主程序逐項檢查（main.js 的 envCheck），每項一行結果，有問題的多一行修法
async function runEnvCheck() {
  const b = $('#envCheck'), box = $('#envResult');
  b.disabled = true;
  box.innerHTML = `<div class="muted">${esc(t('檢查中…'))}</div>`;
  const rows = await api.envCheck(form ? readSettingsForm() : settings, current?.cwd).catch(e => [{ label: t('環境檢查'), ok: false, detail: String(e.message || e), fix: '' }]);
  b.disabled = false;
  box.innerHTML = rows.map(r => `<div class="env-row ${r.ok === true ? 'ok' : r.ok === false ? 'bad' : 'skip'}"><span class="env-mark">${r.ok === true ? '✓' : r.ok === false ? '✗' : '–'}</span>`
    + `<span class="env-label">${esc(r.label)}</span><span class="env-detail" title="${esc(r.detail)}">${esc(r.detail)}</span>${r.fix ? `<div class="env-fix">${esc(r.fix)}</div>` : ''}</div>`).join('');
}
$('#envCheck').onclick = e => { e.preventDefault(); runEnvCheck(); };

// 第一次使用（給別人用時）：Claude 沒裝或沒登入就直接帶到設定
async function firstRunCheck() {
  const r = await api.cliCheck('claude', settings.agents.claude);
  conn.claude = r;
  if (!r.found || !r.loggedIn) { openSettings(t(r.found ? 'Claude Code 還沒登入：按「登入」完成後即可開始對話。' : '找不到 Claude Code：按「安裝」，裝好後再按「登入」。')); runEnvCheck(); }
}

// ---------- 啟動 ----------
(async () => {
  settings = await api.getSettings();
  I18n.setLang(settings.uiLang);
  await loadModels('claude');
  translateDom(document.body);
  renderAgentStyles();
  renderPicker();
  agentStatus = await api.agentStatus();
  renderAgentPanel();
  await refreshList();
  if (firstConv()) await openConv(firstConv().id); else { loadDraft(); renderConv(); }
  firstRunCheck();
})();
