// 逐字稿：把一個對話機械地寫成一份 Markdown，每則訊息一段，段落編號是 #N。
// N 是訊息在對話裡的順位（從 1 起）。訊息只會往後加，所以編號不會變，壓縮時的索引可以拿它當指標。
// 不經過 Agent、不花額度。這裡只有純函式；寫檔在 main.js。

// 沒傳翻譯函式時（單元測試）照樣代入 {name} 這類佔位
const same = (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => (v && v[k] !== undefined ? v[k] : m));
const TOOL_MAX = 200;    // 一次工具呼叫只留一行
const ERROR_MAX = 300;

const pad = n => String(n).padStart(2, '0');
// 本地時間 YYYY-MM-DD HH:mm
function stamp(ts) {
  const d = new Date(ts);
  if (!ts || isNaN(d)) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const oneLine = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const quote = s => String(s || '').trim().split(/\r?\n/).map(l => `> ${l}`.trimEnd()).join('\n');
// 內文裡剛好長得像段落標題的行（行首「## #數字」）前面加反斜線，照編號搜尋時才不會找到別段去
const guard = s => String(s || '').trim().replace(/^(## #\d)/gm, '\\$1');

// 停止、出錯、還沒跑完的訊息（或委派）在段落最後註明，免得被當成完整的回覆
function statusNote(x, tr) {
  if (x.status === 'stopped') return tr('（已停止）');
  if (x.status === 'error') return tr('（錯誤：{text}）', { text: oneLine(x.error, ERROR_MAX) });
  if (x.status === 'running') return tr('（還在執行，內容不完整）');
  return '';
}

// 一則 Agent 訊息的內文：文字原樣、連續的工具呼叫各一行、委派列出交辦內容與對方的回覆；思考過程與工具輸出不收
function partsBody(parts, who, opts) {
  const { label, tr } = opts;
  const out = [];
  let tools = [];
  let named = true;    // 委派那一塊之後，主 Agent 再開口要重新標是誰在講
  const flush = () => { if (tools.length) { out.push(tools.join('\n')); tools = []; } };
  const name = () => { if (!named) { out.push(`**${tr('{name}：', { name: who })}**`); named = true; } };
  for (const p of parts || []) {
    if (p.kind === 'approval') {
      name();
      tools.push(`- ${tr(p.status === 'allowed' ? '使用者允許：{text}' : p.status === 'denied' ? '使用者拒絕：{text}' : '等使用者核准：{text}', { text: oneLine(`${p.tool || ''} ${p.detail || ''}`, TOOL_MAX) })}`);
      continue;
    }
    if (p.kind === 'tool') {
      name();
      tools.push(`- ${tr('工具：{text}', { text: oneLine(`${p.name || 'tool'} ${p.detail || ''}`, TOOL_MAX) })}${p.status === 'error' ? tr('（失敗）') : ''}`);
      continue;
    }
    flush();
    if (p.kind === 'text') {
      if (!String(p.text || '').trim()) continue;
      name();
      out.push(guard(p.text));
    } else if (p.kind === 'notice') {
      if (String(p.text || '').trim()) out.push(quote(p.text));
    } else if (p.kind === 'delegate') {
      const to = label(p.agent) || p.agent || '?';
      out.push(`**${tr('{from} → {to}（委派）：', { from: who, to })}**`, quote(p.prompt));
      out.push(`**${tr('{name}：', { name: to })}**`, partsBody(p.parts, to, opts) || tr('（沒有內容）'));
      const st = statusNote(p, tr);
      if (st) out.push(st);
      named = false;
    }
  }
  flush();
  return out.join('\n\n');
}

// 一段：「## #編號 誰 · 時間」＋內文。n 從 1 起
function entry(m, n, { label = a => a, tr = same } = {}) {
  const opts = { label, tr };
  const who = label(m.agent) || m.agent || '?';
  const time = stamp(m.ts);
  const head = `## #${n} ${m.role === 'user' ? tr('使用者 → {name}', { name: who }) : who}${time ? ` · ${time}` : ''}`;
  const body = [];
  if (m.role === 'user') {
    if (String(m.text || '').trim()) body.push(guard(m.text));
    if (m.attachments?.length) {
      const kind = { image: tr('圖片'), file: tr('檔案'), folder: tr('資料夾') };
      body.push([tr('附件：'), ...m.attachments.map(a => `- ${tr('{name}：{text}', { name: kind[a.kind] || kind.file, text: a.path })}`)].join('\n'));
    }
  } else {
    const b = partsBody(m.parts, who, opts);
    if (b) body.push(b);
    const st = statusNote(m, tr);
    if (st) body.push(st);
  }
  if (!body.length) body.push(tr('（沒有內容）'));
  return [head, ...body].join('\n\n');
}

// 整份逐字稿。label(agent) 取 Agent 的顯示名稱
function transcript(conv, opts = {}) {
  const tr = opts.tr || same;
  const title = !conv?.title || conv.title === '新對話' ? tr('新對話') : oneLine(conv.title, 200);
  const head = [
    `# ${tr('{title} 逐字稿', { title })}`,
    '',
    `- ${tr('這份檔是 AgentDesk 自動產生的對話逐字稿，每一輪結束後整份重寫，手動修改會被蓋掉。')}`,
    `- ${tr('每則訊息一段，標題是「## #編號 誰 · 時間」。要找第 12 段，就搜尋行首的「## #12 」（編號後面有一個空白）。')}`,
    `- ${tr('只記文字、用過的工具與委派；思考過程與工具輸出不收。')}`,
    ...(conv?.cwd ? [`- ${tr('工作資料夾：{cwd}', { cwd: conv.cwd })}`] : []),
  ].join('\n');
  return [head, ...(conv?.messages || []).map((m, i) => entry(m, i + 1, opts))].join('\n\n') + '\n';
}

module.exports = { stamp, entry, transcript };
