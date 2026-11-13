// 用 Electron 把 build/icon.svg 轉成 build/icon.png 與多尺寸 build/icon.ico
// 執行：node_modules\electron\dist\electron.exe tools\make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'), 'utf8');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

// 一個隱藏視窗內用 canvas 直接把向量圖畫成各尺寸（小尺寸也是向量重繪，不是縮圖）
async function renderAll() {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<html><body></body></html>');
  const src = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  const urls = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image(); img.src = ${JSON.stringify(src)}; await img.decode();
    return ${JSON.stringify(SIZES)}.map(n => {
      const c = document.createElement('canvas'); c.width = c.height = n;
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, n, n);
      return c.toDataURL('image/png');
    });
  })()`);
  win.destroy();
  return urls.map((u, i) => ({ size: SIZES[i], data: Buffer.from(u.split(',')[1], 'base64') }));
}

function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o); dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2); dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...pngs.map(p => p.data)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const pngs = await renderAll();
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), pngs.at(-1).data);
  fs.writeFileSync(path.join(root, 'build', 'icon.ico'), ico(pngs));
  console.log('icon ok', pngs.map(p => `${p.size}:${p.data.length}`).join(' '));
  app.quit();
});
