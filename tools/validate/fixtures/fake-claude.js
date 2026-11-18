// 驗證用假 Claude（Claude 相容的 stream-json）：回覆最後一行，並照真的 CLI 的樣子回報用量。
// 每個請求的用量在 assistant 事件裡，result 的 usage 是整輪加總；session 大小要取最後一個請求（40,107），不是加總。
// 最後一行含 big 時，最後一個請求報 17 萬多（大 session，超過以 200k 估的上下文八成）。每一輪都用 Edit 改一次 src/edited.js（壓縮時由動作記錄補「相關檔案」用）。
// 使用者的話有「note X」時，回覆最後一行照 AgentDesk 的要求寫這一輪的索引（邊對話邊記）。
// 收到壓縮的請求時：只替 #起 到 #迄-1 寫一筆（故意漏最後一段），resumed= 寫有沒有帶 --resume，相關檔案寫一個逐字稿裡沒有的檔
const path = require('path');
let d = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { d += c; }).on('end', () => {
  const ev = o => console.log(JSON.stringify(o));
  const i = process.argv.indexOf('--resume');
  const id = i > 0 ? process.argv[i + 1] : 'cc-1';
  // 每輪最後附的「索引」要求（noteAsk）先拿掉，最後一行才是使用者的話；裡面帶的上一輪主題記下來回報
  const ask = (d.match(/\[AgentDesk (?:索引|index)[^\n]*/) || [''])[0];
  const prev = (ask.match(/(?:照抄|copy)\s*[「"“]([^」"”]+)[」"”]/) || [])[1] || 'none';
  d = d.replace(/\n*\[AgentDesk (?:索引|index)[^\n]*\s*$/, '');
  const last = d.trim().split('\n').pop();
  const cm = d.match(/\[AgentDesk \S+ #(\d+)–#(\d+)\]/);
  ev({ type: 'system', subtype: 'init', session_id: id, model: 'fake' });
  if (cm) {
    const a = +cm[1], b = +cm[2];
    const text = `#${a}–#${Math.max(a, b - 1)}｜cc topic resumed=${i > 0 ? 'yes' : 'no'}｜ok｜src/ghost2.js`;
    // 慢一點回，畫面測試才問得到「壓縮中」的狀態
    return setTimeout(() => {
      ev({ type: 'assistant', message: { content: [{ type: 'text', text }], usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 4000, output_tokens: 1 } } });
      ev({ type: 'result', result: text, session_id: id, total_cost_usd: 0, usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 4000, output_tokens: 1 } });
    }, 500);
  }
  // 額度用完（沒帶 ANTHROPIC_API_KEY 時）：「weekly limit」照真的 CLI 先發 rate_limit_event（rejected）再回錯誤；
  // 「limit text」只有錯誤訊息（測只靠文字判斷的那條路）。帶了金鑰就照常回覆，多寫 apikey=yes，費用報 0.25
  // 像真的 Claude 一樣：--settings 裡有 apiKeyHelper 就執行它拿金鑰（AgentDesk 的 API 模式走這條，見 src/apihome.js）
  const helperKey = () => {
    const si = process.argv.indexOf('--settings');
    if (si < 0) return '';
    try {
      const cmd = JSON.parse(require('fs').readFileSync(process.argv[si + 1], 'utf8')).apiKeyHelper || '';
      const parts = (cmd.match(/"[^"]*"|\S+/g) || []).map(s => s.replace(/^"|"$/g, ''));
      return require('child_process').execFileSync(parts[0], parts.slice(1), { encoding: 'utf8' }).trim();
    } catch { return ''; }
  };
  const viaHelper = /^sk-ant-/.test(helperKey());
  const key = viaHelper || !!process.env.ANTHROPIC_API_KEY;
  // 「midway limit」：先做了一個動作才被擋（測做到一半撞到額度、改用 API 接著做）
  if (!key && /weekly limit|limit text|midway limit/.test(last)) {
    if (/midway limit/.test(last)) {
      ev({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-m', name: 'Read', input: { file_path: 'a.txt' } }] } });
      ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-m', content: 'ok' }] } });
    }
    if (/weekly limit|midway limit/.test(last)) ev({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', utilization: 1, resetsAt: Math.floor(Date.now() / 1000) + 3600 } });
    ev({ type: 'result', is_error: true, subtype: 'success', result: "You've hit your weekly limit · resets Mon 9am", session_id: id, total_cost_usd: 0 });
    process.exitCode = 1;
    return;
  }
  // 使用者的話有「note X」時才照要求在最後一行寫索引（主題 topic-X），並回報收到的上一輪主題
  const nm = ask && last.match(/note (\w+)/);
  const text = `cc got: ${last.slice(0, 40)} session=${id}` + (key ? ` apikey=yes helper=${viaHelper ? 'yes' : 'no'} envkey=${process.env.ANTHROPIC_API_KEY ? 'yes' : 'no'} home=${process.env.CLAUDE_CONFIG_DIR ? 'yes' : 'no'}` : '') + (nm ? ` prev=${prev}\n\n[[agentdesk:index]] topic-${nm[1]}｜result ${nm[1]}｜src/edited.js` : '');
  const read = /big/.test(last) ? 170000 : 40000;
  ev({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Edit', input: { file_path: path.join(process.cwd(), 'src', 'edited.js') } }],
    usage: { input_tokens: 2, cache_creation_input_tokens: 5000, cache_read_input_tokens: 30000, output_tokens: 1 } } });
  ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }] } });
  ev({ type: 'assistant', message: { content: [{ type: 'text', text }], usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: read, output_tokens: 1 } } });
  ev({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 5 } } });
  // modelUsage 照真的 CLI 的樣子：主模型 fake 是 1M，子代理用的 fake-sub 是 2M（AgentDesk 要取主模型那一筆）
  ev({ type: 'result', result: text, session_id: id, total_cost_usd: key ? 0.25 : 0,
    modelUsage: /window/.test(last) ? { 'fake-sub': { contextWindow: 2000000 }, fake: { contextWindow: 1000000 } } : undefined,
    usage: { input_tokens: 4, cache_creation_input_tokens: 5100, cache_read_input_tokens: 30000 + read, output_tokens: 6 } });
});
