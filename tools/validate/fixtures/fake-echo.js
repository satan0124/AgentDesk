// 驗證用假 Agent（純文字）：讀 stdin，分段回覆最後一行與收到的參數
let d = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { d += c; }).on('end', async () => {
  const last = d.trim().split('\n').pop();
  for (const part of ['Echo got: ', last.slice(0, 60), '\n', `(args: ${process.argv.slice(2).join(' ')})`]) {
    process.stdout.write(part);
    await new Promise(r => setTimeout(r, 60));
  }
});
