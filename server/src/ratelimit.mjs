// Token buckets in memory. One process, one VPS: that is the whole deployment.
export function createBuckets({ capacity, refillPerSec, now = Date.now }) {
  const buckets = new Map();
  let lastSweep = now();

  function bucket(id) {
    const t = now();
    let b = buckets.get(id);
    if (!b) {
      b = { tokens: capacity, at: t };
      buckets.set(id, b);
    } else {
      b.tokens = Math.min(capacity, b.tokens + ((t - b.at) / 1000) * refillPerSec);
      b.at = t;
    }
    if (t - lastSweep > 600_000) {
      lastSweep = t;
      for (const [k, v] of buckets) if (t - v.at > 600_000) buckets.delete(k);
    }
    return b;
  }

  return {
    /** Take n tokens; returns { ok, retryAfterSec }. */
    take(id, n = 1) {
      const b = bucket(id);
      if (b.tokens >= n) {
        b.tokens -= n;
        return { ok: true, retryAfterSec: 0 };
      }
      return { ok: false, retryAfterSec: Math.ceil((n - b.tokens) / refillPerSec) };
    },
    size: () => buckets.size,
  };
}
