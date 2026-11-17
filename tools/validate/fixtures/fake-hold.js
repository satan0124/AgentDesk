// 驗證用：停在半途，等畫面測試刪掉對話。
// 使用者的話有一行「delegate <Agent> <對話 id>」時，像 MCP bridge 一樣打 AgentDesk 的 /delegate，請那個 Agent 做事
// （畫面測試用一直不結束的 fake-slow），自己也一直不結束；其他時候直接一直輸出不結束（同 fake-slow）。
// /delegate 的位址與 token 由主程序在自我測試模式放進環境變數 AGENTDESK_TEST_DELEGATE（見 main.js 的 startServer）
const http = require('http');
let d = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { d += c; }).on('end', () => {
  const tick = label => { let n = 0; setInterval(() => process.stdout.write(`${label} ${n++}\n`), 100); };
  const t = process.env.AGENTDESK_TEST_DELEGATE;
  // 「approve <對話 id>」：像 Claude 的 --permission-prompt-tool 一樣打 /approve，回報使用者按了什麼就結束
  const ap = d.match(/^approve (\S+)\s*$/m);
  if (ap && t) {
    const { port, token } = JSON.parse(t);
    const body = JSON.stringify({ token, conv: ap[1], tool_name: 'Bash', input: { command: 'npm test' } });
    const req = http.request({ host: '127.0.0.1', port, path: '/approve', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      let b = '';
      res.on('data', x => { b += x; });
      res.on('end', () => { process.stdout.write(`approval answer ${b}\n`); process.exit(0); });
    });
    req.on('error', e => { process.stdout.write(`approve failed ${e.message}\n`); process.exit(0); });
    return req.end(body);
  }
  const m = d.match(/^delegate (\S+) (\S+)\s*$/m);
  if (!m || !t) return tick('hold');
  const { port, token } = JSON.parse(t);
  process.stdout.write(`delegating to ${m[1]}\n`);
  const body = JSON.stringify({ token, conv: m[2], agent: m[1], prompt: 'hold' });
  const req = http.request({ host: '127.0.0.1', port, path: '/delegate', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
    let b = '';
    res.on('data', x => { b += x; });
    res.on('end', () => { process.stdout.write(`delegate returned ${b}\n`); tick('after'); });
  });
  req.on('error', e => process.stdout.write(`delegate failed ${e.message}\n`));
  req.end(body);
  tick('waiting');
});
