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
  // 7) 主視窗不能被導走
  const before = location.href;
  location.href = 'file:///C:/__agentdesk_validate__/x.png';
  await wait(600);
  out.navigationBlocked = location.href === before && !!document.querySelector('#messages');
  return out;
})()
