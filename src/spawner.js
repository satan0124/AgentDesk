// 在 worker thread 裡建立子行程。
// Windows 啟動大型執行檔（例如 claude.exe）時，CreateProcess 本身就要約 0.6 秒，
// 放在主程序做會讓整個視窗卡住；這裡代為 spawn，輸出再轉回主程序。
const { parentPort } = require('worker_threads');
const { spawn } = require('child_process');

const children = new Map();
const post = msg => parentPort.postMessage(msg);

parentPort.on('message', msg => {
  const { type, id } = msg;
  if (type === 'spawn') {
    let child;
    try {
      child = spawn(msg.file, msg.args, { ...msg.opts, windowsHide: true });
    } catch (err) {
      post({ type: 'error', id, message: err.message });
      post({ type: 'close', id, code: -1 });
      return;
    }
    children.set(id, child);
    post({ type: 'pid', id, pid: child.pid });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => post({ type: 'stdout', id, data }));
    child.stderr.on('data', data => post({ type: 'stderr', id, data }));
    child.stdin.on('error', () => {});
    child.on('error', err => post({ type: 'error', id, message: err.message }));
    child.on('close', code => { children.delete(id); post({ type: 'close', id, code }); });
  } else if (type === 'stdin') {
    const child = children.get(id);
    if (child) child.stdin.end(msg.data ?? '', 'utf8');
  } else if (type === 'kill') {
    const child = children.get(id);
    if (!child || child.exitCode !== null) return;
    if (process.platform === 'win32') {
      try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch {}
    } else {
      try { child.kill('SIGTERM'); } catch {}
    }
  }
});
