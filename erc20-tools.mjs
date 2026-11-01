import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const MAX_UNITS = (1n << 256n) - 1n;
const RPC_TIMEOUT_MS = 9000;
const RPC_MAX_BYTES = 2 * 1024 * 1024;
const conversationProperty = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const addressProperty = { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$', description: '非零 EVM 地址。' };
const requestProperty = { type: 'string', format: 'uuid' };

function failure(message, statusCode = 409) {
  return Object.assign(new Error(message), { statusCode });
}

function fields(args, names) {
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || Reflect.ownKeys(args).some(key => typeof key !== 'string' || !names.includes(key))
    || names.some(key => !Object.hasOwn(args, key))) throw new TypeError(`Expected exactly: ${names.join(', ')}.`);
  integer(args.conversationId, 'conversationId', 1, Number.MAX_SAFE_INTEGER);
}

function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`Invalid ${name}.`);
  return value;
}

function address(value, name) {
  if (typeof value !== 'string' || !ADDRESS.test(value) || /^0x0{40}$/i.test(value)) throw new TypeError(`Invalid ${name}.`);
  return value.toLowerCase();
}

function rpcUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || value !== value.trim()
    || /[\s\\]/.test(value)) throw new TypeError('Invalid rpcUrl.');
  let url;
  try { url = new URL(value); } catch { throw new TypeError('Invalid rpcUrl.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || /^https:\/\/[^/]*@/i.test(value) || value.includes('?') || value.includes('#') || !url.hostname) throw new TypeError('rpcUrl requires HTTPS without credentials, query, or fragment.');
  const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'localhost.localdomain') throw new TypeError('Local RPC addresses are forbidden.');
  const version = isIP(host);
  if (version === 4) {
    const [a, b, c] = host.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113)) throw new TypeError('Private or reserved RPC addresses are forbidden.');
  } else if (version === 6) {
    // Only native globally routable IPv6 literals; reject mapped/transition,
    // loopback, link-local, unique-local, multicast and documentation ranges.
    const first = Number.parseInt(host.split(':')[0], 16);
    if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff || first === 0x2002
      || /^2001:(?:0:|:|db8(?::|$)|0?10(?::|$)|0?20(?::|$))/i.test(host)) throw new TypeError('Private or reserved RPC addresses are forbidden.');
  }
  return url.href;
}

function unitsFor(amount, decimals) {
  if (typeof amount !== 'string' || amount.length > 120 || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(amount)) throw new TypeError('amount must be a positive plain decimal string.');
  const [whole, fraction = ''] = amount.split('.');
  if (fraction.length > decimals) throw new TypeError('amount exceeds the token decimal precision.');
  const units = BigInt(whole) * (10n ** BigInt(decimals)) + BigInt((fraction || '0').padEnd(decimals, '0'));
  if (units <= 0n || units > MAX_UNITS) throw new TypeError('amount is outside the positive uint256 range.');
  return units.toString();
}

function quantity(value, label) {
  if (typeof value !== 'string' || !QUANTITY.test(value) || value.length > 66) throw failure(`RPC returned invalid ${label}.`, 502);
  return BigInt(value);
}

async function rpc(url, method, params, signal) {
  try {
    const response = await fetch(url, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Unsuccessful HTTP response.');
    }
    if (!response.body) throw new Error('Empty RPC response.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let size = 0;
    let text = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > RPC_MAX_BYTES) {
          await reader.cancel();
          throw new Error('RPC response exceeds size limit.');
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    const payload = JSON.parse(text);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.jsonrpc !== '2.0'
      || payload.id !== 1 || Object.hasOwn(payload, 'error') || !Object.hasOwn(payload, 'result')) throw new Error('Malformed or unsuccessful JSON-RPC response.');
    return payload.result;
  } catch {
    // Do not expose RPC credentials/path, remote error bodies or internal hosts.
    throw failure(`RPC ${method} failed; payment was not confirmed.`, 502);
  }
}

async function verifyReceipt(config, txHash) {
  const signal = AbortSignal.timeout(RPC_TIMEOUT_MS);
  const chain = quantity(await rpc(config.rpcUrl, 'eth_chainId', [], signal), 'chainId');
  if (chain !== BigInt(config.chainId)) return { reason: 'chain_mismatch', matches: [] };
  const receipt = await rpc(config.rpcUrl, 'eth_getTransactionReceipt', [txHash], signal);
  if (receipt === null) return { reason: 'receipt_not_found', matches: [] };
  if (!receipt || typeof receipt !== 'object' || !HASH.test(receipt.transactionHash ?? '')
    || receipt.transactionHash.toLowerCase() !== txHash || !HASH.test(receipt.blockHash ?? '')
    || !Array.isArray(receipt.logs)) throw failure('RPC returned an invalid transaction receipt.', 502);
  const blockNumber = quantity(receipt.blockNumber, 'receipt blockNumber');
  const status = quantity(receipt.status, 'receipt status');
  if (status !== 1n) return { reason: 'transaction_failed', matches: [] };
  const blockHash = receipt.blockHash.toLowerCase();
  const block = await rpc(config.rpcUrl, 'eth_getBlockByNumber', [receipt.blockNumber, false], signal);
  if (block === null) return { reason: 'noncanonical_block', matches: [] };
  if (!block || typeof block !== 'object' || !HASH.test(block.hash ?? '')) throw failure('RPC returned an invalid canonical block.', 502);
  if (quantity(block.number, 'canonical blockNumber') !== blockNumber || block.hash.toLowerCase() !== blockHash) return { reason: 'noncanonical_block', matches: [] };
  const head = quantity(await rpc(config.rpcUrl, 'eth_blockNumber', [], signal), 'head blockNumber');
  if (head < blockNumber) return { reason: 'head_before_receipt', matches: [] };
  const confirmations = head - blockNumber + 1n;
  const matches = [];
  const indices = new Set();
  const recipientTopic = `0x${config.recipientAddress.slice(2).padStart(64, '0')}`;
  const payerTopic = typeof config.payerAddress === 'string' && ADDRESS.test(config.payerAddress)
    && !/^0x0{40}$/i.test(config.payerAddress)
    ? `0x${config.payerAddress.slice(2).toLowerCase().padStart(64, '0')}` : null;
  for (const log of receipt.logs) {
    if (!log || typeof log !== 'object' || typeof log.address !== 'string'
      || log.address.toLowerCase() !== config.tokenAddress || !Array.isArray(log.topics)
      || log.topics.length !== 3 || typeof log.topics[0] !== 'string'
      || log.topics[0].toLowerCase() !== TRANSFER_TOPIC
      || payerTopic === null || typeof log.topics[1] !== 'string' || log.topics[1].toLowerCase() !== payerTopic
      || typeof log.topics[2] !== 'string' || log.topics[2].toLowerCase() !== recipientTopic
      || !HASH.test(log.data ?? '') || BigInt(log.data).toString() !== config.units) continue;
    if (log.removed === true) continue;
    if (!HASH.test(log.transactionHash ?? '') || log.transactionHash.toLowerCase() !== txHash
      || !HASH.test(log.blockHash ?? '') || log.blockHash.toLowerCase() !== blockHash
      || quantity(log.blockNumber, 'log blockNumber') !== blockNumber) throw failure('RPC returned inconsistent transfer log metadata.', 502);
    const logIndex = quantity(log.logIndex, 'logIndex').toString();
    if (indices.has(logIndex)) throw failure('RPC returned duplicate transfer log indices.', 502);
    indices.add(logIndex);
    matches.push(logIndex);
  }
  matches.sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
  return {
    reason: matches.length ? (confirmations >= BigInt(config.confirmations) ? 'confirmed' : 'insufficient_confirmations') : 'transfer_not_found',
    matches, confirmations: confirmations.toString(), blockNumber: blockNumber.toString(), blockHash,
  };
}

export function registerERC20Tools(registry, context) {
  const { db } = context;
  db.exec(`
    SAVEPOINT erc20_schema;
    CREATE TABLE IF NOT EXISTS payment_config (
      conversationId INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      configJson TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payment_requests (
      requestId TEXT PRIMARY KEY,
      conversationId INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      ownerId TEXT NOT NULL,
      clientRequestId TEXT NOT NULL,
      amount TEXT NOT NULL,
      units TEXT NOT NULL,
      configJson TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','paid')),
      verificationJson TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      UNIQUE(conversationId, ownerId, clientRequestId)
    );
    CREATE INDEX IF NOT EXISTS payment_requests_conversation_created ON payment_requests(conversationId,createdAt DESC);
    CREATE TABLE IF NOT EXISTS payment_transfer_claims (
      chainId INTEGER NOT NULL,
      txHash TEXT NOT NULL,
      logIndex TEXT NOT NULL,
      conversationId INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      requestId TEXT NOT NULL REFERENCES payment_requests(requestId) ON DELETE CASCADE,
      PRIMARY KEY(chainId,txHash,logIndex)
    );
    CREATE INDEX IF NOT EXISTS payment_transfer_claims_request ON payment_transfer_claims(requestId,chainId);
    RELEASE erc20_schema;
  `);
  const transaction = (fn) => {
    db.exec('SAVEPOINT erc20_write');
    try {
      const result = fn();
      db.exec('RELEASE erc20_write');
      return result;
    } catch (error) {
      db.exec('ROLLBACK TO erc20_write; RELEASE erc20_write');
      throw error;
    }
  };
  const authorize = (args, actor, write, admin = false) => {
    const conversationId = context.read(args, actor);
    if (conversationId !== args.conversationId) throw failure('Conversation authorization mismatch.', 403);
    if (!actor || typeof actor.id !== 'string' || !actor.id || (admin && actor.admin !== true)
      || (!actor.admin && !(write ? actor.status === 'active' : ['active', 'paused'].includes(actor.status)))) throw failure('Payment tool permission denied.', 403);
    if (write && context.write(args, actor) !== conversationId) throw failure('Conversation is no longer active.');
    return conversationId;
  };
  const publicConfig = (config, actor) => {
    const { rpcUrl: privateUrl, ...visible } = config;
    return actor.admin === true ? { ...visible, rpcUrl: privateUrl } : visible;
  };
  const publicRequest = (row, actor) => {
    const config = JSON.parse(row.configJson);
    return {
      requestId: row.requestId, conversationId: row.conversationId, ownerId: row.ownerId,
      clientRequestId: row.clientRequestId, amount: row.amount, units: row.units,
      config: publicConfig(config, actor), status: row.status,
      verification: row.verificationJson === null ? null : JSON.parse(row.verificationJson),
      paymentUri: `ethereum:${config.tokenAddress}@${config.chainId}/transfer?address=${config.recipientAddress}&uint256=${row.units}`,
      createdAt: row.createdAt, updatedAt: row.updatedAt,
    };
  };
  const getRequest = (conversationId, requestId, actor) => {
    const row = db.prepare('SELECT * FROM payment_requests WHERE conversationId = ? AND requestId = ?').get(conversationId, requestId);
    if (!row || (!actor.admin && row.ownerId !== actor.id)) throw failure('Payment request not found.', 404);
    return row;
  };
  const requestClaim = db.prepare('SELECT txHash,logIndex FROM payment_transfer_claims WHERE conversationId = ? AND requestId = ? AND chainId = ? ORDER BY CASE WHEN txHash = ? AND logIndex = ? THEN 0 ELSE 1 END, txHash, length(logIndex), logIndex LIMIT 1');
  const insertClaim = db.prepare('INSERT INTO payment_transfer_claims (chainId,txHash,logIndex,conversationId,requestId) VALUES (?,?,?,?,?) ON CONFLICT(chainId,txHash,logIndex) DO NOTHING');
  const claimOwner = db.prepare('SELECT requestId FROM payment_transfer_claims WHERE chainId = ? AND txHash = ? AND logIndex = ?');
  const register = (name, permission, description, properties, execute) => registry.register({
    name, permission, description,
    inputSchema: { type: 'object', properties: { conversationId: conversationProperty, ...properties }, required: ['conversationId', ...Object.keys(properties)], additionalProperties: false },
    execute,
  });

  register('payment.configure', 'admin', '管理员配置当前对话唯一 ERC-20 收款参数；保存前核对链 ID 和合约 decimals。只读取链，不发送交易。', {
    chainId: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    rpcUrl: { type: 'string', format: 'uri', maxLength: 2048, description: 'HTTPS JSON-RPC；禁止凭据、查询、片段、本机或私有 IP 字面量。' },
    tokenAddress: addressProperty, recipientAddress: addressProperty,
    decimals: { type: 'integer', minimum: 0, maximum: 36 },
    symbol: { type: 'string', minLength: 1, maxLength: 16, pattern: '^[^\\s\\u0000-\\u001f\\u007f]+$' },
    confirmations: { type: 'integer', minimum: 1, maximum: 256 },
  }, async (args, actor) => {
    fields(args, ['conversationId', 'chainId', 'rpcUrl', 'tokenAddress', 'recipientAddress', 'decimals', 'symbol', 'confirmations']);
    const conversationId = authorize(args, actor, true, true);
    const config = {
      chainId: integer(args.chainId, 'chainId', 1, Number.MAX_SAFE_INTEGER), rpcUrl: rpcUrl(args.rpcUrl),
      tokenAddress: address(args.tokenAddress, 'tokenAddress'), recipientAddress: address(args.recipientAddress, 'recipientAddress'),
      decimals: integer(args.decimals, 'decimals', 0, 36), symbol: args.symbol,
      confirmations: integer(args.confirmations, 'confirmations', 1, 256),
    };
    if (typeof config.symbol !== 'string' || !/^[^\s\x00-\x1f\x7f]{1,16}$/u.test(config.symbol) || config.symbol.length > 16) throw new TypeError('Invalid symbol.');
    const signal = AbortSignal.timeout(RPC_TIMEOUT_MS);
    try {
      if (quantity(await rpc(config.rpcUrl, 'eth_chainId', [], signal), 'chainId') !== BigInt(config.chainId)) throw failure('RPC chainId does not match the configured chain.');
      const decimalsResult = await rpc(config.rpcUrl, 'eth_call', [{ to: config.tokenAddress, data: '0x313ce567' }, 'latest'], signal);
      if (typeof decimalsResult !== 'string' || !HASH.test(decimalsResult) || BigInt(decimalsResult) !== BigInt(config.decimals)) throw failure('Token decimals do not match the on-chain decimals() result.');
    } finally { authorize(args, actor, true, true); }
    config.verifiedAt = new Date().toISOString();
    transaction(() => db.prepare('INSERT INTO payment_config (conversationId,configJson) VALUES (?,?) ON CONFLICT(conversationId) DO UPDATE SET configJson = excluded.configJson').run(conversationId, JSON.stringify(config)));
    return { conversationId, config: publicConfig(config, actor) };
  });

  register('payment.config', 'member', '读取当前对话 ERC-20 收款配置；非管理员不会获得 RPC URL。', {}, (args, actor) => {
    fields(args, ['conversationId']);
    const conversationId = authorize(args, actor, false);
    const row = db.prepare('SELECT configJson FROM payment_config WHERE conversationId = ?').get(conversationId);
    return { conversationId, config: row ? publicConfig(JSON.parse(row.configJson), actor) : null };
  });

  register('payment.create', 'active', '创建绑定付款钱包的 ERC-20 订单及不可变快照，返回 EIP-681 URI；付款钱包必须匹配 payerAddress；幂等键只能重试相同金额和付款人。', {
    amount: { type: 'string', minLength: 1, maxLength: 120, pattern: '^(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$' },
    payerAddress: { ...addressProperty, description: '实际发送 ERC-20 Transfer 的非零付款钱包；必须从此钱包付款，EIP-681 URI 不会自动选择付款钱包。' },
    clientRequestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' },
  }, (args, actor) => {
    fields(args, ['conversationId', 'amount', 'payerAddress', 'clientRequestId']);
    const conversationId = authorize(args, actor, true);
    const payerAddress = address(args.payerAddress, 'payerAddress');
    if (typeof args.clientRequestId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(args.clientRequestId)) throw new TypeError('Invalid clientRequestId.');
    if (typeof args.amount !== 'string' || args.amount.length > 120 || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(args.amount)) throw new TypeError('Invalid amount.');
    const row = transaction(() => {
      const existing = db.prepare('SELECT * FROM payment_requests WHERE conversationId = ? AND ownerId = ? AND clientRequestId = ?').get(conversationId, actor.id, args.clientRequestId);
      if (existing) {
        if (existing.amount !== args.amount || JSON.parse(existing.configJson).payerAddress !== payerAddress) throw failure('clientRequestId already belongs to a different amount or payerAddress.');
        return existing;
      }
      const stored = db.prepare('SELECT configJson FROM payment_config WHERE conversationId = ?').get(conversationId);
      if (!stored) throw failure('Payment configuration is required.');
      const config = { ...JSON.parse(stored.configJson), payerAddress };
      const units = unitsFor(args.amount, config.decimals);
      const now = new Date().toISOString();
      const requestId = randomUUID();
      db.prepare("INSERT INTO payment_requests (requestId,conversationId,ownerId,clientRequestId,amount,units,configJson,status,verificationJson,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,'pending',NULL,?,?)").run(requestId, conversationId, actor.id, args.clientRequestId, args.amount, units, JSON.stringify(config), now, now);
      return getRequest(conversationId, requestId, actor);
    });
    return { conversationId, request: publicRequest(row, actor) };
  });

  register('payment.list', 'member', '列出本对话最近 50 个收款订单；成员仅能查看自己的订单，管理员可查看全部。', {}, (args, actor) => {
    fields(args, ['conversationId']);
    const conversationId = authorize(args, actor, false);
    const rows = actor.admin
      ? db.prepare('SELECT * FROM payment_requests WHERE conversationId = ? ORDER BY createdAt DESC, rowid DESC LIMIT 50').all(conversationId)
      : db.prepare('SELECT * FROM payment_requests WHERE conversationId = ? AND ownerId = ? ORDER BY createdAt DESC, rowid DESC LIMIT 50').all(conversationId, actor.id);
    return { conversationId, requests: rows.map(row => publicRequest(row, actor)) };
  });

  register('payment.verify', 'active', '重新查链核验本人订单（管理员可核验全部）：检查成功回执、规范区块、确认数和精确 Transfer 日志；确认后绑定原交易及日志，重组会回到 pending。', {
    requestId: requestProperty,
    txHash: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' },
  }, async (args, actor) => {
    fields(args, ['conversationId', 'requestId', 'txHash']);
    const conversationId = authorize(args, actor, true);
    if (typeof args.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args.requestId)) throw new TypeError('Invalid requestId.');
    if (typeof args.txHash !== 'string' || !HASH.test(args.txHash)) throw new TypeError('Invalid txHash.');
    const txHash = args.txHash.toLowerCase();
    const initial = getRequest(conversationId, args.requestId, actor);
    const config = { ...JSON.parse(initial.configJson), units: initial.units };
    const previous = initial.verificationJson === null ? null : JSON.parse(initial.verificationJson);
    // Claims survive reorgs and RPC failures. Prefer the last recorded identity
    // for legacy orders with multiple claims; never release historical claims.
    const claimed = requestClaim.get(conversationId, args.requestId, config.chainId, previous?.txHash ?? null, previous?.logIndex ?? null);
    if (claimed && claimed.txHash !== txHash) throw failure('Payment request is bound to a different transaction; reverify the original transaction.');
    let outcome;
    let rpcError;
    try { outcome = await verifyReceipt(config, txHash); }
    catch (error) { rpcError = error; outcome = { reason: 'rpc_error', matches: [] }; }
    // A conversation switch, revocation or pause during RPC prevents any write
    // or disclosure of the completed result. Never retarget the active chat.
    authorize(args, actor, true);
    let replay = false;
    const updated = transaction(() => {
      const current = getRequest(conversationId, args.requestId, actor);
      if (current.revision !== initial.revision) throw failure('Payment request was verified concurrently; retry to obtain a fresh chain result.');
      let logIndex = claimed?.logIndex ?? null;
      let reason = outcome.reason;
      if (claimed) {
        // A different matching event cannot replace this order's original log.
        if (outcome.matches.length > 0 && !outcome.matches.includes(logIndex)) reason = 'transfer_not_found';
      } else if (outcome.reason === 'confirmed') {
        for (const candidate of outcome.matches) {
          insertClaim.run(config.chainId, txHash, candidate, conversationId, args.requestId);
          if (claimOwner.get(config.chainId, txHash, candidate)?.requestId === args.requestId) { logIndex = candidate; break; }
        }
        replay = logIndex === null;
      } else {
        // Pending evidence is informative, not a reservation of a transfer.
        logIndex = outcome.matches[0] ?? null;
      }
      const verification = {
        txHash, logIndex, reason: replay ? 'transfer_already_claimed' : reason,
        confirmations: outcome.confirmations ?? '0', blockNumber: outcome.blockNumber ?? null,
        blockHash: outcome.blockHash ?? null, checkedAt: new Date().toISOString(),
      };
      const status = !replay && logIndex !== null && reason === 'confirmed' ? 'paid' : 'pending';
      db.prepare('UPDATE payment_requests SET status = ?, verificationJson = ?, updatedAt = ?, revision = revision + 1 WHERE conversationId = ? AND requestId = ?').run(status, JSON.stringify(verification), verification.checkedAt, conversationId, args.requestId);
      return getRequest(conversationId, args.requestId, actor);
    });
    if (rpcError) throw rpcError;
    if (replay) throw failure('This transfer log has already been claimed by another payment request.');
    return { conversationId, request: publicRequest(updated, actor) };
  });
}
