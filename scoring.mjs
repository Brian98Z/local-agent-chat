import { randomInt } from 'node:crypto';

// This module supplies persistence and selection only. The caller must authenticate
// and authorize the adjudicator and verify the cited work before recording a score.
export function createScoring(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scoring_rounds (
      id INTEGER PRIMARY KEY,
      conversationId INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      roundKey TEXT NOT NULL,
      selectedAgentId TEXT NOT NULL REFERENCES agents(id),
      selectedAt TEXT NOT NULL,
      UNIQUE(conversationId, roundKey)
    );
    CREATE TABLE IF NOT EXISTS scoring_awards (
      id INTEGER PRIMARY KEY,
      roundId INTEGER NOT NULL UNIQUE REFERENCES scoring_rounds(id) ON DELETE CASCADE,
      points INTEGER NOT NULL CHECK(points BETWEEN 0 AND 100),
      evidence TEXT NOT NULL,
      rationale TEXT NOT NULL,
      adjudicator TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scoring_pending_rounds (
      conversationId INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      roundKey TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      PRIMARY KEY(conversationId, roundKey)
    );
    CREATE INDEX IF NOT EXISTS scoring_rounds_conversation ON scoring_rounds(conversationId, id);
  `);
  const statement = (sql) => db.prepare(sql);
  const positiveId = (value, name) => {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Invalid ${name}.`);
  };
  const text = (value, name, max) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TypeError(`Invalid ${name}.`);
    return value.trim();
  };
  const roundQuery = `SELECT r.id,r.conversationId,r.roundKey,r.selectedAgentId,r.selectedAt,
    a.points,a.evidence,a.rationale,a.adjudicator,a.createdAt AS scoredAt
    FROM scoring_rounds r LEFT JOIN scoring_awards a ON a.roundId = r.id`;
  function getRound(id) {
    positiveId(id, 'round id');
    return statement(`${roundQuery} WHERE r.id = ?`).get(id) ?? null;
  }
  return Object.freeze({
    // One cryptographically random active member per conversation/round key.
    // Retries return the original selection; caller defines the round boundaries.
    selectRound(conversationId, roundKey) {
      positiveId(conversationId, 'conversation id');
      roundKey = text(roundKey, 'round key', 160);
      db.exec('SAVEPOINT scoring_select');
      try {
        let round = statement(`${roundQuery} WHERE r.conversationId = ? AND r.roundKey = ?`).get(conversationId, roundKey);
        if (!round) {
          if (!statement('SELECT 1 FROM conversations WHERE id = ?').get(conversationId)) throw new Error('Conversation not found.');
          const agents = statement("SELECT id FROM agents WHERE status = 'active' ORDER BY id").all();
          if (!agents.length) throw new Error('No active members available for audit.');
          const selected = agents[randomInt(agents.length)].id;
          const result = statement('INSERT INTO scoring_rounds(conversationId,roundKey,selectedAgentId,selectedAt) VALUES (?,?,?,?)')
            .run(conversationId, roundKey, selected, new Date().toISOString());
          round = getRound(Number(result.lastInsertRowid));
          statement('DELETE FROM scoring_pending_rounds WHERE conversationId = ? AND roundKey = ?').run(conversationId, roundKey);
        }
        db.exec('RELEASE scoring_select');
        return round;
      } catch (error) {
        db.exec('ROLLBACK TO scoring_select; RELEASE scoring_select');
        throw error;
      }
    },
    // Invoke in the message insertion transaction. A round remains pending when
    // no member is active; retrying this method later completes the selection.
    selectMessageRound(conversationId, messageId) {
      positiveId(conversationId, 'conversation id');
      positiveId(messageId, 'message id');
      const roundKey = `message:${messageId}`;
      db.exec('SAVEPOINT scoring_message');
      try {
        let round = statement(`${roundQuery} WHERE r.conversationId = ? AND r.roundKey = ?`).get(conversationId, roundKey);
        if (!round) {
          if (!statement('SELECT 1 FROM conversations WHERE id = ?').get(conversationId)) throw new Error('Conversation not found.');
          if (statement("SELECT 1 FROM agents WHERE status = 'active' LIMIT 1").get()) {
            round = this.selectRound(conversationId, roundKey);
          } else {
            statement('INSERT INTO scoring_pending_rounds(conversationId,roundKey,createdAt) VALUES (?,?,?) ON CONFLICT(conversationId,roundKey) DO NOTHING')
              .run(conversationId, roundKey, new Date().toISOString());
            round = { id: null, conversationId, roundKey, selectedAgentId: null, selectedAt: null,
              points: null, evidence: null, rationale: null, adjudicator: null, scoredAt: null };
          }
        }
        db.exec('RELEASE scoring_message');
        return round;
      } catch (error) {
        db.exec('ROLLBACK TO scoring_message; RELEASE scoring_message');
        throw error;
      }
    },
    // Exactly one adjudicated award per selection. Evidence is a nonempty reference,
    // not proof by itself; the trusted caller is responsible for its verification.
    recordAward(roundId, { points, evidence, rationale, adjudicator }) {
      positiveId(roundId, 'round id');
      if (!Number.isSafeInteger(points) || points < 0 || points > 100) throw new TypeError('Invalid points.');
      evidence = text(evidence, 'evidence', 8000);
      rationale = text(rationale, 'rationale', 8000);
      adjudicator = text(adjudicator, 'adjudicator', 160);
      // Do not rely on SQLite foreign_keys being enabled: an award must refer to
      // an existing, still-unscored round even when the caller races another writer.
      const result = statement(`INSERT INTO scoring_awards(roundId,points,evidence,rationale,adjudicator,createdAt)
        SELECT r.id,?,?,?,?,? FROM scoring_rounds r
        WHERE r.id = ? AND NOT EXISTS (SELECT 1 FROM scoring_awards a WHERE a.roundId = r.id)`)
        .run(points, evidence, rationale, adjudicator, new Date().toISOString(), roundId);
      if (!result.changes) {
        if (!getRound(roundId)) throw new Error('Audit round not found.');
        throw new Error('Audit round already scored.');
      }
      return getRound(roundId);
    },
    getRound,
    listRounds(conversationId) {
      positiveId(conversationId, 'conversation id');
      const rounds = statement(`${roundQuery} WHERE r.conversationId = ? ORDER BY r.id DESC`).all(conversationId);
      const pending = statement(`SELECT NULL AS id, conversationId, roundKey, NULL AS selectedAgentId,
        NULL AS selectedAt, NULL AS points, NULL AS evidence, NULL AS rationale,
        NULL AS adjudicator, NULL AS scoredAt FROM scoring_pending_rounds
        WHERE conversationId = ? ORDER BY createdAt DESC, roundKey DESC`).all(conversationId);
      return [...pending, ...rounds];
    },
    leaderboard(conversationId) {
      positiveId(conversationId, 'conversation id');
      return statement(`SELECT ag.id AS agentId, ag.name, SUM(a.points) AS points, COUNT(a.id) AS audits
        FROM scoring_awards a JOIN scoring_rounds r ON r.id = a.roundId
        JOIN agents ag ON ag.id = r.selectedAgentId WHERE r.conversationId = ?
        GROUP BY ag.id, ag.name ORDER BY points DESC, audits DESC, ag.id`).all(conversationId);
    },
    // Call in the same transaction as deleting a conversation. Existing servers
    // may have foreign_keys disabled or may delete their own related rows first.
    deleteConversation(conversationId) {
      positiveId(conversationId, 'conversation id');
      db.exec('SAVEPOINT scoring_delete');
      try {
        statement('DELETE FROM scoring_awards WHERE roundId IN (SELECT id FROM scoring_rounds WHERE conversationId = ?)').run(conversationId);
        statement('DELETE FROM scoring_pending_rounds WHERE conversationId = ?').run(conversationId);
        statement('DELETE FROM scoring_rounds WHERE conversationId = ?').run(conversationId);
        db.exec('RELEASE scoring_delete');
      } catch (error) {
        db.exec('ROLLBACK TO scoring_delete; RELEASE scoring_delete');
        throw error;
      }
    },
  });
}
