// Claude 透過這個 stdio MCP server 呼叫 Codex / Cursor。
// 實際執行交給 AgentDesk 主程序（本機 HTTP），這樣介面能即時顯示子 Agent 的進度。
const http = require('http');

const PORT = process.env.AGENTDESK_PORT;
const TOKEN = process.env.AGENTDESK_TOKEN;
const CONV = process.env.AGENTDESK_CONV;
// 可委派的 Agent 由主程序傳入：[{ id, name }]
let HELPERS = [];
try { HELPERS = JSON.parse(process.env.AGENTDESK_HELPERS || '[]'); } catch {}

const TOOLS = HELPERS.map(h => ({
  name: `ask_${h.id}`,
  description: `Hand a task to ${h.name} (${h.id}); it runs in the same working folder and returns its final reply. ` +
    `${h.name} cannot see this conversation, so the prompt must be self-contained: goal, relevant files, constraints, definition of done. ` +
    `Within one chat it continues its previous session by default (if supported); set new_session=true to start fresh.`,
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: `Complete instructions for ${h.name}` },
      new_session: { type: 'boolean', description: 'Start a new session (default false: continue the previous one)' },
    },
    required: ['prompt'],
  },
}));

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function delegate(agent, args) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ token: TOKEN, conv: CONV, agent, prompt: args.prompt || '', newSession: !!args.new_session });
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/delegate', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ error: 'Could not parse the AgentDesk response' }); } });
    });
    req.setTimeout(0);
    req.on('error', e => resolve({ error: 'Could not reach AgentDesk: ' + e.message }));
    req.end(body);
  });
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'agentdesk-agents', version: '0.1.0' },
    } });
  }
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const agent = TOOLS.some(t => t.name === params?.name) ? params.name.slice(4) : null;
    if (!agent) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool' } });
    const r = await delegate(agent, params.arguments || {});
    const text = r.error ? `[${agent} failed] ${r.error}${r.text ? '\n\nPartial output:\n' + r.text : ''}` : (r.text || '(no text reply)');
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: !!r.error } });
  }
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch {}
  }
});
