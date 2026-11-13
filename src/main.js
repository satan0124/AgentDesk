const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { runAgent, listModels, labelOf: labelOfCfg } = require('./agents');
const { clearCache } = require('./cli');
const connect = require('./connect');
const i18n = require('./shared/i18n');
const tr = i18n.t;
const { applyEvent } = require('./shared/reduce');

if (process.env.AGENTDESK_DATA) app.setPath('userData', process.env.AGENTDESK_DATA);
const DATA = app.getPath('userData');
const CONV_DIR = path.join(DATA, 'conversations');
const MCP_DIR = path.join(DATA, 'mcp');
fs.mkdirSync(path.join(DATA, 'attachments'), { recursive: true });
// 轉成長路徑：Claude 的 --add-dir 對 8.3 短路徑（SATAN0~1）比對不到
const ATT_DIR = fs.realpathSync.native(path.join(DATA, 'attachments'));
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const BRIDGE = path.join(DATA, 'mcp-bridge.js');
fs.mkdirSync(CONV_DIR, { recursive: true });
fs.mkdirSync(MCP_DIR, { recursive: true });

const DEFAULT_SETTINGS = {
  language: 'auto',            // auto：繁中系統用繁中，其他用英文
  defaultCwd: os.homedir(),
  delegation: true,
  agents: {
    claude: { enabled: true, cli: 'claude', model: '', effort: '', permission: 'acceptEdits' },
    // 新安裝只開 Claude；Codex、Cursor 由使用者在設定裡加入
    codex: { enabled: false, cli: 'codex', model: '', effort: '', sandbox: 'workspace-write' },
    cursor: { enabled: false, cli: 'agent', model: '', effort: '', permission: 'force' },
  },
};

let win;
let settings = loadSettings();
const convs = new Map();      // id -> conversation（已載入的）
const running = new Map();    // convId -> { msg, stops:Set, conv }
const token = crypto.randomBytes(16).toString('hex');
let port = 0;

// ---------- 設定 ----------
function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    // 舊版設定沒有 enabled：當時三個都在用，保持啟用；自訂 Agent（custom: true）照原樣接在後面
    const builtin = Object.entries(DEFAULT_SETTINGS.agents)
      .map(([k, v]) => [k, { ...v, ...(s.agents?.[k] ? { enabled: true } : {}), ...(s.agents?.[k] || {}) }]);
    const custom = Object.entries(s.agents || {}).filter(([k, v]) => v?.custom && !DEFAULT_SETTINGS.agents[k]);
    return { ...DEFAULT_SETTINGS, ...s, agents: Object.fromEntries([...builtin, ...custom]) };
  } catch { return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); }
}
function saveSettings() { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); }
function systemLangs() {
  try { const l = app.getPreferredSystemLanguages(); if (l?.length) return l; } catch {}
  try { return [app.getLocale()]; } catch { return []; }
}
function applyLang() { i18n.setLang(i18n.pickLang(settings.language, systemLangs())); }
const publicSettings = () => ({ ...settings, uiLang: i18n.getLang() });

// ---------- 對話儲存 ----------
const convFile = id => path.join(CONV_DIR, `${id}.json`);
function getConv(id) {
  if (convs.has(id)) return convs.get(id);
  try { const c = JSON.parse(fs.readFileSync(convFile(id), 'utf8')); convs.set(id, c); return c; } catch { return null; }
}
function saveConv(c, touch = true) { if (touch) c.updated = Date.now(); fs.writeFileSync(convFile(c.id), JSON.stringify(c)); }
const saveTimers = new Map();
function saveSoon(c) {
  if (saveTimers.has(c.id)) return;
  saveTimers.set(c.id, setTimeout(() => { saveTimers.delete(c.id); saveConv(c); }, 2000));
}
function listConvs() {
  const out = [];
  for (const f of fs.readdirSync(CONV_DIR)) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -5);
    const c = convs.get(id) || (() => { try { return JSON.parse(fs.readFileSync(path.join(CONV_DIR, f), 'utf8')); } catch { return null; } })();
    if (c) out.push({ id: c.id, title: c.title, updated: c.updated, cwd: c.cwd, running: running.has(c.id) });
  }
  return out.sort((a, b) => b.updated - a.updated);
}
function newConv(cwd) {
  const c = { id: Date.now().toString(36) + crypto.randomBytes(3).toString('hex'), title: '新對話',
    cwd: cwd || settings.defaultCwd, created: Date.now(), updated: Date.now(), sessions: {}, messages: [] };
  convs.set(c.id, c); saveConv(c);
  return c;
}

// ---------- 給 Agent 的上下文 ----------
// Agent 只記得自己的 session；這裡補上它沒看過的、使用者與其他 Agent 的往來。
function clip(s, n) { s = s || ''; return s.length > n ? s.slice(0, n) + tr('…（略）') : s; }
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
function attachText(atts) {
  if (!atts?.length) return '';
  const kind = { image: tr('圖片'), file: tr('檔案'), folder: tr('資料夾') };
  return '\n\n' + tr('[使用者附上的檔案，請直接讀取]') + '\n' + atts.map(a => `- ${tr('{name}：{text}', { name: kind[a.kind], text: a.path })}`).join('\n');
}
function msgText(m) {
  if (m.role === 'user') return (m.text || '') + attachText(m.attachments);
  return (m.parts || []).filter(p => p.kind === 'text').map(p => p.text).join('\n\n');
}
function buildPrompt(conv, agent, text, history) {
  const hasSession = !!conv.sessions[agent];
  let start = 0;
  if (hasSession) {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'assistant' && history[i].agent === agent) { start = i + 1; break; }
    }
  }
  const lines = [];
  for (const m of history.slice(start)) {
    if (hasSession && m.agent === agent) continue;
    const t = clip(msgText(m), 4000);
    if (!t) continue;
    lines.push(tr(m.role === 'user' ? '使用者 → {name}：{text}' : '{name}：{text}', { name: labelOf(m.agent), text: t }));
  }
  if (!lines.length) return text;
  const head = tr(hasSession ? '[你上次回覆之後，使用者在同一個對話裡和其他 Agent 的往來，供參考]'
    : '[這個對話先前的內容，供參考]');
  return `${head}\n${clip(lines.join('\n\n'), 24000)}\n${tr('[以上]')}\n\n${text}`;
}

const labelOf = agent => labelOfCfg(agent, settings.agents[agent]);
// 可以讓 Claude 委派的 Agent：已加入、不是 Claude、沒有關掉「可委派」
const helpers = () => Object.keys(settings.agents)
  .filter(a => a !== 'claude' && settings.agents[a]?.enabled && settings.agents[a]?.delegate !== false);
const HELPER_DESC = { codex: 'OpenAI Codex CLI', cursor: 'Cursor Agent CLI' };
const claudeSystem = list => i18n.getLang() === 'en' ? `You are the main agent inside the AgentDesk desktop app. Besides your own tools, you can hand work to other agents through MCP tools:
${list.map(a => `- mcp__agents__ask_${a}: ${labelOf(a)}${settings.agents[a].description ? ` (${settings.agents[a].description})` : HELPER_DESC[a] && labelOf(a) !== HELPER_DESC[a] ? ` (${HELPER_DESC[a]})` : ''}`).join('\n')}
They run in the same working folder and cannot see this conversation, so every prompt you give them must be self-contained (goal, files, constraints, definition of done).
Delegate only when the user names an agent, asks for a second opinion or cross-check, or the work clearly splits into parallel parts; answer ordinary questions yourself.
After delegating, read their replies and check the results before reporting back; do not paste their output verbatim.` : `你在 AgentDesk 桌面程式裡擔任主 Agent。除了自己的工具，你還能用 MCP 工具把工作交給其他 Agent：
${list.map(a => `- mcp__agents__ask_${a}：${labelOf(a)}${settings.agents[a].description ? `（${settings.agents[a].description}）` : HELPER_DESC[a] && labelOf(a) !== HELPER_DESC[a] ? `（${HELPER_DESC[a]}）` : ''}`).join('\n')}
它們在同一個工作資料夾執行、看不到這段對話，所以給它們的 prompt 要自含（目標、檔案、限制、完成標準）。
使用者點名要哪個 Agent 做、要求第二意見或交叉檢查，或工作明顯適合平行分工時才委派；一般問題自己回答。
委派後要讀它們的回覆，檢查結果再回報使用者，不要原封不動轉貼。`;

function mcpConfigFor(convId) {
  const file = path.join(MCP_DIR, `${convId}.json`);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { agents: {
    type: 'stdio', command: process.execPath, args: [BRIDGE],
    env: { ELECTRON_RUN_AS_NODE: '1', AGENTDESK_PORT: String(port), AGENTDESK_TOKEN: token, AGENTDESK_CONV: convId,
      AGENTDESK_HELPERS: JSON.stringify(helpers().map(id => ({ id, name: labelOf(id) }))) },
  } } }, null, 2));
  return file;
}

// ---------- Agent 工作狀況（右欄） ----------
const jobs = new Map();          // jobId -> job
const finished = [];             // 最近完成，新的在前
let jobsTimer = null;
function publishJobs() {
  if (jobsTimer) return;
  jobsTimer = setTimeout(() => {
    jobsTimer = null;
    send('agents:status', { running: [...jobs.values()], finished: finished.slice(0, 12) });
  }, 200);
}
function startJob(agent, conv, role, prompt) {
  const job = { id: crypto.randomUUID(), agent, convId: conv.id, convTitle: conv.title, role,
    prompt: (prompt || '').replace(/\s+/g, ' ').slice(0, 120), startedAt: Date.now(), activity: tr('啟動中…'), tools: 0 };
  jobs.set(job.id, job); publishJobs();
  return job;
}
function trackEvent(job, ev) {
  if (ev.type === 'tool') {
    if (ev.status === 'running') { job.activity = `${ev.name} ${ev.detail || ''}`.trim(); job.tools++; }
    else job.activity = tr('思考中…');
  } else if (ev.type === 'text') job.activity = tr('回覆中…');
  else if (ev.type === 'thinking') job.activity = tr('思考中…');
  else if (ev.type === 'delegate_start') job.activity = tr('等待 {name} 完成', { name: labelOf(ev.agent) });
  else if (ev.type === 'delegate_end') job.activity = tr('思考中…');
  else return;
  publishJobs();
}
function endJob(job, error) {
  jobs.delete(job.id);
  finished.unshift({ ...job, endedAt: Date.now(), status: error ? (error === '已停止' ? 'stopped' : 'error') : 'done',
    activity: error ? String(error).split('\n')[0].slice(0, 120) : job.tools ? tr('完成（{n} 個工具）', { n: job.tools }) : tr('完成') });
  finished.length = Math.min(finished.length, 30);
  publishJobs();
}

// ---------- 執行一輪 ----------
function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }

function emitTo(conv, msg, ev) {
  if (process.env.AGENTDESK_SELFTEST && ev.type !== 'text' && ev.type !== 'thinking') console.log('[ev]', JSON.stringify(ev).slice(0, 200));
  applyEvent(msg, ev);
  send('chat:event', { convId: conv.id, msgId: msg.id, ev });
  saveSoon(conv);
}

// 附件先放 _inbox，送出時搬到該對話的資料夾（刪對話時一起刪）
function addAttachments(items) {
  const inbox = path.join(ATT_DIR, '_inbox');
  fs.mkdirSync(inbox, { recursive: true });
  const out = [];
  for (const it of items) {
    if (it.path) {
      let st; try { st = fs.statSync(it.path); } catch { continue; }
      if (st.isDirectory()) { out.push({ kind: 'folder', name: path.basename(it.path) || it.path, path: it.path }); continue; }
      const dest = path.join(inbox, `${crypto.randomBytes(3).toString('hex')}-${path.basename(it.path)}`);
      fs.copyFileSync(it.path, dest);
      out.push({ kind: IMAGE_EXT.test(dest) ? 'image' : 'file', name: path.basename(it.path), path: dest, size: st.size });
    } else if (it.data) {
      const name = (it.name || 'pasted.png').replace(/[\\/:*?"<>|]/g, '_');
      const dest = path.join(inbox, `${crypto.randomBytes(3).toString('hex')}-${name}`);
      fs.writeFileSync(dest, Buffer.from(it.data));
      out.push({ kind: IMAGE_EXT.test(dest) ? 'image' : 'file', name, path: dest, size: it.data.byteLength });
    }
  }
  return out;
}
function claimAttachments(convId, atts) {
  const dir = path.join(ATT_DIR, convId);
  return (atts || []).map(a => {
    if (a.kind === 'folder' || path.dirname(a.path) !== path.join(ATT_DIR, '_inbox')) return a;
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, path.basename(a.path));
    try { fs.renameSync(a.path, dest); return { ...a, path: dest }; } catch { return a; }
  }).filter(a => fs.existsSync(a.path));
}

async function startTurn(convId, agent, text, attachments = []) {
  const conv = getConv(convId);
  if (!conv) throw new Error(tr('找不到對話'));
  if (running.has(convId)) throw new Error(tr('這個對話還在執行中'));
  if (!fs.existsSync(conv.cwd)) throw new Error(tr('工作資料夾不存在：{cwd}', { cwd: conv.cwd }));
  if (!settings.agents[agent]?.enabled) throw new Error(tr('{name} 還沒加入，請到設定加入', { name: labelOf(agent) }));
  const history = conv.messages.slice();
  const atts = claimAttachments(convId, attachments);
  const user = { id: crypto.randomUUID(), role: 'user', agent, text, attachments: atts, ts: Date.now() };
  const msg = { id: crypto.randomUUID(), role: 'assistant', agent, parts: [], status: 'running', ts: Date.now() };
  if (conv.title === '新對話') {
    const t = text.replace(/\s+/g, ' ').trim();
    conv.title = (t.length > 40 ? t.slice(0, 40) + '…' : t) || '新對話';
  }
  conv.messages.push(user, msg);
  saveConv(conv);
  const ctx = { conv, msg, stops: new Set() };
  running.set(convId, ctx);
  send('conv:changed', listConvs());

  const cfg = settings.agents[agent];
  const job = startJob(agent, conv, 'main', text || tr('（附件）'));
  ctx.job = job;
  const prompt = buildPrompt(conv, agent, (text || tr('請看附件。')) + attachText(atts), history);
  const opts = { prompt, cwd: conv.cwd, sessionId: conv.sessions[agent],
    images: atts.filter(a => a.kind === 'image').map(a => a.path),
    addDirs: [...new Set(atts.map(a => a.kind === 'folder' ? a.path : path.dirname(a.path)))],
    onEvent: ev => {
    if (ev.type === 'session') { if (ev.id) conv.sessions[agent] = ev.id; return; }
    trackEvent(job, ev);
    emitTo(conv, msg, ev);
  } };
  if (agent === 'claude') {
    const canDelegate = settings.delegation && helpers().length > 0;
    if (canDelegate) {
      opts.systemPrompt = claudeSystem(helpers());
      opts.mcpConfig = mcpConfigFor(convId);
      opts.allowedTools = helpers().map(a => `mcp__agents__ask_${a}`);
    }
    opts.env = { MCP_TOOL_TIMEOUT: '7200000', MCP_TIMEOUT: '30000' };
  }
  const run = runAgent(agent, cfg, opts);
  ctx.stops.add(run.stop);
  const r = await run.promise;
  // session 失效（例如 CLI 端被刪）：清掉，下一次重開並帶上下文
  if (r.error && /session|thread|chat/i.test(r.error) && /not found|no conversation|找不到|invalid/i.test(r.error)) delete conv.sessions[agent];
  if (r.text && !msg.parts.some(p => p.kind === 'text')) emitTo(conv, msg, { type: 'text', text: r.text });
  emitTo(conv, msg, { type: 'status', status: r.error ? (r.error === '已停止' ? 'stopped' : 'error') : 'done', error: r.error,
    meta: { cost: r.cost, usage: r.usage } });
  endJob(job, r.error);
  running.delete(convId);
  clearTimeout(saveTimers.get(convId)); saveTimers.delete(convId);
  saveConv(conv);
  send('conv:changed', listConvs());
}

// Claude 經 MCP 委派過來
async function delegate({ conv: convId, agent, prompt, newSession }) {
  const ctx = running.get(convId);
  if (!ctx) return { error: tr('這個對話目前沒有在執行的 Claude 回合') };
  if (!settings.agents[agent]?.enabled || agent === 'claude') return { error: tr('{name} 沒有加入 AgentDesk', { name: labelOf(agent) }) };
  const { conv, msg } = ctx;
  const id = crypto.randomUUID();
  emitTo(conv, msg, { type: 'delegate_start', id, agent, prompt });
  if (ctx.job) trackEvent(ctx.job, { type: 'delegate_start', agent });
  const job = startJob(agent, conv, 'delegate', prompt);
  if (newSession) delete conv.sessions[agent];
  const run = runAgent(agent, settings.agents[agent], { prompt, cwd: conv.cwd, sessionId: conv.sessions[agent], onEvent: ev => {
    if (ev.type === 'session') { if (ev.id) conv.sessions[agent] = ev.id; return; }
    trackEvent(job, ev);
    emitTo(conv, msg, { ...ev, del: id });
  } });
  ctx.stops.add(run.stop);
  const r = await run.promise;
  ctx.stops.delete(run.stop);
  emitTo(conv, msg, { type: 'delegate_end', id, error: r.error });
  endJob(job, r.error);
  if (ctx.job && ![...jobs.values()].some(j => j.convId === convId && j.role === 'delegate')) trackEvent(ctx.job, { type: 'delegate_end' });
  return r;
}

function startServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/delegate') { res.writeHead(404); return res.end(); }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', d => body += d);
      req.on('end', async () => {
        let data; try { data = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
        if (data.token !== token) { res.writeHead(403); return res.end(); }
        const r = await delegate(data).catch(e => ({ error: e.message }));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: r.text, error: r.error }));
      });
    });
    server.requestTimeout = 0;
    server.headersTimeout = 0;
    server.timeout = 0;
    server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
  });
}

// ---------- IPC ----------
ipcMain.handle('conv:list', () => listConvs());
ipcMain.handle('conv:get', (_, id) => getConv(id));
ipcMain.handle('conv:create', (_, cwd) => { const c = newConv(cwd); send('conv:changed', listConvs()); return c; });
ipcMain.handle('conv:delete', (_, id) => {
  if (running.has(id)) for (const s of running.get(id).stops) s();
  convs.delete(id);
  try { fs.unlinkSync(convFile(id)); } catch {}
  try { fs.unlinkSync(path.join(MCP_DIR, `${id}.json`)); } catch {}
  try { fs.rmSync(path.join(ATT_DIR, id), { recursive: true, force: true }); } catch {}
  send('conv:changed', listConvs());
});
ipcMain.handle('conv:update', (_, id, patch) => {
  const c = getConv(id); if (!c) return;
  if (typeof patch.title === 'string') {
    c.title = patch.title.trim() || c.title;
    for (const j of jobs.values()) if (j.convId === id) j.convTitle = c.title;
    publishJobs();
  }
  if (typeof patch.cwd === 'string') c.cwd = patch.cwd;
  if (patch.resetSessions) c.sessions = {};
  saveConv(c); send('conv:changed', listConvs());
  return c;
});
ipcMain.handle('att:add', (_, items) => addAttachments(items || []));
ipcMain.handle('chat:send', (_, convId, agent, text, atts) => {
  startTurn(convId, agent, text, atts).catch(err => send('chat:error', { convId, error: err.message }));
});
ipcMain.handle('chat:stop', (_, convId) => { const ctx = running.get(convId); if (ctx) for (const s of ctx.stops) s(); });
ipcMain.handle('settings:get', () => publicSettings());
ipcMain.handle('settings:set', (_, s) => { delete s.uiLang; settings = s; saveSettings(); clearCache(); applyLang(); return publicSettings(); });
ipcMain.handle('models:list', (_, agent, cfg) => { clearCache(); return listModels(agent, cfg || settings.agents[agent]); });
ipcMain.handle('dialog:files', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
  return r.canceled ? [] : addAttachments(r.filePaths.map(p => ({ path: p })));
});
ipcMain.handle('dialog:folder', async (_, current) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: current });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('open:path', (_, p) => (p && fs.existsSync(p) ? shell.openPath(p) : 'not found'));
ipcMain.handle('open:url', (_, u) => { if (/^https:\/\//.test(u)) shell.openExternal(u); });
ipcMain.handle('cli:check', (_, agent, cfg, force) => connect.check(agent, cfg, force));
ipcMain.handle('cli:install', (_, agent, cfg) => connect.install(agent, cfg));
ipcMain.handle('cli:login', (_, agent, cfg) => connect.login(agent, cfg));
ipcMain.handle('cli:browse', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'],
    filters: [{ name: tr('執行檔'), extensions: ['exe', 'cmd', 'bat', 'js'] }, { name: tr('全部'), extensions: ['*'] }] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('open:reveal', (_, p) => shell.showItemInFolder(p));
ipcMain.handle('agents:status', () => ({ running: [...jobs.values()], finished: finished.slice(0, 12) }));

// ---------- 視窗 ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 760, minHeight: 500,
    backgroundColor: '#1b1b1d', autoHideMenuBar: true, title: 'AgentDesk',
    icon: path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // 主視窗只顯示 index.html：任何跳頁都攔下（網址開瀏覽器、本機檔案用系統程式開），避免整個視窗被換成別的檔案回不來
  const openOutside = url => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    else if (/^file:/i.test(url)) {
      // 檔案不存在就不開：shell.openPath 會跳出 Windows 錯誤對話框，還會讓程式關不掉
      try { const p = require('url').fileURLToPath(url); if (fs.existsSync(p)) shell.openPath(p); } catch {}
    }
  };
  win.webContents.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.split('#')[0] === win.webContents.getURL().split('#')[0]) return;
    e.preventDefault();
    openOutside(url);
  });
}

app.setAppUserModelId('AgentDesk');
app.whenReady().then(async () => {
  applyLang();
  fs.copyFileSync(path.join(__dirname, 'mcp-bridge.js'), BRIDGE);
  // 上次異常關閉而停在「執行中」的訊息
  for (const f of fs.readdirSync(CONV_DIR)) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(CONV_DIR, f), 'utf8'));
      let dirty = false;
      for (const m of c.messages) if (m.status === 'running') { m.status = 'stopped'; m.error = '程式關閉時中斷'; dirty = true; }
      if (dirty) fs.writeFileSync(path.join(CONV_DIR, f), JSON.stringify(c));
    } catch {}
  }
  await startServer();
  createWindow();
  if (process.env.AGENTDESK_SELFTEST) require('./selftest')({ app, getWin: () => win, newConv, startTurn, getConv, addAttachments });
});

app.on('before-quit', () => {
  for (const ctx of running.values()) for (const s of ctx.stops) s();
  for (const c of convs.values()) { try { saveConv(c, false); } catch {} }
});
app.on('window-all-closed', () => app.quit());
