// 三個 CLI Agent 的啟動與串流解析，統一成同一組事件：
//   {type:'session', id} {type:'text', text} {type:'thinking', text}
//   {type:'tool', id, name, detail, status, output?}
const { spawn, execFile } = require('child_process');
const { spawnProc } = require('./proc');
const { t: tr } = require('./shared/i18n');
const { resolveCli, killTree } = require('./cli');

const LABEL = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' };
const labelOf = (agent, cfg) => cfg?.name || LABEL[agent] || agent;
const stripAnsi = s => String(s || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r(?!\n)/g, '');

// 自訂 Agent 的額外參數：以空白分隔，雙引號可包住含空白的參數；{cwd} 代換成工作資料夾
function splitArgs(s) {
  const out = []; let cur = '', quoted = false, has = false;
  for (const ch of String(s || '')) {
    if (ch === '"') { quoted = !quoted; has = true; continue; }
    if (/\s/.test(ch) && !quoted) { if (has || cur) out.push(cur); cur = ''; has = false; continue; }
    cur += ch;
  }
  if (has || cur) out.push(cur);
  return out;
}

function short(v, n = 200) {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ---------- 指令組成 ----------
function buildCommand(agent, cfg, { prompt, sessionId, mcpConfig, systemPrompt, cwd, images = [], addDirs = [], allowedTools = [] }) {
  const base = resolveCli(cfg.cli || agent);
  if (!base) throw new Error(tr('找不到 {name} CLI：{cli}（請到設定檢查 CLI 路徑）', { name: labelOf(agent, cfg), cli: cfg.cli || agent }));
  const args = [];
  if (cfg.custom) {
    args.push(...splitArgs(cfg.args).map(a => a.split('{cwd}').join(cwd)));
    if (cfg.model && cfg.modelFlag) args.push(cfg.modelFlag, cfg.model);
    if (sessionId && cfg.resumeFlag) args.push(cfg.resumeFlag, sessionId);
    if (cfg.promptMode === 'stream-json') {
      // agy 等：stdin 一行 JSON {"event":"user","message":{"content":"…"}}，避開命令列長度上限
      return { file: base[0], args: [...base.slice(1), ...args], cwd,
        stdin: JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n' };
    }
    if (cfg.promptMode === 'arg') {
      // 透過 cmd.exe 啟動時把整段 prompt 當參數會被 cmd 解讀特殊字元，只允許 stdin
      if (/cmd\.exe$/i.test(base[0])) throw new Error(tr('{name} 是 .cmd/.bat 啟動，prompt 只能用 stdin 傳入（請到設定改）', { name: labelOf(agent, cfg) }));
      if (cfg.promptFlag) args.push(cfg.promptFlag);
      args.push(prompt);
      return { file: base[0], args: [...base.slice(1), ...args], cwd, stdin: '' };
    }
    return { file: base[0], args: [...base.slice(1), ...args], cwd, stdin: prompt };
  }
  if (agent === 'claude') {
    args.push('-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--permission-mode', cfg.permission || 'acceptEdits');
    if (addDirs.length) args.push('--add-dir', ...addDirs);
    if (cfg.model) args.push('--model', cfg.model);
    if (cfg.effort) args.push('--effort', cfg.effort);
    if (sessionId) args.push('--resume', sessionId);
    if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
    if (mcpConfig) args.push('--mcp-config', mcpConfig, '--allowedTools', ...allowedTools);
  } else if (agent === 'codex') {
    args.push('exec');
    if (sessionId) args.push('resume', sessionId);
    args.push('--json', '--skip-git-repo-check', '-c', `sandbox_mode="${cfg.sandbox || 'workspace-write'}"`);
    if (cfg.model) args.push('-m', cfg.model);
    if (cfg.effort) args.push('-c', `model_reasoning_effort="${cfg.effort}"`);
    for (const img of images) args.push(`--image=${img}`);
    args.push('-');
  } else if (agent === 'cursor') {
    args.push('-p', '--output-format', 'stream-json', '--stream-partial-output', '--trust');
    const perm = cfg.permission || 'force';
    if (perm === 'force') args.push('--force');
    else if (perm === 'ask') args.push('--mode', 'ask');
    else if (perm === 'plan') args.push('--mode', 'plan');
    const model = cursorModel(cfg.model, cfg.effort);
    if (model) args.push('--model', model);
    if (sessionId) args.push('--resume', sessionId);
  }
  return { file: base[0], args: [...base.slice(1), ...args], cwd, stdin: prompt };
}

// Cursor 的強度用參數化模型 id 表示：gpt-5.2[effort=high]；id 已含強度就不再包
function cursorModel(model, effort) {
  if (!model || model === 'auto' || !effort || model.includes('[')) return model || '';
  if (/(?:^|-)(?:low|medium|high|xhigh|extra-?high)(?:-fast)?$|-fast$/i.test(model)) return model;
  return `${model}[effort=${effort}]`;
}

// ---------- 串流解析 ----------
function claudeParser(emit, state) {
  return evt => {
    switch (evt.type) {
      case 'system':
        if (evt.subtype === 'init' && evt.session_id) emit({ type: 'session', id: evt.session_id, model: evt.model });
        break;
      case 'stream_event': {
        const e = evt.event || {};
        if (evt.parent_tool_use_id) break;
        if (e.type === 'content_block_delta') {
          if (e.delta?.type === 'text_delta') { state.streamed = true; emit({ type: 'text', text: e.delta.text }); }
          else if (e.delta?.type === 'thinking_delta') emit({ type: 'thinking', text: e.delta.thinking });
        } else if (e.type === 'message_start') {
          if (state.streamed) emit({ type: 'text', text: '\n\n' });
        }
        break;
      }
      case 'assistant':
        if (evt.parent_tool_use_id) break;
        for (const b of evt.message?.content || []) {
          if (b.type === 'tool_use') {
            const name = b.name.replace(/^mcp__agents__/, '');
            // 委派卡片由主程序另外呈現；ToolSearch 是 CLI 內部載入工具用的
            if (/^mcp__agents__ask_/.test(b.name) || name === 'ToolSearch') { state.hidden.add(b.id); continue; }
            emit({ type: 'tool', id: b.id, name, detail: toolDetail(b.name, b.input), status: 'running' });
          }
        }
        break;
      case 'user':
        for (const b of evt.message?.content || []) {
          if (b.type === 'tool_result' && !state.hidden.has(b.tool_use_id)) {
            const out = Array.isArray(b.content) ? b.content.map(c => c.text || '').join('\n') : b.content;
            emit({ type: 'tool', id: b.tool_use_id, status: b.is_error ? 'error' : 'done', output: short(out, 2000) });
          }
        }
        break;
      case 'result':
        state.final = evt.result;
        if (evt.session_id) emit({ type: 'session', id: evt.session_id });
        if (evt.is_error) state.error = evt.result || evt.subtype || 'Claude error';
        if (!state.streamed && evt.result) emit({ type: 'text', text: evt.result });
        state.usage = evt.usage; state.cost = evt.total_cost_usd;
        break;
    }
  };
}

function toolDetail(name, input = {}) {
  return input.command || input.file_path || input.path || input.pattern || input.url || input.query
    || input.description || short(input, 160);
}

function codexParser(emit, state) {
  return evt => {
    const item = evt.item || {};
    switch (evt.type) {
      case 'thread.started': emit({ type: 'session', id: evt.thread_id }); break;
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const done = evt.type === 'item.completed';
        if (item.type === 'agent_message') {
          if (done) { emit({ type: 'text', text: (state.texts++ ? '\n\n' : '') + (item.text || '') }); state.final = item.text; }
        } else if (item.type === 'reasoning') {
          if (done && item.text) emit({ type: 'thinking', text: item.text + '\n' });
        } else if (item.type === 'command_execution') {
          emit({ type: 'tool', id: item.id, name: 'shell', detail: item.command,
            status: done ? (item.exit_code === 0 || item.status === 'completed' ? 'done' : 'error') : 'running',
            output: done ? short(item.aggregated_output, 2000) : undefined });
        } else if (item.type === 'file_change') {
          emit({ type: 'tool', id: item.id, name: 'edit', status: done ? 'done' : 'running',
            detail: (item.changes || []).map(c => `${c.kind || ''} ${c.path}`).join(', ') });
        } else if (item.type === 'mcp_tool_call') {
          emit({ type: 'tool', id: item.id, name: `${item.server}.${item.tool}`, detail: short(item.arguments, 160),
            status: done ? (item.status === 'failed' ? 'error' : 'done') : 'running' });
        } else if (item.type === 'web_search') {
          emit({ type: 'tool', id: item.id, name: 'web_search', detail: item.query, status: done ? 'done' : 'running' });
        } else if (item.type === 'error') {
          emit({ type: 'notice', text: item.message });
        }
        break;
      }
      case 'turn.completed': state.usage = evt.usage; break;
      case 'turn.failed': state.error = evt.error?.message || 'Codex turn failed'; break;
      case 'error': state.error = evt.message || 'Codex error'; break;
    }
  };
}

function cursorParser(emit, state) {
  return evt => {
    switch (evt.type) {
      case 'system':
        if (evt.subtype === 'init') emit({ type: 'session', id: evt.session_id, model: evt.model });
        break;
      case 'thinking':
        if (evt.subtype === 'delta' && evt.text) emit({ type: 'thinking', text: evt.text });
        break;
      case 'assistant': {
        const text = (evt.message?.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
        // --stream-partial-output：帶 timestamp_ms 的是增量；整段重送不帶 timestamp_ms 或帶 model_call_id
        if (evt.timestamp_ms && !evt.model_call_id) { state.streamed = true; emit({ type: 'text', text }); }
        else if (!state.streamed) emit({ type: 'text', text });
        else state.streamed = false; // 下一段新訊息重新計
        break;
      }
      case 'tool_call': {
        const call = evt.tool_call || {};
        const key = Object.keys(call)[0] || 'tool';
        const body = call[key] || {};
        const a = body.args || {};
        const name = key.replace(/ToolCall$/, '');
        const done = evt.subtype === 'completed';
        const res = body.result || {};
        emit({ type: 'tool', id: evt.call_id, name, detail: a.command || a.path || a.pattern || a.globPattern || short(a, 160),
          status: done ? (res.error || res.rejected ? 'error' : 'done') : 'running',
          output: done ? short(res.success?.stdout ?? res.success?.content ?? res.error ?? '', 2000) : undefined });
        break;
      }
      case 'result':
        state.final = evt.result;
        if (evt.is_error) state.error = evt.result || 'Cursor error';
        state.usage = evt.usage;
        break;
    }
  };
}

// Gemini CLI --output-format stream-json：init / message / tool_use / tool_result / error / result
function geminiParser(emit, state) {
  return evt => {
    switch (evt.type) {
      case 'init':
        if (evt.session_id) emit({ type: 'session', id: evt.session_id, model: evt.model });
        break;
      case 'message': {
        if (evt.role && evt.role !== 'assistant') break;
        const text = typeof evt.content === 'string' ? evt.content
          : Array.isArray(evt.content) ? evt.content.map(c => c.text || '').join('') : '';
        if (!text) break;
        if (evt.delta) { state.streamed = true; emit({ type: 'text', text }); }
        else if (!state.streamed) emit({ type: 'text', text });
        break;
      }
      case 'tool_use':
        emit({ type: 'tool', id: evt.tool_id, name: evt.tool_name || 'tool', detail: toolDetail(evt.tool_name, evt.parameters || {}), status: 'running' });
        break;
      case 'tool_result':
        emit({ type: 'tool', id: evt.tool_id, status: evt.status === 'error' ? 'error' : 'done',
          output: short(evt.output ?? evt.error?.message ?? '', 2000) });
        break;
      case 'error':
        emit({ type: 'notice', text: evt.message || evt.error?.message || 'error' });
        if (evt.severity === 'error' || evt.fatal) state.error = evt.message || evt.error?.message;
        break;
      case 'result':
        if (evt.status === 'error') state.error = evt.error?.message || evt.message || 'error';
        if (typeof evt.response === 'string' && !state.streamed) state.final = evt.response;
        state.usage = evt.stats || evt.usage;
        break;
    }
  };
}

// Antigravity CLI（agy）--output-format stream-json：init / step_update / result（欄位放在同名子物件裡）
function antigravityParser(emit, state) {
  return evt => {
    const kind = evt.event || evt.type;
    if (kind === 'init') {
      const id = evt.conversation_id || evt.init?.conversation_id;
      if (id) emit({ type: 'session', id, model: evt.init?.model });
    } else if (kind === 'step_update') {
      const s = evt.step_update || evt;
      const type = String(s.step_type || '').toLowerCase();
      if (s.text_delta && (type === 'agent_response' || type === '' || type === 'response')) {
        state.streamed = true;
        emit({ type: 'text', text: s.text_delta });
      } else if (type === 'tool' || s.tool_name || s.tool_info) {
        const info = s.tool_info || {};
        const name = s.tool_name || info.name || 'tool';
        const id = `${s.conversation_id || ''}#${s.step_index}`;
        const done = String(s.state).toUpperCase() === 'DONE';
        emit({ type: 'tool', id, name, detail: toolDetail(name, info.parameters || {}),
          status: done ? (info.error ? 'error' : 'done') : 'running',
          output: done ? short(info.error?.message ?? info.output ?? '', 2000) : undefined });
      }
    } else if (kind === 'result') {
      const r = evt.result || evt;
      if (r.conversation_id) emit({ type: 'session', id: r.conversation_id });
      const status = String(r.status || '').toUpperCase();
      if (status && status !== 'SUCCESS') state.error = r.error || status;
      if (!state.streamed && r.response) emit({ type: 'text', text: r.response });
      state.usage = r.usage;
    }
  };
}

const PARSERS = { claude: claudeParser, codex: codexParser, cursor: cursorParser, gemini: geminiParser, antigravity: antigravityParser };

// ---------- 執行 ----------
function runAgent(agent, cfg, { prompt, cwd, sessionId, mcpConfig, systemPrompt, env, onEvent, images, addDirs, allowedTools }) {
  let child;
  const state = { texts: 0, streamed: false, hidden: new Set() };
  let collected = '';
  const emit = e => {
    if (e.type === 'text') collected += e.text;
    if (e.type === 'session' && e.id) state.session = e.id;
    onEvent?.(e);
  };
  const promise = new Promise((resolve) => {
    let cmd;
    try { cmd = buildCommand(agent, cfg, { prompt, sessionId, mcpConfig, systemPrompt, cwd, images, addDirs, allowedTools }); }
    catch (err) { return resolve({ error: err.message, text: '' }); }
    const childEnv = { ...process.env, ...env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    child = spawnProc(cmd.file, cmd.args, { cwd, env: childEnv });   // 在 worker 裡建立行程，主程序不卡
    // 自訂 Agent：format = claude（Claude 相容 stream-json）/ gemini / text（純文字，stdout 直接當回覆）
    const kind = cfg.custom ? (cfg.format || 'text') : agent;
    const textMode = !PARSERS[kind];
    const parse = textMode ? () => {} : PARSERS[kind](emit, state);
    let buf = '', errBuf = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => {
      if (textMode) { const t = stripAnsi(d); if (t) emit({ type: 'text', text: t }); return; }
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        try { parse(JSON.parse(line)); } catch {}
      }
    });
    child.stderr.on('data', d => { errBuf = (errBuf + d).slice(-6000); });
    child.on('error', err => resolve({ error: tr('無法啟動 {name}：{error}', { name: labelOf(agent, cfg), error: err.message }), text: collected }));
    child.on('close', code => {
      if (buf.trim().startsWith('{')) { try { parse(JSON.parse(buf.trim())); } catch {} }
      let error = state.error;
      if (child.killed || state.stopped) error = '已停止';
      else if (!error && code !== 0) {
        const tail = errBuf.split(/\r?\n/).filter(l => l && !/rmcp::transport|^\s*at /.test(l)).slice(-8).join('\n');
        error = tr('{name} 結束碼 {code}', { name: labelOf(agent, cfg), code }) + (tail ? '\n' + tail : '');
      }
      resolve({ text: collected.trim() || state.final || '', sessionId: state.session || sessionId,
        error, usage: state.usage, cost: state.cost });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(cmd.stdin ?? '', 'utf8');
  });
  return { promise, stop: () => { state.stopped = true; killTree(child); } };
}

// ---------- 可用模型 ----------
const CLAUDE_MODELS = ['opus', 'sonnet', 'haiku', 'fable', 'claude-opus-5-5', 'claude-sonnet-5-5',
  'claude-haiku-5-5', 'claude-fable-5-2'];

function listModels(agent, cfg) {
  return new Promise(resolve => {
    if (cfg?.custom) return resolve({ models: [], error: tr('自訂 Agent 沒有模型清單，請直接輸入模型名稱') });
    if (agent === 'claude') return resolve({ models: CLAUDE_MODELS });
    const base = resolveCli(cfg.cli || agent);
    if (!base) return resolve({ models: [], error: tr('找不到 CLI') });
    if (agent === 'cursor') {
      execFile(base[0], [...base.slice(1), 'models'], { windowsHide: true, timeout: 30000, encoding: 'utf8' }, (err, out) => {
        const models = (out || '').split(/\r?\n/).map(l => l.match(/^([\w.\-\[\]=,]+)\s+-\s+/)?.[1]).filter(Boolean);
        resolve({ models, error: models.length ? null : (err?.message || tr('讀不到模型清單')) });
      });
      return;
    }
    // codex：app-server JSON-RPC model/list
    const child = spawn(base[0], [...base.slice(1), 'app-server'], { windowsHide: true });
    const models = [];
    let buf = '', done = false;
    const finish = (error) => { if (done) return; done = true; killTree(child); resolve({ models, error: models.length ? null : error }); };
    const send = o => child.stdin.write(JSON.stringify(o) + '\n');
    const timer = setTimeout(() => finish(tr('逾時')), 20000);
    child.on('error', e => finish(e.message));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let obj; try { obj = JSON.parse(line); } catch { continue; }
        if (obj.id === 1) { send({ method: 'initialized', params: {} }); send({ method: 'model/list', id: 2, params: { limit: 100, includeHidden: false } }); }
        if (obj.id === 2) {
          for (const m of obj.result?.data || []) if (m.model || m.id) models.push(m.model || m.id);
          clearTimeout(timer); finish(obj.error ? JSON.stringify(obj.error) : null);
        }
      }
    });
    send({ method: 'initialize', id: 1, params: { clientInfo: { name: 'agentdesk', title: 'AgentDesk', version: '0.1.0' } } });
  });
}

module.exports = { runAgent, listModels, LABEL, labelOf };
// 給 tools/validate.js 做單元測試用
module.exports._test = { PARSERS, buildCommand, cursorModel, splitArgs };
