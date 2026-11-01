import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createGroupTools } from './group-tools.mjs';
import { registerERC20Tools } from './erc20-tools.mjs';

// Run by node --test in its normal per-file process isolation. No server,
// subprocess, wallet, filesystem data store or actual RPC connection is used.
const TOKEN = `0x${'11'.repeat(20)}`;
const RECIPIENT = `0x${'22'.repeat(20)}`;
const OTHER = `0x${'33'.repeat(20)}`;
const TX = `0x${'44'.repeat(32)}`;
const BLOCK = `0x${'55'.repeat(32)}`;
const OTHER_BLOCK = `0x${'66'.repeat(32)}`;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const config = {
  chainId: 1, rpcUrl: 'https://rpc.example.org/ethereum', tokenAddress: TOKEN,
  recipientAddress: RECIPIENT, decimals: 6, symbol: 'USDT', confirmations: 3,
};
const word = value => `0x${BigInt(value).toString(16).padStart(64, '0')}`;
const topicAddress = value => `0x${value.slice(2).padStart(64, '0')}`;
const conflict = statusCode => error => error instanceof Error && error.statusCode === statusCode;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function withPayments(run) {
  const originalFetch = globalThis.fetch;
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON; CREATE TABLE conversations (id INTEGER PRIMARY KEY); INSERT INTO conversations VALUES (1),(2);');
    const actors = new Map([
      ['admin', { id: 'admin', admin: true, status: 'active' }],
      ['alice', { id: 'alice', admin: false, status: 'active' }],
      ['bob', { id: 'bob', admin: false, status: 'active' }],
    ]);
    let activeConversationId = 1;
    const read = (args, actor) => {
      if (!Number.isSafeInteger(args.conversationId) || args.conversationId < 1) throw new TypeError('Invalid conversationId.');
      const current = actors.get(actor.id);
      if (!current || (!current.admin && !['active', 'paused'].includes(current.status))) throw Object.assign(new Error('Access denied.'), { statusCode: 403 });
      if (!db.prepare('SELECT id FROM conversations WHERE id = ?').get(args.conversationId)) throw Object.assign(new Error('Missing conversation.'), { statusCode: 404 });
      return args.conversationId;
    };
    const registry = createGroupTools();
    registerERC20Tools(registry, {
      db, read,
      write(args, actor) {
        const conversationId = read(args, actor);
        const current = actors.get(actor.id);
        if (!current.admin && current.status !== 'active') throw Object.assign(new Error('Write denied.'), { statusCode: 403 });
        if (conversationId !== activeConversationId) throw Object.assign(new Error('Conversation changed.'), { statusCode: 409 });
        return conversationId;
      },
    });
    registry.seal();
    const state = {
      chainId: '0x1', decimals: word(6), head: '0x66', canonicalHash: BLOCK,
      receipt: {
        transactionHash: TX, blockNumber: '0x64', blockHash: BLOCK, status: '0x1',
        logs: [{
          address: TOKEN, topics: [TRANSFER, topicAddress(OTHER), topicAddress(RECIPIENT)],
          data: word(1250000), transactionHash: TX, blockNumber: '0x64', blockHash: BLOCK,
          logIndex: '0x0', removed: false,
        }],
      },
      hook: null,
    };
    const calls = [];
    globalThis.fetch = async (url, options) => {
      // Installing this before any tool invocation makes accidental real network
      // impossible, including invalid configuration tests.
      assert.equal(typeof url, 'string');
      assert.equal(options.redirect, 'error');
      assert.equal(options.method, 'POST');
      assert.ok(options.signal instanceof AbortSignal);
      const body = JSON.parse(options.body);
      assert.equal(body.jsonrpc, '2.0');
      assert.equal(body.id, 1);
      const call = { url, options, ...body };
      calls.push(call);
      if (state.hook) await state.hook(call);
      let result;
      switch (body.method) {
        case 'eth_chainId': result = state.chainId; break;
        case 'eth_call':
          assert.equal(body.params[0].data, '0x313ce567');
          assert.equal(body.params[1], 'latest');
          result = state.decimals;
          break;
        case 'eth_getTransactionReceipt': result = state.receipt; break;
        case 'eth_getBlockByNumber':
          assert.deepEqual(body.params, ['0x64', false]);
          result = { number: '0x64', hash: state.canonicalHash };
          break;
        case 'eth_blockNumber': result = state.head; break;
        default: assert.fail(`Unexpected network operation: ${body.method}`);
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const invoke = (name, args = {}, owner = 'alice') => registry.invoke(name, { conversationId: 1, ...args }, actors.get(owner));
    const configure = (overrides = {}, conversationId = 1) => invoke('payment.configure', { ...config, ...overrides, conversationId }, 'admin');
    let sequence = 0;
    const create = (overrides = {}, owner = 'alice') => invoke('payment.create', { amount: '1.25', payerAddress: OTHER, clientRequestId: `request-${++sequence}`, ...overrides }, owner);
    const verify = (request, overrides = {}, owner = 'alice') => invoke('payment.verify', { requestId: request.requestId, txHash: TX, ...overrides }, owner);
    await run({ db, registry, actors, state, calls, invoke, configure, create, verify, setActive: value => { activeConversationId = value; } });
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
}

test('payment discovery has complete flat schemas and strict fields', async () => {
  await withPayments(async ({ registry, actors, configure, invoke }) => {
    const tools = registry.list(actors.get('admin')).filter(tool => tool.name.startsWith('payment.'));
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['payment.config', 'payment.configure', 'payment.create', 'payment.list', 'payment.verify']);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.deepEqual(tool.inputSchema.required.sort(), Object.keys(tool.inputSchema.properties).sort());
      assert.ok(Object.values(tool.inputSchema.properties).every(property => property.type !== 'object'));
    }
    await assert.rejects(configure({ unexpected: true }), TypeError);
    await assert.rejects(invoke('payment.config', { unexpected: true }), TypeError);
    await assert.rejects(invoke('payment.list', { conversationId: '1' }), TypeError);
    await assert.rejects(invoke('payment.create', { amount: '1' }), TypeError);
    await assert.rejects(invoke('payment.verify', { requestId: 'not-a-uuid', txHash: TX }), TypeError);
  });
});

test('payment configure verifies chain and exact ABI decimals before saving', async () => {
  await withPayments(async ({ state, configure, invoke, calls }) => {
    assert.equal((await invoke('payment.config')).config, null);
    state.chainId = '0x2';
    await assert.rejects(configure(), conflict(409));
    assert.equal(calls.length, 1);
    state.chainId = '0x1';
    state.decimals = word(18);
    await assert.rejects(configure(), conflict(409));
    state.decimals = '0x06';
    await assert.rejects(configure(), conflict(409));
    assert.equal((await invoke('payment.config')).config, null);
    state.decimals = word(6);
    const result = await configure();
    assert.equal(result.config.decimals, 6);
    assert.equal(result.config.rpcUrl, config.rpcUrl);
    assert.equal(calls.at(-1).options.signal, calls.at(-2).options.signal, 'configuration calls share a single timeout budget');
    const member = await invoke('payment.config');
    assert.equal(Object.hasOwn(member.config, 'rpcUrl'), false);
    state.chainId = '0x2';
    await assert.rejects(configure({ symbol: 'NEW' }), conflict(409));
    assert.equal((await invoke('payment.config')).config.symbol, 'USDT');
  });
});

test('payment configure rejects local/private literals, credentials, malformed addresses and values without network', async () => {
  await withPayments(async ({ configure, calls }) => {
    const invalidUrls = [
      'http://rpc.example.org/', 'https://localhost/', 'https://a.localhost/',
      'https://127.0.0.1/', 'https://127.1/', 'https://0x7f000001/',
      'https://10.0.0.1/', 'https://172.16.0.1/', 'https://192.168.1.1/',
      'https://169.254.169.254/', 'https://100.64.0.1/', 'https://[::1]/',
      'https://[fc00::1]/', 'https://[fe80::1]/', 'https://[::ffff:127.0.0.1]/',
      'https://user:pass@rpc.example.org/', 'https://@rpc.example.org/',
      'https://rpc.example.org/?', 'https://rpc.example.org/#',
    ];
    for (const rpcUrl of invalidUrls) await assert.rejects(configure({ rpcUrl }), TypeError, rpcUrl);
    for (const override of [
      { chainId: 0 }, { chainId: Number.MAX_SAFE_INTEGER + 1 }, { decimals: 37 },
      { decimals: -1 }, { confirmations: 0 }, { confirmations: 257 },
      { tokenAddress: `0x${'00'.repeat(20)}` }, { recipientAddress: '0x1234' },
      { symbol: '' }, { symbol: 'TOO LONG TOKEN SYMBOL' },
    ]) await assert.rejects(configure(override), TypeError);
    assert.equal(calls.length, 0);
  });
});

test('payment uses exact BigInt units, uint256 bounds and EIP-681; idempotency retains immutable snapshots', async () => {
  await withPayments(async ({ configure, create, state, invoke }) => {
    await configure();
    const first = (await create({ amount: '12345678901234567890.123456', clientRequestId: 'stable' })).request;
    assert.equal(first.units, '12345678901234567890123456');
    assert.equal(first.paymentUri, `ethereum:${TOKEN}@1/transfer?address=${RECIPIENT}&uint256=12345678901234567890123456`);
    const retry = (await create({ amount: '12345678901234567890.123456', clientRequestId: 'stable' })).request;
    assert.equal(retry.requestId, first.requestId);
    await assert.rejects(create({ amount: '1.25', clientRequestId: 'stable' }), conflict(409));
    await assert.rejects(create({ amount: '12345678901234567890.123456', payerAddress: TOKEN, clientRequestId: 'stable' }), conflict(409));
    for (const amount of ['0', '-1', '1e6', '.1', '01', '1.', '1.0000001', ' 1', 'NaN']) await assert.rejects(create({ amount }), TypeError, amount);
    state.decimals = word(0);
    await configure({ decimals: 0, symbol: 'NEW', recipientAddress: OTHER });
    const maximum = ((1n << 256n) - 1n).toString();
    assert.equal((await create({ amount: maximum })).request.units, maximum);
    await assert.rejects(create({ amount: (1n << 256n).toString() }), TypeError);
    const listed = (await invoke('payment.list')).requests.find(row => row.requestId === first.requestId);
    assert.equal(listed.config.decimals, 6);
    assert.equal(listed.config.recipientAddress, RECIPIENT);
    assert.equal(listed.config.symbol, 'USDT');
    assert.equal(listed.config.payerAddress, OTHER);
    assert.equal(listed.units, first.units);
    assert.equal(Object.hasOwn(listed.config, 'rpcUrl'), false);
    assert.equal((await create({ amount: '12345678901234567890.123456', clientRequestId: 'stable' })).request.requestId, first.requestId);
  });
});

test('payment ownership, conversation isolation, paused writes and list cap', async () => {
  await withPayments(async ({ configure, create, verify, invoke, setActive, actors }) => {
    await configure();
    const alice = (await create()).request;
    const bob = (await create({}, 'bob')).request;
    assert.deepEqual((await invoke('payment.list')).requests.map(row => row.requestId), [alice.requestId]);
    assert.equal((await invoke('payment.list', {}, 'admin')).requests.length, 2);
    assert.equal((await invoke('payment.list', {}, 'admin')).requests[0].config.rpcUrl, config.rpcUrl);
    await assert.rejects(verify(bob), conflict(404));
    await assert.rejects(invoke('payment.configure', config), /permission denied/i);
    assert.equal((await invoke('payment.config', { conversationId: 2 })).config, null);
    assert.deepEqual((await invoke('payment.list', { conversationId: 2 })).requests, []);
    setActive(2);
    await assert.rejects(verify(alice), conflict(409));
    await assert.rejects(verify(alice, { conversationId: 2 }), conflict(404));
    await configure({}, 2);
    const second = (await create({ conversationId: 2 })).request;
    assert.equal(second.conversationId, 2);
    assert.equal((await invoke('payment.list')).requests.length, 1, 'historical read stays in requested conversation');
    setActive(1);
    actors.get('alice').status = 'paused';
    assert.equal((await invoke('payment.list')).requests.length, 1);
    await assert.rejects(create(), /permission denied/i);
    await assert.rejects(verify(alice), /permission denied/i);
    actors.get('alice').status = 'active';
    for (let i = 0; i < 51; i++) await create();
    const list = (await invoke('payment.list')).requests;
    assert.equal(list.length, 50);
    assert.equal(list.some(row => row.requestId === alice.requestId), false);
  });
});

test('payment verifies a successful exact transfer and always rechecks paid orders', async () => {
  await withPayments(async ({ configure, create, verify, calls, state }) => {
    await configure();
    const request = (await create()).request;
    calls.length = 0;
    const paid = (await verify(request)).request;
    assert.equal(paid.status, 'paid');
    assert.equal(paid.verification.confirmations, '3');
    assert.equal(paid.verification.logIndex, '0');
    assert.deepEqual(calls.map(call => call.method), ['eth_chainId', 'eth_getTransactionReceipt', 'eth_getBlockByNumber', 'eth_blockNumber']);
    assert.ok(calls.every(call => call.options.signal === calls[0].options.signal), 'all verification calls share one timeout');
    calls.length = 0;
    assert.equal((await verify(request)).request.status, 'paid');
    assert.equal(calls.length, 4, 'paid does not bypass chain lookup');
    state.canonicalHash = OTHER_BLOCK;
    const reorg = (await verify(request)).request;
    assert.equal(reorg.status, 'pending');
    assert.equal(reorg.verification.reason, 'noncanonical_block');
  });
});

test('payment requires configured confirmations and can recover pending orders', async () => {
  await withPayments(async ({ configure, create, verify, state }) => {
    await configure();
    const request = (await create()).request;
    state.head = '0x65';
    const pending = (await verify(request)).request;
    assert.equal(pending.status, 'pending');
    assert.equal(pending.verification.reason, 'insufficient_confirmations');
    assert.equal(pending.verification.confirmations, '2');
    state.head = '0x66';
    assert.equal((await verify(request)).request.status, 'paid');
    state.receipt = null;
    assert.equal((await verify(request)).request.status, 'pending');
  });
});

test('payment does not reserve an insufficiently confirmed transfer against another order', async () => {
  await withPayments(async ({ configure, create, verify, state, db, invoke }) => {
    await configure();
    const first = (await create()).request;
    state.head = '0x65';
    const pending = (await verify(first)).request;
    assert.equal(pending.status, 'pending');
    assert.equal(pending.verification.reason, 'insufficient_confirmations');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM payment_transfer_claims').get().count, 0);
    const second = (await create({}, 'bob')).request;
    state.head = '0x66';
    assert.equal((await verify(second, {}, 'bob')).request.status, 'paid');
    await assert.rejects(verify(first), conflict(409));
    assert.equal((await invoke('payment.list')).requests[0].status, 'pending');
    assert.equal(db.prepare('SELECT requestId FROM payment_transfer_claims').get().requestId, second.requestId);
  });
});

test('payment confirmed transfer identity survives unrelated hashes and failed original rechecks', async () => {
  await withPayments(async ({ configure, create, verify, state, db, calls, invoke }) => {
    await configure();
    const request = (await create()).request;
    const paid = (await verify(request)).request;
    const before = db.prepare('SELECT * FROM payment_requests WHERE requestId = ?').get(request.requestId);
    const callCount = calls.length;
    await assert.rejects(verify(request, { txHash: OTHER_BLOCK }), conflict(409));
    assert.equal(calls.length, callCount, 'an unrelated hash is rejected before RPC');
    assert.deepEqual(db.prepare('SELECT * FROM payment_requests WHERE requestId = ?').get(request.requestId), before);
    assert.deepEqual((await invoke('payment.list')).requests[0].verification, paid.verification);
    state.hook = call => {
      if (call.method === 'eth_getTransactionReceipt') throw new Error('Unavailable RPC');
    };
    await assert.rejects(verify(request), conflict(502));
    const pending = (await invoke('payment.list')).requests[0];
    assert.equal(pending.status, 'pending');
    assert.equal(pending.verification.reason, 'rpc_error');
    assert.equal(pending.verification.txHash, TX);
    assert.equal(pending.verification.logIndex, '0');
    const failed = db.prepare('SELECT * FROM payment_requests WHERE requestId = ?').get(request.requestId);
    await assert.rejects(verify(request, { txHash: OTHER_BLOCK }), conflict(409));
    assert.deepEqual(db.prepare('SELECT * FROM payment_requests WHERE requestId = ?').get(request.requestId), failed);
    state.hook = null;
    const second = (await create()).request;
    await assert.rejects(verify(second), conflict(409), 'RPC failure must not release a previously confirmed transfer');
    assert.equal((await verify(request)).request.status, 'paid');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM payment_transfer_claims').get().count, 1);
  });
});

test('payment rechecks its original log without consuming another matching transfer', async () => {
  await withPayments(async ({ configure, create, verify, state, db }) => {
    await configure();
    const firstLog = structuredClone(state.receipt.logs[0]);
    const secondLog = { ...structuredClone(firstLog), logIndex: '0x1' };
    state.receipt.logs = [secondLog, firstLog];
    const first = (await create()).request;
    assert.equal((await verify(first)).request.verification.logIndex, '0');
    state.receipt.logs = [secondLog];
    const rechecked = (await verify(first)).request;
    assert.equal(rechecked.status, 'pending');
    assert.equal(rechecked.verification.reason, 'transfer_not_found');
    assert.equal(rechecked.verification.logIndex, '0');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM payment_transfer_claims').get().count, 1);
    const second = (await create({}, 'bob')).request;
    const otherPayment = (await verify(second, {}, 'bob')).request;
    assert.equal(otherPayment.status, 'paid');
    assert.equal(otherPayment.verification.logIndex, '1');
    state.receipt.logs = [secondLog, firstLog];
    const restored = (await verify(first)).request;
    assert.equal(restored.status, 'paid');
    assert.equal(restored.verification.logIndex, '0');
    assert.equal((await verify(second, {}, 'bob')).request.verification.logIndex, '1');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM payment_transfer_claims').get().count, 2);
  });
});

test('payment preserves recorded legacy claim identity and never releases historical claims', async () => {
  await withPayments(async ({ configure, create, verify, state, db }) => {
    await configure();
    const request = (await create()).request;
    const paid = (await verify(request)).request;
    db.prepare('INSERT INTO payment_transfer_claims (chainId,txHash,logIndex,conversationId,requestId) VALUES (?,?,?,?,?)').run(1, TX, '1', 1, request.requestId);
    db.prepare('UPDATE payment_requests SET verificationJson = ? WHERE requestId = ?').run(JSON.stringify({ ...paid.verification, logIndex: '1' }), request.requestId);
    const receipt = structuredClone(state.receipt);
    receipt.logs.push({ ...structuredClone(receipt.logs[0]), logIndex: '0x1' });
    state.receipt = null;
    const pending = (await verify(request)).request;
    assert.equal(pending.status, 'pending');
    assert.equal(pending.verification.logIndex, '1');
    state.receipt = receipt;
    const restored = (await verify(request)).request;
    assert.equal(restored.status, 'paid');
    assert.equal(restored.verification.logIndex, '1');
    const second = (await create()).request;
    await assert.rejects(verify(second), conflict(409));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM payment_transfer_claims').get().count, 2);
  });
});

test('payment never pays incorrect chain/status/contract/recipient/amount/topic/canonical metadata', async t => {
  const cases = [
    ['wrong chain', state => { state.chainId = '0x2'; }],
    ['failed receipt', state => { state.receipt.status = '0x0'; }],
    ['wrong contract', state => { state.receipt.logs[0].address = OTHER; }],
    ['wrong recipient', state => { state.receipt.logs[0].topics[2] = topicAddress(OTHER); }],
    ['wrong sender', state => { state.receipt.logs[0].topics[1] = topicAddress(TOKEN); }],
    ['wrong amount', state => { state.receipt.logs[0].data = word(1250001); }],
    ['wrong event', state => { state.receipt.logs[0].topics[0] = TX; }],
    ['removed log', state => { state.receipt.logs[0].removed = true; }],
    ['short uint256', state => { state.receipt.logs[0].data = '0x1312d0'; }],
    ['noncanonical block', state => { state.canonicalHash = OTHER_BLOCK; }],
    ['head behind receipt', state => { state.head = '0x63'; }],
    ['missing receipt', state => { state.receipt = null; }],
  ];
  for (const [name, change] of cases) await t.test(name, async () => {
    await withPayments(async ({ configure, create, verify, state }) => {
      await configure();
      const request = (await create()).request;
      change(state);
      assert.equal((await verify(request)).request.status, 'pending');
    });
  });
});

test('payment rejects transaction/log metadata inconsistencies and duplicate receipt indices', async t => {
  const cases = [
    ['receipt tx mismatch', state => { state.receipt.transactionHash = OTHER_BLOCK; }],
    ['log tx mismatch', state => { state.receipt.logs[0].transactionHash = OTHER_BLOCK; }],
    ['log block mismatch', state => { state.receipt.logs[0].blockHash = OTHER_BLOCK; }],
    ['log number mismatch', state => { state.receipt.logs[0].blockNumber = '0x63'; }],
    ['duplicate matching logIndex', state => { state.receipt.logs.push(structuredClone(state.receipt.logs[0])); }],
  ];
  for (const [name, change] of cases) await t.test(name, async () => {
    await withPayments(async ({ configure, create, verify, invoke, state }) => {
      await configure();
      const request = (await create()).request;
      assert.equal((await verify(request)).request.status, 'paid');
      change(state);
      await assert.rejects(verify(request), conflict(502));
      assert.equal((await invoke('payment.list')).requests[0].status, 'pending');
    });
  });
});

test('payment transfer claim cannot be replayed across orders, owners or conversations', async () => {
  await withPayments(async ({ configure, create, verify, invoke, setActive }) => {
    await configure();
    const first = (await create()).request;
    assert.equal((await verify(first)).request.status, 'paid');
    const second = (await create()).request;
    await assert.rejects(verify(second), conflict(409));
    const bob = (await create({}, 'bob')).request;
    await assert.rejects(verify(bob, {}, 'bob'), conflict(409));
    assert.equal((await invoke('payment.list')).requests.find(row => row.requestId === second.requestId).status, 'pending');
    setActive(2);
    await configure({}, 2);
    const anotherConversation = (await create({ conversationId: 2 })).request;
    await assert.rejects(verify(anotherConversation, { conversationId: 2 }), conflict(409));
  });
});

test('payment RPC timeout after paid fails closed, redacts remote errors and leaves pending', async () => {
  await withPayments(async ({ configure, create, verify, invoke, state }) => {
    await configure();
    const request = (await create()).request;
    assert.equal((await verify(request)).request.status, 'paid');
    state.hook = call => {
      if (call.method === 'eth_getTransactionReceipt') throw new DOMException('Timeout connecting to private-secret-host', 'TimeoutError');
    };
    await assert.rejects(verify(request), error => error.statusCode === 502 && !error.message.includes('private-secret-host'));
    const pending = (await invoke('payment.list')).requests[0];
    assert.equal(pending.status, 'pending');
    assert.equal(pending.verification.reason, 'rpc_error');
  });
});

test('payment rechecks active conversation and current authorization after asynchronous RPC', async t => {
  for (const mode of ['switch', 'pause', 'revoke']) await t.test(mode, async () => {
    await withPayments(async ({ configure, create, verify, state, setActive, actors, db }) => {
      await configure();
      const request = (await create()).request;
      const entered = deferred();
      const release = deferred();
      state.hook = async call => {
        if (call.method === 'eth_getTransactionReceipt') { entered.resolve(); await release.promise; }
      };
      const pending = verify(request);
      await entered.promise;
      if (mode === 'switch') setActive(2);
      else actors.get('alice').status = mode === 'pause' ? 'paused' : 'revoked';
      release.resolve();
      await assert.rejects(pending, conflict(mode === 'switch' ? 409 : 403));
      const row = db.prepare('SELECT status,verificationJson,revision FROM payment_requests WHERE conversationId = ? AND requestId = ?').get(1, request.requestId);
      assert.equal(row.status, 'pending');
      assert.equal(row.verificationJson, null);
      assert.equal(row.revision, 0);
    });
  });
});

test('payment concurrent verification cannot overwrite a newer revision with stale result', async () => {
  await withPayments(async ({ configure, create, verify, state, invoke }) => {
    await configure();
    const request = (await create()).request;
    const entered = deferred();
    const release = deferred();
    let first = true;
    state.hook = async call => {
      if (call.method === 'eth_getTransactionReceipt' && first) {
        first = false;
        entered.resolve();
        await release.promise;
      }
    };
    const stale = verify(request);
    await entered.promise;
    assert.equal((await verify(request)).request.status, 'paid');
    state.receipt = null;
    release.resolve();
    await assert.rejects(stale, error => error.statusCode === 409 && /concurrently/.test(error.message));
    assert.equal((await invoke('payment.list')).requests[0].status, 'paid');
  });
});

test('payment configure rechecks conversation after RPC and does not save into another chat', async () => {
  await withPayments(async ({ configure, state, setActive, db }) => {
    const entered = deferred();
    const release = deferred();
    state.hook = async call => {
      if (call.method === 'eth_call') { entered.resolve(); await release.promise; }
    };
    const configuring = configure();
    await entered.promise;
    setActive(2);
    release.resolve();
    await assert.rejects(configuring, conflict(409));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM payment_config').get().count, 0);
  });
});

test('payment shared timeout signal aborts verification and invalidates previous paid state', async t => {
  await withPayments(async ({ configure, create, verify, state, invoke }) => {
    await configure();
    const request = (await create()).request;
    assert.equal((await verify(request)).request.status, 'paid');
    t.mock.method(AbortSignal, 'timeout', milliseconds => {
      assert.equal(milliseconds, 9000);
      return AbortSignal.abort(new DOMException('Test deadline expired', 'TimeoutError'));
    });
    try {
      state.hook = call => call.options.signal.throwIfAborted();
      await assert.rejects(verify(request), conflict(502));
      const result = (await invoke('payment.list')).requests[0];
      assert.equal(result.status, 'pending');
      assert.equal(result.verification.reason, 'rpc_error');
    } finally { t.mock.restoreAll(); }
  });
});

test('payment validates required payerAddress and does not add payer to global configuration', async () => {
  await withPayments(async ({ configure, create, invoke }) => {
    await configure();
    await assert.rejects(invoke('payment.create', { amount: '1', clientRequestId: 'missing-payer' }), TypeError);
    for (const payerAddress of ['0x1234', `0x${'00'.repeat(20)}`, null, 1]) await assert.rejects(create({ payerAddress }), TypeError);
    assert.equal(Object.hasOwn((await invoke('payment.config')).config, 'payerAddress'), false);
  });
});

test('payment different declared sender cannot consume transfer before a matching sender order', async () => {
  await withPayments(async ({ configure, create, verify, db }) => {
    await configure();
    const wrongPayer = (await create({ payerAddress: TOKEN }, 'bob')).request;
    const rejected = (await verify(wrongPayer, {}, 'bob')).request;
    assert.equal(rejected.status, 'pending');
    assert.equal(rejected.verification.reason, 'transfer_not_found');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM payment_transfer_claims').get().count, 0);
    const correctPayer = (await create()).request;
    assert.equal((await verify(correctPayer)).request.status, 'paid');
  });
});

test('payment legacy order without payerAddress cannot remain paid', async () => {
  await withPayments(async ({ configure, create, verify, db }) => {
    await configure();
    const request = (await create()).request;
    assert.equal((await verify(request)).request.status, 'paid');
    const row = db.prepare('SELECT configJson FROM payment_requests WHERE conversationId = ? AND requestId = ?').get(1, request.requestId);
    const snapshot = JSON.parse(row.configJson);
    delete snapshot.payerAddress;
    db.prepare('UPDATE payment_requests SET configJson = ? WHERE conversationId = ? AND requestId = ?').run(JSON.stringify(snapshot), 1, request.requestId);
    const legacy = (await verify(request)).request;
    assert.equal(legacy.status, 'pending');
    assert.equal(legacy.verification.reason, 'transfer_not_found');
  });
});
