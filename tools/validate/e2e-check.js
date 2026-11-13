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
  const t0 = Date.now();
  document.querySelector('#saveSettings').click();
  while (!document.querySelector('#settingsModal').classList.contains('hidden') && Date.now() - t0 < 10000) await wait(10);
  out.saveMs = Date.now() - t0;
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
  document.querySelector('#viewToggle').click();
  out.projectView = document.querySelectorAll('#convList .proj').length > 0 && !!document.querySelector('#convList li.conv.sub');
  out.viewCjk = CJK.test(document.querySelector('#viewToggle').textContent);
  document.querySelector('#viewToggle').click();
  // 7) 主視窗不能被導走
  const before = location.href;
  location.href = 'file:///C:/__agentdesk_validate__/x.png';
  await wait(600);
  out.navigationBlocked = location.href === before && !!document.querySelector('#messages');
  return out;
})()
