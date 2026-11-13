// 開發用：AGENTDESK_SELFTEST=<輸出資料夾> 時自動跑幾輪對話、截圖後關閉。
//   AGENTDESK_SELFTEST_STEPS  '[["claude","...",["附件路徑"]],["codex","..."]]'
//   AGENTDESK_SELFTEST_MIDSHOT 執行中第幾毫秒截一張 mid.png
//   AGENTDESK_SELFTEST_SHOTS  '[["名稱","截圖前執行的 JS"]]'，預設 final + settings
//   AGENTDESK_SELFTEST_ATTACH '["路徑"]'：final 前放進待送附件並打開＋選單
//   AGENTDESK_SELFTEST_JS     跑完後執行並印出結果
const fs = require('fs');
const path = require('path');
module.exports = function selftest({ app, getWin, newConv, startTurn, getConv, addAttachments }) {
  const out = process.env.AGENTDESK_SELFTEST;
  const win = getWin();
  const env = k => process.env['AGENTDESK_SELFTEST_' + k];
  const steps = JSON.parse(env('STEPS') || '[]');
  const shots = JSON.parse(env('SHOTS') || '[["final",""],["settings","openSettings()"]]');
  const wait = ms => new Promise(r => setTimeout(r, ms));
  async function capture(name) {
    let img = await win.webContents.capturePage();
    for (let i = 0; i < 6 && img.isEmpty(); i++) { await wait(500); img = await win.webContents.capturePage(); }
    fs.writeFileSync(path.join(out, name + '.png'), img.toPNG());
    console.log('[st] shot', name, img.getSize().width + 'x' + img.getSize().height);
  }
  win.webContents.once('did-finish-load', async () => {
    const conv = newConv(env('CWD') || out);
    await win.webContents.executeJavaScript(`refreshList().then(() => openConv(${JSON.stringify(conv.id)}))`);
    if (env('MIDSHOT')) setTimeout(() => capture('mid'), +env('MIDSHOT'));
    for (const [agent, text, files] of steps) {
      console.log('[st] step', agent);
      try { await startTurn(conv.id, agent, text, addAttachments((files || []).map(p => ({ path: p })))); }
      catch (err) { console.log('[st] error', agent, err.message); continue; }
      const m = getConv(conv.id).messages.at(-1);
      console.log('[st] reply', agent, JSON.stringify(m.parts.filter(p => p.kind === 'text').map(p => p.text).join(' ').slice(0, 300)), m.error || '');
    }
    if (env('JS')) console.log('[st] js', JSON.stringify(await win.webContents.executeJavaScript(env('JS'))));
    if (env('ATTACH')) {
      const extra = JSON.stringify(addAttachments(JSON.parse(env('ATTACH')).map(p => ({ path: p }))));
      await win.webContents.executeJavaScript(`pending.push(...${extra}); renderAttachBar(); document.querySelector('#plusBtn').click();`);
    }
    await wait(800);
    for (const [name, js] of shots) {
      if (js) await win.webContents.executeJavaScript(js);
      await wait(500);
      await capture(name);
    }
    fs.writeFileSync(path.join(out, 'conv.json'), JSON.stringify(getConv(conv.id), null, 2));
    app.quit();
  });
};
