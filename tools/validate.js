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
    const files = [...listJs(SRC), ...listJs(path.join(ROOT, 'tools'))].filter(f => !f.includes(`${path.sep}fixtures${path.sep}`));
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
    for (const f of ['src/renderer/app.js', 'src/main.js', 'src/agents.js', 'src/connect.js', 'src/mode.js', 'src/work.js', 'src/transcript.js', 'src/compress.js']) {
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

  // 原生的 confirm／alert 在 Windows 上關掉後，輸入框拿不回鍵盤焦點（要把視窗縮到工作列再打開）。一律用 app.js 的 confirmBox／alertBox
  await check('畫面程式不用原生的 confirm／alert', () => {
    const src = read('src/renderer/app.js');
    const hit = src.split(/\r?\n/).map((l, i) => [i + 1, l]).filter(([, l]) => /(^|[^\w.])(confirm|alert|prompt)\(/.test(l.replace(/\/\/.*$/, '')));
    assert(!hit.length, `app.js 第 ${hit.map(h => h[0]).join('、')} 行用了原生視窗`);
    assert(/function confirmBox\(/.test(src) && /function alertBox\(/.test(src) && /id="askModal"/.test(read('src/renderer/index.html')), '少了頁面內的確認視窗');
  });

  // exe 只在本機打包（npm run dist），不上傳到 Releases；一般使用者從原始碼執行
  await check('啟動與打包設定：npm start、AgentDesk.bat、本機打包', () => {
    const pkg = JSON.parse(read('package.json'));
    const b = pkg.build || {};
    assert(pkg.scripts?.start === 'electron .' && pkg.devDependencies?.electron, 'package.json 缺 start 指令或 electron');
    assert(/electron\.exe/.test(read('AgentDesk.bat')), 'AgentDesk.bat 沒有啟動 electron');
    // 從原始碼執行時工作列上跑的是 electron.exe：沒有告訴 Windows 釘選要記的指令與圖示，釘選後開出來的是 Electron 的預設頁
    const mainSrc = read('src/main.js');
    assert(/setAppDetails\(/.test(mainSrc) && /relaunchCommand:/.test(mainSrc) && /relaunchDisplayName:/.test(mainSrc) && /appIconPath:/.test(mainSrc) && /!app\.isPackaged/.test(mainSrc),
      'main.js 沒有設定釘選到工作列時的啟動指令與圖示（win.setAppDetails）');
    assert(/--publish never/.test(pkg.scripts?.dist || ''), 'dist 指令要加 --publish never（exe 不上傳）');
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
  const { PARSERS, buildCommand, splitArgs, claudeWindows, codexWindows } = agents._test;
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

  await check('額度：Claude rate_limit_event 與 Codex rateLimits 換算', () => {
    const r = run('claude', [{ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: {
      five_hour: { utilization: 0.24, resetsAt: 100 }, seven_day: { utilization: 0.02, resetsAt: 200 }, seven_day_overage_included: { utilization: 0 } } } }]);
    const lim = r.evs.find(e => e.type === 'limits');
    assert(lim && JSON.stringify(lim.windows) === JSON.stringify([{ kind: 'five_hour', used: 24, resetsAt: 100 }, { kind: 'seven_day', used: 2, resetsAt: 200 }]), JSON.stringify(lim));
    assert(!claudeWindows({}).length, '沒有資料時應該是空的');
    const cw = codexWindows({ primary: { usedPercent: 21, windowDurationMins: 300, resetsAt: 1 }, secondary: { usedPercent: 73, windowDurationMins: 10080, resetsAt: 2 } });
    assert(JSON.stringify(cw) === JSON.stringify([{ kind: 'five_hour', used: 21, resetsAt: 1 }, { kind: 'seven_day', used: 73, resetsAt: 2 }]), JSON.stringify(cw));
  });

  await check('上下文：保留最新往來、補回開頭需求、委派回覆截短', () => {
    const { buildContext, delegateReply, BUDGETS } = require(path.join(SRC, 'context.js'));
    const msgText = m => m.text;
    const line = (m, t) => `${m.role === 'user' ? 'U→' + m.agent : m.agent}:${t}`;
    const big = n => 'x'.repeat(n);
    // 30 則、每則 2000 字：標準上限 16000 → 只放得下最新幾則
    const hist = [{ role: 'user', agent: 'claude', text: 'GOAL ' + big(2000) }];
    for (let i = 1; i < 30; i++) hist.push({ role: i % 2 ? 'assistant' : 'user', agent: 'claude', text: `M${i} ` + big(2000) });
    const r = buildContext({ history: hist, agent: 'codex', hasSession: false, msgText, line, level: 'standard' });
    assert(r.chars <= BUDGETS.standard.total + 1500, `超過上限：${r.chars}`);
    assert(r.text.includes('M29 ') && !r.text.includes('M10 '), '沒有保留最新的往來');
    assert(r.text.startsWith('U→claude:GOAL'), '對話開頭的需求沒有補回來');
    assert(/較早的 \d+ 則/.test(r.text) && r.omitted > 0, '沒有標示省略');
    const lean = buildContext({ history: hist, agent: 'codex', hasSession: false, msgText, line, level: 'lean' });
    assert(lean.chars < r.chars, `精簡沒有比標準少：${lean.chars} / ${r.chars}`);
    // 有 session：只附它上次回覆之後、別人的往來
    const h2 = [{ role: 'user', agent: 'codex', text: 'old' }, { role: 'assistant', agent: 'codex', text: 'mine' },
      { role: 'user', agent: 'claude', text: 'new q' }, { role: 'assistant', agent: 'claude', text: 'new a' }];
    const s = buildContext({ history: h2, agent: 'codex', hasSession: true, msgText, line, level: 'standard' });
    assert(s.text === 'U→claude:new q\n\nclaude:new a', JSON.stringify(s.text));
    // 長訊息保留頭尾
    const one = buildContext({ history: [{ role: 'user', agent: 'claude', text: 'HEAD' + big(9000) + 'TAIL' }], agent: 'codex', hasSession: false, msgText, line, level: 'standard' });
    assert(one.text.includes('HEAD') && one.text.includes('TAIL') && /中間省略/.test(one.text), '長訊息沒有保留頭尾');
    // 委派回覆：太長時優先用最終回覆，再不夠就截短
    assert(delegateReply({ text: 'p'.repeat(20000) + 'FINAL', final: 'FINAL' }, 'standard') === 'FINAL', '沒有改用最終回覆');
    const d = delegateReply({ text: big(50000) }, 'standard');
    assert(d.length < 13000 && /截短/.test(d), `委派回覆沒有截短：${d.length}`);
    assert(delegateReply({ text: 'short' }, 'lean') === 'short', '短回覆不應該變動');
    // 太長時把完整回覆交給 save 存檔，回覆裡寫檔案路徑；存不了（回傳空字串）照舊指到畫面上；沒超過上限不存
    let saved = '';
    const ds = delegateReply({ text: 'HEAD' + big(50000) + 'TAIL' }, 'standard', undefined, full => { saved = full; return 'C:\\t\\delegate-1.md'; });
    assert(saved.startsWith('HEAD') && saved.endsWith('TAIL') && ds.length < 13000 && ds.includes('C:\\t\\delegate-1.md') && !ds.includes('畫面上'), ds.slice(-120));
    assert(/畫面上/.test(delegateReply({ text: big(50000) }, 'standard', undefined, () => '')), '存不了時沒有退回原本的說法');
    let called = false;
    delegateReply({ text: 'short' }, 'lean', undefined, () => { called = true; return 'x'; });
    assert(!called, '沒超過上限也存了檔');
    // 給被委派 Agent 的收尾格式：三行，英文沒有中文
    const { delegateTail } = require(path.join(SRC, 'mode.js'));
    const { t, setLang } = require(path.join(SRC, 'shared', 'i18n.js'));
    const tail = delegateTail();
    setLang('en');
    const tailEn = delegateTail(t);
    setLang('zh-TW');
    assert(tail.includes('做了什麼：') && tail.includes('改了哪些檔：') && tail.includes('沒做完或要注意的：') && !CJK.test(tailEn), tailEn);
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

  await check('模式：舊對話判定、對話模式唯讀旗標、給 Agent 的說明、Cursor 切到工作模式重開 session', () => {
    const { modeOf, modeNotes } = require(path.join(SRC, 'mode.js'));
    // 沒有 mode 的舊對話：不管有沒有訊息都當對話（唯讀）；有 mode 就照 mode，認不得的值也當對話
    assert(modeOf({ messages: [{}] }) === 'chat' && modeOf({ messages: [] }) === 'chat' && modeOf({}) === 'chat' && modeOf(null) === 'chat', '舊對話判定不對');
    assert(modeOf({ mode: 'chat', messages: [{}] }) === 'chat' && modeOf({ mode: 'work', messages: [] }) === 'work' && modeOf({ mode: 'x', messages: [{}] }) === 'chat', '已有 mode 的對話判定不對');
    const cwd = os.tmpdir();
    const after = (args, flag) => args[args.indexOf(flag) + 1];
    // Claude：設定再寬（全部放行）也換成 default；plan 本來就唯讀，維持；工作模式照設定
    const cl = p => buildCommand('claude', { cli: nodeExe, permission: p.permission, readOnly: p.readOnly }, { prompt: 'p', cwd }).args;
    assert(after(cl({ permission: 'bypassPermissions', readOnly: true }), '--permission-mode') === 'default', `claude 唯讀：${cl({ permission: 'bypassPermissions', readOnly: true }).join(' ')}`);
    assert(after(cl({ permission: 'plan', readOnly: true }), '--permission-mode') === 'plan', 'claude plan 應維持');
    assert(after(cl({ permission: 'bypassPermissions' }), '--permission-mode') === 'bypassPermissions', 'claude 工作模式應照設定');
    // Codex：sandbox 一律 read-only
    const cx = c => buildCommand('codex', { cli: nodeExe, ...c }, { prompt: 'p', cwd }).args.join(' ');
    assert(cx({ sandbox: 'danger-full-access', readOnly: true }).includes('sandbox_mode="read-only"'), `codex 唯讀：${cx({ sandbox: 'danger-full-access', readOnly: true })}`);
    assert(cx({ sandbox: 'danger-full-access' }).includes('sandbox_mode="danger-full-access"'), 'codex 工作模式應照設定');
    // Cursor：拿掉 --force，改 --mode ask；plan 維持
    const cu = c => buildCommand('cursor', { cli: nodeExe, ...c }, { prompt: 'p', cwd }).args;
    const ask = cu({ permission: 'force', readOnly: true });
    assert(!ask.includes('--force') && after(ask, '--mode') === 'ask', `cursor 唯讀：${ask.join(' ')}`);
    assert(after(cu({ permission: 'plan', readOnly: true }), '--mode') === 'plan', 'cursor plan 應維持');
    assert(cu({ permission: 'force' }).includes('--force'), 'cursor 工作模式應照設定');
    // 自訂 Agent 沒有旗標可擋：指令不變，靠 prompt 說明
    const custom = { custom: true, cli: nodeExe, args: '--x', promptMode: 'stdin' };
    assert(buildCommand('x', { ...custom, readOnly: true }, { prompt: 'P', cwd }).args.join(' ') === buildCommand('x', custom, { prompt: 'P', cwd }).args.join(' '), '自訂 Agent 的指令不應變動');
    // 說明：對話模式 Claude 走 system prompt、其他放 prompt 前面；切到工作後同一個 session 補一句
    const c1 = modeNotes({ mode: 'chat', agent: 'claude' }), c2 = modeNotes({ mode: 'chat', agent: 'xecho' });
    assert(/唯讀/.test(c1.system) && !c1.prefix && /唯讀/.test(c2.prefix) && !c2.system, JSON.stringify({ c1, c2 }));
    assert(c1.system.includes('[[agentdesk:work]]') && c2.prefix.includes('[[agentdesk:work]]'), '唯讀說明沒有寫出約定的標記');
    assert(/工作模式/.test(modeNotes({ mode: 'work', agent: 'codex', told: 'chat' }).prefix), '從對話切到工作沒有補說明');
    const quiet = [modeNotes({ mode: 'work', agent: 'codex' }), modeNotes({ mode: 'work', agent: 'claude', told: 'work' })];
    assert(quiet.every(n => !n.prefix && !n.system), '工作模式平常不應帶說明');
    // Cursor 的 session 跑過唯讀就回不到可寫（用真的 CLI 試過）：切到工作模式要重開，其他 Agent、其他情況不用
    const { mustRestart, stickyReadOnly } = require(path.join(SRC, 'mode.js'));
    const mr = (agent, mode, told, permission) => mustRestart({ agent, mode, told, permission });
    assert(mr('cursor', 'work', 'chat') && mr('cursor', 'work', 'chat', 'force'), 'Cursor 從對話切到工作沒有重開 session');
    assert(!mr('cursor', 'chat', 'chat') && !mr('cursor', 'work', 'work') && !mr('cursor', 'work', undefined) && !mr('cursor', 'work', 'work:main:x'), 'Cursor 不該重開的情況重開了');
    assert(!mr('cursor', 'work', 'chat', 'ask') && !mr('cursor', 'work', 'chat', 'plan'), '工作模式本來就選唯讀時不用重開');
    assert(!mr('codex', 'work', 'chat') && !mr('claude', 'work', 'chat') && !mr('xecho', 'work', 'chat') && stickyReadOnly('cursor') && !stickyReadOnly('codex'), '只有 Cursor 需要重開');
    const mainSrc = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
    const turnSrc = mainSrc.slice(mainSrc.indexOf('async function startTurn('), mainSrc.indexOf('async function delegate('));
    const deleSrc = mainSrc.slice(mainSrc.indexOf('async function delegate('), mainSrc.indexOf('async function compress('));
    const before = (src, a, b) => src.includes(a) && src.indexOf(a) < src.indexOf(b);
    assert(before(turnSrc, 'freshIfStuck(conv, agent)', 'buildPrompt(') && before(deleSrc, 'freshIfStuck(conv, agent)', 'notesFor('), '主程序沒有在組 prompt 之前檢查要不要重開 session');
  });

  await check('工作：工作名、進程檔範本、給 Agent 的指示、只附最近幾則', () => {
    const { safeName, makeWork, workPath, template, workNote } = require(path.join(SRC, 'work.js'));
    const { modeNotes } = require(path.join(SRC, 'mode.js'));
    const { buildContext } = require(path.join(SRC, 'context.js'));
    // 工作名 → 檔名：拿掉不能用的字元、結尾的點與空白；清完是空的就沒有工作
    assert(safeName(' a/b:c*?"<>|d. ') === 'a b c d' && makeWork(' . ') === null && makeWork('x'.repeat(90)).name.length === 60, `safeName：${safeName(' a/b:c*?"<>|d. ')}`);
    const work = makeWork('登入頁 改版');
    const cwd = os.tmpdir(), file = workPath(cwd, work);
    assert(work.name === '登入頁 改版' && work.file === 'docs/進程/登入頁 改版.md' && file === path.join(cwd, 'docs', '進程', '登入頁 改版.md'), JSON.stringify(work));
    // 範本：有「▶」續傳指引、任務清單表格、工作名與日期
    const tpl = template(work.name, '2026-11-15');
    assert(/^# 登入頁 改版 進程\n/.test(tpl) && tpl.includes('## ▶ ') && tpl.includes('2026-11-15') && /\n\| # \| .+\|\n\|---\|/.test(tpl), tpl.slice(0, 200));
    // 指示：主 Agent 要先列任務、回寫進程檔；被委派的只告知進程檔在哪
    const main = workNote({ work, file }), del = workNote({ work, file, role: 'delegate' });
    assert(main.startsWith('[工作模式：登入頁 改版]') && main.includes(file) && /核准/.test(main) && /回寫/.test(main), main);
    assert(del.includes(file) && !/核准/.test(del) && !del.includes('\n'), del);
    // Claude 當主 Agent：指示放 system prompt，每輪都帶
    const key = 'work:main:登入頁 改版';
    const c = modeNotes({ mode: 'work', agent: 'claude', work, file, told: key });
    assert(c.system === main && !c.prefix && c.key === key, JSON.stringify(c));
    assert(modeNotes({ mode: 'work', agent: 'claude', work, file, told: 'chat' }).prefix === '[已切換到工作模式：可以修改檔案了。]', 'Claude 從對話切過來沒有補說明');
    // 其他 Agent：這個 session 還沒收過才放在 prompt 前面
    const x1 = modeNotes({ mode: 'work', agent: 'codex', work, file });
    const x2 = modeNotes({ mode: 'work', agent: 'codex', work, file, told: key });
    const x3 = modeNotes({ mode: 'work', agent: 'codex', work, file, told: 'chat' });
    const x4 = modeNotes({ mode: 'work', agent: 'codex', work, file, told: 'work' });
    assert(x1.prefix === main && !x1.system && x1.key === key && x2.prefix === '' && x4.prefix === main, JSON.stringify({ x1, x2, x4 }));
    assert(x3.prefix === `[已切換到工作模式：可以修改檔案了。]\n${main}`, x3.prefix);
    const d = modeNotes({ mode: 'work', agent: 'codex', work, file, role: 'delegate', told: key });
    assert(d.prefix === del && d.key === 'work:delegate:登入頁 改版', JSON.stringify(d));
    // 沒取工作名的工作模式、對話模式：和以前一樣，不帶工作指示
    assert(modeNotes({ mode: 'work', agent: 'codex' }).key === 'work' && !modeNotes({ mode: 'work', agent: 'codex' }).prefix, '沒有工作名時不應帶指示');
    assert(!modeNotes({ mode: 'chat', agent: 'codex', work, file }).prefix.includes('工作模式：登入頁'), '對話模式不應帶工作指示');
    // 上下文：recent 只看最近幾則，並標示省略了幾則
    const hist = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', agent: 'claude', text: `M${i}.` }));
    const r = buildContext({ history: hist, agent: 'codex', hasSession: false, msgText: m => m.text, line: (m, t) => t, level: 'lean', recent: 6 });
    assert(r.text.includes('M4.') && r.text.includes('M9.') && !r.text.includes('M3.') && !r.text.includes('M0.') && r.omitted === 4, JSON.stringify(r));
    assert(buildContext({ history: hist, agent: 'codex', hasSession: false, msgText: m => m.text, line: (m, t) => t, level: 'lean' }).omitted === 0, '沒傳 recent 時不應省略');
  });

  // 數字取自 2026-11 用真的 CLI 量到的用量（見 docs/進程/對話與工作模式.md「任務 #5」）
  await check('session 大小：Claude 取最後一個請求、Codex 用累計的增量、Cursor 加總後除以請求數', () => {
    const { sessionSize } = agents;
    // Claude：一輪兩個請求，各自的用量在 assistant 事件；子代理（parent_tool_use_id）的不算；result 的加總不能拿來當大小
    const c = run('claude', [
      { type: 'assistant', message: { content: [], usage: { input_tokens: 2, cache_creation_input_tokens: 14042, cache_read_input_tokens: 29354, output_tokens: 2 } } },
      { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 131 } } },
      { type: 'assistant', parent_tool_use_id: 'sub', message: { content: [], usage: { input_tokens: 9, cache_read_input_tokens: 999999, output_tokens: 9 } } },
      { type: 'assistant', message: { content: [], usage: { input_tokens: 2, cache_creation_input_tokens: 163, cache_read_input_tokens: 43396, output_tokens: 2 } } },
      { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 9 } } },
      { type: 'result', result: 'x', usage: { input_tokens: 4, cache_creation_input_tokens: 14205, cache_read_input_tokens: 72750, output_tokens: 140 } },
    ]);
    const cs = sessionSize({ kind: 'claude', usage: c.state.usage, lastUsage: c.state.lastUsage });
    assert(cs.tokens === 2 + 163 + 43396 + 9, `claude：${JSON.stringify(cs)}`);
    assert(sessionSize({ kind: 'claude', usage: c.state.usage }).tokens === 4 + 14205 + 72750 + 140, '沒有逐請求用量時應退回整輪加總');
    // Codex：usage 是整個 session 的累計
    const x = run('codex', [{ type: 'item.completed', item: { id: 'c', type: 'command_execution', command: 'type a.txt', exit_code: 0 } },
      { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'alpha' } }, { type: 'turn.completed', usage: { input_tokens: 35649, cached_input_tokens: 31232, output_tokens: 49 } }]);
    assert(x.state.steps === 1, `codex 工具數：${x.state.steps}`);
    const first = sessionSize({ kind: 'codex', usage: { input_tokens: 17125 }, steps: 0 }, undefined, false);
    assert(first.tokens === 17125 && first.total === 17125, JSON.stringify(first));
    const second = sessionSize({ kind: 'codex', usage: { input_tokens: 34265 }, steps: 0 }, first, true);
    assert(second.tokens === 17140 && second.total === 34265, JSON.stringify(second));
    assert(sessionSize({ kind: 'codex', usage: x.state.usage, steps: x.state.steps }, undefined, false).tokens === 17825, '一輪兩個請求要除以 2');
    const lost = sessionSize({ kind: 'codex', usage: { input_tokens: 34265 }, steps: 0 }, undefined, true);
    assert(lost.tokens === null && lost.total === 34265, `接續但沒有上一輪的累計時算不出來：${JSON.stringify(lost)}`);
    // Cursor：這一輪各請求的加總，inputTokens 不含快取
    const u = run('cursor', [{ type: 'tool_call', subtype: 'started', call_id: 'k', tool_call: { readToolCall: { args: { path: 'a.txt' } } } },
      { type: 'tool_call', subtype: 'completed', call_id: 'k', tool_call: { readToolCall: { args: { path: 'a.txt' }, result: { success: { content: 'alpha' } } } } },
      { type: 'result', result: 'alpha', usage: { inputTokens: 11916, outputTokens: 91, cacheReadTokens: 19712, cacheWriteTokens: 0 } }]);
    assert(u.state.steps === 1 && sessionSize({ kind: 'cursor', usage: u.state.usage, steps: u.state.steps }).tokens === 15814, `cursor：${u.state.steps}`);
    assert(sessionSize({ kind: 'cursor', usage: { inputTokens: 11794, outputTokens: 55, cacheReadTokens: 3968 }, steps: 0 }).tokens === 15762, 'cursor 單一請求');
    // 沒量過的格式、沒有用量：不顯示
    assert(sessionSize({ kind: 'antigravity', usage: { total_tokens: 5 } }) === null && sessionSize({ kind: 'text' }) === null && sessionSize(null) === null
      && sessionSize({ kind: 'codex', usage: {} }) === null && sessionSize({ kind: 'claude' }) === null, '不該有數字');
  });

  await check('工作：讀進程檔（續傳指引、任務清單、完成判定）與接續現成的檔', () => {
    const { parseWork, template, workFromFile, isDone } = require(path.join(SRC, 'work.js'));
    // 靠「▶」與第一張表格找，標題是哪種語言都一樣；巢狀條列不算，表格可以多欄、可以有跳脫的 |
    const md = ['# X progress', '', 'intro | not a table', '', '### ▶ Resume here', '- Status: **two** tasks', '  - nested detail', '* Next: do `task 2`', '', 'plain line', '',
      '## Tasks', '| # | Task | Status | Blocked | Notes |', '|---|:--|---|---|---|', '| 1 | Write parser | 完成（未提交） | - | a \\| b |', '| 2 | Wire **panel** | 未完成 | 1 | |', '| 3 | Docs | ✅ done | | |', '',
      '## Other', '| a | b |', '|---|---|', '| x | y |'].join('\n');
    const p = parseWork(md);
    assert(JSON.stringify(p.resume) === JSON.stringify(['Status: two tasks', 'Next: do task 2']), JSON.stringify(p.resume));
    assert(p.tasks.length === 3 && p.tasks.map(x => x.id).join() === '1,2,3' && p.tasks[1].title === 'Wire panel' && p.tasks.map(x => x.done).join() === 'true,false,true', JSON.stringify(p.tasks));
    assert(isDone('Done') && isDone('已完成') && isDone('[x] ok') && !isDone('待做') && !isDone('進行中') && !isDone('not done') && !isDone(''), 'isDone 判定不對');
    // 剛建好的範本：四條續傳指引、還沒有任務；空檔與沒有「▶」的檔不會出錯
    const t0 = parseWork(template('X', '2026-11-15'));
    assert(t0.resume.length === 4 && /2026-11-15/.test(t0.resume[0]) && t0.tasks.length === 0, JSON.stringify(t0));
    assert(parseWork('').resume.length === 0 && parseWork('# a\n- b').tasks.length === 0 && parseWork(null).resume.length === 0, '空檔處理不對');
    // 現成的檔名原樣當工作名（不清理，才對得上原檔）；帶路徑的不收
    assert(workFromFile('a  b.').file === 'docs/進程/a  b..md' && workFromFile('../x') === null && workFromFile('') === null && workFromFile('a\\b') === null, 'workFromFile 不對');
  });

  await check('逐字稿：每則訊息一段有編號、工具與委派各自成行、舊段落不因新訊息改變', () => {
    const { transcript, entry, stamp } = require(path.join(SRC, 'transcript.js'));
    const label = a => ({ claude: 'Claude', codex: 'Codex' }[a] || a);
    const ts = new Date(2026, 10, 15, 1, 23).getTime();
    const conv = { id: 'c1', title: 'Fix login', cwd: 'C:\\proj', messages: [
      { role: 'user', agent: 'claude', text: 'please fix\n## #9 not a heading', ts,
        attachments: [{ kind: 'image', name: 'a.png', path: 'C:\\att\\a.png' }, { kind: 'folder', name: 'src', path: 'C:\\proj\\src' }] },
      { role: 'assistant', agent: 'claude', status: 'done', ts, parts: [
        { kind: 'thinking', text: 'SECRET-THOUGHT' },
        { kind: 'text', text: 'Looking.' },
        { kind: 'tool', id: 't1', name: 'Read', detail: 'src/a.js', status: 'done', output: 'TOOL-OUTPUT' },
        { kind: 'tool', id: 't2', name: 'Bash', detail: 'npm test\n' + 'x'.repeat(400), status: 'error' },
        { kind: 'delegate', id: 'd1', agent: 'codex', prompt: 'check b.js\nline two', status: 'done',
          parts: [{ kind: 'tool', name: 'shell', detail: 'ls', status: 'done' }, { kind: 'text', text: 'b.js is fine' }] },
        { kind: 'text', text: 'All good.' }] },
      { role: 'user', agent: 'codex', text: '', ts: 0 },
      { role: 'assistant', agent: 'codex', status: 'stopped', parts: [] },
      { role: 'assistant', agent: 'codex', status: 'error', error: 'boom\nmore', parts: [{ kind: 'text', text: 'partial' }] },
    ] };
    const md = transcript(conv, { label });
    // 標題：一則訊息一個、編號連續；內文裡長得像標題的行被跳脫，不會多算
    const heads = md.match(/^## #\d+ .*$/gm) || [];
    assert(heads.length === 5 && heads[0] === '## #1 使用者 → Claude · 2026-11-15 01:23' && heads[1] === '## #2 Claude · 2026-11-15 01:23'
      && heads[2] === '## #3 使用者 → Codex' && heads[3] === '## #4 Codex' && md.includes('\n\\## #9 not a heading'), JSON.stringify(heads));
    assert(md.startsWith('# Fix login 逐字稿\n') && md.includes('- 工作資料夾：C:\\proj\n') && md.endsWith('\n') && !md.endsWith('\n\n'), md.slice(0, 200));
    assert(md.includes('附件：\n- 圖片：C:\\att\\a.png\n- 資料夾：C:\\proj\\src'), '附件沒列出來');
    // 思考過程與工具輸出不收；連續的工具呼叫各一行，太長的截短成一行，失敗的註明
    assert(!md.includes('SECRET-THOUGHT') && !md.includes('TOOL-OUTPUT'), '收了不該收的內容');
    const bash = md.split('\n').find(l => l.startsWith('- 工具：Bash'));
    assert(md.includes('Looking.\n\n- 工具：Read src/a.js\n- 工具：Bash npm test x') && bash.length < 230 && bash.endsWith('…（失敗）'), bash);
    // 委派：交辦內容用引言、對方的回覆接在後面，主 Agent 再開口時重新標名字
    assert(md.includes('**Claude → Codex（委派）：**\n\n> check b.js\n> line two\n\n**Codex：**\n\n- 工具：shell ls\n\nb.js is fine\n\n**Claude：**\n\nAll good.'), md);
    // 空訊息、停止、出錯都留一段，註明狀態
    assert(md.includes('## #3 使用者 → Codex\n\n（沒有內容）\n') && md.includes('## #4 Codex\n\n（已停止）\n') && md.includes('partial\n\n（錯誤：boom more）\n'), md.slice(-300));
    // 之後再加訊息，前面的段落一個字都不變（索引上的編號才指得到同一段）
    const before = transcript({ ...conv, messages: conv.messages.slice(0, 4) }, { label });
    assert(md.startsWith(before.trimEnd() + '\n\n## #5 '), '加訊息後舊段落變了');
    assert(entry(conv.messages[0], 12, { label }).startsWith('## #12 使用者 → Claude') && stamp(0) === '' && stamp('x') === '', 'entry／stamp 不對');
    assert((transcript(null).match(/^## #/gm) || []).length === 0 && transcript({ messages: [] }).startsWith('# 新對話 逐字稿'), '空對話處理不對');
    // 英文介面：檔案說明、標題、狀態註記都沒有中文
    const { t, setLang } = require(path.join(SRC, 'shared', 'i18n.js'));
    setLang('en'); const en = transcript({ ...conv, title: '新對話' }, { label, tr: t }); setLang('zh-TW');
    assert(en.startsWith('# Transcript: New chat\n') && en.includes('## #1 User → Claude · ') && en.includes('- Tool: Read src/a.js') && en.includes('**Claude → Codex (delegated):**')
      && en.includes('(error: boom more)') && !CJK.test(en), (en.split('\n').find(l => CJK.test(l)) || en.slice(0, 120)));
  });

  await check('壓縮：請 Agent 寫索引的話、從回覆挑出索引行、之後附索引＋最近幾則有編號的原文', () => {
    const { KEEP, compressPrompt, parseIndex, indexLine, indexHead, indexLines, indexContext } = require(path.join(SRC, 'compress.js'));
    const { buildContext } = require(path.join(SRC, 'context.js'));
    // 給 Agent 的話：第一行帶範圍，有逐字稿路徑與格式；整段被原樣唸回來也挑不出索引行（格式說明與範例不算）
    const p = compressPrompt({ file: 'C:\\t\\transcript.md', from: 5, to: 20 });
    assert(p.startsWith('[AgentDesk 壓縮 #5–#20]\n') && p.includes('C:\\t\\transcript.md') && p.includes('\n#起–#迄｜主題｜結論｜相關檔案\n') && parseIndex(p, { from: 1, to: 99 }).length === 0, p);
    // 從回覆挑索引行：條列、半形直線、表格列、單一段、寫反的範圍都收；超出這次範圍的截掉，範圍外與不是索引的不收
    const reply = ['好的，索引如下：', '#5–#8｜登入失敗｜api.js 吞掉 401，已改｜src/api.js、src/login.js', '- #9-12 | 樣式 | 未定 | -', '| #13 | 單一段 | 完成 |',
      '#14~#30｜超出範圍的尾巴｜截到 20', '#1–#4｜已經寫過的｜不收｜-', '#40–#50｜範圍外｜不收', '7. 不是索引 | x', '#19 到 #18｜寫反了｜照樣收｜a.js｜b.js', '```'].join('\n');
    const lines = parseIndex(reply, { from: 5, to: 20 }).map(indexLine);
    const want = ['#5–#8｜登入失敗｜api.js 吞掉 401，已改｜src/api.js、src/login.js', '#9–#12｜樣式｜未定｜-', '#13–#13｜單一段｜完成｜-', '#14–#20｜超出範圍的尾巴｜截到 20｜-', '#18–#19｜寫反了｜照樣收｜a.js、b.js'];
    assert(JSON.stringify(lines) === JSON.stringify(want), JSON.stringify(lines));
    assert(parseIndex('', {}).length === 0 && parseIndex(null).length === 0 && parseIndex(`#1–#2｜${'長'.repeat(900)}｜x`)[0].topic.length <= 301, '空回覆或過長欄位處理不對');
    // 索引檔：開頭的說明不算索引行
    const file = indexHead('Fix login') + lines.join('\n') + '\n';
    assert(file.startsWith('# Fix login 索引\n') && JSON.stringify(indexLines(file)) === JSON.stringify(want) && indexLines('').length === 0 && indexLines(indexHead('x')).length === 0, file.slice(0, 200));
    // 之後每一輪的開頭：逐字稿路徑、兩條用法、索引
    const c = indexContext({ lines, file: 'T.md', index: 'I.md', level: 'standard' });
    assert(c.startsWith('[這個對話壓縮過') && c.includes('逐字稿：T.md') && c.includes('照索引上的編號去讀逐字稿') && c.includes('不能因為索引沒寫就當作沒發生過') && c.endsWith(want.join('\n')) && !c.includes('I.md'), c);
    // 索引太長：只附最新的，其餘指到索引檔
    const many = Array.from({ length: 400 }, (_, i) => `#${i * 2 + 1}–#${i * 2 + 2}｜${'主題'.repeat(20)}｜結論｜-`);
    const cut = indexContext({ lines: many, file: 'T.md', index: 'I.md', level: 'lean' });
    assert(cut.length < 6600 && cut.endsWith(many.at(-1)) && !cut.includes(many[0] + '\n') && /（較早的 \d+ 筆索引沒有附上，完整索引在 I\.md）/.test(cut), `${cut.length} ${cut.slice(0, 300)}`);
    // 附的原文：索引涵蓋到 #16 → 從最後 KEEP 則（#13）開始附到最新，每則帶編號；不會把對話第一則補回來
    const hist = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', agent: 'claude', text: `m${i + 1}` }));
    const line = (m, t, i) => `#${i + 1} ${m.role}:${t}`;
    const base = { history: hist, agent: 'codex', hasSession: false, msgText: m => m.text, line, level: 'standard' };
    const nums = x => x.text.split('\n\n').map(l => l.split(' ')[0]).join();
    const bc = buildContext({ ...base, since: 16 - KEEP });
    assert(KEEP === 4 && nums(bc) === '#13,#14,#15,#16,#17,#18,#19,#20' && bc.omitted === 0, bc.text);
    // 工作模式另外只看最近 6 則：被擠掉的有註明
    const bw = buildContext({ ...base, since: 16 - KEEP, recent: 6 });
    assert(bw.omitted === 2 && bw.text.includes('#15 user:m15') && !bw.text.includes('#14 ') && bw.text.endsWith('#20 assistant:m20'), bw.text);
    // 有 session 的 Agent 照舊只補它上次回覆之後別人的往來，一樣帶編號
    const hs = buildContext({ ...base, hasSession: true, history: [...hist, { role: 'user', agent: 'codex', text: 'x' }, { role: 'assistant', agent: 'codex', text: 'y' },
      { role: 'user', agent: 'claude', text: 'z' }, { role: 'assistant', agent: 'claude', text: 'w' }] });
    assert(hs.text === '#23 user:z\n\n#24 assistant:w', hs.text);
    // 英文介面：給 Agent 的話、索引檔說明都沒有中文
    const { t, setLang } = require(path.join(SRC, 'shared', 'i18n.js'));
    setLang('en');
    const en = [compressPrompt({ file: 'T.md', from: 1, to: 2, tr: t }), indexHead('新對話', t), indexContext({ lines: ['#1–#2｜a｜b｜-'], file: 'T.md', index: 'I.md', level: 'lean', tr: t })].join('\n');
    setLang('zh-TW');
    assert(en.startsWith('[AgentDesk compress #1–#2]\n') && en.includes('# Index: New chat') && !CJK.test(en), en.split('\n').find(l => CJK.test(l)) || en.slice(0, 100));
  });

  await check('壓縮：大 session 改讀逐字稿、改過的檔由動作記錄補、索引核對（檔案、跳號、重疊）', () => {
    const { FRESH_BASE, CHUNK_MAX, compressPrompt, chunkRanges, resumeForIndex, editedFiles, verifyIndex, indexLine, parseIndex } = require(path.join(SRC, 'compress.js'));
    // #9 接續與否：session 沒看過全部要寫的段落（seen 不知道、或比 from 晚）一律不接續；
    // 看過的話，大小不知道就接續，否則比「一個 session 大小的請求」和「基本盤＋段落原文」哪個便宜
    assert(FRESH_BASE === 40000 && !resumeForIndex() && !resumeForIndex({ tokens: 30000, from: 5 }) && !resumeForIndex({ tokens: 30000, seen: 6, from: 5 })
      && resumeForIndex({ seen: 1, from: 5 }) && resumeForIndex({ tokens: 30000, seen: 5, from: 5 })
      && !resumeForIndex({ tokens: 133000, chars: 20000, seen: 1, from: 137 }) && resumeForIndex({ tokens: 150000, chars: 250000, seen: 1, from: 1 }), 'resumeForIndex 的規則不對');
    // 新開的 session 看過哪些：buildContext 回傳從第幾則起的原文全部附上了（擠掉的不算看過）
    const { buildContext } = require(path.join(SRC, 'context.js'));
    const bcBase = { agent: 'codex', hasSession: false, msgText: m => m.text, line: (m, t) => t };
    const hist = n => Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', agent: 'claude', text: 'x'.repeat(n) }));
    const bSmall = buildContext({ ...bcBase, history: hist(10), level: 'lean' }), bBig = buildContext({ ...bcBase, history: hist(5000), level: 'lean' });
    assert(bSmall.from === 0 && bBig.omitted > 0 && bBig.from > 1 && buildContext({ ...bcBase, history: [], level: 'lean' }).from === 0, JSON.stringify({ s: bSmall.from, b: bBig.from, o: bBig.omitted }));
    // 分批：每批不超過上限，單一段超過就自己一批，不跳號
    assert(JSON.stringify(chunkRanges([40, 40, 40, 200, 10], 7, 100)) === '[[7,8],[9,9],[10,10],[11,11]]' && JSON.stringify(chunkRanges([5, 5], 1)) === '[[1,2]]'
      && chunkRanges([], 3).length === 0 && CHUNK_MAX === 100000, JSON.stringify(chunkRanges([40, 40, 40, 200, 10], 7, 100)));
    // 開乾淨的 session：段落原文附在最後，不請它讀檔；原文裡像索引的行不會被當成給 Agent 的範例
    const pin = compressPrompt({ file: 'T.md', from: 3, to: 4, text: '## #3 使用者 → Claude\n\nhello\n\n## #4 Claude\n\nworld' });
    assert(pin.includes('附在最後') && !pin.includes('先讀逐字稿再寫') && pin.includes('[逐字稿 #3–#4 原文開始]\n## #3 使用者') && pin.endsWith('world\n[逐字稿原文結束。照前面的格式輸出。]')
      && compressPrompt({ file: 'T.md', from: 3, to: 4 }).includes('先讀逐字稿再寫') && parseIndex(pin, { from: 1, to: 9 }).length === 0, pin.slice(-160));
    // #11 改過的檔：Claude 的 Edit/Write/NotebookEdit、委派裡 Codex 的 edit（一次多個）、Cursor 的 edit；讀檔、指令、失敗的不算；
    // 工作資料夾裡的轉相對路徑、去重、照出現順序；資料夾外的留絕對路徑
    const cwd = process.platform === 'win32' ? 'E:\\proj' : '/proj';
    const P = (...a) => path.join(cwd, ...a);
    const msgs = [
      { role: 'user', agent: 'claude', text: `改 ${P('src', 'user.js')}` },
      { role: 'assistant', agent: 'claude', parts: [
        { kind: 'tool', name: 'Read', detail: P('src', 'read.js') }, { kind: 'tool', name: 'Edit', detail: P('src', 'a.js') }, { kind: 'tool', name: 'Write', detail: P('src', 'a.js') },
        { kind: 'tool', name: 'Edit', detail: P('src', 'fail.js'), status: 'error' }, { kind: 'tool', name: 'NotebookEdit', detail: JSON.stringify({ notebook_path: P('nb.ipynb'), new_source: 'x' }) },
        { kind: 'delegate', agent: 'codex', parts: [{ kind: 'tool', name: 'edit', detail: `update ${P('src', 'b.cs')}, add ${P('src', 'c.cs')}` }, { kind: 'tool', name: 'shell', detail: 'git status' }] }] },
      { role: 'assistant', agent: 'cursor', parts: [{ kind: 'tool', name: 'edit', detail: 'src/d.ts' }, { kind: 'tool', name: 'read', detail: 'src/e.ts' }, { kind: 'tool', name: 'Edit', detail: 'SRC/D.ts' }] },
    ];
    const ed = editedFiles(msgs, cwd);
    assert(JSON.stringify(ed) === JSON.stringify(['src/a.js', 'nb.ipynb', 'src/b.cs', 'src/c.cs', 'src/d.ts']), JSON.stringify(ed));
    // 工作資料夾外面的不收（專案搬家前的舊路徑、Agent 自己的設定檔）
    const out = path.resolve(cwd, '..', 'other', 'x.txt');
    assert(editedFiles([{ role: 'assistant', parts: [{ kind: 'tool', name: 'Write', detail: out }, { kind: 'tool', name: 'Write', detail: P('in.txt') }] }], cwd).join() === 'in.txt'
      && editedFiles([], cwd).length === 0, '工作資料夾外的檔');
    // 給 Agent 的話：相關檔案只寫沒改的
    assert(compressPrompt({ file: 'T.md', from: 1, to: 2 }).includes('改過的檔案 AgentDesk 會從動作記錄補上'), '寫索引的話沒提到改過的檔由 AgentDesk 補');
    // #10 核對：檔名沒出現在那幾段的拿掉（a.js 不能對到 data.js）、改過的檔排前面且不重複、漏掉的段落補佔位、重疊只計數、照起點排序
    const seg = { 1: '看 src/login.js 的問題', 2: `- 工具：Edit ${P('src', 'api.js')}`, 3: 'data.js 很長', 4: 'x', 5: 'y', 6: 'z', 7: 'w', 8: 'v', 9: 'u', 10: 't' };
    const segText = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => seg[a + i]).join('\n\n');
    const edited = (a, b) => [...(a <= 2 && b >= 2 ? ['src/api.js'] : []), ...(a <= 9 && b >= 9 ? ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'] : [])];
    const v = verifyIndex([
      { from: 7, to: 8, topic: '重疊', result: '-', files: '-' },
      { from: 1, to: 3, topic: '登入', result: '改了', files: 'src/login.js、src/api.js、src/ghost.js、lib/a.js' },
      { from: 6, to: 7, topic: '中段', result: '-', files: 'data.js' },
    ], { from: 1, to: 10, segText, edited });
    const got = v.entries.map(indexLine);
    const want = ['#1–#3｜登入｜改了｜src/api.js、src/login.js', '#4–#5｜（沒有索引）｜-｜-', '#6–#7｜中段｜-｜-', '#7–#8｜重疊｜-｜-', '#9–#10｜（沒有索引）｜-｜f1、f2、f3、f4、f5（另 2 個）'];
    assert(JSON.stringify(got) === JSON.stringify(want) && v.dropped === 3 && v.overlaps === 1 && JSON.stringify(v.gaps) === '[[4,5],[9,10]]', JSON.stringify({ got, dropped: v.dropped, overlaps: v.overlaps, gaps: v.gaps }));
    // 只有檔名出現也算；全部對得上、沒漏段時什麼都不改
    const ok = verifyIndex([{ from: 1, to: 2, topic: 'a', result: 'b', files: 'lib/login.js' }], { from: 1, to: 2, segText, edited: () => [] });
    assert(indexLine(ok.entries[0]) === '#1–#2｜a｜b｜lib/login.js' && !ok.dropped && !ok.gaps.length && !ok.overlaps, JSON.stringify(ok));
    // 英文介面：佔位與「另幾個」沒有中文
    const { t, setLang } = require(path.join(SRC, 'shared', 'i18n.js'));
    setLang('en');
    const ven = verifyIndex([{ from: 1, to: 1, topic: 'a', result: 'b', files: '-' }], { from: 1, to: 9, segText, edited, tr: t }).entries.map(indexLine).join('\n');
    setLang('zh-TW');
    assert(ven.includes('(no index entry)') && ven.includes('f1, f2') && ven.includes('(+3 more)') && !CJK.test(ven), ven);
  });

  await check('壓縮：沒有進程檔的對話多要「現況／下一步」，每次換掉、接在索引後面', () => {
    const { compressPrompt, parseState, parseIndex, indexContext } = require(path.join(SRC, 'compress.js'));
    const p0 = compressPrompt({ file: 'T.md', from: 1, to: 9 }), p1 = compressPrompt({ file: 'T.md', from: 1, to: 9, state: true });
    assert(!p0.includes('現況：') && p1.includes('\n現況：') && p1.includes('\n下一步：') && p1.includes('到 #9 為止') && parseIndex(p1, { from: 1, to: 99 }).length === 0, p1.slice(-200));
    // 三種語言的開頭、條列與粗體都收；只有一行時另一行是「-」；沒有就是 null；索引行不受影響
    const reply = ['#1–#9｜a｜b｜-', '- **現況：** 登入改好了，還沒測', 'Next steps: 補測試', '現況：第二次不收'].join('\n');
    assert(JSON.stringify(parseState(reply)) === JSON.stringify({ now: '登入改好了，還沒測', next: '補測試' }) && parseIndex(reply, { from: 1, to: 9 }).length === 1, JSON.stringify(parseState(reply)));
    assert(JSON.stringify(parseState('现状：做完了')) === JSON.stringify({ now: '做完了', next: '-' }) && parseState('#1–#2｜a｜b｜-') === null && parseState('') === null, '只有一行或沒有時不對');
    // 接在索引後面，註明是到 #幾的狀態；沒有就不附
    const c = indexContext({ lines: ['#1–#9｜a｜b｜-'], file: 'T.md', index: 'I.md', level: 'lean', state: { now: 'N1', next: 'X1', at: 9 } });
    assert(c.endsWith('#1–#9｜a｜b｜-\n壓縮當時（到 #9）的狀態，之後的發展看後面的原文：\n現況：N1\n下一步：X1') && !indexContext({ lines: ['#1–#2｜a｜b｜-'], file: 'T.md', index: 'I.md', level: 'lean' }).includes('現況'), c);
    const { t, setLang } = require(path.join(SRC, 'shared', 'i18n.js'));
    setLang('en');
    const en = compressPrompt({ file: 'T.md', from: 1, to: 2, state: true, tr: t }) + indexContext({ lines: ['#1–#2｜a｜b｜-'], file: 'T.md', index: 'I.md', level: 'lean', tr: t, state: { now: 'n', next: 'x', at: 2 } });
    setLang('zh-TW');
    // 英文的開頭也要讀得回來
    assert(!CJK.test(en) && JSON.stringify(parseState('Current state: n\nNext steps: x')) === JSON.stringify({ now: 'n', next: 'x' }), en.split('\n').find(l => CJK.test(l)) || 'parseState en');
  });

  await check('「極度節省 token」規則：文字、放在哪、同一個 session 只附一次', () => {
    const { frugalNote, frugalPlace } = require(path.join(SRC, 'mode.js'));
    const { t, setLang } = require(path.join(SRC, 'shared', 'i18n.js'));
    const zh = frugalNote();
    assert(zh.split('\n').length === 5 && zh.startsWith('[極度節省 token：') && zh.endsWith(']') && zh.includes('壞消息、未驗證、待決事項照常講'), zh);
    setLang('en'); const en = frugalNote(t); setLang('zh-CN'); const cn = frugalNote(t); setLang('zh-TW');
    assert(en.split('\n').length === 5 && en.startsWith('[Save tokens:') && en.endsWith(']') && !CJK.test(en), en);
    assert(cn.split('\n').length === 5 && cn.startsWith('[极度节省 token：') && !/[過這個們寫講]/.test(cn), cn);
    // 沒打開：不附。Claude 當主 Agent：放 system prompt，每輪都帶。其他：這個 session 還沒收過才放在 prompt 前面
    const fp = (on, agent, role, hasSession, ruled) => frugalPlace({ on, agent, role, hasSession, ruled });
    assert(fp(false, 'claude') === '' && fp(false, 'codex', 'main', false, false) === '' && fp(undefined, 'xecho', 'delegate') === '', '沒打開時不該附');
    assert(fp(true, 'claude', 'main', true, true) === 'system' && fp(true, 'claude', 'main', false, false) === 'system', 'Claude 當主 Agent 應放 system prompt');
    assert(fp(true, 'codex', 'main', false, false) === 'prefix' && fp(true, 'codex', 'main', true, false) === 'prefix' && fp(true, 'cursor', 'delegate', false, true) === 'prefix', '新的 session、或這個 session 還沒收過，應該附');
    assert(fp(true, 'codex', 'main', true, true) === '' && fp(true, 'xagy', 'delegate', true, true) === '', '同一個 session 已經收過，不該再附');
    // 主程序：規則接在說明前面、記下收過了、丟掉 session 時一起清掉；壓縮寫索引那一輪不經過 notesFor
    const main = read('src/main.js');
    const nf = main.slice(main.indexOf('function notesFor('), main.indexOf('function dropSession('));
    assert(/frugalPlace\(\{ on: !!settings\.agents\[agent\]\?\.frugal/.test(nf) && /conv\.ruled = /.test(nf), 'notesFor 沒有照設定附規則');
    assert(/if \(conv\.ruled\) delete conv\.ruled\[agent\]/.test(main), 'dropSession 沒有清掉「收過規則」的記號');
  });

  await check('模式：Agent 想改檔的訊號（Claude 拒絕記錄、約定標記）與標記清除', () => {
    const { needWork } = require(path.join(SRC, 'mode.js'));
    const { applyEvent, MARK, stripMark, partsText } = require(path.join(SRC, 'shared', 'reduce.js'));
    // Claude 的 result 事件：permission_denials 整理成 [{ tool, detail }]
    const r = run('claude', [{ type: 'result', result: 'no', permission_denials: [
      { tool_name: 'Write', tool_use_id: 't1', tool_input: { file_path: 'a.txt', content: 'hi' } },
      { tool_name: 'Bash', tool_use_id: 't2', tool_input: { command: 'npm test' } }] }]);
    assert(JSON.stringify(r.state.denials) === JSON.stringify([{ tool: 'Write', detail: 'a.txt' }, { tool: 'Bash', detail: 'npm test' }]), JSON.stringify(r.state.denials));
    assert(!run('claude', [{ type: 'result', result: 'ok', permission_denials: [] }]).state.denials, '沒有被拒時不應有 denials');
    // 改檔工具被拒一定算；指令被拒只有工作模式會放行（全部放行／auto）才算；其他工具不算
    const w = needWork({ text: 'x', denials: r.state.denials, permission: 'acceptEdits' });
    assert(w && w.denied.join() === 'Write a.txt', JSON.stringify(w));
    assert(needWork({ text: 'x', denials: r.state.denials, permission: 'bypassPermissions' }).denied.length === 2, '全部放行時指令被拒也要算');
    assert(needWork({ text: 'x', denials: [{ tool: 'Bash', detail: 'npm test' }], permission: 'acceptEdits' }) === null, '切了也不會放行的指令不應算');
    assert(needWork({ text: 'x', denials: [{ tool: 'WebFetch', detail: 'https://x' }], permission: 'bypassPermissions' }) === null, '和改檔無關的工具不應算');
    // 標記：任何 Agent 都適用，含委派卡片裡的回覆
    assert(needWork({ text: `要改 a.js\n${MARK}` })?.denied.length === 0 && needWork({ text: '只是回答' }) === null, '標記判斷不對');
    const m = { parts: [{ kind: 'text', text: `要改 a.js\n${MARK}` }, { kind: 'delegate', id: 'd', agent: 'codex', parts: [{ kind: 'text', text: `b ${MARK}` }] }] };
    assert(needWork({ text: partsText([m.parts[1]]) }), '委派卡片裡的標記沒有算到');
    // 回合結束：記下 needWork，標記從存下來的文字拿掉
    applyEvent(m, { type: 'status', status: 'done', needWork: { denied: [] } });
    assert(m.needWork && m.parts[0].text === '要改 a.js' && m.parts[1].parts[0].text === 'b' && !partsText(m.parts).includes(MARK), JSON.stringify(m));
    const plain = { parts: [{ kind: 'text', text: 'a' }] };
    applyEvent(plain, { type: 'status', status: 'done' });
    assert(!('needWork' in plain) && plain.parts[0].text === 'a', '一般回合不應受影響');
    // 串流中打到一半的標記先藏起來；不是串流就原樣
    assert(stripMark('abc\n[[agentdesk:wo', true) === 'abc\n' && stripMark('abc [[agentdesk:wo') === 'abc [[agentdesk:wo' && stripMark('a [link]', true) === 'a [link]', 'stripMark 不對');
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
  await check('執行：Claude 相容格式回報用量 → session 大小取最後一個請求', async () => {
    const { sessionSize } = require(path.join(SRC, 'agents.js'));
    const cfg = custom('fake-claude.js', { format: 'claude', promptMode: 'stdin', resumeFlag: '--resume' });
    const r1 = await go(cfg, 'q');
    const r2 = await go(cfg, 'again', r1.sessionId);
    assert(r1.kind === 'claude' && r1.sessionId === 'cc-1' && /session=cc-1/.test(r2.text), `${r1.kind} ${r1.sessionId} ${r2.text}`);
    assert(sessionSize(r1).tokens === 40107, JSON.stringify({ last: r1.lastUsage, usage: r1.usage }));
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
      // Claude 相容格式、會回報用量：測 session 大小用（不排進開頭的步驟，由 e2e-check.js 自己送）
      xcc: c('fake-claude.js', { name: 'CC', color: '#cc7755', format: 'claude', promptMode: 'stdin', resumeFlag: '--resume' }),
    },
  }, null, 2));
  // 沒有 mode 欄位的舊對話（已有訊息）：載入後要當成對話模式（唯讀）
  fs.mkdirSync(path.join(data, 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(data, 'conversations', 'legacy1.json'), JSON.stringify({ id: 'legacy1', title: 'Legacy', cwd: dir, created: 1, updated: 1, sessions: {},
    messages: [{ id: 'u1', role: 'user', agent: 'claude', text: 'old', ts: 1 }, { id: 'a1', role: 'assistant', agent: 'claude', parts: [{ kind: 'text', text: 'ok' }], status: 'done', ts: 2 }] }));
  // 工作資料夾裡現成的進程檔（兩項任務、一項完成）：新對話要能選它接續，右欄要讀得出任務
  fs.mkdirSync(path.join(dir, 'docs', '進程'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', '進程', 'Seeded.md'), ['# Seeded progress', '', '## ▶ Resume here', '- Status: two tasks listed.', '- Next: do task 2.', '',
    '## Tasks', '| # | Task | Status |', '|---|---|---|', '| 1 | Write parser | Done |', '| 2 | Wire panel | Pending |', ''].join('\n'));
  const checkJs = fs.readFileSync(path.join(__dirname, 'validate', 'e2e-check.js'), 'utf8');
  const launch = async (language, steps, foreign, del) => {
    const s = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));
    s.language = language;
    fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify(s, null, 2));
    const env = { ...process.env, AGENTDESK_DATA: data, AGENTDESK_SELFTEST: dir, AGENTDESK_SELFTEST_STEPS: JSON.stringify(steps),
      AGENTDESK_SELFTEST_SHOTS: JSON.stringify([[`e2e-${language}`, '']]),
      // 檢查腳本自己丟錯時，把錯誤訊息帶回來（不然只會看到「Script failed to execute」）
      AGENTDESK_SELFTEST_JS: (foreign ? `window.__FOREIGN = ${JSON.stringify(foreign)};\n` : '') + (del ? `window.__DELETE = ${JSON.stringify(del)};\n` : '')
        + `(async () => { try { return await ${checkJs}\n } catch (e) { return { __error: String((e && e.stack) || e) }; } })()` };
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
    let res;
    try { res = JSON.parse(line.slice(8)); } catch (e) { fail(`畫面測試（${language}）：結果解析`, e.message); return null; }
    if (res?.__error) { fail(`畫面測試（${language}）：檢查腳本出錯`, res.__error.split('\n').slice(0, 3).join(' ｜ ')); return null; }
    return res;
  };
  const r = await launch('en', [['xecho', 'hello from validate'], ['xagy', 'first'], ['xagy', 'second']]);
  if (!r) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} return; }
  const msgs = r.messages || [];
  await check('畫面：英文介面沒有殘留中文', () => assert(r.uiLang === 'en' && !r.cjkLeft.length && !r.settingsCjk.length, `${r.uiLang} ${[...r.cjkLeft, ...r.settingsCjk].join('；')}`));
  await check('畫面：切換列與右欄列出已加入的 Agent', () => assert(r.picker.join() === 'claude,xecho,xagy,xcc' && r.panelCards === 4, `${r.picker} / ${r.panelCards}`));
  await check('畫面：純文字 Agent 回覆', () => assert(msgs[0]?.status === 'done' && /Echo got: hello from validate/.test(msgs[0].text), JSON.stringify(msgs[0])));
  await check('畫面：agy 兩輪（工具卡片＋接續對話）', () => {
    assert(msgs[1]?.status === 'done' && msgs[1].tools.includes('run_command:done'), JSON.stringify(msgs[1]));
    assert(/conv=conv-abc/.test(msgs[2]?.text || ''), JSON.stringify(msgs[2]));
  });
  await check('畫面：換 Agent 時附上先前對話並顯示字數、設定頁有附帶量選項', () => {
    // xecho → xagy（第一次，帶 xecho 的往來）→ xagy（接續，沒有新往來就不附）
    const c = r.ctxChars || [];
    assert(c[3] > 0 && !c[5] && (r.ctxNotes || []).length === 1 && /earlier chat/.test(r.ctxNotes[0]) && r.contextSetting === 'lean,standard,full',
      JSON.stringify({ chars: c, notes: r.ctxNotes, setting: r.contextSetting }));
    return r.ctxNotes[0];
  });
  await check('畫面：對話／工作模式（切換鈕在側欄「新對話」右邊、預設對話並帶唯讀說明、切換存進對話、再點已選的模式不跳視窗、執行中不能換、舊對話當對話）', () => { const m = r.mode || {};
    assert(m.buttons === 'chat,work' && m.place && m.initial && m.chatNote && m.enabled && m.saved && m.reclick && m.locked && m.workNoNote && m.back && m.newIsChat && m.legacy === 'chat' && m.legacyUi, JSON.stringify(m)); });
  await check('畫面：對話模式下 Agent 要改檔時出現按鈕，按了切到工作模式並由同一個 Agent 接著做', () => { const n = r.needWork || {};
    assert(n.flagged && n.stripped && n.shown && n.hiddenMark && n.cjk === false && n.switched && n.continued && n.workNote && n.gone, JSON.stringify(n)); });
  const workFileOf = () => { try { return fs.readFileSync(path.join(dir, 'docs', '進程', 'E2E Work 1.md'), 'utf8'); } catch { return ''; } };
  const workFileEn = workFileOf();
  await check('畫面：切到工作模式時取工作名（可不建進程檔）、頂列顯示工作名、照範本建進程檔、工作指示帶給 Agent', () => { const w = r.work || {};
    assert(w.popShown && w.prefill && w.popCjk === false && w.skipped && w.popOnContinue && w.startEnabled && w.saved && w.chip && w.note
      && workFileEn.startsWith('# E2E Work 1 ') && workFileEn.includes('## ▶ ') && /\n\| # \| /.test(workFileEn) && !CJK.test(workFileEn),
      JSON.stringify({ ...w, file: workFileEn.slice(0, 60) })); });
  await check('畫面：右欄工作現況讀進程檔；新對話可以接續資料夾裡現成的工作', () => { const p = r.workPanel || {}, s = r.resume || {};
    assert(p.shown && p.name === 'E2E Work 1' && p.resume === 4 && p.noTasks && p.cjk === false
      && s.pick && s.pickCjk === false && s.panelHidden && s.listed && s.listCjk === false && s.picked && s.panel && s.panelCjk === false, JSON.stringify({ p, s })); });
  await check('畫面：確認與提示視窗畫在頁面裡（取消、確定、Esc，關掉後焦點回輸入框）', () => { const a = r.ask || {};
    assert(a.shown && a.text && a.focus && a.cjk === false && a.no && a.yes && a.alert && a.esc, JSON.stringify(a)); });
  await check('畫面：連續的動作收成一行、預設收合，單獨一個維持原樣', () => { const f = r.fold || {};
    assert(f.groups === 1 && f.closed && f.inner === 3 && f.think === 1 && f.solo === 1 && f.count && f.failed && f.last && f.running && f.cjk === false, JSON.stringify(f)); });
  await check('畫面：設定頁每個 Agent 有「極度節省 token」的開關，新增 CLI 時會問要不要加', () => { const f = r.frugalUi || {};
    assert(f.boxes && f.off && f.asked && f.askCjk === false && f.checked, JSON.stringify(f)); });
  await check('畫面：打開規則的 Agent 在 prompt 最前面收到規則，關掉就不附', () => { const f = r.frugal || {};
    assert(f.on && f.off, JSON.stringify(f)); });
  await check('畫面：視窗縮小時頂列不疊到右欄（主欄不到 400 時只留標題與圖示）', () => { const [w1, w2, w3, w4] = r.topbar || [];
    assert([w1, w2, w3, w4].every(w => w && w.inside && w.apart), JSON.stringify(r.topbar));
    // 寬的時候標題、工作名、資料夾、五顆圖示都在；窄的時候剩標題與五顆圖示
    assert(!w1.tight && w1.shown === 8 && !w2.tight && w2.shown === 8 && w3.tight && w3.shown === 6 && w4.tight && w4.shown === 6, JSON.stringify(r.topbar));
    return `主欄 ${[w1, w2, w3, w4].map(w => w.main).join('／')}px`;
  });
  await check('畫面：右欄卡片顯示 session 大小、超過門檻提醒並多一顆壓縮、工作中壓灰、只讓一個 Agent 重開', () => { const z = r.size || {};
    assert(z.stored === 40107 && z.session === 'cc-1' && z.shown && z.notBig && z.cjk === false && z.none && z.noCompress && z.big && z.bigCjk === false && z.compressBtn
      && z.offWhenRunning && z.onWhenIdle && z.reset, JSON.stringify(z)); });
  await check('畫面：訊息下方有時間與複製，Agent 的訊息多一顆分支；右鍵選單有同樣的功能', () => { const f = r.msgFoot || {};
    assert(f.user && f.agent && f.cjk === false && f.copyUser && f.menu && f.menuCjk === false && f.copyAgent, JSON.stringify(f)); });
  await check('畫面：從某一則訊息分支（帶訊息與索引、不帶 session、原本的對話不動）', () => { const f = r.fork || {};
    assert(f.made && f.msgs && f.noSession && f.kept && f.title && f.titleCjk === false && f.index && f.srcSame && f.bad && f.opened, JSON.stringify(f)); });
  // 逐字稿：主程序每一輪結束後寫到資料夾的 transcripts/<對話 id>.md
  const trRead = (id, name = 'transcript.md') => { try { return fs.readFileSync(path.join(data, 'transcripts', String(id), name), 'utf8'); } catch { return ''; } };
  // 檔案說明與各段標題（內文是對話內容，不查語言）
  const trFrame = md => md.split('\n## #')[0] + (md.match(/^## #\d+ .*$/gm) || []).join('\n');
  const trEn = trRead(r.transcript?.id);
  await check('畫面：每一輪結束後寫出逐字稿（一則訊息一段、編號連續、工具各一行）', () => {
    const heads = trEn.match(/^## #\d+ /gm) || [];
    assert(r.transcript?.count >= 6 && heads.length === r.transcript.count && heads.every((h, i) => h === `## #${i + 1} `)
      && trEn.startsWith('# Transcript: hello from validate\n') && /^## #1 User → Echo · \d{4}-\d\d-\d\d \d\d:\d\d$/m.test(trEn) && /^## #2 Echo · /m.test(trEn)
      && /Echo got: hello from validate/.test(trEn) && /^- Tool: run_command/m.test(trEn) && !CJK.test(trFrame(trEn)),
      JSON.stringify({ count: r.transcript?.count, heads: heads.length, head: trEn.slice(0, 80), cjk: trFrame(trEn).split('\n').find(l => CJK.test(l)) }));
    return `${heads.length} 段`;
  });
  // 壓縮：索引檔在逐字稿旁邊，由主程序從假 Agent 的回覆挑出索引行寫進去
  const idxEn = trRead(r.transcript?.id, 'index.md');
  await check('畫面：壓縮（請 Agent 寫索引、不進對話記錄、清掉 session、下一輪改附索引＋最近幾則、再壓一次只追加）', () => {
    const k = r.compress || {}, n = k.next || {}, [u1, u2] = k.upto || [];
    const lines = idxEn.split('\n').filter(l => /^#\d/.test(l)), half = Math.floor((1 + u1) / 2);
    assert(k.enabled && k.hadSession && k.btnCjk === false && k.note && k.noteCjk === false && k.noteGone && k.running && k.asked && k.askCjk === false
      && k.done && k.mark && k.markCjk === false && k.btnOff && k.info, JSON.stringify(k));
    // 接續與否：大小不知道的 xagy 接續（確認視窗沒有「開新的 session」那句）；15 萬 tokens 的 xcc 不接續（有那句）
    assert(k.resumeInfo && k.askResume && k.bigInfo, JSON.stringify({ resumeInfo: k.resumeInfo, askResume: k.askResume, bigInfo: k.bigInfo }));
    // 壓完那一行：範圍、補了佔位的段落，英文介面沒有中文
    assert(k.summary && k.summaryCjk === false, k.summaryText);
    // 下一輪沒有 session 的 Agent：兩筆索引、逐字稿路徑、索引涵蓋的最後 4 則原文（有編號）
    assert(n.index === 2 && n.recent === 4 && n.first === n.upto - 3 && n.transcript === 'yes', JSON.stringify(n));
    // 索引檔：第一次兩筆（假 Agent 夾的說明與不同寫法都整理成同一種格式），第二次只追加新的兩段
    // 第二次是從右欄卡片按的：寫索引的是那張卡片的 Agent，不是輸入框下方選的
    assert(k.card, '從卡片按壓縮，寫索引的不是那張卡片的 Agent');
    // 第一次：xagy 接續了 session（conv=conv-abc）；它寫的 src/ghost.js 逐字稿裡沒有，拿掉；xcc 用 Edit 改過的 src/edited.js 由動作記錄補在涵蓋那一則的那筆。
    // 第二次：xcc 沒接續（resumed=no），故意漏掉最後一段 → 補一筆「沒有索引」的佔位，列出那一段改過的檔
    const ed = at => (k.ccAt >= at[0] && k.ccAt <= at[1] ? 'src/edited.js' : '-');
    assert(k.againEnabled && k.again && u2 === u1 + 4 && lines.length === 4 && idxEn.startsWith('# Index: hello from validate\n') && !CJK.test(idxEn.split('\n#')[0]) && k.ccAt > 0
      && lines[0] === `#1–#${half}｜first topic conv=conv-abc｜decided X｜${ed([1, half])}` && lines[1] === `#${half + 1}–#${u1}｜second topic｜undecided｜${ed([half + 1, u1])}`
      && lines[2] === `#${u1 + 1}–#${u2 - 1}｜cc topic resumed=no｜ok｜-` && lines[3] === `#${u2}–#${u2}｜(no index entry)｜-｜src/edited.js`,
    JSON.stringify({ again: k.again, upto: k.upto, ccAt: k.ccAt, lines }));
    return `索引 ${lines.length} 筆，涵蓋到 #${u2}`;
  });
  await check('畫面：沒有進程檔的對話壓縮時多記現況與下一步，下一輪接在索引後面；有進程檔的不記', () => {
    const s = r.state || {};
    assert(s.workNone && s.saved && s.next, JSON.stringify(s));
  });
  await check('畫面：工作模式完成一項任務、session 偏大時提示重開（第一次只記、小 session 不提示、按了清掉 session）', () => {
    const k = r.taskTip || {};
    assert(k.work && k.first && k.small && k.shown && k.cjk === false && k.same && k.reset, JSON.stringify(k));
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
  await check('畫面：右欄卡片切換這個對話的模型與強度（不改設定）', () => { const m = r.convModel || {};
    assert(m.mainCount >= 5 && m.allCount >= 14 && m.picked === 'claude-sonnet-5-5' && m.effort === 'high' && m.info && m.reset && m.settingsKept && !m.menuCjk?.length,
      JSON.stringify(m)); });
  await check('畫面：右欄額度條、只顯示目前對話的工作', () => { const q = r.quota || {};
    assert(q.rows === 2 && /76/.test(q.text) && /10/.test(q.text) && q.low && !q.cjk && r.panelScoped, JSON.stringify({ ...q, scoped: r.panelScoped })); });
  await check('畫面：設定頁 Claude 模型清單完整、Codex／Cursor 從新增 Agent 加入、沒有 Gemini', () => { const s = r.settingsModels || {};
    assert(s.claudeOptions >= 14 && s.presets?.includes('builtin:codex') && s.presets?.includes('builtin:cursor') && !s.presets?.includes('gemini') && !s.builtinShown?.length,
      JSON.stringify(s)); });
  // 簡中：只有繁體才有的字（出現在繁中原文、但沒出現在任何簡中翻譯裡）不應留在畫面上
  const { CN } = require(path.join(SRC, 'shared', 'i18n.js'));
  const simp = new Set([...Object.values(CN).join('')]);
  const trad = [...new Set([...Object.keys(CN).join('')])].filter(ch => CJK.test(ch) && !simp.has(ch));
  // 第二次啟動結束前刪掉第一次的對話：它的逐字稿要跟著刪
  const rc = await launch('zh-CN', [['xecho', 'hello'], ['xagy', 'first']], `[${trad.join('')}]`, r.transcript?.id);
  if (rc) await check('畫面：簡中介面沒有殘留繁體字', () => assert(rc.uiLang === 'zh-CN' && !rc.cjkLeft.length && !rc.settingsCjk.length && !rc.ctxCjk.length && !rc.viewCjk && !rc.cwdPickCjk?.length && !rc.convModel?.menuCjk?.length && !rc.quota?.cjk && rc.needWork?.cjk === false && rc.work?.popCjk === false
    && rc.workPanel?.cjk === false && rc.resume?.pickCjk === false && rc.resume?.listCjk === false && rc.resume?.panelCjk === false
    && rc.size?.cjk === false && rc.size?.bigCjk === false
    && rc.compress?.btnCjk === false && rc.compress?.noteCjk === false && rc.compress?.askCjk === false && rc.compress?.markCjk === false,
    `${rc.uiLang} ${[...rc.cjkLeft, ...rc.settingsCjk, ...rc.ctxCjk, ...(rc.cwdPickCjk || []), ...(rc.convModel?.menuCjk || [])].join('；')}${rc.quota?.cjk ? '；額度條' : ''}${rc.needWork?.cjk !== false ? '；切到工作模式的詢問框' : ''}${rc.work?.popCjk !== false ? '；取工作名的視窗' : ''}${rc.workPanel?.cjk !== false || rc.resume?.panelCjk !== false ? '；右欄工作現況' : ''}${rc.resume?.pickCjk !== false || rc.resume?.listCjk !== false ? '；接續工作' : ''}${rc.size?.cjk !== false || rc.size?.bigCjk !== false ? '；session 大小' : ''}${rc.compress?.btnCjk !== false || rc.compress?.noteCjk !== false || rc.compress?.askCjk !== false || rc.compress?.markCjk !== false ? '；壓縮' : ''}${rc.viewCjk ? '；分類切換鈕' : ''}`));
  // 第二次啟動用同一個工作名：進程檔已經在，不能被新範本蓋掉
  if (rc) await check('畫面：同名的進程檔已存在時沿用、不覆蓋', () => assert(workFileEn && workFileOf() === workFileEn && rc.work?.saved && rc.work?.note,
    JSON.stringify({ same: workFileOf() === workFileEn, saved: rc.work?.saved, note: rc.work?.note })));
  if (rc) await check('畫面：刪對話時逐字稿與索引一起刪；簡中介面的逐字稿與索引沒有繁體字', () => {
    const cn = trRead(rc.transcript?.id), cnIdx = trRead(rc.transcript?.id, 'index.md'), foreign = new RegExp(`[${trad.join('')}]`);
    assert(trEn && idxEn && rc.transcript?.deleted && !fs.existsSync(path.join(data, 'transcripts', r.transcript.id)) && rc.transcript.id !== r.transcript.id
      && /^## #1 用户 → Echo · /m.test(cn) && cn.startsWith('# hello 逐字稿\n') && !foreign.test(trFrame(cn))
      && cnIdx.startsWith('# hello 索引\n') && cnIdx.split('\n').filter(l => /^#\d/.test(l)).length === 4 && !foreign.test(cnIdx.split('\n#')[0]),
      JSON.stringify({ deleted: rc.transcript?.deleted, gone: !fs.existsSync(path.join(data, 'transcripts', r.transcript?.id || 'x')), head: cn.slice(0, 60), idx: cnIdx.slice(0, 60),
        trad: [...trFrame(cn).split('\n'), ...cnIdx.split('\n#')[0].split('\n')].find(l => foreign.test(l)) }));
  });
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
    '- 對話模式下真的 CLI 有沒有擋下改檔（腳本只檢查帶出去的旗標與說明）',
    '- 真的 Agent 在對話模式想改檔時會不會照約定寫出標記（腳本用假 Agent 回覆標記）',
    '- 安裝／登入按鈕開出的 PowerShell 視窗與瀏覽器授權流程',
    '- 貼上截圖、拖曳檔案、選檔對話框等實際滑鼠鍵盤操作',
    '- 本機打包的 exe（`npm run dist` 之後）能啟動、能跑 Agent',
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
