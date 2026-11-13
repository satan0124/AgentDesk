#!/usr/bin/env node
// AgentDesk 專用驗證工具。
//
//   node tools/validate.js            快速：靜態檢查 + 單元測試 + 假 Agent 整合測試（不開視窗、不花額度，約數秒）
//   node tools/validate.js --e2e      再加 Electron 畫面測試（假 Agent，不花額度）
//   node tools/validate.js --live     再加真的 Claude／Codex／Cursor 各問一句（會用到額度）
//   node tools/validate.js --hook     給 Claude Code 的 Stop hook 用：程式有變才跑（快速 + e2e），
//                                      失敗時 exit 2 讓 Claude 繼續修；沒變就直接通過
//
// 結果同時寫到 .claude/validate-last.md。
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const FIX = path.join(__dirname, 'validate', 'fixtures');
const STATE_DIR = path.join(ROOT, '.claude');
const STATE_FILE = path.join(STATE_DIR, 'validate-state.json');
const REPORT_FILE = path.join(STATE_DIR, 'validate-last.md');
const args = process.argv.slice(2);
const HOOK = args.includes('--hook');
const E2E = HOOK || args.includes('--e2e') || args.includes('--live');
const LIVE = args.includes('--live');
const CJK = /[一-鿿]/;

const results = [];   // { name, status: 'pass'|'fail'|'skip', detail }
const pass = (name, detail = '') => results.push({ name, status: 'pass', detail });
const fail = (name, detail) => results.push({ name, status: 'fail', detail });
const skip = (name, detail) => results.push({ name, status: 'skip', detail });
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const rel = p => path.relative(ROOT, p).split(path.sep).join('/');
const nodeExe = process.execPath;

function listJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJs(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function check(name, fn) {
  try { const d = await fn(); if (d === 'SKIP') return; pass(name, typeof d === 'string' ? d : ''); }
  catch (e) { fail(name, e.message); }
}

// ======================================================================
// 靜態檢查
// ======================================================================
async function staticChecks() {
  await check('語法：src、tools 全部 .js 可解析', () => {
    const files = [...listJs(SRC), ...listJs(path.join(ROOT, 'tools'))].filter(f => !f.includes(`${path.sep}fixtures${path.sep}`) && !f.endsWith('e2e-check.js'));
    const bad = [];
    for (const f of files) {
      const r = spawnSync(nodeExe, ['--check', f], { encoding: 'utf8' });
      if (r.status !== 0) bad.push(`${rel(f)}: ${(r.stderr || '').split('\n').find(l => /Error/.test(l)) || 'error'}`);
    }
    assert(!bad.length, bad.join('；'));
    return `${files.length} 檔`;
  });

  await check('翻譯：t()／tr() 的中文 key 都有英文，佔位一致', () => {
    const { EN } = require(path.join(SRC, 'shared', 'i18n.js'));
    const problems = [];
    const keyRe = /\b(?:t|tr)\(\s*(['`])((?:\\.|(?!\1).)*)\1/g;
    const ternRe = /\b(?:t|tr)\(\s*[^'`()]*\?\s*'([^']*)'\s*:\s*'([^']*)'/g;
    for (const f of ['src/renderer/app.js', 'src/main.js', 'src/agents.js', 'src/connect.js']) {
      const src = read(f);
      const keys = [...src.matchAll(keyRe)].map(m => m[2]).concat([...src.matchAll(ternRe)].flatMap(m => [m[1], m[2]]));
      for (let k of keys) {
        k = k.replace(/\\n/g, '\n').replace(/\\'/g, "'");
        if (!CJK.test(k) || k.includes('${')) continue;
        if (!(k in EN)) problems.push(`${f} 缺英文：${k.slice(0, 30)}`);
      }
    }
    const { CN } = require(path.join(SRC, 'shared', 'i18n.js'));
    const ph = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
    for (const [k, v] of Object.entries(EN)) {
      if (!v) problems.push(`空翻譯：${k.slice(0, 30)}`);
      else if (ph(k) !== ph(v)) problems.push(`英文佔位不一致：${k.slice(0, 30)}`);
      if (CJK.test(k) && !(k in CN)) problems.push(`缺簡中：${k.slice(0, 30)}`);
      else if (CJK.test(k) && ph(k) !== ph(CN[k])) problems.push(`簡中佔位不一致：${k.slice(0, 30)}`);
    }
    assert(!problems.length, problems.slice(0, 8).join('；') + (problems.length > 8 ? `…共 ${problems.length} 項` : ''));
    return `英文 ${Object.keys(EN).length}、簡中 ${Object.keys(CN).length} 條對照`;
  });

  await check('IPC：preload 用到的頻道 main 都有處理；畫面呼叫的 api 都有開放', () => {
    const main = read('src/main.js'), preload = read('src/preload.js'), app = read('src/renderer/app.js');
    const handled = new Set([...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map(m => m[1]));
    const invoked = new Set([...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(m => m[1]));
    const exposed = new Set([...preload.matchAll(/^\s{2}(\w+):/gm)].map(m => m[1]));
    const used = new Set([...app.matchAll(/\bapi\.(\w+)\(/g)].map(m => m[1]));
    const sent = new Set([...main.matchAll(/send\('([^']+)'/g)].map(m => m[1]));
    const listened = new Set([...app.matchAll(/api\.on\('([^']+)'/g)].map(m => m[1]));
    const p = [];
    for (const c of invoked) if (!handled.has(c)) p.push(`preload 呼叫 ${c} 但 main 沒有 handle`);
    for (const a of used) if (!exposed.has(a)) p.push(`畫面呼叫 api.${a} 但 preload 沒開放`);
    for (const c of listened) if (!sent.has(c)) p.push(`畫面監聽 ${c} 但 main 從不送出`);
    assert(!p.length, p.join('；'));
    return `${handled.size} 個頻道`;
  });

  await check('DOM：畫面用到的 #id 在 index.html 或程式產生的 HTML 裡都存在', () => {
    const app = read('src/renderer/app.js'), html = read('src/renderer/index.html');
    const ids = new Set([...app.matchAll(/\$\('#([\w-]+)/g), ...app.matchAll(/getElementById\('([\w-]+)'/g)].map(m => m[1]));
    const defined = new Set([...html.matchAll(/id="([\w-]+)"/g), ...app.matchAll(/id="([\w-]+)"/g), ...app.matchAll(/\.id = '([\w-]+)'/g)].map(m => m[1]));
    const missing = [...ids].filter(i => !defined.has(i));
    assert(!missing.length, `找不到：${missing.join(', ')}`);
    return `${ids.size} 個`;
  });

  await check('防回歸：主程序不用同步子行程、開視窗不用 detached', () => {
    const p = [];
    for (const f of ['src/main.js', 'src/connect.js', 'src/cli.js', 'src/agents.js', 'src/proc.js']) {
      const s = read(f).split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
      if (/\b(execFileSync|execSync|spawnSync)\s*\(/.test(s)) p.push(`${f} 用了同步子行程（會卡住整個視窗）`);
      if (/detached:\s*true/.test(s)) p.push(`${f} 用了 detached:true（Windows 上不會出現視窗）`);
    }
    const mainSrc = read('src/main.js');
    if (!/will-navigate/.test(mainSrc) || !/setWindowOpenHandler/.test(mainSrc)) p.push('main.js 少了攔截跳頁（點本機檔案連結會把視窗換掉）');
    assert(!p.length, p.join('；'));
  });

  await check('打包設定：worker 入口在 asarUnpack、icon 有打包', () => {
    const pkg = JSON.parse(read('package.json'));
    const b = pkg.build || {};
    assert((b.asarUnpack || []).some(x => /spawner\.js/.test(x)), 'build.asarUnpack 沒有 src/spawner.js（打包後 worker 起不來）');
    assert(/app\.asar\.unpacked/.test(read('src/proc.js')), 'proc.js 沒有改用 app.asar.unpacked 的 spawner');
    assert((b.files || []).some(x => /icon\.ico/.test(x)), 'build.files 沒有 build/icon.ico');
    assert(fs.existsSync(path.join(ROOT, 'build', 'icon.ico')), 'build/icon.ico 不存在');
    return `v${pkg.version}`;
  });
}

// ======================================================================
// 單元測試
// ======================================================================
async function unitTests() {
  const agents = require(path.join(SRC, 'agents.js'));
  const { PARSERS, buildCommand, splitArgs } = agents._test;
  const run = (kind, lines) => {
    const evs = [], state = { texts: 0, streamed: false, hidden: new Set() };
    const parse = PARSERS[kind](e => evs.push(e), state);
    for (const l of lines) parse(l);
    return { evs, state, text: evs.filter(e => e.type === 'text').map(e => e.text).join('') };
  };

  await check('解析：Claude stream-json（串流文字、工具、委派工具隱藏）', () => {
    const r = run('claude', [
      { type: 'system', subtype: 'init', session_id: 's1' },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls' } }, { type: 'tool_use', id: 'b', name: 'mcp__agents__ask_codex', input: {} }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }, { type: 'tool_result', tool_use_id: 'b', content: 'y' }] } },
      { type: 'result', result: 'Hello', session_id: 's1' },
    ]);
    assert(r.text === 'Hello', `文字=${r.text}`);
    const tools = r.evs.filter(e => e.type === 'tool');
    assert(tools.length === 2 && tools.every(t => t.id === 'a'), `委派工具沒有隱藏：${JSON.stringify(tools)}`);
  });

  await check('解析：Codex --json', () => {
    const r = run('codex', [
      { type: 'thread.started', thread_id: 't1' },
      { type: 'item.started', item: { id: 'c', type: 'command_execution', command: 'dir' } },
      { type: 'item.completed', item: { id: 'c', type: 'command_execution', command: 'dir', exit_code: 0, aggregated_output: 'ok' } },
      { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'done' } },
    ]);
    assert(r.text === 'done', `文字=${r.text}`);
    assert(r.evs.some(e => e.type === 'session' && e.id === 't1'), '沒有 session');
    assert(r.evs.filter(e => e.type === 'tool').pop().status === 'done', '工具狀態不是 done');
  });

  await check('解析：Cursor stream-json（增量不重複）', () => {
    const r = run('cursor', [
      { type: 'system', subtype: 'init', session_id: 'u1' },
      { type: 'assistant', message: { content: [{ type: 'text', text: '我來' }] }, timestamp_ms: 1 },
      { type: 'assistant', message: { content: [{ type: 'text', text: '讀' }] }, timestamp_ms: 2 },
      { type: 'assistant', message: { content: [{ type: 'text', text: '我來讀' }] }, timestamp_ms: 3, model_call_id: 'x' },
      { type: 'tool_call', subtype: 'started', call_id: 'k', tool_call: { readToolCall: { args: { path: 'a' } } } },
      { type: 'assistant', message: { content: [{ type: 'text', text: '好' }] }, timestamp_ms: 4 },
      { type: 'assistant', message: { content: [{ type: 'text', text: '好' }] } },
      { type: 'result', result: '我來讀好' },
    ]);
    assert(r.text === '我來讀好', `文字重複或缺漏：${r.text}`);
  });

  await check('解析：Gemini stream-json', () => {
    const r = run('gemini', [
      { type: 'init', session_id: 'g1' },
      { type: 'message', role: 'user', content: 'q' },
      { type: 'tool_use', tool_name: 'read_file', tool_id: 't', parameters: { path: 'x' } },
      { type: 'tool_result', tool_id: 't', status: 'success', output: 'o' },
      { type: 'message', role: 'assistant', content: 'A', delta: true },
      { type: 'message', role: 'assistant', content: 'B', delta: true },
      { type: 'result', status: 'success' },
    ]);
    assert(r.text === 'AB', `文字=${r.text}`);
  });

  await check('解析：Antigravity（agy）stream-json', () => {
    const r = run('antigravity', [
      { event: 'init', conversation_id: 'c1', init: {} },
      { event: 'step_update', step_update: { conversation_id: 'c1', step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { command: 'dir' } } } },
      { event: 'step_update', step_update: { conversation_id: 'c1', step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { output: 'ok' } } },
      { event: 'step_update', step_update: { conversation_id: 'c1', step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Hi' } },
      { event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'Hi' } },
    ]);
    assert(r.text === 'Hi', `文字=${r.text}`);
    const tools = r.evs.filter(e => e.type === 'tool');
    assert(tools.length === 2 && tools[1].status === 'done' && tools[0].id === tools[1].id, `工具事件不對：${JSON.stringify(tools)}`);
    const bad = run('antigravity', [{ event: 'result', result: { status: 'ERROR', error: 'authentication required' } }]);
    assert(bad.state.error === 'authentication required', '錯誤狀態沒有帶出');
  });

  await check('指令組成：內建三個 Agent 與自訂三種 prompt 傳法', () => {
    const cwd = os.tmpdir();
    const c = buildCommand('codex', { cli: nodeExe, model: 'm', effort: 'high', sandbox: 'read-only' }, { prompt: 'p', sessionId: 's', cwd, images: ['a.png'] });
    const ci = c.args.indexOf('resume');
    assert(ci > 0 && c.args[ci + 1] === 's' && c.args.includes('--image=a.png') && c.args[c.args.length - 1] === '-', `codex：${c.args.join(' ')}`);
    const cl = buildCommand('claude', { cli: nodeExe, permission: 'plan' }, { prompt: 'p', cwd, mcpConfig: 'x.json', allowedTools: ['mcp__agents__ask_codex'] });
    assert(cl.args.slice(-3).join(' ') === 'x.json --allowedTools mcp__agents__ask_codex', `claude allowedTools 要放最後：${cl.args.slice(-4).join(' ')}`);
    const cu = buildCommand('cursor', { cli: nodeExe, model: 'gpt-5', effort: 'high', permission: 'force' }, { prompt: 'p', cwd });
    assert(cu.args.includes('gpt-5[effort=high]') && cu.args.includes('--force'), `cursor：${cu.args.join(' ')}`);
    const base = { custom: true, cli: nodeExe, args: '"a b" --x {cwd}', modelFlag: '-m', model: 'mm', resumeFlag: '--r' };
    const s1 = buildCommand('x', { ...base, promptMode: 'stdin' }, { prompt: 'P', cwd, sessionId: 'S' });
    assert(s1.args.includes('a b') && s1.args.includes(cwd) && s1.stdin === 'P' && s1.args.join(' ').includes('-m mm --r S'), `stdin：${s1.args.join(' ')}`);
    const s2 = buildCommand('x', { ...base, promptMode: 'arg', promptFlag: '-p' }, { prompt: 'P', cwd });
    assert(s2.args.slice(-2).join(' ') === '-p P' && s2.stdin === '', `arg：${s2.args.join(' ')}`);
    const s3 = buildCommand('x', { ...base, promptMode: 'stream-json' }, { prompt: 'P\n2', cwd });
    assert(JSON.parse(s3.stdin).message.content === 'P\n2', `stream-json stdin：${s3.stdin}`);
    assert(splitArgs('a "b c" d').length === 3, 'splitArgs 雙引號');
  });

  await check('語言：系統語言對應', () => {
    const { pickLang, t, setLang } = require(path.join(SRC, 'shared', 'i18n.js'));
    const cases = [[['zh-Hant-TW'], 'zh-TW'], [['zh-TW'], 'zh-TW'], [['zh-HK'], 'zh-TW'], [['zh-CN'], 'zh-CN'], [['zh-Hans-CN'], 'zh-CN'], [['zh-SG'], 'zh-CN'], [['zh'], 'zh-CN'], [['en-US'], 'en'], [['ja-JP'], 'en'], [[], 'en']];
    for (const [sys, want] of cases) assert(pickLang('auto', sys) === want, `${sys} → ${pickLang('auto', sys)}，應為 ${want}`);
    assert(pickLang('zh-TW', ['en-US']) === 'zh-TW' && pickLang('en', ['zh-TW']) === 'en' && pickLang('zh-CN', ['en-US']) === 'zh-CN', '手動指定沒有優先');
    setLang('en'); const en = t('等待 {name} 完成', { name: 'X' }); setLang('zh-TW');
    assert(en === 'Waiting for X', `代換錯誤：${en}`);
  });

  await check('訊息組裝：委派卡片內的事件放進卡片', () => {
    const { applyEvent } = require(path.join(SRC, 'shared', 'reduce.js'));
    const m = { parts: [] };
    applyEvent(m, { type: 'text', text: 'a' });
    applyEvent(m, { type: 'delegate_start', id: 'd', agent: 'codex', prompt: 'p' });
    applyEvent(m, { type: 'tool', id: 't', name: 'shell', status: 'running', del: 'd' });
    applyEvent(m, { type: 'tool', id: 't', status: 'done', del: 'd' });
    applyEvent(m, { type: 'delegate_end', id: 'd', error: '已停止' });
    const d = m.parts.find(p => p.kind === 'delegate');
    assert(d.parts.length === 1 && d.parts[0].status === 'done' && d.status === 'stopped', JSON.stringify(m));
  });
}

// ======================================================================
// 整合測試（假 Agent，經過 worker 建立子行程）
// ======================================================================
async function integrationTests() {
  const { runAgent } = require(path.join(SRC, 'agents.js'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-validate-'));
  const custom = (file, extra) => ({ custom: true, enabled: true, name: 'T', cli: nodeExe, args: `"${path.join(FIX, file)}"`, ...extra });
  const go = (cfg, prompt, sessionId) => runAgent('xt', cfg, { prompt, cwd, sessionId, onEvent: () => {} }).promise;

  await check('執行：純文字 Agent', async () => {
    const r = await go(custom('fake-echo.js', { format: 'text', promptMode: 'stdin' }), 'line1\nhello');
    assert(!r.error && /Echo got: hello/.test(r.text), `${r.error || r.text}`);
  });
  await check('執行：Gemini 格式＋模型旗標＋接續 session', async () => {
    const cfg = custom('fake-gemini.js', { format: 'gemini', promptMode: 'stdin', modelFlag: '-m', model: 'g', resumeFlag: '--resume' });
    const r1 = await go(cfg, 'q');
    const r2 = await go(cfg, 'q', r1.sessionId);
    assert(r1.sessionId === 'gem-123' && /resume=gem-123/.test(r2.text) && /model=g/.test(r2.text), `${r1.sessionId} / ${r2.text}`);
  });
  await check('執行：Antigravity（agy）格式＋stdin JSON＋接續對話', async () => {
    const cfg = custom('fake-agy.js', { format: 'antigravity', promptMode: 'stream-json', modelFlag: '--model', model: 'gm', resumeFlag: '--conversation' });
    const r1 = await go(cfg, '長一點的\n多行 prompt "含引號"');
    const r2 = await go(cfg, 'again', r1.sessionId);
    assert(/agy got: 多行 prompt "含引號"/.test(r1.text), `第一輪：${r1.error || r1.text}`);
    assert(r1.sessionId === 'conv-abc' && /conv=conv-abc/.test(r2.text), `接續：${r1.sessionId} / ${r2.text}`);
  });
  await check('執行：停止能砍掉執行中的 Agent', async () => {
    const run = runAgent('xt', custom('fake-slow.js', { format: 'text' }), { prompt: '', cwd, onEvent: () => {} });
    await new Promise(r => setTimeout(r, 600));
    const t0 = Date.now();
    run.stop();
    const r = await Promise.race([run.promise, new Promise(r => setTimeout(() => r({ error: 'TIMEOUT' }), 8000))]);
    assert(r.error === '已停止', `停止後狀態：${r.error}`);
    return `${Date.now() - t0}ms`;
  });
  await check('執行：找不到 CLI 時回報錯誤而不是當掉', async () => {
    const r = await runAgent('xt', { custom: true, cli: 'agentdesk-no-such-cli', format: 'text' }, { prompt: 'x', cwd, onEvent: () => {} }).promise;
    assert(r.error && /agentdesk-no-such-cli/.test(r.error), String(r.error));
  });
  await check('偵測：自訂 Agent 找得到／找不到', async () => {
    const connect = require(path.join(SRC, 'connect.js'));
    const ok = await connect.check('xt', { custom: true, cli: nodeExe, versionArgs: '--version' }, true);
    const no = await connect.check('xt', { custom: true, cli: 'agentdesk-no-such-cli', installCmd: 'echo hi' }, true);
    assert(ok.found && /^v\d+/.test(ok.version) && ok.loggedIn === null, JSON.stringify(ok));
    assert(!no.found && no.install?.cmd === 'echo hi', JSON.stringify(no));
  });
  await check('委派：MCP bridge 依清單產生 ask_<id> 工具', async () => {
    const env = { ...process.env, AGENTDESK_HELPERS: JSON.stringify([{ id: 'codex', name: 'Codex' }, { id: 'xabc', name: 'My Agent' }]) };
    const p = spawn(nodeExe, [path.join(SRC, 'mcp-bridge.js')], { env });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    await new Promise(r => setTimeout(r, 800));
    p.kill();
    const list = out.split('\n').filter(Boolean).map(l => JSON.parse(l)).find(m => m.id === 2);
    const names = list?.result?.tools?.map(t => t.name) || [];
    assert(names.join() === 'ask_codex,ask_xabc', `工具：${names.join()}`);
  });
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
}

// ======================================================================
// Electron 畫面測試（假 Agent）
// ======================================================================
async function e2eTests() {
  const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (!fs.existsSync(electron)) return skip('畫面測試', '沒有 node_modules/electron，先 npm install');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-e2e-'));
  const data = path.join(dir, 'data');
  fs.mkdirSync(data, { recursive: true });
  const c = (file, extra) => ({ custom: true, enabled: true, delegate: true, cli: nodeExe, args: `"${path.join(FIX, file)}"`, ...extra });
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
    language: 'en', defaultCwd: dir, delegation: true,
    agents: {
      claude: { enabled: true, cli: 'claude', model: '', effort: '', permission: 'acceptEdits' },
      codex: { enabled: false, cli: 'codex' }, cursor: { enabled: false, cli: 'agent' },
      xecho: c('fake-echo.js', { name: 'Echo', color: '#22aa88', format: 'text', promptMode: 'stdin' }),
      xagy: c('fake-agy.js', { name: 'Agy', color: '#4f8ef7', format: 'antigravity', promptMode: 'stream-json', modelFlag: '--model', resumeFlag: '--conversation' }),
    },
  }, null, 2));
  const checkJs = fs.readFileSync(path.join(__dirname, 'validate', 'e2e-check.js'), 'utf8');
  const launch = async (language, steps, foreign) => {
    const s = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));
    s.language = language;
    fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify(s, null, 2));
    const env = { ...process.env, AGENTDESK_DATA: data, AGENTDESK_SELFTEST: dir, AGENTDESK_SELFTEST_STEPS: JSON.stringify(steps),
      AGENTDESK_SELFTEST_SHOTS: JSON.stringify([[`e2e-${language}`, '']]),
      AGENTDESK_SELFTEST_JS: (foreign ? `window.__FOREIGN = ${JSON.stringify(foreign)};\n` : '') + checkJs };
    delete env.ELECTRON_RUN_AS_NODE;
    const out = await new Promise(resolve => {
      // --no-sandbox：只在測試時用（從受限環境啟動時 Chromium 沙箱會讓渲染程序崩潰）
      const p = spawn(electron, [ROOT, '--no-sandbox'], { env, windowsHide: true });
      let buf = '';
      p.stdout.on('data', d => { buf += d; });
      p.stderr.on('data', d => { buf += d; });
      const timer = setTimeout(() => { p.kill(); resolve(buf + '\n[timeout]'); }, 90000);
      p.on('close', () => { clearTimeout(timer); resolve(buf); });
    });
    const line = out.split('\n').find(l => l.startsWith('[st] js '));
    if (!line) { fail(`畫面測試（${language}）：程式啟動並跑完`, (out.match(/Error[^\n]*/) || [out.slice(-300)])[0]); return null; }
    try { return JSON.parse(line.slice(8)); } catch (e) { fail(`畫面測試（${language}）：結果解析`, e.message); return null; }
  };
  const r = await launch('en', [['xecho', 'hello from validate'], ['xagy', 'first'], ['xagy', 'second']]);
  if (!r) return;
  const msgs = r.messages || [];
  await check('畫面：英文介面沒有殘留中文', () => assert(r.uiLang === 'en' && !r.cjkLeft.length && !r.settingsCjk.length, `${r.uiLang} ${[...r.cjkLeft, ...r.settingsCjk].join('；')}`));
  await check('畫面：切換列與右欄列出已加入的 Agent', () => assert(r.picker.join() === 'claude,xecho,xagy' && r.panelCards === 3, `${r.picker} / ${r.panelCards}`));
  await check('畫面：純文字 Agent 回覆', () => assert(msgs[0]?.status === 'done' && /Echo got: hello from validate/.test(msgs[0].text), JSON.stringify(msgs[0])));
  await check('畫面：agy 兩輪（工具卡片＋接續對話）', () => {
    assert(msgs[1]?.status === 'done' && msgs[1].tools.includes('run_command:done'), JSON.stringify(msgs[1]));
    assert(/conv=conv-abc/.test(msgs[2]?.text || ''), JSON.stringify(msgs[2]));
  });
  await check('畫面：設定頁偵測與存檔不卡', () => {
    assert(r.settingsConn.xecho === 'ok' && r.settingsConn.xagy === 'ok', JSON.stringify(r.settingsConn));
    assert(r.saveMs < 1000, `存檔等了 ${r.saveMs}ms`);
    return `存檔 ${r.saveMs}ms`;
  });
  await check('畫面：圖片預覽能開能關、主視窗不會被導走', () => assert(r.lightbox && r.navigationBlocked, JSON.stringify({ lightbox: r.lightbox, nav: r.navigationBlocked })));
  await check('畫面：側欄右鍵選單、釘選、封存、依專案分類', () => assert(
    ['pin', 'rename', 'archive', 'delete'].every(a => r.ctxItems?.includes(a)) && !r.ctxCjk.length && !r.viewCjk
      && r.pinned && r.archived && r.unarchived && r.projectView,
    JSON.stringify({ items: r.ctxItems, cjk: r.ctxCjk, viewCjk: r.viewCjk, pinned: r.pinned, archived: r.archived, unarchived: r.unarchived, project: r.projectView })));
  await check('畫面：新對話在輸入框上方選資料夾（最近使用）', () => { const p = r.cwdPick || {};
    assert(p.hiddenWithMsgs && p.shown && p.open && p.dirs >= 1 && p.checked === 1 && p.browse && p.closed && !r.cwdPickCjk?.length,
      JSON.stringify({ ...p, cjk: r.cwdPickCjk })); });
  // 簡中：只有繁體才有的字（出現在繁中原文、但沒出現在任何簡中翻譯裡）不應留在畫面上
  const { CN } = require(path.join(SRC, 'shared', 'i18n.js'));
  const simp = new Set([...Object.values(CN).join('')]);
  const trad = [...new Set([...Object.keys(CN).join('')])].filter(ch => CJK.test(ch) && !simp.has(ch));
  const rc = await launch('zh-CN', [['xecho', 'hello'], ['xagy', 'first']], `[${trad.join('')}]`);
  if (rc) await check('畫面：簡中介面沒有殘留繁體字', () => assert(rc.uiLang === 'zh-CN' && !rc.cjkLeft.length && !rc.settingsCjk.length && !rc.ctxCjk.length && !rc.viewCjk && !rc.cwdPickCjk?.length,
    `${rc.uiLang} ${[...rc.cjkLeft, ...rc.settingsCjk, ...rc.ctxCjk, ...(rc.cwdPickCjk || [])].join('；')}${rc.viewCjk ? '；分類切換鈕' : ''}`));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ======================================================================
// 真的 CLI（花額度）
// ======================================================================
async function liveTests() {
  const { runAgent } = require(path.join(SRC, 'agents.js'));
  const { resolveCli } = require(path.join(SRC, 'cli.js'));
  const cwd = os.tmpdir();
  const cfgs = { claude: { cli: 'claude', model: 'haiku', permission: 'plan' }, codex: { cli: 'codex', sandbox: 'read-only', effort: 'low' }, cursor: { cli: 'agent', permission: 'ask' } };
  for (const [a, cfg] of Object.entries(cfgs)) {
    if (!resolveCli(cfg.cli)) { skip(`真實：${a}`, '沒有安裝'); continue; }
    await check(`真實：${a} 兩輪接續`, async () => {
      const r1 = await runAgent(a, cfg, { prompt: '記住數字 42，只回覆「好」。', cwd, onEvent: () => {} }).promise;
      assert(!r1.error, r1.error);
      const r2 = await runAgent(a, cfg, { prompt: '剛剛的數字是多少？只回數字。', cwd, sessionId: r1.sessionId, onEvent: () => {} }).promise;
      assert(!r2.error && /42/.test(r2.text), r2.error || r2.text);
    });
  }
}

// ======================================================================
// 主流程
// ======================================================================
function fingerprint() {
  const h = crypto.createHash('sha1');
  const files = [...listJs(SRC), ...listJs(path.join(ROOT, 'tools')),
    path.join(SRC, 'renderer', 'index.html'), path.join(SRC, 'renderer', 'style.css'), path.join(ROOT, 'package.json')]
    .filter(f => fs.existsSync(f)).sort();
  for (const f of files) h.update(rel(f)).update(fs.readFileSync(f));
  return h.digest('hex');
}
function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function writeState(s) { try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {} }
function readHookInput() {
  if (!HOOK || process.stdin.isTTY) return {};
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

function report(ms, mode) {
  const icon = { pass: '✓', fail: '✗', skip: '–' };
  const n = s => results.filter(r => r.status === s).length;
  const lines = [`AgentDesk 驗證（${mode}）${new Date().toLocaleString()}　${(ms / 1000).toFixed(1)}s`];
  for (const r of results) lines.push(`${icon[r.status]} ${r.name}${r.detail ? `：${r.detail}` : ''}`);
  lines.push(`結果：通過 ${n('pass')}／未通過 ${n('fail')}／略過 ${n('skip')}`);
  const md = [
    `# AgentDesk 驗證報告`, '', `- 時間：${new Date().toLocaleString()}`, `- 模式：${mode}`, `- 耗時：${(ms / 1000).toFixed(1)}s`, '',
    '## 驗證通過', '', ...results.filter(r => r.status === 'pass').map(r => `- ${r.name}${r.detail ? `（${r.detail}）` : ''}`), '',
    '## 驗證未通過', '', ...(n('fail') ? results.filter(r => r.status === 'fail').map(r => `- ${r.name}：${r.detail}`) : ['無。']), '',
    '## 略過', '', ...(n('skip') ? results.filter(r => r.status === 'skip').map(r => `- ${r.name}：${r.detail}`) : ['無。']), '',
    '## 無法自動驗證（需手動試）', '',
    '- 真的 Claude／Codex／Cursor 對話與委派（`--live` 只測 CLI 兩輪接續，委派需在畫面上試）',
    '- 安裝／登入按鈕開出的 PowerShell 視窗與瀏覽器授權流程',
    '- 貼上截圖、拖曳檔案、選檔對話框等實際滑鼠鍵盤操作',
    '- 打包後的安裝版安裝流程（`npm run dist` 之後）',
  ].join('\n');
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(REPORT_FILE, md + '\n'); } catch {}
  return lines.join('\n');
}

(async () => {
  const hookInput = readHookInput();
  const fp = fingerprint();
  const state = readState();
  if (HOOK && state.lastPass === fp) process.exit(0);        // 上次驗證後沒改過程式
  const t0 = Date.now();
  await staticChecks();
  await unitTests();
  await integrationTests();
  if (E2E) await e2eTests();
  if (LIVE) await liveTests();
  const mode = LIVE ? '快速＋畫面＋真實 CLI' : E2E ? '快速＋畫面' : '快速';
  const text = report(Date.now() - t0, mode);
  const failed = results.some(r => r.status === 'fail');
  if (!failed) {
    writeState({ ...state, lastPass: fp, lastFail: null, at: new Date().toISOString() });
    console.log(text);
    process.exit(0);
  }
  if (HOOK) {
    // 修了一輪還是同樣失敗就放行，避免 Stop hook 無限循環；結果仍留在報告裡
    const failKey = crypto.createHash('sha1').update(fp + results.filter(r => r.status === 'fail').map(r => r.name).join()).digest('hex');
    const repeated = hookInput.stop_hook_active && state.lastFail === failKey;
    writeState({ ...state, lastFail: failKey, at: new Date().toISOString() });
    process.stderr.write(`AgentDesk 驗證未通過，請修正後再結束（報告：.claude/validate-last.md）\n${text}\n`);
    process.exit(repeated ? 0 : 2);
  }
  console.log(text);
  process.exit(1);
})().catch(e => { console.error('驗證工具本身出錯：', e); process.exit(HOOK ? 0 : 1); });
