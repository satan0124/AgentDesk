// 對話／工作模式：每個對話各自記在 conv.mode。
//   chat（對話）：問問題、討論、查資料，Agent 唯讀
//   work（工作）：照設定頁的權限
const { MARK } = require('./shared/reduce');
const { workNote } = require('./work');
const MODES = ['chat', 'work'];
// 沒傳翻譯函式時（單元測試）照樣代入 {mark}
const same = (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => (v && v[k] !== undefined ? v[k] : m));

// 沒有 mode 的舊對話一律當「對話」（唯讀）：要讓 Agent 改檔，由使用者自己切到工作模式
function modeOf(conv) {
  return MODES.includes(conv?.mode) ? conv.mode : 'chat';
}

// 給 Agent 的模式說明，回傳 { system, prefix, key }。
//   told：這個 Agent 目前的 session 上次收到的 key（沒有 session 就不傳）；key 由呼叫端記下來，下一輪再傳回來。
//   對話模式：每一輪都帶。Claude 放 system prompt（不會留在 session 裡），其他 Agent 放在 prompt 最前面。
//   工作模式：同一個 session 先前被告知「唯讀」時，補一句可以改檔了。
//   工作模式且有工作名（work、file＝進程檔完整路徑）：再帶工作指示（work.js）。Claude 當主 Agent 時放 system prompt、每輪都帶；
//     其他 Agent 與被委派的 Agent（role: 'delegate'）只在這個 session 還沒收過時放在 prompt 最前面。
// 內建 Agent 另外有旗標擋著（agents.js 的 buildCommand）；自訂 Agent 擋不了，只能靠這段說明。
function modeNotes({ mode, told, agent, tr = same, work, file, role = 'main' }) {
  if (mode === 'chat') {
    const note = tr('[對話模式：唯讀。不要建立、修改或刪除檔案，也不要執行會改動檔案的指令。需要改檔時，先說明要改什麼，再於回覆最後另起一行只寫 {mark}，AgentDesk 會請使用者決定要不要切換到工作模式。]', { mark: MARK });
    return agent === 'claude' ? { system: note, prefix: '', key: 'chat' } : { system: '', prefix: note, key: 'chat' };
  }
  const lines = told === 'chat' ? [tr('[已切換到工作模式：可以修改檔案了。]')] : [];
  if (!work) return { system: '', prefix: lines.join('\n'), key: 'work' };
  const key = `work:${role}:${work.name}`;
  const note = workNote({ work, file, role, tr });
  if (agent === 'claude' && role === 'main') return { system: note, prefix: lines.join('\n'), key };
  if (told !== key) lines.push(note);
  return { system: '', prefix: lines.join('\n'), key };
}

// 被委派的 Agent 回覆的收尾格式：委派它的 Agent（Claude）只拿得到有上限的回覆，固定幾行收尾讓它一眼看到結果。
// 每次委派都附在 prompt 最後（只管這一次的回覆）
function delegateTail(tr = same) {
  return [
    tr('[回覆最後用下面三行收尾，給委派你的 Agent 看：'),
    tr('做了什麼：…'),
    tr('改了哪些檔：…（沒有就寫「-」）'),
    tr('沒做完或要注意的：…（沒有就寫「-」）]'),
  ].join('\n');
}

// 「極度節省 token」規則：設定頁每個 Agent 各自開關（agents[id].frugal），由 AgentDesk 附在 prompt 裡。
// 不寫進各 CLI 自己的規則檔：不是每個 CLI 都有全域規則檔（Codex 有 ~/.codex/AGENTS.md，Cursor CLI 只讀專案資料夾裡的），
// 由 AgentDesk 附上對任何 CLI 都有效，代價是只在 AgentDesk 裡有效。附在哪、多久附一次見 main.js 的 notesFor
function frugalNote(tr = same) {
  return [
    tr('[極度節省 token：把自己當成極度小氣的 AI，能省的 token 絕不浪費。'),
    tr('- 工作過程不寫旁白：工具呼叫之間不報告正在做什麼、查到什麼、下一步是什麼。'),
    tr('- 只在收尾回覆結果；能一行講完就一行。'),
    tr('- 不重述已講過的內容，不做使用者沒要的盤點或延伸。'),
    tr('- 省的是字數，不是事實：壞消息、未驗證、待決事項照常講。]'),
  ].join('\n');
}

// 規則放哪：'system'（Claude 當主 Agent：放 system prompt、每輪都帶，不會留在 session 裡）、
// 'prefix'（其他 Agent 與被委派的：放在 prompt 最前面，這個 session 還沒收過才附）、''（不附）。
//   on：設定頁有沒有替這個 Agent 打開；hasSession：這一輪是不是接續原本的 session；ruled：這個 session 是不是已經收過
function frugalPlace({ on, agent, role = 'main', hasSession, ruled }) {
  if (!on) return '';
  if (agent === 'claude' && role === 'main') return 'system';
  return hasSession && ruled ? '' : 'prefix';
}

// 對話模式的回合結束後：Agent 是不是想改檔卻做不了。是的話回傳 { denied: [被拒的動作…] }，畫面會出現切換按鈕。
//   text：這一輪所有回覆文字（找約定的標記）
//   denials：Claude 的 result 事件帶的 permission_denials（[{ tool, detail }]，agents.js 整理過）
//   permission：設定頁的 Claude 權限。指令類（Bash）被拒時，只有切到工作模式真的會放行才算，不然按了也沒用
const EDIT_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit)$/;
const RUN_TOOLS = /^(Bash|PowerShell)$/;
function needWork({ text, denials, permission }) {
  const runOk = permission === 'bypassPermissions' || permission === 'auto';
  const denied = (denials || []).filter(d => EDIT_TOOLS.test(d.tool) || (runOk && RUN_TOOLS.test(d.tool)));
  if (!denied.length && !String(text || '').includes(MARK)) return null;
  return { denied: [...new Set(denied.map(d => `${d.tool} ${d.detail || ''}`.trim()))].slice(0, 5) };
}

// 唯讀跑過一輪之後，同一個 session 回不到可寫的 CLI。2026-11 用真的 CLI 試過：
//   Cursor：用 --mode ask 跑過的 session，接續時改帶 --force，回覆仍說自己在 Ask 模式、不肯寫檔。
//           反過來沒問題：可寫的 session 接續時帶 --mode ask 有擋下。
//   Codex：每一輪照當次的 sandbox_mode，兩個方向都正常，不在這裡。
const STICKY = new Set(['cursor']);
const stickyReadOnly = agent => STICKY.has(agent);
// 切到工作模式後，這個 Agent 原本的 session 是不是得丟掉重開。
//   told：這個 session 上次收到的說明（main.js 的 notesFor 記的 key，'chat' 表示上一輪是唯讀跑的）
//   permission：設定頁給這個 Agent 的權限。工作模式本來就選唯讀（ask／plan）的話旗標沒變，不用重開
function mustRestart({ agent, mode, told, permission }) {
  return mode === 'work' && told === 'chat' && stickyReadOnly(agent) && (permission || 'force') === 'force';
}

module.exports = { MODES, modeOf, modeNotes, delegateTail, frugalNote, frugalPlace, needWork, stickyReadOnly, mustRestart };
