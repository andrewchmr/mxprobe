// Token buckets in memory. One process, one VPS: that is the whole deployment.
export interface BucketOptions {
  capacity: number;
  refillPerSec: number;
  now?: () => number;
}

export interface TakeResult {
  ok: boolean;
  /** Whole seconds until `n` tokens are back; 0 when ok. */
  retryAfterSec: number;
}

export interface Buckets {
  /** Take n tokens for id. */
  take(id: string | number, n?: number): TakeResult;
  /** How many ids are tracked; idle ones are swept every ten minutes. */
  size(): number;
}

interface Bucket {
  tokens: number;
  at: number;
}

const SWEEP_MS = 600_000;

export function createBuckets({ capacity, refillPerSec, now = Date.now }: BucketOptions): Buckets {
  const buckets = new Map<string | number, Bucket>();
  let lastSweep = now();

  function bucket(id: string | number): Bucket {
    const t = now();
    let b = buckets.get(id);
    if (!b) {
      b = { tokens: capacity, at: t };
      buckets.set(id, b);
    } else {
      b.tokens = Math.min(capacity, b.tokens + ((t - b.at) / 1000) * refillPerSec);
      b.at = t;
    }
    if (t - lastSweep > SWEEP_MS) {
      lastSweep = t;
      for (const [k, v] of buckets) if (t - v.at > SWEEP_MS) buckets.delete(k);
    }
    return b;
  }

  return {
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
