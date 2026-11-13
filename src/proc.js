// 主程序這邊的子行程介面：實際 spawn 交給 spawner.js（worker thread），主程序不會被卡住。
// 回傳的物件模仿 ChildProcess 常用的部分：stdout / stderr 的 data 事件、stdin.end、error / close 事件、pid、kill。
const path = require('path');
const { EventEmitter } = require('events');
const { Worker } = require('worker_threads');

let worker = null;
const procs = new Map();
let seq = 0;

function getWorker() {
  if (worker) return worker;
  // 打包後程式碼在 app.asar 裡；worker 的入口檔放在 app.asar.unpacked（見 package.json asarUnpack）
  const file = path.join(__dirname, 'spawner.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  worker = new Worker(file);
  worker.unref();
  worker.on('message', msg => {
    const p = procs.get(msg.id);
    if (!p) return;
    if (msg.type === 'pid') p.pid = msg.pid;
    else if (msg.type === 'stdout') p.stdout.emit('data', msg.data);
    else if (msg.type === 'stderr') p.stderr.emit('data', msg.data);
    else if (msg.type === 'error') p.emit('error', new Error(msg.message));
    else if (msg.type === 'close') { p.exitCode = msg.code; procs.delete(msg.id); p.emit('close', msg.code); }
  });
  worker.on('error', err => {
    // worker 掛了：讓所有進行中的行程結束，下次重開 worker
    for (const p of procs.values()) { p.emit('error', err); p.exitCode = -1; p.emit('close', -1); }
    procs.clear();
    worker = null;
  });
  return worker;
}

function stream() { const s = new EventEmitter(); s.setEncoding = () => s; return s; }

function spawnProc(file, args, opts = {}) {
  const id = ++seq;
  const p = new EventEmitter();
  p.pid = undefined;
  p.exitCode = null;
  p.killed = false;
  p.stdout = stream();
  p.stderr = stream();
  p.stdin = { end: data => getWorker().postMessage({ type: 'stdin', id, data: data ?? '' }), on: () => {} };
  p.kill = () => { p.killed = true; getWorker().postMessage({ type: 'kill', id }); };
  procs.set(id, p);
  const { env, cwd } = opts;
  getWorker().postMessage({ type: 'spawn', id, file, args, opts: { env, cwd } });
  return p;
}

// 類似 execFile：收集輸出，逾時就砍掉
function runProc(file, args, { timeout = 20000, env, cwd } = {}) {
  return new Promise(resolve => {
    const p = spawnProc(file, args, { env, cwd });
    let out = '', err = '', done = false;
    const finish = code => { if (done) return; done = true; clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); };
    const timer = setTimeout(() => { p.kill(); finish(-1); }, timeout);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { err += e.message; });
    p.on('close', code => finish(code));
    p.stdin.end('');
  });
}

module.exports = { spawnProc, runProc };
