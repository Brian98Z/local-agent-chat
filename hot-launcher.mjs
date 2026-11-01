// Versioned native client deployment. Never writes the project executable or data.
import { copyFileSync, cpSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { createPreflightPathGuard } from './preflight-path-guard.mjs';

const source = dirname(fileURLToPath(import.meta.url));
const files = ['Launcher.cs', 'ChatForm.cs', 'launcher-host.mjs', 'server.mjs', 'scoring.mjs', 'group-tools.mjs', 'vote-game-tools.mjs', 'erc20-tools.mjs', 'MCP.md', 'native-preflight.ps1', 'preflight-path-guard.mjs', 'preflight-path-guard.ps1', 'package.json', 'launcher.manifest', 'chat-icon.ico'];
const usage = 'node hot-launcher.mjs start|bootstrap --store PATH --data-dir PATH [--port PORT] | install --store PATH | preflight --store PATH --data-dir PATH --sanitized-test-data yes | run --store PATH --data-dir PATH [--port PORT]';
function fail(message) { throw new Error(message + '\n' + usage); }
function parse(args) {
  const command = args.shift(), options = {};
  while (args.length) {
    const key = args.shift();
    if (!['--store', '--data-dir', '--port', '--sanitized-test-data'].includes(key) || !args.length || Object.hasOwn(options, key)) fail('Invalid argument: ' + key);
    options[key] = args.shift();
  }
  if (!['install', 'preflight', 'run', 'start', 'bootstrap'].includes(command) || !options['--store']) fail('A command and --store are required.');
  if (command === 'install' && (options['--data-dir'] || options['--port'])) fail('Install accepts only --store.');
  if (command === 'preflight' && options['--port']) fail('Preflight does not accept --port.');
  if (command !== 'install' && !options['--data-dir']) fail('Preflight, run, and start/bootstrap require an explicit --data-dir.');
  if (options['--sanitized-test-data'] && (command !== 'preflight' || options['--sanitized-test-data'] !== 'yes')) fail('Only preflight accepts --sanitized-test-data yes.');
  if (command === 'preflight' && options['--sanitized-test-data'] !== 'yes') fail('Preflight requires an explicitly sanitized isolated test database: --sanitized-test-data yes. Never supply production data.');
  return { command, options };
}
function inside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && rel !== '..' && !resolve(rel).startsWith('\\\\') && !/^[A-Za-z]:/.test(rel));
}
function atomicJson(path, value) {
  const tmp = path + '.' + randomUUID() + '.tmp';
  writeFileSync(tmp, JSON.stringify(value) + '\n', { flag: 'wx' });
  renameSync(tmp, path);
}
function publishInitialVersion(store, id) {
  const target = join(store, 'current.json');
  const pending = join(store, 'initial-' + randomUUID() + '.json');
  writeFileSync(pending, JSON.stringify({ version: id }) + '\n', { flag: 'wx' });
  // Link exposes a complete file atomically and refuses an existing target.
  // Retain the proposal as evidence until the final task cleanup.
  try { linkSync(pending, target); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('An initial version already exists; refusing to replace it.');
    throw error;
  }
}
function digest(root) {
  const hash = createHash('sha256');
  function add(path, name) {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) add(join(path, entry), name + '/' + entry);
    } else { hash.update(name + '\0'); hash.update(readFileSync(path)); hash.update('\0'); }
  }
  for (const name of [...files, 'public']) add(join(root, name), name);
  return hash.digest('hex');
}
function version(store, name) {
  const id = JSON.parse(readFileSync(join(store, name + '.json'), 'utf8')).version;
  if (typeof id !== 'string' || !/^[0-9TZ-]+-[0-9a-f-]{36}$/.test(id) || basename(id) !== id) throw new Error('Invalid version pointer.');
  return id;
}
function waitExit(child) {
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolvePromise({ code, signal }));
  });
}
function candidateDigest(store, id) {
  const root = join(store, 'versions', id);
  return createHash('sha256').update(digest(root)).update(readFileSync(join(root, 'LocalAgentChat.exe'))).digest('hex');
}
async function install(store) {
  if (process.platform !== 'win32') throw new Error('Windows is required.');
  if (inside(source, store) || inside(store, source)) throw new Error('Store must be separate from the project tree.');
  const compiler = join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  if (!existsSync(compiler)) throw new Error('Missing compiler: ' + compiler);
  const before = digest(source), versions = join(store, 'versions');
  mkdirSync(versions, { recursive: true });
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID(), target = join(versions, id);
  mkdirSync(target);
  for (const name of files) copyFileSync(join(source, name), join(target, name));
  cpSync(join(source, 'public'), join(target, 'public'), { recursive: true, errorOnExist: true, force: false });
  if (digest(target) !== before || digest(source) !== before) throw new Error('Source changed during snapshot; candidate discarded.');
  const wpf = join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/WPF');
  const child = spawn(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/codepage:65001', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Net.Http.dll', '/r:System.Web.Extensions.dll', '/r:System.Xaml.dll', '/r:' + join(wpf, 'WindowsBase.dll'), '/r:' + join(wpf, 'PresentationCore.dll'), '/r:' + join(wpf, 'PresentationFramework.dll'), '/r:' + join(wpf, 'WindowsFormsIntegration.dll'), '/win32manifest:' + join(target, 'launcher.manifest'), '/win32icon:' + join(target, 'chat-icon.ico'), '/out:' + join(target, 'LocalAgentChat.exe'), join(target, 'Launcher.cs'), join(target, 'ChatForm.cs')], { cwd: target, stdio: 'inherit', windowsHide: true });
  const result = await waitExit(child);
  if (result.code !== 0) throw new Error('Compilation failed; active version unchanged.');
  if (digest(source) !== before) throw new Error('Source changed during build; candidate discarded.');
  atomicJson(join(store, 'candidate.json'), { version: id });
  console.log('Built candidate ' + id);
  return id;
}
async function preflight(store, data, expected) {
  data = resolve(data);
  if (!inside(resolve('D:/OMP/temp'), data)) throw new Error('Preflight accepts only an explicitly sanitized test database under D:/OMP/temp.');
  const id = version(store, 'candidate');
  if (expected && id !== expected) throw new Error('Candidate changed before preflight.');
  const target = join(store, 'versions', id);
  if (!existsSync(join(target, 'LocalAgentChat.exe'))) throw new Error('Candidate executable missing.');
  if (inside(store, data) || inside(data, store)) throw new Error('Data and version store must be separate.');
  const verified = candidateDigest(store, id);
  const guard = await createPreflightPathGuard();
  try {
    // No source SQLite open precedes the native locks. The guard rejects all
    // reparse components, hard links and live writers while holding every handle.
    await guard.request({ op: 'source', root: resolve('D:/OMP/temp'), data });
    const scratch = join('D:/OMP/temp', 'hot-launcher-preflight-' + randomUUID());
    await guard.request({ op: 'mkdir', path: scratch });
    const captured = join(scratch, 'source');
    await guard.request({ op: 'mkdir', path: captured });
    // Read source bytes through the verified handles, not a re-opened pathname.
    // This also avoids ever opening a newly injected source WAL/SHM pathname.
    await guard.request({ op: 'snapshot', source: data, destination: captured });
    const nativeData = join(scratch, 'native-data');
    await guard.request({ op: 'mkdir', path: nativeData });
  const native = spawn(join(target, 'LocalAgentChat.exe'), ['--data-dir', nativeData, '--port', '0'], { cwd: target, stdio: 'ignore', windowsHide: false });
  const nativeExit = waitExit(native);
  // Observe only the child PID; no handoff files or unauthenticated control channel.
  // A checked-in script keeps the diagnostic operation inspectable; no encoded payload.
  const observerScript = join(target, 'native-preflight.ps1');
  try {
    const observer = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', observerScript, '-ClientProcessId', String(native.pid)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
    let errors = ''; observer.stderr.on('data', chunk => { errors = (errors + chunk).slice(-8000); }); observer.stdout.on('data', chunk => { errors = (errors + chunk).slice(-8000); });
    const observed = await waitExit(observer);
    if (observed.code !== 0) throw new Error(errors || 'Native observation failed.');
    const exit = await nativeExit;
    if (exit.code !== 0) throw new Error('Native client exited unsuccessfully.');
  } catch (error) {
    if (native.exitCode === null && native.signalCode === null) native.kill();
    await nativeExit.catch(() => {});
    throw new Error('Isolated native preflight failed: ' + error.message);
  }
  const copyDir = join(scratch, 'data');
  await guard.request({ op: 'mkdir', path: copyDir });
  const copyPath = join(copyDir, 'chat.sqlite');
  guard.assertAlive();
  const original = new DatabaseSync(join(captured, 'chat.sqlite'), { readOnly: true });
  try { await backup(original, copyPath); } finally { original.close(); }
  guard.assertAlive();
  const schema = () => {
    const db = new DatabaseSync(copyPath, { readOnly: true });
    try {
      const integrity = db.prepare('PRAGMA integrity_check').all();
      if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') throw new Error('Snapshot database integrity check failed.');
      return JSON.stringify({
        userVersion: db.prepare('PRAGMA user_version').get(),
        applicationId: db.prepare('PRAGMA application_id').get(),
        objects: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
      });
    } finally { db.close(); }
  };
  const before = schema();
  for (let attempt = 0; attempt < 2; attempt++) {
    const child = spawn(process.execPath, [join(target, 'launcher-host.mjs'), '--data-dir', copyDir, '--port', '0'], { cwd: target, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = '', errors = '', ready = false, timedOut = false;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-16000); if (!ready && output.includes('Admin token: ') && output.includes('Listening: http://127.0.0.1:')) { ready = true; child.stdin.end('stop\n'); } });
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-8000); });
    child.stdin.on('error', () => {});
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 20000);
    let result;
    try { result = await waitExit(child); } finally { clearTimeout(timer); }
    if (timedOut || !ready || result.code !== 0) throw new Error('Candidate snapshot preflight failed: ' + (timedOut ? 'timeout' : errors));
    if (schema() !== before) throw new Error('Candidate changes database schema or version; automatic activation is refused.');
  }
  if (version(store, 'candidate') !== id || candidateDigest(store, id) !== verified) throw new Error('Candidate changed during preflight.');
  guard.assertAlive();
  atomicJson(join(scratch, 'result.json'), { version: id, candidateDigest: verified, sourceDataDir: data, sourcePathHandlesLocked: true, sourceSnapshotFromHandles: true, snapshotSchemaUnchanged: true, at: new Date().toISOString() });
  console.log('Candidate passed isolated native and snapshot database preflight: ' + id);
  return id;
  } finally { await guard.close(); }
}
const delay = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
const serviceFiles = ['launcher-host.mjs', 'server.mjs', 'scoring.mjs', 'group-tools.mjs', 'vote-game-tools.mjs', 'erc20-tools.mjs', 'package.json'];
function serviceDigest(root) {
  const hash = createHash('sha256');
  function add(path, name) {
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path).sort()) add(join(path, entry), name + '/' + entry);
    } else { hash.update(name + '\0'); hash.update(readFileSync(path)); hash.update('\0'); }
  }
  for (const name of [...serviceFiles, 'public']) add(join(root, name), name);
  return hash.digest('hex');
}
function controlledClient(target, data, port, state) {
  const args = ['--hot-control', '--data-dir', data];
  if (port) args.push('--port', port);
  // libuv puts non-detached Windows children in its kill-on-close job. The
  // window must outlive a crashed controller to recover its in-memory draft.
  // Keep the control pipes, but let the launcher own its service-only lifetime.
  const child = spawn(join(target, 'LocalAgentChat.exe'), args, { cwd: target, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: false, detached: true });
  const messages = [], waiters = [];
  let ended = false, protocolError = null, reason = 'client exited', buffer = '', errors = '';
  const exit = new Promise(resolvePromise => {
    child.once('error', error => { reason = error.message; });
    child.once('close', (code, signal) => {
      ended = true; reason += ' (' + (signal || code) + ') ' + errors;
      while (waiters.length) waiters.shift().reject(new Error(reason));
      resolvePromise({ code, signal });
    });
  });
  child.stdin.on('error', () => {});
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-8000); });
  child.stdout.setEncoding('utf8');
  function badProtocol(message) {
    if (protocolError) return;
    protocolError = new Error(message);
    while (waiters.length) waiters.shift().reject(protocolError);
    child.stdout.pause();
  }
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 8 * 1024 * 1024) { badProtocol('Control message too large'); return; }
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        if (waiters.length) waiters.shift().resolve(message); else messages.push(message);
      } catch { badProtocol('Invalid control message'); return; }
    }
  });
  function receive(timeout = 30000) {
    if (messages.length) return Promise.resolve(messages.shift());
    if (protocolError) return Promise.reject(protocolError);
    if (ended) return Promise.reject(new Error(reason));
    return new Promise((resolvePromise, reject) => {
      const waiter = { resolve: value => { clearTimeout(timer); resolvePromise(value); }, reject: error => { clearTimeout(timer); reject(error); } };
      const timer = setTimeout(() => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); reject(new Error('Control response timed out')); }, timeout);
      waiters.push(waiter);
    });
  }
  function send(message) {
    if (ended || child.stdin.destroyed) throw new Error(reason);
    child.stdin.write(JSON.stringify(message) + '\n', 'utf8');
  }
  send({ type: 'start', requestId: state?.requestId ?? null, state });
  return { child, exit, receive, send, get ended() { return ended; } };
}
async function requireReady(client) {
  const response = await client.receive();
  if (response?.type !== 'ready') throw new Error('Client did not become ready; control response rejected.');
}
async function stopClient(client) {
  if (!client.ended) client.send({ type: 'shutdown' });
  const result = await Promise.race([client.exit, delay(15000).then(() => null)]);
  if (!result) throw new Error('Client did not exit; refusing to start another service.');
  return result;
}
async function isolatedDatabase(target) {
  const dir = join('D:/OMP/temp/hot-launcher-preflight', randomUUID(), 'seed');
  mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, [join(target, 'launcher-host.mjs'), '--data-dir', dir, '--port', '0'], { cwd: target, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let output = '', errors = '', ready = false;
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-16000); if (!ready && output.includes('Admin token: ') && output.includes('Listening: http://127.0.0.1:')) { ready = true; child.stdin.end('stop\n'); } });
  child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-8000); });
  const timer = setTimeout(() => child.kill(), 20000);
  let result;
  try { result = await waitExit(child); } finally { clearTimeout(timer); }
  if (!ready || result.code !== 0) throw new Error('Cannot initialize isolated test database: ' + errors);
  return dir;
}
async function start(store, options) {
  const data = resolve(options['--data-dir']);
  if (inside(store, data) || inside(data, store)) throw new Error('Data and version store must be separate.');
  if (!existsSync(join(store, 'current.json'))) {
    const id = await install(store), target = join(store, 'versions', id);
    const testData = await isolatedDatabase(target);
    const verified = candidateDigest(store, id);
    await preflight(store, testData, id);
    if (candidateDigest(store, id) !== verified || version(store, 'candidate') !== id) throw new Error('Candidate changed before initial activation.');
    publishInitialVersion(store, id);
    console.log('Initial version activated after synthetic database preflight: ' + id);
  }
  await run(store, options);
}
async function run(store, options) {
  const data = resolve(options['--data-dir']);
  if (inside(store, data) || inside(data, store)) throw new Error('Data and version store must be separate.');
  // Legacy file-based prototypes may have left drafts here. This is only a
  // guard for those old files, not a crash journal for the current pipe protocol.
  const handoffs = join(store, 'handoffs');
  if (existsSync(handoffs)) {
    const pending = readdirSync(handoffs).filter(name => existsSync(join(handoffs, name, 'state.json')) && existsSync(join(handoffs, name, 'request.json')));
    if (pending.length) throw new Error('Existing handoff state requires manual recovery: ' + pending.join(', '));
  }
  let id = version(store, 'current'), target = join(store, 'versions', id);
  let client = controlledClient(target, data, options['--port'], null);
  try { await requireReady(client); } catch (error) { await stopClient(client); throw error; }
  console.log('Launched and connected ' + id + ' (PID ' + client.child.pid + ').');
  let seen = digest(source);
  if (seen !== digest(target)) seen = '';
  while (!client.ended) {
    await delay(2000);
    if (client.ended) break;
    let fingerprint;
    try { fingerprint = digest(source); } catch (error) { console.error('Source scan failed: ' + error.message); continue; }
    if (fingerprint === seen) continue;
    seen = fingerprint;
    try {
      const nextId = await install(store), nextTarget = join(store, 'versions', nextId);
      if (serviceDigest(target) !== serviceDigest(nextTarget)) {
        console.error('Candidate staged; service or public code changed, so automatic handoff is refused.');
        continue;
      }
      const testData = await isolatedDatabase(target);
      const verified = candidateDigest(store, nextId);
      await preflight(store, testData, nextId);
      if (candidateDigest(store, nextId) !== verified || version(store, 'candidate') !== nextId || serviceDigest(target) !== serviceDigest(nextTarget)) throw new Error('Candidate changed before handoff.');
      const requestId = randomUUID();
      let prepared = false, prepareSent = false, committed = false, replacement = null, phase = 'prepare';
      try {
        client.send({ type: 'prepare', requestId });
        prepareSent = true;
        const response = await client.receive();
        if (response?.type !== 'prepared' || response.requestId !== requestId || !response.state || response.state.requestId !== requestId) throw new Error('Client refused handoff; control response rejected.');
        prepared = true;
        if (candidateDigest(store, nextId) !== verified || serviceDigest(target) !== serviceDigest(nextTarget)) throw new Error('Candidate changed during handoff.');
        phase = 'stop old service';
        client.send({ type: 'stop-service', requestId });
        const stoppedResponse = await client.receive();
        if (stoppedResponse?.type !== 'service-stopped' || stoppedResponse.requestId !== requestId) throw new Error('Old service did not stop; control response rejected.');
        // Keep the old window alive and frozen until the replacement is ready.
        phase = 'start replacement';
        replacement = controlledClient(nextTarget, data, options['--port'], response.state);
        await requireReady(replacement);
        if (candidateDigest(store, nextId) !== verified || serviceDigest(target) !== serviceDigest(nextTarget)) throw new Error('Candidate changed before activation.');
        phase = 'commit old window';
        client.send({ type: 'commit', requestId });
        committed = true;
        const oldExit = await Promise.race([client.exit, delay(15000).then(() => null)]);
        if (!oldExit) throw new Error('Old window did not exit after commit; both windows retain the draft.');
        phase = 'publish version';
        atomicJson(join(store, 'current.json'), { version: nextId });
        phase = 'activate replacement';
        replacement.send({ type: 'activate', requestId });
        const activated = await replacement.receive();
        if (activated?.type !== 'activated' || activated.requestId !== requestId) throw new Error('Replacement activation failed; control response rejected.');
        client = replacement; replacement = null; id = nextId; target = nextTarget;
        console.log('Activated ' + id + ' (PID ' + client.child.pid + ').');
      } catch (error) {
        console.error('Handoff failed during ' + phase + ': ' + error.message);
        if (committed) {
          if (replacement) replacement.child.stdin.end();
          client.child.stdin.end();
          throw Object.assign(new Error('Commit outcome uncertain; windows retained for manual recovery: ' + error.message), { fatal: true });
        }
        if (replacement) {
          if (!replacement.ended) replacement.send({ type: 'shutdown', requestId });
          const exit = await Promise.race([replacement.exit, delay(15000).then(() => null)]);
          if (!exit) {
            replacement.child.stdin.end(); client.child.stdin.end();
            throw Object.assign(new Error('Candidate did not stop; windows retained for manual recovery: ' + error.message), { fatal: true });
          }
        }
        if (prepared) {
          try {
            client.send({ type: 'abort', requestId });
            const aborted = await client.receive();
            if (aborted?.type !== 'aborted' || aborted.requestId !== requestId) throw new Error('Old window could not resume; control response rejected.');
            console.log('Previous window resumed after failed handoff.');
          } catch (abortError) {
            client.child.stdin.end();
            throw Object.assign(new Error('Abort failed; controller disconnected for old-window recovery: ' + abortError.message), { fatal: true });
          }
        } else if (prepareSent) {
          client.child.stdin.end();
          throw Object.assign(new Error('Prepare outcome uncertain; controller disconnected so the old window can recover safely.'), { fatal: true });
        }
        throw error;
      }
    } catch (error) { console.error('Automatic update stopped: ' + error.message); if (error.fatal) { client.child.stdin.end(); client.child.stdout.destroy(); client.child.stderr.destroy(); client.child.unref(); return; } }
  }
  await client.exit;
}
try {
  const { command, options } = parse(process.argv.slice(2));
  const store = resolve(options['--store']);
  if (command === 'install') await install(store);
  else if (command === 'preflight') {
    const id = await preflight(store, options['--data-dir']);
    publishInitialVersion(store, id);
    console.log('Initial version activated after snapshot preflight; behavioral rollback compatibility is not established.');
  } else if (command === 'start' || command === 'bootstrap') await start(store, options);
  else await run(store, options);
} catch (error) { console.error(error.message); process.exitCode = 1; }
