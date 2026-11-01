import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// Lock acquisition and final-path validation happen together in the native helper.
// Holding every ancestor prevents a successful check being invalidated by rename,
// junction replacement, or FSCTL_SET_REPARSE_POINT before SQLite opens a snapshot.
export async function createPreflightPathGuard() {
  if (process.platform !== 'win32') throw new Error('Windows native path locking is required for preflight.');
  const script = fileURLToPath(new URL('./preflight-path-guard.ps1', import.meta.url));
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: false, env: { ...process.env, TEMP: 'D:/OMP/temp', TMP: 'D:/OMP/temp' } });
  let failure, pending, errors = '', closing = false;
  const exited = new Promise(resolve => {
    child.once('error', error => { failure = error; pending?.reject(error); pending = undefined; resolve(); });
    child.once('exit', (code, signal) => {
      failure = new Error('Preflight path guard exited (' + (signal || code) + '). ' + errors);
      pending?.reject(failure); pending = undefined; resolve();
    });
  });
  child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-8000); });
  child.stdin.on('error', error => { failure = error; pending?.reject(error); pending = undefined; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    if (!pending) return;
    const request = pending; pending = undefined;
    try {
      const result = JSON.parse(line);
      if (result.ok !== true) throw new Error(result.error || 'Native path lock refused.');
      request.resolve();
    } catch (error) { request.reject(error); }
  });
  return {
    async request(operation) {
      if (failure || closing) throw failure || new Error('Preflight path guard is closed.');
      if (pending) throw new Error('Concurrent preflight path guard request.');
      let timer;
      try {
        await new Promise((resolve, reject) => {
          pending = { resolve, reject };
          timer = setTimeout(() => { failure = new Error('Preflight path guard timed out.'); pending?.reject(failure); pending = undefined; child.stdin.end(); }, 20000);
          child.stdin.write(JSON.stringify(operation) + '\n');
        });
      } finally { clearTimeout(timer); }
      if (failure) throw failure;
    },
    assertAlive() { if (failure || closing || child.exitCode !== null || child.signalCode !== null) throw failure || new Error('Preflight path guard is no longer holding locks.'); },
    async close() {
      closing = true;
      child.stdin.end();
      await exited;
      lines.close();
    }
  };
}
