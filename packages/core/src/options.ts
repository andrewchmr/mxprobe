import { promises as dnsPromises } from "node:dns";
import { hostname } from "node:os";
import type { Resolver } from "./types.ts";

export interface VerifierOptions {
  /** Run the SMTP probe after the DNS tier. Needs outbound port 25. */
  smtp?: boolean;
  dnsTimeoutMs?: number;
  smtpTimeoutMs?: number;
  smtpConcurrency?: number;
  dnsConcurrency?: number;
  /** The name given in EHLO. Best: the reverse DNS name of the probing IP. Default: this machine's host name. */
  helo?: string;
  /** The MAIL FROM address. Default "": the null sender, MAIL FROM:<>, which names no domain. */
  from?: string;
  port?: number;
  /** Connect here instead of the MX host, for tests against a local server. */
  hostOverride?: string | null;
  /**
   * When true, an ECONNREFUSED / EHOSTUNREACH / ENETUNREACH on a probe turns
   * the SMTP tier off for the rest of the run: the network blocks port 25.
   * The hosted API sets this to false because its port is proven by a health
   * check, and one refusing MX must not switch the tier off for everyone.
   */
  autoDisableSmtp?: boolean;
  resolver?: Resolver;
}

export type ResolvedOptions = Required<VerifierOptions>;

// The probe names this machine, not mxprobe.dev: the SPF record of
// probe.mxprobe.dev allows only the hosted API's IP, so from any other IP that
// HELO fails the check. The hosted API sets its own helo and from.
export const DEFAULTS: Readonly<ResolvedOptions> = Object.freeze({
  smtp: false,
  dnsTimeoutMs: 8000,
  smtpTimeoutMs: 12000,
  smtpConcurrency: 3,
  dnsConcurrency: 20,
  helo: hostname() || "localhost",
  from: "",
  port: 25,
  hostOverride: null,
  autoDisableSmtp: true,
  resolver: dnsPromises,
});

/** Defaults under the caller's options. An explicit `undefined` keeps the default. */
export function resolveOptions(opts: VerifierOptions = {}): ResolvedOptions {
  const out: Record<string, unknown> = { ...DEFAULTS };
  for (const [key, value] of Object.entries(opts)) {
    if (value !== undefined) out[key] = value;
  }
  return out as ResolvedOptions;
}
