// 給 Agent 的上下文：Agent 只記得自己的 session，這裡補上它沒看過的、使用者與其他 Agent 的往來。
// 附帶量會直接吃各家額度，所以有上限（設定頁「附帶上下文」），超過時保留最新的往來與對話開頭的需求。
const BUDGETS = {
  lean: { total: 6000, per: 1500, reply: 6000 },
  standard: { total: 16000, per: 3000, reply: 12000 },
  full: { total: 40000, per: 8000, reply: 30000 },
};
const budgetOf = level => BUDGETS[level] || BUDGETS.standard;
// 沒傳翻譯函式時（單元測試）照樣代入 {n}
const fill = (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => (v && v[k] !== undefined ? v[k] : m));

// 太長的字串保留開頭與結尾（結論通常在最後），中間省略
function clipMid(s, n, tr = fill) {
  s = s || '';
  if (s.length <= n) return s;
  const head = Math.floor(n * 0.6), tail = n - head;
  return s.slice(0, head) + '\n' + tr('…（中間省略 {n} 字）…', { n: s.length - n }) + '\n' + s.slice(-tail);
}

// history：這一輪之前的訊息；msgText(m) 取訊息文字；line(m, 文字, 訊息在 history 裡的位置) 組成「使用者 → X：…」這樣的一行
// recent：只看最近幾則（工作模式有進程檔時用：背景在進程檔裡，不必把整段對話再附一次）
// since：只看 history 裡第幾則之後的（壓縮過的對話用：更早的已經寫進索引，見 compress.js）
function buildContext({ history, agent, hasSession, msgText, line, tr = fill, level, recent = 0, since = 0 }) {
  const b = budgetOf(level);
  let start = Math.max(0, since);
  if (hasSession) {
    for (let i = history.length - 1; i >= start; i--) {
      if (history[i].role === 'assistant' && history[i].agent === agent) { start = i + 1; break; }
    }
  }
  let items = [];
  for (let i = start; i < history.length; i++) {
    const m = history[i];
    if (hasSession && m.agent === agent) continue;
    const t = msgText(m);
    if (t) items.push({ i, m, t });
  }
  // from：從 history 的第幾則（0 起）開始之後的原文全部附上了（壓縮時判斷新開的 session 看過哪些段落用）
  if (!items.length) return { text: '', chars: 0, omitted: 0, from: history.length };
  const total = items.length;
  if (recent > 0 && items.length > recent) items = items.slice(-recent);
  // 從最新往回放，放到上限為止
  const picked = [];
  let used = 0;
  for (let k = items.length - 1; k >= 0; k--) {
    const s = line(items[k].m, clipMid(items[k].t, b.per, tr), items[k].i);
    if (picked.length && used + s.length > b.total) break;
    picked.unshift({ ...items[k], s });
    used += s.length;
  }
  let omitted = total - picked.length;
  // 第一次跟這個 Agent 講話時，對話開頭的需求通常最重要：被擠掉的話補回來（縮短）
  let first = '';
  if (omitted && !hasSession && items[0].i === 0 && items[0].m.role === 'user') {
    first = line(items[0].m, clipMid(items[0].t, Math.floor(b.per / 2), tr), items[0].i);
    omitted--;
  }
  const parts = [];
  if (first) parts.push(first);
  if (omitted) parts.push(tr('（中間較早的 {n} 則往來已省略）', { n: omitted }));
  parts.push(...picked.map(p => p.s));
  const body = parts.join('\n\n');
  return { text: body, chars: body.length, omitted, from: picked[0].i };
}

// 委派結果交回 Claude：有最終回覆就用最終回覆，太長就截。
// save(完整回覆)：把完整回覆存成檔、回傳路徑（存不了回傳空字串）；有路徑就請 Claude 去讀檔，沒有就只能指到畫面上
function delegateReply(r, level, tr = fill, save) {
  const b = budgetOf(level);
  const full = r.text || '';
  let out = full;
  if (r.final && out.length > b.reply && r.final.length < out.length) out = r.final;
  if (out.length > b.reply) {
    const file = save ? save(full) : '';
    out = clipMid(out, b.reply, tr) + '\n' + (file ? tr('（回覆太長已截短，完整內容在 {file}，需要時直接讀這個檔）', { file })
      : tr('（回覆太長已截短，完整內容在 AgentDesk 畫面上）'));
  }
  return out;
}

module.exports = { BUDGETS, budgetOf, clipMid, buildContext, delegateReply };
