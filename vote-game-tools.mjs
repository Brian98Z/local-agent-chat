import { randomInt } from 'node:crypto';

// The host supplies authenticated actors and synchronous, current-state access checks.
export function registerVoteGameTools(registry, context) {
  const { db } = context;
  let savepointSequence = 0;
  const statements = new Map();
  const sql = (query) => {
    if (!statements.has(query)) statements.set(query, db.prepare(query));
    return statements.get(query);
  };
  function transaction(operation) {
    const name = `vote_game_${++savepointSequence}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const result = operation();
      db.exec(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      try {
        db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
        db.exec(`RELEASE SAVEPOINT ${name}`);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Vote/game transaction rollback failed.');
      }
      throw error;
    }
  }
  transaction(() => db.exec(`
    CREATE TABLE IF NOT EXISTS group_polls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversationId INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      optionsJson TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      closedAt TEXT,
      UNIQUE (conversationId, id)
    );
    CREATE TABLE IF NOT EXISTS group_poll_votes (
      conversationId INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      pollId INTEGER NOT NULL,
      actorId TEXT NOT NULL,
      optionIndex INTEGER NOT NULL CHECK (optionIndex BETWEEN 0 AND 9),
      PRIMARY KEY (conversationId, pollId, actorId),
      FOREIGN KEY (conversationId, pollId) REFERENCES group_polls(conversationId, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS group_poll_votes_totals
      ON group_poll_votes (conversationId, pollId, optionIndex, actorId);
    CREATE TABLE IF NOT EXISTS group_game_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversationId INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      actorId TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('roll', 'rps')),
      inputJson TEXT NOT NULL,
      resultJson TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS group_game_results_history
      ON group_game_results (conversationId, actorId, id DESC);
    CREATE INDEX IF NOT EXISTS group_game_results_conversation_history
      ON group_game_results (conversationId, id DESC);
    CREATE TABLE IF NOT EXISTS group_vote_game_requests (
      conversationId INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      actorId TEXT NOT NULL,
      clientRequestId TEXT NOT NULL,
      tool TEXT NOT NULL,
      inputJson TEXT NOT NULL,
      resultId INTEGER NOT NULL,
      PRIMARY KEY (conversationId, actorId, clientRequestId)
    );
  `));

  const conversationProperty = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: '明确指定对话；写操作仅允许当前对话。' };
  const requestProperty = { type: 'string', minLength: 1, maxLength: 128, description: '同一身份、对话内唯一的幂等请求标识；重试必须复用原标识。' };
  const pollIdProperty = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: '投票编号。' };
  function register(name, permission, description, properties, execute) {
    registry.register({
      name, permission, description,
      inputSchema: {
        type: 'object',
        properties: { conversationId: conversationProperty, ...properties },
        required: ['conversationId', ...Object.keys(properties)],
        additionalProperties: false,
      },
      execute(args, actor) {
        fields(args, ['conversationId', ...Object.keys(properties)]);
        integer(args.conversationId, 'conversationId', 1, Number.MAX_SAFE_INTEGER);
        return execute(args, actor);
      },
    });
  }
  function fields(args, names) {
    if (!args || typeof args !== 'object' || Array.isArray(args)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(args))
        || Reflect.ownKeys(args).length !== names.length
        || names.some((name) => !Object.hasOwn(args, name))) {
      throw new TypeError(`Expected exactly: ${names.join(', ')}.`);
    }
  }
  function integer(value, name, min, max) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new TypeError(`${name} must be an integer from ${min} to ${max}.`);
    }
    return value;
  }
  function text(value, name, max) {
    if (typeof value !== 'string' || !value.trim() || value.length > max) {
      throw new TypeError(`${name} must contain 1 to ${max} characters and not be blank.`);
    }
    return value.trim();
  }
  const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
  function authorize(args, actor, permission) {
    if (!actor || typeof actor.id !== 'string' || !actor.id
        || (actor.admin !== true && !['active', 'paused'].includes(actor.status))) {
      fail(403, 'Tool permission denied.');
    }
    if (permission === 'admin' && actor.admin !== true) fail(403, 'Administrator permission required.');
    if (permission === 'active' && actor.admin !== true && actor.status !== 'active') fail(403, 'Active identity required.');
    return permission === 'member' ? context.read(args, actor) : context.write(args, actor);
  }
  function findPoll(conversationId, pollId) {
    const row = sql('SELECT id, conversationId, question, optionsJson, createdAt, closedAt FROM group_polls WHERE conversationId = ? AND id = ?').get(conversationId, pollId);
    if (!row) fail(404, 'Poll not found in this conversation.');
    return row;
  }
  function summarizePoll(row, counts = []) {
    const options = JSON.parse(row.optionsJson).map((value, index) => ({ index, text: value, votes: 0 }));
    let myOptionIndex = null;
    let totalVotes = 0;
    for (const count of counts) {
      options[count.optionIndex].votes = count.votes;
      totalVotes += count.votes;
      if (count.mine) myOptionIndex = count.optionIndex;
    }
    return {
      id: row.id, conversationId: row.conversationId, question: row.question,
      options, totalVotes, myOptionIndex, closed: row.closedAt !== null,
      createdAt: row.createdAt, closedAt: row.closedAt,
    };
  }
  function pollResult(conversationId, pollId, actor) {
    const row = findPoll(conversationId, pollId);
    const counts = sql(`SELECT optionIndex, COUNT(*) AS votes,
      MAX(CASE WHEN actorId = ? THEN 1 ELSE 0 END) AS mine
      FROM group_poll_votes WHERE conversationId = ? AND pollId = ? GROUP BY optionIndex`).all(actor.id, conversationId, pollId);
    return summarizePoll(row, counts);
  }
  function previousRequest(conversationId, actor, clientRequestId, tool, inputJson) {
    const row = sql(`SELECT tool, inputJson, resultId FROM group_vote_game_requests
      WHERE conversationId = ? AND actorId = ? AND clientRequestId = ?`).get(conversationId, actor.id, clientRequestId);
    if (row && (row.tool !== tool || row.inputJson !== inputJson)) {
      fail(409, 'clientRequestId was already used with different parameters or a different tool.');
    }
    return row;
  }
  function saveRequest(conversationId, actor, clientRequestId, tool, inputJson, resultId) {
    sql(`INSERT INTO group_vote_game_requests
      (conversationId, actorId, clientRequestId, tool, inputJson, resultId) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(conversationId, actor.id, clientRequestId, tool, inputJson, resultId);
  }
  function gameResult(row) {
    return {
      id: row.id, conversationId: row.conversationId, actorId: row.actorId, kind: row.kind,
      ...JSON.parse(row.inputJson), ...JSON.parse(row.resultJson), createdAt: row.createdAt,
    };
  }
  function play(args, actor, kind, input, generate) {
    const clientRequestId = text(args.clientRequestId, 'clientRequestId', 128);
    const inputJson = JSON.stringify(input);
    return transaction(() => {
      const conversationId = authorize(args, actor, 'active');
      const tool = `game.${kind}`;
      const previous = previousRequest(conversationId, actor, clientRequestId, tool, inputJson);
      if (previous) {
        const row = sql(`SELECT * FROM group_game_results
          WHERE conversationId = ? AND actorId = ? AND id = ?`).get(conversationId, actor.id, previous.resultId);
        if (!row) fail(409, 'Persisted game result is unavailable; this request cannot be rerolled.');
        return { conversationId, game: gameResult(row), replayed: true };
      }
      const resultJson = JSON.stringify(generate());
      const createdAt = new Date().toISOString();
      const result = sql(`INSERT INTO group_game_results
        (conversationId, actorId, kind, inputJson, resultJson, createdAt) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(conversationId, actor.id, kind, inputJson, resultJson, createdAt);
      const id = Number(result.lastInsertRowid);
      saveRequest(conversationId, actor, clientRequestId, tool, inputJson, id);
      return {
        conversationId,
        game: gameResult({ id, conversationId, actorId: actor.id, kind, inputJson, resultJson, createdAt }),
        replayed: false,
      };
    });
  }

  register('poll.create', 'admin', '在当前对话创建匿名汇总投票；题目及选项会去除首尾空白，同请求标识不会重复创建。', {
    question: { type: 'string', minLength: 1, maxLength: 160, description: '投票题目。' },
    options: { type: 'array', minItems: 2, maxItems: 10, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 120 }, description: '2至10个不重复的选项，每行一项。' },
    clientRequestId: requestProperty,
  }, (args, actor) => {
    const question = text(args.question, 'question', 160);
    if (!Array.isArray(args.options) || args.options.length < 2 || args.options.length > 10) throw new TypeError('options must contain 2 to 10 strings.');
    const options = [];
    for (let index = 0; index < args.options.length; index++) options.push(text(args.options[index], `options[${index}]`, 120));
    if (new Set(options).size !== options.length) throw new TypeError('Poll options must be unique after trimming.');
    const clientRequestId = text(args.clientRequestId, 'clientRequestId', 128);
    const inputJson = JSON.stringify({ question, options });
    return transaction(() => {
      const conversationId = authorize(args, actor, 'admin');
      const previous = previousRequest(conversationId, actor, clientRequestId, 'poll.create', inputJson);
      if (previous) return { conversationId, poll: pollResult(conversationId, previous.resultId, actor), replayed: true };
      const createdAt = new Date().toISOString();
      const result = sql('INSERT INTO group_polls (conversationId, question, optionsJson, createdAt) VALUES (?, ?, ?, ?)')
        .run(conversationId, question, JSON.stringify(options), createdAt);
      const id = Number(result.lastInsertRowid);
      saveRequest(conversationId, actor, clientRequestId, 'poll.create', inputJson, id);
      return { conversationId, poll: pollResult(conversationId, id, actor), replayed: false };
    });
  });

  register('poll.list', 'member', '查看指定对话的投票、各选项票数与自己的选择；不公开其他投票人。', {}, (args, actor) => transaction(() => {
    const conversationId = authorize(args, actor, 'member');
    const rows = sql('SELECT id, conversationId, question, optionsJson, createdAt, closedAt FROM group_polls WHERE conversationId = ? ORDER BY id DESC').all(conversationId);
    const counts = sql(`SELECT pollId, optionIndex, COUNT(*) AS votes,
      MAX(CASE WHEN actorId = ? THEN 1 ELSE 0 END) AS mine
      FROM group_poll_votes WHERE conversationId = ? GROUP BY pollId, optionIndex`).all(actor.id, conversationId);
    const byPoll = new Map();
    for (const count of counts) {
      if (!byPoll.has(count.pollId)) byPoll.set(count.pollId, []);
      byPoll.get(count.pollId).push(count);
    }
    return { conversationId, polls: rows.map((row) => summarizePoll(row, byPoll.get(row.id))) };
  }));

  register('poll.vote', 'active', '对当前对话中的未关闭投票投一票；再次投票会修改自己的选择。', {
    pollId: pollIdProperty,
    optionIndex: { type: 'integer', minimum: 0, maximum: 9, description: '从0开始的选项索引，必须小于该投票选项数量。' },
  }, (args, actor) => {
    const pollId = integer(args.pollId, 'pollId', 1, Number.MAX_SAFE_INTEGER);
    const optionIndex = integer(args.optionIndex, 'optionIndex', 0, 9);
    return transaction(() => {
      const conversationId = authorize(args, actor, 'active');
      const row = findPoll(conversationId, pollId);
      if (row.closedAt !== null) fail(409, 'Poll is closed.');
      if (optionIndex >= JSON.parse(row.optionsJson).length) throw new TypeError('optionIndex does not identify an option in this poll.');
      sql(`INSERT INTO group_poll_votes (conversationId, pollId, actorId, optionIndex) VALUES (?, ?, ?, ?)
        ON CONFLICT (conversationId, pollId, actorId) DO UPDATE SET optionIndex = excluded.optionIndex`)
        .run(conversationId, pollId, actor.id, optionIndex);
      return { conversationId, poll: pollResult(conversationId, pollId, actor) };
    });
  });

  register('poll.close', 'admin', '关闭当前对话中的投票，保留汇总结果；重复关闭不会改变关闭时间。', { pollId: pollIdProperty }, (args, actor) => {
    const pollId = integer(args.pollId, 'pollId', 1, Number.MAX_SAFE_INTEGER);
    return transaction(() => {
      const conversationId = authorize(args, actor, 'admin');
      findPoll(conversationId, pollId);
      sql('UPDATE group_polls SET closedAt = ? WHERE conversationId = ? AND id = ? AND closedAt IS NULL')
        .run(new Date().toISOString(), conversationId, pollId);
      return { conversationId, poll: pollResult(conversationId, pollId, actor) };
    });
  });

  register('game.roll', 'active', '使用加密安全随机数掷骰子并持久化；相同请求只能取回原结果，不能重掷。', {
    count: { type: 'integer', minimum: 1, maximum: 10, description: '骰子数量。' },
    sides: { type: 'integer', minimum: 2, maximum: 1000, description: '每个骰子的面数。' },
    clientRequestId: requestProperty,
  }, (args, actor) => {
    const count = integer(args.count, 'count', 1, 10);
    const sides = integer(args.sides, 'sides', 2, 1000);
    return play(args, actor, 'roll', { count, sides }, () => {
      const dice = Array.from({ length: count }, () => randomInt(1, sides + 1));
      return { dice, total: dice.reduce((sum, value) => sum + value, 0) };
    });
  });

  register('game.rps', 'active', '与加密安全随机出招的电脑进行石头剪刀布，持久化出招及胜负；相同请求不能重抽。', {
    move: { type: 'string', enum: ['rock', 'paper', 'scissors'], description: '自己的出招：rock石头、paper布、scissors剪刀。' },
    clientRequestId: requestProperty,
  }, (args, actor) => {
    if (!['rock', 'paper', 'scissors'].includes(args.move)) throw new TypeError('move must be rock, paper, or scissors.');
    const move = args.move;
    return play(args, actor, 'rps', { move }, () => {
      const moves = ['rock', 'paper', 'scissors'];
      const opponentMove = moves[randomInt(0, moves.length)];
      const outcome = move === opponentMove ? 'draw'
        : ((moves.indexOf(move) - moves.indexOf(opponentMove) + 3) % 3 === 1 ? 'win' : 'loss');
      return { opponentMove, outcome };
    });
  });

  register('game.history', 'member', '查看指定对话最近30条游戏结果；普通成员仅能查看自己的结果，管理员可查看所有身份。', {}, (args, actor) => transaction(() => {
    const conversationId = authorize(args, actor, 'member');
    const rows = actor.admin === true
      ? sql('SELECT * FROM group_game_results WHERE conversationId = ? ORDER BY id DESC LIMIT 30').all(conversationId)
      : sql('SELECT * FROM group_game_results WHERE conversationId = ? AND actorId = ? ORDER BY id DESC LIMIT 30').all(conversationId, actor.id);
    return { conversationId, scope: actor.admin === true ? 'all' : 'self', games: rows.map(gameResult) };
  }));
}
