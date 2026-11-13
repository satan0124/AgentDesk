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
const PERMS = {
  claude: [['acceptEdits', '自動接受改檔（指令需另外允許）'], ['auto', 'auto：由分類器判斷'], ['bypassPermissions', '全部放行（不詢問）'], ['plan', '只規劃不動手']],
  codex: [['workspace-write', '可寫工作資料夾'], ['read-only', '唯讀'], ['danger-full-access', '完全存取（危險）']],
  cursor: [['force', '自動執行指令（--force）'], ['trust', '只信任資料夾，不自動跑指令'], ['ask', '唯讀問答（ask）'], ['plan', '只規劃（plan）']],
};

let settings, convList = [], current = null, agent = 'claude';
let pending = []; // 待送出的附件
const renderQueue = new Set();

marked.setOptions({ gfm: true, breaks: true });

// ---------- 工具 ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function md(text) { try { return marked.parse(text || ''); } catch { return `<pre>${esc(text)}</pre>`; } }
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }
function dayLabel(ts) {
  const d = new Date(ts), now = new Date();
  const start = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (start(now) - start(d)) / 86400000;
  if (diff === 0) return t('今天'); if (diff === 1) return t('昨天'); if (diff < 7) return t('過去 7 天'); if (diff < 30) return t('過去 30 天');
  return `${d.getFullYear()}/${d.getMonth() + 1}`;
}
function modelLine(a) {
  const c = settings.agents[a];
  return [c.model || t('預設模型'), c.effort ? t('強度 {effort}', { effort: c.effort }) : null].filter(Boolean).join(' · ');
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

function renderList() {
  const q = $('#search').value.trim().toLowerCase();
  const ul = $('#convList'); ul.innerHTML = '';
  for (const b of $('#viewToggle').children) b.classList.toggle('on', b.dataset.view === sideView);
  const match = c => !q || c.title.toLowerCase().includes(q) || t(c.title).toLowerCase().includes(q);
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
let menuConv = null;
function hideCtx() { $('#ctxMenu').classList.add('hidden'); menuConv = null; }
function showConvMenu(c, x, y) {
  const items = c.archived
    ? [['unarchive', '取消封存', 'A'], ['rename', '重新命名', 'R'], ['delete', '刪除', 'D']]
    : [[c.pinned ? 'unpin' : 'pin', c.pinned ? '取消釘選' : '釘選', 'P'], ['rename', '重新命名', 'R'], ['archive', '封存', 'A'], ['delete', '刪除', 'D']];
  const m = $('#ctxMenu');
  m.innerHTML = items.map(([act, label, key]) => `<button data-act="${act}" data-key="${key}"${act === 'delete' ? ' class="danger"' : ''}>${esc(t(label))}<kbd>${key}</kbd></button>`).join('');
  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 6)) + 'px';
  m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 6)) + 'px';
  menuConv = c;
}
async function convAction(act, c) {
  hideCtx();
  if (!c) return;
  if (act === 'pin' || act === 'unpin') await api.updateConv(c.id, { pinned: act === 'pin' });
  else if (act === 'archive' || act === 'unarchive') await api.updateConv(c.id, { archived: act === 'archive' });
  else if (act === 'rename') renameInList(c);
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
$('#ctxMenu').onclick = e => { const b = e.target.closest('button'); if (b) convAction(b.dataset.act, menuConv); };
document.addEventListener('mousedown', e => { if (!e.target.closest('#ctxMenu')) hideCtx(); }, true);
window.addEventListener('blur', hideCtx);
document.addEventListener('keydown', e => {
  if ($('#ctxMenu').classList.contains('hidden')) return;
  e.preventDefault(); e.stopPropagation();
  if (e.key === 'Escape') return hideCtx();
  const b = $(`#ctxMenu button[data-key="${e.key.toUpperCase()}"]`);
  if (b) convAction(b.dataset.act, menuConv);
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

async function newConvIn(cwd) {
  const c = await api.createConv(cwd || settings.defaultCwd);
  await openConv(c.id);
}
const newConv = () => newConvIn(current?.cwd);
const firstConv = () => convList.find(c => !c.archived) || convList[0];

function isRunning() { return current?.messages.some(m => m.role === 'assistant' && m.status === 'running'); }

function renderConv() {
  $('#convTitle').textContent = current ? t(current.title) : '';
  $('#cwdBtn').textContent = current ? current.cwd : '';
  // 還沒開始聊的對話，輸入框上方顯示資料夾選單
  $('#cwdPick').classList.toggle('hidden', !current || !!current.messages.length);
  $('#cwdPick .t').textContent = current ? baseName(current.cwd) : '';
  $('#cwdPickBtn').title = current ? current.cwd : '';
  $('#cwdBtn').title = current ? t('工作資料夾：{cwd}\n點擊更換', { cwd: current.cwd }) : '';
  const box = $('#messages'); box.innerHTML = '';
  for (const m of current?.messages || []) box.appendChild(renderMsg(m));
  $('#empty').classList.toggle('hidden', !!current?.messages.length);
  updateComposer();
  box.scrollTop = box.scrollHeight;
}

function renderMsg(m) {
  if (m.role === 'user') {
    const node = el(`<div class="msg user" data-id="${m.id}">${m.agent !== 'claude' ? `<div class="to-tag">→ ${LABEL[m.agent]}</div>` : ''}${m.attachments?.length ? `<div class="msg-atts">${m.attachments.map(attHtml).join('')}</div>` : ''}${m.text ? `<div class="bubble">${esc(m.text)}</div>` : ''}</div>`);
    node.querySelectorAll('.att[data-open]').forEach(x => x.onclick = () => api.openPath(x.dataset.open));
    return node;
  }
  const node = el(`<div class="msg assistant" data-id="${m.id}"></div>`);
  fillAssistant(node, m);
  return node;
}

function fillAssistant(node, m) {
  const open = new Set([...node.querySelectorAll('details[open]')].map(d => d.dataset.key));
  let html = `<div class="who"><span class="badge ${m.agent}">${INITIAL[m.agent]}</span>${LABEL[m.agent]}</div>`;
  html += renderParts(m.parts, m.id);
  if (m.status === 'running') html += `<div class="working"><span class="spinner"></span>${runningLabel(m)}</div>`;
  if (m.status === 'error' && m.error) html += `<div class="errbox">${esc(t(m.error))}</div>${reloginHtml(m.agent, m.error)}`;
  if (m.status === 'stopped') html += `<div class="stopped">■ ${esc(t(m.error || '已停止'))}</div>`;
  node.innerHTML = html;
  for (const d of node.querySelectorAll('details')) if (open.has(d.dataset.key)) d.open = true;
  // 執行中的委派預設展開
  for (const d of node.querySelectorAll('details.delegate[data-running]')) if (!open.has(d.dataset.key) && !d.dataset.seen) d.open = true;
  enhanceCode(node);
  fixImages(node);
}

function runningLabel(m) {
  const d = [...m.parts].reverse().find(p => p.kind === 'delegate' && p.status === 'running');
  if (d) return t('{name} 執行中…', { name: LABEL[d.agent] });
  return t('{name} 處理中…', { name: LABEL[m.agent] });
}

function renderParts(parts, key) {
  let html = '';
  parts.forEach((p, i) => {
    const k = `${key}-${i}`;
    if (p.kind === 'text') html += `<div class="part md">${md(p.text)}</div>`;
    else if (p.kind === 'thinking') {
      if (!p.text?.trim()) return;
      html += `<details class="part think" data-key="${k}"><summary><span>💭</span><span>${t('思考過程')}</span></summary><div class="tx">${esc(p.text.trim())}</div></details>`;
    } else if (p.kind === 'tool') {
      const icon = p.status === 'running' ? '●' : p.status === 'error' ? '✕' : '✓';
      html += `<details class="part tool" data-key="${k}"><summary><span class="st ${p.status}">${icon}</span><span class="nm">${esc(p.name)}</span><span class="dt">${esc(p.detail)}</span></summary>${p.output ? `<pre class="out">${esc(p.output)}</pre>` : ''}</details>`;
    } else if (p.kind === 'notice') html += `<div class="part notice">${esc(p.text)}</div>`;
    else if (p.kind === 'delegate') {
      const st = t({ running: '執行中…', done: '完成', error: '失敗', stopped: '已停止' }[p.status] || p.status);
      html += `<details class="part delegate ${p.agent}" data-key="${k}" ${p.status === 'running' ? 'data-running' : ''}>
        <summary><span class="badge ${p.agent}">${INITIAL[p.agent]}</span><b>${esc(t('交給 {name}', { name: LABEL[p.agent] }))}</b><span class="dstate ${p.status}">${st}</span></summary>
        <div class="dbody"><div class="dprompt">${esc(p.prompt)}</div>${renderParts(p.parts, k)}${p.error && p.status !== 'stopped' ? `<div class="errbox">${esc(t(p.error))}</div>${reloginHtml(p.agent, p.error)}` : ''}</div></details>`;
    }
  });
  return html;
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
  renderQueue.clear();
  updateComposer();
  if (stick) box.scrollTop = box.scrollHeight;
}

api.on('conv:changed', async list => {
  await refreshList(list);
  // 新開始的回合：重新取得這個對話（含新的訊息）
  if (current) {
    const fresh = await api.getConv(current.id);
    if (fresh && fresh.messages.length !== current.messages.length) { current = fresh; renderConv(); }
    else updateComposer();
  }
});
api.on('chat:error', ({ convId, error }) => { if (current?.id === convId) alert(t(error)); });

// ---------- 輸入 ----------
function updateComposer() {
  const run = isRunning();
  const btn = $('#sendBtn');
  btn.classList.toggle('stop', !!run);
  btn.textContent = run ? '■' : '↑';
  btn.title = run ? t('停止') : t('送出');
  btn.disabled = !run && !$('#input').value.trim() && !pending.length;
  for (const b of $('#agentPicker').children) b.classList.toggle('on', b.dataset.agent === agent);
  const helperNames = settings ? enabledAgents().filter(a => a !== 'claude' && settings.agents[a].delegate !== false).map(a => LABEL[a]) : [];
  $('#agentInfo').textContent = settings ? modelLine(agent) + (agent === 'claude' && settings.delegation && helperNames.length ? t(' · 可委派 {names}', { names: helperNames.join(' / ') }) : '') : '';
}

async function submit() {
  if (isRunning()) return api.stop(current.id);
  const text = $('#input').value.trim();
  if (!text && !pending.length) return;
  if (!current) { const c = await api.createConv(settings.defaultCwd); current = c; }
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
$('#messages').addEventListener('click', async e => {
  const b = e.target.closest('[data-relogin]');
  if (!b) return;
  const a = b.dataset.relogin;
  try { await api.cliLogin(a, settings.agents[a]); b.textContent = t('已開啟登入視窗，完成後回來重新送出。'); b.disabled = true; }
  catch (err) { alert(t(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))); }
});

// ---------- 圖片：本機路徑轉 file://，點擊放大 ----------
// Agent 寫的本機路徑（絕對、file://、相對於工作資料夾）→ Windows 絕對路徑；網址回 null
function localPath(raw) {
  raw = (raw || '').trim();
  if (!raw || raw.startsWith('#') || /^(https?|data|mailto|blob|about):/i.test(raw)) return null;
  let p = raw.replace(/^<|>$/g, '');
  try { p = decodeURI(p); } catch {}
  if (/^file:/i.test(p)) p = p.replace(/^file:\/+/i, '');
  p = p.replace(/[?#].*$/, '').replace(/:(\d+)(:\d+)?$/, '');   // 去掉 ?query、#anchor、:行號
  const abs = /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
  if (!abs) {
    if (!current?.cwd) return null;
    p = current.cwd.replace(/[\\/]+$/, '') + '\\' + p.replace(/^\.?[\\/]/, '');
  }
  return p.split('/').join('\\');
}
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i;

function fixImages(node) {
  for (const img of node.querySelectorAll('.md img')) {
    const p = localPath(img.getAttribute('src'));
    if (!p) continue;
    img.dataset.path = p;
    img.src = fileUrl(p);
  }
  for (const a of node.querySelectorAll('.md a[href]')) {
    const p = localPath(a.getAttribute('href'));
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
  if (IMG_EXT.test(p)) openLightboxPath(p);
  else api.openPath(p);
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
function renderAgentPanel() {
  const run = agentStatus.running;
  $('#panelCount').textContent = run.length ? t('{n} 個工作中', { n: run.length }) : '';
  $('#agentCards').innerHTML = enabledAgents().map(a => {
    const mine = run.filter(j => j.agent === a);
    const jobs = mine.map(j => `<div class="job" data-conv="${j.convId}" title="${esc(j.prompt)}">
        <div class="jt"><span class="role">${j.role === 'delegate' ? t('Claude 委派') : t('主對話')}</span><span class="t">${esc(t(j.convTitle))}</span><span class="tm">${elapsed(Date.now() - j.startedAt)}</span></div>
        <div class="act">${esc(t(j.activity))}</div></div>`).join('');
    return `<div class="acard ${mine.length ? 'busy' : ''}">
      <div class="acard-head"><span class="badge ${a}">${INITIAL[a]}</span><span class="nm">${LABEL[a]}</span>
        <span class="st ${mine.length ? 'busy' : ''}">${mine.length ? (mine.length > 1 ? t('工作中 ×{n}', { n: mine.length }) : t('工作中')) : t('閒置')}</span></div>
      ${settings ? `<div class="model">${esc(modelLine(a))}</div>` : ''}${jobs}</div>`;
  }).join('');
  const fin = agentStatus.finished;
  const icon = { done: '✓', error: '✕', stopped: '■' };
  $('#recentJobs').innerHTML = fin.length ? fin.map(j => `<li data-conv="${j.convId}" title="${esc(j.prompt)}">
      <span class="ic ${j.status}">${icon[j.status] || '·'}</span>
      <div class="body"><div class="l1"><b>${LABEL[j.agent]}</b><span class="t">${esc(t(j.convTitle))}</span></div>
      <div class="l2">${esc(t(j.activity))} · ${elapsed(j.endedAt - j.startedAt)} · ${ago(j.endedAt)}</div></div></li>`).join('')
    : `<li class="empty">${t('還沒有完成的工作')}</li>`;
}
for (const sel of ['#agentCards', '#recentJobs']) $(sel).addEventListener('click', e => {
  const id = e.target.closest('[data-conv]')?.dataset.conv;
  if (id && convList.some(c => c.id === id)) openConv(id);
});
api.on('agents:status', st => { agentStatus = st; renderAgentPanel(); });
const panelOn = () => !document.body.classList.contains('panel-off');
setInterval(() => { if (agentStatus.running.length && panelOn()) renderAgentPanel(); }, 1000);
setInterval(() => { if (panelOn()) renderAgentPanel(); }, 30000);
function setPanel(on) {
  document.body.classList.toggle('panel-off', !on);
  try { localStorage.setItem('agentPanel', on ? '1' : '0'); } catch {}
}
try { if (localStorage.getItem('agentPanel') === '0') document.body.classList.add('panel-off'); } catch {}
$('#togglePanel').onclick = () => setPanel(!panelOn());

// ---------- 頂列 ----------
$('#convTitle').ondblclick = () => {
  if (!current) return;
  const box = $('#convTitle'); box.contentEditable = 'true'; box.focus();
  document.getSelection().selectAllChildren(box);
  const done = async () => { box.contentEditable = 'false'; box.onblur = null; current.title = box.textContent.trim() || current.title; await api.updateConv(current.id, { title: current.title }); };
  box.onblur = done;
  box.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); box.blur(); } if (e.key === 'Escape') { box.textContent = t(current.title); box.blur(); } };
};
async function setCwd(p) {
  if (!current || !p) return;
  if (projKey(p) !== projKey(current.cwd)) { current = await api.updateConv(current.id, { cwd: p }); renderConv(); }
  $('#input').focus();
}
$('#cwdBtn').onclick = async () => current && setCwd(await api.pickFolder(current.cwd));

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
$('#openCwd').onclick = () => current && api.openPath(current.cwd);
$('#resetSessions').onclick = async () => {
  if (!current || !confirm(t('讓 Claude / Codex / Cursor 下一次都開新 session？\n畫面上的對話記錄會保留，並在下一次送出時當作參考帶給 Agent。'))) return;
  current = await api.updateConv(current.id, { resetSessions: true });
};
async function deleteConvById(id, title) {
  if (!confirm(t('刪除「{title}」？此動作無法復原。', { title: t(title) }))) return;
  await api.deleteConv(id);
  delete drafts[id];
  if (current?.id === id) { current = null; loadDraft(); }
  await refreshList();
  if (!current) { const next = firstConv(); if (next) openConv(next.id); else renderConv(); }
  else renderList();
}
$('#deleteConv').onclick = () => current && deleteConvById(current.id, current.title);

// ---------- 自訂 Agent ----------
const CUSTOM_PRESETS = {
  antigravity: {
    title: 'Antigravity CLI（agy，取代 Gemini CLI）', name: 'Antigravity', color: '#4f8ef7', cli: 'agy',
    args: '--output-format stream-json --input-format stream-json --dangerously-skip-permissions',
    promptMode: 'stream-json', promptFlag: '', format: 'antigravity', modelFlag: '--model', resumeFlag: '--conversation',
    versionArgs: '--version', statusArgs: '', loginArgs: '*', installCmd: 'irm https://antigravity.google/cli/install.ps1 | iex',
    doc: 'https://antigravity.google/docs/cli/headless', description: 'Google Antigravity CLI (Gemini)',
  },
  gemini: {
    title: 'Gemini CLI', name: 'Gemini', color: '#4f8ef7', cli: 'gemini', args: '--output-format stream-json --yolo',
    promptMode: 'stdin', promptFlag: '', format: 'gemini', modelFlag: '-m', resumeFlag: '',
    versionArgs: '--version', statusArgs: '', loginArgs: '', installCmd: 'npm install -g @google/gemini-cli',
    doc: 'https://geminicli.com/docs/cli/headless', description: 'Google Gemini CLI',
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
const FORMATS = [['text', '純文字：stdout 直接當回覆（任何 CLI 都能用）'], ['claude', 'Claude 相容 stream-json（看得到工具與即時串流）'], ['antigravity', 'Antigravity CLI stream-json（agy）'], ['gemini', 'Gemini CLI stream-json']];
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
  const opt = (list, cur) => list.map(([val, t]) => `<option value="${val}" ${cur === val ? 'selected' : ''}>${t}</option>`).join('');
  return `<section class="set-group custom" data-agent="${a}">
    <h3><span class="badge" style="background:${safeColor(c.color)}">${esc((c.name || '?').trim().charAt(0).toUpperCase())}</span>${esc(c.name || t('自訂 Agent'))}<span class="muted">${t('自訂')}</span><span class="spacer"></span>
      <button class="btn subtle" data-act="delete">${t('刪除')}</button></h3>
    <div class="conn-wrap" data-conn="${a}">${connHtml(a)}</div>
    <label class="row"><span>${t('名稱／顏色')}</span><div class="inline"><input data-k="name" value="${v('name')}" placeholder="${t('顯示名稱')}"><input data-k="color" type="color" value="${safeColor(c.color)}" class="color"></div></label>
    <label class="row"><span>${t('CLI 指令')}</span><input data-k="cli" value="${v('cli')}" placeholder="${t('例如 gemini，或完整路徑')}"></label>
    <label class="row"><span>${t('額外參數')}</span><input data-k="args" value="${v('args')}" placeholder="${t('例如 --output-format stream-json --yolo')}"></label>
    <div class="hint">${t('以空白分隔，含空白的參數用雙引號包起來；<code>{cwd}</code> 會換成對話的工作資料夾。')}</div>
    <label class="row"><span>${t('Prompt 傳入')}</span><div class="inline">
      <select data-k="promptMode">${opt(trOpts([['stdin', '從 stdin 傳入'], ['arg', '接在參數最後'], ['stream-json', '一行 JSON 從 stdin 傳入（agy）']]), c.promptMode)}</select>
      <input data-k="promptFlag" value="${v('promptFlag')}" placeholder="${t('前面加的旗標，例如 -p（可空）')}"></div></label>
    <label class="row"><span>${t('輸出格式')}</span><select data-k="format">${opt(trOpts(FORMATS), c.format)}</select></label>
    <label class="row"><span>${t('預設模型')}</span><div class="inline"><input data-k="model" value="${v('model')}" placeholder="${t('留空＝CLI 預設')}"><input data-k="modelFlag" value="${v('modelFlag')}" placeholder="${t('模型旗標，例如 -m')}" class="narrow"></div></label>
    <label class="row"><span>${t('接續 session 旗標')}</span><input data-k="resumeFlag" value="${v('resumeFlag')}" placeholder="${t('例如 --resume；留空＝每次重開，自動附上對話記錄')}"></label>
    <label class="row"><span>${t('給 Claude 的說明')}</span><input data-k="description" value="${v('description')}" placeholder="${t('它擅長什麼，Claude 決定要不要委派時參考')}"></label>
    <label class="row check"><input type="checkbox" data-k="delegate" ${c.delegate !== false ? 'checked' : ''}><span>${t('讓 Claude 可以委派工作給它')}</span></label>
    <details class="adv"><summary>${t('進階：偵測、安裝、登入')}</summary>
      <label class="row"><span>${t('版本參數')}</span><input data-k="versionArgs" value="${v('versionArgs')}" placeholder="--version"></label>
      <label class="row"><span>${t('登入狀態參數')}</span><input data-k="statusArgs" value="${v('statusArgs')}" placeholder="${t('例如 auth status（可空）')}"></label>
      <label class="row"><span>${t('登入參數')}</span><input data-k="loginArgs" value="${v('loginArgs')}" placeholder="${t('例如 login；填 * 代表直接開啟互動模式登入')}"></label>
      <label class="row"><span>${t('安裝指令')}</span><input data-k="installCmd" value="${v('installCmd')}" placeholder="${t('PowerShell 指令，例如 npm install -g …')}"></label>
      <label class="row"><span>${t('說明網址')}</span><input data-k="doc" value="${v('doc')}" placeholder="https://…"></label>
    </details>
  </section>`;
}

function addCustomHtml() {
  return `<div class="add-custom">
    <span class="muted">${t('新增其他 CLI Agent：')}</span>
    <select id="customPreset">${Object.entries(CUSTOM_PRESETS).map(([k, p]) => `<option value="${k}">${t(p.title)}</option>`).join('')}</select>
    <button class="btn primary" data-act="addCustom">${t('＋ 新增自訂 Agent')}</button>
  </div>`;
}

function newCustomId() {
  let id;
  do { id = 'x' + Math.random().toString(16).slice(2, 7); } while (form.agents[id]);
  return id;
}

// ---------- 設定 ----------
const allAgents = () => Object.keys(settings?.agents || {});
const DESC_ZH = {
  claude: 'Anthropic Claude Code，主要對話。',
  codex: 'OpenAI Codex CLI：可直接對話，或讓 Claude 委派工作。',
  cursor: 'Cursor Agent CLI：可直接對話，或讓 Claude 委派工作。',
};
const enabledAgents = () => allAgents().filter(a => settings?.agents[a]?.enabled);
const DESC = new Proxy(DESC_ZH, { get: (o, k) => t(o[k]) });
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
  if (!c.enabled) {
    return `<section class="set-group off" data-agent="${a}">
      <h3><span class="badge ${a}">${INITIAL[a]}</span>${LABEL[a]}<span class="muted">${t('未加入')}</span><span class="spacer"></span>
        <button class="btn primary" data-act="enable">${t('＋ 加入')}</button></h3>
      <div class="muted">${DESC[a]}</div></section>`;
  }
  const effort = [`<option value="">${t('預設（CLI 自己決定）')}</option>`, ...EFFORTS[a].map(e => `<option ${c.effort === e ? 'selected' : ''}>${e}</option>`)].join('');
  const permKey = a === 'codex' ? 'sandbox' : 'permission';
  const perms = PERMS[a].map(([v, label]) => `<option value="${v}" ${c[permKey] === v ? 'selected' : ''}>${t(label)}</option>`).join('');
  return `<section class="set-group" data-agent="${a}">
    <h3><span class="badge ${a}">${INITIAL[a]}</span>${LABEL[a]}${a === 'claude' ? `<span class="muted">${t('（主要對話，不能移除）')}</span>` : ''}<span class="spacer"></span>
      ${a === 'claude' ? '' : `<button class="btn subtle" data-act="disable">${t('移除')}</button>`}</h3>
    <div class="conn-wrap" data-conn="${a}">${connHtml(a)}</div>
    <label class="row"><span>${t('CLI 指令')}</span><input data-k="cli" value="${esc(c.cli)}" placeholder="${a === 'cursor' ? 'agent' : a}"></label>
    <label class="row"><span>${t('預設模型')}</span><div class="inline"><input data-k="model" list="models-${a}" value="${esc(c.model)}" placeholder="${t('留空＝CLI 預設')}"><button class="btn" data-load="${a}">${t('讀取清單')}</button></div></label>
    <datalist id="models-${a}"></datalist>
    <label class="row"><span>${t('強度')}</span><select data-k="effort">${effort}</select></label>
    ${a === 'cursor' ? `<div class="hint">${t('Cursor 的強度會組成 模型[effort=…]；模型 id 本身已含強度（例如 -high）時不另外加。')}</div>` : ''}
    <label class="row"><span>${a === 'codex' ? t('沙箱') : t('權限')}</span><select data-k="${permKey}">${perms}</select></label>
  </section>`;
}

function syncForm() {
  if (!form) return;
  form.language = $('#setLang').value;
  form.defaultCwd = $('#setCwd').value.trim() || form.defaultCwd;
  form.delegation = $('#setDelegation').checked;
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
  renderAgentSettings();
  $('#setMsg').textContent = note || '';
  $('#settingsModal').classList.remove('hidden');
  for (const a of Object.keys(form.agents)) if (form.agents[a].enabled) checkCli(a);
}
function readSettingsForm() { syncForm(); return JSON.parse(JSON.stringify(form)); }

$('#openSettings').onclick = () => openSettings();
$('#settingsModal').onclick = async e => {
  if (e.target === $('#settingsModal') || e.target.closest('[data-close]')) return $('#settingsModal').classList.add('hidden');
  const btn = e.target.closest('button');
  const a = btn?.closest('section')?.dataset.agent;
  const act = btn?.dataset.act;
  if (act === 'addCustom') {
    e.preventDefault();
    syncForm();
    const { title, ...preset } = CUSTOM_PRESETS[$('#customPreset').value] || CUSTOM_PRESETS.text;
    const id = newCustomId();
    form.agents[id] = { ...preset, name: t(preset.name), custom: true, enabled: true, delegate: true };
    renderAgentSettings();
    checkCli(id);
    const sec = document.querySelector(`section[data-agent="${id}"]`);
    sec?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    sec?.querySelector('[data-k="name"]')?.select();
    $('#setMsg').textContent = t('已新增「{name}」，填好後按「儲存」', { name: t(preset.name) });
    return;
  }
  if (a && act === 'delete') {
    e.preventDefault();
    syncForm();
    if (!confirm(t('刪除自訂 Agent「{name}」？（按「儲存」後生效，對話記錄保留）', { name: form.agents[a].name || a }))) return;
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
    } else if (act === 'check') checkCli(a, true);
    else if (act === 'install') {
      const it = conn[a]?.install;
      if (it && confirm(t('會開一個 PowerShell 視窗執行 {label} 的官方安裝指令：\n\n{cmd}\n\n要繼續嗎？', { label: it.label, cmd: it.cmd }))) {
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
    $(`#models-${la}`).innerHTML = r.models.map(m => `<option value="${esc(m)}">`).join('');
    $('#setMsg').textContent = r.error ? t('{name}：{error}', { name: LABEL[la], error: t(r.error) }) : t('{name}：{n} 個模型，點模型欄位可選', { name: LABEL[la], n: r.models.length });
    b.closest('.inline').querySelector('input').focus();
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

// 第一次使用（給別人用時）：Claude 沒裝或沒登入就直接帶到設定
async function firstRunCheck() {
  const r = await api.cliCheck('claude', settings.agents.claude);
  conn.claude = r;
  if (!r.found || !r.loggedIn) openSettings(t(r.found ? 'Claude Code 還沒登入：按「登入」完成後即可開始對話。' : '找不到 Claude Code：按「安裝」，裝好後再按「登入」。'));
}

// ---------- 啟動 ----------
(async () => {
  settings = await api.getSettings();
  I18n.setLang(settings.uiLang);
  translateDom(document.body);
  renderAgentStyles();
  renderPicker();
  agentStatus = await api.agentStatus();
  renderAgentPanel();
  await refreshList();
  if (firstConv()) await openConv(firstConv().id); else { loadDraft(); renderConv(); }
  firstRunCheck();
})();
