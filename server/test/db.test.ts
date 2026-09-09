import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { canned } from "./helpers.ts";

/** node:sqlite rows have a null prototype; strict deepEqual wants plain objects. */
const plain = (rows: Record<string, unknown>[]) => rows.map((r) => ({ ...r }));

const newKey = (n: number) => ({ email: `k${n}@good.test`, keyHash: `hash${n}`, keyPrefix: `mxp_${n}`, credits: 100, ip: "127.0.0.1" });

test("db: createKey stores the row, records the signup credit event and enforces one key per email", () => {
  const db = openDb();
  try {
    const row = db.createKey(newKey(1));
    assert.equal(row.id, 1);
    assert.equal(row.email, "k1@good.test");
    assert.equal(row.credits, 100);
    assert.equal(row.checks_total, 0);
    assert.equal(row.revoked, 0);
    assert.equal(row.signup_ip, "127.0.0.1");
    assert.equal(row.last_used_at, null);
    assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(db.keyById(1), row);
    assert.deepEqual(db.keyByHash("hash1"), row);
    assert.deepEqual(db.keyByEmail("k1@good.test"), row);
    assert.equal(db.keyById(2), null);
    assert.equal(db.keyByHash("nope"), null);
    assert.equal(db.keyByEmail("nope"), null);
    assert.throws(() => db.createKey({ ...newKey(2), email: "k1@good.test" }), /UNIQUE/);
    assert.throws(() => db.createKey({ ...newKey(2), keyHash: "hash1" }), /UNIQUE/);
    assert.equal(db.stats().keys, 1, "the failed inserts rolled back");
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM credit_events").get()?.["n"], 1);
    const noIp = db.createKey({ ...newKey(3), ip: undefined });
    assert.equal(noIp.signup_ip, null);
  } finally {
    db.close();
  }
});

test("db: signupsFromIp counts keys from an IP since a time", () => {
  const db = openDb();
  try {
    db.createKey(newKey(1));
    db.createKey(newKey(2));
    db.createKey({ ...newKey(3), ip: "10.0.0.1" });
    const longAgo = new Date(Date.now() - 3600_000).toISOString();
    const future = new Date(Date.now() + 3600_000).toISOString();
    assert.equal(db.signupsFromIp("127.0.0.1", longAgo), 2);
    assert.equal(db.signupsFromIp("10.0.0.1", longAgo), 1);
    assert.equal(db.signupsFromIp("127.0.0.1", future), 0);
    assert.equal(db.signupsFromIp("unknown", longAgo), 0);
  } finally {
    db.close();
  }
});

test("db: chargeCredits is atomic and refuses to overdraw; addCredits records an event", () => {
  const db = openDb();
  try {
    const { id } = db.createKey({ ...newKey(1), credits: 5 });
    assert.equal(db.chargeCredits(id, 0), true, "zero is free");
    assert.equal(db.chargeCredits(id, -1), true);
    assert.equal(db.chargeCredits(id, 3), true);
    assert.equal(db.keyById(id)?.credits, 2);
    assert.equal(db.keyById(id)?.checks_total, 3);
    assert.ok(db.keyById(id)?.last_used_at);
    assert.equal(db.chargeCredits(id, 3), false, "only 2 left");
    assert.equal(db.keyById(id)?.credits, 2, "nothing taken");
    assert.equal(db.chargeCredits(999, 1), false, "unknown key");

    const after = db.addCredits(id, 10, "purchase", "cs_1");
    assert.equal(after.credits, 12);
    db.addCredits(id, 1, "refund", "unreachable");
    db.addCredits(id, -2, "manual", null);
    assert.equal(db.keyById(id)?.credits, 11);
    const events = plain(db.raw.prepare("SELECT delta, kind, ref FROM credit_events WHERE key_id = ? ORDER BY id").all(id));
    assert.deepEqual(events, [
      { delta: 5, kind: "signup", ref: null },
      { delta: 10, kind: "purchase", ref: "cs_1" },
      { delta: 1, kind: "refund", ref: "unreachable" },
      { delta: -2, kind: "manual", ref: null },
    ]);
    assert.throws(() => db.addCredits(999, 1, "manual"), /FOREIGN KEY constraint failed/, "the credit_events foreign key catches an unknown key");
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM credit_events WHERE key_id = 999").get()?.["n"], 0, "rolled back");
  } finally {
    db.close();
  }
});

test("db: setRevoked flips the flag and reports whether a row matched", () => {
  const db = openDb();
  try {
    db.createKey(newKey(1));
    assert.equal(db.setRevoked("k1@good.test", true), true);
    assert.equal(db.keyByEmail("k1@good.test")?.revoked, 1);
    assert.equal(db.setRevoked("k1@good.test", false), true);
    assert.equal(db.keyByEmail("k1@good.test")?.revoked, 0);
    assert.equal(db.setRevoked("nobody@good.test", true), false);
  } finally {
    db.close();
  }
});

test("db: logVerify writes one row per result, bumps the daily stats, and purgeLog empties it", () => {
  const db = openDb();
  try {
    const { id } = db.createKey(newKey(1));
    db.logVerify(id, [canned("a@good.test"), canned("b@good.test", "WEAK", { catch_all: true }), canned("c@good.test", "DEAD", { smtp: "rejected", catch_all: null })], 42);
    db.logVerify(id, [canned("d@good.test")], 7);
    const rows = plain(db.raw.prepare("SELECT email, action, verdict, mx, smtp, catch_all, ms FROM verify_log ORDER BY id").all());
    assert.deepEqual(rows, [
      { email: "a@good.test", action: "send", verdict: "OK", mx: "mx.good.test", smtp: "accepted", catch_all: 0, ms: 42 },
      { email: "b@good.test", action: "hold", verdict: "WEAK", mx: "mx.good.test", smtp: "accepted", catch_all: 1, ms: 42 },
      { email: "c@good.test", action: "kill", verdict: "DEAD", mx: "mx.good.test", smtp: "rejected", catch_all: null, ms: 42 },
      { email: "d@good.test", action: "send", verdict: "OK", mx: "mx.good.test", smtp: "accepted", catch_all: 0, ms: 7 },
    ]);
    const today = new Date().toISOString().slice(0, 10);
    assert.deepEqual(db.stats().last_30_days, [{ day: today, checks: 4, send: 2, hold: 1, kill: 1 }]);
    assert.deepEqual(db.stats().verdict_mix, { checks: 4, send: 2, hold: 1, kill: 1 });
    assert.equal(db.purgeLog(new Date(Date.now() - 3600_000).toISOString()), 0, "nothing that old");
    assert.equal(db.purgeLog(new Date(Date.now() + 3600_000).toISOString()), 4);
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM verify_log").get()?.["n"], 0);
    assert.equal(db.stats().verdict_mix.checks, 4, "the daily counts survive the purge");
  } finally {
    db.close();
  }
});

test("db: stripe events are claimed once and can be released", () => {
  const db = openDb();
  try {
    assert.equal(db.claimStripeEvent("evt_1", "checkout.session.completed"), true);
    assert.equal(db.claimStripeEvent("evt_1", "checkout.session.completed"), false);
    assert.equal(db.releaseStripeEvent("evt_1"), 1);
    assert.equal(db.releaseStripeEvent("evt_1"), 0);
    assert.equal(db.claimStripeEvent("evt_1", "x"), true);
  } finally {
    db.close();
  }
});

test("db: subscribers are unique, feedback is not", () => {
  const db = openDb();
  try {
    assert.equal(db.addSubscriber("a@good.test", "127.0.0.1"), true);
    assert.equal(db.addSubscriber("a@good.test"), false);
    assert.equal(db.addSubscriber("b@good.test"), true);
    assert.equal(db.addFeedback("a@good.test", "hi", "127.0.0.1"), 1);
    assert.equal(db.addFeedback(null, "anon"), 2);
    const s = db.stats();
    assert.equal(s.subscribers, 2);
    assert.equal(s.feedback, 2);
  } finally {
    db.close();
  }
});

test("db: stats and listKeys", () => {
  const db = openDb();
  try {
    const a = db.createKey(newKey(1));
    const b = db.createKey({ ...newKey(2), credits: 50 });
    db.addCredits(a.id, 10000, "purchase", "cs_1");
    db.addCredits(a.id, 10000, "purchase", "cs_2");
    db.chargeCredits(b.id, 20);
    db.setRevoked("k2@good.test", true);
    const s = db.stats();
    assert.equal(s.keys, 2);
    assert.equal(s.keys_revoked, 1);
    assert.equal(s.purchases, 2);
    assert.equal(s.paying_keys, 1);
    assert.equal(s.checks_total, 20);
    assert.equal(s.credits_outstanding, 20100 + 30);
    assert.deepEqual(s.verdict_mix, { checks: 0, send: 0, hold: 0, kill: 0 });
    const keys = db.listKeys();
    assert.equal(keys.length, 2);
    assert.deepEqual(Object.keys(keys[0] ?? {}), ["id", "key_prefix", "email", "credits", "checks_total", "revoked", "signup_ip", "created_at", "last_used_at"]);
    assert.equal(keys[0]?.email, "k2@good.test", "newest first");
    assert.ok(!("key_hash" in (keys[0] ?? {})), "the hash is never listed");
  } finally {
    db.close();
  }
});

test("db: a file on disk is created, reopened and in WAL mode", async () => {
  const { mkdtempSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const path = join(mkdtempSync(join(tmpdir(), "mxprobe-db-")), "t.sqlite");
  let db = openDb(path);
  db.createKey(newKey(1));
  assert.equal(db.raw.prepare("PRAGMA journal_mode").get()?.["journal_mode"], "wal");
  db.close();
  assert.ok(existsSync(path));
  db = openDb(path);
  try {
    assert.equal(db.keyByEmail("k1@good.test")?.credits, 100);
  } finally {
    db.close();
  }
});
