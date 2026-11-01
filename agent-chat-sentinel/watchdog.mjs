#!/usr/bin/env node
// 哨兵看护：读取哨兵 state 文件的 lastPollAt，超过 stale-ms 未更新且进程已不存在时，
// 用隐藏窗口重新拉起同 config 的哨兵。只负责"保持在线"，不发送任何聊天消息。
// 判定阈值须大于最长 worker 时间（worker 运行期间 check() 不刷新 lastPollAt）。
import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const options = {};
for (let index = 0; index < argv.length; index += 1) {
  const key = argv[index];
  const value = argv[index + 1];
  if (!key.startsWith('--') || value === undefined) { console.error('node watchdog.mjs --config FILE [--check-ms 5000] [--stale-ms 300000]'); process.exit(2); }
  options[key.slice(2)] = value;
  index += 1;
}
if (!options.config) { console.error('node watchdog.mjs --config FILE [--check-ms 5000] [--stale-ms 300000]'); process.exit(2); }
const configPath = resolve(options.config);
const checkMs = Number(options['check-ms'] ?? 5000);
const staleMs = Number(options['stale-ms'] ?? 300000);
const config = JSON.parse(await readFile(configPath, 'utf8'));
const statePath = resolve(config.state || resolve(config.projectDir || '.', 'data', 'sentinel-state.json'));
const logDir = resolve(config.logDir || resolve(config.projectDir || '.', 'logs'));
const logPath = resolve(logDir, 'watchdog.log');
const sentinelPath = resolve(config.projectDir || '.', 'sentinel.mjs');
await mkdir(logDir, { recursive: true });

async function log(line) {
  await appendFile(logPath, `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${line}\n`, 'utf8').catch(() => {});
}

function sentinelProcesses() {
  const result = spawnSync('powershell', ['-NoProfile', '-Command',
    `@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${configPath.replace(/'/g, "''")}*' }).Count`],
  { encoding: 'utf8', timeout: 20000, windowsHide: true });
  const count = Number(String(result.stdout || '').trim());
  return Number.isFinite(count) ? count : -1;
}

function startSentinel() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = resolve(logDir, `restart-${stamp}.out.log`);
  const err = resolve(logDir, `restart-${stamp}.err.log`);
  const script = `$p = Start-Process -FilePath '${process.execPath.replace(/'/g, "''")}' -ArgumentList '${sentinelPath}','--config','${configPath}' -WorkingDirectory '${resolve(config.projectDir || ".")}' -WindowStyle Hidden -PassThru -RedirectStandardOutput '${out}' -RedirectStandardError '${err}'; $p.Id`;
  const result = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  return String(result.stdout || '').trim();
}

let lastReport = 0;
let attempts = 0;
let nextAttemptAt = 0;
async function tick() {
  try {
    const info = await stat(statePath);
    const age = Date.now() - info.mtimeMs;
    if (age <= staleMs) { attempts = 0; return; }
    const count = sentinelProcesses();
    if (count > 0) {
      if (Date.now() - lastReport > staleMs) {
        lastReport = Date.now();
        await log(`state 已 ${Math.round(age / 1000)}s 未更新，但检测到 ${count} 个哨兵进程（可能在跑长任务或已卡死），不重启。`);
      }
      return;
    }
    if (Date.now() < nextAttemptAt) return;
    const pid = startSentinel();
    attempts += 1;
    nextAttemptAt = Date.now() + Math.min(600000, 30000 * 2 ** (attempts - 1));
    lastReport = Date.now();
    await log(`哨兵无进程且 state 已 ${Math.round(age / 1000)}s 未更新，第 ${attempts} 次重启 pid=${pid || '未知'}（config=${configPath}；下次最早 ${new Date(nextAttemptAt).toLocaleString('zh-CN', { hour12: false })}）。`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      const count = sentinelProcesses();
      if (count === 0 && Date.now() >= nextAttemptAt) {
        const pid = startSentinel();
        attempts += 1;
        nextAttemptAt = Date.now() + Math.min(600000, 30000 * 2 ** (attempts - 1));
        lastReport = Date.now();
        await log(`state 文件不存在且无哨兵进程，第 ${attempts} 次重启 pid=${pid || '未知'}（下次最早 ${new Date(nextAttemptAt).toLocaleString('zh-CN', { hour12: false })}）。`);
      }
      return;
    }
    await log(`检查失败：${error.message}`);
  }
}

await log(`看护启动：config=${configPath} state=${statePath} checkMs=${checkMs} staleMs=${staleMs} pid=${process.pid}`);
process.once('SIGINT', async () => { await log('看护退出'); process.exit(0); });
process.once('SIGTERM', async () => { await log('看护退出'); process.exit(0); });
for (;;) {
  await tick();
  await new Promise(resolve => setTimeout(resolve, checkMs));
}
