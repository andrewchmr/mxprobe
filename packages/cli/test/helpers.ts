import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTIONS, type Resolver, type VerifyResult } from "mxprobe-core";
import type { FetchLike } from "../src/client.ts";

const nx = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

/** good.test has an MX; dead.test is NXDOMAIN; anything else has an MX too. */
export const resolver: Resolver = {
  async resolveMx(d) {
    if (d === "dead.test") throw nx("ENOTFOUND");
    return [{ exchange: "mx.good.test", priority: 10 }];
  },
  async resolve4(h) {
    if (h === "mx.good.test") return ["192.0.2.1"];
    throw nx("ENODATA");
  },
  async resolve6() {
    throw nx("ENODATA");
  },
  async reverse() {
    throw nx("ENOTFOUND");
  },
};

/** A fresh config dir per test, so no test sees another's key. */
export const freshEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const dir = mkdtempSync(join(tmpdir(), "mxprobe-"));
  return { XDG_CONFIG_HOME: dir, HOME: dir, ...extra };
};

export interface Captured {
  out: { stdout: string; stderr: string };
  stdout: { write(s: string): boolean };
  stderr: { write(s: string): boolean };
}

export function capture(): Captured {
  const out = { stdout: "", stderr: "" };
  return {
    out,
    stdout: { write: (s: string) => ((out.stdout += s), true) },
    stderr: { write: (s: string) => ((out.stderr += s), true) },
  };
}

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A canned reply per "METHOD /path"; anything else is a 404. */
export type Canned = Record<string, { status?: number; body: unknown } | ((call: FetchCall) => { status?: number; body: unknown })>;

export function fakeFetch(canned: Canned = {}): { fetchImpl: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const call: FetchCall = { url, method: init.method, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) };
    calls.push(call);
    const route = `${init.method} ${new URL(url).pathname}`;
    const hit = canned[route];
    const reply = hit === undefined ? { status: 404, body: { error: "not_found", message: `no canned ${route}` } } : typeof hit === "function" ? hit(call) : hit;
    const status = reply.status ?? 200;
    return { ok: status < 400, status, text: async () => (typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body)) };
  };
  return { fetchImpl, calls };
}

export const hostedResult = (email: string, verdict: "OK" | "WEAK" | "DEAD" = "OK"): VerifyResult => ({
  email,
  action: ACTIONS[verdict],
  verdict,
  reason: `hosted says ${verdict}`,
  checks: { syntax: true, mx: "mx.good.test", smtp: verdict === "DEAD" ? "rejected" : "accepted", catch_all: verdict === "WEAK" ? true : verdict === "OK" ? false : null },
});
