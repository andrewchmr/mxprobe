// One SQLite file. Keys and credits, a 24-hour verify log, daily counts
// without addresses, Stripe event ids, subscribers and feedback.
import { DatabaseSync } from "node:sqlite";
import { summarize, type VerifyResult } from "mxprobe-core";

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

export interface KeyRow {
  id: number;
  key_hash: string;
  key_prefix: string;
  email: string;
  credits: number;
  checks_total: number;
  /** 0 or 1 */
  revoked: number;
  signup_ip: string | null;
  created_at: string;
  last_used_at: string | null;
}

/** A key as `admin keys` lists it: everything but the hash. */
export type KeyListing = Omit<KeyRow, "key_hash">;

export type CreditKind = "signup" | "purchase" | "refund" | "manual";

export interface NewKey {
  email: string;
  keyHash: string;
  keyPrefix: string;
  credits: number;
  ip?: string | null;
}

export interface DailyStats {
  day: string;
  checks: number;
  send: number;
  hold: number;
  kill: number;
}

export interface Stats {
  keys: number;
  keys_revoked: number;
  purchases: number;
  paying_keys: number;
  checks_total: number;
  credits_outstanding: number;
  subscribers: number;
  feedback: number;
  last_30_days: DailyStats[];
  verdict_mix: Omit<DailyStats, "day">;
}

export interface Db {
  readonly raw: DatabaseSync;
  createKey(key: NewKey): KeyRow;
  keyById(id: number | bigint): KeyRow | null;
  keyByHash(hash: string): KeyRow | null;
  keyByEmail(email: string): KeyRow | null;
  signupsFromIp(ip: string, sinceIso: string): number;
  /** Atomic: false when the key has fewer than n credits. */
  chargeCredits(keyId: number, n: number): boolean;
  addCredits(keyId: number, n: number, kind: CreditKind, ref?: string | null): KeyRow;
  setRevoked(email: string, flag: boolean): boolean;
  logVerify(keyId: number, results: readonly VerifyResult[], ms: number): void;
  /** Delete log rows older than the ISO timestamp; returns how many. */
  purgeLog(olderThanIso: string): number;
  /** False when the event id was seen before. */
  claimStripeEvent(id: string, type: string): boolean;
  releaseStripeEvent(id: string): number;
  /** False when the address was already subscribed. */
  addSubscriber(email: string, ip?: string | null): boolean;
  addFeedback(email: string | null, message: string, ip?: string | null): number | bigint;
  /** The numbers the kill rule reads. */
  stats(): Stats;
  listKeys(): KeyListing[];
  close(): void;
}

const count = (row: Record<string, unknown> | undefined): number => Number(row?.["n"] ?? 0);

// node:sqlite rows have a null prototype; callers (and deepEqual in tests) expect plain objects.
const plain = <T>(row: Record<string, unknown> | undefined): T | null => (row ? ({ ...row } as T) : null);
const plainAll = <T>(rows: readonly Record<string, unknown>[]): T[] => rows.map((r) => ({ ...r }) as T);

export function openDb(path = ":memory:"): Db {
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

  const keyRow = (id: number | bigint): KeyRow => {
    const row = plain<KeyRow>(q.keyById.get(id));
    if (!row) throw new Error(`no key with id ${id}`);
    return row;
  };

  function transaction<T>(mode: "BEGIN" | "BEGIN IMMEDIATE", fn: () => T): T {
    db.exec(mode);
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  return {
    raw: db,

    createKey({ email, keyHash, keyPrefix, credits, ip }) {
      return transaction("BEGIN IMMEDIATE", () => {
        const { lastInsertRowid } = q.insertKey.run(keyHash, keyPrefix, email, credits, ip ?? null);
        q.creditEvent.run(lastInsertRowid, credits, "signup", null);
        return keyRow(lastInsertRowid);
      });
    },
    keyById: (id) => plain<KeyRow>(q.keyById.get(id)),
    keyByHash: (hash) => plain<KeyRow>(q.keyByHash.get(hash)),
    keyByEmail: (email) => plain<KeyRow>(q.keyByEmail.get(email)),
    signupsFromIp: (ip, sinceIso) => count(q.signupsFromIp.get(ip, sinceIso)),

    chargeCredits(keyId, n) {
      if (n <= 0) return true;
      return Number(q.charge.run(n, n, keyId, n).changes) === 1;
    },
    addCredits(keyId, n, kind, ref = null) {
      return transaction("BEGIN IMMEDIATE", () => {
        q.credit.run(n, keyId);
        q.creditEvent.run(keyId, n, kind, ref);
        return keyRow(keyId);
      });
    },
    setRevoked: (email, flag) => Number(q.setRevoked.run(flag ? 1 : 0, email).changes) === 1,

    logVerify(keyId, results, ms) {
      const day = new Date().toISOString().slice(0, 10);
      const s = summarize(results);
      transaction("BEGIN", () => {
        for (const r of results) {
          q.logVerify.run(keyId, r.email, r.action, r.verdict, r.reason, r.checks.mx, r.checks.smtp, r.checks.catch_all == null ? null : r.checks.catch_all ? 1 : 0, ms);
        }
        q.bumpStats.run(day, s.total, s.send, s.hold, s.kill);
      });
    },
    purgeLog: (olderThanIso) => Number(q.purgeLog.run(olderThanIso).changes),

    claimStripeEvent: (id, type) => Number(q.claimEvent.run(id, type).changes) === 1,
    releaseStripeEvent: (id) => Number(q.releaseEvent.run(id).changes),

    addSubscriber: (email, ip = null) => Number(q.addSubscriber.run(email, ip).changes) === 1,
    addFeedback: (email, message, ip = null) => q.addFeedback.run(email, message, ip).lastInsertRowid,

    stats() {
      const one = (sql: string) => db.prepare(sql).get() as Record<string, unknown> | undefined;
      const mix = one("SELECT COALESCE(SUM(checks),0) AS checks, COALESCE(SUM(send),0) AS send, COALESCE(SUM(hold),0) AS hold, COALESCE(SUM(kill),0) AS kill FROM stats_daily") ?? {};
      return {
        keys: count(one("SELECT COUNT(*) AS n FROM keys")),
        keys_revoked: count(one("SELECT COUNT(*) AS n FROM keys WHERE revoked = 1")),
        purchases: count(one("SELECT COUNT(*) AS n FROM credit_events WHERE kind = 'purchase'")),
        paying_keys: count(one("SELECT COUNT(DISTINCT key_id) AS n FROM credit_events WHERE kind = 'purchase'")),
        checks_total: count(one("SELECT COALESCE(SUM(checks_total), 0) AS n FROM keys")),
        credits_outstanding: count(one("SELECT COALESCE(SUM(credits), 0) AS n FROM keys")),
        subscribers: count(one("SELECT COUNT(*) AS n FROM subscribers")),
        feedback: count(one("SELECT COUNT(*) AS n FROM feedback")),
        last_30_days: plainAll<DailyStats>(db.prepare("SELECT day, checks, send, hold, kill FROM stats_daily WHERE day >= date('now', '-30 days') ORDER BY day").all()),
        verdict_mix: { checks: Number(mix["checks"] ?? 0), send: Number(mix["send"] ?? 0), hold: Number(mix["hold"] ?? 0), kill: Number(mix["kill"] ?? 0) },
      };
    },
    listKeys: () => plainAll<KeyListing>(db.prepare("SELECT id, key_prefix, email, credits, checks_total, revoked, signup_ip, created_at, last_used_at FROM keys ORDER BY created_at DESC, id DESC").all()),
    close: () => db.close(),
  };
}
