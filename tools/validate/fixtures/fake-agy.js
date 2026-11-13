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
  ev({ event: 'step_update', step_update: { conversation_id: id, step_index: 0, state: 'DONE', step_type: 'user_input' } });
  ev({ event: 'step_update', step_update: { conversation_id: id, step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { command: 'dir' } } } });
  ev({ event: 'step_update', step_update: { conversation_id: id, step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { command: 'dir' }, output: 'ok' } } });
  ev({ event: 'step_update', step_update: { conversation_id: id, step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'agy got: ' } });
  ev({ event: 'step_update', step_update: { conversation_id: id, step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: `${content.split('\n').pop().slice(0, 40)} conv=${id}` } });
  ev({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: 'unused', num_turns: 1, usage: { total_tokens: 5 } } });
});
