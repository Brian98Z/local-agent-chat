import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { get } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

const root = fileURLToPath(new URL('.', import.meta.url));
const tempBase = resolve('D:/OMP/temp/local-agent-chat-tests');
await mkdir(tempBase, { recursive: true });
const tempRoot = resolve(await mkdtemp(join(tempBase, 'run-')));
await mkdir(tempRoot, { recursive: true });
const dir = await mkdtemp(join(tempRoot, 'contract-'));
const secret = () => randomBytes(32).toString('hex');
const AVATAR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="#0f766e"/></svg>';

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
    if (path === '/api/join' && body && body.avatarSvg === undefined) body = { ...body, avatarSvg: AVATAR };
    const response = await fetch(server.url + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    assert.equal(response.status, status, `${path}: ${JSON.stringify(result)}`);
    return result;
  };
}
function bridge(server, name, identity, model = 'test-model') {
  const args = [join(root, 'mcp.mjs'), '--name', name];
  if (model) args.push('--model', model);
  args.push('--identity', identity, '--url', server.url);
  const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
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
  const injectAvatar = (name, args) => name === 'chat_join' && args.avatarSvg === undefined ? { ...args, avatarSvg: AVATAR } : args;
  return { child, rpc, call: (name, args = {}) => rpc('tools/call', { name, arguments: injectAvatar(name, args) }) };
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
  const rejectedIdentity = join(dir, 'rejected.key');
  const rejectedBridge = bridge(server, 'Rejected', rejectedIdentity);
  t.after(async () => stop(rejectedBridge.child));
  assert.equal((await rejectedBridge.call('chat_join')).result.isError, true);
  await assert.rejects(readFile(rejectedIdentity, 'utf8'), (error) => error.code === 'ENOENT');
  const aToken = secret(), bToken = secret(), cToken = secret();
  const a = client(server, aToken), b = client(server, bToken), c = client(server, cToken);
  await a('/api/join', { name: 'Alpha', token: aToken, model: 'model-alpha' }, 403);
  await admin('/api/admin/registration', { open: true });
  await a('/api/join', { name: 'NoModel', token: secret() }, 400);
  const aid = (await a('/api/join', { name: 'Alpha', token: aToken, model: 'model-alpha' })).agent.id;
  const bid = (await b('/api/join', { name: 'Beta', token: bToken, model: 'model-beta' })).agent.id;
  const cid = (await c('/api/join', { name: 'Gamma', token: cToken, model: 'model-gamma' })).agent.id;
  await client(server)('/api/join', { name: 'alpha', token: secret(), model: 'model-alpha' }, 409);
  await a('/api/messages', undefined, 403);
  await a('/api/admin/state', undefined, 403);
  assert.equal((await a('/api/me')).agent.status, 'pending');
  assert.equal((await a('/api/me')).agent.model, 'model-alpha');
  for (const agentId of [aid, bid, cid]) await admin(`/api/admin/agents/${agentId}`, { status: 'active' });
  const beforeHeartbeat = (await admin('/api/agents')).agents.find(agent => agent.id === aid);
  assert.equal(beforeHeartbeat.lastHeartbeatAt, null);
  assert.equal(beforeHeartbeat.online, false);
  await a('/api/events?conversationId=1&after=0&timeout=1');
  const afterHeartbeat = (await admin('/api/agents')).agents.find(agent => agent.id === aid);
  assert.equal(afterHeartbeat.online, true);
  assert.ok(Number.isFinite(Date.parse(afterHeartbeat.lastHeartbeatAt)));
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
  const adminReply = (await a('/api/messages', { text: 'private admin reply', to: 'admin' })).message;
  assert.equal(adminReply.to, 'admin');
  assert.equal((await b('/api/messages')).messages.some(message => message.id === adminReply.id), false);
  assert.equal((await admin('/api/messages')).messages.find(message => message.id === adminReply.id).to, 'admin');
  assert.equal((await a('/api/messages')).messages.find(message => message.id === adminReply.id).to, 'admin');
  const upload = await a('/api/attachments', { name: 'note.txt', contentType: 'text/plain', data: Buffer.from('secret attachment').toString('base64') }, 201);
  const attached = await a('/api/messages', { text: '', to: bid, attachmentIds: [upload.attachment.id] });
  assert.equal(attached.message.attachments[0].name, 'note.txt');
  const download = await fetch(`${server.url}/api/attachments/${upload.attachment.id}`, { headers: { Authorization: `Bearer ${bToken}` } });
  assert.equal(await download.text(), 'secret attachment');
  const denied = await fetch(`${server.url}/api/attachments/${upload.attachment.id}`, { headers: { Authorization: `Bearer ${cToken}` } });
  assert.equal(denied.status, 404);
  await a('/api/messages', { text: 'reuse', attachmentIds: [upload.attachment.id] }, 404);
  const round = (await admin('/api/admin/scoring/rounds', { roundKey: 'round-1' })).round;
  assert.equal((await admin('/api/admin/scoring/rounds', { roundKey: 'round-1' })).round.id, round.id);
  await a('/api/admin/scoring/rounds', { roundKey: 'no-permission' }, 403);
  await admin(`/api/admin/scoring/rounds/${round.id}/award`, { points: 8, evidence: 'hash and command', rationale: 'verified' });
  await admin(`/api/admin/scoring/rounds/${round.id}/award`, { points: 9, evidence: 'again', rationale: 'duplicate' }, 409);
  assert.equal((await a('/api/scoring')).leaderboard[0].points, 8);
  const unused = (await a('/api/attachments', { name: 'unused.txt', contentType: 'text/plain', data: 'eA==' }, 201)).attachment;
  const unauthorizedDelete = await fetch(`${server.url}/api/attachments/${unused.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${bToken}` } });
  assert.equal(unauthorizedDelete.status, 404);
  const ownerDelete = await fetch(`${server.url}/api/attachments/${unused.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${aToken}` } });
  assert.equal(ownerDelete.status, 200);
  const deletedDownload = await fetch(`${server.url}/api/attachments/${unused.id}`, { headers: { Authorization: `Bearer ${aToken}` } });
  assert.equal(deletedDownload.status, 404);
  assert.deepEqual((await a('/api/group-tools/invoke', { name: 'text.length', arguments: { text: 'abc' } })).result, { length: 3 });
  await a('/api/group-tools/invoke', { name: 'text.length', arguments: { text: 3 } }, 400);
  await a('/api/group-tools/invoke', { name: 'missing', arguments: {} }, 404);
  const createdPoll = (await admin('/api/group-tools/invoke', { name: 'poll.create', arguments: { conversationId: 1, question: 'Choose release window', options: ['Morning', 'Evening'], clientRequestId: 'http-poll' } })).result.poll;
  await a('/api/group-tools/invoke', { name: 'poll.vote', arguments: { conversationId: 1, pollId: createdPoll.id, optionIndex: 1 } });
  assert.equal((await b('/api/group-tools/invoke', { name: 'poll.list', arguments: { conversationId: 1 } })).result.polls[0].options[1].votes, 1);
  await a('/api/group-tools/invoke', { name: 'poll.create', arguments: { conversationId: 1, question: 'Not admin', options: ['A', 'B'], clientRequestId: 'forbidden-poll' } }, 404);
  const firstRoll = (await a('/api/group-tools/invoke', { name: 'game.roll', arguments: { conversationId: 1, count: 2, sides: 6, clientRequestId: 'http-roll' } })).result.game;
  assert.deepEqual((await a('/api/group-tools/invoke', { name: 'game.roll', arguments: { conversationId: 1, count: 2, sides: 6, clientRequestId: 'http-roll' } })).result.game, firstRoll);
  await a('/api/group-tools/invoke', { name: 'game.roll', arguments: { conversationId: 1, count: 1, sides: 6, clientRequestId: 'http-roll' } }, 409);
  assert.equal((await a('/api/group-tools/invoke', { name: 'payment.config', arguments: { conversationId: 1 } })).result.config, null);
  const mention = (await admin('/api/messages', { text: '@Beta, please review' })).message;
  assert.deepEqual(mention.mentions, [bid]);
  assert.deepEqual((await c(`/api/messages?after=${mention.id - 1}`)).messages[0].mentions, [bid]);
  const autoRounds = (await admin('/api/scoring')).rounds;
  const autoRound = autoRounds.find(item => item.roundKey === `message:${mention.id}`);
  assert.ok(autoRound && [aid, bid, cid].includes(autoRound.selectedAgentId));
  const idempotentBody = { text: 'idempotent', clientMessageId: 'test-request-1', kind: 'message' };
  const sentOnce = (await admin('/api/messages', idempotentBody)).message;
  const sentTwice = (await admin('/api/messages', idempotentBody)).message;
  assert.equal(sentTwice.id, sentOnce.id);
  assert.equal((await admin('/api/scoring')).rounds.filter(item => item.roundKey === `message:${sentOnce.id}`).length, 1);
  await admin('/api/messages', { ...idempotentBody, text: 'different' }, 409);
  const previous = await c(`/api/messages?before=${sentOnce.id}&limit=2`);
  assert.ok(previous.messages.every(message => message.id < sentOnce.id));
  assert.ok(previous.messages.every(message => message.to === null || message.from === cid || message.to === cid));
  assert.ok(previous.earliest_available_id > 0);
  await c(`/api/messages?before=${sentOnce.id}&after=0`, undefined, 400);
  const attachRetry = (await a('/api/attachments', { name: 'retry.txt', contentType: 'text/plain', data: 'eA==' }, 201)).attachment;
  const attachBody = { text: '', to: bid, attachmentIds: [attachRetry.id], clientMessageId: 'attachment-retry' };
  const firstAttachmentMessage = (await a('/api/messages', attachBody)).message;
  assert.equal((await a('/api/messages', attachBody)).message.id, firstAttachmentMessage.id);
  await a('/api/messages', { ...attachBody, to: cid }, 409);
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
  const mutedOwner = client(server, owner === aid ? aToken : bToken);
  assert.equal((await mutedOwner('/api/tasks')).conversationId > 0, true);
  await mutedOwner('/api/messages', { text: 'muted write' }, 403);
  await admin(`/api/admin/agents/${owner}`, { status: 'active' });
  await a(`/api/tasks/${task.id}`, { action: 'claim' });
  await a(`/api/tasks/${task.id}`, { action: 'complete', note: 'Verified' });
  await a(`/api/tasks/${task.id}`, { action: 'reopen' }, 403);
  await admin(`/api/tasks/${task.id}`, { action: 'reopen' });
  assert.equal((await a('/api/tasks')).tasks.find(row => row.id === task.id).owner, null);
  await admin(`/api/admin/agents/${cid}`, { status: 'revoked' });
  await admin(`/api/admin/agents/${cid}`, { status: 'active' }, 409);
  assert.equal((await c('/api/join', { name: 'Changed', token: cToken, model: 'model-changed' }, 200)).agent.status, 'revoked');
  assert.equal((await c('/api/join', { name: 'Changed', token: cToken, model: 'model-changed' }, 200)).agent.model, 'model-gamma');
  await c('/api/messages', undefined, 403);
  const identity = join(dir, 'mcp-identity.key');
  const unconfigured = bridge(server, 'No Model', join(dir, 'no-model.key'), null);
  t.after(async () => stop(unconfigured.child));
  assert.equal((await unconfigured.call('chat_join')).result.isError, true);
  const mcp = bridge(server, 'MCP Worker', identity);
  t.after(async () => stop(mcp.child));
  assert.equal((await mcp.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'contract-test', version: '1' } })).result.protocolVersion, '2025-03-26');
  const joinResult = await mcp.call('chat_join');
  assert.equal(joinResult.result.isError, undefined);
  const mid = JSON.parse(joinResult.result.content[0].text).agent.id;
  assert.equal(JSON.parse(joinResult.result.content[0].text).agent.model, 'test-model');
  const pendingStatus = JSON.parse((await mcp.call('chat_status')).result.content[0].text);
  assert.equal(pendingStatus.status, 'pending');
  assert.equal(pendingStatus.model, 'test-model');
  const pendingReady = JSON.parse((await mcp.call('chat_ready')).result.content[0].text);
  assert.equal(pendingReady.ready, false);
  assert.equal(pendingReady.readable, false);
  assert.equal(pendingReady.canWrite, false);
  assert.equal(pendingReady.heartbeat.timeout, 25000);
  assert.equal(pendingReady.heartbeat.maxGapMs, 45000);
  assert.equal((await admin('/api/admin/state')).agents.find(row => row.id === mid).model, 'test-model');
  assert.equal((await mcp.call('chat_send', { text: 'blocked' })).result.isError, true);
  await admin(`/api/admin/agents/${mid}`, { status: 'active' });
  const activeReady = JSON.parse((await mcp.call('chat_ready')).result.content[0].text);
  assert.equal(activeReady.ready, true);
  assert.equal(activeReady.readable, true);
  assert.equal(activeReady.canWrite, true);
  assert.ok(Number.isInteger(activeReady.activeConversationId) && activeReady.activeConversationId > 0);
  assert.ok(Array.isArray(activeReady.conversations));
  const toolResult = await mcp.call('chat_tool_call', { name: 'text.length', arguments: { text: 'hello' } });
  assert.equal(JSON.parse(toolResult.result.content[0].text).result.length, 5);
  const mcpConversation = activeReady.activeConversationId;
  const namedPoll = (await admin('/api/group-tools/invoke', { name: 'poll.create', arguments: { conversationId: mcpConversation, question: 'MCP named vote', options: ['A', 'B'], clientRequestId: 'mcp-named-poll' } })).result.poll;
  const voted = JSON.parse((await mcp.call('chat_poll_vote', { conversationId: mcpConversation, pollId: namedPoll.id, optionIndex: 1 })).result.content[0].text).result.poll;
  assert.equal(voted.myOptionIndex, 1);
  assert.equal(JSON.parse((await mcp.call('chat_poll_list', { conversationId: mcpConversation })).result.content[0].text).result.polls.find(poll => poll.id === namedPoll.id).totalVotes, 1);
  const rollArgs = { conversationId: mcpConversation, count: 2, sides: 6, clientRequestId: 'mcp-named-roll' };
  const namedRoll = JSON.parse((await mcp.call('chat_game_roll', rollArgs)).result.content[0].text).result.game;
  assert.deepEqual(JSON.parse((await mcp.call('chat_game_roll', rollArgs)).result.content[0].text).result.game, namedRoll);
  assert.equal((await mcp.call('chat_game_roll', { ...rollArgs, sides: 8 })).result.isError, true);
  assert.equal((await mcp.call('chat_game_roll', { count: 2, sides: 6, clientRequestId: 'missing-conversation' })).result.isError, true);
  assert.equal((await mcp.call('chat_game_rps', { conversationId: mcpConversation, move: 'invalid', clientRequestId: 'invalid-rps' })).result.isError, true);
  const namedRps = JSON.parse((await mcp.call('chat_game_rps', { conversationId: mcpConversation, move: 'rock', clientRequestId: 'mcp-named-rps' })).result.content[0].text).result.game;
  assert.equal(JSON.parse((await mcp.call('chat_game_history', { conversationId: mcpConversation })).result.content[0].text).result.games[0].id, namedRps.id);
  assert.equal(JSON.parse((await mcp.call('chat_payment_config', { conversationId: mcpConversation })).result.content[0].text).result.config, null);
  assert.deepEqual(JSON.parse((await mcp.call('chat_payment_list', { conversationId: mcpConversation })).result.content[0].text).result.requests, []);
  assert.equal((await mcp.call('chat_payment_create', { conversationId: mcpConversation, amount: '1e6', payerAddress: '0x' + '11'.repeat(20), clientRequestId: 'bad-amount' })).result.isError, true);
  assert.equal((await mcp.call('chat_payment_verify', { conversationId: mcpConversation, requestId: 'bad', txHash: '0x' + '11'.repeat(32) })).result.isError, true);
  const uploadedByMcp = JSON.parse((await mcp.call('chat_upload', { name: 'mcp.txt', contentType: 'text/plain', data: Buffer.from('mcp data').toString('base64') })).result.content[0].text).attachment;
  const downloadedByMcp = JSON.parse((await mcp.call('chat_download', { id: uploadedByMcp.id })).result.content[0].text);
  assert.equal(Buffer.from(downloadedByMcp.data, 'base64').toString(), 'mcp data');
  const mcpAttachmentMessage = await mcp.call('chat_send', { text: '', attachmentIds: [uploadedByMcp.id] });
  assert.equal(JSON.parse(mcpAttachmentMessage.result.content[0].text).message.attachments[0].id, uploadedByMcp.id);
  assert.equal((await mcp.call('chat_send', { text: 'from MCP', to: aid })).result.isError, undefined);
  assert.equal((await a('/api/messages')).messages.at(-1).text, 'from MCP');
  const cliStatus = spawnSync(process.execPath, [join(root, 'mcp.mjs'), '--name', 'MCP Worker', '--model', 'test-model', '--identity', identity, '--url', server.url, '--call', 'chat_status'], { encoding: 'utf8' });
  assert.equal(cliStatus.status, 0, cliStatus.stderr);
  assert.equal(JSON.parse(cliStatus.stdout).status, 'active');
  const replyFile = join(dir, 'cli-reply.txt');
  await writeFile(replyFile, 'CLI text file reply', 'utf8');
  const sendFile = spawnSync(process.execPath, [join(root, 'mcp.mjs'), '--name', 'MCP Worker', '--model', 'test-model', '--identity', identity, '--url', server.url, '--call', 'chat_send', '--args', JSON.stringify({ conversationId: activeReady.activeConversationId }), '--text-file', replyFile], { encoding: 'utf8' });
  assert.equal(sendFile.status, 0, sendFile.stderr);
  assert.equal(JSON.parse(sendFile.stdout).message.text, 'CLI text file reply');
  assert.equal((await mcp.call('chat_send', { text: 'bad', injected: true })).result.isError, true);
  const mtask = JSON.parse((await mcp.call('task_create', { title: 'MCP task' })).result.content[0].text).task;
  await mcp.call('task_claim', { id: mtask.id });
  await mcp.call('task_release', { id: mtask.id });
  await mcp.call('task_claim', { id: mtask.id });
  const done = await mcp.call('task_complete', { id: mtask.id, note: 'MCP verified' });
  assert.equal(JSON.parse(done.result.content[0].text).task.status, 'done');
  await admin(`/api/admin/agents/${mid}`, { status: 'paused' });
  const pausedReady = JSON.parse((await mcp.call('chat_ready')).result.content[0].text);
  assert.equal(pausedReady.ready, false);
  assert.equal(pausedReady.readable, true);
  assert.equal(pausedReady.canWrite, false);
  assert.equal((await mcp.call('chat_game_roll', { conversationId: mcpConversation, count: 1, sides: 6, clientRequestId: 'paused-game' })).result.isError, true);
  assert.equal(JSON.parse((await mcp.call('chat_game_history', { conversationId: mcpConversation })).result.content[0].text).result.games.some(game => game.id === namedRoll.id), true);
  await admin(`/api/admin/agents/${mid}`, { status: 'active' });
  assert.equal(JSON.parse((await mcp.call('chat_ready')).result.content[0].text).ready, true);
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
  assert.equal(restored.registrationOpen, true);
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
  const identity = (await agent('/api/join', { name: '对话验证', token, model: 'test-dialog' })).agent;
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
  const otherId = (await other('/api/join', { name: '私聊隔离验证', token: otherToken, model: 'test-private' })).agent.id;
  await admin(`/api/admin/agents/${otherId}`, { status: 'active' });
  const invisibleWait = other(`/api/events?conversationId=${next.id}&after=${fresh.id}&timeout=100`);
  await admin('/api/messages', { text: '仅指定成员可见', to: identity.id, conversationId: next.id });
  const hidden = await invisibleWait;
  assert.equal(hidden.reason, 'timeout');
  assert.deepEqual(hidden.messages, []);
  assert.equal(hidden.cursor, fresh.id);
  const pauseCursor = (await agent('/api/messages')).cursor;
  const mutedWait = agent(`/api/events?conversationId=${next.id}&after=${pauseCursor}&timeout=5000`);
  await admin(`/api/admin/agents/${identity.id}`, { status: 'paused' });
  assert.equal((await agent('/api/me')).agent.status, 'paused');
  const mutedNotice = (await admin('/api/messages', { text: '禁言仍可读', conversationId: next.id })).message;
  const mutedEvent = await mutedWait;
  assert.equal(mutedEvent.reason, 'messages');
  assert.deepEqual(mutedEvent.messages.map(m => m.text), ['禁言仍可读']);
  assert.equal(mutedEvent.cursor, mutedNotice.id);
  await agent('/api/messages', { text: '禁言不可发' }, 403);
  await agent('/api/tasks', { title: '禁言不可建任务' }, 403);
  await admin(`/api/admin/agents/${identity.id}`, { status: 'active' });
  const auto = (await admin('/api/admin/conversations', {}, 201)).conversation;
  assert.match(auto.title, /^对话 /);
  await admin('/api/messages', { text: '请排查 8H42 启动器闪退。补充说明不进入标题', conversationId: auto.id });
  let titled = (await admin('/api/conversations')).conversations.find(row => row.id === auto.id);
  assert.equal(titled.title, '请排查 8H42 启动器闪退。');
  await admin('/api/messages', { text: '第二条补充', conversationId: auto.id });
  titled = (await admin('/api/conversations')).conversations.find(row => row.id === auto.id);
  assert.equal(titled.title, '请排查 8H42 启动器闪退。');
  const taskAuto = (await admin('/api/admin/conversations', {}, 201)).conversation;
  await admin('/api/tasks', { title: '修复登录超时', conversationId: taskAuto.id });
  titled = (await admin('/api/conversations')).conversations.find(row => row.id === taskAuto.id);
  assert.equal(titled.title, '修复登录超时');
  await admin(`/api/admin/conversations/${first}/activate`, {});
  assert.equal((await admin('/api/admin/state')).messages[0].text, '旧对话原文');
  await stop(server.child);
  server = await start(data); admin = client(server, server.admin); agent = client(server, token);
  assert.equal((await admin('/api/admin/state')).activeConversationId, first);
  assert.equal((await agent('/api/messages')).messages[0].text, '旧对话原文');
  assert.equal((await agent('/api/me')).agent.status, 'active');
  assert.equal((await admin('/api/admin/state')).registrationOpen, true);
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

test('heartbeat becomes offline after 45 seconds without waiting', { timeout: 60000 }, async t => {
  const data = await mkdtemp(join(tempRoot, 'heartbeat-expiry-'));
  const server = await start(data);
  t.after(async () => stop(server.child));
  const admin = client(server, server.admin);
  const token = secret(), agent = client(server, token);
  await admin('/api/admin/registration', { open: true });
  const id = (await agent('/api/join', { name: 'Heartbeat expiry', token, model: 'test' })).agent.id;
  await admin(`/api/admin/agents/${id}`, { status: 'active' });
  let state = (await admin('/api/agents')).agents.find(item => item.id === id);
  assert.equal(state.lastHeartbeatAt, null);
  assert.equal(state.online, false);
  await agent('/api/events?conversationId=1&after=0&timeout=1');
  state = (await admin('/api/agents')).agents.find(item => item.id === id);
  assert.equal(state.online, true);
  const heartbeat = state.lastHeartbeatAt;
  await new Promise(resolveWait => setTimeout(resolveWait, 45100));
  state = (await admin('/api/agents')).agents.find(item => item.id === id);
  assert.equal(state.lastHeartbeatAt, heartbeat);
  assert.equal(state.online, false);
});

test('join requires a self-drawn SVG avatar, serves it, and allows updates', { timeout: 30000 }, async t => {
  const data = await mkdtemp(join(tempRoot, 'avatar-'));
  const server = await start(data);
  t.after(async () => stop(server.child));
  const admin = client(server, server.admin);
  await admin('/api/admin/registration', { open: true });
  const missing = await fetch(server.url + '/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'No Avatar', token: secret(), model: 'test' }) });
  assert.equal(missing.status, 400);
  await client(server)('/api/join', { name: 'Unsafe Avatar', token: secret(), model: 'test', avatarSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><script>alert(1)</script></svg>' }, 400);
  await client(server)('/api/join', { name: 'No ViewBox', token: secret(), model: 'test', avatarSvg: '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="4" cy="4" r="4"/></svg>' }, 400);
  await client(server)('/api/join', { name: 'External Ref', token: secret(), model: 'test', avatarSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><image href="http://example.test/a.png"/></svg>' }, 400);

  const token = secret(), member = client(server, token);
  const joined = await member('/api/join', { name: 'Avatar A', token, model: 'test' });
  assert.equal(joined.agent.avatarHash.length, 16);
  const id = joined.agent.id;
  await admin(`/api/admin/agents/${id}`, { status: 'active' });
  let bytes = await fetch(`${server.url}/api/avatars/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(bytes.status, 200);
  assert.equal(bytes.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
  assert.equal(await bytes.text(), AVATAR);
  bytes = await fetch(`${server.url}/api/avatars/${id}`, { headers: { Authorization: `Bearer ${server.admin}` } });
  assert.equal(bytes.status, 200);

  const next = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#b45309"/></svg>';
  const updated = await member('/api/avatar', { avatarSvg: next });
  assert.notEqual(updated.avatarHash, joined.agent.avatarHash);
  bytes = await fetch(`${server.url}/api/avatars/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(await bytes.text(), next);
  const state = await admin('/api/admin/state?includeMessages=0');
  const row = state.agents.find((agent) => agent.id === id);
  assert.equal(row.avatarHash, updated.avatarHash);
  assert.equal(row.avatarSvg, undefined);
  assert.equal((await admin('/api/agents')).agents.find((agent) => agent.id === id).avatarHash, updated.avatarHash);

  assert.equal((await member('/api/join', { name: 'Avatar A', token, model: 'test' }, 200)).agent.status, 'active');
  await admin(`/api/admin/agents/${id}`, { status: 'paused' });
  assert.equal((await member('/api/avatar', { avatarSvg: AVATAR })).avatarHash.length, 16);
  await admin(`/api/admin/agents/${id}`, { status: 'revoked' });
  await member('/api/avatar', { avatarSvg: AVATAR }, 403);
  const revokedHash = (await admin('/api/agents')).agents.find((agent) => agent.id === id).avatarHash;
  const revokedRejoin = await member('/api/join', { name: 'Avatar A', token, model: 'test', avatarSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#111111"/></svg>' }, 200);
  assert.equal(revokedRejoin.agent.avatarHash, revokedHash);

  await admin('/api/admin/registration', { open: false });
  await client(server)('/api/join', { name: 'Avatar A', token: secret(), model: 'test' }, 403);
});

test('administrator can delete one message, cascade attachments, and bump the revision', { timeout: 30000 }, async t => {
  const data = await mkdtemp(join(tempRoot, 'delete-message-'));
  const server = await start(data);
  t.after(async () => stop(server.child));
  const admin = client(server, server.admin);
  await admin('/api/admin/registration', { open: true });
  const token = secret(), member = client(server, token);
  const id = (await member('/api/join', { name: 'Delete Target', token, model: 'test' })).agent.id;
  await admin(`/api/admin/agents/${id}`, { status: 'active' });

  const attachment = await admin('/api/attachments', { name: 'note.txt', contentType: 'text/plain', data: Buffer.from('hello').toString('base64') }, 201);
  const sent = await admin('/api/messages', { text: 'delete me', conversationId: 1, attachmentIds: [attachment.attachment.id] });
  const keep = await admin('/api/messages', { text: 'keep me', conversationId: 1 });
  assert.equal((await admin('/api/admin/state?includeMessages=0')).messageRevision, 0);

  await member(`/api/admin/messages/${sent.message.id}/delete`, {}, 403);
  await admin('/api/admin/messages/999999/delete', {}, 404);
  const deleted = await admin(`/api/admin/messages/${sent.message.id}/delete`, {});
  assert.equal(deleted.deletedId, sent.message.id);
  assert.equal(deleted.messageRevision, 1);
  assert.equal((await admin('/api/admin/state?includeMessages=0')).messageRevision, 1);
  const messages = await admin('/api/messages?conversationId=1&after=0&limit=100');
  assert.deepEqual(messages.messages.map((message) => message.id), [keep.message.id]);
  assert.equal((await admin('/api/messages/search?conversationId=1&q=delete')).messages.length, 0);
  await admin(`/api/attachments/${attachment.attachment.id}`, undefined, 404);
  const audit = (await admin('/api/admin/state?includeMessages=0')).audit;
  assert.ok(audit.some((entry) => entry.action === 'message.delete' && entry.target === String(sent.message.id)));
  await admin(`/api/admin/messages/${sent.message.id}/delete`, {}, 404);
});

test('administrator can edit a message, mark it edited, and keep attachments valid', { timeout: 30000 }, async t => {
  const data = await mkdtemp(join(tempRoot, 'edit-message-'));
  const server = await start(data);
  t.after(async () => stop(server.child));
  const admin = client(server, server.admin);
  await admin('/api/admin/registration', { open: true });
  const token = secret(), member = client(server, token);
  await member('/api/join', { name: 'Edit Member', token, model: 'test' });

  const sent = await admin('/api/messages', { text: 'original edit me', conversationId: 1 });
  await member(`/api/admin/messages/${sent.message.id}/edit`, { text: 'nope' }, 403);
  await admin(`/api/admin/messages/${sent.message.id}/edit`, { text: '   ' }, 400);
  await admin('/api/admin/messages/999999/edit', { text: 'missing' }, 404);
  const edited = await admin(`/api/admin/messages/${sent.message.id}/edit`, { text: 'edited text' });
  assert.equal(edited.messageRevision, 1);
  assert.ok(edited.editedAt);
  let page = await admin('/api/messages?conversationId=1&after=0&limit=10');
  assert.equal(page.messages[0].text, 'edited text');
  assert.ok(page.messages[0].editedAt);
  assert.equal((await admin('/api/messages/search?conversationId=1&q=original')).messages.length, 0);
  assert.equal((await admin('/api/messages/search?conversationId=1&q=edited')).messages.length, 1);
  const audit = (await admin('/api/admin/state?includeMessages=0')).audit;
  assert.ok(audit.some((entry) => entry.action === 'message.edit' && entry.target === String(sent.message.id)));

  const upload = await admin('/api/attachments', { name: 'keep.txt', contentType: 'text/plain', data: Buffer.from('x').toString('base64') }, 201);
  const withFile = await admin('/api/messages', { text: 'file text', conversationId: 1, attachmentIds: [upload.attachment.id] });
  await admin(`/api/admin/messages/${withFile.message.id}/edit`, { text: '' });
  page = await admin('/api/messages?conversationId=1&after=0&limit=10');
  assert.equal(page.messages.find((message) => message.id === withFile.message.id).text, '');
});

test('administrator can pin and unpin one message per conversation', { timeout: 30000 }, async t => {
  const data = await mkdtemp(join(tempRoot, 'pin-'));
  const server = await start(data);
  t.after(async () => stop(server.child));
  const admin = client(server, server.admin);
  await admin('/api/admin/registration', { open: true });
  const token = secret(), member = client(server, token);
  await member('/api/join', { name: 'Pin Member', token, model: 'test' });

  const first = await admin('/api/messages', { text: 'first pin candidate', conversationId: 1 });
  const second = await admin('/api/messages', { text: 'second pin candidate', conversationId: 1 });
  await member(`/api/admin/messages/${first.message.id}/pin`, { pinned: true }, 403);
  await admin('/api/admin/messages/999999/pin', { pinned: true }, 404);
  await admin(`/api/admin/messages/${first.message.id}/pin`, { pinned: 'yes' }, 400);
  await admin(`/api/admin/messages/${first.message.id}/pin`, { pinned: true });
  let state = await admin('/api/admin/state?includeMessages=0');
  assert.equal(state.pinnedMessageId, first.message.id);
  assert.equal(state.pinnedMessage.id, first.message.id);
  assert.equal(state.pinnedMessage.text, 'first pin candidate');
  assert.equal(state.conversations.find((conversation) => conversation.id === 1).pinnedMessageId, first.message.id);

  await admin(`/api/admin/messages/${second.message.id}/pin`, { pinned: true });
  state = await admin('/api/admin/state?includeMessages=0');
  assert.equal(state.pinnedMessageId, second.message.id);
  assert.equal(state.pinnedMessage.text, 'second pin candidate');

  await admin(`/api/admin/messages/${second.message.id}/pin`, { pinned: false });
  state = await admin('/api/admin/state?includeMessages=0');
  assert.equal(state.pinnedMessageId, null);
  assert.equal(state.pinnedMessage, null);

  await admin(`/api/admin/messages/${first.message.id}/pin`, { pinned: true });
  await admin(`/api/admin/messages/${first.message.id}/delete`, {});
  state = await admin('/api/admin/state?includeMessages=0');
  assert.equal(state.pinnedMessageId, null);
  const audit = state.audit;
  assert.ok(audit.some((entry) => entry.action === 'message.pin'));
  assert.ok(audit.some((entry) => entry.action === 'message.unpin'));
});

test('message search can filter by sender while keeping visibility', { timeout: 30000 }, async t => {
  const data = await mkdtemp(join(tempRoot, 'search-sender-'));
  const server = await start(data);
  t.after(async () => stop(server.child));
  const admin = client(server, server.admin);
  await admin('/api/admin/registration', { open: true });
  const tokenA = secret(), tokenB = secret();
  const agentA = client(server, tokenA), agentB = client(server, tokenB);
  const idA = (await agentA('/api/join', { name: 'Sender A', token: tokenA, model: 'test' })).agent.id;
  await agentB('/api/join', { name: 'Sender B', token: tokenB, model: 'test' });
  await admin(`/api/admin/agents/${idA}`, { status: 'active' });
  await admin('/api/admin/agents/bulk', { action: 'approve' });

  await admin('/api/messages', { text: 'filter admin broadcast', conversationId: 1 });
  const privateA = await admin('/api/messages', { text: 'filter admin private', to: idA, conversationId: 1 });
  const fromA = await agentA('/api/messages', { text: 'filter from A', conversationId: 1 });
  const fromB = await agentB('/api/messages', { text: 'filter from B', conversationId: 1 });

  const adminSender = await admin(`/api/messages/search?conversationId=1&q=filter&from=admin`);
  assert.deepEqual(adminSender.messages.map((message) => message.id), [privateA.message.id, 1]);
  const aSender = await admin(`/api/messages/search?conversationId=1&q=filter&from=${idA}`);
  assert.deepEqual(aSender.messages.map((message) => message.id), [fromA.message.id]);
  const bSender = await admin(`/api/messages/search?conversationId=1&q=filter&from=${fromB.message.from}`);
  assert.deepEqual(bSender.messages.map((message) => message.id), [fromB.message.id]);

  const memberBSearch = await agentB(`/api/messages/search?conversationId=1&q=filter&from=admin`);
  assert.deepEqual(memberBSearch.messages.map((message) => message.id), [1]);
  const memberAFromA = await agentB(`/api/messages/search?conversationId=1&q=filter&from=${idA}`);
  assert.deepEqual(memberAFromA.messages.map((message) => message.id), [fromA.message.id]);
  assert.equal((await admin('/api/messages/search?conversationId=1&q=filter&from=00000000-0000-4000-8000-000000000000')).messages.length, 0);
  const timeline = await admin(`/api/messages/search?conversationId=1&from=${idA}`);
  assert.deepEqual(timeline.messages.map((message) => message.id), [fromA.message.id]);
  assert.equal(timeline.query, '');
  await admin('/api/messages/search?conversationId=1', undefined, 400);
  await admin('/api/messages/search?conversationId=1&q=filter&from=x', undefined, 400);
});

test('message search matches literal text and respects member visibility', { timeout: 30000 }, async t => {
  const data = await mkdtemp(join(tempRoot, 'search-'));
  const server = await start(data);
  t.after(async () => stop(server.child));
  const admin = client(server, server.admin);
  await admin('/api/admin/registration', { open: true });
  const tokenA = secret(), tokenB = secret();
  const agentA = client(server, tokenA), agentB = client(server, tokenB);
  const idA = (await agentA('/api/join', { name: 'Search A', token: tokenA, model: 'test' })).agent.id;
  await agentB('/api/join', { name: 'Search B', token: tokenB, model: 'test' });
  await admin(`/api/admin/agents/${idA}`, { status: 'active' });
  await admin('/api/admin/agents/bulk', { action: 'approve' });

  await admin('/api/messages', { text: 'alpha 100% done', conversationId: 1 });
  const directed = await admin('/api/messages', { text: 'secret alpha plan', to: idA, conversationId: 1 });
  await admin('/api/messages', { text: 'beta only', conversationId: 1 });

  const adminHits = await admin('/api/messages/search?conversationId=1&q=alpha');
  assert.equal(adminHits.query, 'alpha');
  assert.deepEqual(adminHits.messages.map((message) => message.id), [directed.message.id, 1]);
  assert.equal((await admin('/api/messages/search?conversationId=1&q=ALPHA')).messages.length, 2);
  const wildcard = await admin('/api/messages/search?conversationId=1&q=' + encodeURIComponent('%'));
  assert.equal(wildcard.messages.length, 1);
  assert.equal(wildcard.messages[0].text, 'alpha 100% done');

  const observer = await agentB('/api/messages/search?conversationId=1&q=alpha');
  assert.deepEqual(observer.messages.map((message) => message.id), [1]);
  const recipient = await agentA('/api/messages/search?conversationId=1&q=alpha');
  assert.deepEqual(recipient.messages.map((message) => message.id), [directed.message.id, 1]);

  await admin('/api/messages/search?conversationId=1', undefined, 400);
  await admin('/api/messages/search?conversationId=1&q=' + encodeURIComponent('   '), undefined, 400);
  await admin('/api/messages/search?conversationId=1&q=alpha&limit=0', undefined, 400);
  await admin('/api/messages/search?conversationId=1&q=alpha&extra=1', undefined, 400);
});

test('conversation lists expose latestMessageId with member visibility scoping', { timeout: 30000 }, async t => {
  const data = await mkdtemp(join(tempRoot, 'unread-'));
  const server = await start(data);
  t.after(async () => stop(server.child));
  const admin = client(server, server.admin);
  await admin('/api/admin/registration', { open: true });
  const tokenA = secret(), tokenB = secret();
  const agentA = client(server, tokenA), agentB = client(server, tokenB);
  const idA = (await agentA('/api/join', { name: 'Unread A', token: tokenA, model: 'test' })).agent.id;
  await agentB('/api/join', { name: 'Unread B', token: tokenB, model: 'test' });
  await admin(`/api/admin/agents/${idA}`, { status: 'active' });
  await admin('/api/admin/agents/bulk', { action: 'approve' });

  const second = await admin('/api/admin/conversations', { title: '第二对话' }, 201);
  const before = (await admin('/api/conversations')).conversations.find((conversation) => conversation.id === second.conversation.id);
  assert.equal(before.latestMessageId, 0);

  const first = await admin('/api/messages', { text: '广播消息', conversationId: second.conversation.id });
  const directed = await admin('/api/messages', { text: '只给 A', to: idA, conversationId: second.conversation.id });
  assert.ok(directed.message.id > first.message.id);

  const adminConversations = (await admin('/api/conversations')).conversations;
  const adminRow = adminConversations.find((conversation) => conversation.id === second.conversation.id);
  assert.equal(adminRow.latestMessageId, directed.message.id);
  const stateRow = (await admin('/api/admin/state?includeMessages=0')).conversations.find((conversation) => conversation.id === second.conversation.id);
  assert.equal(stateRow.latestMessageId, directed.message.id);

  const memberConversations = (await agentB('/api/conversations')).conversations;
  assert.equal(memberConversations.find((conversation) => conversation.id === second.conversation.id).latestMessageId, first.message.id);
  const recipientConversations = (await agentA('/api/conversations')).conversations;
  assert.equal(recipientConversations.find((conversation) => conversation.id === second.conversation.id).latestMessageId, directed.message.id);
});

test('administrator health reports storage, counts, uptime and rejects members', { timeout: 30000 }, async t => {
  const data = await mkdtemp(join(tempRoot, 'health-'));
  const server = await start(data);
  t.after(async () => stop(server.child));
  const admin = client(server, server.admin);
  await admin('/api/admin/registration', { open: true });
  const token = secret(), member = client(server, token);
  await member('/api/join', { name: 'Health Member', token, model: 'test' });
  await admin('/api/messages', { text: 'health message', conversationId: 1 });
  await admin('/api/tasks', { title: 'health task', conversationId: 1 });
  await admin('/api/attachments', { name: 'h.txt', contentType: 'text/plain', data: Buffer.from('x').toString('base64') }, 201);

  const health = await admin('/api/admin/health');
  assert.equal(typeof health.version, 'string');
  assert.match(health.node, /^v\d+/);
  assert.ok(health.uptimeSeconds >= 0);
  assert.ok(Number.isInteger(health.port) && health.port > 0);
  assert.ok(health.databaseBytes > 0);
  assert.ok(health.walBytes >= 0);
  assert.equal(health.counts.agents, 1);
  assert.equal(health.counts.messages, 1);
  assert.equal(health.counts.tasks, 1);
  assert.equal(health.counts.conversations, 1);
  assert.equal(health.counts.attachments, 1);
  assert.ok(health.memory.rss > 0);
  assert.equal(health.messageRevision, 0);
  assert.ok(!JSON.stringify(health).includes(server.admin));
  await member('/api/admin/health', undefined, 403);
});

test('admin state can omit messages and exposes latestMessageId', { timeout: 30000 }, async t => {
  const data = await mkdtemp(join(tempRoot, 'light-state-'));
  const server = await start(data);
  t.after(async () => stop(server.child));
  const admin = client(server, server.admin);
  const sent = await admin('/api/messages', { text: '轻量状态测试', conversationId: 1 });
  const full = await admin('/api/admin/state');
  assert.equal(full.latestMessageId, sent.message.id);
  assert.equal(full.messages.length, 1);
  assert.equal(full.messages[0].id, sent.message.id);
  const light = await admin('/api/admin/state?includeMessages=0');
  assert.equal(light.latestMessageId, sent.message.id);
  assert.deepEqual(light.messages, []);
  assert.equal(light.agents.length, full.agents.length);
  assert.equal(light.audit.length, full.audit.length);
  assert.equal(light.tasks.length, full.tasks.length);
  await admin('/api/admin/state?includeMessages=1', undefined, 200);
  await admin('/api/admin/state?includeMessages=yes', undefined, 400);
});

test('activity reports are validated, per-member, and exposed to monitors', { timeout: 30000 }, async t => {
  const data = await mkdtemp(join(tempRoot, 'activity-'));
  const server = await start(data);
  t.after(async () => stop(server.child));
  const admin = client(server, server.admin);
  const tokenA = secret(), tokenB = secret();
  const agentA = client(server, tokenA), agentB = client(server, tokenB);
  await admin('/api/admin/registration', { open: true });
  const idA = (await agentA('/api/join', { name: 'Activity A', token: tokenA, model: 'test' })).agent.id;
  const idB = (await agentB('/api/join', { name: 'Activity B', token: tokenB, model: 'test' })).agent.id;
  await admin(`/api/admin/agents/${idA}`, { status: 'active' });
  await admin(`/api/admin/agents/${idB}`, { status: 'active' });

  await admin('/api/activity', { state: 'thinking' }, 403);
  await agentA('/api/activity', { state: 'busy' }, 400);
  await agentA('/api/activity', { state: 'thinking', surprise: true }, 400);
  await agentA('/api/activity', { state: 'thinking', detail: 'x'.repeat(81) }, 400);

  const reported = await agentA('/api/activity', { state: 'thinking', detail: '分析消息' });
  assert.equal(reported.activity.state, 'thinking');
  assert.equal(reported.activity.detail, '分析消息');
  let agents = (await admin('/api/agents')).agents;
  let a = agents.find(row => row.id === idA), b = agents.find(row => row.id === idB);
  assert.equal(a.activity.state, 'thinking');
  assert.equal(a.activity.detail, '分析消息');
  assert.equal(a.online, true);
  assert.equal(b.activity, null);
  assert.equal(b.online, false);

  await agentA('/api/activity', { state: 'generating' });
  agents = (await admin('/api/agents')).agents;
  a = agents.find(row => row.id === idA);
  assert.equal(a.activity.state, 'generating');
  assert.equal(a.activity.detail, '');

  const state = await admin('/api/admin/state');
  a = state.agents.find(row => row.id === idA);
  assert.equal(a.activity.state, 'generating');
  assert.equal(state.agents.find(row => row.id === idB).activity, null);

  const memberView = await agentB('/api/agents');
  assert.equal(memberView.agents.find(row => row.id === idA).activity.state, 'generating');

  await admin(`/api/admin/agents/${idB}`, { status: 'paused' });
  assert.equal((await agentB('/api/activity', { state: 'idle' })).activity.state, 'idle');
  assert.equal((await admin('/api/agents')).agents.find(row => row.id === idB).activity.state, 'idle');
  await admin(`/api/admin/agents/${idB}`, { status: 'revoked' });
  await agentB('/api/activity', { state: 'thinking' }, 403);
});

test('bridge mirrors thinking, explicit generating, and idle to the monitor', { timeout: 30000 }, async t => {
  const data = await mkdtemp(join(tempRoot, 'activity-bridge-'));
  const server = await start(data);
  t.after(async () => stop(server.child));
  const admin = client(server, server.admin);
  await admin('/api/admin/registration', { open: true });
  const identity = join(data, 'bridge.key');
  const mcp = bridge(server, 'Activity Bridge', identity);
  t.after(async () => stop(mcp.child));
  const joined = JSON.parse((await mcp.call('chat_join')).result.content[0].text);
  const id = joined.agent.id;
  await admin(`/api/admin/agents/${id}`, { status: 'active' });
  const presence = async () => (await admin('/api/agents')).agents.find(row => row.id === id);

  const first = await admin('/api/messages', { text: '第一项任务', conversationId: 1 });
  const read = JSON.parse((await mcp.call('chat_read', { conversationId: 1, after: 0 })).result.content[0].text);
  assert.ok(read.messages.some(message => message.id === first.message.id));
  assert.equal((await presence()).activity.state, 'thinking');

  const generating = JSON.parse((await mcp.call('chat_activity', { state: 'generating', detail: '撰写回复' })).result.content[0].text);
  assert.equal(generating.activity.state, 'generating');
  assert.equal((await presence()).activity.detail, '撰写回复');

  await mcp.call('chat_send', { conversationId: 1, text: '收到第一项任务' });
  assert.equal((await presence()).activity.state, 'idle');

  await admin('/api/messages', { text: '第二项任务', conversationId: 1 });
  const wait = JSON.parse((await mcp.call('chat_wait', { conversationId: 1, after: read.cursor, timeout: 1000 })).result.content[0].text);
  assert.ok(wait.messages.length > 0);
  assert.equal((await presence()).activity.state, 'thinking');
});

test('bridge chat_search respects member visibility and validates arguments', { timeout: 30000 }, async t => {
  const data = await mkdtemp(join(tempRoot, 'bridge-search-'));
  const server = await start(data);
  t.after(async () => stop(server.child));
  const admin = client(server, server.admin);
  await admin('/api/admin/registration', { open: true });
  const identity = join(data, 'search-bridge.key');
  const mcp = bridge(server, 'Search Bridge', identity);
  t.after(async () => stop(mcp.child));
  const joined = JSON.parse((await mcp.call('chat_join')).result.content[0].text);
  await admin(`/api/admin/agents/${joined.agent.id}`, { status: 'active' });

  const otherToken = secret(), other = client(server, otherToken);
  const otherId = (await other('/api/join', { name: 'Search Other', token: otherToken, model: 'test' })).agent.id;
  await admin(`/api/admin/agents/${otherId}`, { status: 'active' });

  const broadcast = await admin('/api/messages', { text: 'bridge alpha broadcast', conversationId: 1 });
  const directed = await admin('/api/messages', { text: 'alpha private for other', to: otherId, conversationId: 1 });
  await admin('/api/messages', { text: 'bridge beta', conversationId: 1 });
  await admin('/api/messages', { text: '100% literal', conversationId: 1 });

  const result = JSON.parse((await mcp.call('chat_search', { conversationId: 1, q: 'alpha' })).result.content[0].text);
  assert.deepEqual(result.messages.map((message) => message.id), [broadcast.message.id]);
  assert.ok(!result.messages.some((message) => message.id === directed.message.id));
  const limited = JSON.parse((await mcp.call('chat_search', { conversationId: 1, q: 'bridge', limit: 1 })).result.content[0].text);
  assert.equal(limited.messages.length, 1);
  const literal = JSON.parse((await mcp.call('chat_search', { conversationId: 1, q: '%' })).result.content[0].text);
  assert.deepEqual(literal.messages.map((message) => message.text), ['100% literal']);
  const fromAdmin = JSON.parse((await mcp.call('chat_search', { conversationId: 1, q: 'alpha', from: 'admin' })).result.content[0].text);
  assert.deepEqual(fromAdmin.messages.map((message) => message.id), [broadcast.message.id]);
  const fromBridge = JSON.parse((await mcp.call('chat_search', { conversationId: 1, q: 'alpha', from: joined.agent.id })).result.content[0].text);
  assert.equal(fromBridge.messages.length, 0);
  const timeline = JSON.parse((await mcp.call('chat_search', { conversationId: 1, from: 'admin' })).result.content[0].text);
  assert.equal(timeline.messages.length, 3);
  assert.equal((await mcp.call('chat_search', { conversationId: 1, q: 'alpha', from: 'x' })).result.isError, true);
  assert.equal((await mcp.call('chat_search', { conversationId: 1, q: 'alpha', from: joined.agent.id.toUpperCase() })).result.isError, true);
  assert.equal((await mcp.call('chat_search', { conversationId: 1, q: '' })).result.isError, true);
  assert.equal((await mcp.call('chat_search', { conversationId: 1, q: 'alpha', limit: 0 })).result.isError, true);
});

test('members can read only pinned messages visible to them', { timeout: 30000 }, async t => {
  const data = await mkdtemp(join(tempRoot, 'pinned-read-'));
  const server = await start(data);
  t.after(async () => stop(server.child));
  const admin = client(server, server.admin);
  await admin('/api/admin/registration', { open: true });
  const identity = join(data, 'pinned-bridge.key');
  const mcp = bridge(server, 'Pinned Bridge', identity);
  t.after(async () => stop(mcp.child));
  const joined = JSON.parse((await mcp.call('chat_join')).result.content[0].text);
  await admin(`/api/admin/agents/${joined.agent.id}`, { status: 'active' });
  const otherToken = secret(), other = client(server, otherToken);
  const otherId = (await other('/api/join', { name: 'Pinned Other', token: otherToken, model: 'test' })).agent.id;
  await admin(`/api/admin/agents/${otherId}`, { status: 'active' });

  const broadcast = await admin('/api/messages', { text: 'pinned broadcast rule', conversationId: 1 });
  await admin(`/api/admin/messages/${broadcast.message.id}/pin`, { pinned: true });
  let result = JSON.parse((await mcp.call('chat_pinned', { conversationId: 1 })).result.content[0].text);
  assert.equal(result.pinnedMessage.text, 'pinned broadcast rule');
  assert.equal((await other('/api/pinned?conversationId=1')).pinnedMessage.text, 'pinned broadcast rule');

  const directed = await admin('/api/messages', { text: 'pinned private for other', to: otherId, conversationId: 1 });
  await admin(`/api/admin/messages/${directed.message.id}/pin`, { pinned: true });
  result = JSON.parse((await mcp.call('chat_pinned', { conversationId: 1 })).result.content[0].text);
  assert.equal(result.pinnedMessage, null);
  const bridgeConversations = JSON.parse((await mcp.call('chat_conversations')).result.content[0].text);
  assert.equal(bridgeConversations.conversations.find((conversation) => conversation.id === 1).pinnedMessageId, null);
  const otherConversations = await other('/api/conversations');
  assert.equal(otherConversations.conversations.find((conversation) => conversation.id === 1).pinnedMessageId, directed.message.id);
  assert.equal((await other('/api/pinned?conversationId=1')).pinnedMessage.text, 'pinned private for other');

  await other(`/api/admin/messages/${directed.message.id}/pin`, { pinned: false }, 403);
  await admin(`/api/admin/messages/${directed.message.id}/pin`, { pinned: false });
  result = JSON.parse((await mcp.call('chat_pinned', { conversationId: 1 })).result.content[0].text);
  assert.equal(result.pinnedMessage, null);
  await other('/api/pinned?conversationId=999', undefined, 404);
  await other('/api/pinned?conversationId=1&extra=1', undefined, 400);
});

test('automatic audit waits for an active member and can be drawn later', { timeout: 30000 }, async t => {
  const data = await mkdtemp(join(tempRoot, 'audit-pending-'));
  let server = await start(data);
  t.after(async () => stop(server.child));
  let admin = client(server, server.admin);
  const message = (await admin('/api/messages', { text: 'audit without members' })).message;
  const key = `message:${message.id}`;
  const pending = (await admin('/api/scoring')).rounds.find(round => round.roundKey === key);
  assert.equal(pending.id, null);
  await admin('/api/admin/registration', { open: true });
  const token = secret();
  const agent = client(server, token);
  const id = (await agent('/api/join', { name: 'Audit candidate', token, model: 'audit-model' })).agent.id;
  await admin(`/api/admin/agents/${id}`, { status: 'active' });
  const drawn = (await admin('/api/admin/scoring/rounds', { roundKey: key })).round;
  assert.equal(drawn.selectedAgentId, id);
  assert.equal((await admin('/api/scoring')).rounds.filter(round => round.roundKey === key).length, 1);
  await admin(`/api/admin/scoring/rounds/${drawn.id}/award`, { points: 7, evidence: 'sha256 and command output', rationale: 'verified' });
  await stop(server.child);
  server = await start(data);
  admin = client(server, server.admin);
  assert.equal((await admin('/api/scoring')).leaderboard.find(row => row.agentId === id).points, 7);
  assert.equal((await admin('/api/admin/scoring/rounds', { roundKey: key })).round.id, drawn.id);
});

test('administrator can rename a conversation with validation and audit', { timeout: 30000 }, async t => {
  const data = await mkdtemp(join(tempRoot, 'rename-'));
  const server = await start(data);
  t.after(async () => stop(server.child));
  const admin = client(server, server.admin);
  await admin('/api/admin/registration', { open: true });
  const token = secret(), member = client(server, token);
  await member('/api/join', { name: 'Rename Member', token, model: 'test' });

  const renamed = await admin('/api/admin/conversations/1/rename', { title: '  新标题  ' });
  assert.equal(renamed.conversation.title, '新标题');
  assert.equal(renamed.conversations.find((conversation) => conversation.id === 1).title, '新标题');
  assert.equal((await admin('/api/admin/state?includeMessages=0')).conversations.find((conversation) => conversation.id === 1).title, '新标题');

  await admin('/api/admin/conversations/1/rename', { title: '   ' }, 400);
  await admin('/api/admin/conversations/1/rename', { title: 'x'.repeat(81) }, 400);
  await admin('/api/admin/conversations/1/rename', {}, 400);
  await admin('/api/admin/conversations/999/rename', { title: 'missing' }, 404);
  await member('/api/admin/conversations/1/rename', { title: 'nope' }, 403);
  const audit = (await admin('/api/admin/state?includeMessages=0')).audit;
  assert.ok(audit.some((entry) => entry.action === 'conversation.rename' && entry.target === '1'));
});

test('administrator can assign a task to active members and reassign it', { timeout: 30000 }, async t => {
  const data = await mkdtemp(join(tempRoot, 'assign-task-'));
  const server = await start(data);
  t.after(async () => stop(server.child));
  const admin = client(server, server.admin);
  await admin('/api/admin/registration', { open: true });
  const tokenA = secret(), tokenB = secret(), tokenP = secret();
  const agentA = client(server, tokenA), agentB = client(server, tokenB), pending = client(server, tokenP);
  const idA = (await agentA('/api/join', { name: 'Assign A', token: tokenA, model: 'test' })).agent.id;
  const idB = (await agentB('/api/join', { name: 'Assign B', token: tokenB, model: 'test' })).agent.id;
  const idP = (await pending('/api/join', { name: 'Assign Pending', token: tokenP, model: 'test' })).agent.id;
  await admin(`/api/admin/agents/${idA}`, { status: 'active' });
  await admin(`/api/admin/agents/${idB}`, { status: 'active' });

  const created = await admin('/api/tasks', { title: '指派任务', conversationId: 1 });
  const taskId = created.task.id;
  await agentA(`/api/admin/tasks/${taskId}/assign`, { owner: idB }, 403);
  await admin(`/api/admin/tasks/${taskId}/assign`, { owner: idP }, 400);
  await admin('/api/admin/tasks/999999/assign', { owner: idA }, 404);
  await admin(`/api/admin/tasks/${taskId}/assign`, { owner: '00000000-0000-4000-8000-000000000000' }, 404);
  const assigned = await admin(`/api/admin/tasks/${taskId}/assign`, { owner: idA });
  assert.equal(assigned.task.status, 'claimed');
  assert.equal(assigned.task.owner, idA);
  const reassigned = await admin(`/api/admin/tasks/${taskId}/assign`, { owner: idB });
  assert.equal(reassigned.task.status, 'claimed');
  assert.equal(reassigned.task.owner, idB);
  await admin(`/api/tasks/${taskId}`, { action: 'complete', conversationId: 1 });
  await admin(`/api/admin/tasks/${taskId}/assign`, { owner: idA }, 409);
  const audit = (await admin('/api/admin/state?includeMessages=0')).audit;
  assert.ok(audit.some((entry) => entry.action === 'task.assign' && entry.target === String(taskId)));
});

test('administrator can delete a task with audit and permission checks', { timeout: 30000 }, async t => {
  const data = await mkdtemp(join(tempRoot, 'delete-task-'));
  const server = await start(data);
  t.after(async () => stop(server.child));
  const admin = client(server, server.admin);
  await admin('/api/admin/registration', { open: true });
  const token = secret(), member = client(server, token);
  await member('/api/join', { name: 'Task Member', token, model: 'test' });

  const created = await admin('/api/tasks', { title: '待删除任务', description: '清理', conversationId: 1 });
  const taskId = created.task.id;
  assert.equal((await admin('/api/tasks?conversationId=1')).tasks.length, 1);
  await member(`/api/admin/tasks/${taskId}/delete`, {}, 403);
  await admin('/api/admin/tasks/999999/delete', {}, 404);
  const deleted = await admin(`/api/admin/tasks/${taskId}/delete`, {});
  assert.equal(deleted.deletedId, taskId);
  assert.deepEqual((await admin('/api/tasks?conversationId=1')).tasks, []);
  const audit = (await admin('/api/admin/state?includeMessages=0')).audit;
  assert.ok(audit.some((entry) => entry.action === 'task.delete' && entry.target === String(taskId)));
  await admin(`/api/admin/tasks/${taskId}/delete`, {}, 404);
});

test('conversation deletion removes its messages and tasks and keeps one conversation', { timeout: 30000 }, async t => {
  const data = await mkdtemp(join(tempRoot, 'delete-conversation-'));
  const server = await start(data);
  t.after(async () => stop(server.child));
  const admin = client(server, server.admin);
  await admin('/api/admin/registration', { open: true });
  const token = secret();
  const agent = client(server, token);
  await agent('/api/join', { name: 'Delete Verifier', token, model: 'delete-model' });
  await admin(`/api/admin/agents/${(await agent('/api/me')).agent.id}`, { status: 'active' });
  const first = (await admin('/api/conversations')).activeConversationId;
  await agent('/api/messages', { text: '第一段历史', conversationId: first });
  await agent('/api/tasks', { title: '第一段任务', conversationId: first });
  const second = (await admin('/api/admin/conversations', { title: '第二段' }, 201)).conversation;
  await agent('/api/messages', { text: '第二段消息', conversationId: second.id });
  await agent('/api/tasks', { title: '第二段任务', conversationId: second.id });
  await agent(`/api/admin/conversations/${first}/delete`, {}, 403);
  const deletedHistory = await admin(`/api/admin/conversations/${first}/delete`, {});
  assert.equal(deletedHistory.deletedId, first);
  assert.equal(deletedHistory.activeConversationId, second.id);
  assert.deepEqual(deletedHistory.conversations.map(row => row.id), [second.id]);
  await agent(`/api/messages?conversationId=${first}`, undefined, 404);
  await agent(`/api/tasks?conversationId=${first}`, undefined, 404);
  let state = await admin('/api/admin/state');
  assert.equal(state.conversations.length, 1);
  assert.equal(state.messages[0].text, '第二段消息');
  assert.equal(state.tasks[0].title, '第二段任务');
  assert.ok(state.audit.some(row => row.action === 'conversation.delete' && row.target === String(first)));
  const third = (await admin('/api/admin/conversations', { title: '第三段' }, 201)).conversation;
  await admin(`/api/admin/conversations/${second.id}/activate`, {});
  const deletedActive = await admin(`/api/admin/conversations/${second.id}/delete`, {});
  assert.equal(deletedActive.activeConversationId, third.id);
  assert.deepEqual(deletedActive.conversations.map(row => row.id), [third.id]);
  await admin(`/api/admin/conversations/${third.id}/delete`, {}, 409);
  await admin('/api/admin/conversations/999999/delete', {}, 404);
});

test('bulk approval activates pending members and bulk revocation removes all access', { timeout: 30000 }, async t => {
  const data = await mkdtemp(join(tempRoot, 'bulk-'));
  const server = await start(data);
  t.after(async () => stop(server.child));
  const admin = client(server, server.admin);
  await admin('/api/admin/registration', { open: true });
  const tokens = [secret(), secret(), secret()];
  const ids = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const result = await client(server, tokens[index])('/api/join', { name: `Bulk ${index}`, token: tokens[index], model: `bulk-model-${index}` });
    ids.push(result.agent.id);
  }
  await client(server, tokens[1])('/api/admin/agents/bulk', { action: 'approve' }, 403);
  await admin('/api/admin/agents/bulk', { action: 'invalid' }, 400);
  assert.deepEqual(await admin('/api/admin/agents/bulk', { action: 'approve' }), { action: 'approve', updated: 3 });
  let state = await admin('/api/admin/state');
  assert.deepEqual(state.agents.filter(row => ids.includes(row.id)).map(row => row.status), ['active', 'active', 'active']);
  const task = (await client(server, tokens[0])('/api/tasks', { title: 'Bulk task' })).task;
  await client(server, tokens[0])(`/api/tasks/${task.id}`, { action: 'claim' });
  assert.deepEqual(await admin('/api/admin/agents/bulk', { action: 'revoke' }), { action: 'revoke', updated: 3 });
  state = await admin('/api/admin/state');
  assert.deepEqual(state.agents.filter(row => ids.includes(row.id)).map(row => row.status), ['revoked', 'revoked', 'revoked']);
  assert.deepEqual(state.agents.filter(row => ids.includes(row.id)).map(row => row.model), ['bulk-model-0', 'bulk-model-1', 'bulk-model-2']);
  assert.equal(state.tasks.find(row => row.id === task.id).status, 'open');
  await client(server, tokens[0])('/api/messages', undefined, 403);
  assert.deepEqual(await admin('/api/admin/agents/bulk', { action: 'revoke' }), { action: 'revoke', updated: 0 });
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

test('sentinel lock: isolation, duplicate rejection, clean restart and stale lock refusal', { timeout: 120000 }, async t => {
  const data = await mkdtemp(join(tempRoot, 'lock-'));
  const db = new DatabaseSync(join(data, 'chat.sqlite'));
  db.exec(`CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,"from" TEXT NOT NULL,"to" TEXT,text TEXT NOT NULL,createdAt TEXT NOT NULL,conversationId INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL,model TEXT,createdAt TEXT NOT NULL)`);
  db.close();
  const configAPath = join(data, 'a.config.json');
  const configBPath = join(data, 'b.config.json');
  const baseConfig = {
    projectDir: root,
    db: join(data, 'chat.sqlite'),
    state: join(data, 'a-state.json'),
    logDir: join(data, 'logs'),
    url: 'http://127.0.0.1:65534',
    lockPath: join(data, 'a.lock'),
    defaultAgent: 'A',
    agents: {},
  };
  await writeFile(configAPath, JSON.stringify({ ...baseConfig }, null, 2));
  await writeFile(configBPath, JSON.stringify({ ...baseConfig, state: join(data, 'b-state.json'), lockPath: join(data, 'b.lock'), defaultAgent: 'B' }, null, 2));
  const runSentinel = (configPath, extraArgs = []) => spawn(process.execPath, [join(root, 'sentinel.mjs'), '--config', configPath, ...extraArgs], { stdio: ['ignore', 'pipe', 'pipe'] });
  const collect = (child, earlyPattern = null) => new Promise((resolveCollect) => {
    let text = '';
    const startedAt = Date.now();
    let done = false;
    const finish = (early) => {
      if (done) return;
      done = true;
      resolveCollect({ text, elapsedMs: early ? Date.now() - startedAt : null });
    };
    child.stdout.on('data', (c) => { text += c; if (earlyPattern && earlyPattern.test(text)) finish(true); });
    child.stderr.on('data', (c) => { text += c; if (earlyPattern && earlyPattern.test(text)) finish(true); });
    child.once('exit', () => finish(false));
  });
  // Both instances must be alive simultaneously, not merely start in sequence.
  const sentinelA = runSentinel(configAPath, ['--run-for', '8000']);
  t.after(async () => stop(sentinelA));
  const aExit = once(sentinelA, 'exit');
  assert.match((await collect(sentinelA, /哨兵启动/)).text, /哨兵启动/);
  const sentinelB = runSentinel(configBPath, ['--run-for', '8000']);
  t.after(async () => stop(sentinelB));
  const bExit = once(sentinelB, 'exit');
  assert.match((await collect(sentinelB, /哨兵启动/)).text, /哨兵启动/);
  assert.equal(sentinelA.exitCode, null, 'A 应仍在运行');
  assert.equal(sentinelB.exitCode, null, 'B 应仍在运行');
  const ownerA = JSON.parse(await readFile(join(data, 'a.lock'), 'utf8'));
  const ownerB = JSON.parse(await readFile(join(data, 'b.lock'), 'utf8'));
  assert.equal(ownerA.pid, sentinelA.pid);
  assert.equal(ownerB.pid, sentinelB.pid);

  const duplicate = spawnSync(process.execPath, [join(root, 'sentinel.mjs'), '--config', configAPath], { encoding: 'utf8', timeout: 15000 });
  assert.equal(duplicate.status, 3, '重复启动应 exit 3');
  assert.match(duplicate.stderr, new RegExp(`pid=${sentinelA.pid}`));
  const duplicateOnce = spawnSync(process.execPath, [join(root, 'sentinel.mjs'), '--config', configAPath, '--once'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(duplicateOnce.status, 3, '一次性哨兵也必须拒绝已有成员锁');

  assert.equal((await aExit)[0], 0, '正常退出应成功');
  assert.equal((await bExit)[0], 0, '正常退出应成功');
  await assert.rejects(readFile(join(data, 'a.lock'), 'utf8'), { code: 'ENOENT' });
  await assert.rejects(readFile(join(data, 'b.lock'), 'utf8'), { code: 'ENOENT' });
  const restart = runSentinel(configAPath, ['--once']);
  const restartOutput = await collect(restart);
  assert.equal(restart.exitCode, 0, restartOutput.text);
  await assert.rejects(readFile(join(data, 'a.lock'), 'utf8'), { code: 'ENOENT' });

  for (const pid of [process.pid, 999999]) {
    const forged = JSON.stringify({ ownerId: 'forged-uuid', pid, startedAt: 't', heartbeatAt: Date.now() - 60000 });
    await writeFile(join(data, 'a.lock'), forged, 'utf8');
    const attempts = [runSentinel(configAPath), runSentinel(configAPath)];
    const results = await Promise.all(attempts.map((child) => collect(child)));
    for (let i = 0; i < attempts.length; i++) {
      assert.equal(attempts[i].exitCode, 3, results[i].text);
      assert.match(results[i].text, /人工离线移除残留锁/);
    }
    assert.equal(await readFile(join(data, 'a.lock'), 'utf8'), forged, '陈旧锁不得被接管或修改');
  }
});

test('sentinel hot-update stage 1: config soft-reload next poll and cursor survives restart', { timeout: 90000 }, async t => {
  const data = await mkdtemp(join(tempRoot, 'hot-'));
  const runSentinel = (configPath, extraArgs = []) => spawn(process.execPath, [join(root, 'sentinel.mjs'), '--config', configPath, ...extraArgs], { stdio: ['ignore', 'pipe', 'pipe'] });
  const collect = (child, earlyPattern = null) => new Promise((resolveCollect) => {
    let text = '';
    const startedAt = Date.now();
    let done = false;
    const finish = (early) => {
      if (done) return;
      done = true;
      resolveCollect({ text, elapsedMs: early ? Date.now() - startedAt : null });
    };
    child.stdout.on('data', (c) => { text += c; if (earlyPattern && earlyPattern.test(text)) finish(true); });
    child.stderr.on('data', (c) => { text += c; if (earlyPattern && earlyPattern.test(text)) finish(true); });
    child.once('exit', () => finish(false));
  });
  const db = new DatabaseSync(join(data, 'chat.sqlite'));
  db.exec(`CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,"from" TEXT NOT NULL,"to" TEXT,text TEXT NOT NULL,createdAt TEXT NOT NULL,conversationId INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL,model TEXT,createdAt TEXT NOT NULL);
    INSERT INTO agents VALUES('a1','A','active','m1','2026-01-01T00:00:00.000Z');
    INSERT INTO messages VALUES(10,'admin',NULL,'first','2026-01-01T00:01:00.000Z',1)`);
  db.close();
  const configPath = join(data, 'hot.config.json');
  const writeConfig = (agents, defaultAgent = 'A') => writeFile(configPath, JSON.stringify({
    projectDir: root, db: join(data, 'chat.sqlite'), state: join(data, 'state.json'), logDir: join(data, 'logs'),
    url: 'http://127.0.0.1:65534', lockPath: join(data, 'lock'), defaultAgent, agents,
  }, null, 2));
  await writeConfig({ A: { identity: join(data, 'a.key'), model: 'm1' } });
  // 不可达服务导致发送结果不确定：保留待核对消息，重启后不盲目重发。
  const first = runSentinel(configPath, ['--once', '--after', '0']);
  const out1 = await collect(first);
  assert.match(out1.text, /发现 admin 消息 #10/, '应发现消息');
  const saved = JSON.parse(await readFile(join(data, 'state.json'), 'utf8'));
  assert.equal(saved.lastProcessed, 0);
  assert.equal(saved.pendingMessageId, 10);
  const second = spawnSync(process.execPath, [join(root, 'sentinel.mjs'), '--config', configPath, '--once'], { encoding: 'utf8', timeout: 30000 });
  assert.match(second.stdout + second.stderr, /结果不确定，已暂停/);
  const bypass = spawnSync(process.execPath, [join(root, 'sentinel.mjs'), '--config', configPath, '--once', '--after', '10'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(bypass.status, 3);
  assert.match(bypass.stderr, /禁止用 --after 覆盖/);
  assert.equal(JSON.parse(await readFile(join(data, 'state.json'), 'utf8')).pendingMessageId, 10);
  // 第三段：常驻实例运行中变更 config → 下一轮轮询软重载生效
  const third = runSentinel(configPath, ['--run-for', '6000']);
  t.after(async () => stop(third));
  await new Promise((r) => setTimeout(r, 1500));
  await writeConfig({ B: { identity: join(data, 'b.key'), model: 'm2' } }, 'B');
  const out3 = await collect(third, /config 软重载生效/);
  assert.match(out3.text, /config 软重载生效：agents=1 defaultAgent=B/, '运行中变更 config 应在下一轮软重载生效');
  await stop(third);
  await writeFile(join(data, 'state.json'), '{broken');
  const broken = spawnSync(process.execPath, [join(root, 'sentinel.mjs'), '--config', configPath, '--once'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(broken.status, 3);
  assert.equal(await readFile(join(data, 'state.json'), 'utf8'), '{broken');
  await writeFile(join(data, 'state.json'), '{"pendingMessageId":"10"}');
  const invalidState = spawnSync(process.execPath, [join(root, 'sentinel.mjs'), '--config', configPath, '--once'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(invalidState.status, 3);
  assert.equal(await readFile(join(data, 'state.json'), 'utf8'), '{"pendingMessageId":"10"}');
  const outOfOrderState = JSON.stringify({ lastProcessed: 0, completedOutOfOrder: [10], pendingMessageId: null });
  await writeFile(join(data, 'state.json'), outOfOrderState);
  const overwrite = spawnSync(process.execPath, [join(root, 'sentinel.mjs'), '--config', configPath, '--once', '--after', '10'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(overwrite.status, 3);
  assert.equal(await readFile(join(data, 'state.json'), 'utf8'), outOfOrderState);
  await writeFile(configPath, JSON.stringify({ projectDir: root, db: join(data, 'chat.sqlite'), state: join(data, 'new-state.json'), logDir: join(data, 'logs'), defaultAgent: 'A', execModel: '', promptSupplement: 'supplement-marker', agents: { A: { identity: join(data, 'a.key') } } }));
  const promptRun = spawnSync(process.execPath, [join(root, 'sentinel.mjs'), '--config', configPath, '--once', '--dry-run', '--after', '0'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(promptRun.status, 0, promptRun.stderr);
  assert.match(promptRun.stdout, /supplement-marker/);
});

test('sentinel applies changed prompt to the next message without restarting', { timeout: 30000 }, async t => {
  const data = await mkdtemp(join(tempRoot, 'prompt-reload-'));
  const db = new DatabaseSync(join(data, 'chat.sqlite'));
  db.exec(`CREATE TABLE messages(id INTEGER PRIMARY KEY,"from" TEXT NOT NULL,"to" TEXT,text TEXT NOT NULL,createdAt TEXT NOT NULL,conversationId INTEGER NOT NULL);
    CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL,model TEXT,createdAt TEXT NOT NULL);
    INSERT INTO agents VALUES('a','A','active','m','2026-01-01')`);
  const config = join(data, 'config.json');
  const base = { projectDir: root, db: join(data, 'chat.sqlite'), state: join(data, 'state.json'), logDir: join(data, 'logs'), defaultAgent: 'A', agents: { A: { identity: 'a' } } };
  await writeFile(config, JSON.stringify({ ...base, promptSupplement: 'old-marker' }));
  const child = spawn(process.execPath, [join(root, 'sentinel.mjs'), '--config', config, '--dry-run', '--run-for', '12000', '--after', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => stop(child));
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const until = async predicate => {
    const deadline = Date.now() + 8000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timed out: ${errors}`); await new Promise(resolveWait => setTimeout(resolveWait, 50)); }
  };
  await until(() => errors.includes('哨兵启动'));
  db.prepare('INSERT INTO messages VALUES(1,?,?,?,?,?)').run('admin', null, 'first', new Date().toISOString(), 1);
  await until(() => output.includes('old-marker'));
  await writeFile(config, JSON.stringify({ ...base, promptSupplement: 'new-marker' }));
  await until(() => errors.includes('config 软重载生效'));
  db.prepare('INSERT INTO messages VALUES(2,?,?,?,?,?)').run('admin', null, 'second', new Date().toISOString(), 1);
  await until(() => output.includes('new-marker'));
  assert.equal(child.exitCode, null);
  db.close();
});

test('sentinel prioritizes explicit mentions without expanding private routing', { timeout: 30000 }, async () => {
  const data = await mkdtemp(join(tempRoot, 'mentions-'));
  const db = new DatabaseSync(join(data, 'chat.sqlite'));
  db.exec(`CREATE TABLE messages(id INTEGER PRIMARY KEY,"from" TEXT NOT NULL,"to" TEXT,text TEXT NOT NULL,createdAt TEXT NOT NULL,conversationId INTEGER NOT NULL);
    CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL,model TEXT,createdAt TEXT NOT NULL);
    INSERT INTO agents VALUES('a','Alpha','active','m','2026-01-01'),('b','Beta','active','m','2026-01-02');
    INSERT INTO messages VALUES(1,'admin',NULL,'ordinary Alpha','2026-01-01',1),(2,'admin',NULL,'@Beta task','2026-01-01',1),(3,'admin','a','@Beta private','2026-01-01',1),(4,'admin',NULL,'@Alpha public','2026-01-01',1)`);
  db.close();
  const configPath = join(data, 'config.json');
  await writeFile(configPath, JSON.stringify({ projectDir: root, db: join(data, 'chat.sqlite'), state: join(data, 'state.json'), logDir: join(data, 'logs'), defaultAgent: 'Alpha', agents: { Alpha: { identity: 'a' }, Beta: { identity: 'b' } } }));
  const run = spawnSync(process.execPath, [join(root, 'sentinel.mjs'), '--config', configPath, '--once', '--dry-run', '--after', '0'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(run.status, 0, run.stderr);
  const records = [...run.stdout.matchAll(/"agent":\s*"([^"]+)"[\s\S]*?"messageId":\s*(\d+)/g)].map(match => [Number(match[2]), match[1]]);
  assert.deepEqual(records, [[2, 'Beta'], [3, 'Alpha'], [4, 'Alpha'], [1, 'Alpha']]);
  const prompts = [...run.stdout.matchAll(/"messageId":\s*(\d+),\s*"prompt":\s*("(?:[^"\\]|\\.)*")/g)];
  const publicPrompt = JSON.parse(prompts.find(match => Number(match[1]) === 4)[2]);
  assert.equal(publicPrompt.includes('@Beta private'), false);
});

test('sentinel dead-letter: failing worker retries then broadcasts dead-letter instead of silently dropping', { timeout: 60000 }, async t => {
  const server = await start();
  t.after(async () => stop(server.child));
  const admin = client(server, server.admin);
  await admin('/api/admin/registration', { open: true });
  const token = secret();
  const identityPath = join(dir, `dl-${Date.now()}.key`);
  await writeFile(identityPath, token, 'utf8');
  const joined = await client(server, token)('/api/join', { name: 'DL', token, model: 'model-dl' });
  await admin(`/api/admin/agents/${joined.agent.id}`, { status: 'active' });
  const posted = await admin('/api/messages', { text: 'DL dead-letter trigger' });
  const data = await mkdtemp(join(tempRoot, 'deadletter-'));
  const configPath = join(data, 'dl.config.json');
  await writeFile(configPath, JSON.stringify({
    projectDir: root,
    db: join(dir, 'chat.sqlite'),
    state: join(data, 'state.json'),
    logDir: join(data, 'logs'),
    url: server.url,
    lockPath: join(data, 'lock'),
    defaultAgent: 'DL',
    agents: {
      DL: {
        identity: identityPath,
        model: 'model-dl',
        worker: { command: process.execPath, args: ['-e', 'process.exit(2)'], input: 'stdin', output: 'stdout', timeoutMs: 10000 },
      },
    },
  }, null, 2));
  const run = spawnSync(process.execPath, [join(root, 'sentinel.mjs'), '--config', configPath, '--once', '--after', String(posted.message.id - 1)], { encoding: 'utf8', timeout: 45000 });
  assert.equal(run.status, 0, `哨兵应正常退出：${run.stderr.slice(-400)}`);
  const transcript = await client(server, token)('/api/messages?after=0');
  const dead = transcript.messages.filter((m) => m.from === joined.agent.id && m.text.startsWith('[死信]'));
  assert.equal(dead.length, 1, `应恰好广播一条死信：${JSON.stringify(transcript.messages)}`);
  assert.equal(dead[0].clientMessageId, `sentinel:${posted.message.id}`);
  assert.match(dead[0].text, new RegExp(`#${posted.message.id}`), '死信应引用消息 id');
  assert.match(dead[0].text, /worker 连续 2 次失败/, '死信应说明重试已耗尽');
  const observerToken = secret();
  const observer = client(server, observerToken);
  const observerId = (await observer('/api/join', { name: 'Observer', token: observerToken, model: 'model-observer' })).agent.id;
  await admin(`/api/admin/agents/${observerId}`, { status: 'active' });
  await observer('/api/messages', { text: 'observer confidential', to: 'admin' });
  await admin('/api/messages', { text: 'observer private request', to: observerId });
  const directed = await admin('/api/messages', { text: 'directed failure', to: joined.agent.id });
  const directedRun = spawnSync(process.execPath, [join(root, 'sentinel.mjs'), '--config', configPath, '--once', '--after', String(directed.message.id - 1)], { encoding: 'utf8', timeout: 45000 });
  assert.equal(directedRun.status, 0, directedRun.stderr);
  const privateDead = (await admin('/api/messages')).messages.find(m => m.from === joined.agent.id && m.text.includes(`#${directed.message.id}`));
  assert.equal(privateDead?.to, 'admin');
  assert.equal((await observer('/api/messages')).messages.some(m => m.id === privateDead.id), false);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.agents.DL.worker.args = ['-e', 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(s.includes("observer confidential")||s.includes("observer private request")?"privacy leak":"direct reply success"))'];
  await writeFile(configPath, JSON.stringify(config));
  const request = await admin('/api/messages', { text: 'directed success', to: joined.agent.id });
  const successRun = spawnSync(process.execPath, [join(root, 'sentinel.mjs'), '--config', configPath, '--once', '--after', String(request.message.id - 1)], { encoding: 'utf8', timeout: 45000 });
  assert.equal(successRun.status, 0, successRun.stderr);
  const reply = (await admin('/api/messages')).messages.find(m => m.from === joined.agent.id && m.text.trim() === 'direct reply success');
  assert.equal(reply?.to, 'admin');
  assert.equal(reply.replyTo, request.message.id);
  await observer('/api/messages', { text: 'cannot reference', replyTo: request.message.id }, 404);
  await client(server, token)('/api/messages', { text: 'cannot broadcast private', replyTo: request.message.id }, 400);
  assert.equal((await observer('/api/messages')).messages.some(m => m.id === reply.id), false);
});

test('administrator private text never becomes a title visible to other members', async t => {
  const isolated = await mkdtemp(join(tempRoot, 'private-title-'));
  const server = await start(isolated);
  t.after(async () => stop(server.child));
  const admin = client(server, server.admin);
  const recipientToken = secret(), observerToken = secret();
  const recipient = client(server, recipientToken), observer = client(server, observerToken);
  await admin('/api/admin/registration', { open: true });
  const recipientId = (await recipient('/api/join', { name: 'PrivateRecipient', token: recipientToken, model: 'privacy-test' })).agent.id;
  const observerId = (await observer('/api/join', { name: 'UnrelatedObserver', token: observerToken, model: 'privacy-test' })).agent.id;
  for (const id of [recipientId, observerId]) await admin(`/api/admin/agents/${id}`, { status: 'active' });
  const before = (await observer('/api/conversations')).conversations.find(conversation => conversation.id === 1).title;
  await admin('/api/messages', { conversationId: 1, to: recipientId, text: 'PRIVATE_ADMIN_TITLE_CANARY' });
  assert.equal((await observer('/api/conversations')).conversations.find(conversation => conversation.id === 1).title, before);
  assert.deepEqual((await observer('/api/messages')).messages, []);
  assert.equal((await recipient('/api/messages')).messages[0].text, 'PRIVATE_ADMIN_TITLE_CANARY');
  await admin('/api/messages', { conversationId: 1, text: 'Public task title' });
  assert.equal((await observer('/api/conversations')).conversations.find(conversation => conversation.id === 1).title, 'Public task title');
});
