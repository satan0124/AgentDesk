// Claude 的計費方式：訂閱（sub，用 claude.ai 帳號的額度）或 Claude API（api，用 API 金鑰、扣 API 額度）。
// 切到 API 時 AgentDesk 在 Claude 的子行程加上 ANTHROPIC_API_KEY（-p 模式有這個變數就一律用它，不用登入的帳號）。
// 這裡只放判斷，狀態與存檔在 main.js。
//
// 額度用完怎麼看出來（2026-11 依 CLI 的事件格式，沒有真的把額度用完測過）：
//   1. rate_limit_event 的 status 是 rejected，rateLimitType 說是哪一個額度（agents.js 記成 r.limitHit）
//   2. 沒有那個事件時，看錯誤訊息像不像額度用完，再從訊息或右欄記下的額度判斷是每週還是 5 小時
const LIMIT_TEXT = /usage limit|limit reached|hit your (?:\w+ )*limit|limit (?:will )?reset|out of (?:extra )?usage/i;

// 這一輪是不是因為額度用完而失敗：回 'seven_day'、'five_hour' 或 null
function limitHit(r, claudeLimits) {
  if (!r?.error || r.error === '已停止') return null;
  if (r.limitHit) return r.limitHit === 'seven_day' || /week|seven/i.test(r.limitHit) ? 'seven_day' : 'five_hour';
  const e = String(r.error);
  if (!LIMIT_TEXT.test(e)) return null;
  if (/week|7-day|seven[_ ]day|每週|每周/i.test(e)) return 'seven_day';
  if (/5-hour|five[_ ]hour|session limit|5 小時/i.test(e)) return 'five_hour';
  return weeklyFull(claudeLimits) ? 'seven_day' : 'five_hour';
}
// when：weekly＝只有每週額度用完才切；any＝5 小時額度用完也切
const shouldSwitch = (hit, when) => !!hit && (when === 'any' || hit === 'seven_day');

const weekWin = lim => (lim?.windows || []).find(w => w.kind === 'seven_day');
// 右欄記下的每週額度已經用完、還沒到重置時間
function weeklyFull(lim, now = Date.now()) {
  const w = weekWin(lim);
  return !!w && w.used >= 100 && (!w.resetsAt || w.resetsAt * 1000 > now);
}
// 某個額度（預設每週）什麼時候重置（毫秒）；不知道回 null
function resetAt(lim, kind = 'seven_day') {
  const w = (lim?.windows || []).find(x => x.kind === kind);
  return w?.resetsAt ? w.resetsAt * 1000 : null;
}
// API 額度還剩多少（美元）：使用者在設定填的剩餘額度，減掉之後 Claude CLI 回報的費用（API 牌價）。沒填過回 null
function remaining(b) {
  if (typeof b?.base !== 'number') return null;
  return Math.round((b.base - (b.spent || 0)) * 100) / 100;
}

module.exports = { limitHit, shouldSwitch, weeklyFull, resetAt, remaining, LIMIT_TEXT };
