// Claude 改用 API 金鑰時的設定資料夾（CLAUDE_CONFIG_DIR）與取金鑰的小程式（apiKeyHelper）。
//
// 為什麼要另一個設定資料夾（2026-11-18 用 Claude Code 2.1.310 實測，假金鑰不花額度）：
//   - 已經用訂閱帳號登入時，-p 模式就算帶了 ANTHROPIC_API_KEY 或 apiKeyHelper，照樣用登入的帳號（假金鑰也照常回覆）
//   - 加 --bare 才只用金鑰，但內建工具只剩 Bash、Edit、PowerShell、Read
//   - 指到一個沒有 .credentials.json 的 CLAUDE_CONFIG_DIR：工具齊全，只用金鑰（假金鑰回 Invalid API key）
// 這個資料夾裡，~/.claude 的子資料夾（projects＝session、skills、plugins…）用 junction 指回原處，session 兩邊共用，切換前後接得上；
// CLAUDE.md、settings.json 等檔案複製過來（原本的比較新才覆蓋），登入憑證（.credentials.json）不帶。
// 注意：junction 指向的是使用者真的 ~/.claude 子資料夾，要清掉這個資料夾時只能拿掉連結本身（fs.rmSync 對 junction 只拿掉連結）。
//
// 為什麼用 apiKeyHelper 不用環境變數：環境變數會傳給 Claude 執行的每個指令，Agent 跑 env／set 或工具把環境變數印進日誌時，金鑰就跟著出現在
// 對話與逐字稿裡。apiKeyHelper 是 Claude Code 要金鑰時才執行的指令：這裡寫成用 node 跑一支小程式，向 AgentDesk 的本機服務要。
// 擋得住不小心外洩，擋不住刻意找金鑰的程式（它一樣能用這個帳號的身分解開加密，或照著小程式去要）。
const fs = require('fs');
const os = require('os');
const path = require('path');

const SKIP = /^(\.credentials\.json|policy-limits.*)$/i;
function copyIfNewer(from, to) {
  try {
    const a = fs.statSync(from);
    let b = null; try { b = fs.statSync(to); } catch {}
    if (!b || a.mtimeMs > b.mtimeMs) fs.copyFileSync(from, to);
  } catch {}
}
// 建好（或更新）API 模式用的設定資料夾，回傳路徑。src：使用者原本的設定資料夾
function prepareHome(dir, { src = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), home = os.homedir() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  let entries = [];
  try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch {}
  for (const e of entries) {
    if (SKIP.test(e.name)) continue;
    const from = path.join(src, e.name), to = path.join(dir, e.name);
    if (e.isDirectory()) {
      let exists = false; try { fs.lstatSync(to); exists = true; } catch {}
      if (!exists) try { fs.symlinkSync(from, to, 'junction'); } catch {}
    } else if (e.isFile()) copyIfNewer(from, to);
  }
  // 沒設 CLAUDE_CONFIG_DIR 時，使用者層的 .claude.json（MCP 伺服器、專案信任等）在家目錄；設了之後 Claude 讀資料夾裡的那份
  if (!process.env.CLAUDE_CONFIG_DIR) copyIfNewer(path.join(home, '.claude.json'), path.join(dir, '.claude.json'));
  return dir;
}

// 取金鑰的小程式：node <這支> <port> <token>，印出金鑰；拿不到就結束碼 1（Claude 會回報金鑰錯誤）
const HELPER = `// AgentDesk：Claude Code 的 apiKeyHelper，向 AgentDesk 的本機服務要 Claude API 金鑰（只在 AgentDesk 用 API 跑 Claude 時拿得到）
const http = require('http');
const [port, token] = process.argv.slice(2);
http.get({ host: '127.0.0.1', port, path: '/apikey', headers: { 'x-agentdesk-token': token } }, res => {
  let d = ''; res.setEncoding('utf8'); res.on('data', c => { d += c; });
  res.on('end', () => { if (res.statusCode !== 200) { process.stderr.write('AgentDesk: ' + d); process.exit(1); } process.stdout.write(d); });
}).on('error', e => { process.stderr.write('AgentDesk: ' + e.message); process.exit(1); });
`;
// apiKeyHelper 的指令（Claude Code 經 shell 執行；路徑用 / 並加引號，cmd 與 Git Bash 都吃）
const q = p => `"${String(p).replace(/\\/g, '/')}"`;
const helperCommand = ({ node, script, port, token }) => `${q(node)} ${q(script)} ${port} ${token}`;

module.exports = { prepareHome, HELPER, helperCommand };
