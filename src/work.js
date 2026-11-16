// 工作模式的「工作」：一個工作有名字與一份進程檔 <工作資料夾>/docs/進程/<工作名>.md。
// 進程檔是交接檔：任務、進度、決策、驗證都寫在裡面，換對話或換 Agent 時讀它就能接續。
// 這裡只有純函式（檔名、範本、給 Agent 的指示）；建檔在 main.js。
const path = require('path');

const DIR = ['docs', '進程'];
// 沒傳翻譯函式時（單元測試）照樣代入 {name} 這類佔位
const same = (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => (v && v[k] !== undefined ? v[k] : m));

// 工作名 → 可以當檔名的字串：拿掉 Windows 不能用的字元與結尾的點、空白，太長就截
function safeName(name) {
  return String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 60).trim();
}
// 對話上記的工作：{ name, file }，file 是相對工作資料夾的路徑；名字清完是空的就回 null
function makeWork(name) {
  const n = safeName(name);
  return n ? { name: n, file: [...DIR, `${n}.md`].join('/') } : null;
}
const workPath = (cwd, work) => path.join(cwd, ...work.file.split('/'));

// 進程檔範本。「▶」標出續傳指引那一段、任務清單是檔案裡第一張表格，之後讀檔的程式靠這兩點找，不靠標題文字（標題會跟著介面語言）
function template(name, date, tr = same) {
  return [
    `# ${tr('{name} 進程', { name })}`,
    '',
    tr('這份檔是「{name}」的交接檔，給接手的對話讀。它記進度與決策；程式現況以檔案為準，引用前先看檔案。', { name }),
    '',
    `## ▶ ${tr('續傳指引（新對話先讀這段）')}`,
    `- ${tr('現況（{date}）：剛建立，還沒列任務。', { date })}`,
    `- ${tr('下一步：列任務清單與順序，給使用者核准。')}`,
    `- ${tr('在等：使用者核准任務清單。')}`,
    `- ${tr('規則：（使用者交代的做事規則寫在這裡）')}`,
    '',
    `## ${tr('目標')}`,
    tr('（要做什麼、做到什麼程度算完成）'),
    '',
    `## ${tr('任務清單')}`,
    `| # | ${tr('任務')} | ${tr('狀態')} | ${tr('依賴')} | ${tr('落地檔')} | ${tr('續傳 context')} |`,
    '|---|---|---|---|---|---|',
    '',
    `## ${tr('決策記錄')}`,
    `- ${tr('（日期　決定了什麼、為什麼）')}`,
    '',
    `## ${tr('驗證記錄')}`,
    `- ${tr('（日期　跑了什麼、結果）')}`,
    '',
  ].join('\n');
}

// 給 Agent 的工作指示。main：使用者直接對話的 Agent；delegate：Claude 委派出去的 Agent（只要知道背景在哪，不維護進程檔）
function workNote({ work, file, role = 'main', tr = same }) {
  if (role === 'delegate') {
    return tr('[工作：{name}。進程檔：{file}，需要背景時先讀它；進程檔由交辦工作的 Agent 維護，你不用改。]', { name: work.name, file });
  }
  return [
    tr('[工作模式：{name}]', { name: work.name }),
    tr('進程檔：{file}（這個工作的交接檔，先讀它再動手）', { file }),
    tr('- 進程檔還沒有任務清單時：先列任務與順序，寫進進程檔並回覆給使用者，等使用者核准後才修改其他檔案。'),
    tr('- 有進展的那一輪，結束前回寫進程檔：任務狀態、「▶」那段續傳指引、決策與驗證記錄；沒有進展就不用寫。'),
    tr('- 進程檔只記進度與決策，不貼大段程式碼。'),
  ].join('\n');
}

// ---------- 讀進程檔（右欄的工作現況、接續工作的清單） ----------
// 狀態欄開頭是「完成／Done／✅」這類字才算做完（「完成（未提交）」算，「未完成」不算）
const isDone = s => /^\s*(✅|✔|☑|\[x\]|已?完成|done|completed?|finished)/i.test(s || '');
const plain = s => String(s || '').replace(/[*`]/g, '').trim();
// 靠位置找，不靠標題文字（標題跟著介面語言，Agent 也可能改寫）：
//   resume：標題帶「▶」的那一段裡，最外層的條列
//   tasks：檔案裡第一張表格，前三欄當成 編號｜任務｜狀態
function parseWork(md) {
  const lines = String(md || '').split(/\r?\n/);
  const resume = [];
  let i = lines.findIndex(l => /^#{1,6}\s.*▶/.test(l));
  if (i >= 0) {
    for (i++; i < lines.length && !/^#{1,6}\s/.test(lines[i]); i++) {
      const m = lines[i].match(/^[-*]\s+(.*)$/);
      if (m && plain(m[1])) resume.push(plain(m[1]));
    }
  }
  const tasks = [];
  const cells = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => plain(c.replace(/\\\|/g, '|')));
  const h = lines.findIndex((l, k) => /^\s*\|/.test(l) && /^\s*\|?\s*:?-{3,}/.test(lines[k + 1] || ''));
  if (h >= 0) {
    for (let k = h + 2; k < lines.length && /^\s*\|/.test(lines[k]); k++) {
      const c = cells(lines[k]);
      if (c.some(Boolean)) tasks.push({ id: c[0] || '', title: c[1] || '', status: c[2] || '', done: isDone(c[2]) });
    }
  }
  return { resume, tasks };
}
// 資料夾裡現成的進程檔 → 對話上記的工作。檔名原樣當工作名，不經過 safeName（改了就對不上原檔）
function workFromFile(base) {
  const n = String(base || '');
  return n && !/[\\/]/.test(n) && n !== '.' && n !== '..' ? { name: n, file: [...DIR, `${n}.md`].join('/') } : null;
}

module.exports = { DIR, safeName, makeWork, workPath, template, workNote, parseWork, workFromFile, isDone };
