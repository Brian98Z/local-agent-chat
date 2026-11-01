import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createGroupTools } from './group-tools.mjs';
import { registerVoteGameTools } from './vote-game-tools.mjs';

const admin = Object.freeze({ id: 'admin', admin: true, status: 'active' });
const alice = Object.freeze({ id: 'alice', admin: false, status: 'active' });
const bob = Object.freeze({ id: 'bob', admin: false, status: 'active' });
const paused = Object.freeze({ id: 'paused', admin: false, status: 'paused' });
const status = (statusCode) => (error) => error instanceof Error && error.statusCode === statusCode;

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE conversations (id INTEGER PRIMARY KEY);
    INSERT INTO conversations (id) VALUES (1), (2);`);
  const current = { conversationId: 1 };
  const identities = new Map([admin, alice, bob, paused].map((actor) => [actor.id, { ...actor }]));
  const accessCalls = [];
  function access(args, actor, writing) {
    accessCalls.push({ conversationId: args.conversationId, actorId: actor.id, writing });
    const identity = identities.get(actor.id);
    if (!identity || (!identity.admin && !['active', 'paused'].includes(identity.status))
        || (writing && !identity.admin && identity.status !== 'active')
        || (actor.admin && !identity.admin)) {
      throw Object.assign(new Error('Current identity access denied.'), { statusCode: 403 });
    }
    if (!Number.isSafeInteger(args.conversationId) || args.conversationId < 1) throw new TypeError('Invalid conversationId.');
    if (!db.prepare('SELECT id FROM conversations WHERE id = ?').get(args.conversationId)) {
      throw Object.assign(new Error('Conversation not found.'), { statusCode: 404 });
    }
    if (writing && args.conversationId !== current.conversationId) {
      throw Object.assign(new Error('Conversation no longer active.'), { statusCode: 409 });
    }
    return args.conversationId;
  }
  const registry = createGroupTools();
  registerVoteGameTools(registry, {
    db,
    read: (args, actor) => access(args, actor, false),
    write: (args, actor) => access(args, actor, true),
  });
  registry.seal();
  const invoke = (name, args = {}, actor = admin) => registry.invoke(name, { conversationId: 1, ...args }, actor);
  const create = (args = {}, actor = admin) => invoke('poll.create', {
    question: 'Lunch?', options: ['Rice', 'Noodles'], clientRequestId: 'poll-1', ...args,
  }, actor);
  const roll = (args = {}, actor = alice) => invoke('game.roll', {
    count: 3, sides: 6, clientRequestId: 'roll-1', ...args,
  }, actor);
  const rps = (args = {}, actor = alice) => invoke('game.rps', {
    move: 'rock', clientRequestId: 'rps-1', ...args,
  }, actor);
  const count = (table, conversationId = 1) => db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE conversationId = ?`).get(conversationId).count;
  return { db, registry, current, identities, accessCalls, invoke, create, roll, rps, count };
}

test('tool discovery exposes exact permissions and closed, complete input schemas', (t) => {
  const f = fixture(t);
  const definitions = f.registry.list(admin).filter((tool) => /^(poll|game)\./.test(tool.name));
  assert.deepEqual(definitions.map(({ name, permission }) => [name, permission]), [
    ['poll.create', 'admin'], ['poll.list', 'member'], ['poll.vote', 'active'],
    ['poll.close', 'admin'], ['game.roll', 'active'], ['game.rps', 'active'], ['game.history', 'member'],
  ]);
  for (const { inputSchema } of definitions) {
    assert.equal(inputSchema.type, 'object');
    assert.equal(inputSchema.additionalProperties, false);
    assert.deepEqual(inputSchema.required, Object.keys(inputSchema.properties));
    assert.equal(inputSchema.properties.conversationId.minimum, 1);
  }
  const pollSchema = definitions.find((tool) => tool.name === 'poll.create').inputSchema;
  assert.deepEqual([pollSchema.properties.options.minItems, pollSchema.properties.options.maxItems], [2, 10]);
  assert.equal(pollSchema.properties.options.uniqueItems, true);
  assert.equal(pollSchema.properties.options.items.type, 'string');
  const pausedNames = f.registry.list(paused).map((tool) => tool.name);
  assert.ok(pausedNames.includes('poll.list'));
  assert.ok(pausedNames.includes('game.history'));
  assert.ok(!pausedNames.includes('poll.create'));
  assert.ok(!pausedNames.includes('poll.vote'));
  assert.ok(!pausedNames.includes('game.roll'));
});

test('all handlers reject missing conversation, unknown fields and invalid field types', async (t) => {
  const f = fixture(t);
  const cases = [
    ['poll.create', { question: 'Q', options: ['A', 'B'], clientRequestId: 'p' }],
    ['poll.list', {}], ['poll.vote', { pollId: 1, optionIndex: 0 }], ['poll.close', { pollId: 1 }],
    ['game.roll', { count: 1, sides: 6, clientRequestId: 'd' }],
    ['game.rps', { move: 'rock', clientRequestId: 'r' }], ['game.history', {}],
  ];
  for (const [name, args] of cases) {
    await assert.rejects(f.registry.invoke(name, args, admin), TypeError);
    await assert.rejects(f.invoke(name, { ...args, extra: true }), TypeError);
    for (const conversationId of [null, '1', 0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(f.invoke(name, { ...args, conversationId }), TypeError);
    }
  }
  for (const question of ['', ' ', 'x'.repeat(161), 1]) await assert.rejects(f.create({ question }), TypeError);
  for (const options of [null, ['A'], Array(11).fill('A'), ['A', 'A'], [' A ', 'A'], ['A', ' '], ['A', 1], ['A', 'x'.repeat(121)], Array(2)]) {
    await assert.rejects(f.create({ options }), TypeError);
  }
  for (const clientRequestId of ['', ' ', 'x'.repeat(129), 1]) {
    await assert.rejects(f.create({ clientRequestId }), TypeError);
    await assert.rejects(f.roll({ clientRequestId }), TypeError);
    await assert.rejects(f.rps({ clientRequestId }), TypeError);
  }
  for (const count of [0, 11, 1.1, '1']) await assert.rejects(f.roll({ count }), TypeError);
  for (const sides of [1, 1001, 2.1, '6']) await assert.rejects(f.roll({ sides }), TypeError);
  for (const move of ['', 'Rock', 'lizard', null, 1]) await assert.rejects(f.rps({ move }), TypeError);
  for (const pollId of [0, -1, 1.1, '1']) {
    await assert.rejects(f.invoke('poll.vote', { pollId, optionIndex: 0 }, alice), TypeError);
    await assert.rejects(f.invoke('poll.close', { pollId }), TypeError);
  }
  assert.equal(f.count('group_polls'), 0);
  assert.equal(f.count('group_game_results'), 0);
});

test('polls enforce administrator creation, anonymous aggregates, changeable single votes and closure', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.create({}, alice), { code: 'TOOL_PERMISSION_DENIED' });
  const created = await f.create({ question: ' Lunch? ', options: [' Rice ', 'Noodles'] });
  const pollId = created.poll.id;
  assert.equal(created.replayed, false);
  assert.equal(created.conversationId, 1);
  assert.equal(created.poll.question, 'Lunch?');
  assert.equal(created.poll.closed, false);
  assert.equal(created.poll.closedAt, null);
  assert.equal(created.poll.myOptionIndex, null);
  assert.deepEqual(created.poll.options, [{ index: 0, text: 'Rice', votes: 0 }, { index: 1, text: 'Noodles', votes: 0 }]);
  await f.invoke('poll.vote', { pollId, optionIndex: 0 }, alice);
  await f.invoke('poll.vote', { pollId, optionIndex: 1 }, bob);
  const changed = await f.invoke('poll.vote', { pollId, optionIndex: 1 }, alice);
  assert.equal(changed.poll.totalVotes, 2);
  assert.equal(changed.poll.myOptionIndex, 1);
  assert.deepEqual(changed.poll.options.map((option) => option.votes), [0, 2]);
  await f.invoke('poll.vote', { pollId, optionIndex: 1 }, alice);
  assert.equal(f.count('group_poll_votes'), 2);
  const viewed = (await f.invoke('poll.list', {}, paused)).polls[0];
  assert.equal(viewed.myOptionIndex, null);
  assert.deepEqual(Object.keys(viewed).sort(), ['id', 'conversationId', 'question', 'options', 'totalVotes', 'myOptionIndex', 'closed', 'createdAt', 'closedAt'].sort());
  for (const option of viewed.options) assert.deepEqual(Object.keys(option).sort(), ['index', 'text', 'votes']);
  assert.equal(JSON.stringify(viewed).includes('alice'), false);
  assert.equal(JSON.stringify(viewed).includes('bob'), false);
  for (const optionIndex of [-1, 10, 0.5, '0', 2]) {
    await assert.rejects(f.invoke('poll.vote', { pollId, optionIndex }, alice), TypeError);
  }
  await assert.rejects(f.invoke('poll.close', { pollId }, alice), { code: 'TOOL_PERMISSION_DENIED' });
  await assert.rejects(f.invoke('poll.vote', { pollId, optionIndex: 0 }, paused), { code: 'TOOL_PERMISSION_DENIED' });
  const closed = await f.invoke('poll.close', { pollId });
  assert.equal(closed.poll.closed, true);
  assert.ok(Number.isFinite(Date.parse(closed.poll.closedAt)));
  const again = await f.invoke('poll.close', { pollId });
  assert.equal(again.poll.closedAt, closed.poll.closedAt);
  await assert.rejects(f.invoke('poll.vote', { pollId, optionIndex: 0 }, alice), status(409));
  assert.equal((await f.invoke('poll.list', {}, alice)).polls[0].myOptionIndex, 1);
});

test('idempotent creation and game requests reject changed parameters and cross-tool reuse', async (t) => {
  const f = fixture(t);
  const original = await f.create();
  const repeated = await f.create();
  assert.equal(repeated.replayed, true);
  assert.deepEqual(repeated.poll, original.poll);
  assert.equal(f.count('group_polls'), 1);
  await assert.rejects(f.create({ question: 'Different?' }), status(409));
  await assert.rejects(f.create({ options: ['Rice', 'Soup'] }), status(409));
  await assert.rejects(f.roll({ clientRequestId: 'poll-1' }, admin), status(409));
  const dice = await f.roll();
  assert.equal((await f.roll()).game.id, dice.game.id);
  await assert.rejects(f.roll({ count: 2 }), status(409));
  await assert.rejects(f.roll({ sides: 8 }), status(409));
  await assert.rejects(f.rps({ clientRequestId: 'roll-1' }), status(409));
  await f.rps();
  await assert.rejects(f.rps({ move: 'paper' }), status(409));
  const independent = await f.roll({}, bob);
  assert.notEqual(independent.game.id, dice.game.id);
  assert.equal(f.count('group_game_results'), 3);
  assert.equal(f.count('group_vote_game_requests'), 4);
});

test('current context authorization is rechecked even for stale actors and replayed requests', async (t) => {
  const f = fixture(t);
  const poll = await f.create();
  await f.roll();
  await f.rps();
  f.identities.get(alice.id).status = 'revoked';
  const blocked = [
    ['poll.list', {}], ['game.history', {}], ['poll.vote', { pollId: poll.poll.id, optionIndex: 0 }],
    ['game.roll', { count: 3, sides: 6, clientRequestId: 'roll-1' }],
    ['game.rps', { move: 'rock', clientRequestId: 'rps-1' }],
  ];
  for (const [name, args] of blocked) await assert.rejects(f.invoke(name, args, alice), status(403));
  f.identities.get(admin.id).admin = false;
  await assert.rejects(f.create(), status(403));
  await assert.rejects(f.invoke('poll.close', { pollId: poll.poll.id }), status(403));
  assert.equal(f.count('group_poll_votes'), 0);
  assert.equal(f.count('group_game_results'), 2);
  assert.ok(f.accessCalls.some((call) => call.actorId === alice.id && !call.writing));
  assert.ok(f.accessCalls.some((call) => call.actorId === alice.id && call.writing));
});

test('conversation reads are isolated and stale or nonexistent conversation writes are rejected', async (t) => {
  const f = fixture(t);
  const first = await f.create();
  const firstGame = await f.roll();
  f.current.conversationId = 2;
  const second = await f.create({ conversationId: 2 });
  const secondGame = await f.roll({ conversationId: 2 });
  assert.notEqual(second.poll.id, first.poll.id);
  assert.notEqual(secondGame.game.id, firstGame.game.id);
  assert.deepEqual((await f.invoke('poll.list', { conversationId: 1 })).polls.map((poll) => poll.id), [first.poll.id]);
  assert.deepEqual((await f.invoke('poll.list', { conversationId: 2 })).polls.map((poll) => poll.id), [second.poll.id]);
  assert.deepEqual((await f.invoke('game.history', { conversationId: 2 }, alice)).games.map((game) => game.id), [secondGame.game.id]);
  await assert.rejects(f.invoke('poll.vote', { conversationId: 2, pollId: first.poll.id, optionIndex: 0 }, alice), status(404));
  await assert.rejects(f.invoke('poll.close', { conversationId: 2, pollId: first.poll.id }), status(404));
  await assert.rejects(f.create(), status(409));
  await assert.rejects(f.roll(), status(409));
  await assert.rejects(f.invoke('poll.vote', { pollId: first.poll.id, optionIndex: 0 }, alice), status(409));
  await assert.rejects(f.invoke('poll.list', { conversationId: 999 }), status(404));
  await assert.rejects(f.roll({ conversationId: 999 }), status(404));
  assert.equal(f.count('group_poll_votes', 1), 0);
  assert.equal(f.count('group_poll_votes', 2), 0);
});

test('dice cover supported bounds and persisted requests cannot reroll after registration restarts', async (t) => {
  const f = fixture(t);
  for (const [count, sides] of [[1, 2], [10, 1000], [3, 6]]) {
    const args = { count, sides, clientRequestId: `dice-${count}-${sides}` };
    const result = await f.roll(args);
    assert.equal(result.replayed, false);
    assert.equal(result.game.kind, 'roll');
    assert.equal(result.game.actorId, alice.id);
    assert.equal(result.game.count, count);
    assert.equal(result.game.sides, sides);
    assert.equal(result.game.dice.length, count);
    assert.ok(result.game.dice.every((value) => Number.isInteger(value) && value >= 1 && value <= sides));
    assert.equal(result.game.total, result.game.dice.reduce((sum, value) => sum + value, 0));
    assert.ok(Number.isFinite(Date.parse(result.game.createdAt)));
    const replay = await f.roll(args);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.game, result.game);
  }
  const original = await f.roll();
  const restarted = createGroupTools();
  registerVoteGameTools(restarted, {
    db: f.db,
    read: (args) => args.conversationId,
    write: (args) => args.conversationId,
  });
  restarted.seal();
  const replay = await restarted.invoke('game.roll', { conversationId: 1, count: 3, sides: 6, clientRequestId: 'roll-1' }, alice);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.game, original.game);
  assert.equal(f.count('group_game_results'), 4);
});

test('rock-paper-scissors persists the selected move, valid opponent move and correct outcome', async (t) => {
  const f = fixture(t);
  const defeats = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
  for (const move of ['rock', 'paper', 'scissors']) {
    const args = { move, clientRequestId: `rps-${move}` };
    const result = await f.rps(args);
    assert.equal(result.game.kind, 'rps');
    assert.equal(result.game.move, move);
    assert.ok(Object.hasOwn(defeats, result.game.opponentMove));
    const expected = move === result.game.opponentMove ? 'draw'
      : defeats[move] === result.game.opponentMove ? 'win' : 'loss';
    assert.equal(result.game.outcome, expected);
    const replay = await f.rps(args);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.game, result.game);
  }
  assert.equal(f.count('group_game_results'), 3);
});

test('history returns only own latest thirty results while administrators see latest thirty across identities', async (t) => {
  const f = fixture(t);
  const aliceIds = [];
  for (let index = 0; index < 35; index++) {
    aliceIds.push((await f.roll({ count: 1, clientRequestId: `history-${index}` })).game.id);
  }
  const bobGame = await f.rps({}, bob);
  const own = await f.invoke('game.history', {}, alice);
  assert.equal(own.scope, 'self');
  assert.equal(own.conversationId, 1);
  assert.deepEqual(own.games.map((game) => game.id), aliceIds.slice(-30).reverse());
  assert.ok(own.games.every((game) => game.actorId === alice.id));
  const bobHistory = await f.invoke('game.history', {}, bob);
  assert.deepEqual(bobHistory.games.map((game) => game.id), [bobGame.game.id]);
  assert.deepEqual((await f.invoke('game.history', {}, paused)).games, []);
  const all = await f.invoke('game.history');
  assert.equal(all.scope, 'all');
  assert.equal(all.games.length, 30);
  assert.equal(all.games[0].id, bobGame.game.id);
  assert.deepEqual(all.games.slice(1).map((game) => game.id), aliceIds.slice(-29).reverse());
  assert.equal(f.count('group_game_results'), 36);
});

test('SAVEPOINT rolls back partial poll/game creation and preserves surrounding transactions', async (t) => {
  const f = fixture(t);
  f.db.exec(`CREATE TRIGGER fail_vote_game_request BEFORE INSERT ON group_vote_game_requests
    BEGIN SELECT RAISE(ABORT, 'Injected request persistence failure'); END;`);
  await assert.rejects(f.create(), /Injected request persistence failure/);
  await assert.rejects(f.roll(), /Injected request persistence failure/);
  await assert.rejects(f.rps(), /Injected request persistence failure/);
  assert.equal(f.count('group_polls'), 0);
  assert.equal(f.count('group_game_results'), 0);
  assert.equal(f.count('group_vote_game_requests'), 0);
  f.db.exec('DROP TRIGGER fail_vote_game_request; BEGIN;');
  await f.create();
  await f.roll();
  assert.equal(f.count('group_polls'), 1);
  assert.equal(f.count('group_game_results'), 1);
  f.db.exec('ROLLBACK;');
  assert.equal(f.count('group_polls'), 0);
  assert.equal(f.count('group_game_results'), 0);
  assert.equal(f.count('group_vote_game_requests'), 0);
  await f.create();
  await f.roll();
  assert.equal(f.count('group_polls'), 1);
  assert.equal(f.count('group_game_results'), 1);
});

test('database foreign keys reject cross-conversation votes and cascade only the deleted conversation', async (t) => {
  const f = fixture(t);
  const first = await f.create();
  await f.invoke('poll.vote', { pollId: first.poll.id, optionIndex: 1 }, alice);
  await f.roll();
  await f.rps();
  f.current.conversationId = 2;
  const second = await f.create({ conversationId: 2 });
  await f.invoke('poll.vote', { conversationId: 2, pollId: second.poll.id, optionIndex: 0 }, bob);
  await f.roll({ conversationId: 2 });
  assert.throws(() => f.db.prepare('INSERT INTO group_poll_votes (conversationId, pollId, actorId, optionIndex) VALUES (?, ?, ?, ?)')
    .run(2, first.poll.id, 'cross-conversation', 0), /FOREIGN KEY/);
  f.db.prepare('DELETE FROM conversations WHERE id = ?').run(1);
  for (const table of ['group_polls', 'group_poll_votes', 'group_game_results', 'group_vote_game_requests']) {
    assert.equal(f.count(table, 1), 0);
    assert.ok(f.count(table, 2) > 0);
  }
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual((await f.invoke('poll.list', { conversationId: 2 })).polls.map((poll) => poll.id), [second.poll.id]);
});

test('complete poll history preserves all aggregates and isolation after registration restart', async (t) => {
  const f = fixture(t);
  const createdAt = '2026-11-01T00:00:00.000Z';
  const insertPoll = f.db.prepare('INSERT INTO group_polls (conversationId, question, optionsJson, createdAt, closedAt) VALUES (?, ?, ?, ?, ?)');
  const insertVote = f.db.prepare('INSERT INTO group_poll_votes (conversationId, pollId, actorId, optionIndex) VALUES (?, ?, ?, ?)');
  const ids = [];
  f.db.exec('BEGIN');
  for (let index = 0; index < 1200; index++) {
    const id = Number(insertPoll.run(1, `Question ${index}`, '["A","B","Unused"]', createdAt, index % 2 ? createdAt : null).lastInsertRowid);
    ids.push(id);
    for (let voter = 0; voter < 20; voter++) insertVote.run(1, id, voter === 0 ? alice.id : `voter-${voter}`, voter % 2);
  }
  const emptyId = Number(insertPoll.run(1, 'No votes', '["A","B"]', createdAt, null).lastInsertRowid);
  const otherId = Number(insertPoll.run(2, 'Other conversation', '["A","B"]', createdAt, null).lastInsertRowid);
  insertVote.run(2, otherId, alice.id, 1);
  f.db.exec('COMMIT');
  const registry = createGroupTools();
  registerVoteGameTools(registry, {
    db: f.db,
    read: (args) => args.conversationId,
    write: (args) => args.conversationId,
  });
  registry.seal();
  const result = await registry.invoke('poll.list', { conversationId: 1 }, alice);
  assert.deepEqual(Object.keys(result), ['conversationId', 'polls']);
  assert.deepEqual(result.polls.map((poll) => poll.id), [emptyId, ...ids.toReversed()]);
  assert.equal(result.polls[0].totalVotes, 0);
  assert.equal(result.polls[0].myOptionIndex, null);
  for (const poll of result.polls.slice(1)) {
    assert.equal(poll.totalVotes, 20);
    assert.equal(poll.myOptionIndex, 0);
    assert.deepEqual(poll.options.map((option) => option.votes), [10, 10, 0]);
    assert.equal(poll.closed, (poll.id - ids[0]) % 2 === 1);
  }
  assert.equal(f.count('group_polls'), 1201);
  assert.equal(f.count('group_poll_votes'), 24000);
  assert.equal(f.count('group_polls', 2), 1);
  assert.equal(f.count('group_poll_votes', 2), 1);
});

test('administrator and member histories return only their latest thirty results from large conversation history', async (t) => {
  const f = fixture(t);
  const insert = f.db.prepare('INSERT INTO group_game_results (conversationId, actorId, kind, inputJson, resultJson, createdAt) VALUES (?, ?, ?, ?, ?, ?)');
  f.db.exec('BEGIN');
  const ids = [];
  for (let index = 0; index < 4000; index++) {
    const id = Number(insert.run(1, index % 2 ? alice.id : bob.id, 'roll', '{"count":1,"sides":6}', '{"dice":[3],"total":3}', '2026-11-01T00:00:00.000Z').lastInsertRowid);
    ids.push(id);
  }
  insert.run(2, alice.id, 'rps', '{"move":"rock"}', '{"opponentMove":"rock","outcome":"draw"}', '2026-11-01T00:00:00.000Z');
  f.db.exec('COMMIT');
  const all = await f.invoke('game.history');
  const own = await f.invoke('game.history', {}, alice);
  assert.deepEqual(all.games.map((game) => game.id), ids.slice(-30).reverse());
  assert.deepEqual(own.games.map((game) => game.id), ids.filter((id, index) => index % 2).slice(-30).reverse());
  assert.equal(f.count('group_game_results'), 4000);
  assert.equal(f.count('group_game_results', 2), 1);
});

test('replay after later poll changes returns current state and unavailable games never reroll', async (t) => {
  const f = fixture(t);
  const original = await f.create();
  await f.invoke('poll.vote', { pollId: original.poll.id, optionIndex: 1 }, alice);
  const closed = await f.invoke('poll.close', { pollId: original.poll.id });
  const replay = await f.create();
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.poll, closed.poll);
  assert.equal(replay.poll.totalVotes, 1);
  const roll = await f.roll();
  const rps = await f.rps();
  f.db.prepare('DELETE FROM group_game_results WHERE id IN (?, ?)').run(roll.game.id, rps.game.id);
  await assert.rejects(f.roll(), status(409));
  await assert.rejects(f.rps(), status(409));
  assert.equal(f.count('group_game_results'), 0);
  assert.equal(f.count('group_vote_game_requests'), 3);
});

test('current paused status blocks replay and writes but permits only own game history and anonymous polls', async (t) => {
  const f = fixture(t);
  const created = await f.create();
  const rolled = await f.roll();
  await f.rps({}, bob);
  f.identities.get(alice.id).status = 'paused';
  for (const [name, args] of [
    ['game.roll', { count: 3, sides: 6, clientRequestId: 'roll-1' }],
    ['game.rps', { move: 'rock', clientRequestId: 'new-rps' }],
    ['poll.vote', { pollId: created.poll.id, optionIndex: 1 }],
  ]) await assert.rejects(f.invoke(name, args, alice), status(403));
  const history = await f.invoke('game.history', {}, alice);
  assert.deepEqual(history.games.map((game) => game.id), [rolled.game.id]);
  const listed = await f.invoke('poll.list', {}, alice);
  assert.equal(listed.polls[0].myOptionIndex, null);
  assert.equal(listed.polls[0].totalVotes, 0);
  assert.equal(f.count('group_poll_votes'), 0);
  assert.equal(f.count('group_game_results'), 2);
});
