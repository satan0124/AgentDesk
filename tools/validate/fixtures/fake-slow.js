// 驗證用：一直輸出不結束，測「停止」能不能砍掉
process.stdin.resume();
let n = 0;
setInterval(() => process.stdout.write(`tick ${n++}\n`), 100);
