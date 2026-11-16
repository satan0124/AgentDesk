// 驗證用假 Antigravity CLI（agy）：stdin 讀一行 {"event":"user",...}，輸出 init / step_update / result
// 格式依 https://antigravity.google/docs/cli/headless
let d = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { d += c; }).on('end', () => {
  const ev = o => console.log(JSON.stringify(o));
  const arg = f => (process.argv.includes(f) ? process.argv[process.argv.indexOf(f) + 1] : 'none');
  let content = '';
  try { content = JSON.parse(d.trim().split('\n')[0]).message.content; } catch { content = '(bad input)'; }
  const id = arg('--conversation') !== 'none' ? arg('--conversation') : 'conv-abc';
  ev({ event: 'init', conversation_id: id, init: { cwd: process.cwd(), tools: ['run_command'], permission_mode: 'always-proceed', model: arg('--model') } });
  // AgentDesk 請它寫索引（壓縮）：照格式回兩筆，前後各夾一行不合格式的話，看主程序挑不挑得出來。
  // conv= 寫的是收到的 --conversation（沒有接續 session 就是 none）；src/ghost.js 是逐字稿裡沒有的檔案，主程序核對時要拿掉
  const cm = content.match(/\[AgentDesk \S+ #(\d+)–#(\d+)\]/);
  if (cm) {
    const a = +cm[1], b = +cm[2], mid = Math.floor((a + b) / 2);
    // 慢一點回，畫面測試才問得到「壓縮中」的狀態
    setTimeout(() => {
      ev({ event: 'step_update', step_update: { conversation_id: id, step_index: 0, state: 'ACTIVE', step_type: 'agent_response',
        text_delta: `Here is the index:\n#${a}–#${mid}｜first topic conv=${arg('--conversation')}｜decided X｜src/ghost.js\n- #${mid + 1}-${b} | second topic | undecided | -\n`
          // 沒有進程檔的對話會多要「現況／下一步」兩行
          + (/^(Current state|現況)[:：]/m.test(content) ? `- **Current state:** agy now #${b}\nNext steps: agy next\n` : '') + 'Done.' } });
      ev({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: 'unused', num_turns: 1, usage: { total_tokens: 5 } } });
    }, 500);
    return;
  }
  ev({ event: 'step_update', step_update: { conversation_id: id, step_index: 0, state: 'DONE', step_type: 'user_input' } });
  ev({ event: 'step_update', step_update: { conversation_id: id, step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { command: 'dir' } } } });
  ev({ event: 'step_update', step_update: { conversation_id: id, step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { command: 'dir' }, output: 'ok' } } });
  ev({ event: 'step_update', step_update: { conversation_id: id, step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'agy got: ' } });
  ev({ event: 'step_update', step_update: { conversation_id: id, step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: `${content.split('\n').pop().slice(0, 40)} conv=${id} head=${content.split('\n')[0].slice(0, 12)}` } });
  ev({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: 'unused', num_turns: 1, usage: { total_tokens: 5 } } });
});
