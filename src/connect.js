// 設定頁「連結 CLI」：偵測是否安裝、版本、登入狀態；開終端機安裝或登入。
const { spawn } = require('child_process');
const { runProc } = require('./proc');
const { t: tr } = require('./shared/i18n');
const { resolveCli, clearCache, refreshPath } = require('./cli');

const ps = s => `'${String(s).replace(/'/g, "''")}'`;
const REFRESH_PATH = "$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')";

// 官方安裝方式（Claude、Cursor 用官方 PowerShell 安裝程式；Codex 走 npm，沒有 Node.js 先用 winget 裝）
const INSTALL = {
  claude: { label: 'Claude Code', cmd: 'irm https://claude.ai/install.ps1 | iex', doc: 'https://code.claude.com/docs/en/setup' },
  codex: { label: 'Codex CLI', cmd: `if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements; ${REFRESH_PATH} }; npm install -g @openai/codex`, doc: 'https://github.com/openai/codex' },
  cursor: { label: 'Cursor Agent CLI', cmd: "irm 'https://cursor.com/install?win32=true' | iex", doc: 'https://cursor.com/docs/cli/installation' },
};
const LOGIN = { claude: ['auth', 'login'], codex: ['login'], cursor: ['login'] };
const STATUS = { claude: ['auth', 'status'], codex: ['login', 'status'], cursor: ['status'] };

const stripAnsi = s => String(s || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');

async function run(base, args, timeout = 20000) {
  const r = await runProc(base[0], [...base.slice(1), ...args], { timeout, env: { ...process.env, NO_COLOR: '1' } });
  return { code: r.code, out: stripAnsi(r.stdout) + '\n' + stripAnsi(r.stderr) };
}

const splitArgs = s => (String(s || '').match(/"[^"]*"|\S+/g) || []).map(a => a.replace(/^"|"$/g, ''));
const customInstall = cfg => cfg?.installCmd ? { label: cfg.name || 'CLI', cmd: cfg.installCmd, doc: cfg.doc || '' } : (cfg?.doc ? { label: cfg.name, cmd: '', doc: cfg.doc } : null);

// 版本只在執行檔變動時重查；整體結果 20 秒內共用（啟動像 claude.exe 這種大型執行檔，
// 光是建立行程就會卡住主程序約 0.6 秒，設定頁一次偵測多個 Agent 會讓存檔延遲好幾秒）
const versionCache = new Map(), resultCache = new Map();
async function versionOf(base, args) {
  let stamp = '';
  try { const st = require('fs').statSync(base[base.length - 1]); stamp = `${st.mtimeMs}:${st.size}`; } catch {}
  const key = base.join('|') + '|' + args.join(' ');
  const hit = versionCache.get(key);
  if (hit && hit.stamp === stamp) return hit.version;
  const r = await run(base, args);
  const version = r.out.split('\n').map(x => x.trim()).find(Boolean) || '';
  versionCache.set(key, { stamp, version });
  return version;
}

// cfg：該 Agent 的設定（cli、自訂 Agent 的 versionArgs / statusArgs / installCmd / loginArgs / doc）
// force：使用者按「重新偵測」或安裝／登入後的輪詢，不用快取
async function check(agent, cfg = {}, force = false) {
  const key = JSON.stringify([agent, cfg.cli, cfg.custom, cfg.versionArgs, cfg.statusArgs, cfg.installCmd, cfg.loginArgs, cfg.doc]);
  const hit = resultCache.get(key);
  if (!force && hit && Date.now() - hit.at < 20000) return hit.result;
  const result = await doCheck(agent, cfg);
  resultCache.set(key, { at: Date.now(), result });
  return result;
}

async function doCheck(agent, cfg) {
  clearCache();
  await refreshPath();
  const base = resolveCli(cfg.cli || agent);
  if (cfg.custom) {
    if (!base) return { found: false, install: customInstall(cfg), custom: true };
    const version = await versionOf(base, splitArgs(cfg.versionArgs || '--version'));
    let loggedIn = null, account = '';
    if (cfg.statusArgs) {
      const st = await run(base, splitArgs(cfg.statusArgs), 30000);
      loggedIn = st.code === 0 && !/not logged in|未登入|unauthenticated/i.test(st.out);
      account = (st.out.match(/logged in (?:as|using) ([^\n]+)/i) || [])[1] || '';
    }
    return { found: true, path: base[base.length - 1], version, loggedIn, account: account.trim(), install: customInstall(cfg), custom: true,
      canLogin: !!cfg.loginArgs };
  }
  if (!base) return { found: false, install: INSTALL[agent] };
  const where = base[base.length - 1];
  const [version, st] = await Promise.all([versionOf(base, ['--version']), run(base, STATUS[agent], 30000)]);
  let loggedIn = false, account = '';
  if (agent === 'claude') {
    try {
      const j = JSON.parse(st.out.slice(st.out.indexOf('{'), st.out.lastIndexOf('}') + 1));
      loggedIn = !!j.loggedIn;
      account = j.email || j.authMethod || '';
    } catch { loggedIn = /logged in/i.test(st.out) && !/not logged in/i.test(st.out); }
  } else if (agent === 'codex') {
    loggedIn = st.code === 0 && /logged in/i.test(st.out) && !/not logged in/i.test(st.out);
    account = (st.out.match(/logged in using ([^\n]+)/i) || [])[1] || '';
  } else {
    loggedIn = /logged in as/i.test(st.out);
    account = (st.out.match(/logged in as ([^\n]+)/i) || [])[1] || '';
  }
  return { found: true, path: where, version, loggedIn, account: account.trim(), install: INSTALL[agent], canLogin: true };
}

// 開一個看得見的 PowerShell 視窗執行（安裝與登入都需要使用者看著或在瀏覽器確認）
function openTerminal(title, script) {
  const full = `$Host.UI.RawUI.WindowTitle = ${ps(title)}; ${script}; Write-Host ''; Write-Host ${ps(tr('完成後可以關閉這個視窗，回到 AgentDesk 按「重新偵測」。'))} -ForegroundColor Cyan`;
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-Command', full],
    { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
}

function install(agent, cfg = {}) {
  const it = cfg.custom ? customInstall(cfg) : INSTALL[agent];
  if (!it?.cmd) throw new Error(tr('這個 Agent 沒有設定安裝指令'));
  openTerminal(tr('安裝 {name}', { name: it.label }), it.cmd);
}

async function login(agent, cfg = {}) {
  clearCache(); await refreshPath();
  const base = resolveCli(cfg.cli || agent);
  if (!base) throw new Error(tr('還沒找到 CLI，請先安裝或指定路徑'));
  const args = cfg.custom ? splitArgs(cfg.loginArgs) : LOGIN[agent];
  if (!args?.length) throw new Error(tr('這個 Agent 沒有設定登入參數'));
  openTerminal(tr('登入 {name}', { name: cfg.name || INSTALL[agent]?.label || agent }), `& ${[...base, ...args].map(ps).join(' ')}`);
}

module.exports = { check, install, login, INSTALL };
