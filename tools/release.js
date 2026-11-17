// 發版：node tools/release.js <版號> <說明檔> [--dry] [--co-author "名字 <email>"]
//   例：node tools/release.js 0.2.1 docs/release-v0.2.1.md
// 依序做：檢查 → 跑 validate.js --e2e → 改 package.json、package-lock.json 的版號 → 提交「v<版號>」→ 打 tag → 推送 main 和 tag → gh release create。
// 任何一步失敗就停，並印出已經做到哪裡、怎麼接著做。--dry 只做檢查與驗證，不改檔、不提交、不推送。
// 說明檔要有英文、繁中、簡中三段（各段用 --- 分開，繁中、簡中段的第一個標題分別含「繁體中文」「简体中文」），每段都有安裝說明。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const ca = args.indexOf('--co-author');
const coAuthor = ca >= 0 ? args[ca + 1] : '';
const [version, notesArg] = args.filter((a, i) => !a.startsWith('--') && (ca < 0 || i !== ca + 1));

const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { cwd: ROOT, encoding: 'utf8', stdio: opts.show ? 'inherit' : 'pipe', ...opts });
const git = (...a) => run('git', a).trim();
function stop(msg, done = []) {
  console.error(`\n✗ ${msg}`);
  if (done.length) console.error(`已經做完：\n${done.map(d => `  - ${d}`).join('\n')}`);
  process.exit(1);
}

// ---------- 檢查 ----------
if (!/^\d+\.\d+\.\d+$/.test(version || '')) stop('用法：node tools/release.js <版號，例如 0.2.1> <說明檔> [--dry] [--co-author "名字 <email>"]');
const tag = `v${version}`;
const notesFile = path.resolve(ROOT, notesArg || '');
if (!notesArg || !fs.existsSync(notesFile)) stop(`找不到說明檔：${notesArg || '（沒給）'}`);
const notes = fs.readFileSync(notesFile, 'utf8');
const parts = notes.split(/^---\s*$/m);
const problems = [];
if (parts.length !== 3) problems.push(`說明檔要用 --- 分成英文、繁中、簡中三段，現在是 ${parts.length} 段`);
else {
  if (!/繁體中文/.test(parts[1].split('\n').find(l => l.startsWith('#')) || '')) problems.push('第二段的第一個標題要含「繁體中文」');
  if (!/简体中文/.test(parts[2].split('\n').find(l => l.startsWith('#')) || '')) problems.push('第三段的第一個標題要含「简体中文」');
  ['### Install', '### 安裝', '### 安装'].forEach((h, i) => { if (!parts[i].includes(h)) problems.push(`第 ${i + 1} 段少了「${h}」`); });
}
if (problems.length) stop(`說明檔格式不對：\n  - ${problems.join('\n  - ')}`);

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'main') stop(`要在 main 分支發版，現在是 ${branch}`);
// 未追蹤的檔不算（docs/、.claude/ 不進版控）；已追蹤的檔內容有改動（含已暫存）就停。
// 用 git diff 比內容，不用 git status：status 會把只有換行不同（core.autocrlf）、內容其實一樣的檔也列成 M
const dirty = git('-c', 'core.safecrlf=false', 'diff', '--name-only', 'HEAD');
if (dirty) stop(`工作區還有沒提交的改動，先提交或還原：\n${dirty}`);
if (git('tag', '--list', tag)) stop(`tag ${tag} 已經存在`);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
if (pkg.version === version) stop(`package.json 已經是 ${version}`);
if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) stop(`package-lock.json 的版號（${lock.version}）跟 package.json（${pkg.version}）對不上`);
const remote = git('remote', 'get-url', 'origin');
const repo = (remote.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/) || [])[1];
if (!repo) stop(`看不出 GitHub 儲存庫：${remote}`);
try { run('gh', ['auth', 'status']); } catch { stop('gh 沒有登入，先執行 gh auth login'); }
console.log(`✓ 檢查通過：${pkg.version} → ${version}，${repo}，說明檔 ${path.relative(ROOT, notesFile)}`);

// ---------- 驗證 ----------
console.log('跑 node tools/validate.js --e2e …');
try { run(process.execPath, [path.join('tools', 'validate.js'), '--e2e'], { show: true }); } catch { stop('驗證沒有全部通過，先修好再發版'); }
console.log('✓ 驗證通過');
if (dry) { console.log(`\n--dry：到這裡為止。真的發版會改版號、提交「${tag}」、打 tag、推送 main 和 ${tag}、建立 Release「AgentDesk ${tag}」。`); process.exit(0); }

// ---------- 改版號、提交、tag、推送、Release ----------
const done = [];
// 只改版號那一行，不重新排版（npm version 會把 package.json 裡寫成一行的陣列展開）
const bump = (file, re, count) => {
  const p = path.join(ROOT, file);
  const s = fs.readFileSync(p, 'utf8');
  let n = 0;
  const out = s.replace(re, (m, head) => { n++; return `${head}${version}"`; });
  if (n !== count) stop(`${file} 找到 ${n} 個版號，預期 ${count} 個，沒有改`, done);
  fs.writeFileSync(p, out);
};
bump('package.json', /^(  "version": ")[^"]+"/m, 1);
bump('package-lock.json', /("name": "agent-desk",\s*\n\s*"version": ")[^"]+"/g, 2);
done.push(`package.json、package-lock.json 改成 ${version}`);
const msgFile = path.join(require('os').tmpdir(), `agentdesk-release-${version}.txt`);
fs.writeFileSync(msgFile, `${tag}\n${coAuthor ? `\nCo-Authored-By: ${coAuthor}\n` : ''}`);
try {
  git('add', 'package.json', 'package-lock.json');
  git('-c', 'i18n.commitEncoding=utf-8', 'commit', '-q', '-F', msgFile);
} catch (e) { stop(`提交失敗：${e.message}`, done); } finally { fs.rmSync(msgFile, { force: true }); }
done.push(`提交 ${git('rev-parse', '--short', 'HEAD')}「${tag}」`);
try { git('tag', tag); } catch (e) { stop(`打 tag 失敗：${e.message}`, done); }
done.push(`tag ${tag}`);
try { run('git', ['push', 'origin', 'main', tag], { show: true }); } catch { stop(`推送失敗。接著做：git push origin main ${tag}，再重跑 gh release create`, done); }
done.push(`推送 main 和 ${tag}`);
// --verify-tag：tag 一定要已經在 GitHub 上；不用 --target（帶了會讓 gh 回 422）
try {
  const url = run('gh', ['release', 'create', tag, '-R', repo, '--title', `AgentDesk ${tag}`, '--notes-file', notesFile, '--verify-tag']).trim();
  console.log(`\n✓ 發版完成：${url}`);
} catch (e) { stop(`建立 Release 失敗：${e.message}\n接著做：gh release create ${tag} -R ${repo} --title "AgentDesk ${tag}" --notes-file ${notesFile} --verify-tag`, done); }
