// The driver: syntax, then the DNS tier, then (with `smtp`) the probe, with
// shared concurrency limits and the "port 25 is blocked" switch.
import { parseAddress } from "./address.ts";
import { checkDomain, type MxHost } from "./dns.ts";
import { resolveOptions, type ResolvedOptions, type VerifierOptions } from "./options.ts";
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
  return {
    email,
    action: ACTIONS[verdict],
    verdict,
    reason,
    checks: { syntax: true, mx: null, smtp: "skipped", catch_all: null, ...checks },
  };
}

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

// Try the primary MX, then the secondary when the primary cannot be reached at all.
async function probeWithFallback(email: string, domain: string, mxHosts: readonly MxHost[], o: ResolvedOptions): Promise<ProbeResult> {
  let last: ProbeResult | null = null;
  for (const { host, ip } of mxHosts) {
    const probe = await probeMailbox(email, domain, host, { ...o, connectHost: ip ?? host });
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

  async function verify(raw: string): Promise<VerifyResult> {
    const parsed = parseAddress(raw);
    if (parsed.error !== undefined) return result(parsed.email, "DEAD", parsed.error, { syntax: false });
    const { email, domain } = parsed;
    try {
      const d = await dnsLimit(() => checkDomain(domain, o));
      if (d.verdict === "DEAD") return result(email, "DEAD", d.reason, { mx: null });

      if (!o.smtp) {
        const note = d.verdict === "OK" ? "; mailbox not probed" : "";
        return result(email, d.verdict, `${d.reason}${note}`, { mx: d.mx });
      }
      if (state.smtpDown) {
        return result(email, d.verdict, `${d.reason}; SMTP tier off for this run (${state.smtpDownWhy})`, { mx: d.mx, smtp: "unreachable" });
      }

      const probe = await smtpLimit(() => probeWithFallback(email, domain, d.mxHosts, o));
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
    return Promise.all(emails.map((e) => verify(e)));
  }

  return { verify, verifyBatch, state, options: o };
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
