// 驗證用假 Claude（Claude 相容的 stream-json）：回覆最後一行，並照真的 CLI 的樣子回報用量。
// 每個請求的用量在 assistant 事件裡，result 的 usage 是整輪加總；session 大小要取最後一個請求（40,107），不是加總。
// 最後一行含 big 時，最後一個請求報 15 萬多（大 session）。每一輪都用 Edit 改一次 src/edited.js（壓縮時由動作記錄補「相關檔案」用）。
// 收到壓縮的請求時：只替 #起 到 #迄-1 寫一筆（故意漏最後一段），resumed= 寫有沒有帶 --resume，相關檔案寫一個逐字稿裡沒有的檔
const path = require('path');
let d = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { d += c; }).on('end', () => {
  const ev = o => console.log(JSON.stringify(o));
  const i = process.argv.indexOf('--resume');
  const id = i > 0 ? process.argv[i + 1] : 'cc-1';
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
  const text = `cc got: ${last.slice(0, 40)} session=${id}`;
  const read = /big/.test(last) ? 150000 : 40000;
  ev({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Edit', input: { file_path: path.join(process.cwd(), 'src', 'edited.js') } }],
    usage: { input_tokens: 2, cache_creation_input_tokens: 5000, cache_read_input_tokens: 30000, output_tokens: 1 } } });
  ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }] } });
  ev({ type: 'assistant', message: { content: [{ type: 'text', text }], usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: read, output_tokens: 1 } } });
  ev({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 5 } } });
  ev({ type: 'result', result: text, session_id: id, total_cost_usd: 0,
    usage: { input_tokens: 4, cache_creation_input_tokens: 5100, cache_read_input_tokens: 30000 + read, output_tokens: 6 } });
});
