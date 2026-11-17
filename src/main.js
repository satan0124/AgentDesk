const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { runAgent, listModels, readLimits, sessionSize, labelOf: labelOfCfg } = require('./agents');
const { clearCache, resolveCli } = require('./cli');
const { runProc } = require('./proc');
const connect = require('./connect');
const { buildContext, delegateReply } = require('./context');
const { MODES, modeOf, modeNotes, delegateTail, frugalNote, frugalPlace, needWork, stickyReadOnly, mustRestart } = require('./mode');
const { DIR: WORK_DIR, makeWork, workPath, template, parseWork, workFromFile } = require('./work');
const { transcript, entry } = require('./transcript');
const { KEEP, compressPrompt, noteAsk, parseNote, noteEntries, noteHoles, parseState, resumeForIndex, chunkRanges, editedFiles, verifyIndex, parseIndex, indexLine, indexHead, indexLines, indexContext } = require('./compress');
const i18n = require('./shared/i18n');
const tr = i18n.t;
const { applyEvent, partsText } = require('./shared/reduce');
const { upgradeCustom } = require('./shared/presets');

if (process.env.AGENTDESK_DATA) app.setPath('userData', process.env.AGENTDESK_DATA);
const DATA = app.getPath('userData');
const CONV_DIR = path.join(DATA, 'conversations');
const MCP_DIR = path.join(DATA, 'mcp');
fs.mkdirSync(path.join(DATA, 'attachments'), { recursive: true });
// 轉成長路徑：Claude 的 --add-dir 對 8.3 短路徑（SATAN0~1）比對不到
const ATT_DIR = fs.realpathSync.native(path.join(DATA, 'attachments'));
// 逐字稿與索引（transcript.js、compress.js）：每個對話一個資料夾 <對話 id>/，裡面是 transcript.md 與 index.md。
// 一個對話一個資料夾，開給 Agent 讀的時候才不會連別的對話一起開。一樣轉成長路徑
fs.mkdirSync(path.join(DATA, 'transcripts'), { recursive: true });
const TR_DIR = fs.realpathSync.native(path.join(DATA, 'transcripts'));
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const LIMITS_FILE = path.join(DATA, 'limits.json');
const BRIDGE = path.join(DATA, 'mcp-bridge.js');
fs.mkdirSync(CONV_DIR, { recursive: true });
fs.mkdirSync(MCP_DIR, { recursive: true });

const DEFAULT_SETTINGS = {
  language: 'auto',            // auto：繁中系統用繁中，其他用英文
  defaultCwd: os.homedir(),
  delegation: true,
  context: 'standard',         // 附帶上下文：lean／standard／full（見 context.js）
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
    const custom = Object.entries(s.agents || {}).filter(([k, v]) => v?.custom && !DEFAULT_SETTINGS.agents[k]).map(([k, v]) => [k, upgradeCustom(v)]);
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
  try {
    const c = JSON.parse(fs.readFileSync(convFile(id), 'utf8'));
    c.mode = modeOf(c);   // 舊對話沒有 mode：載入時補上（當成對話模式，見 mode.js），之後跟著對話一起存
    convs.set(id, c); return c;
  } catch { return null; }
}
function saveConv(c, touch = true) { if (touch) c.updated = Date.now(); fs.writeFileSync(convFile(c.id), JSON.stringify(c)); }
const saveTimers = new Map();
function saveSoon(c) {
  if (saveTimers.has(c.id)) return;
  // 計時器到的時候對話可能已經被刪掉（例如委派的 Agent 在刪除後才結束、又發了事件）：被刪的就不存，免得刪掉的對話回來
  saveTimers.set(c.id, setTimeout(() => { saveTimers.delete(c.id); if (convs.get(c.id) === c) saveConv(c); }, 2000));
}
function listConvs() {
  const out = [];
  for (const f of fs.readdirSync(CONV_DIR)) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -5);
    const c = convs.get(id) || (() => { try { return JSON.parse(fs.readFileSync(path.join(CONV_DIR, f), 'utf8')); } catch { return null; } })();
    if (c) out.push({ id: c.id, title: c.title, updated: c.updated, cwd: c.cwd, mode: modeOf(c), running: running.has(c.id),
      pinned: !!c.pinned, archived: !!c.archived, compressing: running.get(c.id)?.compress || null });
  }
  return out.sort((a, b) => b.updated - a.updated);
}
function newConv(cwd) {
  const c = { id: Date.now().toString(36) + crypto.randomBytes(3).toString('hex'), title: '新對話',
    cwd: cwd || settings.defaultCwd, mode: 'chat', created: Date.now(), updated: Date.now(), sessions: {}, messages: [] };
  convs.set(c.id, c); saveConv(c);
  return c;
}

// 從某一則訊息分支：開一個新對話，帶著到那一則為止的訊息，原本的對話不動。
//   各 Agent 的 session 不帶過去：兩個對話接續同一個 session 會互相蓋到。新對話第一輪照「沒有 session」的做法附上先前對話。
//   附件複製一份到新對話的資料夾：原本的對話刪掉時附件會跟著刪。
//   壓縮過的話，索引裡完全落在這段之內的那幾筆一起帶過去，逐字稿照新對話重寫。
function forkConv(id, msgId) {
  const src = getConv(id);
  const at = src ? src.messages.findIndex(m => m.id === msgId) : -1;
  if (at < 0) return { error: tr('找不到這則訊息') };
  if (src.messages[at].status === 'running') return { error: tr('這則訊息還在執行中') };
  const c = newConv(src.cwd);
  c.title = tr('{title}（分支）', { title: src.title });
  c.mode = modeOf(src);
  if (src.work) c.work = { ...src.work };
  if (src.agentCfg) c.agentCfg = JSON.parse(JSON.stringify(src.agentCfg));
  c.messages = JSON.parse(JSON.stringify(src.messages.slice(0, at + 1)));
  c.forkOf = { id: src.id, at: at + 1 };
  const from = path.join(ATT_DIR, src.id), to = path.join(ATT_DIR, c.id);
  for (const m of c.messages) for (const a of m.attachments || []) {
    if (a.kind === 'folder' || path.dirname(a.path) !== from) continue;
    try { fs.mkdirSync(to, { recursive: true }); const dest = path.join(to, path.basename(a.path)); fs.copyFileSync(a.path, dest); a.path = dest; } catch {}
  }
  const keep = [];
  for (const l of indexOf(src)?.lines || []) {
    const m = l.match(/^#\d+–#(\d+)/);
    if (!m || +m[1] > at + 1) break;
    keep.push([l, +m[1]]);
  }
  if (keep.length) {
    try {
      fs.mkdirSync(trDir(c.id), { recursive: true });
      fs.writeFileSync(indexFile(c.id), indexHead(c.title, tr) + keep.map(k => k[0]).join('\n') + '\n');
      c.indexed = keep.at(-1)[1];
      // 現況／下一步只在剛好是到這裡為止的狀態時帶過去
      if (src.state?.at === c.indexed) c.state = { ...src.state };
    } catch {}
  }
  saveConv(c);
  writeTranscript(c);
  send('conv:changed', listConvs());
  return { id: c.id };
}

// ---------- 給 Agent 的上下文 ----------
// Agent 只記得自己的 session；這裡補上它沒看過的、使用者與其他 Agent 的往來（上限見 context.js）。
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
  // 工作模式有進程檔時，背景寫在進程檔裡：只附最近幾則、用精簡的上限，不照設定頁的附帶量
  const work = workOf(conv);
  const idx = indexOf(conv);
  const level = work ? 'lean' : settings.context;
  // 壓縮過的對話，附上的原文前面標段落編號，Agent 才對得上索引與逐字稿
  const opts = { history, agent, hasSession, msgText, tr, level, recent: work ? 6 : 0,
    line: (m, t, i) => (idx ? `#${i + 1} ` : '') + tr(m.role === 'user' ? '使用者 → {name}：{text}' : '{name}：{text}', { name: labelOf(m.agent), text: t }) };
  // 壓縮過、這個 Agent 又沒有 session：附「索引＋最近幾則原文」。
  // 有 session 的 Agent 在 session 開頭已經拿過索引，照舊只補它沒看過的往來
  if (idx && !hasSession) {
    const ctx = buildContext({ ...opts, since: Math.max(0, idx.upto - KEEP) });
    const head = indexContext({ lines: idx.lines, file: transcriptFile(conv.id), index: indexFile(conv.id), level, tr,
      state: !work && conv.state?.at <= idx.upto ? conv.state : null });
    const body = ctx.text ? `${head}\n${tr('最近的原文：')}\n${ctx.text}` : head;
    return { prompt: `${body}\n${tr('[以上]')}\n\n${text}`, chars: body.length, seen: ctx.from + 1 };
  }
  // seen：沒有 session 時，這個新 session 從第幾則（1 起）之後的原文都看過了（見 compress 的接續判斷）
  const ctx = buildContext(opts);
  if (!ctx.text) return { prompt: text, chars: 0, seen: ctx.from + 1 };
  const head = tr(hasSession ? '[你上次回覆之後，使用者在同一個對話裡和其他 Agent 的往來，供參考]'
    : '[這個對話先前的內容，供參考]');
  return { prompt: `${head}\n${ctx.text}\n${tr('[以上]')}\n\n${text}`, chars: ctx.chars, seen: ctx.from + 1 };
}

const labelOf = agent => labelOfCfg(agent, settings.agents[agent]);
// 每個對話可以各自指定模型與強度（右欄卡片切換），沒指定的照設定；對話模式一律唯讀
function cfgFor(conv, agent) {
  const c = { ...settings.agents[agent] };
  const o = conv?.agentCfg?.[agent] || {};
  if (typeof o.model === 'string') c.model = o.model;
  if (typeof o.effort === 'string') c.effort = o.effort;
  c.readOnly = modeOf(conv) === 'chat';
  return c;
}
// 這個對話正在做的工作（工作模式且取了工作名才有）：{ name, file }，見 work.js
const workOf = conv => (modeOf(conv) === 'work' && conv.work?.name ? conv.work : null);
// 這一輪要給 Agent 的模式說明與工作指示（見 mode.js），並記下這個 Agent 的 session 收到的是哪一種
function notesFor(conv, agent, role = 'main') {
  const work = workOf(conv);
  const notes = modeNotes({ mode: modeOf(conv), agent, tr, role, work, file: work && workPath(conv.cwd, work),
    told: conv.sessions[agent] ? conv.told?.[agent] : undefined });
  conv.told = { ...(conv.told || {}), [agent]: notes.key };
  // 「極度節省 token」規則（設定頁每個 Agent 各自開關，文字見 mode.js 的 frugalNote）。
  // 放哪、要不要附由 mode.js 的 frugalPlace 決定；conv.ruled 記這個 session 收過了沒，session 重開後會再附一次
  const place = frugalPlace({ on: !!settings.agents[agent]?.frugal, agent, role, hasSession: !!conv.sessions[agent], ruled: !!conv.ruled?.[agent] });
  if (place === 'system') notes.system = [frugalNote(tr), notes.system].filter(Boolean).join('\n\n');
  if (place === 'prefix') {
    notes.prefix = [frugalNote(tr), notes.prefix].filter(Boolean).join('\n');
    conv.ruled = { ...(conv.ruled || {}), [agent]: true };
  }
  return notes;
}
// 丟掉某個 Agent 在這個對話的 session（下一輪重開，先前的對話當作參考附上），連同記下的大小
function dropSession(conv, agent) {
  delete conv.sessions[agent];
  if (conv.sizes) delete conv.sizes[agent];
  if (conv.seen) delete conv.seen[agent];
  if (conv.ruled) delete conv.ruled[agent];
}
// 切到工作模式後接不回去的 session（Cursor，見 mode.js 的 mustRestart）：丟掉重開。
// 要在 buildPrompt 之前呼叫，先前的對話才會照「沒有 session」的做法附上
function freshIfStuck(conv, agent) {
  if (conv.sessions[agent] && mustRestart({ agent, mode: modeOf(conv), told: conv.told?.[agent], permission: settings.agents[agent]?.permission })) dropSession(conv, agent);
}
// 一輪跑完：記下這個 Agent 的 session 現在大約多大（右欄卡片顯示，算法見 agents.js 的 sessionSize）
function noteSize(conv, agent, r, resumed) {
  const s = sessionSize(r, resumed ? conv.sizes?.[agent] : undefined, resumed);
  if (s && conv.sessions[agent]) conv.sizes = { ...(conv.sizes || {}), [agent]: s };
}
// 告訴畫面這個對話各 Agent 的 session 與大小有變
const sendMeta = conv => send('conv:meta', { convId: conv.id, sessions: conv.sessions, sizes: conv.sizes || {} });
// 工作模式第一次用到進程檔時，照範本建一份（已經有就不動，接續同一個工作時沿用）
function ensureWorkFile(conv) {
  const work = workOf(conv);
  if (!work) return;
  const file = workPath(conv.cwd, work);
  if (fs.existsSync(file)) return;
  const d = new Date(), p = n => String(n).padStart(2, '0');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, template(work.name, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, tr));
  } catch {}
}
// 逐字稿：每一輪結束後把整個對話重寫成 Markdown（每則訊息一段、有編號）。寫不進去不影響對話。
// onlyIfExists：只在已經有逐字稿時重寫（改標題時用，不替還沒聊過的對話建檔）
const trDir = id => path.join(TR_DIR, id);
const transcriptFile = id => path.join(trDir(id), 'transcript.md');
const indexFile = id => path.join(trDir(id), 'index.md');
function writeTranscript(conv, onlyIfExists) {
  try {
    if (onlyIfExists && !fs.existsSync(transcriptFile(conv.id))) return;
    fs.mkdirSync(trDir(conv.id), { recursive: true });
    fs.writeFileSync(transcriptFile(conv.id), transcript(conv, { label: labelOf, tr }));
  } catch {}
}
// 這個對話的索引（壓縮過才有，見 compress.js）：{ lines, upto }，upto＝索引涵蓋到第幾段。索引檔不見了就當作沒壓縮過
function indexOf(conv) {
  const upto = Math.min(conv.indexed || 0, conv.messages.length);
  if (!upto) return null;
  let lines = [];
  try { lines = indexLines(fs.readFileSync(indexFile(conv.id), 'utf8')); } catch {}
  return lines.length ? { lines, upto } : null;
}
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

// ---------- 環境檢查（設定頁） ----------
// 第一次用的人最常卡在安裝與設定：一次列出每一項，各給一行結果與修法。form：設定頁目前的內容（含還沒存的）；cwd：目前對話的資料夾
// 回傳 [{ label, ok: true|false|null（不適用）, detail, fix }]
async function envCheck(form, cwd) {
  const rows = [];
  // Node.js：AgentDesk.bat 第一次啟動要 npm install，需要 18 以上
  const node = resolveCli('node');
  if (!node) rows.push({ label: 'Node.js', ok: false, detail: tr('找不到'), fix: tr('到 https://nodejs.org/ 安裝 18 以上的版本，裝好後重開 AgentDesk') });
  else {
    const r = await runProc(node[0], [...node.slice(1), '--version'], { timeout: 15000 });
    const v = String(r.stdout || '').trim(), major = +(v.match(/^v(\d+)/) || [])[1];
    rows.push({ label: 'Node.js', ok: major >= 18, detail: v || tr('讀不到版本'), fix: major >= 18 ? '' : tr('到 https://nodejs.org/ 安裝 18 以上的版本，裝好後重開 AgentDesk') });
  }
  // 各 Agent：內建三個都列（沒加入的註明可以不用），自訂的只列已加入的；同時偵測
  const list = Object.entries(form.agents || {}).filter(([id, c]) => !c?.custom || c.enabled);
  rows.push(...await Promise.all(list.map(async ([id, c]) => {
    const label = labelOfCfg(id, c);
    if (!c.custom && !c.enabled) return { label, ok: null, detail: tr('沒加入（可以不用）'), fix: '' };
    const r = await connect.check(id, c, true).catch(e => ({ found: false, error: e.message }));
    if (!r.found) return { label, ok: false, detail: tr('找不到 CLI'),
      fix: r.install?.cmd ? tr('到下面 {name} 的設定按「安裝」，或在 PowerShell 執行：{cmd}', { name: label, cmd: r.install.cmd }) : tr('確認下面 {name} 的「CLI 指令」填對了', { name: label }) };
    const ver = [r.version, r.account].filter(Boolean).join(' · ');
    if (r.loggedIn === false) return { label, ok: false, detail: tr('已安裝，未登入') + (r.version ? ` · ${r.version}` : ''),
      fix: r.canLogin ? tr('到下面 {name} 的設定按「登入」', { name: label }) : tr('照 {name} 的說明登入', { name: label }) };
    return { label, ok: true, detail: ver || tr('已找到 CLI'), fix: '' };
  })));
  // 工作資料夾：新對話的預設資料夾與目前對話的資料夾，要存在、能寫入（Agent 要在裡面讀寫檔）
  for (const dir of [...new Set([form.defaultCwd, cwd].filter(Boolean))]) {
    const label = tr('工作資料夾');
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { rows.push({ label, ok: false, detail: tr('不存在：{dir}', { dir }), fix: tr('在「新對話預設工作資料夾」或對話上方選一個存在的資料夾') }); continue; }
    const probe = path.join(dir, `.agentdesk-write-test-${process.pid}`);
    try { fs.writeFileSync(probe, ''); fs.unlinkSync(probe); rows.push({ label, ok: true, detail: dir, fix: '' }); }
    catch { rows.push({ label, ok: false, detail: tr('不能寫入：{dir}', { dir }), fix: tr('換一個有寫入權限的資料夾，或檢查這個資料夾的權限') }); }
  }
  return rows;
}

// ---------- Agent 工作狀況（右欄） ----------
const jobs = new Map();          // jobId -> job
const finished = [];             // 最近完成，新的在前
let jobsTimer = null;
const agentStatus = () => ({ running: [...jobs.values()], finished, limits });
function publishJobs() {
  if (jobsTimer) return;
  jobsTimer = setTimeout(() => { jobsTimer = null; send('agents:status', agentStatus()); }, 200);
}

// ---------- 剩餘額度（右欄卡片） ----------
let limits = {};
try { limits = JSON.parse(fs.readFileSync(LIMITS_FILE, 'utf8')) || {}; } catch {}
function setLimits(agent, { windows, plan }) {
  if (!windows?.length) return;
  limits[agent] = { windows, plan, at: Date.now() };
  try { fs.writeFileSync(LIMITS_FILE, JSON.stringify(limits)); } catch {}
  publishJobs();
}
let codexLimitsAt = 0;
async function refreshCodexLimits(force) {
  if (!settings.agents.codex?.enabled || (!force && Date.now() - codexLimitsAt < 60000)) return;
  codexLimitsAt = Date.now();
  setLimits('codex', await readLimits('codex', settings.agents.codex));
}
function startJob(agent, conv, role, prompt) {
  const job = { id: crypto.randomUUID(), agent, convId: conv.id, convTitle: conv.title, role,
    prompt: (prompt || '').replace(/\s+/g, ' ').slice(0, 120), startedAt: Date.now(), activity: tr('啟動中…'), tools: 0 };
  jobs.set(job.id, job); publishJobs();
  return job;
}
function trackEvent(job, ev) {
  if (ev.type === 'tool' && ev.sub) { job.activity = tr('子代理：{action}', { action: `${ev.sub.name} ${ev.sub.detail || ''}`.trim() }); job.tools++; }
  else if (ev.type === 'tool' && ev.subError) return;
  else if (ev.type === 'tool') {
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
  if (job.agent === 'codex') refreshCodexLimits(true);
  finished.unshift({ ...job, endedAt: Date.now(), status: error ? (error === '已停止' ? 'stopped' : 'error') : 'done',
    activity: error ? String(error).split('\n')[0].slice(0, 120) : job.tools ? tr('完成（{n} 個工具）', { n: job.tools }) : tr('完成') });
  finished.length = Math.min(finished.length, 200);   // 右欄只看目前對話，留多一點
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
  // 從這裡起不管哪條路結束（正常、出錯、中途丟例外）都要收尾：結束工作、清掉執行中、存檔；不然對話會一直卡在執行中
  let job = null, endError = '';
  try {
  const cfg = cfgFor(conv, agent);
  freshIfStuck(conv, agent);
  ensureWorkFile(conv);
  job = startJob(agent, conv, 'main', text || tr('（附件）'));
  ctx.job = job;
  const freshSession = !conv.sessions[agent];
  const { prompt, chars: ctxChars, seen } = buildPrompt(conv, agent, (text || tr('請看附件。')) + attachText(atts), history);
  if (ctxChars) emitTo(conv, msg, { type: 'context', chars: ctxChars });
  const notes = notesFor(conv, agent);
  if (agent === 'claude') try { fs.mkdirSync(trDir(convId), { recursive: true }); } catch {}
  // 邊對話邊記索引：請它在回覆最後另起一行寫這一輪的索引（見 compress.js 的 noteAsk），附上上一輪的主題好讓同一件事用同一個主題
  const ask = noteAsk({ prev: history.findLast(m => m.note?.topic)?.note.topic, tr });
  const opts = { prompt: `${notes.prefix ? `${notes.prefix}\n\n` : ''}${prompt}\n\n${ask}`, cwd: conv.cwd, sessionId: conv.sessions[agent],
    images: atts.filter(a => a.kind === 'image').map(a => a.path),
    // 逐字稿資料夾在工作資料夾外面，要另外開讀取權（Claude 的 --add-dir）：壓縮過的對話要讀逐字稿與索引；
    // Claude 每一輪都開，委派回覆太長時完整內容存在那裡（見 saveDelegate），委派是在這一輪中途發生的
    addDirs: [...new Set([...atts.map(a => a.kind === 'folder' ? a.path : path.dirname(a.path)), ...(indexOf(conv) || agent === 'claude' ? [trDir(convId)] : [])])],
    onEvent: ev => {
    if (ev.type === 'session') { if (ev.id) conv.sessions[agent] = ev.id; return; }
    if (ev.type === 'limits') return setLimits(agent, ev);
    trackEvent(job, ev);
    emitTo(conv, msg, ev);
  } };
  if (agent === 'claude') {
    const canDelegate = settings.delegation && helpers().length > 0;
    const sys = [];
    if (canDelegate) {
      sys.push(claudeSystem(helpers()));
      opts.mcpConfig = mcpConfigFor(convId);
      opts.allowedTools = helpers().map(a => `mcp__agents__ask_${a}`);
    }
    if (notes.system) sys.push(notes.system);
    if (sys.length) opts.systemPrompt = sys.join('\n\n');
    opts.env = { MCP_TOOL_TIMEOUT: '7200000', MCP_TIMEOUT: '30000' };
  }
  const run = runAgent(agent, cfg, opts);
  ctx.stops.add(run.stop);
  const r = await run.promise;
  if (convs.get(convId) !== conv) { endError = r.error || '已停止'; return; }   // 執行中對話被刪掉：不再發事件、不記 session（finally 收尾）
  // session 失效（例如 CLI 端被刪）：清掉，下一次重開並帶上下文
  if (r.error && /session|thread|chat/i.test(r.error) && /not found|no conversation|找不到|invalid/i.test(r.error)) dropSession(conv, agent);
  else noteSize(conv, agent, r, !!opts.sessionId);
  // 新開的 session：記下它從第幾則之後的原文都看過（之後壓縮時判斷接續原本的 session 划不划算）
  if (freshSession && conv.sessions[agent]) conv.seen = { ...(conv.seen || {}), [agent]: seen };
  sendMeta(conv);
  if (r.text && !msg.parts.some(p => p.kind === 'text')) emitTo(conv, msg, { type: 'text', text: r.text });
  // 取出這一輪的索引行存到訊息上（那一行在下面的 status 事件裡從文字拿掉）
  const note = parseNote(msg.parts.filter(p => p.kind === 'text').map(p => p.text).join('\n'));
  if (note) msg.note = note;
  // 對話模式：Agent 想改檔卻做不了（Claude 的拒絕記錄，或回覆裡約定的標記）→ 畫面出現「切到工作模式並繼續」
  const need = !r.error && modeOf(conv) === 'chat'
    ? needWork({ text: partsText(msg.parts), denials: r.denials, permission: settings.agents[agent]?.permission }) : null;
  emitTo(conv, msg, { type: 'status', status: r.error ? (r.error === '已停止' ? 'stopped' : 'error') : 'done', error: r.error,
    meta: { cost: r.cost, usage: r.usage }, ...(need ? { needWork: need } : {}) });
  endError = r.error;
  } catch (e) {
    endError = e?.message || String(e);
    if (msg.status === 'running') emitTo(conv, msg, { type: 'status', status: 'error', error: endError });
  } finally {
    if (job) endJob(job, endError);
    running.delete(convId);
    clearTimeout(saveTimers.get(convId)); saveTimers.delete(convId);
    // 執行中被刪掉的對話不要再存回去（不然刪掉的對話會在回合結束後回來）
    if (convs.get(convId) === conv) { saveConv(conv); writeTranscript(conv); }
    send('conv:changed', listConvs());
  }
}

// Claude 經 MCP 委派過來
async function delegate({ conv: convId, agent, prompt, newSession }) {
  const ctx = running.get(convId);
  if (!ctx || ctx.compress) return { error: tr('這個對話目前沒有在執行的 Claude 回合') };
  if (!settings.agents[agent]?.enabled || agent === 'claude') return { error: tr('{name} 沒有加入 AgentDesk', { name: labelOf(agent) }) };
  const { conv, msg } = ctx;
  const id = crypto.randomUUID();
  emitTo(conv, msg, { type: 'delegate_start', id, agent, prompt });
  if (ctx.job) trackEvent(ctx.job, { type: 'delegate_start', agent });
  const job = startJob(agent, conv, 'delegate', prompt);
  // 中途丟例外也要收尾（卡片結束、右欄工作結束），不然卡片會一直顯示執行中
  let r, resumed = false;
  try {
    if (newSession) dropSession(conv, agent);
    freshIfStuck(conv, agent);
    // 被委派的 Agent 跟著這個對話的模式：對話模式一樣唯讀，說明放在 Claude 給的 prompt 前面（卡片上顯示的仍是原本的 prompt）
    const { prefix } = notesFor(conv, agent, 'delegate');
    resumed = !!conv.sessions[agent];
    // 最後附上收尾格式（做了什麼、改了哪些檔、沒做完的），Claude 拿到的回覆有上限，結論要在固定的地方
    const ask = `${prefix ? `${prefix}\n\n` : ''}${prompt}\n\n${delegateTail(tr)}`;
    const run = runAgent(agent, cfgFor(conv, agent), { prompt: ask, cwd: conv.cwd, sessionId: conv.sessions[agent], onEvent: ev => {
      if (ev.type === 'session') { if (ev.id) conv.sessions[agent] = ev.id; return; }
      if (ev.type === 'limits') return setLimits(agent, ev);
      trackEvent(job, ev);
      emitTo(conv, msg, { ...ev, del: id });
    } });
    ctx.stops.add(run.stop);
    r = await run.promise;
    ctx.stops.delete(run.stop);
  } catch (e) { r = { error: e?.message || String(e), text: '' }; }
  // 等待中對話被刪掉：不再發事件、不存委派回覆（不然會重建逐字稿資料夾），只收掉右欄的工作
  if (convs.get(convId) !== conv) { endJob(job, '已停止'); return { error: '已停止' }; }
  noteSize(conv, agent, r, resumed);
  sendMeta(conv);
  emitTo(conv, msg, { type: 'delegate_end', id, error: r.error });
  endJob(job, r.error);
  if (ctx.job && ![...jobs.values()].some(j => j.convId === convId && j.role === 'delegate')) trackEvent(ctx.job, { type: 'delegate_end' });
  // 交回 Claude 的內容有上限：Claude 的 context 每一輪都要重送，太長很吃額度。
  // 超過上限時完整回覆存到逐字稿資料夾（delegate-<序號>.md），Claude 每一輪都有那個資料夾的讀取權（見 startTurn）
  return { ...r, text: delegateReply(r, settings.context, tr, full => saveDelegate(conv, agent, prompt, full)) };
}
// 太長的委派回覆存成檔，回傳路徑；寫不進去回傳空字串（就只截短）
function saveDelegate(conv, agent, prompt, full) {
  try {
    const dir = trDir(conv.id);
    fs.mkdirSync(dir, { recursive: true });
    const n = fs.readdirSync(dir).filter(f => /^delegate-\d+\.md$/.test(f)).length + 1;
    const file = path.join(dir, `delegate-${n}.md`);
    fs.writeFileSync(file, [`# ${tr('{name} 的委派回覆', { name: labelOf(agent) })}`, '', `## ${tr('交辦內容')}`, '', prompt.trim(), '', `## ${tr('完整回覆')}`, '', full.trim(), ''].join('\n'));
    return file;
  } catch { return ''; }
}

// ---------- 壓縮 ----------
// 這次壓縮要寫哪幾段、那幾段的逐字稿文字、要不要接續 agent 原本的 session（規則見 compress.js 的 resumeForIndex）
function compressPlan(conv, agent) {
  const had = indexOf(conv);
  const from = (had?.upto || 0) + 1, to = conv.messages.length;
  const segs = conv.messages.slice(from - 1, to).map((m, i) => entry(m, from + i, { label: labelOf, tr }));
  const segText = (a, b) => segs.slice(a - from, b - from + 1).join('\n\n');
  const lens = segs.map(x => x.length + 2);
  const chars = lens.reduce((s, n) => s + n, 0);
  // 對話時記下的索引直接用，只有沒記到的段落才請 agent 寫
  const notes = noteEntries(conv.messages, from, to);
  const holes = noteHoles(conv.messages, notes, from, to);
  const resume = !notes.length && !!conv.sessions[agent] && resumeForIndex({ tokens: conv.sizes?.[agent]?.tokens, chars, seen: conv.seen?.[agent], from });
  // 開乾淨的 session 時，段落原文直接放進 prompt；太長就分批，每批各開一個
  const parts = resume ? [[from, to]] : holes.flatMap(([a, b]) => chunkRanges(lens.slice(a - from, b - from + 1), a));
  return { had, from, to, segText, resume, parts, notes };
}
// 請 agent 替「還沒進索引的段落」寫索引（給它的話與格式見 compress.js）。
// 對話時每輪記下的索引（訊息的 note）直接用，只有沒記到的段落才請 agent 寫；全都記到了就不用跑 agent。
// 整段都沒記到時，它原本的 session 看過全部要寫的段落、又不比重讀便宜太多時，接續原本的 session（一個請求就寫完）；
// 否則開乾淨的 session，把段落原文直接放進 prompt（不用它分段讀檔，每讀一段就重送一次前面的內容），太長分批。
// 寫回來的索引由 AgentDesk 核對（逐字稿裡沒出現的檔案拿掉、漏掉的段落補佔位）並補上改過的檔，
// 再追加到索引檔、清掉各 Agent 的 session，之後每一輪改附「索引＋最近幾則原文」。
// 這一輪不進對話記錄；失敗或被停止時什麼都不變
async function compress(convId, agent) {
  const conv = getConv(convId);
  if (!conv) return { error: tr('找不到對話') };
  if (running.has(convId)) return { error: tr('這個對話還在執行中') };
  if (!fs.existsSync(conv.cwd)) return { error: tr('工作資料夾不存在：{cwd}', { cwd: conv.cwd }) };
  if (!settings.agents[agent]?.enabled) return { error: tr('{name} 還沒加入，請到設定加入', { name: labelOf(agent) }) };
  const { had, from, to, segText, resume, parts, notes } = compressPlan(conv, agent);
  if (to < from) return { error: tr('沒有還沒寫進索引的內容') };
  writeTranscript(conv);
  if (!fs.existsSync(transcriptFile(convId))) return { error: tr('逐字稿寫不進去：{file}', { file: transcriptFile(convId) }) };
  const ctx = { conv, stops: new Set(), compress: { agent, from, to, part: 1, parts: parts.length } };
  running.set(convId, ctx);
  send('conv:changed', listConvs());
  const job = startJob(agent, conv, 'compress', tr('替 #{from}–#{to} 寫索引', { from, to }));
  // 只寫索引：不管對話是哪種模式都用唯讀的方式跑；這一輪產生的 session 不留
  // 沒有進程檔的對話另外要「現況／下一步」（有進程檔的，狀態寫在進程檔裡）：只在最後一批要，它看得到最近的內容
  const wantState = !workOf(conv);
  const parsed = [];
  let error = '', r = {}, checked = { entries: [] };
  // 中途丟例外也要收尾（結束工作、清掉執行中），不然對話會一直卡在壓縮中
  try {
  for (let k = 0; k < parts.length && !error; k++) {
    const [a, b] = parts[k];
    ctx.compress = { ...ctx.compress, part: k + 1 };
    if (k) send('conv:changed', listConvs());
    const last = k === parts.length - 1;
    const prompt = compressPrompt({ file: transcriptFile(convId), from: a, to: b, tr, state: wantState && last, text: resume ? '' : segText(a, b) });
    const run = runAgent(agent, { ...cfgFor(conv, agent), readOnly: true }, { prompt,
      cwd: conv.cwd, sessionId: resume ? conv.sessions[agent] : undefined, addDirs: [trDir(convId)],
      onEvent: ev => {
        if (ev.type === 'session') return;
        if (ev.type === 'limits') return setLimits(agent, ev);
        trackEvent(job, ev);
      } });
    ctx.stops.add(run.stop);
    r = await run.promise;
    ctx.stops.delete(run.stop);
    // 這一輪是唯讀跑的。接續的 session 沒壓成時會留著：記下它跑過唯讀，之後在工作模式才會重開（Cursor，見 mode.js 的 mustRestart）。
    // 沒接續就沒動到原本的 session
    if (resume && stickyReadOnly(agent)) conv.told = { ...(conv.told || {}), [agent]: 'chat' };
    // session 失效：清掉，再按一次就會開乾淨的 session 來寫
    if (resume && r.error && /session|thread|chat/i.test(r.error) && /not found|no conversation|找不到|invalid/i.test(r.error)) dropSession(conv, agent);
    const got = r.error ? [] : parseIndex(`${r.text || ''}\n${r.final || ''}`, { from: a, to: b });
    error = r.error || (got.length ? '' : tr('{name} 沒有照格式寫出索引，這次沒有壓縮。可以再試一次，或換一個 Agent。', { name: labelOf(agent) }));
    parsed.push(...got);
  }
  const uniq = [...notes, ...parsed.filter((e, i, all) => all.findIndex(x => indexLine(x) === indexLine(e)) === i)];
  // 工作資料夾裡真的有的檔（相對路徑，或在工作資料夾裡的絕對路徑）；工作資料夾裡的絕對路徑寫進索引時轉成相對路徑
  const inCwd = f => { const r = path.relative(path.resolve(conv.cwd), path.resolve(conv.cwd, f)); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : ''; };
  const exists = f => { try { return !!inCwd(f) && fs.statSync(path.resolve(conv.cwd, f)).isFile(); } catch { return false; } };
  const rel = f => (path.isAbsolute(f) && inCwd(f) ? inCwd(f).replace(/\\/g, '/') : f);
  checked = verifyIndex(uniq, { from, to, segText, edited: (a, b) => editedFiles(conv.messages.slice(a - 1, b), conv.cwd), tr, exists, rel });
  if (!error) {
    try {
      if (!had) fs.writeFileSync(indexFile(convId), indexHead(conv.title, tr));
      fs.appendFileSync(indexFile(convId), checked.entries.map(indexLine).join('\n') + '\n');
      conv.indexed = to; conv.sessions = {}; conv.sizes = {}; conv.seen = {};
      // 現況／下一步每次整個換掉（不追加）；這次沒寫出來就留著上一次的，附上時會註明是到 #幾的狀態
      const st = wantState ? parseState(`${r.text || ''}\n${r.final || ''}`) : null;
      if (st) conv.state = { ...st, at: to };
    } catch (e) { error = tr('索引寫不進去：{error}', { error: e.message }); }
  }
  } catch (e) { error = e?.message || String(e); }
  const entries = checked.entries;
  endJob(job, error);
  running.delete(convId);
  if (convs.get(convId) === conv) saveConv(conv, false);   // 壓縮途中對話被刪掉就不要再存回去
  sendMeta(conv);
  send('conv:changed', listConvs());
  return error ? { error } : { from, to, added: entries.length, noted: notes.length, resumed: resume, parts: parts.length, dropped: checked.dropped, gaps: checked.gaps, overlaps: checked.overlaps };
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
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      // 只在自我測試：讓假 Agent 能像 MCP bridge 一樣打 /delegate（畫面測試的「委派中刪對話」，見 tools/validate/fixtures/fake-hold.js）
      if (process.env.AGENTDESK_SELFTEST) process.env.AGENTDESK_TEST_DELEGATE = JSON.stringify({ port, token });
      resolve();
    });
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
  try { fs.rmSync(trDir(id), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(ATT_DIR, id), { recursive: true, force: true }); } catch {}
  send('conv:changed', listConvs());
});
ipcMain.handle('conv:fork', (_, id, msgId) => { try { return forkConv(id, msgId); } catch (e) { return { error: e.message }; } });
ipcMain.handle('conv:update', (_, id, patch) => {
  const c = getConv(id); if (!c) return;
  if (typeof patch.title === 'string') {
    c.title = patch.title.trim() || c.title;
    writeTranscript(c, true);
    for (const j of jobs.values()) if (j.convId === id) j.convTitle = c.title;
    publishJobs();
  }
  if (typeof patch.cwd === 'string') c.cwd = patch.cwd;
  if (patch.resetSessions) { c.sessions = {}; c.sizes = {}; c.seen = {}; }
  // 只讓一個 Agent 重開（右欄卡片的「重開」）；回合執行中不動，免得跑完又把舊的 session 寫回來
  if (typeof patch.resetSession === 'string' && !running.has(id)) dropSession(c, patch.resetSession);
  // 模式與工作名跟著整個回合走：執行中不換（委派出去的 Agent 才不會和 Claude 用不同的權限）
  if (!running.has(id)) {
    if (MODES.includes(patch.mode)) c.mode = patch.mode;
    // 工作名：字串＝設定（清成可以當檔名的字，清完是空的就不動），null＝拿掉
    if (typeof patch.work === 'string') c.work = makeWork(patch.work) || c.work;
    else if (patch.work === null) delete c.work;
    // 接續資料夾裡現成的進程檔：檔名（不含 .md）原樣當工作名，檔案要真的存在
    if (typeof patch.workFile === 'string') {
      const w = workFromFile(patch.workFile);
      if (w && fs.existsSync(workPath(c.cwd, w))) c.work = w;
    }
  }
  // 模式、釘選、封存不算對話有新動靜，不改排序用的更新時間
  if (typeof patch.pinned === 'boolean') c.pinned = patch.pinned;
  if (typeof patch.archived === 'boolean') { c.archived = patch.archived; if (c.archived) c.pinned = false; }
  // 這個對話用的模型／強度：字串＝指定，null＝回到設定的預設
  if (patch.agentCfg && typeof patch.agentCfg === 'object') {
    const all = { ...(c.agentCfg || {}) };
    for (const [a, v] of Object.entries(patch.agentCfg)) {
      const cur = { ...(all[a] || {}) };
      for (const k of ['model', 'effort']) if (v && k in v) { if (typeof v[k] === 'string') cur[k] = v[k]; else delete cur[k]; }
      if (Object.keys(cur).length) all[a] = cur; else delete all[a];
    }
    c.agentCfg = all;
  }
  const touch = typeof patch.cwd === 'string' || !!patch.resetSessions || typeof patch.resetSession === 'string';
  saveConv(c, touch); send('conv:changed', listConvs());
  return c;
});
// ---------- 工作（進程檔） ----------
const readText = file => { try { return fs.readFileSync(file, 'utf8').slice(0, 300000); } catch { return null; } };
// 右欄的工作現況：讀這個對話的進程檔（續傳指引的條列、任務清單），解析見 work.js
ipcMain.handle('work:read', (_, id) => {
  const c = getConv(id);
  if (!c?.work?.name) return null;
  const file = workPath(c.cwd, c.work);
  const md = readText(file);
  if (md === null) return { name: c.work.name, path: file, exists: false, resume: [], tasks: [] };
  const p = parseWork(md);
  return { name: c.work.name, path: file, exists: true, resume: p.resume.slice(0, 6), tasks: p.tasks.slice(0, 40) };
});
// 這個對話的工作資料夾裡現成的進程檔（新對話「接續工作」用），最近改過的在前
ipcMain.handle('work:list', (_, id) => {
  const c = getConv(id);
  if (!c) return [];
  const dir = path.join(c.cwd, ...WORK_DIR);
  let names;
  try { names = fs.readdirSync(dir).filter(f => /\.md$/i.test(f)); } catch { return []; }
  return names.map(f => {
    const file = path.join(dir, f);
    let mtime;
    try { const st = fs.statSync(file); if (!st.isFile()) return null; mtime = st.mtimeMs; } catch { return null; }
    const p = parseWork(readText(file) || '');
    return { name: f.replace(/\.md$/i, ''), mtime, status: p.resume[0] || '', done: p.tasks.filter(x => x.done).length, total: p.tasks.length };
  }).filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, 20);
});
// ---------- 壓縮（逐字稿與索引） ----------
ipcMain.handle('conv:compress', (_, id, agent) => compress(id, agent).catch(e => ({ error: e.message })));
// 這個對話的逐字稿與索引在哪、索引有幾筆（畫面上點「已壓縮」那條線時開啟索引檔用）。
// 帶 agent 時另外回答：由它寫索引會不會接續原本的 session（確認視窗用）
ipcMain.handle('compress:info', (_, id, agent) => {
  const c = getConv(id);
  if (!c) return null;
  const idx = indexOf(c);
  return { transcript: transcriptFile(id), index: indexFile(id), upto: idx?.upto || 0, lines: idx?.lines.length || 0,
    ...(agent ? (p => ({ resume: p.resume, parts: p.parts.length, noted: p.notes.length }))(compressPlan(c, agent)) : {}) };
});
ipcMain.handle('att:add', (_, items) => addAttachments(items || []));
ipcMain.handle('chat:send', (_, convId, agent, text, atts) => {
  startTurn(convId, agent, text, atts).catch(err => send('chat:error', { convId, error: err.message }));
});
ipcMain.handle('chat:stop', (_, convId) => { const ctx = running.get(convId); if (ctx) for (const s of ctx.stops) s(); });
ipcMain.handle('settings:get', () => publicSettings());
ipcMain.handle('settings:set', (_, s) => { delete s.uiLang; settings = s; saveSettings(); clearCache(); applyLang(); return publicSettings(); });
ipcMain.handle('models:list', (_, agent, cfg) => { if (agent !== 'claude') clearCache(); return listModels(agent, cfg || settings.agents[agent]); });
ipcMain.handle('dialog:files', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
  return r.canceled ? [] : addAttachments(r.filePaths.map(p => ({ path: p })));
});
ipcMain.handle('dialog:folder', async (_, current) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: current });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('open:path', (_, p) => (p && fs.existsSync(p) ? shell.openPath(p) : 'not found'));
// 右側預覽（畫面的 openPreview）：Markdown 讀內容回去畫；HTML 由畫面用 iframe 直接開，這裡只給修改時間（每 1.5 秒比一次，檔案改了就重畫）
const PREVIEW_MAX = 2000000;
ipcMain.handle('file:read', (_, p) => {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return { error: 'not a file' };
    const fd = fs.openSync(p, 'r'), buf = Buffer.alloc(Math.min(st.size, PREVIEW_MAX));
    try { fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
    return { text: buf.toString('utf8'), mtime: st.mtimeMs, cut: st.size > PREVIEW_MAX };
  } catch (e) { return { error: e.message }; }
});
ipcMain.handle('file:mtime', (_, p) => { try { return fs.statSync(p).mtimeMs; } catch { return null; } });
ipcMain.handle('open:url', (_, u) => { if (/^https:\/\//.test(u)) shell.openExternal(u); });
ipcMain.handle('cli:check', (_, agent, cfg, force) => connect.check(agent, cfg, force));
ipcMain.handle('env:check', (_, form, cwd) => envCheck(form || settings, cwd));
ipcMain.handle('cli:install', (_, agent, cfg) => connect.install(agent, cfg));
ipcMain.handle('cli:login', (_, agent, cfg) => connect.login(agent, cfg));
ipcMain.handle('cli:browse', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'],
    filters: [{ name: tr('執行檔'), extensions: ['exe', 'cmd', 'bat', 'js'] }, { name: tr('全部'), extensions: ['*'] }] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('open:reveal', (_, p) => shell.showItemInFolder(p));
ipcMain.handle('agents:status', () => agentStatus());

// ---------- 視窗 ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 760, minHeight: 500,
    backgroundColor: '#1b1b1d', autoHideMenuBar: true, title: 'AgentDesk',
    icon: path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  // 從原始碼執行時，工作列上跑的是 electron.exe。使用者把視窗釘選到工作列，Windows 記下的只有 electron.exe：
  // 關掉後圖示變成 Electron 的，從那個圖示開出來的是 Electron 的預設頁。這裡告訴 Windows 釘選時要記的指令與圖示。
  // appId 要和下面 app.setAppUserModelId 的一樣；打包後的 exe 本身就是 AgentDesk，不用設
  if (process.platform === 'win32' && !app.isPackaged) {
    try {
      win.setAppDetails({ appId: 'AgentDesk', appIconPath: path.join(__dirname, '..', 'build', 'icon.ico'), appIconIndex: 0,
        relaunchCommand: `"${process.execPath}" "${app.getAppPath()}"`, relaunchDisplayName: 'AgentDesk' });
    } catch {}
  }
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
  // Codex 額度：啟動時讀一次，之後每 5 分鐘（右欄打開時才會用到，讀不到就算了）
  if (!process.env.AGENTDESK_SELFTEST) { setTimeout(refreshCodexLimits, 3000); setInterval(refreshCodexLimits, 300000); }
  if (process.env.AGENTDESK_SELFTEST) require('./selftest')({ app, getWin: () => win, newConv, startTurn, getConv, addAttachments });
});

app.on('before-quit', () => {
  for (const ctx of running.values()) for (const s of ctx.stops) s();
  for (const c of convs.values()) { try { saveConv(c, false); } catch {} }
});
app.on('window-all-closed', () => app.quit());
