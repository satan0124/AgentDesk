// 驗證用假 Agent（純文字）：讀 stdin，分段回覆最後一行、收到的參數與第一行開頭（看得出 prompt 前面有沒有被加上說明）
// prompt 裡帶著壓縮後的索引時，多回報一行：索引幾筆、附了幾則有編號的原文、有沒有逐字稿路徑、原文從第幾段開始
let d = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { d += c; }).on('end', async () => {
  // 每輪最後附的「索引」要求先拿掉（這個假 Agent 不寫索引），最後一行才是使用者的話
  d = d.replace(/\n*\[AgentDesk (?:索引|index)[^\n]*\s*$/, '');
  const lines = d.trim().split('\n');
  const last = lines.pop();
  const head = d.trim().split('\n')[0].slice(0, 12);
  const idx = lines.filter(l => /^#\d+–#\d+｜/.test(l)).length;
  const recent = lines.map(l => (l.match(/^#(\d+) \S/) || [])[1]).filter(Boolean);
  const parts = ['Echo got: ', last.slice(0, 60), '\n', `(args: ${process.argv.slice(2).join(' ')})`, '\n', `(head: ${head})`];
  if (idx) parts.push('\n', `(index: ${idx} recent: ${recent.length} first: ${recent[0] || 0} transcript: ${/transcript\.md/.test(d) ? 'yes' : 'no'})`,
    '\n', `(state: ${/^(Current state|現況)[:：] agy now/m.test(d) ? 'yes' : 'no'})`);
  // 使用者的話有 long 時多回一段，讓回覆超過「簡短回合」的長度（compress.js 的 BRIEF），沒寫索引就要請 Agent 補
  if (/\blong\b/.test(last)) parts.push('\n', `(filler: ${'lorem '.repeat(60).trim()})`);
  for (const part of parts) {
    process.stdout.write(part);
    await new Promise(r => setTimeout(r, 60));
  }
});
