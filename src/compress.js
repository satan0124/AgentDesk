// 壓縮：對話太長時，請 Agent 替「還沒進索引的段落」各寫一行索引，之後清掉各 Agent 的 session，
// 每一輪改附「索引＋最近幾則原文」，細節讓 Agent 照編號回逐字稿（transcript.js）去讀。
// 索引只是指標，原文都留在逐字稿裡；索引只追加，不整份重寫（重寫一次就掉一次細節）。
// 這裡只有純函式（給 Agent 的話、讀 Agent 寫回來的索引、之後每輪附的內容）；跑 Agent 與寫檔在 main.js。
const path = require('path');
const { budgetOf } = require('./context');
const { NOTE, partsText } = require('./shared/reduce');

const SEP = '｜';
const KEEP = 4;          // 索引涵蓋的段落裡，最後幾則仍然附原文：剛壓縮完的那一輪才接得上話
const FIELD_MAX = 300;   // 索引一欄最長幾個字（Agent 寫太長時截短，細節本來就該留在逐字稿）
const FRESH_BASE = 40000;   // 開乾淨的 session 時，一個請求的基本盤（系統提示、工具說明；實測 Claude 約 4.7 萬、Codex 約 2 萬）
const CHUNK_MAX = 100000;   // 段落原文直接放進 prompt 時，一批最多幾個字（超過就分批，每批各開一個 session）
const FILES_MAX = 5;     // 一筆索引由 AgentDesk 補的「改過的檔」最多列幾個
// 沒傳翻譯函式時（單元測試）照樣代入 {name} 這類佔位
const same = (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => (v && v[k] !== undefined ? v[k] : m));
const oneLine = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

// 請 Agent 寫索引的 prompt。第一行的「#起–#迄」是這次要寫的範圍。
// state：沒有進程檔的對話另外要「現況／下一步」兩行（有進程檔的由進程檔的續傳指引負責）
// text：那幾段的逐字稿原文（開乾淨的 session 時直接附上，不用它讀檔）；空的就請它自己看逐字稿（接續原本的 session 時）
function compressPrompt({ file, from, to, tr = same, state = false, text = '' }) {
  return [
    tr('[AgentDesk 壓縮 #{from}–#{to}]', { from, to }),
    tr('這個對話要壓縮。請替逐字稿第 #{from} 到 #{to} 段寫索引。這一輪只寫索引：不要修改任何檔案，也不要做別的事。', { from, to }),
    text ? tr('第 #{from} 到 #{to} 段的逐字稿原文附在最後（每則訊息一段，標題是「## #編號 誰 · 時間」），照這些內容寫，不用再讀檔。完整逐字稿在 {file}。', { from, to, file })
      : tr('逐字稿：{file}（每則訊息一段，標題是「## #編號 誰 · 時間」）。沒看過或記不清楚的段落，先讀逐字稿再寫。', { file }),
    tr('格式：每行一筆，四欄用全形的「｜」分開。只輸出索引行，不要表格、標題或其他說明。'),
    tr('#起–#迄｜主題｜結論｜相關檔案'),
    tr('- 連續談同一件事的段落合成一筆，換了話題就另起一筆。編號要涵蓋 #{from} 到 #{to}，不跳號、不重疊。', { from, to }),
    tr('- 結論寫定下來的事：做了什麼決定、改了哪裡、關鍵的數字與名稱。還沒有結論就寫「未定」。'),
    tr('- 相關檔案只寫談到但沒有改的檔案路徑，多個用「、」分開，沒有就寫「-」。改過的檔案 AgentDesk 會從動作記錄補上。'),
    tr('- 一筆一行，寫短。細節留在逐字稿，索引只要讓人知道去哪一段找。'),
    tr('例：#3–#8｜登入失敗時沒有錯誤訊息｜原因是 api.js 吞掉 401，已改成往上拋｜src/login.js'),
    ...(state ? [
      tr('索引行寫完後，最後另外寫兩行（只有這兩行不是索引行），講整個對話到 #{to} 為止的狀態：', { to }),
      tr('現況：做到哪裡、定了什麼（一行）'),
      tr('下一步：接下來要做或還沒解決的事，沒有就寫「-」（一行）'),
    ] : []),
    ...(text ? ['', tr('[逐字稿 #{from}–#{to} 原文開始]', { from, to }), String(text).trim(), tr('[逐字稿原文結束。照前面的格式輸出。]')] : []),
  ].join('\n');
}

// ---------- 邊對話邊記 ----------
// 每一輪請 Agent 在回覆最後另起一行寫這一輪的索引（它這時看得到整輪內容，不用事後重讀逐字稿）。
// main.js 在回合結束時取出存到 assistant 訊息的 note，那一行從畫面與存檔拿掉（見 shared/reduce.js 的 stripMark）。
// 壓縮時有 note 的段落直接用，只有沒記到的段落才請 Agent 寫。prev：上一輪的主題，同一件事照抄，之後才合得起來
function noteAsk({ prev, tr = same } = {}) {
  return prev
    ? tr('[AgentDesk 索引：回覆的最後另起一行，寫 {mark} 主題｜結論｜相關檔案。主題用幾個字講這一輪在談什麼，跟上一輪是同一件事就照抄「{prev}」。結論寫定下來的事（決定、改了哪裡、關鍵數字），沒有就寫「未定」。相關檔案寫談到的檔案路徑，用「、」分開，沒有就寫「-」。這一行使用者看不到。]', { mark: NOTE, prev })
    : tr('[AgentDesk 索引：回覆的最後另起一行，寫 {mark} 主題｜結論｜相關檔案。主題用幾個字講這一輪在談什麼。結論寫定下來的事（決定、改了哪裡、關鍵數字），沒有就寫「未定」。相關檔案寫談到的檔案路徑，用「、」分開，沒有就寫「-」。這一行使用者看不到。]', { mark: NOTE });
}
// 從回覆裡取出那一行（有好幾行就用最後一行）：{ topic, result, files }，沒寫就是 null
function parseNote(text) {
  let got = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    // 只認行首的標記（同 shared/reduce.js 的 stripMark），內文提到標記的不算
    const l = raw.replace(/^[ \t>*_`-]*/, '');
    if (!l.startsWith(NOTE)) continue;
    const f = l.slice(NOTE.length).replace(/^\s*[:：]?\s*/, '').replace(/[`*_\s]+$/, '').split(/\s*[｜|]\s*/).map(s => oneLine(s, FIELD_MAX));
    if (f[0]) got = { topic: f[0], result: f[1] || '-', files: f.slice(2).filter(Boolean).join('、') || '-' };
  }
  return got;
}
const vague = s => !s || /^(-|未定|TBD|N\/A|none)$/i.test(String(s).trim());
const topicKey = s => String(s || '').replace(/[\s「」“”"'`]/g, '').toLowerCase();
const fileList = s => String(s || '').split(/\s*[、,，;；]\s*/).map(x => x.trim()).filter(x => x && x !== '-');
// 合併時的結論：不同的結論用「；」接起來（實測 Codex 把幾個相關的問題都歸在同一個主題，只留最新的會丟掉前面的答案）；
// 太長就從前面截掉，最新的一定留著。最新的是「未定」就不接
function joinResult(a, b) {
  if (vague(b)) return a;
  if (vague(a) || a === b || a.endsWith(`；${b}`)) return vague(a) ? b : a;
  const s = `${a}；${b}`;
  return s.length > FIELD_MAX ? '…' + s.slice(s.length - FIELD_MAX + 1) : s;
}
// 第 from 到 to 段裡記下的索引（messages 是整個對話，編號 1 起）。一輪是使用者那則加上回覆那則；
// 連續幾輪主題相同的合成一筆：範圍接起來、結論接起來（見 joinResult）、檔案合併
function noteEntries(messages, from, to) {
  const out = [];
  for (let k = from; k <= to; k++) {
    const m = messages[k - 1];
    if (!m || m.role === 'user' || !m.note?.topic) continue;
    const a = k > from && messages[k - 2]?.role === 'user' ? k - 1 : k;
    const p = out[out.length - 1];
    if (p && p.to + 1 === a && topicKey(p.topic) === topicKey(m.note.topic)) {
      p.to = k;
      p.result = joinResult(p.result, m.note.result);
      const files = [...new Set([...fileList(p.files), ...fileList(m.note.files)])];
      p.files = files.length ? files.join('、') : '-';
    } else out.push({ from: a, to: k, topic: m.note.topic, result: m.note.result || '-', files: m.note.files || '-' });
  }
  return out;
}
// 第 from 到 to 段裡還要請 Agent 寫的範圍：沒被 entries 涵蓋、而且裡面有 Agent 回覆文字的（只有出錯或停掉的回合，補佔位就好）
function noteHoles(messages, entries, from, to) {
  const out = [];
  let next = from;
  const add = (a, b) => { if (messages.slice(a - 1, b).some(m => m.role !== 'user' && partsText(m.parts).trim())) out.push([a, b]); };
  for (const e of [...entries].sort((x, y) => x.from - y.from)) {
    if (e.from > next) add(next, e.from - 1);
    next = Math.max(next, e.to + 1);
  }
  if (next <= to) add(next, to);
  return out;
}

// 段落太多時切成幾批：lengths 是第 from 段起每一段的字數，每批加起來不超過 max（單一段超過就自己一批）。回傳 [[起, 迄], …]
function chunkRanges(lengths, from, max = CHUNK_MAX) {
  const out = [];
  let a = from, sum = 0;
  lengths.forEach((n, i) => {
    const k = from + i;
    if (sum && sum + n > max) { out.push([a, k - 1]); a = k; sum = 0; }
    sum += n;
  });
  if (lengths.length) out.push([a, from + lengths.length - 1]);
  return out;
}

// 從寫索引的回覆裡挑出「現況／下一步」兩行（三種語言的開頭都收，前面的條列符號與粗體略過）。兩行都沒有就是 null
const STATE_NOW = /^(?:現況|现况|现状|Current state|Now)\s*[:：]\s*(.+)$/i;
const STATE_NEXT = /^(?:下一步|Next steps?|Next)\s*[:：]\s*(.+)$/i;
function parseState(text) {
  let now = '', next = '';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const l = raw.trim().replace(/^[-*•]\s+/, '').replace(/\*\*/g, '').trim();
    const a = l.match(STATE_NOW), b = l.match(STATE_NEXT);
    if (a && !now) now = oneLine(a[1], FIELD_MAX);
    else if (b && !next) next = oneLine(b[1], FIELD_MAX);
  }
  return now || next ? { now: now || '-', next: next || '-' } : null;
}

// 寫索引要不要接續原本的 session。
//   seen：這個 session 從第幾則（1 起）之後的原文都看過（main.js 在 session 開的時候記）；from：這次從第幾段寫起
//   tokens：session 大小（conv.sizes，不知道就是空的）；chars：要寫的段落在逐字稿裡的字數
// 接續只有在 session 看過全部要寫的段落時才便宜：一個請求就寫完。沒看過的話它得回頭讀逐字稿，
// 每讀一段就把整個大 session 重送一次（實測 30.7 萬的 session 跑了 22 個請求、550 萬 tokens）。
// 看過的話再比成本：接續是一個 session 大小的請求；開乾淨的是基本盤加上段落原文（兩個字粗估一個 token）
function resumeForIndex({ tokens, chars = 0, seen, from } = {}) {
  if (!seen || !from || seen > from) return false;
  if (!tokens) return true;
  return tokens <= FRESH_BASE + chars / 2;
}

// ---------- 索引寫完後由 AgentDesk 補與核對 ----------
// 會改檔的工具（小寫比對）：Claude 的 Write/Edit/MultiEdit/NotebookEdit、Codex 的 edit、Cursor 的 write/edit/delete、Gemini 的 write_file/replace 等
const EDIT_TOOLS = new Set(['write', 'edit', 'multiedit', 'notebookedit', 'delete', 'write_file', 'replace', 'create_file', 'edit_file',
  'write_to_file', 'replace_file_content', 'multi_replace_file_content']);
const slash = p => p.replace(/\\/g, '/');
const baseName = p => slash(String(p || '')).replace(/\/+$/, '').split('/').pop();
// 工具記錄的 detail 轉成路徑清單。Codex 的 edit 是「update E:\a.cs, add E:\b.cs」；NotebookEdit 的 detail 是參數的 JSON
function toolPaths(name, detail) {
  const d = String(detail || '').trim();
  if (!d) return [];
  if (d.startsWith('{')) { const m = d.match(/"(?:notebook_path|file_path|path)"\s*:\s*"((?:[^"\\]|\\.)+)"/); return m ? [m[1].replace(/\\\\/g, '\\')] : []; }
  if (name === 'edit' && /,\s/.test(d)) return d.split(/,\s+/).map(s => s.replace(/^(add|update|delete|remove|create|modify|rename)\s+/i, '').trim()).filter(Boolean);
  return [d.replace(/^(add|update|delete|remove|create|modify|rename)\s+(?=[A-Za-z]:[\\/]|[\\/.])/i, '')];
}
// 一段訊息裡改過的檔（工具失敗的不算；委派卡片裡對方改的也算）。只留工作資料夾裡的，轉成相對路徑，去重、照出現順序。
// 工作資料夾外面的（例如專案搬家前的舊路徑、Agent 自己的設定檔）不收：索引只是指標，列太多反而難找
function editedFiles(messages, cwd) {
  const out = [], seen = new Set();
  const root = cwd ? path.resolve(cwd) : '';
  const add = p => {
    let r = p;
    if (root && path.isAbsolute(p)) {
      const rel = path.relative(root, path.resolve(p));
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
      r = rel;
    }
    r = slash(r);
    const k = r.toLowerCase();
    if (r && !seen.has(k)) { seen.add(k); out.push(r); }
  };
  const walk = parts => {
    for (const p of parts || []) {
      if (p.kind === 'delegate') walk(p.parts);
      else if (p.kind === 'tool' && p.status !== 'error' && EDIT_TOOLS.has(String(p.name || '').toLowerCase())) toolPaths(String(p.name).toLowerCase(), p.detail).forEach(add);
    }
  };
  for (const m of messages || []) if (m.role !== 'user') walk(m.parts);
  return out;
}
// 檔案清單寫成索引的一欄：太多只留前幾個並註明還有幾個；沒有就是「-」
function fileField(files, tr = same) {
  if (!files.length) return '-';
  const shown = files.slice(0, FILES_MAX).join(tr('、'));
  return files.length > FILES_MAX ? shown + tr('（另 {n} 個）', { n: files.length - FILES_MAX }) : shown;
}
// 檔名有沒有出現在文字裡（前後不能接著檔名用的字，免得 a.js 對到 data.js）
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text, name) => new RegExp(`(^|[^\\w.-])${esc(name)}(?![\\w-])`, 'i').test(text);

// 核對並補完 Agent 寫回來的索引（不花額度）：
// - 相關檔案：Agent 寫的逐個查，檔名沒出現在那幾段逐字稿裡、工作資料夾裡也沒有的拿掉（摘要會編造路徑）；
//   改過的檔以動作記錄為準排在前面，Agent 寫的補在後面（同檔名的不重複）。
// - 範圍：照起點排好；中間漏掉的段落補一筆「沒有索引」的佔位（列出那幾段改過的檔），重疊的只計數。數字與結論不查（比對不準）。
// segText(a, b)：第 a 到 b 段的逐字稿文字；edited(a, b)：第 a 到 b 段改過的檔
// exists(f)：f 在工作資料夾裡真的有（有的就留，例如 Agent 當輪讀過、回覆裡只寫了「三種語言」沒寫檔名）
function verifyIndex(entries, { from, to, segText, edited, tr = same, exists = () => false }) {
  let dropped = 0, overlaps = 0;
  const gaps = [];
  const fix = e => {
    const text = segText(e.from, e.to);
    const mech = edited(e.from, e.to);
    const names = new Set(mech.map(f => baseName(f).toLowerCase()));
    const extra = [];
    for (const raw of String(e.files || '').split(/\s*[、,，;；]\s*/)) {
      const f = raw.trim().replace(/^`+|`+$/g, '');
      if (!f || f === '-') continue;
      const name = baseName(f);
      if (!name || !(text.toLowerCase().includes(f.toLowerCase()) || mentions(text, name) || exists(f))) { dropped++; continue; }
      if (!names.has(name.toLowerCase())) { names.add(name.toLowerCase()); extra.push(f); }
    }
    return { ...e, files: fileField([...mech, ...extra], tr) };
  };
  const sorted = [...entries].sort((a, b) => a.from - b.from || a.to - b.to);
  const out = [];
  let next = from;
  const hole = (a, b) => { gaps.push([a, b]); out.push({ from: a, to: b, topic: tr('（沒有索引）'), result: '-', files: fileField(edited(a, b), tr) }); };
  for (const e of sorted) {
    if (e.from > next) hole(next, e.from - 1);
    else if (e.from < next) overlaps++;
    out.push(fix(e));
    next = Math.max(next, e.to + 1);
  }
  if (out.length && next <= to) hole(next, to);
  return { entries: out, dropped, gaps, overlaps };
}

// 從 Agent 的回覆裡挑出索引行。行首要是「#數字」，範圍可以寫 #3–#8、#3-8、#3~#8、#3 到 #8，單一段寫 #5；
// 欄位用全形或半形的直線分開。不合格式的行（說明、表格線）略過；超出這次範圍的截掉，完全在範圍外的不收
function parseIndex(text, { from = 1, to = Infinity } = {}) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const l = raw.trim().replace(/^[-*•]\s+/, '').replace(/^[|｜]\s*/, '').replace(/\s*[|｜]$/, '').replace(/^`+|`+$/g, '');
    const m = l.match(/^#(\d+)\s*(?:(?:[–—~～-]|到|至|to)\s*#?(\d+))?\s*[｜|]\s*(.+)$/i);
    if (!m) continue;
    let a = +m[1], b = m[2] ? +m[2] : a;
    if (a > b) [a, b] = [b, a];
    if (b < from || a > to) continue;
    const f = m[3].split(/\s*[｜|]\s*/).map(s => oneLine(s, FIELD_MAX));
    if (!f[0]) continue;
    out.push({ from: Math.max(a, from), to: Math.min(b, to), topic: f[0], result: f[1] || '-', files: f.slice(2).filter(Boolean).join('、') || '-' });
  }
  return out;
}
const indexLine = e => `#${e.from}–#${e.to}${SEP}${e.topic}${SEP}${e.result}${SEP}${e.files}`;

// 索引檔開頭的說明（檔案第一次建立時寫一次，之後只往後加索引行）
function indexHead(title, tr = same) {
  return [
    `# ${tr('{title} 索引', { title: !title || title === '新對話' ? tr('新對話') : oneLine(title, 200) })}`,
    '',
    `- ${tr('這份檔是 AgentDesk 壓縮對話時請 Agent 寫的索引，每行一筆：#起–#迄｜主題｜結論｜相關檔案。')}`,
    `- ${tr('編號對應同一個資料夾裡 transcript.md 的段落。索引只是指標，原文以逐字稿為準。')}`,
    '',
    '',
  ].join('\n');
}
// 索引檔裡的索引行（行首是「#數字」；開頭的說明與空行不算）
const indexLines = md => String(md || '').split(/\r?\n/).map(l => l.trim()).filter(l => /^#\d/.test(l));

// 壓縮之後、沒有 session 的 Agent 每一輪拿到的開頭：怎麼用索引與逐字稿＋索引本身（最近幾則原文由 main.js 接在後面）。
// 索引太長時只附最新的幾筆，其餘請它讀索引檔
// state：壓縮當時的「現況／下一步」（{ now, next, at }，沒有進程檔的對話才有），接在索引後面
function indexContext({ lines, file, index, level, tr = same, state }) {
  const max = budgetOf(level).total;
  const picked = [];
  let used = 0;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (picked.length && used + lines[k].length > max) break;
    picked.unshift(lines[k]);
    used += lines[k].length + 1;
  }
  const skipped = lines.length - picked.length;
  return [
    tr('[這個對話壓縮過：較早的內容只留索引。以下是索引與最近幾則原文，供參考]'),
    tr('逐字稿：{file}（完整原文，每則訊息一段，標題是「## #編號 誰 · 時間」）', { file }),
    tr('- 需要細節時，照索引上的編號去讀逐字稿的那幾段，不要只憑索引推測。'),
    tr('- 索引沒提到的事，先在逐字稿裡搜尋；不能因為索引沒寫就當作沒發生過。'),
    tr('索引（每行：#起–#迄｜主題｜結論｜相關檔案）：'),
    ...(skipped ? [tr('（較早的 {n} 筆索引沒有附上，完整索引在 {file}）', { n: skipped, file: index })] : []),
    ...picked,
    ...(state ? [
      tr('壓縮當時（到 #{n}）的狀態，之後的發展看後面的原文：', { n: state.at }),
      tr('現況：{text}', { text: state.now }),
      tr('下一步：{text}', { text: state.next }),
    ] : []),
  ].join('\n');
}

module.exports = { KEEP, FRESH_BASE, CHUNK_MAX, compressPrompt, noteAsk, parseNote, noteEntries, noteHoles, chunkRanges, parseState, resumeForIndex, editedFiles, verifyIndex, parseIndex, indexLine, indexHead, indexLines, indexContext };
