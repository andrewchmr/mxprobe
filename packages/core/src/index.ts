// MX Probe engine. Zero dependencies, Node 20+.
//
// Two tiers, run in order:
//   1. DNS. Free and local. Finds domains that cannot receive mail: no MX and
//      a web host behind the A record, a null MX, an MX that does not resolve,
//      a domain that does not exist, a parking host as MX.
//   2. SMTP probe. Connects to the MX on port 25, says EHLO and MAIL FROM,
//      asks RCPT TO for the address and for a random local part (the catch-all
//      test), then QUITs. No message is ever sent. Needs outbound port 25.
//
// The verdict contract, the same in the CLI, the MCP server and the API:
//   { email, action, verdict, reason, checks: { syntax, mx, smtp, catch_all } }
//   action  = send | hold | kill
//   verdict = OK   | WEAK | DEAD
//   `hold` never becomes `kill` on a refusal, a greylist or a catch-all. Only
//   a 5xx that names the mailbox kills.

import { createRequire } from "node:module";

/** The package version, read from package.json so a bump is one edit there. */
export const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

export { parseAddress, type AddressError, type ParsedAddress, type ParseResult } from "./address.ts";
export { checkDomain, labelWebHost, type DomainCheck, type MxHost } from "./dns.ts";
export { DEFAULTS, resolveOptions, type ResolvedOptions, type VerifierOptions } from "./options.ts";
export { probeMailbox, PORT_BLOCKED, type ProbeOptions, type ProbeResult, type ProbeSmtp } from "./smtp.ts";
export { ACTIONS, VERDICTS, createVerifier, summarize, verify, verifyBatch, type Verifier, type VerifierState } from "./verifier.ts";
export { errorMessage } from "./util.ts";
export type { Action, Checks, MxRecord, Resolver, SmtpCheck, Summary, Verdict, VerifyResult } from "./types.ts";
export type { ApiErrorBody, BalanceResponse, CheckoutResponse, SignupResponse, VerifyResponse } from "./api.ts";
