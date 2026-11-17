// 在 AgentDesk 畫面裡執行（由 tools/validate.js 透過 AGENTDESK_SELFTEST_JS 帶入）。
// 回傳一個物件，validate.js 依此判斷通過與否。
(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const out = {};
  // 英文介面查「任何中文」；簡中介面查「只有繁體才有的字」（由 validate.js 帶入 window.__FOREIGN）
  const CJK = window.__FOREIGN ? new RegExp(window.__FOREIGN) : /[\u4e00-\u9fff]/;
  // 1) 介面語言（設定檔指定 en）：側欄、頂列、輸入框、右欄不應殘留中文
  out.uiLang = settings.uiLang;
  const zones = ['#sidebar', '#topbar', '#composer', '#agentPanel'];
  out.cjkLeft = [];
  for (const z of zones) {
    const el = document.querySelector(z);
    if (!el) { out.cjkLeft.push(`${z} 不存在`); continue; }
    const texts = [el.innerText, ...[...el.querySelectorAll('[title],[placeholder]')].map(x => (x.title || '') + ' ' + (x.placeholder || ''))];
    // 對話標題是使用者資料，不算
    const titles = [...document.querySelectorAll('#convList .t')].map(x => x.textContent);
    for (const t of texts) {
      let s = t || '';
      for (const ti of titles) s = s.split(ti).join('');
      const hit = s.split('\n').find(l => CJK.test(l));
      if (hit) out.cjkLeft.push(`${z}: ${hit.trim().slice(0, 40)}`);
    }
  }
  // 2) 切換列與右欄
  out.picker = [...document.querySelectorAll('#agentPicker button')].map(b => b.dataset.agent);
  out.panelCards = document.querySelectorAll('#agentCards .acard').length;
  // 3) 訊息
  out.messages = current.messages.filter(m => m.role === 'assistant').map(m => ({
    agent: m.agent, status: m.status, error: m.error || null,
    text: m.parts.filter(p => p.kind === 'text').map(p => p.text).join(''),
    tools: m.parts.filter(p => p.kind === 'tool').map(p => `${p.name}:${p.status}`),
  }));
  // 換 Agent 時附上的先前對話：訊息上要有字數提示
  out.ctxNotes = [...document.querySelectorAll('#messages .ctx-note')].map(x => x.textContent);
  out.ctxChars = current.messages.map(m => m.ctxChars || 0);
  out.contextSetting = $('#setContext') ? [...$('#setContext').options].map(o => o.value).join() : '';
  // 3b) 對話／工作模式（切換鈕在側欄最上面、「新對話」的右邊）：新對話預設「對話」（唯讀說明放在 prompt 最前面），切到「工作」會存進對話、說明不再帶
  const modeBtn = m => document.querySelector(`#modeToggle button[data-mode="${m}"]`);
  const isOn = m => modeBtn(m).classList.contains('on');
  const lastText = c => c.messages.at(-1).parts.filter(p => p.kind === 'text').map(p => p.text).join('');
  const noteHead = `(head: ${t('[對話模式：唯讀。不要建立、修改或刪除檔案，也不要執行會改動檔案的指令。需要改檔時，先說明要改什麼，再於回覆最後另起一行只寫 {mark}，AgentDesk 會請使用者決定要不要切換到工作模式。]').slice(0, 12)})`;
  const mid = current.id;
  out.mode = { buttons: [...document.querySelectorAll('#modeToggle button')].map(b => b.dataset.mode).join(),
    initial: current.mode === 'chat' && isOn('chat') && !isOn('work'),
    chatNote: !!out.messages[0]?.text.includes(noteHead) };
  // 位置：在側欄裡、和「新對話」同一列、在它右邊，右緣對齊下面的「依日期｜依專案」；頂列不再有
  const rc = sel => document.querySelector(sel).getBoundingClientRect();
  const tg = rc('#modeToggle'), nb = rc('#newConv'), vt = rc('#viewToggle');
  out.mode.place = !!document.querySelector('#sidebar .side-top #modeToggle') && !document.querySelector('#topbar #modeToggle')
    && tg.left >= nb.right && Math.abs((tg.top + tg.bottom) / 2 - (nb.top + nb.bottom) / 2) <= 1 && Math.abs(tg.right - vt.right) <= 1;
  // 測試視窗是隱藏的，requestAnimationFrame 不會跑；先手動重畫，切換鈕才會從「執行中停用」恢復
  flush();
  out.mode.enabled = !modeBtn('work').disabled && !modeBtn('chat').disabled;
  // 還沒取工作名：按 🛠 先問工作名（預填對話標題）。這裡選「不建進程檔」，只切模式
  const pop = document.querySelector('#workPop'), nameInput = document.querySelector('#workName'), chip = document.querySelector('#workChip');
  modeBtn('work').click();
  await wait(200);
  // docs/進程/ 是固定的資料夾名稱，不算殘留
  out.work = { popShown: !pop.classList.contains('hidden'), prefill: nameInput.value === current.title,
    popCjk: CJK.test(pop.innerText.split('docs/進程/').join('') + nameInput.placeholder) };
  document.querySelector('#workSkip').click();
  await wait(400);
  out.mode.saved = (await api.getConv(mid)).mode === 'work' && isOn('work') && !isOn('chat');
  out.work.skipped = !(await api.getConv(mid)).work && pop.classList.contains('hidden') && chip.classList.contains('hidden');
  // 已經在工作模式（沒有工作名）時再點一次 🛠：不做事，不跳出取工作名的視窗
  modeBtn('work').click();
  await wait(200);
  out.mode.reclick = pop.classList.contains('hidden') && isOn('work');
  // 執行中不能換模式：送出後馬上要求換回對話，主程序要擋下
  await api.send(mid, 'xecho', 'work turn');
  out.mode.locked = (await api.updateConv(mid, { mode: 'chat' })).mode === 'work';
  let w;
  for (let i = 0; i < 40; i++) { await wait(250); w = await api.getConv(mid); if (w.messages.at(-1).role === 'assistant' && w.messages.at(-1).status !== 'running') break; }
  out.mode.workNoNote = /Echo got: work turn/.test(lastText(w)) && !lastText(w).includes(noteHead);
  await wait(400);
  flush();
  modeBtn('chat').click();
  await wait(400);
  out.mode.back = (await api.getConv(mid)).mode === 'chat' && isOn('chat');
  // 沒有 mode 的舊對話（validate.js 預先放的 legacy1，已有訊息）當成對話模式：打開它，切換鈕選在 💬
  out.mode.legacy = (await api.getConv('legacy1'))?.mode;
  await openConv('legacy1');
  out.mode.legacyUi = current.id === 'legacy1' && isOn('chat') && !isOn('work');
  await openConv(mid);
  // 3c) 對話模式下 Agent 說要改檔（回覆帶約定的標記）→ 出現按鈕 → 按了切到工作模式，同一個 Agent 接著做
  //     用有 session 的 xagy：接著做的那一輪 prompt 最前面要有「可以修改檔案了」（fake-agy 會回報 head=）
  const turnDone = async n => {
    let c;
    for (let i = 0; i < 60; i++) { await wait(250); c = await api.getConv(mid); const m = c.messages.at(-1); if (c.messages.length >= n && m.role === 'assistant' && m.status !== 'running') break; }
    await wait(400); flush();
    return c;
  };
  const count0 = (await api.getConv(mid)).messages.length;
  await api.send(mid, 'xagy', `need edit ${Reduce.MARK}`);
  const n1 = await turnDone(count0 + 2);
  const nwBox = () => document.querySelector('#messages .msg.assistant:last-child .need-work:not(.hidden)');
  out.needWork = { flagged: !!n1.messages.at(-1).needWork,
    stripped: /agy got: need edit/.test(lastText(n1)) && !lastText(n1).includes(Reduce.MARK),
    shown: !!nwBox(), hiddenMark: !document.querySelector('#messages .msg.assistant:last-child').innerText.includes(Reduce.MARK),
    cjk: nwBox() ? CJK.test(nwBox().innerText) : null };
  // 這個對話還沒有工作名：按鈕按下後先問工作名，填了才切換並接著做
  nwBox()?.querySelector('button').click();
  await wait(200);
  out.work.popOnContinue = !pop.classList.contains('hidden');
  nameInput.value = 'E2E: Work/1';
  nameInput.dispatchEvent(new Event('input', { bubbles: true }));
  out.work.startEnabled = !document.querySelector('#workStart').disabled;
  document.querySelector('#workStart').click();
  const n2 = await turnDone(count0 + 4);
  // 工作名清成可以當檔名的字；頂列顯示工作名
  out.work.saved = n2.work?.name === 'E2E Work 1' && n2.work?.file === 'docs/進程/E2E Work 1.md';
  out.work.chip = !chip.classList.contains('hidden') && chip.textContent === 'E2E Work 1' && chip.title.includes(workFile()) && !CJK.test(chip.title.split(workFile()).join(''));
  const lastUser = n2.messages.filter(m => m.role === 'user').at(-1);
  out.needWork.switched = n2.mode === 'work' && isOn('work');
  out.needWork.continued = n2.messages.length === count0 + 4 && lastUser.agent === 'xagy' && lastUser.text === t('已切換到工作模式，請繼續剛才要做的修改。');
  out.needWork.workNote = lastText(n2).includes(`head=${t('[已切換到工作模式：可以修改檔案了。]').slice(0, 12)}`);
  out.needWork.gone = !document.querySelector('#messages .need-work:not(.hidden)');
  // 工作指示：沒有 session 的 Agent（xecho）每一輪 prompt 最前面都是「[工作模式：工作名]」
  await api.send(mid, 'xecho', 'with work');
  const n3 = await turnDone(count0 + 6);
  out.work.note = lastText(n3).includes(`(head: ${t('[工作模式：{name}]', { name: 'E2E Work 1' }).slice(0, 12)})`);
  // 右欄工作現況：讀剛照範本建好的進程檔（四條續傳指引、還沒有任務）
  const wsec = document.querySelector('#workSec');
  out.workPanel = { shown: !wsec.classList.contains('hidden'), name: wsec.querySelector('.wk-head .nm')?.textContent,
    resume: wsec.querySelectorAll('.wk-resume li').length, noTasks: !!wsec.querySelector('.wk-note') && !wsec.querySelector('.wk-tasks'),
    cjk: CJK.test(wsec.innerText) };
  // 3e) session 大小：假 Claude（xcc）照真的 CLI 的樣子回報用量 → 主程序記下最後一個請求的 40,107 → 卡片顯示
  await api.send(mid, 'xcc', 'size turn');
  const n4 = await turnDone(count0 + 8);
  renderAgentPanel();
  const sess = () => document.querySelector('#agentCards .acard[data-agent="xcc"] .sess');
  out.size = { stored: n4.sizes?.xcc?.tokens, session: n4.sessions?.xcc, shown: /40\.1k/.test(sess()?.textContent || ''), notBig: !!sess() && !sess().classList.contains('big'),
    cjk: sess() ? CJK.test(sess().innerText + sess().title + sess().querySelector('button').title) : null,
    none: !document.querySelector('#agentCards .acard[data-agent="xecho"] .sess'), noCompress: !!sess() && !sess().querySelector('.sess-compress') };
  // 3e2) 這一輪的用量：result 的 usage 加起來 75,110 → 回覆標題旁顯示 75.1k tokens（費用 0 不顯示），右欄有這個對話的加總
  flush();
  const useEl = [...document.querySelectorAll('#messages .msg.assistant')].at(-1)?.querySelector('.use-note');
  out.usage = { stored: n4.messages.at(-1).meta?.turn?.total === 75110, shown: /75\.1k tokens/.test(useEl?.textContent || '') && !/\$/.test(useEl?.textContent || ''),
    conv: /tokens/.test($('#convUsage').textContent), cost: usageHtml({ input: 1, output: 1, total: 2, cost: 0.5 }).includes('$0.50') && usageHtml({ input: 1, output: 1, total: 2, cost: 0.004 }).includes('$0.0040'), cjk: CJK.test((useEl?.textContent || '') + (useEl?.title || '') + $('#convUsage').textContent + $('#convUsage').title) };
  // 超過門檻（10 萬 tokens）：提醒重開
  current.sizes = { ...current.sizes, xcc: { tokens: 123456 } };
  renderAgentPanel();
  out.size.big = !!sess()?.classList.contains('big') && /123k/.test(sess().textContent);
  out.size.bigCjk = sess() ? CJK.test(sess().innerText) : null;
  // 偏大時多一顆「壓縮」（由這張卡片的 Agent 寫索引，7b 會按）
  const scomp = sess()?.querySelector('.sess-compress');
  out.size.compressBtn = !!scomp && scomp.dataset.compress === 'xcc' && !CJK.test(scomp.textContent + scomp.title);
  // 確認與提示視窗畫在頁面裡（原生的 confirm／alert 關掉後輸入框拿不回鍵盤焦點）：取消、確定、Esc，關掉後焦點回輸入框
  const am = document.querySelector('#askModal'), tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  const a1 = confirmBox('line1\nline2'); await tick();
  out.ask = { shown: !am.classList.contains('hidden'), text: document.querySelector('#askText').textContent === 'line1\nline2',
    focus: document.activeElement?.id === 'askYes', cjk: CJK.test(am.innerText) };
  document.querySelector('#askNo').click();
  out.ask.no = (await a1) === false && am.classList.contains('hidden');
  const a2 = confirmBox('x'); await tick(); document.querySelector('#askYes').click();
  out.ask.yes = (await a2) === true && document.activeElement?.id === 'input';
  const a3 = alertBox('y'); await tick();
  out.ask.alert = !am.classList.contains('hidden') && document.querySelector('#askNo').classList.contains('hidden');
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  out.ask.esc = (await a3) === true && am.classList.contains('hidden');
  // 連續兩個以上的動作收成一行、預設收合，那一行顯示個數、失敗數與最新的動作；夾在中間的思考過程收在一起；單獨一個動作維持原樣
  const fold = document.createElement('div');
  fold.innerHTML = renderParts([{ kind: 'text', text: 'a' }, { kind: 'tool', name: 'Read', detail: 'x', status: 'done' }, { kind: 'thinking', text: 'hmm' },
    { kind: 'tool', name: 'Bash', detail: 'y', status: 'error' }, { kind: 'tool', name: 'Edit', detail: 'z', status: 'running' }, { kind: 'text', text: 'b' },
    { kind: 'tool', name: 'Grep', detail: 'solo', status: 'done' }], 'k', true);
  const fg = fold.querySelectorAll('details.tools'), fsum = fg[0]?.querySelector('summary');
  out.fold = { groups: fg.length, closed: !!fg[0] && !fg[0].open, inner: fg[0]?.querySelectorAll('details.tool').length, think: fg[0]?.querySelectorAll('details.think').length,
    solo: fold.querySelectorAll(':scope > details.tool').length, count: /3/.test(fsum?.querySelector('.nm').textContent || ''), failed: /1/.test(fsum?.querySelector('.nm').textContent || ''),
    last: /Edit z/.test(fsum?.querySelector('.dt').textContent || ''), running: !!fsum?.querySelector('.st.running'), cjk: CJK.test(fsum?.textContent || '') };
  // 視窗縮小時頂列不能疊到右欄（用 body 的寬度當視窗寬度；側欄 268、右欄 290，剩下的是主欄）。
  // 標題放長、工作名與資料夾都在：每一個看得到的元素都要在主欄裡、彼此不重疊；主欄不到 400 時只留標題與圖示
  const tbar = document.querySelector('#topbar'), tmain = document.querySelector('#main'), ttitle = document.querySelector('#convTitle'), told = ttitle.textContent;
  ttitle.textContent = 'A very long conversation title that never fits. '.repeat(3);
  const fit = w => {
    document.body.style.width = w ? w + 'px' : ''; fitTopbar();
    const edge = tmain.getBoundingClientRect().right, box = el => el.getBoundingClientRect();
    const kids = [...tbar.querySelectorAll('#convTitle, #workChip, #cwdBtn, .top-actions .icon-btn')].filter(el => el.offsetParent !== null);
    return { main: Math.round(tmain.clientWidth), tight: tbar.classList.contains('tight'), shown: kids.length,
      inside: kids.every(el => box(el).right <= edge + 0.5), apart: kids.every((el, i) => !i || box(el).left >= box(kids[i - 1]).right - 0.5) };
  };
  out.topbar = [1269, 1000, 900, 760].map(fit);
  fit(0); ttitle.textContent = told;
  // 回合在跑的時候，卡片上的「壓縮」「重開」壓灰、不能按；跑完恢復
  const lastMsg = current.messages.at(-1), keepStatus = lastMsg.status;
  lastMsg.status = 'running'; renderAgentPanel();
  out.size.offWhenRunning = sess()?.querySelectorAll('button').length === 2 && [...sess().querySelectorAll('button')].every(b => b.disabled);
  lastMsg.status = keepStatus; renderAgentPanel();
  out.size.onWhenIdle = sess()?.querySelectorAll('button').length === 2 && [...sess().querySelectorAll('button')].every(b => !b.disabled);
  // 訊息下方的一列：時間、複製；Agent 的訊息多一顆「從這裡分支」。在訊息上按右鍵有同樣的功能（剪貼簿換成假的，只看寫進去什麼）
  const umsg = document.querySelector('#messages .msg.user'), amsg = [...document.querySelectorAll('#messages .msg.assistant')].at(-1);
  const foot = n => n?.querySelector(':scope > .msg-foot'), has = (n, act) => !!foot(n)?.querySelector(`[data-mact="${act}"]`);
  const byNode = n => current.messages.find(m => m.id === n.dataset.id);
  out.msgFoot = { user: !!foot(umsg)?.querySelector('.mt')?.textContent && has(umsg, 'copy') && !has(umsg, 'fork'),
    agent: !!foot(amsg)?.querySelector('.mt')?.textContent && has(amsg, 'copy') && has(amsg, 'fork'),
    cjk: CJK.test((foot(umsg)?.innerText || '') + (foot(amsg)?.innerText || '') + [...(foot(amsg)?.querySelectorAll('button, .mt') || [])].map(b => b.title).join('')) };
  let copied = null;
  navigator.clipboard.writeText = async s => { copied = s; };
  foot(umsg)?.querySelector('[data-mact="copy"]').click();
  await tick();
  out.msgFoot.copyUser = copied !== null && copied === byNode(umsg).text;
  amsg.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 500, clientY: 300 }));
  const mmenu = document.querySelector('#ctxMenu');
  out.msgFoot.menu = !mmenu.classList.contains('hidden') && [...mmenu.querySelectorAll('button')].map(b => b.dataset.act).join(',') === 'copy,fork';
  out.msgFoot.menuCjk = CJK.test(mmenu.innerText);
  copied = null;
  mmenu.querySelector('[data-act="copy"]')?.click();
  await tick();
  out.msgFoot.copyAgent = !!copied && copied === msgCopyText(byNode(amsg)) && mmenu.classList.contains('hidden');
  delete navigator.clipboard.writeText;
  // 「重開」只清這個 Agent 的 session，別的 Agent 不動（確認視窗在測試裡直接答是）
  window.confirmBox = async () => true;
  sess()?.querySelector('.sess-reset').click();
  await wait(500);
  const n5 = await api.getConv(mid);
  out.size.reset = !n5.sessions.xcc && !n5.sizes?.xcc && !!n5.sessions.xagy && !sess();
  // 4) 設定頁：開啟、每個自訂 Agent 都偵測到、存檔回應時間
  openSettings();
  await wait(2500);
  out.settingsConn = Object.fromEntries([...document.querySelectorAll('#agentSettings section[data-agent]')]
    .map(s => [s.dataset.agent, (s.querySelector('.pill')?.className || 'none').replace('pill ', '')]));
  out.settingsCjk = [...document.querySelectorAll('#settingsModal label > span, #settingsModal h3, #settingsModal .btn')]
    .map(x => x.textContent).filter(t => CJK.test(t) && !/假|測試/.test(t)).slice(0, 5);
  const claudeSel = document.querySelector('#agentSettings section[data-agent="claude"] select[data-k="model"]');
  out.settingsModels = { claudeOptions: claudeSel ? claudeSel.querySelectorAll('option').length : 0,
    presets: [...document.querySelectorAll('#customPreset option')].map(o => o.value),
    builtinShown: ['codex', 'cursor'].filter(a => document.querySelector(`#agentSettings section[data-agent="${a}"]`)) };
  // 每個 Agent 的設定都有「極度節省 token」的開關，預設沒勾；新增一個 CLI 時會問要不要加，選是就勾起來。
  // 這裡只看表單，不存：問完把剛新增的那個從表單拿掉
  const fbefore = new Set(Object.keys(form.agents)), fkeep = window.confirmBox;
  let fasked = '';
  window.confirmBox = async msg => { fasked = msg; return true; };
  document.querySelector('#customPreset').value = 'text';
  document.querySelector('#settingsModal [data-act="addCustom"]').click();
  await wait(300);
  const fid = Object.keys(form.agents).find(k => !fbefore.has(k));
  out.frugalUi = { boxes: [...document.querySelectorAll('#agentSettings section[data-agent]')].every(s => s.querySelector('[data-k="frugal"]')),
    off: document.querySelector('#agentSettings section[data-agent="xecho"] [data-k="frugal"]')?.checked === false,
    asked: !!fid && fasked.length > 20, askCjk: CJK.test(fasked),
    checked: !!fid && form.agents[fid].frugal === true && document.querySelector(`#agentSettings section[data-agent="${fid}"] [data-k="frugal"]`)?.checked === true };
  window.confirmBox = fkeep;
  if (fid) { delete form.agents[fid]; renderAgentSettings(); }
  // 用 MutationObserver 等視窗關閉：視窗被遮住時 Chromium 會把計時器節流到約 1 秒一次，用 setTimeout 輪詢會量到假的 1000ms
  const modal = document.querySelector('#settingsModal');
  const t0 = Date.now();
  const closed = new Promise(res => {
    const mo = new MutationObserver(() => { if (modal.classList.contains('hidden')) { mo.disconnect(); res(Date.now() - t0); } });
    mo.observe(modal, { attributes: true, attributeFilter: ['class'] });
  });
  document.querySelector('#saveSettings').click();
  out.saveMs = await Promise.race([closed, wait(10000).then(() => Date.now() - t0)]);
  // 5) 圖片預覽能開能關
  openLightboxPath(current.cwd + '\\nonexistent.png');
  const lbOpen = !document.querySelector('#lightbox').classList.contains('hidden');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  out.lightbox = lbOpen && document.querySelector('#lightbox').classList.contains('hidden');
  // 6) 側欄：右鍵選單、釘選、封存、依專案分類
  const id = current.id;
  const item = () => document.querySelector(`#convList li.conv[data-id="${id}"]`);
  const menu = document.querySelector('#ctxMenu');
  const rightClick = () => item().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 140 }));
  rightClick();
  out.ctxItems = [...menu.querySelectorAll('button')].map(b => b.dataset.act);
  out.ctxCjk = [...menu.querySelectorAll('button')].map(b => b.textContent).filter(x => CJK.test(x));
  menu.querySelector('[data-act="pin"]').click();
  await wait(400);
  const firstLabel = document.querySelector('#convList li.day')?.textContent;
  out.pinned = !!(await api.getConv(id)).pinned && firstLabel === t('已釘選');
  rightClick();
  menu.querySelector('[data-act="archive"]').click();
  await wait(400);
  const toggle = document.querySelector('#convList .arch-toggle');
  out.archived = !!(await api.getConv(id)).archived && !item() && !!toggle && !CJK.test(toggle.textContent);
  toggle.click();
  rightClick();
  menu.querySelector('[data-act="unarchive"]').click();
  await wait(400);
  out.unarchived = !(await api.getConv(id)).archived && !!item();
  document.querySelector('#viewToggle [data-view="project"]').click();
  out.projectView = document.querySelectorAll('#convList .proj').length > 0 && !!document.querySelector('#convList li.conv.sub');
  out.viewCjk = CJK.test(document.querySelector('#viewToggle').textContent);
  document.querySelector('#viewToggle [data-view="date"]').click();
  out.projectView = out.projectView && !document.querySelector('#convList .proj');
  // 6c) 右欄卡片切換這個對話的模型與強度、額度條、只顯示目前對話
  const baseModel = settings.agents.claude.model;
  const mbtn = () => document.querySelector('#agentCards .model-btn[data-model="claude"]');
  const mm = document.querySelector('#modelMenu');
  mbtn().click();
  await wait(100);
  const mainCount = mm.querySelectorAll('button[data-m]').length;
  mm.querySelector('button[data-more]').click();
  const allCount = mm.querySelectorAll('button[data-m]').length;
  const menuCjk = [...mm.querySelectorAll('.sec, button')].map(x => x.textContent).filter(x => CJK.test(x));
  mm.querySelector('button[data-m="claude-sonnet-5-5"]').click();
  await wait(300);
  const c1 = await api.getConv(id);
  mbtn().click(); await wait(100);
  mm.querySelector('button[data-e="high"]').click();
  await wait(300);
  const c2 = await api.getConv(id);
  const info = document.querySelector('#agentInfo').textContent;
  mbtn().click(); await wait(100);
  mm.querySelector('button[data-m=""]').click();
  await wait(300);
  const c3 = await api.getConv(id);
  out.convModel = { mainCount, allCount, picked: c1.agentCfg?.claude?.model, effort: c2.agentCfg?.claude?.effort,
    info: info.includes('Sonnet 5.5') && info.includes('high'), reset: !c3.agentCfg?.claude?.model && c3.agentCfg?.claude?.effort === 'high',
    settingsKept: settings.agents.claude.model === baseModel && (await api.getSettings()).agents.claude.model === baseModel, menuCjk };
  await api.updateConv(id, { agentCfg: { claude: null } });
  agentStatus.limits = { claude: { windows: [{ kind: 'five_hour', used: 24, resetsAt: Date.now() / 1000 + 3600 }, { kind: 'seven_day', used: 90, resetsAt: Date.now() / 1000 + 86400 }] } };
  renderAgentPanel();
  const qrows = [...document.querySelectorAll('#agentCards .acard[data-agent="claude"] .qrow')];
  out.quota = { rows: qrows.length, text: qrows.map(r => r.textContent).join(' | '), low: !!document.querySelector('#agentCards .qbar i.low'),
    cjk: CJK.test(qrows.map(r => r.textContent + r.title).join('')) };
  const finBefore = document.querySelectorAll('#recentJobs li:not(.empty)').length;
  // 6b) 新對話：輸入框上方的資料夾選單（有訊息的對話不顯示）
  const pick = document.querySelector('#cwdPick');
  const hiddenWithMsgs = pick.classList.contains('hidden');
  await newConv();
  await wait(300);
  const shown = !pick.classList.contains('hidden') && pick.querySelector('.t').textContent === baseName(current.cwd);
  out.mode.newIsChat = current.id !== mid && current.mode === 'chat' && isOn('chat') && !isOn('work');
  document.querySelector('#cwdPickBtn').click();
  const cm = document.querySelector('#cwdMenu');
  const dirs = [...cm.querySelectorAll('button[data-dir]')];
  out.cwdPick = { hiddenWithMsgs, shown, open: !cm.classList.contains('hidden'), dirs: dirs.length,
    checked: dirs.filter(b => b.querySelector('.ck')).length, browse: !!cm.querySelector('[data-act="browse"]') };
  // 資料夾名稱是使用者資料，只查介面字樣
  out.cwdPickCjk = [cm.querySelector('.sec').textContent, cm.querySelector('[data-act="browse"]').textContent].filter(x => CJK.test(x));
  document.body.click();
  out.cwdPick.closed = cm.classList.contains('hidden');
  out.panelScoped = finBefore > 0 && !!document.querySelector('#recentJobs .empty') && !document.querySelector('#agentCards .job');
  // 6d) 新對話「接續工作」：資料夾裡有現成的進程檔（validate.js 預先放的 Seeded.md：兩項任務、一項完成）→ 選它 → 右欄顯示任務
  await wait(300);
  const wpick = document.querySelector('#workPickBtn');
  out.resume = { pick: !wpick.classList.contains('hidden') && /\d/.test(wpick.textContent), pickCjk: CJK.test(wpick.textContent + wpick.title),
    panelHidden: wsec.classList.contains('hidden') };
  wpick.click();
  await wait(500);
  const seeded = [...document.querySelectorAll('#workItems button')].find(b => b.dataset.work === 'Seeded');
  out.resume.listed = !pop.classList.contains('hidden') && /1\/2/.test(seeded?.textContent || '');
  out.resume.listCjk = CJK.test(document.querySelector('#workExisting').innerText);
  seeded?.click();
  await wait(600);
  const picked = await api.getConv(current.id);
  out.resume.picked = picked.mode === 'work' && picked.work?.name === 'Seeded' && picked.work?.file === 'docs/進程/Seeded.md' && chip.textContent === 'Seeded' && pop.classList.contains('hidden');
  const wtasks = [...wsec.querySelectorAll('.wk-tasks li')];
  out.resume.panel = !wsec.classList.contains('hidden') && wsec.querySelectorAll('.wk-resume li').length === 2 && wtasks.length === 2
    && wtasks[0].classList.contains('done') && !wtasks[1].classList.contains('done') && /1/.test(wsec.querySelector('.cnt')?.textContent || '');
  out.resume.panelCjk = CJK.test(wsec.innerText);
  // 7) 主視窗不能被導走
  const before = location.href;
  location.href = 'file:///C:/__agentdesk_validate__/x.png';
  await wait(600);
  out.navigationBlocked = location.href === before && !!document.querySelector('#messages');
  // 7b) 壓縮：回到一開始那個對話，選 xagy（它在這個對話有 session）→ 按頂列的壓縮
  //     → 主程序請它寫索引（不進對話記錄）→ 清掉各 Agent 的 session → 下一輪沒有 session 的 Agent 拿到索引＋最近幾則有編號的原文
  await openConv(mid);
  const cbtn = document.querySelector('#compressBtn');
  const kc0 = await api.getConv(mid);
  agent = 'xagy'; updateComposer();
  out.compress = { enabled: !cbtn.disabled && !cbtn.classList.contains('on'), hadSession: !!kc0.sessions.xagy, btnCjk: CJK.test(cbtn.title) };
  // xagy 的 session 大小不知道 → 接續原本的 session 寫索引；xcc「size turn」那一則用 Edit 改過 src/edited.js（索引要由動作記錄補上）
  out.compress.resumeInfo = (await api.compressInfo(mid, 'xagy'))?.resume === true;
  out.compress.ccAt = kc0.messages.findIndex(m => m.role === 'assistant' && m.agent === 'xcc') + 1;
  const freshLine = name => t('{name} 會開新的 session 來寫，AgentDesk 直接把要寫的段落交給它，不接續原本的 session（原本的 session 沒看過全部的段落，或接續比重新讀還貴）。', { name });
  // 「壓縮中」的畫面狀態（直接設狀態來看，不靠時間差）：輸入框上方有一行、送出鈕變停止、不能換模式也不能再按壓縮
  const krow = convList.find(c => c.id === mid), knote = document.querySelector('#compressNote');
  krow.compressing = { agent: 'xagy', from: 1, to: 2 }; updateComposer();
  out.compress.note = !knote.classList.contains('hidden') && /Agy/.test(knote.textContent) && document.querySelector('#sendBtn').classList.contains('stop') && modeBtn('work').disabled && cbtn.disabled;
  out.compress.noteCjk = CJK.test(knote.textContent);
  krow.compressing = null; updateComposer();
  out.compress.noteGone = knote.classList.contains('hidden') && !document.querySelector('#sendBtn').classList.contains('stop') && !cbtn.disabled;
  let asked = '';
  window.confirmBox = async msg => { asked = msg; return true; };
  const compressed = async n => {
    let c;
    for (let i = 0; i < 80; i++) { await wait(250); c = await api.getConv(mid); if ((c.indexed || 0) >= n && !(await api.listConvs()).find(x => x.id === mid)?.running) break; }
    await wait(500);
    return c;
  };
  cbtn.click();
  // 主程序那邊：壓縮中這個對話算在執行，並說得出是誰在寫哪一段。
  // 不用計時器等（隱藏視窗的計時器會被拖慢到一秒一次，等到的時候早就壓完了）；壓縮的請求先送出，緊接著問就問得到
  let ksaw = null;
  for (let i = 0; i < 50 && !ksaw; i++) ksaw = (await api.listConvs()).find(x => x.id === mid)?.compressing || null;
  out.compress.running = !!ksaw && ksaw.agent === 'xagy' && ksaw.from === 1 && ksaw.to === kc0.messages.length;
  const kc1 = await compressed(kc0.messages.length);
  const askedFor = n => new RegExp(`#${n}(?!\\d)`).test(asked);
  out.compress.asked = askedFor(1) && askedFor(kc0.messages.length) && asked.includes('Agy');
  out.compress.askCjk = CJK.test(asked);
  out.compress.askResume = !asked.includes(freshLine('Agy'));
  out.compress.done = kc1.indexed === kc0.messages.length && kc1.messages.length === kc0.messages.length && !Object.keys(kc1.sessions).length && !Object.keys(kc1.sizes || {}).length;
  const kmark = document.querySelector('#messages .idx-mark');
  out.compress.mark = !!kmark && kmark.textContent.includes(`#${kc1.indexed}`) && kmark.previousElementSibling === [...document.querySelectorAll('#messages .msg')][kc1.indexed - 1];
  out.compress.markCjk = kmark ? CJK.test(kmark.textContent + kmark.title) : null;
  out.compress.btnOff = cbtn.disabled && cbtn.classList.contains('on');
  const info1 = await api.compressInfo(mid);
  out.compress.info = info1.upto === kc1.indexed && info1.lines === 2 && /transcript\.md$/.test(info1.transcript) && /index\.md$/.test(info1.index);
  // 下一輪：xecho 沒有 session → prompt 帶兩筆索引、逐字稿路徑、索引涵蓋的最後 4 則原文（有編號）
  await api.send(mid, 'xecho', 'after compress');
  const kc2 = await turnDone(kc1.messages.length + 2);
  const kseen = lastText(kc2).match(/\(index: (\d+) recent: (\d+) first: (\d+) transcript: (\w+)\)/) || [];
  out.compress.next = { index: +kseen[1], recent: +kseen[2], first: +kseen[3], transcript: kseen[4], upto: kc1.indexed };
  // 再壓一次：只替新的段落寫索引，追加在原本的後面
  out.compress.againEnabled = !cbtn.disabled;
  // 先讓 xcc 跑一輪大的（假 Claude 報 15 萬多 tokens，又改了一次 src/edited.js）→ 卡片偏大、出現壓縮鈕
  await api.send(mid, 'xcc', 'big size turn');
  const kcb = await turnDone(kc2.messages.length + 2);
  // 這次從右欄卡片按：輸入框下方選的是 xecho，按的是 xcc 那張卡片 → 由 xcc 寫。
  // xcc 的 session 太大 → 不接續、開新的讀逐字稿（假 Claude 回報 resumed=no），確認視窗多一句說明
  agent = 'xecho'; updateComposer();
  current = await api.getConv(mid); renderAgentPanel();
  out.compress.bigInfo = (await api.compressInfo(mid, 'xcc'))?.resume === false && kcb.sizes?.xcc?.tokens > 100000;
  asked = '';
  document.querySelector('#agentCards .acard[data-agent="xcc"] .sess-compress')?.click();
  let ksaw2 = null;
  for (let i = 0; i < 50 && !ksaw2; i++) ksaw2 = (await api.listConvs()).find(x => x.id === mid)?.compressing || null;
  out.compress.card = !!ksaw2 && ksaw2.agent === 'xcc' && asked.includes('CC') && asked.includes(freshLine('CC'));
  const kc3 = await compressed(kcb.messages.length);
  const info2 = await api.compressInfo(mid);
  out.compress.again = kc3.indexed === kcb.messages.length && info2.lines === 4 && askedFor(kc1.indexed + 1) && askedFor(kcb.messages.length);
  out.compress.upto = [kc1.indexed, kc3.indexed];
  // 壓完那一行：寫了幾筆、拿掉了逐字稿裡沒有的檔、最後一段沒有索引補了佔位；轉圈圖示不顯示
  flush();
  const knote2 = document.querySelector('#compressNote');
  out.compress.summary = !knote2.classList.contains('hidden') && knote2.querySelector('.spinner').classList.contains('hidden')
    && knote2.textContent.includes(`#${kc1.indexed + 1}–#${kcb.messages.length}`) && knote2.textContent.includes(`#${kcb.messages.length} `);
  out.compress.summaryText = knote2.textContent;
  out.compress.summaryCjk = CJK.test(knote2.textContent);
  // 7c) 「極度節省 token」規則：替 xecho 打開 → prompt 最前面就是規則（它沒有 session，每一輪都附）；關掉後不再附
  const fset = await api.getSettings();
  fset.agents.xecho.frugal = true;
  settings = await api.setSettings(fset);
  const fhead = `(head: ${t('[極度節省 token：把自己當成極度小氣的 AI，能省的 token 絕不浪費。').slice(0, 12)})`;
  await api.send(mid, 'xecho', 'frugal on');
  const fr1 = await turnDone(kc3.messages.length + 2);
  fset.agents.xecho.frugal = false;
  settings = await api.setSettings(fset);
  await api.send(mid, 'xecho', 'frugal off');
  const fr2 = await turnDone(kc3.messages.length + 4);
  out.frugal = { on: lastText(fr1).includes(fhead), off: !lastText(fr2).includes(fhead) };
  // 7c2) 環境檢查：Node.js、各 Agent、工作資料夾各一行；沒加入的內建 Agent 註明可以不用；資料夾不存在時給修法；設定頁的按鈕畫出結果
  const eset = await api.getSettings();
  const env1 = await api.envCheck(eset, current.cwd);
  const env2 = await api.envCheck({ ...eset, defaultCwd: current.cwd + '\\no-such-dir' }, null);
  openSettings();
  $('#envCheck').click();
  for (let i = 0; i < 80 && !document.querySelector('#envResult .env-row'); i++) await wait(250);
  const envText = $('#envResult').innerText;
  out.env = { node: env1[0]?.label === 'Node.js' && env1[0].ok === true, agents: ['Echo', 'Agy', 'CC'].every(n => env1.some(r => r.label === n && r.ok === true)),
    skipped: env1.filter(r => r.ok === null).map(r => r.label).join(), folder: env1.some(r => r.ok === true && r.detail === current.cwd),
    missing: env2.some(r => r.ok === false && /no-such-dir/.test(r.detail) && !!r.fix), ui: document.querySelectorAll('#envResult .env-row').length === env1.length,
    cjk: CJK.test(envText.split('\n').filter(l => !l.includes(current.cwd)).join('\n')) };
  $('#settingsModal').classList.add('hidden');
  // 7c3) 右側預覽：訊息裡的 .md 連結在右邊畫出來（右欄先讓位），預覽裡連到 .html 的連結換成沙箱 iframe；關掉後右欄回來
  const pvDir = current.cwd.replace(/[\\/]+$/, '') + '\\docs\\guide';
  const pvHost = document.createElement('div');
  pvHost.innerHTML = '<div class="md"><a href="docs/guide/preview.md">guide</a></div>';
  $('#messages').appendChild(pvHost);
  fixImages(pvHost);
  pvHost.querySelector('a').click();
  for (let i = 0; i < 20 && !document.querySelector('#previewPane .pv-body h1'); i++) await wait(150);
  const pvMd = { open: !$('#previewPane').classList.contains('hidden'), title: document.querySelector('#previewPane .pv-body h1')?.textContent === 'Preview Title',
    name: $('#previewPane .pv-name').textContent === 'preview.md', bold: !!document.querySelector('#previewPane .pv-body strong'),
    panelHidden: getComputedStyle($('#agentPanel')).display === 'none' };
  document.querySelector('#previewPane .pv-body a').click();
  for (let i = 0; i < 20 && !document.querySelector('#previewPane iframe'); i++) await wait(150);
  const fr = document.querySelector('#previewPane iframe');
  const pvHtml = { iframe: !!fr, sandbox: fr?.getAttribute('sandbox') === 'allow-scripts', src: /page\.html$/.test(fr?.src || ''), name: $('#previewPane .pv-name').textContent === 'page.html' };
  document.querySelector('#previewPane [data-pv="close"]').click();
  out.preview = { md: pvMd, html: pvHtml, closed: $('#previewPane').classList.contains('hidden') && getComputedStyle($('#agentPanel')).display !== 'none',
    dir: pvDir, cjk: CJK.test([...document.querySelectorAll('#previewPane [title]')].map(x => x.title).join(' ')) };
  // 回覆裡夾著的框架標籤（CSP 為了預覽開了 frame-src file:）要變成純文字，不能在主視窗載入
  pvHost.innerHTML = `<div class="md">${md('see <iframe src="file:///C:/x.html"></iframe> and <embed src="file:///C:/y.pdf">')}</div>`;
  out.preview.noFrame = !pvHost.querySelector('iframe, embed, object') && pvHost.textContent.includes('<iframe');
  pvHost.remove();
  // 7d) 從這裡分支：新對話帶著到那一則為止的訊息，模式、工作、資料夾照舊，沒有 session；
  //     索引裡完全落在這段之內的筆數跟著過去（第一次壓縮的兩筆），之後的不帶；原本的對話不動
  const fsrc = await api.getConv(mid), fat = kc1.indexed, fmsg = fsrc.messages[fat - 1];
  const fres = await api.forkConv(mid, fmsg.id);
  const fc = fres?.id ? await api.getConv(fres.id) : null;
  const finfo = fc ? await api.compressInfo(fc.id) : null;
  const fsrc2 = await api.getConv(mid);
  out.fork = { made: !!fc && fc.id !== mid, msgs: fc?.messages.length === fat && fc.messages.at(-1).id === fmsg.id, noSession: !!fc && !Object.keys(fc.sessions || {}).length,
    kept: fc?.mode === fsrc.mode && fc?.cwd === fsrc.cwd && fc?.work?.name === fsrc.work?.name && fc?.forkOf?.id === mid,
    title: !!fc && fc.title !== fsrc.title && fc.title.startsWith(fsrc.title), titleCjk: fc ? CJK.test(fc.title.slice(fsrc.title.length)) : null,
    index: finfo?.lines === 2 && finfo.upto === fat && fc?.indexed === fat,
    srcSame: fsrc2.messages.length === fsrc.messages.length && fsrc2.indexed === fsrc.indexed && Object.keys(fsrc2.sessions).join() === Object.keys(fsrc.sessions).join(),
    bad: !!(await api.forkConv(mid, 'nope'))?.error };
  // 從畫面按：分支後直接開到新對話
  await msgAction('fork', current.messages.find(m => m.role === 'assistant' && m.status !== 'running'));
  out.fork.opened = current.id !== mid && current.forkOf?.id === mid && current.messages.length === 2;
  // 7e) 沒有進程檔的對話：壓縮時多要「現況／下一步」，存在對話裡，下一輪接在索引後面。
  //     原本的對話（mid）有進程檔，兩次壓縮都沒有這兩行。用剛分支出來的 fc，切回對話模式（就沒有進程檔）來試
  const waitTurn = async (cid, n) => {
    let c;
    for (let i = 0; i < 60; i++) { await wait(250); c = await api.getConv(cid); const m = c.messages.at(-1); if (c.messages.length >= n && m.role === 'assistant' && m.status !== 'running') break; }
    return c;
  };
  out.state = { workNone: !kc1.state && !kc3.state };
  if (fc) {
    await api.updateConv(fc.id, { mode: 'chat' });
    await api.send(fc.id, 'xecho', 'state turn long');
    await waitTurn(fc.id, fat + 2);
    const sres = await api.compress(fc.id, 'xagy');
    const sc = await api.getConv(fc.id);
    out.state.saved = !sres?.error && sc.state?.at === fat + 2 && sc.indexed === fat + 2 && /agy now/.test(sc.state.now || '') && sc.state.next === 'agy next';
    await api.send(fc.id, 'xecho', 'after state');
    const sc2 = await waitTurn(fc.id, fat + 4);
    out.state.next = /\(state: yes\)/.test(lastText(sc2));
  }
  // 分支出來的兩個對話刪掉，回到原本的對話（後面的檢查照原本的對話數）
  const forkIds = [fc?.id, current.id !== mid ? current.id : null].filter(Boolean);
  await openConv(mid);
  for (const fid2 of forkIds) await api.deleteConv(fid2);
  // 7f) 工作模式完成一項任務：完成數變多、最大的 session 到 5 萬以上 → 輸入框上方提示＋「重開 session」；
  //     第一次讀到只記不提示、session 小不提示、按了清掉這個對話所有 session、提示消失。
  //     進程檔的內容直接餵給 noteTasksDone（畫面這一側的判斷），session 大小在畫面這邊補
  const tip = document.querySelector('#taskTip');
  const wname = current.work?.name;
  const tasksOf = n => ({ exists: true, name: wname, tasks: Array.from({ length: 3 }, (_, i) => ({ done: i < n })) });
  tasksDone.delete(mid); taskTip = null;
  current.sessions = { ...current.sessions, xcc: 'tip-s' }; current.sizes = { ...current.sizes, xcc: { tokens: 30000 } };
  noteTasksDone(tasksOf(0));
  const tipFirst = tip.classList.contains('hidden');
  noteTasksDone(tasksOf(1));
  const tipSmall = tip.classList.contains('hidden');
  current.sizes = { ...current.sizes, xcc: { tokens: 60000 } };
  noteTasksDone(tasksOf(2));
  out.taskTip = { work: !!wname, first: tipFirst, small: tipSmall, shown: !tip.classList.contains('hidden') && /60,000/.test(tip.textContent),
    cjk: CJK.test(tip.textContent), same: (noteTasksDone(tasksOf(2)), !tip.classList.contains('hidden')) };
  tip.querySelector('.btn').click();
  let tipC;
  for (let i = 0; i < 20; i++) { await wait(150); tipC = await api.getConv(mid); if (!Object.keys(tipC.sessions || {}).length) break; }
  flush();
  out.taskTip.reset = !Object.keys(tipC.sessions || {}).length && tip.classList.contains('hidden');
  // 7g) 邊對話邊記索引：使用者的話有「note X」時，假 Claude 在回覆最後一行寫索引（主題 topic-X）。
  //     存在訊息的 note 上，那一行畫面與存檔都不留；下一輪的要求帶著上一輪的主題（假 Claude 回報 prev=）。
  //     壓縮時記到的直接用（主題相同、相鄰的合成一筆），只請 Agent 補沒記到的（xecho 那一輪）；全都記到了就不跑 Agent
  const msgTextOf = m => (m?.parts || []).filter(p => p.kind === 'text').map(p => p.text).join('');
  const nc = await api.createConv(current.cwd);
  for (const [k, [a, s]] of [['xcc', 'note A one'], ['xcc', 'note A two'], ['xcc', 'note B'], ['xecho', 'plain turn long']].entries()) {
    await api.send(nc.id, a, s);
    await waitTurn(nc.id, (k + 1) * 2);
  }
  const nn1 = await api.getConv(nc.id);
  const ncc = nn1.messages.filter(m => m.role === 'assistant' && m.agent === 'xcc');
  await openConv(nc.id);
  out.notes = { saved: ncc.map(m => m.note?.topic).join() === 'topic-A,topic-A,topic-B' && ncc[0].note.result === 'result A',
    stripped: !JSON.stringify(nn1.messages).includes('[[agentdesk:index]]') && !document.querySelector('#messages').innerText.includes('agentdesk:index'),
    prev: ['none', 'topic-A', 'topic-A'].every((p, i) => msgTextOf(ncc[i]).includes(`prev=${p}`)), echoNone: !nn1.messages.at(-1).note };
  const ninfo = await api.compressInfo(nc.id, 'xcc');
  out.notes.info = ninfo?.parts === 1 && ninfo.noted === 2 && ninfo.resume === false;
  const nres = await api.compress(nc.id, 'xcc');
  out.notes.res = !nres?.error && nres.noted === 2 && nres.parts === 1 && nres.added === 4 && JSON.stringify(nres.gaps) === '[[8,8]]'
    && (await api.compressInfo(nc.id)).lines === 4;
  out.notes.summary = compressSummary(nres);
  // 全都記到了：不用請 Agent，確認視窗講明不花額度
  const nc2 = await api.createConv(current.cwd);
  await api.send(nc2.id, 'xcc', 'note C one'); await waitTurn(nc2.id, 2);
  await api.send(nc2.id, 'xcc', 'note C two'); await waitTurn(nc2.id, 4);
  await openConv(nc2.id);
  const ninfo2 = await api.compressInfo(nc2.id, 'xcc');
  asked = '';
  await compressWith('xcc');
  const nn2 = await api.getConv(nc2.id);
  out.notes.all = ninfo2?.parts === 0 && ninfo2.noted === 1 && nn2.indexed === 4 && !Object.keys(nn2.sessions).length && (await api.compressInfo(nc2.id)).lines === 1;
  out.notes.allAsk = asked.includes('#1') && asked.includes('#4') && !asked.includes('CC');
  out.notes.cjk = CJK.test(asked + out.notes.summary);
  await openConv(mid);
  await api.deleteConv(nc.id); await api.deleteConv(nc2.id);
  // 7h) 回合或委派還沒結束就刪掉對話（v0.1.7、v0.1.8 修過的時序問題）：等 3 秒，對話不能被存回來。
  //     xslow 一直輸出不結束；xhold 打 /delegate 請 xslow 做事，兩個都停在半途等這裡刪對話。存檔與逐字稿由 validate.js 查
  const hset = await api.getSettings();
  hset.agents.xslow.enabled = true; hset.agents.xhold.enabled = true;
  settings = await api.setSettings(hset);
  // 7g2) 同一個資料夾有別的對話在工作模式執行：送出前先問；按取消就不送、輸入框的字留著。對話模式不問
  const sdA = await api.createConv(current.cwd);
  await api.updateConv(sdA.id, { mode: 'work' });
  await api.send(sdA.id, 'xslow', 'busy');
  for (let i = 0; i < 40 && !(await api.listConvs()).find(x => x.id === sdA.id)?.running; i++) await wait(250);
  const sdB = await api.createConv(current.cwd);
  await openConv(sdB.id);
  const sdKeep = window.confirmBox;
  let sdAsked = '';
  window.confirmBox = async msg => { sdAsked = msg; return false; };
  // 先測工作模式（按取消、不送出），再測對話模式（不問、照常送出）；反過來的話第二次送出會變成按停止
  current = await api.updateConv(sdB.id, { mode: 'work' });
  $('#input').value = 'same dir work'; await submit();
  const sdB2 = await api.getConv(sdB.id);
  const sdWorkAsk = sdAsked, sdWorkInput = $('#input').value;
  sdAsked = '';
  current = await api.updateConv(sdB.id, { mode: 'chat' });
  $('#input').value = 'same dir chat'; await submit();
  const sdChat = sdAsked;
  out.sameDir = { chatNoAsk: !sdChat, asked: sdWorkAsk.length > 10, kept: sdWorkInput === 'same dir work' && !sdB2.messages.length,
    cjk: CJK.test(sdWorkAsk.replace(sdA.title, '')) };
  window.confirmBox = sdKeep;
  $('#input').value = '';
  await api.deleteConv(sdA.id); await api.deleteConv(sdB.id);
  await openConv(mid);
  const holdCase = async (agentId, text) => {
    const hc = await api.createConv(current.cwd);
    await api.send(hc.id, agentId, text(hc.id));
    let started = false, delegated = false;
    for (let i = 0; i < 40 && !started; i++) { await wait(250); started = !!(await api.listConvs()).find(x => x.id === hc.id)?.running; }
    // 讓 Agent（委派時是被委派的 xslow）真的跑起來
    for (let i = 0; i < 20 && !delegated; i++) { await wait(250); delegated = (await api.agentStatus()).running.some(j => j.convId === hc.id && j.role === 'delegate'); }
    await api.deleteConv(hc.id);
    await wait(3000);
    return { id: hc.id, started, delegated, gone: !(await api.getConv(hc.id)) && !(await api.listConvs()).some(x => x.id === hc.id) };
  };
  out.midDelete = { turn: await holdCase('xslow', () => 'hold'), delegate: await holdCase('xhold', id => `delegate xslow ${id}`) };
  // 7i) 執行中逐項核准：xhold 像 Claude 的 --permission-prompt-tool 一樣打 /approve → 訊息裡出現核准卡片；
  //     按允許／拒絕，Agent 拿到對應的答案；等待中按停止，一律拒絕、回合結束
  const apConv = await api.createConv(current.cwd);
  await openConv(apConv.id);
  const apCase = async (act) => {
    const n0 = (await api.getConv(apConv.id)).messages.length;
    await api.send(apConv.id, 'xhold', `approve ${apConv.id}`);
    let card = null;
    for (let i = 0; i < 40 && !card; i++) { await wait(250); flush(); card = [...document.querySelectorAll('#messages .part.approval')].find(c => c.querySelector('[data-approve]')); }
    const shown = !!card && /Bash/.test(card.textContent) && /npm test/.test(card.textContent);
    const cardText = card?.textContent || '';
    if (act === 'stop') await api.stop(apConv.id);
    else card?.querySelector(`[data-allow="${act === 'allow' ? 1 : 0}"]`)?.click();
    const c = await waitTurn(apConv.id, n0 + 2);
    const last = c.messages.at(-1), ap = last.parts.find(p => p.kind === 'approval');
    return { shown, answered: act === 'stop' ? last.status === 'stopped' && ap?.status === 'denied' : new RegExp(`"allow":${act === 'allow'}`).test(msgTextOf(last)) && ap?.status === (act === 'allow' ? 'allowed' : 'denied'), cardText };
  };
  const apAllow = await apCase('allow'), apDeny = await apCase('deny'), apStop = await apCase('stop');
  flush();
  out.approval = { allow: apAllow.shown && apAllow.answered, deny: apDeny.shown && apDeny.answered, stop: apStop.shown && apStop.answered,
    resolved: document.querySelectorAll('#messages .part.approval.done').length === 3, cjk: CJK.test(apAllow.cardText.replace(/Bash|npm test/g, '')) };
  await openConv(mid);
  await api.deleteConv(apConv.id);
  hset.agents.xslow.enabled = false; hset.agents.xhold.enabled = false;
  settings = await api.setSettings(hset);
  // 8) 逐字稿：validate.js 依對話 id 讀主程序寫的檔，段數要等於訊息數；
  //    第二次啟動時帶入 window.__DELETE（第一次的對話），刪掉後它的逐字稿要跟著不見
  out.transcript = { id: mid, count: (await api.getConv(mid)).messages.length };
  if (window.__DELETE) {
    await api.deleteConv(window.__DELETE);
    out.transcript.deleted = !(await api.getConv(window.__DELETE));
  }
  return out;
})()
