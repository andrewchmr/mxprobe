// One SQLite file. Keys and credits, a 24-hour verify log, daily counts
// without addresses, Stripe event ids, subscribers and feedback.
import { DatabaseSync } from "node:sqlite";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS keys (
  id INTEGER PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  credits INTEGER NOT NULL DEFAULT 0,
  checks_total INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0,
  signup_ip TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS keys_signup_ip ON keys(signup_ip, created_at);
CREATE TABLE IF NOT EXISTS credit_events (
  id INTEGER PRIMARY KEY,
  key_id INTEGER NOT NULL REFERENCES keys(id),
  delta INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE IF NOT EXISTS verify_log (
  id INTEGER PRIMARY KEY,
  key_id INTEGER,
  email TEXT NOT NULL,
  action TEXT NOT NULL,
  verdict TEXT NOT NULL,
  reason TEXT,
  mx TEXT,
  smtp TEXT,
  catch_all INTEGER,
  ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE INDEX IF NOT EXISTS verify_log_created ON verify_log(created_at);
CREATE TABLE IF NOT EXISTS stats_daily (
  day TEXT PRIMARY KEY,
  checks INTEGER NOT NULL DEFAULT 0,
  send INTEGER NOT NULL DEFAULT 0,
  hold INTEGER NOT NULL DEFAULT 0,
  kill INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY,
  email TEXT,
  message TEXT NOT NULL,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
`;

export function openDb(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  db.exec(SCHEMA);

  const q = {
    insertKey: db.prepare("INSERT INTO keys (key_hash, key_prefix, email, credits, signup_ip) VALUES (?, ?, ?, ?, ?)"),
    keyById: db.prepare("SELECT * FROM keys WHERE id = ?"),
    keyByHash: db.prepare("SELECT * FROM keys WHERE key_hash = ?"),
    keyByEmail: db.prepare("SELECT * FROM keys WHERE email = ?"),
    signupsFromIp: db.prepare("SELECT COUNT(*) AS n FROM keys WHERE signup_ip = ? AND created_at > ?"),
    charge: db.prepare(`UPDATE keys SET credits = credits - ?, checks_total = checks_total + ?, last_used_at = ${NOW} WHERE id = ? AND credits >= ?`),
    credit: db.prepare("UPDATE keys SET credits = credits + ? WHERE id = ?"),
    creditEvent: db.prepare("INSERT INTO credit_events (key_id, delta, kind, ref) VALUES (?, ?, ?, ?)"),
    setRevoked: db.prepare("UPDATE keys SET revoked = ? WHERE email = ?"),
    logVerify: db.prepare("INSERT INTO verify_log (key_id, email, action, verdict, reason, mx, smtp, catch_all, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
    purgeLog: db.prepare("DELETE FROM verify_log WHERE created_at < ?"),
    bumpStats: db.prepare(`INSERT INTO stats_daily (day, checks, send, hold, kill) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET checks = checks + excluded.checks, send = send + excluded.send, hold = hold + excluded.hold, kill = kill + excluded.kill`),
    claimEvent: db.prepare("INSERT OR IGNORE INTO stripe_events (id, type) VALUES (?, ?)"),
    releaseEvent: db.prepare("DELETE FROM stripe_events WHERE id = ?"),
    addSubscriber: db.prepare("INSERT OR IGNORE INTO subscribers (email, ip) VALUES (?, ?)"),
    addFeedback: db.prepare("INSERT INTO feedback (email, message, ip) VALUES (?, ?, ?)"),
  };

  return {
    raw: db,

    createKey({ email, keyHash, keyPrefix, credits, ip }) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const { lastInsertRowid } = q.insertKey.run(keyHash, keyPrefix, email, credits, ip ?? null);
        q.creditEvent.run(lastInsertRowid, credits, "signup", null);
        db.exec("COMMIT");
        return q.keyById.get(lastInsertRowid);
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    keyById: (id) => q.keyById.get(id) ?? null,
    keyByHash: (hash) => q.keyByHash.get(hash) ?? null,
    keyByEmail: (email) => q.keyByEmail.get(email) ?? null,
    signupsFromIp: (ip, sinceIso) => Number(q.signupsFromIp.get(ip, sinceIso).n),

    /** Atomic: false when the key has fewer than n credits. */
    chargeCredits(keyId, n) {
      if (n <= 0) return true;
      return q.charge.run(n, n, keyId, n).changes === 1;
    },
    addCredits(keyId, n, kind, ref = null) {
      db.exec("BEGIN IMMEDIATE");
      try {
        q.credit.run(n, keyId);
        q.creditEvent.run(keyId, n, kind, ref);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return q.keyById.get(keyId);
    },
    setRevoked: (email, flag) => q.setRevoked.run(flag ? 1 : 0, email).changes === 1,

    logVerify(keyId, results, ms) {
      const day = new Date().toISOString().slice(0, 10);
      const s = { send: 0, hold: 0, kill: 0 };
      db.exec("BEGIN");
      try {
        for (const r of results) {
          s[r.action]++;
          q.logVerify.run(keyId, r.email, r.action, r.verdict, r.reason, r.checks.mx, r.checks.smtp, r.checks.catch_all == null ? null : r.checks.catch_all ? 1 : 0, ms);
        }
        q.bumpStats.run(day, results.length, s.send, s.hold, s.kill);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    purgeLog: (olderThanIso) => q.purgeLog.run(olderThanIso).changes,

    claimStripeEvent: (id, type) => q.claimEvent.run(id, type).changes === 1,
    releaseStripeEvent: (id) => q.releaseEvent.run(id).changes,

    addSubscriber: (email, ip) => q.addSubscriber.run(email, ip ?? null).changes === 1,
    addFeedback: (email, message, ip) => q.addFeedback.run(email ?? null, message, ip ?? null).lastInsertRowid,

    /** The numbers the kill rule reads. */
    stats() {
      const one = (sql, ...p) => db.prepare(sql).get(...p);
      return {
        keys: Number(one("SELECT COUNT(*) AS n FROM keys").n),
        keys_revoked: Number(one("SELECT COUNT(*) AS n FROM keys WHERE revoked = 1").n),
        purchases: Number(one("SELECT COUNT(*) AS n FROM credit_events WHERE kind = 'purchase'").n),
        paying_keys: Number(one("SELECT COUNT(DISTINCT key_id) AS n FROM credit_events WHERE kind = 'purchase'").n),
        checks_total: Number(one("SELECT COALESCE(SUM(checks_total), 0) AS n FROM keys").n),
        credits_outstanding: Number(one("SELECT COALESCE(SUM(credits), 0) AS n FROM keys").n),
        subscribers: Number(one("SELECT COUNT(*) AS n FROM subscribers").n),
        feedback: Number(one("SELECT COUNT(*) AS n FROM feedback").n),
        last_30_days: db.prepare("SELECT day, checks, send, hold, kill FROM stats_daily WHERE day >= date('now', '-30 days') ORDER BY day").all(),
        verdict_mix: one("SELECT COALESCE(SUM(checks),0) AS checks, COALESCE(SUM(send),0) AS send, COALESCE(SUM(hold),0) AS hold, COALESCE(SUM(kill),0) AS kill FROM stats_daily"),
      };
    },
    listKeys: () => db.prepare("SELECT id, key_prefix, email, credits, checks_total, revoked, signup_ip, created_at, last_used_at FROM keys ORDER BY created_at DESC").all(),
    close: () => db.close(),
  };
}
