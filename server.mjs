import http from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MAX_BODY_BYTES = 64 * 1024;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/i;
const AGENT_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function options(argv) {
  const result = { port: 4317, dataDir: join(ROOT, 'data') };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--port', '--data-dir'].includes(key) || value === undefined || seen.has(key)) {
      throw new Error('Usage: node server.mjs [--port 0..65535] [--data-dir PATH]');
    }
    seen.add(key);
    if (key === '--port') {
      if (!/^(0|[1-9]\d{0,4})$/.test(value) || Number(value) > 65535) {
        throw new Error('Port must be an integer from 0 to 65535.');
      }
      result.port = Number(value);
    } else {
      if (!value.trim() || value.includes('\0')) throw new Error('Data directory must be a valid path.');
      result.dataDir = resolve(value);
    }
  }
  return result;
}

function tokenHash(token) {
  return createHash('sha256').update(token.toLowerCase()).digest('hex');
}

function fail(status, message) {
  throw new HttpError(status, message);
}

function fields(body, allowed, required = []) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Expected a JSON object.');
  if (Object.keys(body).some((key) => !allowed.includes(key))) fail(400, 'Unknown request field.');
  if (required.some((key) => !Object.hasOwn(body, key))) fail(400, 'Missing required field.');
}

function text(value, field, minimum, maximum, trim = false) {
  if (typeof value !== 'string') fail(400, `${field} must be a string.`);
  const result = trim ? value.trim() : value;
  const length = result.length;
  if (length < minimum || length > maximum || (minimum > 0 && !result.trim()) || result.includes('\0')) {
    fail(400, `${field} must contain ${minimum}..${maximum} characters, not be blank when required, and contain no NUL.`);
  }
  return result;
}

function agentId(value) {
  if (typeof value !== 'string' || !AGENT_ID_PATTERN.test(value)) fail(400, 'Invalid agent id.');
  return value;
}

function integer(value, field, minimum, maximum) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) fail(400, `Invalid ${field}.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) fail(400, `Invalid ${field}.`);
  return parsed;
}

async function jsonBody(request) {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    request.resume();
    fail(415, 'Content-Type must be application/json.');
  }
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') {
    request.resume();
    fail(415, 'Compressed request bodies are not supported.');
  }
  if (request.headers['content-length'] && Number(request.headers['content-length']) > MAX_BODY_BYTES) {
    request.resume();
    fail(413, 'Request body is too large.');
  }
  const bytes = await new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let length = 0;
    let rejected = false;
    request.on('data', (chunk) => {
      if (rejected) return;
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        rejected = true;
        chunks.length = 0;
        rejectBody(new HttpError(413, 'Request body is too large.'));
        return;
      }
      chunks.push(chunk);
    });
    request.once('end', () => {
      if (!rejected) resolveBody(Buffer.concat(chunks, length));
    });
    request.once('aborted', () => rejectBody(new HttpError(400, 'Request was interrupted.')));
    request.once('error', () => rejectBody(new HttpError(400, 'Request body could not be read.')));
  });
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail(400, 'Request body must be valid UTF-8 JSON.');
  }
}

function responseHeaders(response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
}

function send(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function localRequest(request, port) {
  const host = request.headers.host;
  if (request.headersDistinct.host?.length !== 1 || typeof host !== 'string') fail(403, 'Local Host required.');
  const hosts = new Set(['127.0.0.1', 'localhost', '[::1]'].map((name) => port === 80 ? name : `${name}:${port}`));
  if (port === 80) {
    hosts.add('127.0.0.1:80');
    hosts.add('localhost:80');
    hosts.add('[::1]:80');
  }
  if (!hosts.has(host.toLowerCase())) fail(403, 'Local Host required.');
  if (request.headers.origin !== undefined) {
    if (request.headersDistinct.origin?.length !== 1) fail(403, 'Cross-origin requests are not allowed.');
    let origin;
    try {
      origin = new URL(request.headers.origin);
    } catch {
      fail(403, 'Cross-origin requests are not allowed.');
    }
    if (origin.origin !== new URL(`http://${host}`).origin || origin.href !== `${origin.origin}/`) {
      fail(403, 'Cross-origin requests are not allowed.');
    }
  }
  // Public static documents can be opened from links/extensions; API cross-site access remains forbidden.
  const publicNavigation = request.method === 'GET' && request.headers['sec-fetch-mode'] === 'navigate'
    && request.headers['sec-fetch-dest'] === 'document' && STATIC_FILES.has(request.url.split('?', 1)[0]);
  if (request.headers['sec-fetch-site'] === 'cross-site' && !publicNavigation) fail(403, 'Cross-origin requests are not allowed.');
}

function start(config) {
  process.umask(0o077);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  // A separate SQLite database holds an OS-backed exclusive lock for our lifetime.
  // Crashes release it automatically; no PID guessing, stale-file deletion, or unlink races.
  const lock = new DatabaseSync(join(config.dataDir, 'service-lock.sqlite'));
  try {
    lock.exec('PRAGMA busy_timeout = 0; PRAGMA journal_mode = PERSIST; BEGIN EXCLUSIVE;');
  } catch {
    lock.close();
    throw new Error('Data directory is already in use, or its service lock is unavailable.');
  }

  let db;
  try {
    db = new DatabaseSync(join(config.dataDir, 'chat.sqlite'));
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 3000;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        activeConversationId INTEGER NOT NULL REFERENCES conversations(id)
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        nameKey TEXT NOT NULL UNIQUE,
        tokenHash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('pending','active','paused','revoked')),
        model TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        "from" TEXT NOT NULL,
        "to" TEXT REFERENCES agents(id),
        text TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open','claimed','done')),
        owner TEXT,
        createdBy TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        CHECK ((status = 'open' AND owner IS NULL) OR (status IN ('claimed','done') AND owner IS NOT NULL))
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_owner_status ON tasks(owner, status);
    `);
    db.prepare('INSERT OR IGNORE INTO conversations (id,title,createdAt) VALUES (1,?,?)').run('初始对话', new Date().toISOString());
    db.exec('INSERT OR IGNORE INTO conversation_state (id,activeConversationId) VALUES (1,1)');
    for (const table of ['messages', 'tasks']) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all();
      if (!columns.some((column) => column.name === 'conversationId')) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN conversationId INTEGER NOT NULL DEFAULT 1 CHECK (conversationId > 0)`);
      }
    }
    if (!db.prepare('PRAGMA table_info(agents)').all().some((column) => column.name === 'model')) {
      db.exec("ALTER TABLE agents ADD COLUMN model TEXT NOT NULL DEFAULT ''");
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS messages_conversation_id ON messages(conversationId,id);
      CREATE INDEX IF NOT EXISTS tasks_conversation_id ON tasks(conversationId,id);
      COMMIT;
    `);
  } catch {
    if (db?.isTransaction) db.exec('ROLLBACK');
    db?.close();
    lock.close();
    throw new Error('Unable to open or initialize the chat database.');
  }

  const statements = new Map();
  function sql(query) {
    if (!statements.has(query)) statements.set(query, db.prepare(query));
    return statements.get(query);
  }
  function transaction(operation) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const publicAgent = (row) => ({ id: row.id, name: row.name, status: row.status, model: row.model, createdAt: row.createdAt });
  const getAgent = (id) => sql('SELECT id,name,status,model,createdAt FROM agents WHERE id = ?').get(id);
  const getTask = (id) => sql('SELECT * FROM tasks WHERE id = ?').get(id);
  const allTasks = (conversationId) => sql('SELECT * FROM tasks WHERE conversationId = ? ORDER BY id').all(conversationId);
  const audit = (actor, action, target, now) => sql('INSERT INTO audit (actor,action,target,createdAt) VALUES (?,?,?,?)').run(actor, action, String(target), now);
  const getConversation = (id) => sql('SELECT id,title,createdAt FROM conversations WHERE id = ?').get(id);
  const allConversations = () => sql('SELECT id,title,createdAt FROM conversations ORDER BY id DESC').all();
  const activeConversationId = () => sql('SELECT activeConversationId FROM conversation_state WHERE id = 1').get().activeConversationId;

  function readConversationId(searchParams) {
    if (searchParams.getAll('conversationId').length > 1) fail(400, 'Repeated conversationId parameter.');
    const value = searchParams.get('conversationId');
    const id = value === null ? activeConversationId() : integer(value, 'conversationId', 1, Number.MAX_SAFE_INTEGER);
    if (!getConversation(id)) fail(404, 'Conversation not found.');
    return id;
  }

  function writeConversationId(body) {
    const activeId = activeConversationId();
    if (body.conversationId === undefined) return activeId;
    if (!Number.isSafeInteger(body.conversationId) || body.conversationId < 1) fail(400, 'Invalid conversationId.');
    if (body.conversationId !== activeId) fail(409, 'Conversation is no longer active.');
    return activeId;
  }

  function defaultConversationTitle(now) {
    const pad = (value) => String(value).padStart(2, '0');
    return `对话 ${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }

  // Summarize the first human instruction locally; the service never calls a model.
  function deriveConversationTitle(source) {
    let value = String(source)
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`]*`/g, ' ')
      .replace(/https?:\/\/\S+/gi, ' ')
      .replace(/[`*_#>~|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^(?:[-+*]|\d+[.)])\s+/, '');
    if (!value) return null;
    const sentence = value.match(/^[\s\S]*?[。！？!?；;]/);
    if (sentence) value = sentence[0].trim();
    const characters = [...value];
    return characters.length <= 40 ? value : `${characters.slice(0, 40).join('')}…`;
  }

  function autoTitleConversation(conversationId, source) {
    const conversation = getConversation(conversationId);
    if (!conversation) return;
    let eligible = false;
    const created = new Date(conversation.createdAt);
    if (!Number.isNaN(created.getTime()) && conversation.title === defaultConversationTitle(created)) eligible = true;
    if (conversation.title === '初始对话') {
      const counts = sql('SELECT (SELECT COUNT(*) FROM messages WHERE conversationId = ? AND "from" = \'admin\') AS adminMessages, (SELECT COUNT(*) FROM tasks WHERE conversationId = ?) AS tasks').get(conversationId, conversationId);
      eligible = counts.adminMessages <= 1 && counts.tasks <= 1;
    }
    if (!eligible) return;
    const title = deriveConversationTitle(source);
    if (!title || title === conversation.title) return;
    sql('UPDATE conversations SET title = ? WHERE id = ? AND title = ?').run(title, conversationId, conversation.title);
  }

  function visibleMessages(actor, conversationId, after, limit) {
    return actor.admin
      ? sql('SELECT * FROM messages WHERE conversationId = ? AND id > ? ORDER BY id LIMIT ?').all(conversationId, after, limit)
      : sql('SELECT * FROM messages WHERE conversationId = ? AND id > ? AND ("to" IS NULL OR "to" = ? OR "from" = ?) ORDER BY id LIMIT ?').all(conversationId, after, actor.id, actor.id, limit);
  }

  const eventWaiters = new Set();
  function wakeEventWaiters() {
    for (const wake of eventWaiters) wake();
  }

  const adminToken = randomBytes(32).toString('hex');
  const adminHash = Buffer.from(tokenHash(adminToken), 'hex');
  let registrationOpen = sql("SELECT value FROM settings WHERE key = 'registrationOpen'").get()?.value === '1';
  let actualPort;
  let stopping = false;

  function authenticate(request, requirement = 'active') {
    if (stopping) fail(503, 'Server is stopping.');
    const authorization = request.headers.authorization;
    if (request.headersDistinct.authorization?.length !== 1 || typeof authorization !== 'string' || !/^Bearer [a-f0-9]{64}$/i.test(authorization)) {
      fail(401, 'A valid bearer token is required.');
    }
    const hash = tokenHash(authorization.slice(7));
    if (timingSafeEqual(Buffer.from(hash, 'hex'), adminHash)) {
      if (requirement === 'agent') fail(403, 'An agent identity is required.');
      return { id: 'admin', admin: true };
    }
    const row = sql('SELECT id,name,status,model,createdAt FROM agents WHERE tokenHash = ?').get(hash);
    if (!row) fail(401, 'A valid bearer token is required.');
    if (requirement === 'admin') fail(403, 'Administrator authorization is required.');
    // Muted (paused) members keep read access; only active members may write.
    if (requirement === 'active' && row.status !== 'active') {
      if (row.status === 'paused') fail(403, 'Agent is muted; write operations are not allowed.');
      fail(403, 'Agent is not active; administrator approval is required.');
    }
    if (requirement === 'member' && row.status !== 'active' && row.status !== 'paused') fail(403, 'Agent is not active; administrator approval is required.');
    return { ...row, admin: false };
  }

  function waitForEvents(request, response, conversationId, after, timeout) {
    return new Promise((resolveWait, rejectWait) => {
      let settled = false;
      let deadlineTimer;
      let authorizationTimer;
      function finish(error, result) {
        if (settled) return;
        settled = true;
        eventWaiters.delete(wake);
        clearTimeout(deadlineTimer);
        clearInterval(authorizationTimer);
        request.off('aborted', cancel);
        response.off('close', cancel);
        if (error) rejectWait(error);
        else resolveWait(result);
      }
      function cancel() {
        finish(null, null);
      }
      function check(timedOut = false) {
        if (settled) return;
        try {
          const actor = authenticate(request, 'member');
          const activeId = activeConversationId();
          if (activeId !== conversationId) {
            finish(null, { conversationId: activeId, changed: true, messages: [], cursor: 0, reason: 'conversation_changed' });
            return;
          }
          const messages = visibleMessages(actor, activeId, after, 100);
          if (messages.length || timedOut) {
            finish(null, {
              conversationId: activeId,
              changed: false,
              messages,
              cursor: messages.at(-1)?.id ?? after,
              reason: messages.length ? 'messages' : 'timeout',
            });
          }
        } catch (error) {
          finish(error);
        }
      }
      function wake() {
        check();
      }
      if (request.aborted || response.destroyed) {
        cancel();
        return;
      }
      request.once('aborted', cancel);
      response.once('close', cancel);
      eventWaiters.add(wake);
      // Only authorization is polled; conversation/message reads are event-driven.
      authorizationTimer = setInterval(() => {
        try {
          authenticate(request, 'member');
        } catch (error) {
          finish(error);
        }
      }, 1000);
      deadlineTimer = setTimeout(() => check(true), timeout);
      check();
    });
  }

  async function route(request, response) {
    responseHeaders(response);
    localRequest(request, actualPort);
    if (stopping) fail(503, 'Server is stopping.');
    if (!request.url.startsWith('/') || request.url.startsWith('//')) fail(400, 'Invalid request URL.');
    const url = new URL(request.url, `http://127.0.0.1:${actualPort}`);
    const path = url.pathname;
    const method = request.method;

    if (STATIC_FILES.has(path)) {
      if (method !== 'GET' && method !== 'HEAD') fail(405, 'Method not allowed.');
      const [filename, contentType] = STATIC_FILES.get(path);
      let bytes;
      try {
        bytes = await readFile(join(ROOT, 'public', filename));
      } catch {
        fail(503, 'Web interface is unavailable.');
      }
      response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': bytes.length });
      response.end(method === 'HEAD' ? undefined : bytes);
      return;
    }

    if (path === '/api/join' && method === 'POST') {
      const body = await jsonBody(request);
      fields(body, ['name', 'token', 'model'], ['name', 'token', 'model']);
      const name = text(body.name, 'name', 1, 64, true);
      const model = text(body.model, 'model', 1, 80, true);
      if (typeof body.token !== 'string' || !TOKEN_PATTERN.test(body.token)) fail(400, 'token must be 64 hexadecimal characters.');
      const hash = tokenHash(body.token);
      const existing = sql('SELECT id,name,status,model,createdAt FROM agents WHERE tokenHash = ?').get(hash);
      if (existing) {
        // The model declaration is fixed after the first successful registration.
        if (!existing.model) sql('UPDATE agents SET model = ? WHERE id = ?').run(model, existing.id);
        return send(response, 200, { agent: publicAgent(getAgent(existing.id)) });
      }
      const nameKey = name.toLowerCase();
      if (sql('SELECT id FROM agents WHERE nameKey = ?').get(nameKey)) fail(409, 'Name is already registered.');
      if (!registrationOpen) fail(403, 'New registration is closed.');
      const now = new Date().toISOString();
      const id = randomUUID();
      transaction(() => {
        sql("INSERT INTO agents (id,name,nameKey,tokenHash,status,model,createdAt) VALUES (?,?,?,?,'pending',?,?)").run(id, name, nameKey, hash, model, now);
        audit(id, 'agent.join', id, now);
      });
      return send(response, 201, { agent: getAgent(id) });
    }

    if (path === '/api/me' && method === 'GET') {
      return send(response, 200, { agent: publicAgent(authenticate(request, 'agent')) });
    }

    if (path === '/api/conversations' && method === 'GET') {
      authenticate(request, 'member');
      return send(response, 200, { conversations: allConversations(), activeConversationId: activeConversationId() });
    }

    if (path === '/api/admin/conversations' && method === 'POST') {
      authenticate(request, 'admin');
      const body = await jsonBody(request);
      authenticate(request, 'admin');
      fields(body, ['title']);
      const now = new Date();
      const title = body.title === undefined ? defaultConversationTitle(now) : text(body.title, 'title', 1, 80, true);
      const conversation = transaction(() => {
        const result = sql('INSERT INTO conversations (title,createdAt) VALUES (?,?)').run(title, now.toISOString());
        sql('UPDATE conversation_state SET activeConversationId = ? WHERE id = 1').run(result.lastInsertRowid);
        audit('admin', 'conversation.create', result.lastInsertRowid, now.toISOString());
        return getConversation(result.lastInsertRowid);
      });
      wakeEventWaiters();
      return send(response, 201, { conversation, activeConversationId: conversation.id });
    }

    const activateConversationMatch = /^\/api\/admin\/conversations\/([^/]+)\/activate$/.exec(path);
    if (activateConversationMatch && method === 'POST') {
      authenticate(request, 'admin');
      const id = integer(activateConversationMatch[1], 'conversation id', 1, Number.MAX_SAFE_INTEGER);
      const body = await jsonBody(request);
      authenticate(request, 'admin');
      fields(body, []);
      const conversation = transaction(() => {
        const current = getConversation(id);
        if (!current) fail(404, 'Conversation not found.');
        sql('UPDATE conversation_state SET activeConversationId = ? WHERE id = 1').run(id);
        audit('admin', 'conversation.activate', id, new Date().toISOString());
        return current;
      });
      wakeEventWaiters();
      return send(response, 200, { conversation, activeConversationId: conversation.id });
    }

    const deleteConversationMatch = /^\/api\/admin\/conversations\/([^/]+)\/delete$/.exec(path);
    if (deleteConversationMatch && method === 'POST') {
      authenticate(request, 'admin');
      const id = integer(deleteConversationMatch[1], 'conversation id', 1, Number.MAX_SAFE_INTEGER);
      const body = await jsonBody(request);
      authenticate(request, 'admin');
      fields(body, []);
      const now = new Date().toISOString();
      const result = transaction(() => {
        const conversation = getConversation(id);
        if (!conversation) fail(404, 'Conversation not found.');
        const count = sql('SELECT COUNT(*) AS count FROM conversations').get().count;
        if (count <= 1) fail(409, 'Cannot delete the last conversation.');
        if (activeConversationId() === id) {
          const next = sql('SELECT id FROM conversations WHERE id != ? ORDER BY id DESC LIMIT 1').get(id).id;
          sql('UPDATE conversation_state SET activeConversationId = ? WHERE id = 1').run(next);
        }
        sql('DELETE FROM messages WHERE conversationId = ?').run(id);
        sql('DELETE FROM tasks WHERE conversationId = ?').run(id);
        sql('DELETE FROM conversations WHERE id = ?').run(id);
        audit('admin', 'conversation.delete', id, now);
        return { deletedId: id, activeConversationId: activeConversationId() };
      });
      wakeEventWaiters();
      return send(response, 200, { ...result, conversations: allConversations() });
    }

    if (path === '/api/admin/state' && method === 'GET') {
      authenticate(request, 'admin');
      const conversationId = activeConversationId();
      return send(response, 200, {
        registrationOpen,
        conversations: allConversations(),
        activeConversationId: conversationId,
        agents: sql('SELECT id,name,status,model,createdAt FROM agents ORDER BY createdAt,id').all(),
        messages: sql('SELECT * FROM messages WHERE conversationId = ? ORDER BY id DESC LIMIT 200').all(conversationId).reverse(),
        tasks: allTasks(conversationId),
        audit: sql('SELECT * FROM audit ORDER BY id DESC LIMIT 200').all().reverse(),
      });
    }

    if (path === '/api/admin/registration' && method === 'POST') {
      authenticate(request, 'admin');
      const body = await jsonBody(request);
      authenticate(request, 'admin');
      fields(body, ['open'], ['open']);
      if (typeof body.open !== 'boolean') fail(400, 'open must be a boolean.');
      audit('admin', body.open ? 'registration.open' : 'registration.close', 'registration', new Date().toISOString());
      sql("INSERT INTO settings (key,value) VALUES ('registrationOpen',?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(body.open ? '1' : '0');
      registrationOpen = body.open;
      return send(response, 200, { registrationOpen });
    }

    if (path === '/api/admin/agents/bulk' && method === 'POST') {
      authenticate(request, 'admin');
      const body = await jsonBody(request);
      authenticate(request, 'admin');
      fields(body, ['action'], ['action']);
      if (!['approve', 'revoke'].includes(body.action)) fail(400, 'Invalid bulk action.');
      const now = new Date().toISOString();
      const result = transaction(() => {
        const status = body.action === 'approve' ? 'active' : 'revoked';
        const targets = body.action === 'approve'
          ? sql("SELECT id FROM agents WHERE status = 'pending'").all()
          : sql("SELECT id FROM agents WHERE status != 'revoked'").all();
        for (const target of targets) {
          sql('UPDATE agents SET status = ? WHERE id = ?').run(status, target.id);
          audit('admin', `agent.${status}`, target.id, now);
          if (status === 'revoked') {
            const released = sql("SELECT id FROM tasks WHERE owner = ? AND status = 'claimed'").all(target.id);
            sql("UPDATE tasks SET status = 'open',owner = NULL,updatedAt = ? WHERE owner = ? AND status = 'claimed'").run(now, target.id);
            for (const task of released) audit('admin', 'task.release', task.id, now);
          }
        }
        return { updated: targets.length };
      });
      wakeEventWaiters();
      return send(response, 200, { action: body.action, updated: result.updated });
    }

    const adminAgentMatch = /^\/api\/admin\/agents\/([^/]+)$/.exec(path);
    if (adminAgentMatch && method === 'POST') {
      authenticate(request, 'admin');
      const id = agentId(adminAgentMatch[1]);
      const body = await jsonBody(request);
      authenticate(request, 'admin');
      fields(body, ['status'], ['status']);
      if (!['active', 'paused', 'revoked'].includes(body.status)) fail(400, 'Invalid agent status.');
      const now = new Date().toISOString();
      const agent = transaction(() => {
        const current = getAgent(id);
        if (!current) fail(404, 'Agent not found.');
        const transitions = { pending: ['active', 'revoked'], active: ['paused', 'revoked'], paused: ['active', 'revoked'], revoked: [] };
        if (!transitions[current.status].includes(body.status)) fail(409, 'Agent status transition is not allowed.');
        sql('UPDATE agents SET status = ? WHERE id = ?').run(body.status, id);
        audit('admin', `agent.${body.status}`, id, now);
        if (body.status === 'paused' || body.status === 'revoked') {
          const released = sql("SELECT id FROM tasks WHERE owner = ? AND status = 'claimed'").all(id);
          sql("UPDATE tasks SET status = 'open',owner = NULL,updatedAt = ? WHERE owner = ? AND status = 'claimed'").run(now, id);
          for (const task of released) audit('admin', 'task.release', task.id, now);
        }
        return getAgent(id);
      });
      wakeEventWaiters();
      return send(response, 200, { agent });
    }

    if (path === '/api/agents' && method === 'GET') {
      const actor = authenticate(request, 'member');
      const agents = actor.admin
        ? sql('SELECT id,name,status,model,createdAt FROM agents ORDER BY createdAt,id').all()
        : sql("SELECT id,name,status,model,createdAt FROM agents WHERE status = 'active' ORDER BY createdAt,id").all();
      return send(response, 200, { agents });
    }

    if (path === '/api/events' && method === 'GET') {
      authenticate(request, 'member');
      for (const key of url.searchParams.keys()) {
        if (!['conversationId', 'after', 'timeout'].includes(key)) fail(400, 'Unknown event parameter.');
        if (url.searchParams.getAll(key).length > 1) fail(400, 'Repeated event parameter.');
      }
      const conversationId = integer(url.searchParams.get('conversationId'), 'conversationId', 1, Number.MAX_SAFE_INTEGER);
      const after = integer(url.searchParams.get('after') ?? '0', 'after', 0, Number.MAX_SAFE_INTEGER);
      const timeout = integer(url.searchParams.get('timeout') ?? '25000', 'timeout', 1, 25000);
      const result = await waitForEvents(request, response, conversationId, after, timeout);
      if (result !== null) return send(response, 200, result);
      return;
    }

    if (path === '/api/messages' && method === 'GET') {
      const actor = authenticate(request, 'member');
      const conversationId = readConversationId(url.searchParams);
      if (url.searchParams.getAll('after').length > 1 || url.searchParams.getAll('limit').length > 1) fail(400, 'Repeated pagination parameter.');
      const after = integer(url.searchParams.get('after') ?? '0', 'after', 0, Number.MAX_SAFE_INTEGER);
      const limit = integer(url.searchParams.get('limit') ?? '100', 'limit', 1, 200);
      const messages = visibleMessages(actor, conversationId, after, limit);
      return send(response, 200, { messages, cursor: messages.at(-1)?.id ?? after, conversationId });
    }

    if (path === '/api/messages' && method === 'POST') {
      authenticate(request);
      const body = await jsonBody(request);
      // Recheck after receiving the body: an administrator may have muted this agent.
      const actor = authenticate(request);
      fields(body, ['text', 'to', 'conversationId'], ['text']);
      const messageText = text(body.text, 'text', 1, 8000);
      const to = body.to === undefined || body.to === null ? null : agentId(body.to);
      if (to !== null) {
        const target = getAgent(to);
        if (!target) fail(404, 'Recipient not found.');
        if (target.status !== 'active') fail(409, 'Recipient is not active.');
      }
      const message = transaction(() => {
        const conversationId = writeConversationId(body);
        const result = sql('INSERT INTO messages ("from","to",text,createdAt,conversationId) VALUES (?,?,?,?,?)').run(actor.id, to, messageText, new Date().toISOString(), conversationId);
        const row = sql('SELECT * FROM messages WHERE id = ?').get(result.lastInsertRowid);
        if (actor.admin) autoTitleConversation(conversationId, messageText);
        return row;
      });
      wakeEventWaiters();
      return send(response, 201, { message });
    }

    if (path === '/api/tasks' && method === 'GET') {
      authenticate(request, 'member');
      const conversationId = readConversationId(url.searchParams);
      return send(response, 200, { tasks: allTasks(conversationId), conversationId });
    }

    if (path === '/api/tasks' && method === 'POST') {
      authenticate(request);
      const body = await jsonBody(request);
      const actor = authenticate(request);
      fields(body, ['title', 'description', 'conversationId'], ['title']);
      const title = text(body.title, 'title', 1, 160, true);
      const description = body.description === undefined ? '' : text(body.description, 'description', 0, 8000);
      const now = new Date().toISOString();
      const task = transaction(() => {
        const conversationId = writeConversationId(body);
        const result = sql("INSERT INTO tasks (title,description,status,owner,createdBy,createdAt,updatedAt,note,conversationId) VALUES (?,?,'open',NULL,?,?,?,'',?)").run(title, description, actor.id, now, now, conversationId);
        audit(actor.id, 'task.create', result.lastInsertRowid, now);
        const row = getTask(result.lastInsertRowid);
        if (actor.admin) autoTitleConversation(conversationId, title);
        return row;
      });
      return send(response, 201, { task });
    }

    const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(path);
    if (taskMatch && method === 'POST') {
      authenticate(request);
      const id = integer(taskMatch[1], 'task id', 1, Number.MAX_SAFE_INTEGER);
      const body = await jsonBody(request);
      const actor = authenticate(request);
      fields(body, ['action', 'note', 'conversationId'], ['action']);
      if (!['claim', 'release', 'complete', 'reopen'].includes(body.action)) fail(400, 'Invalid task action.');
      const note = body.note === undefined ? undefined : text(body.note, 'note', 0, 8000);
      const now = new Date().toISOString();
      const task = transaction(() => {
        const current = getTask(id);
        if (!current) fail(404, 'Task not found.');
        if (current.conversationId !== writeConversationId(body)) fail(409, 'Task conversation is no longer active.');
        let status;
        let owner;
        if (body.action === 'claim') {
          if (current.status !== 'open') fail(409, 'Only open tasks can be claimed.');
          status = 'claimed';
          owner = actor.id;
        } else if (body.action === 'reopen') {
          if (!actor.admin) fail(403, 'Only the administrator can reopen tasks.');
          if (current.status !== 'done') fail(409, 'Only completed tasks can be reopened.');
          status = 'open';
          owner = null;
        } else {
          if (current.status !== 'claimed') fail(409, 'Only claimed tasks can be released or completed.');
          if (!actor.admin && current.owner !== actor.id) fail(403, 'Only the task owner or administrator can perform this action.');
          status = body.action === 'complete' ? 'done' : 'open';
          owner = body.action === 'complete' ? current.owner : null;
        }
        sql('UPDATE tasks SET status = ?,owner = ?,updatedAt = ?,note = ? WHERE id = ?').run(status, owner, now, note ?? current.note, id);
        audit(actor.id, `task.${body.action}`, id, now);
        return getTask(id);
      });
      return send(response, 200, { task });
    }

    if (['/api/join', '/api/me', '/api/admin/state', '/api/admin/registration', '/api/admin/conversations', '/api/conversations', '/api/agents', '/api/messages', '/api/tasks', '/api/events'].includes(path) || adminAgentMatch || activateConversationMatch || deleteConversationMatch || taskMatch) {
      fail(405, 'Method not allowed.');
    }
    fail(404, 'Not found.');
  }

  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    route(request, response).catch((error) => {
      request.resume();
      if (error instanceof HttpError) {
        send(response, error.status, { error: error.message });
      } else {
        // Never log request bodies, Authorization, database contents, or exception text.
        console.error('Request failed due to an internal server error.');
        send(response, 500, { error: 'Internal server error.' });
      }
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1000;
  let closed = false;
  function closeDatabases() {
    if (closed) return;
    closed = true;
    try { db.close(); } finally { lock.close(); }
  }
  function shutdown() {
    if (stopping) return;
    stopping = true;
    wakeEventWaiters();
    const force = setTimeout(() => server.closeAllConnections(), 5000);
    force.unref();
    server.close(() => {
      clearTimeout(force);
      closeDatabases();
    });
    server.closeIdleConnections();
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  server.once('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? 'Unable to listen: port is already in use.' : 'Unable to listen on the local interface.');
    closeDatabases();
    process.exitCode = 1;
  });
  server.listen(config.port, '127.0.0.1', () => {
    actualPort = server.address().port;
    console.log(`Admin token: ${adminToken}`);
    console.log(`Listening: http://127.0.0.1:${actualPort}`);
  });
}

let config;
try {
  config = options(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
if (config) {
  try {
    start(config);
  } catch {
    console.error('Unable to start: check the data directory, database, and whether another service is using this directory.');
    process.exitCode = 1;
  }
}
