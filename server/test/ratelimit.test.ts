import { test } from "node:test";
import assert from "node:assert/strict";
import { createBuckets } from "../src/ratelimit.ts";

test("token bucket refills", () => {
  let t = 0;
  const b = createBuckets({ capacity: 3, refillPerSec: 1, now: () => t });
  assert.deepEqual(b.take("k", 3), { ok: true, retryAfterSec: 0 });
  assert.deepEqual(b.take("k", 1), { ok: false, retryAfterSec: 1 });
  t = 2000;
  assert.equal(b.take("k", 2).ok, true);
  assert.equal(b.take("k", 1).ok, false);
});

test("token bucket: retryAfterSec is the whole seconds until n tokens are back", () => {
  let t = 0;
  const b = createBuckets({ capacity: 60, refillPerSec: 1, now: () => t });
  b.take("k", 60);
  assert.equal(b.take("k", 30).retryAfterSec, 30);
  t = 10_500;
  assert.equal(b.take("k", 30).retryAfterSec, 20, "10.5 tokens back, 19.5 to go, rounded up");
});

test("token bucket: never above capacity, ids are independent, a default take is 1", () => {
  let t = 0;
  const b = createBuckets({ capacity: 2, refillPerSec: 100, now: () => t });
  assert.equal(b.take("a").ok, true);
  assert.equal(b.take("a").ok, true);
  assert.equal(b.take("a").ok, false);
  assert.equal(b.take("b").ok, true, "another id has its own bucket");
  t = 60_000;
  assert.equal(b.take("a", 3).ok, false, "still capped at 2 after a long wait");
  assert.equal(b.take("a", 2).ok, true);
  assert.equal(b.take(7, 1).ok, true, "numeric ids work");
  assert.equal(b.size(), 3);
});

test("token bucket: idle buckets are swept after ten minutes", () => {
  let t = 0;
  const b = createBuckets({ capacity: 1, refillPerSec: 1, now: () => t });
  b.take("old");
  t = 300_000;
  b.take("mid");
  assert.equal(b.size(), 2);
  t = 700_000;
  b.take("new");
  assert.equal(b.size(), 2, "old (700 s idle) was swept, mid (400 s idle) stays");
  t = 1_400_000;
  b.take("new");
  assert.equal(b.size(), 1);
});
