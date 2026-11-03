// The driver: syntax, then the DNS tier, then (with `smtp`) the probe, with
// shared concurrency limits and the "port 25 is blocked" switch.
import { parseAddress } from "./address.ts";
import { checkDomain, type DomainCheck, type MxHost } from "./dns.ts";
import { resolveOptions, type ResolvedOptions, type VerifierOptions } from "./options.ts";
import { mailProvider } from "./provider.ts";
import { PORT_BLOCKED, probeMailbox, type ProbeResult } from "./smtp.ts";
import type { Action, Checks, Summary, Verdict, VerifyResult } from "./types.ts";
import { errorMessage } from "./util.ts";

export const ACTIONS: Readonly<Record<Verdict, Action>> = Object.freeze({ OK: "send", WEAK: "hold", DEAD: "kill" });
export const VERDICTS: readonly Verdict[] = Object.freeze(["OK", "WEAK", "DEAD"]);

const RANK: Readonly<Record<Verdict, number>> = { OK: 0, WEAK: 1, DEAD: 2 };

type Task<T> = () => Promise<T>;
type Limiter = <T>(fn: Task<T>) => Promise<T>;

function makeSemaphore(n: number): Limiter {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = (): void => {
    if (active >= n) return;
    const run = queue.shift();
    if (!run) return;
    active++;
    run();
  };
  return <T>(fn: Task<T>) =>
    new Promise<T>((res, rej) => {
      queue.push(() =>
        fn()
          .then(res, rej)
          .finally(() => {
            active--;
            next();
          }),
      );
      next();
    });
}

function result(email: string, verdict: Verdict, reason: string, checks: Partial<Checks>): VerifyResult {
  const mx = checks.mx ?? null;
  const provider = mx === null ? null : mailProvider(mx, email.slice(email.lastIndexOf("@") + 1));
  return {
    email,
    action: ACTIONS[verdict],
    verdict,
    reason,
    checks: { syntax: true, mx, provider, smtp: "skipped", catch_all: null, ...checks },
  };
}

// What one batch learns as it goes, so that it asks each domain and each MX
// host only once: the DNS tier per domain (the promise, so a lookup in flight
// is shared too), the catch-all answer per domain, and the MX hosts that
// timed out. A tarpit then costs one timeout per batch, not one per address.
interface Batch {
  domains: Map<string, Promise<DomainCheck>>;
  catchAll: Map<string, boolean>;
  slowMx: Set<string>;
}

const newBatch = (): Batch => ({ domains: new Map(), catchAll: new Map(), slowMx: new Set() });

export interface VerifierState {
  /** True once a probe proved that port 25 is blocked (with autoDisableSmtp). */
  smtpDown: boolean;
  smtpDownWhy: string | null;
}

export interface Verifier {
  verify(email: string): Promise<VerifyResult>;
  verifyBatch(emails: readonly string[]): Promise<VerifyResult[]>;
  readonly state: VerifierState;
  readonly options: ResolvedOptions;
}

// Try the primary MX, then the secondary when the primary cannot be reached at
// all. An MX host that timed out earlier in the batch is not asked again.
async function probeWithFallback(email: string, domain: string, mxHosts: readonly MxHost[], o: ResolvedOptions, batch: Batch): Promise<ProbeResult> {
  let last: ProbeResult | null = null;
  for (const { host, ip } of mxHosts) {
    if (batch.slowMx.has(host)) {
      last = { verdict: "WEAK", reason: `${host} timed out earlier in this batch, so it was not asked again`, smtp: "unreachable", catchAll: null };
      continue;
    }
    const probe = await probeMailbox(email, domain, host, { ...o, connectHost: ip ?? host, catchAll: batch.catchAll.get(domain) });
    if (probe.timedOut) batch.slowMx.add(host);
    if (probe.catchAll !== null) batch.catchAll.set(domain, probe.catchAll);
    if (probe.smtp !== "unreachable") return probe;
    last = probe;
    if (probe.connectError !== undefined && PORT_BLOCKED.has(probe.connectError)) return probe;
  }
  return last ?? { verdict: "WEAK", reason: "no MX host to probe", smtp: "unreachable", catchAll: null };
}

/**
 * A verifier with shared limits. The hosted API keeps one for its lifetime so
 * the SMTP concurrency cap holds across requests; the CLI makes one per run.
 */
export function createVerifier(opts: VerifierOptions = {}): Verifier {
  const o = resolveOptions(opts);
  const state: VerifierState = { smtpDown: false, smtpDownWhy: null };
  const dnsLimit = makeSemaphore(o.dnsConcurrency);
  const smtpLimit = makeSemaphore(o.smtpConcurrency);

  function lookup(domain: string, batch: Batch): Promise<DomainCheck> {
    let check = batch.domains.get(domain);
    if (check === undefined) {
      check = dnsLimit(() => checkDomain(domain, o));
      batch.domains.set(domain, check);
    }
    return check;
  }

  async function verifyOne(raw: string, batch: Batch): Promise<VerifyResult> {
    const parsed = parseAddress(raw);
    if (parsed.error !== undefined) return result(parsed.email, "DEAD", parsed.error, { syntax: false });
    const { email, domain } = parsed;
    try {
      const d = await lookup(domain, batch);
      if (d.verdict === "DEAD") return result(email, "DEAD", d.reason, { mx: null });

      if (!o.smtp) {
        const note = d.verdict === "OK" ? "; mailbox not probed" : "";
        return result(email, d.verdict, `${d.reason}${note}`, { mx: d.mx });
      }
      if (state.smtpDown) {
        return result(email, d.verdict, `${d.reason}; SMTP tier off for this run (${state.smtpDownWhy})`, { mx: d.mx, smtp: "unreachable" });
      }

      const probe = await smtpLimit(() => probeWithFallback(email, domain, d.mxHosts, o, batch));
      if (probe.connectError !== undefined && o.autoDisableSmtp && PORT_BLOCKED.has(probe.connectError)) {
        state.smtpDown = true;
        state.smtpDownWhy = `${probe.connectError} on ${d.mx}:${o.port}`;
        return result(email, d.verdict, `${d.reason}; SMTP tier off for this run (${probe.connectError})`, { mx: d.mx, smtp: "unreachable" });
      }
      const verdict = RANK[probe.verdict] >= RANK[d.verdict] ? probe.verdict : d.verdict;
      const reason = d.verdict === "WEAK" && probe.verdict === "OK" ? `${probe.reason}; ${d.reason}` : probe.reason;
      return result(email, verdict, reason, { mx: d.mx, smtp: probe.smtp, catch_all: probe.catchAll });
    } catch (err) {
      return result(email, "WEAK", `check did not finish (${errorMessage(err)})`, {});
    }
  }

  function verifyBatch(emails: readonly string[]): Promise<VerifyResult[]> {
    const batch = newBatch();
    return Promise.all(emails.map((e) => verifyOne(e, batch)));
  }

  return { verify: (email) => verifyOne(email, newBatch()), verifyBatch, state, options: o };
}

/** One-shot helpers. Each call gets its own limits. */
export function verify(email: string, opts: VerifierOptions = {}): Promise<VerifyResult> {
  return createVerifier(opts).verify(email);
}

export function verifyBatch(emails: readonly string[], opts: VerifierOptions = {}): Promise<VerifyResult[]> {
  return createVerifier(opts).verifyBatch(emails);
}

/** Summary counts for a batch: { send, hold, kill, total }. */
export function summarize(results: readonly Pick<VerifyResult, "action">[]): Summary {
  const s: Summary = { send: 0, hold: 0, kill: 0, total: results.length };
  for (const r of results) s[r.action]++;
  return s;
}
