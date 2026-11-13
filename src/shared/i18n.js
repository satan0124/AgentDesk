// 介面語言：原始碼裡直接寫繁體中文，這裡用「中文原文 → 英文」對照。
// 主程序與畫面共用；找不到對照就顯示原文。{name} 這類佔位會代換。
(function (root) {
  const EN = {
    // ---- 通用 ----
    '新對話': 'New chat',
    '設定': 'Settings',
    '儲存': 'Save',
    '取消': 'Cancel',
    '刪除': 'Delete',
    '移除': 'Remove',
    '說明': 'Docs',
    '安裝': 'Install',
    '登入': 'Sign in',
    '開啟': 'Open',
    '複製': 'Copy',
    '已複製': 'Copied',
    '停止': 'Stop',
    '送出': 'Send',
    '完成': 'Done',
    '失敗': 'Failed',
    '已停止': 'Stopped',
    '執行中…': 'Running…',
    '已刪除的 Agent': 'Deleted agent',
    '預設模型': 'Default model',
    '強度 {effort}': 'effort {effort}',

    // ---- 側欄、頂列 ----
    '搜尋對話': 'Search chats',
    '對話記錄': 'Chats',
    '今天': 'Today',
    '昨天': 'Yesterday',
    '過去 7 天': 'Previous 7 days',
    '過去 30 天': 'Previous 30 days',
    '雙擊改名': 'Double-click to rename',
    '更換工作資料夾': 'Change working folder',
    '工作資料夾：{cwd}\n點擊更換': 'Working folder: {cwd}\nClick to change',
    '在檔案總管開啟': 'Open in File Explorer',
    '讓三個 Agent 重開 session（對話記錄保留）': 'Start fresh agent sessions (chat history is kept)',
    '刪除這個對話': 'Delete this chat',
    '顯示／隱藏 Agent 工作狀況': 'Show / hide agent activity',
    '讓 Claude / Codex / Cursor 下一次都開新 session？\n畫面上的對話記錄會保留，並在下一次送出時當作參考帶給 Agent。':
      'Start fresh sessions for all agents next time?\nThe chat history stays and is passed to the agents as context on your next message.',
    '刪除「{title}」？此動作無法復原。': 'Delete "{title}"? This cannot be undone.',

    // ---- 空白頁、輸入框 ----
    '要做什麼？': 'What should we work on?',
    '預設由 Claude 回答；Claude 可以把工作交給 Codex 或 Cursor。也可以在下方直接切換對象。':
      'Claude answers by default and can hand work to the other agents. You can also switch who you talk to below.',
    '輸入訊息，Enter 送出、Shift+Enter 換行；可直接貼上或拖曳圖片、檔案':
      'Message… Enter to send, Shift+Enter for a new line. Paste or drop images and files.',
    '新增檔案、相片或資料夾': 'Add files, photos or a folder',
    '新增檔案或相片': 'Add files or photos',
    '新增資料夾': 'Add folder',
    ' · 可委派 {names}': ' · can delegate to {names}',
    '放開即可附加檔案': 'Drop to attach',
    '資料夾': 'Folder',
    '移除附件': 'Remove',
    '貼上': 'Pasted',

    // ---- 訊息 ----
    '思考過程': 'Thinking',
    '交給 {name}': 'Delegated to {name}',
    '{name} 執行中…': '{name} is working…',
    '{name} 處理中…': '{name} is working…',
    '程式關閉時中斷': 'Interrupted when the app closed',

    // ---- 圖片預覽 ----
    '關閉（Esc）': 'Close (Esc)',
    '上一張（←）': 'Previous (←)',
    '下一張（→）': 'Next (→)',
    '符合視窗': 'Fit',
    '原始大小': 'Actual size',
    '在資料夾中顯示': 'Show in folder',

    // ---- 右欄 ----
    'Agent 工作狀況': 'Agent activity',
    '最近完成': 'Recently finished',
    '{n} 個工作中': '{n} running',
    'Claude 委派': 'From Claude',
    '主對話': 'Chat',
    '工作中 ×{n}': 'Working ×{n}',
    '工作中': 'Working',
    '閒置': 'Idle',
    '還沒有完成的工作': 'Nothing finished yet',
    '{s} 秒': '{s}s',
    '{m} 分 {s} 秒': '{m}m {s}s',
    '{h} 時 {m} 分': '{h}h {m}m',
    '剛剛': 'just now',
    '{m} 分鐘前': '{m} min ago',
    '{h} 小時前': '{h} h ago',
    '啟動中…': 'Starting…',
    '思考中…': 'Thinking…',
    '回覆中…': 'Writing…',
    '等待 {name} 完成': 'Waiting for {name}',
    '完成（{n} 個工具）': 'Done ({n} tools)',

    // ---- 設定：一般 ----
    '一般': 'General',
    '新對話預設工作資料夾': 'Default folder for new chats',
    '選擇…': 'Browse…',
    '讓 Claude 可以把工作委派給已加入的其他 Agent': 'Let Claude delegate work to the other agents you added',
    '介面語言': 'Language',
    '自動（跟隨系統）': 'Automatic (system)',
    '更改語言後會重新載入畫面。': 'The window reloads after changing the language.',

    // ---- 設定：Agent ----
    'Anthropic Claude Code，主要對話。': 'Anthropic Claude Code — the main chat.',
    'OpenAI Codex CLI：可直接對話，或讓 Claude 委派工作。': 'OpenAI Codex CLI — chat with it directly or let Claude delegate to it.',
    'Cursor Agent CLI：可直接對話，或讓 Claude 委派工作。': 'Cursor Agent CLI — chat with it directly or let Claude delegate to it.',
    '未加入': 'Not added',
    '＋ 加入': '+ Add',
    '（主要對話，不能移除）': '(main chat, cannot be removed)',
    'CLI 指令': 'CLI command',
    '讀取清單': 'Load list',
    '讀取中…': 'Loading…',
    '留空＝CLI 預設': 'Empty = CLI default',
    '強度': 'Effort',
    '預設（CLI 自己決定）': 'Default (CLI decides)',
    'Cursor 的強度會組成 模型[effort=…]；模型 id 本身已含強度（例如 -high）時不另外加。':
      'Cursor effort is sent as model[effort=…]; skipped when the model id already includes it (e.g. -high).',
    '沙箱': 'Sandbox',
    '權限': 'Permissions',
    '自動接受改檔（指令需另外允許）': 'Accept edits automatically (commands need approval)',
    'auto：由分類器判斷': 'auto: decided by classifier',
    '全部放行（不詢問）': 'Allow everything (never ask)',
    '只規劃不動手': 'Plan only',
    '可寫工作資料夾': 'Write in working folder',
    '唯讀': 'Read only',
    '完全存取（危險）': 'Full access (dangerous)',
    '自動執行指令（--force）': 'Run commands automatically (--force)',
    '只信任資料夾，不自動跑指令': 'Trust folder, do not auto-run commands',
    '唯讀問答（ask）': 'Read-only Q&A (ask)',
    '只規劃（plan）': 'Plan only (plan)',
    '已加入 {name}，按「儲存」後生效': 'Added {name}. Click Save to apply.',
    '已移除 {name}，按「儲存」後生效': 'Removed {name}. Click Save to apply.',
    '{name}：{error}': '{name}: {error}',
    '{name}：{n} 個模型，點模型欄位可選': '{name}: {n} models — pick one in the model field',

    // ---- 設定：連結 CLI ----
    '偵測中…': 'Checking…',
    '找不到 CLI': 'CLI not found',
    '已安裝，未登入': 'Installed, not signed in',
    '已找到 CLI': 'CLI found',
    '已連結': 'Connected',
    '已連結：{account}': 'Connected: {account}',
    '重新偵測': 'Re-check',
    '指定路徑…': 'Locate…',
    '安裝指令：': 'Install command: ',
    '等待完成…（每 4 秒自動偵測）': 'Waiting… (re-checking every 4 s)',
    '會開一個 PowerShell 視窗執行 {label} 的官方安裝指令：\n\n{cmd}\n\n要繼續嗎？':
      'This opens a PowerShell window and runs the official {label} installer:\n\n{cmd}\n\nContinue?',
    'Claude Code 還沒登入：按「登入」完成後即可開始對話。': 'Claude Code is not signed in. Click "Sign in" and you are ready to chat.',
    '找不到 Claude Code：按「安裝」，裝好後再按「登入」。': 'Claude Code was not found. Click "Install", then "Sign in".',

    // ---- 設定：自訂 Agent ----
    '自訂': 'Custom',
    '自訂 Agent': 'Custom agent',
    '新增其他 CLI Agent：': 'Add another CLI agent:',
    '＋ 新增自訂 Agent': '+ Add custom agent',
    'Claude 相容格式（stream-json）': 'Claude-compatible (stream-json)',
    '一般 CLI（純文字輸出）': 'Any CLI (plain text output)',
    '純文字：stdout 直接當回覆（任何 CLI 都能用）': 'Plain text: stdout is the reply (works with any CLI)',
    'Claude 相容 stream-json（看得到工具與即時串流）': 'Claude-compatible stream-json (tools and live streaming)',
    '名稱／顏色': 'Name / color',
    '顯示名稱': 'Display name',
    '例如 gemini，或完整路徑': 'e.g. gemini, or a full path',
    '額外參數': 'Extra arguments',
    '例如 --output-format stream-json --yolo': 'e.g. --output-format stream-json --yolo',
    '以空白分隔，含空白的參數用雙引號包起來；<code>{cwd}</code> 會換成對話的工作資料夾。':
      'Space-separated; wrap arguments with spaces in double quotes. <code>{cwd}</code> becomes the chat\'s working folder.',
    'Prompt 傳入': 'Prompt input',
    '從 stdin 傳入': 'Via stdin',
    '接在參數最後': 'As the last argument',
    '前面加的旗標，例如 -p（可空）': 'Flag before it, e.g. -p (optional)',
    '輸出格式': 'Output format',
    '模型旗標，例如 -m': 'Model flag, e.g. -m',
    '接續 session 旗標': 'Resume flag',
    '例如 --resume；留空＝每次重開，自動附上對話記錄': 'e.g. --resume; empty = new session each time, chat history is passed along',
    '給 Claude 的說明': 'Description for Claude',
    '它擅長什麼，Claude 決定要不要委派時參考': 'What it is good at — Claude uses this when deciding to delegate',
    '讓 Claude 可以委派工作給它': 'Let Claude delegate work to it',
    '進階：偵測、安裝、登入': 'Advanced: detection, install, sign-in',
    '版本參數': 'Version args',
    '登入狀態參數': 'Auth status args',
    '例如 auth status（可空）': 'e.g. auth status (optional)',
    '登入參數': 'Sign-in args',
    '例如 login（可空）': 'e.g. login (optional)',
    '安裝指令': 'Install command',
    'PowerShell 指令，例如 npm install -g …': 'PowerShell command, e.g. npm install -g …',
    '說明網址': 'Docs URL',
    '已新增「{name}」，填好後按「儲存」': 'Added "{name}". Fill it in and click Save.',
    '刪除自訂 Agent「{name}」？（按「儲存」後生效，對話記錄保留）': 'Delete custom agent "{name}"? (Applies on Save; chat history is kept)',
    '已刪除，按「儲存」後生效': 'Deleted. Click Save to apply.',

    // ---- 給 Agent 的上下文 ----
    '圖片': 'Image',
    '檔案': 'File',
    '[使用者附上的檔案，請直接讀取]': '[Files attached by the user — read them directly]',
    '使用者 → {name}：{text}': 'User → {name}: {text}',
    '{name}：{text}': '{name}: {text}',
    '[你上次回覆之後，使用者在同一個對話裡和其他 Agent 的往來，供參考]': '[For reference: what the user and the other agents said in this chat since your last reply]',
    '[這個對話先前的內容，供參考]': '[For reference: the earlier part of this chat]',
    '[以上]': '[End of reference]',
    '請看附件。': 'Please see the attachments.',
    '（附件）': '(attachments)',
    '…（略）': '… (truncated)',

    // ---- 主程序 ----
    '找不到對話': 'Chat not found',
    '這個對話還在執行中': 'This chat is still running',
    '工作資料夾不存在：{cwd}': 'Working folder does not exist: {cwd}',
    '{name} 還沒加入，請到設定加入': '{name} is not added. Add it in Settings.',
    '這個對話目前沒有在執行的 Claude 回合': 'No Claude turn is running in this chat',
    '{name} 沒有加入 AgentDesk': '{name} is not added to AgentDesk',
    '執行檔': 'Executables',
    '全部': 'All files',
    '找不到 {name} CLI：{cli}（請到設定檢查 CLI 路徑）': '{name} CLI not found: {cli} (check the CLI path in Settings)',
    '{name} 是 .cmd/.bat 啟動，prompt 只能用 stdin 傳入（請到設定改）': '{name} starts through a .cmd/.bat file, so the prompt must go through stdin (change it in Settings)',
    '無法啟動 {name}：{error}': 'Could not start {name}: {error}',
    '{name} 結束碼 {code}': '{name} exited with code {code}',
    '自訂 Agent 沒有模型清單，請直接輸入模型名稱': 'Custom agents have no model list — type the model name',
    '讀不到模型清單': 'Could not read the model list',
    '逾時': 'Timed out',
    '完成後可以關閉這個視窗，回到 AgentDesk 按「重新偵測」。': 'When it finishes, close this window and click "Re-check" in AgentDesk.',
    '這個 Agent 沒有設定安裝指令': 'This agent has no install command',
    '還沒找到 CLI，請先安裝或指定路徑': 'CLI not found yet. Install it or locate it first.',
    '這個 Agent 沒有設定登入參數': 'This agent has no sign-in arguments',
    '安裝 {name}': 'Install {name}',
    '登入 {name}': 'Sign in to {name}',
  };

  let lang = 'zh-TW';
  function setLang(l) { lang = l === 'en' ? 'en' : 'zh-TW'; }
  function getLang() { return lang; }
  function t(key, vars) {
    let s = lang === 'en' && Object.prototype.hasOwnProperty.call(EN, key) ? EN[key] : key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
    return s;
  }
  // 系統語言 → 介面語言：繁體中文（台灣、香港、澳門、Hant）用中文，其他一律英文
  function pickLang(setting, systemLangs) {
    if (setting === 'zh-TW' || setting === 'en') return setting;
    const first = String((systemLangs || [])[0] || '').toLowerCase();
    return /^zh[-_](hant|tw|hk|mo)/.test(first) ? 'zh-TW' : 'en';
  }

  const api = { t, setLang, getLang, pickLang, EN };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.I18n = api;
})(this);
