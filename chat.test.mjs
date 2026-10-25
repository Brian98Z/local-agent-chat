import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { get } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

const root = fileURLToPath(new URL('.', import.meta.url));
const tempRoot = resolve(root, '../../temp/local-agent-chat');
await mkdir(tempRoot, { recursive: true });
const dir = await mkdtemp(join(tempRoot, 'contract-'));
const secret = () => randomBytes(32).toString('hex');

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}
async function start(dataDir = dir, port = 0) {
  const child = spawn(process.execPath, [join(root, 'server.mjs'), '--port', String(port), '--data-dir', dataDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stderr.on('data', bytes => { err += bytes; });
  const ready = new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`Startup timed out: ${err}`)), 10000);
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${err}`)); });
    child.stdout.on('data', bytes => {
      out += bytes;
      const url = out.match(/Listening: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      const admin = out.match(/Admin token: ([a-f0-9]{64})/)?.[1];
      if (url && admin) { clearTimeout(timer); resolveReady({ child, url, admin }); }
    });
  });
  try { return await ready; } catch (error) { await stop(child); throw error; }
}
function client(server, token) {
  return async (path, body, status = body !== undefined && ['/api/join', '/api/messages', '/api/tasks'].includes(path) ? 201 : 200, headers = {}) => {
    const response = await fetch(server.url + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    assert.equal(response.status, status, `${path}: ${JSON.stringify(result)}`);
    return result;
  };
}
function bridge(server, name, identity) {
  const child = spawn(process.execPath, [join(root, 'mcp.mjs'), '--name', name, '--identity', identity, '--url', server.url], { stdio: ['pipe', 'pipe', 'pipe'] });
  let seq = 0, buffer = '', diagnostics = '';
  const waiting = new Map();
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const response = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const job = waiting.get(response.id);
      if (job) { waiting.delete(response.id); clearTimeout(job.timer); job.resolve(response); }
    }
  });
  child.on('exit', () => { for (const job of waiting.values()) { clearTimeout(job.timer); job.reject(new Error(`Bridge exited: ${diagnostics}`)); } waiting.clear(); });
  const rpc = (method, params = {}) => new Promise((resolveReply, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`MCP timeout: ${method}; ${diagnostics}`)); }, 15000);
    waiting.set(id, { resolve: resolveReply, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { child, rpc, call: (name, args = {}) => rpc('tools/call', { name, arguments: args }) };
}

test('real HTTP and MCP lifecycle: approval, private visibility, ownership, revocation, restart', { timeout: 60000 }, async t => {
  let server = await start();
  t.after(async () => stop(server.child));
  let admin = client(server, server.admin);
  const navigationHeaders = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  const navigationStatus = await new Promise((resolveStatus, reject) => {
    get(server.url + '/', { headers: navigationHeaders }, response => {
      response.resume();
      resolveStatus(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(navigationStatus, 200, 'Public administrator login page must open from external links');
  await admin('/api/admin/state', undefined, 403, navigationHeaders);
  const aToken = secret(), bToken = secret(), cToken = secret();
  const a = client(server, aToken), b = client(server, bToken), c = client(server, cToken);
  await a('/api/join', { name: 'Alpha', token: aToken }, 403);
  await admin('/api/admin/registration', { open: true });
  const aid = (await a('/api/join', { name: 'Alpha', token: aToken })).agent.id;
  const bid = (await b('/api/join', { name: 'Beta', token: bToken })).agent.id;
  const cid = (await c('/api/join', { name: 'Gamma', token: cToken })).agent.id;
  await client(server)('/api/join', { name: 'alpha', token: secret() }, 409);
  await a('/api/messages', undefined, 403);
  await a('/api/admin/state', undefined, 403);
  assert.equal((await a('/api/me')).agent.status, 'pending');
  for (const agentId of [aid, bid, cid]) await admin(`/api/admin/agents/${agentId}`, { status: 'active' });
  await a('/api/messages', { text: 'broadcast' });
  await a('/api/messages', { text: 'private AB', to: bid });
  assert.deepEqual((await c('/api/messages')).messages.map(m => m.text), ['broadcast']);
  assert.deepEqual((await b('/api/messages')).messages.map(m => m.text), ['broadcast', 'private AB']);
  const page = await a('/api/messages?after=0&limit=1');
  assert.equal(page.messages[0].text, 'broadcast');
  assert.equal((await a(`/api/messages?after=${page.cursor}`)).messages[0].text, 'private AB');
  const empty = await c(`/api/messages?after=${page.cursor}`);
  assert.equal(empty.cursor, page.cursor);
  await a('/api/messages', { text: '  ' }, 400);
  await a('/api/messages', { text: 'x'.repeat(8001) }, 400);
  await a('/api/messages?limit=201', undefined, 400);
  await a('/api/messages', undefined, 403, { Origin: 'http://evil.invalid' });
  const hostStatus = await new Promise((resolveStatus, reject) => {
    get(server.url + '/api/messages', { headers: { Host: 'evil.invalid', Authorization: `Bearer ${aToken}` } }, response => {
      response.resume();
      resolveStatus(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(hostStatus, 403);
  const task = (await a('/api/tasks', { title: 'Atomic claim', description: 'Only one worker owns execution.' })).task;
  const outcomes = await Promise.all([aToken, bToken].map(token => fetch(`${server.url}/api/tasks/${task.id}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'claim' }) })));
  assert.deepEqual(outcomes.map(r => r.status).sort(), [200, 409]);
  const owner = (await a('/api/tasks')).tasks.find(row => row.id === task.id).owner;
  const outsider = owner === aid ? b : a;
  await outsider(`/api/tasks/${task.id}`, { action: 'complete' }, 403);
  await admin(`/api/admin/agents/${owner}`, { status: 'paused' });
  assert.equal((await admin('/api/tasks')).tasks.find(row => row.id === task.id).status, 'open');
  await client(server, owner === aid ? aToken : bToken)('/api/tasks', undefined, 403);
  await admin(`/api/admin/agents/${owner}`, { status: 'active' });
  await a(`/api/tasks/${task.id}`, { action: 'claim' });
  await a(`/api/tasks/${task.id}`, { action: 'complete', note: 'Verified' });
  await a(`/api/tasks/${task.id}`, { action: 'reopen' }, 403);
  await admin(`/api/tasks/${task.id}`, { action: 'reopen' });
  assert.equal((await a('/api/tasks')).tasks.find(row => row.id === task.id).owner, null);
  await admin(`/api/admin/agents/${cid}`, { status: 'revoked' });
  await admin(`/api/admin/agents/${cid}`, { status: 'active' }, 409);
  assert.equal((await c('/api/join', { name: 'Changed', token: cToken }, 200)).agent.status, 'revoked');
  await c('/api/messages', undefined, 403);
  const identity = join(dir, 'mcp-identity.key');
  const mcp = bridge(server, 'MCP Worker', identity);
  t.after(async () => stop(mcp.child));
  assert.equal((await mcp.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'contract-test', version: '1' } })).result.protocolVersion, '2025-03-26');
  const joinResult = await mcp.call('chat_join');
  assert.equal(joinResult.result.isError, undefined);
  const mid = JSON.parse(joinResult.result.content[0].text).agent.id;
  assert.equal((await mcp.call('chat_send', { text: 'blocked' })).result.isError, true);
  await admin(`/api/admin/agents/${mid}`, { status: 'active' });
  assert.equal((await mcp.call('chat_send', { text: 'from MCP', to: aid })).result.isError, undefined);
  assert.equal((await a('/api/messages')).messages.at(-1).text, 'from MCP');
  assert.equal((await mcp.call('chat_send', { text: 'bad', injected: true })).result.isError, true);
  const mtask = JSON.parse((await mcp.call('task_create', { title: 'MCP task' })).result.content[0].text).task;
  await mcp.call('task_claim', { id: mtask.id });
  await mcp.call('task_release', { id: mtask.id });
  await mcp.call('task_claim', { id: mtask.id });
  const done = await mcp.call('task_complete', { id: mtask.id, note: 'MCP verified' });
  assert.equal(JSON.parse(done.result.content[0].text).task.status, 'done');
  const savedToken = (await readFile(identity, 'utf8')).trim();
  const state = JSON.stringify(await admin('/api/admin/state'));
  for (const token of [aToken, bToken, cToken, savedToken, server.admin]) assert.equal(state.includes(token), false);
  await assert.rejects(start(), /Server exited/);
  const oldAdmin = server.admin;
  await stop(server.child);
  assert.equal((await mcp.call('chat_status')).result.isError, true);
  await stop(mcp.child);
  server = await start(); admin = client(server, server.admin);
  assert.notEqual(server.admin, oldAdmin);
  const restored = await admin('/api/admin/state');
  assert.equal(restored.registrationOpen, false);
  assert.equal(restored.agents.find(row => row.id === cid).status, 'revoked');
  assert.equal(restored.tasks.find(row => row.id === mtask.id).status, 'done');
  assert.ok(restored.messages.some(row => row.text === 'from MCP'));
  await client(server, oldAdmin)('/api/admin/state', undefined, 401);
  const restoredBridge = bridge(server, 'MCP Worker', identity);
  t.after(async () => stop(restoredBridge.child));
  assert.equal(JSON.parse((await restoredBridge.call('chat_join')).result.content[0].text).agent.id, mid);
});

test('conversations preserve history, isolate replies, wake readers and resume selection', { timeout: 60000 }, async t => {
  const data = await mkdtemp(join(tempRoot, 'conversations-'));
  let server = await start(data);
  t.after(async () => stop(server.child));
  let admin = client(server, server.admin);
  await admin('/api/admin/registration', { open: true });
  const token = secret();
  let agent = client(server, token);
  const identity = (await agent('/api/join', { name: '对话验证', token })).agent;
  await admin(`/api/admin/agents/${identity.id}`, { status: 'active' });
  const first = (await admin('/api/conversations')).activeConversationId;
  const old = (await agent('/api/messages', { text: '旧对话原文', conversationId: first })).message;
  const task = (await agent('/api/tasks', { title: '旧任务', conversationId: first })).task;
  await agent('/api/admin/conversations', {}, 403);
  const next = (await admin('/api/admin/conversations', { title: '新一轮' }, 201)).conversation;
  assert.notEqual(next.id, first);
  assert.deepEqual((await agent('/api/messages')).messages, []);
  assert.deepEqual((await agent('/api/tasks')).tasks, []);
  await agent('/api/messages', { text: '延迟旧回复', conversationId: first }, 409);
  await agent(`/api/tasks/${task.id}`, { action: 'claim' }, 409);
  assert.equal((await agent(`/api/messages?conversationId=${first}`)).messages[0].text, '旧对话原文');
  const changed = await agent(`/api/events?conversationId=${first}&after=${old.id}&timeout=1`);
  assert.equal(changed.reason, 'conversation_changed');
  assert.equal(changed.conversationId, next.id);
  assert.equal(changed.cursor, 0);
  const waiting = agent(`/api/events?conversationId=${next.id}&after=0&timeout=5000`);
  const fresh = (await admin('/api/messages', { text: '新任务', conversationId: next.id })).message;
  const event = await waiting;
  assert.equal(event.reason, 'messages');
  assert.deepEqual(event.messages.map(m => m.text), ['新任务']);
  assert.equal(event.cursor, fresh.id);
  const idle = await agent(`/api/events?conversationId=${next.id}&after=${fresh.id}&timeout=20`);
  assert.equal(idle.reason, 'timeout');
  const otherToken = secret();
  const other = client(server, otherToken);
  const otherId = (await other('/api/join', { name: '私聊隔离验证', token: otherToken })).agent.id;
  await admin(`/api/admin/agents/${otherId}`, { status: 'active' });
  const invisibleWait = other(`/api/events?conversationId=${next.id}&after=${fresh.id}&timeout=100`);
  await admin('/api/messages', { text: '仅指定成员可见', to: identity.id, conversationId: next.id });
  const hidden = await invisibleWait;
  assert.equal(hidden.reason, 'timeout');
  assert.deepEqual(hidden.messages, []);
  assert.equal(hidden.cursor, fresh.id);
  const pauseCursor = (await agent('/api/messages')).cursor;
  const pausedWait = agent(`/api/events?conversationId=${next.id}&after=${pauseCursor}&timeout=5000`, undefined, 403);
  await admin(`/api/admin/agents/${identity.id}`, { status: 'paused' });
  await pausedWait;
  await admin(`/api/admin/agents/${identity.id}`, { status: 'active' });
  await admin(`/api/admin/conversations/${first}/activate`, {});
  assert.equal((await admin('/api/admin/state')).messages[0].text, '旧对话原文');
  await stop(server.child);
  server = await start(data); admin = client(server, server.admin); agent = client(server, token);
  assert.equal((await admin('/api/admin/state')).activeConversationId, first);
  assert.equal((await agent('/api/messages')).messages[0].text, '旧对话原文');
  assert.equal((await agent('/api/me')).agent.status, 'active');
  assert.equal((await admin('/api/admin/state')).registrationOpen, false);
  const mcp = bridge(server, '等待验证', join(data, 'wait.key'));
  t.after(async () => stop(mcp.child));
  await admin('/api/admin/registration', { open: true });
  const mid = JSON.parse((await mcp.call('chat_join')).result.content[0].text).agent.id;
  await admin(`/api/admin/agents/${mid}`, { status: 'active' });
  const conversations = JSON.parse((await mcp.call('chat_conversations')).result.content[0].text);
  assert.equal(conversations.activeConversationId, first);
  const held = mcp.call('chat_wait', { conversationId: first, after: old.id, timeout: 5000 });
  await admin('/api/messages', { text: '唤醒等待者', conversationId: first });
  assert.equal(JSON.parse((await held).result.content[0].text).messages[0].text, '唤醒等待者');
  const readNext = JSON.parse((await mcp.call('chat_read', { conversationId: next.id })).result.content[0].text);
  assert.equal(readNext.messages[0].text, '新任务');
  assert.equal((await mcp.call('chat_send', { text: '错误跨对话', conversationId: next.id })).result.isError, true);
  const port = Number(new URL(server.url).port);
  await stop(server.child);
  const reconnecting = mcp.call('chat_wait', { conversationId: first, after: 0, timeout: 1000 });
  await new Promise(resolve => setTimeout(resolve, 200));
  server = await start(data, port);
  const recovered = JSON.parse((await reconnecting).result.content[0].text);
  assert.ok(recovered.reconnectAttempts >= 1);
  assert.equal(recovered.messages[0].text, '旧对话原文');
});

test('legacy messages and tasks migrate without loss and migration is repeatable', { timeout: 20000 }, async t => {
  const data = await mkdtemp(join(tempRoot, 'legacy-'));
  const db = new DatabaseSync(join(data, 'chat.sqlite'));
  db.exec(`CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,"from" TEXT NOT NULL,"to" TEXT,text TEXT NOT NULL,createdAt TEXT NOT NULL);
    CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,description TEXT NOT NULL,status TEXT NOT NULL,owner TEXT,createdBy TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,note TEXT NOT NULL DEFAULT '');
    INSERT INTO messages VALUES(7,'admin',NULL,'迁移前的消息','2026-10-25T00:00:00.000Z');
    INSERT INTO tasks VALUES(3,'迁移前任务','','open',NULL,'admin','2026-10-25T00:00:00.000Z','2026-10-25T00:00:00.000Z','旧备注');`);
  db.close();
  let server = await start(data);
  t.after(async () => stop(server.child));
  const initial = await client(server, server.admin)('/api/admin/state');
  assert.equal(initial.messages[0].id, 7);
  assert.equal(initial.messages[0].text, '迁移前的消息');
  assert.equal(initial.messages[0].conversationId, initial.activeConversationId);
  assert.equal(initial.tasks[0].note, '旧备注');
  assert.equal(initial.tasks[0].conversationId, initial.activeConversationId);
  await stop(server.child);
  server = await start(data);
  const again = await client(server, server.admin)('/api/admin/state');
  assert.deepEqual(again.messages, initial.messages);
  assert.deepEqual(again.tasks, initial.tasks);
  assert.deepEqual(again.conversations, initial.conversations);
});
