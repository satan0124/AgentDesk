// 找到 CLI 的真正執行檔，避開 Windows .cmd shim（Node 不能直接 spawn .cmd，且 shim 會干擾 stdin）。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const isWin = process.platform === 'win32';
const cache = new Map();

// 自己掃 PATH，不呼叫 where.exe：同步開子行程每次要上百毫秒，會卡住主程序
function where(name) {
  const exts = isWin ? (path.extname(name) ? [''] : ['.exe', '.cmd', '.bat', '.com']) : [''];
  const out = [];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir.replace(/^"|"$/g, ''), name + ext);
      try { if (fs.statSync(p).isFile()) out.push(p); } catch {}
    }
  }
  return [...new Set(out)];
}

let nodePath;
function nodeExe() {
  if (nodePath === undefined) nodePath = where('node').find(p => /\.exe$/i.test(p) || !isWin) || null;
  return nodePath;
}

// Cursor 的 agent.cmd 旁邊有 versions/<日期-hash>/node.exe + index.js
function cursorLauncher(cmdPath) {
  const dir = path.dirname(cmdPath);
  const folders = [dir];
  const versions = path.join(dir, 'versions');
  if (fs.existsSync(versions)) {
    const dated = fs.readdirSync(versions)
      .filter(n => /^\d{4}\.\d{1,2}\.\d{1,2}/.test(n))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (dated[0]) folders.push(path.join(versions, dated[0]));
  }
  for (const f of folders.reverse()) {
    const n = path.join(f, 'node.exe'), js = path.join(f, 'index.js');
    if (fs.existsSync(n) && fs.existsSync(js)) return [n, js];
  }
  return null;
}

// npm 產生的 .cmd：  "%dp0%\node_modules\...\bin\x.js" %*
function npmShimLauncher(cmdPath) {
  try {
    const text = fs.readFileSync(cmdPath, 'utf8');
    const m = text.match(/%dp0%\\(node_modules\\[^"%]+\.(?:c|m)?js)/i);
    if (!m) return null;
    const js = path.join(path.dirname(cmdPath), m[1]);
    const node = nodeExe();
    if (node && fs.existsSync(js)) return [node, js];
  } catch {}
  return null;
}

// 回傳 argv 前綴；找不到回 null
function resolveCli(name) {
  if (!name) return null;
  if (cache.has(name)) return cache.get(name);
  let result = null;
  let candidates = fs.existsSync(name) ? [name] : where(name);
  if (!candidates.length && isWin && !/[\\/]/.test(name)) candidates = knownLocations(name);
  if (!isWin) result = candidates[0] ? [candidates[0]] : null;
  else {
    const exe = candidates.find(p => /\.exe$/i.test(p));
    if (exe) result = [exe];
    else {
      const cmd = candidates.find(p => /\.(cmd|bat)$/i.test(p));
      if (cmd) result = cursorLauncher(cmd) || npmShimLauncher(cmd) || ['cmd.exe', '/d', '/s', '/c', cmd];
    }
  }
  cache.set(name, result);
  return result;
}

// 剛裝好的 CLI：程式自己的 PATH 還是舊的，先看各安裝方式的預設位置
function knownLocations(name) {
  const home = process.env.USERPROFILE || '', local = process.env.LOCALAPPDATA || '', roaming = process.env.APPDATA || '';
  const dirs = [path.join(home, '.local', 'bin'), path.join(roaming, 'npm'), path.join(local, 'cursor-agent'),
    path.join(local, 'Antigravity'),
    path.join(local, 'Microsoft', 'WinGet', 'Links')];
  const out = [];
  for (const d of dirs) for (const ext of ['.exe', '.cmd']) {
    const p = path.join(d, name + ext);
    if (fs.existsSync(p)) out.push(p);
  }
  return out;
}

// 從登錄檔重讀使用者與系統 PATH（安裝程式改了 PATH，不必重開程式）
// 非同步、10 秒內共用同一次結果：同步呼叫 PowerShell 會卡住主程序（設定頁一次偵測多個 Agent 時整個畫面會停住）
let pathJob = null, pathAt = 0;
function refreshPath() {
  if (!isWin) return Promise.resolve();
  if (pathJob && Date.now() - pathAt < 10000) return pathJob;
  pathAt = Date.now();
  pathJob = new Promise(resolve => {
    require('child_process').execFile('powershell.exe', ['-NoProfile', '-Command',
      "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 }, (err, out) => {
        out = (out || '').trim();
        if (!err && out) {
          const merged = [...new Set([...out.split(';'), ...(process.env.PATH || '').split(';')].filter(Boolean))];
          process.env.PATH = merged.join(';');
          cache.clear();
        }
        resolve();
      });
  });
  return pathJob;
}

function clearCache() { cache.clear(); }

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (typeof child.kill === 'function' && !child.stdio) { child.kill(); return; }   // proc.js 的行程：交給 worker 砍整棵
  if (isWin) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch {}
  } else {
    try { child.kill('SIGTERM'); } catch {}
  }
}

module.exports = { resolveCli, clearCache, killTree, refreshPath };
