// Independent sentinel supervisor. Snapshots are ephemeral and never replace source code.
// Usage: node sentinel-supervisor.mjs [--config PATH] [--interval MS] [--conversation ID]
// The sentinel is started without --after, preserving its own persisted recovery state.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(dir, 'sentinel.mjs');
const usage = 'node sentinel-supervisor.mjs [--config PATH] [--interval MS] [--conversation ID]';
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log(usage); process.exit(0); }
const childArgs = [];
for (let i = 0; i < args.length; i += 2) {
  if (!['--config', '--interval', '--conversation'].includes(args[i]) || !args[i + 1]) {
    console.error(usage); process.exit(2);
  }
  childArgs.push(args[i], args[i] === '--config' ? resolve(args[i + 1]) : args[i + 1]);
}
const snapshotRoot = resolve('D:/OMP/temp');
const pollMs = 1000, readyMs = 15000, stableMs = 5000, stopMs = 30000;
const log = (message) => console.error(`[supervisor ${new Date().toISOString()}] ${message}`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
await mkdir(snapshotRoot, { recursive: true });
const workDir = await mkdtemp(join(snapshotRoot, 'sentinel-supervisor-'));
let child = null, shuttingDown = false, sequence = 0;
let accepted = null, observed = null;

async function snapshot(knownHash = null) {
  const source = await readFile(sourcePath, 'utf8');
  const hash = createHash('sha256').update(source).digest('hex');
  if (hash === knownHash) return null;
  // Preserve sentinel's own script directory when the immutable copy runs in temp.
  // Relative imports in future sentinel versions require a different snapshot scheme.
  const marker = 'fileURLToPath(import.meta.url)';
  if (!source.includes(marker) || /(?:from\s*|import\s*\()\s*['"]\.{1,2}\//.test(source)) {
    throw new Error('无法安全快照：入口定位已改变或存在相对导入');
  }
  const code = `let supervisorStopPending = false;\nconst requestSupervisorStop = () => { if (process.listenerCount('SIGTERM')) process.emit('SIGTERM'); else supervisorStopPending = true; };\nprocess.on('message', (message) => { if (message === 'supervisor-stop') requestSupervisorStop(); });\nprocess.once('disconnect', requestSupervisorStop);\nprocess.on('newListener', (event) => { if (event === 'SIGTERM' && supervisorStopPending) { supervisorStopPending = false; queueMicrotask(requestSupervisorStop); } });\n` + source.replaceAll(marker, `fileURLToPath(${JSON.stringify(pathToFileURL(sourcePath).href)})`);
  const path = join(workDir, `sentinel-${++sequence}.mjs`);
  await writeFile(path, code, { flag: 'wx' });
  return { hash, path };
}
function checkSyntax(path) {
  return new Promise((done) => {
    const check = spawn(process.execPath, ['--check', path], { stdio: 'inherit', windowsHide: true });
    check.once('error', () => done(false));
    check.once('exit', (code) => done(code === 0));
  });
}
function launch(version) {
  const proc = spawn(process.execPath, [version.path, ...childArgs], { cwd: dir, windowsHide: true, stdio: ['ignore', 'inherit', 'pipe', 'ipc'] });
  const record = { proc, exited: false, ready: false, uncertain: false, drained: false, startedAt: Date.now(), exit: null };
  child = record;
  let buffer = '';
  proc.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    buffer = (buffer + chunk.toString()).slice(-8192);
    if (buffer.includes('结果不确定，已暂停')) record.uncertain = true;
  });
  proc.on('message', (message) => {
    if (!message || message.type !== 'sentinel-status') return;
    if (message.pendingMessageId !== null && message.pendingMessageId !== undefined) record.uncertain = true;
    if (message.event === 'error') record.uncertain = true;
    if (message.event === 'ready') record.ready = true;
    if (message.event === 'drained') record.drained = true;
  });
  record.exit = new Promise((done) => {
    proc.once('error', (error) => { log(`启动失败：${error.message}`); });
    proc.once('close', (code, signal) => { record.exited = true; log(`子进程退出 code=${code} signal=${signal}`); done(); });
  });
  return record;
}
async function stop(record) {
  if (!record) return true;
  if (record.exited) return record.drained && !record.uncertain;
  try { record.proc.send('supervisor-stop'); } catch (error) { log(`停止请求失败：${error.message}`); }
  let timer;
  await Promise.race([record.exit, new Promise((done) => { timer = setTimeout(done, stopMs); })]);
  clearTimeout(timer);
  if (!record.exited) { log('等待停止超时；不强杀、不启动替代进程，请人工检查'); return false; }
  if (!record.drained || record.uncertain) { log('子进程未确认安全排空或有待核对消息；停止自动交接，请人工核对状态'); return false; }
  return true;
}
async function startAndAssess(version) {
  const record = launch(version);
  const deadline = Date.now() + readyMs;
  while (!record.exited && !record.ready && !shuttingDown && Date.now() < deadline) await sleep(100);
  if (record.ready && !record.exited && !record.uncertain && !shuttingDown) {
    const stableUntil = Date.now() + stableMs;
    while (!record.exited && !shuttingDown && Date.now() < stableUntil) await sleep(100);
    if (!record.exited && !record.uncertain && !shuttingDown) return true;
  }
  if (!await stop(record)) throw new Error('子进程未确认安全排空或退出超时，停止自动管理');
  if (record.uncertain) throw new Error('子进程存在待核对消息，停止自动回退');
  return false;
}
process.once('SIGINT', () => { shuttingDown = true; });
process.once('SIGTERM', () => { shuttingDown = true; });
try {
  const initial = await snapshot();
  observed = initial.hash;
  if (!await checkSyntax(initial.path) || !await startAndAssess(initial)) throw new Error('初始版本启动或就绪失败');
  accepted = initial;
  log(`初始版本已就绪 ${accepted.hash}；就绪不证明消息处理成功`);
  while (!shuttingDown) {
    await sleep(pollMs);
    if (shuttingDown) break;
    if (child.exited) {
      throw new Error('子进程异常退出，停止自动重启；请核对锁、待处理状态及发送结果');
    }
    if (child.uncertain) throw new Error('子进程存在待核对消息，停止自动管理并排空');
    let next;
    try { next = await snapshot(observed); } catch (error) { log(`读取代码失败：${error.message}`); continue; }
    if (!next) continue;
    observed = next.hash;
    if (!await checkSyntax(next.path)) { log(`新版本语法检查失败，继续运行旧版 ${next.hash}`); continue; }
    log(`发现代码变更 ${next.hash}，停止旧版后尝试新版`);
    if (!await stop(child)) throw new Error('旧子进程未退出，停止自动管理');
    if (child.uncertain) throw new Error('旧版本存在待核对消息，停止自动交接');
    if (shuttingDown) break;
    if (await startAndAssess(next)) {
      accepted = next;
      // Retain snapshots for investigation and explicit recovery.
      log(`新版本通过启动观察 ${next.hash}`);
    } else if (!shuttingDown) {
      throw new Error('新版本启动失败；状态兼容性未证明，停止自动回退并保留快照供人工核对');
    }
  }
} catch (error) {
  log(error.message);
  process.exitCode = 1;
} finally {
  if (!await stop(child)) process.exitCode = 1;
  // User requested that temporary artifacts be retained.
}
