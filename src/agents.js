// 三個 CLI Agent 的啟動與串流解析，統一成同一組事件：
//   {type:'session', id} {type:'text', text} {type:'thinking', text}
//   {type:'tool', id, name, detail, status, output?}
const { spawnProc, runProc } = require('./proc');
const { t: tr } = require('./shared/i18n');
const { resolveCli, killTree } = require('./cli');

const LABEL = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' };
// 對話模式停用的 Claude 改檔工具（一個參數、逗號分隔，避免後面的參數被當成工具名稱）；同 mode.js 的 EDIT_TOOLS
const CLAUDE_EDIT_TOOLS = 'Edit,Write,MultiEdit,NotebookEdit';
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
// settingsFile：Claude 的 --settings（API 模式放 apiKeyHelper，見 apihome.js）；主程序只替用 API 跑的 Claude 帶，驗證時是假 Claude
function buildCommand(agent, cfg, { prompt, sessionId, mcpConfig, systemPrompt, cwd, images = [], addDirs = [], allowedTools = [], permissionPromptTool, settingsFile }) {
  const base = resolveCli(cfg.cli || agent);
  if (!base) throw new Error(tr('找不到 {name} CLI：{cli}（請到設定檢查 CLI 路徑）', { name: labelOf(agent, cfg), cli: cfg.cli || agent }));
  const args = [];
  if (cfg.custom) {
    args.push(...splitArgs(cfg.args).map(a => a.split('{cwd}').join(cwd)));
    if (settingsFile) args.push('--settings', settingsFile);
    if (cfg.model && cfg.modelFlag) args.push(cfg.modelFlag, cfg.model);
    if (cfg.effort && cfg.effortFlag) args.push(cfg.effortFlag, cfg.effort);
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
  // cfg.readOnly（對話模式）：不管設定頁選什麼權限，一律換成各 CLI 的唯讀做法。
  //   Claude：--permission-mode default，-p 沒有人能回答詢問，改檔與非唯讀指令會被拒（列在 result 的 permission_denials）；
  //     另外用 --disallowedTools 停用改檔工具：deny 規則比 permissions.allow 優先，使用者自己允許過 Edit／Write 也擋得住。
  //     使用者允許過的 Bash 指令與 MCP 工具擋不了（擋掉 Bash 會連唯讀指令一起擋）
  //   Codex：sandbox_mode="read-only"；Cursor：拿掉 --force，改 --mode ask（設定是 plan 就維持 plan，同樣唯讀）
  //   自訂 Agent 沒有共通旗標，上面已經 return，只能靠 prompt 裡的說明（mode.js）
  if (agent === 'claude') {
    args.push('-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--permission-mode', cfg.readOnly ? (cfg.permission === 'plan' ? 'plan' : 'default') : cfg.permission || 'default');
    if (cfg.readOnly) args.push('--disallowedTools', CLAUDE_EDIT_TOOLS);
    if (addDirs.length) args.push('--add-dir', ...addDirs);
    if (cfg.model) args.push('--model', cfg.model);
    if (cfg.effort) args.push('--effort', cfg.effort);
    if (sessionId) args.push('--resume', sessionId);
    if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
    if (mcpConfig) args.push('--mcp-config', mcpConfig, ...(allowedTools.length ? ['--allowedTools', ...allowedTools] : []));
    // 工作模式要問的工具（改檔、指令）改由這個 MCP 工具問使用者（AgentDesk 畫面上按允許／拒絕），不再一律拒絕；
    // 2026-11 用真的 Claude 試過：參數是 { tool_name, input, tool_use_id }，回 {"behavior":"allow","updatedInput":…} 或 {"behavior":"deny","message":…}
    if (permissionPromptTool && !cfg.readOnly) args.push('--permission-prompt-tool', permissionPromptTool);
    if (settingsFile) args.push('--settings', settingsFile);
  } else if (agent === 'codex') {
    args.push('exec');
    if (sessionId) args.push('resume', sessionId);
    args.push('--json', '--skip-git-repo-check', '-c', `sandbox_mode="${cfg.readOnly ? 'read-only' : cfg.sandbox || 'workspace-write'}"`);
    if (cfg.model) args.push('-m', cfg.model);
    if (cfg.effort) args.push('-c', `model_reasoning_effort="${cfg.effort}"`);
    for (const img of images) args.push(`--image=${img}`);
    args.push('-');
  } else if (agent === 'cursor') {
    args.push('-p', '--output-format', 'stream-json', '--stream-partial-output', '--trust');
    const perm = cfg.readOnly ? (cfg.permission === 'plan' ? 'plan' : 'ask') : cfg.permission || 'force';
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
        if (evt.subtype === 'init' && evt.model) state.model = evt.model;
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
        } else if (e.type === 'message_delta' && e.usage) {
          state.lastUsage = { ...state.lastUsage, ...e.usage };   // 這個請求收尾時的輸出量
        }
        break;
      }
      case 'assistant':
        // 子代理（Task／Agent 工具，含背景執行的）自己的動作：不另外列，記在發動它的那個工具上（畫面顯示「子代理第幾個動作、最新是什麼」）
        if (evt.parent_tool_use_id) {
          for (const b of evt.message?.content || []) {
            if (b.type === 'tool_use') emit({ type: 'tool', id: evt.parent_tool_use_id, sub: { name: b.name.replace(/^mcp__\w+?__/, ''), detail: toolDetail(b.name, b.input) } });
          }
          break;
        }
        // 每個請求各自的用量；最後一個請求的輸入量就是這個 session 現在的大小（見 sessionSize）
        if (evt.message?.usage) state.lastUsage = evt.message.usage;
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
        // 子代理的工具結果：只記失敗數（之前沒擋，結果會變成一堆沒有名稱的「tool」動作）
        if (evt.parent_tool_use_id) {
          for (const b of evt.message?.content || []) if (b.type === 'tool_result' && b.is_error) emit({ type: 'tool', id: evt.parent_tool_use_id, subError: true });
          break;
        }
        for (const b of evt.message?.content || []) {
          if (b.type === 'tool_result' && !state.hidden.has(b.tool_use_id)) {
            const out = Array.isArray(b.content) ? b.content.map(c => c.text || '').join('\n') : b.content;
            emit({ type: 'tool', id: b.tool_use_id, status: b.is_error ? 'error' : 'done', output: short(out, 2000) });
          }
        }
        break;
      case 'rate_limit_event': {
        const windows = claudeWindows(evt.rate_limit_info);
        if (windows.length) emit({ type: 'limits', windows });
        // 額度用完被擋下：記下是哪一個額度（billing.js 的 limitHit 用來決定要不要改用 Claude API）
        if (evt.rate_limit_info?.status === 'rejected') state.limitHit = evt.rate_limit_info.rateLimitType || 'unknown';
        break;
      }
      case 'result':
        state.final = evt.result;
        if (evt.session_id) emit({ type: 'session', id: evt.session_id });
        if (evt.is_error) state.error = evt.result || evt.subtype || 'Claude error';
        // 出錯時的 result 是錯誤訊息：不當成回覆文字串流出去（額度用完改用 API 重跑時，畫面才不會留著那句錯誤）
        if (!state.streamed && evt.result && !evt.is_error) emit({ type: 'text', text: evt.result });
        state.usage = evt.usage; state.cost = evt.total_cost_usd;
        // 模型的上下文大小：session 用了幾成、什麼時候該壓縮。modelUsage 每個用到的模型一筆 contextWindow
        // （2026-11-18 用 Claude Code 2.1.310、Haiku 5.5 實測：{"claude-haiku-5-5":{…,"contextWindow":1000000}}）。
        // 子代理可能用別的模型，取主模型（init 的 model）那一筆；對不上才取最大的
        const mu = evt.modelUsage || {}, main = mu[state.model] || Object.values(mu).find(m => m?.canonicalModel === state.model);
        const win = Number(main?.contextWindow) || Math.max(0, ...Object.values(mu).map(m => Number(m?.contextWindow) || 0));
        if (win) state.window = win;
        // 被擋下的工具呼叫（-p 沒有人能回答詢問時自動拒絕）：對話模式用來判斷「想改檔」
        if (evt.permission_denials?.length) {
          state.denials = evt.permission_denials.map(d => ({ tool: d.tool_name, detail: short(toolDetail(d.tool_name, d.tool_input || {}), 160) }));
        }
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
        // 工具類的項目每完成一個，模型就多發一次請求（估 session 大小用，見 sessionSize）
        if (done && /^(command_execution|file_change|mcp_tool_call|web_search)$/.test(item.type)) state.steps = (state.steps || 0) + 1;
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
        if (done) state.steps = (state.steps || 0) + 1;
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
function runAgent(agent, cfg, { prompt, cwd, sessionId, mcpConfig, systemPrompt, env, onEvent, images, addDirs, allowedTools, permissionPromptTool, settingsFile }) {
  let child;
  const state = { texts: 0, streamed: false, hidden: new Set() };
  let collected = '';
  const emit = e => {
    if (e.type === 'text') collected += e.text;
    if (e.type === 'session' && e.id) state.session = e.id;
    onEvent?.(e);
  };
  // 自訂 Agent 照指定的模型直接跑；失敗了才重讀一次模型清單（不用快取），模型不在清單就在錯誤後面說明，請使用者自己重選
  // 重讀清單時按停止：不等列模型指令跑完，直接回原本的錯誤
  let onStop;
  const stopped = new Promise(res => { onStop = res; });
  const promise = new Promise(start).then(r => (r.error && r.error !== '已停止' && !state.stopped
    ? Promise.race([explainModel(agent, cfg, r), stopped.then(() => r)]) : r));
  function start(resolve) {
    let cmd;
    try { cmd = buildCommand(agent, cfg, { prompt, sessionId, mcpConfig, systemPrompt, cwd, images, addDirs, allowedTools, permissionPromptTool, settingsFile }); }
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
      resolve({ text: collected.trim() || state.final || '', final: state.final || '', sessionId: state.session || sessionId,
        error, usage: state.usage, cost: state.cost, denials: state.denials, kind, lastUsage: state.lastUsage, steps: state.steps || 0, limitHit: state.limitHit, window: state.window });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(cmd.stdin ?? '', 'utf8');
  }
  return { promise, stop: () => { state.stopped = true; killTree(child); onStop(); } };
}

// ---------- 自訂 Agent 執行失敗時：模型還在不在清單裡 ----------
// 讀得到清單、而且指定的模型不在裡面，才補一段說明；讀不到清單就只留原本的錯誤
async function explainModel(agent, cfg, r) {
  if (!cfg?.custom || !cfg.model || !String(cfg.modelsArgs || '').trim()) return r;
  const L = await listModels(agent, cfg).catch(() => null);
  if (!L?.models?.length || L.models.includes(cfg.model)) return r;
  return { ...r, modelUnavailable: cfg.model,
    error: `${r.error}\n${tr('模型 {model} 不在 {name} 目前的模型清單裡。請在右欄或設定裡重新選擇，AgentDesk 不會自動換模型。', { name: labelOf(agent, cfg), model: cfg.model })}` };
}

// ---------- session 大小 ----------
// 這個 session 現在大約多大（tokens）＝之後每一輪至少要重送的量。各家回報方式不同（2026-11 用真的 CLI 量過）：
//   Claude：每個請求各自回報，取最後一個請求的「輸入＋快取＋輸出」，是準的
//   Codex：turn.completed 的 usage 是整個 session 的累計，一輪裡每發一次請求就把輸入再算一次
//          → 這一輪的增量 ÷ 請求數（工具呼叫數＋1），是估的；接續的 session 要靠上一輪記下的 total 才算得出增量
//   Cursor：result 的 usage 是這一輪各請求的加總，inputTokens 不含快取 → （輸入＋快取）÷ 請求數，是估的
//   其他格式（自訂 Agent）：沒有量過，不顯示
// r：runAgent 的結果；prev：上一輪記下的 { tokens, total }；resumed：這一輪是不是接續既有的 session
// 回傳 { tokens, total?, window? }，tokens 算不出來時是 null；完全沒有資料回傳 null。
// window：模型的上下文大小，只有 Claude 回報（result 的 modelUsage），其他的畫面用預設值
function sessionSize(r, prev, resumed) {
  const u = r?.usage || {};
  const sum = (o, keys) => keys.reduce((s, k) => s + (Number(o?.[k]) || 0), 0);
  const reqs = (r?.steps || 0) + 1;
  if (r?.kind === 'claude') {
    const t = sum(r.lastUsage || u, ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']);
    return t ? { tokens: t, ...(r.window ? { window: r.window } : {}) } : null;
  }
  if (r?.kind === 'codex') {
    const total = sum(u, ['input_tokens']);
    if (!total) return null;
    const delta = !resumed ? total : typeof prev?.total === 'number' && total >= prev.total ? total - prev.total : null;
    return { tokens: delta === null ? null : Math.round(delta / reqs), total };
  }
  if (r?.kind === 'cursor') {
    const t = sum(u, ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens']);
    return t ? { tokens: Math.round(t / reqs) } : null;
  }
  return null;
}

// ---------- 這一輪用了多少（每則回覆顯示、對話加總） ----------
// 各家回報方式（2026-11 用真的 CLI 看過）：
//   Claude：result 的 usage 是這一輪；輸入＝新的＋寫入快取＋讀快取，費用是 total_cost_usd（API 牌價）
//   Cursor：result 的 usage 是這一輪；輸入＝inputTokens＋快取讀寫
//   Codex、Antigravity：usage 是整個 session 的累計 → 減掉上一輪記下的（prevRaw）。接續的 session 沒有上一輪的記錄就算不出來（total: null）
//   其他格式：沒有量過，不顯示
// 回傳 { input, output, total, cost?, raw? }（raw：累計型的這一輪原始值，主程序記下來給下一輪減）；沒有資料回 null
function turnUsage(r, prevRaw, resumed) {
  const u = r?.usage;
  if (!u || typeof u !== 'object') return null;
  const n = k => Number(u[k]) || 0;
  const done = (input, output, extra = {}) => ({ input, output, total: input + output, ...(r.cost ? { cost: r.cost } : {}), ...extra });
  if (r.kind === 'claude') return done(n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens'), n('output_tokens'));
  if (r.kind === 'cursor') return done(n('inputTokens') + n('cacheReadTokens') + n('cacheWriteTokens'), n('outputTokens'));
  if (r.kind === 'codex' || r.kind === 'antigravity') {
    const raw = { input: n('input_tokens'), output: n('output_tokens') };
    if (!raw.input && !raw.output) return null;
    // 接續的 session：減掉上一輪的累計；記錄比現在還大（中間換過 session）就當成新的
    const fresh = !resumed || (prevRaw && (raw.input < prevRaw.input || raw.output < prevRaw.output));
    if (fresh) return done(raw.input, raw.output, { raw });
    if (!prevRaw) return { input: null, output: null, total: null, raw };
    return done(raw.input - prevRaw.input, raw.output - prevRaw.output, { raw });
  }
  return null;
}

// ---------- 剩餘額度 ----------
// 統一成 [{ kind: 'five_hour' | 'seven_day' | '<分鐘>m', used: 已用百分比, resetsAt: 重置時間（秒） }]
// Claude 另外有的額度也留著，例如 seven_day_overage_included：2026-11-20 實測只有用 Fable 5.2 的回合才出現
// （Haiku 的回合只有 five_hour、seven_day），畫面當成 Fable 的每週額度、只在這個對話用 Fable 時顯示（app.js 的 quotaHtml）
function claudeWindows(info) {
  const w = info?.unifiedWindows || {};
  const keys = ['five_hour', 'seven_day', ...Object.keys(w).filter(k => k !== 'five_hour' && k !== 'seven_day')];
  const out = keys.filter(k => w[k] && typeof w[k] === 'object')
    .map(k => ({ kind: k, used: Math.round((w[k].utilization || 0) * 100), resetsAt: w[k].resetsAt }));
  if (!out.length && info?.rateLimitType && typeof info.utilization === 'number') {
    out.push({ kind: info.rateLimitType, used: Math.round(info.utilization * 100), resetsAt: info.resetsAt });
  }
  return out;
}
function codexWindows(rl) {
  return ['primary', 'secondary'].map(k => rl?.[k]).filter(w => w && typeof w.usedPercent === 'number').map(w => ({
    kind: w.windowDurationMins === 300 ? 'five_hour' : w.windowDurationMins === 10080 ? 'seven_day' : `${w.windowDurationMins}m`,
    used: Math.round(w.usedPercent), resetsAt: w.resetsAt,
  }));
}

// Codex app-server：JSON-RPC 問一個問題就關掉
function codexRpc(cfg, method, params, ms = 20000) {
  return new Promise(resolve => {
    const base = resolveCli(cfg?.cli || 'codex');
    if (!base) return resolve({ error: tr('找不到 CLI') });
    // 經 proc.js 的 worker 建立行程：主程序直接 spawn codex.exe 會卡住畫面
    const child = spawnProc(base[0], [...base.slice(1), 'app-server']);
    let buf = '', done = false;
    const finish = r => { if (done) return; done = true; clearTimeout(timer); child.kill(); resolve(r); };
    const send = o => child.stdin.write(JSON.stringify(o) + '\n');
    const timer = setTimeout(() => finish({ error: tr('逾時') }), ms);
    child.on('error', e => finish({ error: e.message }));
    child.on('close', code => finish({ error: tr('{name} 結束碼 {code}', { name: 'Codex app-server', code }) }));
    child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let obj; try { obj = JSON.parse(line); } catch { continue; }
        if (obj.id === 1) { send({ method: 'initialized', params: {} }); send({ method, id: 2, params }); }
        if (obj.id === 2) finish(obj.error ? { error: obj.error.message || JSON.stringify(obj.error) } : { result: obj.result });
      }
    });
    send({ method: 'initialize', id: 1, params: { clientInfo: { name: 'agentdesk', title: 'AgentDesk', version: '0.1.0' } } });
  });
}

// Claude 的額度跟著每次回覆的 rate_limit_event 更新；Codex 可以隨時問；Cursor CLI 沒有提供
async function readLimits(agent, cfg) {
  if (agent !== 'codex' || cfg?.custom) return { windows: [] };
  const r = await codexRpc(cfg, 'account/rateLimits/read', {});
  return { windows: codexWindows(r.result?.rateLimits), plan: r.result?.rateLimits?.planType, error: r.error };
}

// ---------- 可用模型 ----------
// Claude Code 沒有列模型的指令，清單照 Claude 桌面程式：常用四個，其餘放「更多模型」
const CLAUDE_MAIN = [['claude-opus-5-5', 'Opus 5.5'], ['claude-fable-5-2', 'Fable 5.2'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-5-5', 'Haiku 5.5']];
const CLAUDE_MORE = [['claude-fable-5-1', 'Fable 5.1'], ['claude-haiku-4-5', 'Haiku 4.5'], ['claude-sonnet-5', 'Sonnet 5'], ['claude-opus-5', 'Opus 5'],
  ['claude-fable-5', 'Fable 5'], ['claude-opus-4-8', 'Opus 4.8'], ['claude-opus-4-7', 'Opus 4.7'], ['claude-opus-4-6', 'Opus 4.6'], ['claude-sonnet-4-6', 'Sonnet 4.6']];
const CLAUDE_ALIAS = [['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'], ['fable', 'Fable']];

// 自訂 Agent 列模型指令的輸出：一行一個，「id<Tab>名稱」「id - 名稱」「id  名稱」或只有 id；
// 開頭有空白分隔的說明行（例如 agy 的「Fetching available models...」）不算
function parseModelRows(out) {
  return stripAnsi(out || '').split(/\r?\n/).map(l => l.trim().match(/^([\w.\-\[\]=,:/@]+)(?:(?:\s*\t\s*|\s+-\s+|\s{2,})(.+?))?\s*(?:\((?:current|default)[^)]*\))?$/))
    .filter(r => r && !r[1].endsWith(':')).map(r => [r[1], (r[2] || r[1]).trim()]);
}

// 跑 CLI 的列模型指令（經 proc.js 的 worker，主程序不卡），rows＝[[id, 名稱]]
async function modelsFromCommand(base, args, parse) {
  const r = await runProc(base[0], [...base.slice(1), ...args], { timeout: 30000 });
  const rows = parse(r.stdout);
  const why = r.code === -1 ? tr('逾時') : (stripAnsi(r.stderr || '').trim().split(/\r?\n/)[0] || '').slice(0, 200);
  return { models: rows.map(x => x[0]), labels: Object.fromEntries(rows), error: rows.length ? null : (why || tr('讀不到模型清單')) };
}

function listModels(agent, cfg) {
  return new Promise(resolve => {
    if (cfg?.custom) {
      // 舊的 Antigravity 設定已在載入時補上 modelsArgs（shared/presets.js 的 upgradeCustom）
      const margs = String(cfg.modelsArgs || '').trim();
      if (!margs) return resolve({ models: [], error: tr('自訂 Agent 沒有模型清單，請直接輸入模型名稱') });
      const base = resolveCli(cfg.cli);
      if (!base) return resolve({ models: [], error: tr('找不到 CLI') });
      // 每次都重跑 CLI 的列模型指令，不留快取
      return modelsFromCommand(base, splitArgs(margs), parseModelRows).then(resolve, err => resolve({ models: [], error: err.message }));
    }
    if (agent === 'claude') {
      return resolve({ models: CLAUDE_MAIN.map(m => m[0]), more: CLAUDE_MORE.map(m => m[0]),
        labels: Object.fromEntries([...CLAUDE_MAIN, ...CLAUDE_MORE, ...CLAUDE_ALIAS]) });
    }
    const base = resolveCli(cfg.cli || agent);
    if (!base) return resolve({ models: [], error: tr('找不到 CLI') });
    if (agent === 'cursor') {
      const parse = out => stripAnsi(out || '').split(/\r?\n/).map(l => l.match(/^([\w.\-\[\]=,]+)\s+-\s+(.+?)\s*(?:\((?:current|default)[^)]*\))?\s*$/)).filter(Boolean).map(r => [r[1], r[2]]);
      return modelsFromCommand(base, ['models'], parse).then(resolve, err => resolve({ models: [], error: err.message }));
    }
    // codex：app-server JSON-RPC model/list
    codexRpc(cfg, 'model/list', { limit: 100, includeHidden: false }).then(r => {
      const data = (r.result?.data || []).filter(m => m.model || m.id);
      const models = data.map(m => m.model || m.id);
      resolve({ models, labels: Object.fromEntries(data.map(m => [m.model || m.id, m.displayName || m.model || m.id])),
        error: models.length ? null : (r.error || tr('讀不到模型清單')) });
    });
  });
}

module.exports = { runAgent, listModels, readLimits, sessionSize, turnUsage, toolDetail, LABEL, labelOf };
// 給 tools/validate.js 做單元測試用
module.exports._test = { PARSERS, buildCommand, cursorModel, splitArgs, claudeWindows, codexWindows, parseModelRows, explainModel };
