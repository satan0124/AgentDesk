// 驗證用假 Gemini CLI：輸出 Gemini stream-json 事件
let d = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { d += c; }).on('end', () => {
  const ev = o => console.log(JSON.stringify(o));
  const arg = f => (process.argv.includes(f) ? process.argv[process.argv.indexOf(f) + 1] : 'none');
  ev({ type: 'init', session_id: 'gem-123', model: arg('-m') });
  ev({ type: 'message', role: 'user', content: d });
  ev({ type: 'tool_use', tool_name: 'read_file', tool_id: 't1', parameters: { path: 'README.md' } });
  ev({ type: 'tool_result', tool_id: 't1', status: 'success', output: 'file content' });
  ev({ type: 'message', role: 'assistant', content: 'fake gemini, ', delta: true });
  ev({ type: 'message', role: 'assistant', content: `model=${arg('-m')} resume=${arg('--resume')}`, delta: true });
  ev({ type: 'result', status: 'success', stats: { total_tokens: 10 } });
});
