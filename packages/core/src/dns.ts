// Tier 1: DNS. Free and local. Finds domains that cannot receive mail: no MX
// and a web host behind the A record, a null MX, an MX that does not resolve,
// a domain that does not exist, a parking host as MX.
import { resolveOptions, type VerifierOptions } from "./options.ts";
import type { MxRecord, Resolver, Verdict } from "./types.ts";
import { errorCode, errorMessage, withTimeout } from "./util.ts";

// MX hosts that forward rather than hold mail. They bounce when the forward
// target is dead, and some refuse relays outright.
const FORWARDER_MX: readonly RegExp[] = [
  /registrar-servers\.com$/i, // Namecheap eforward1..5
  /improvmx\.com$/i,
  /forwardemail\.net$/i,
  /mx\.cloudflare\.net$/i, // Cloudflare Email Routing route1..3
  /fwd\d*\.porkbun\.com$/i,
  /mailforward\./i,
  /forwardmx\./i,
];

// Hosts that serve web pages, not mail. An MX pointing here times out.
const WEBHOST_MX: readonly RegExp[] = [/pixie\.porkbun\.com$/i, /parkingcrew\./i, /sedoparking\./i, /bodis\./i, /above\.com$/i];

export interface MxHost {
  host: string;
  /** Resolved for the primary; null for the secondary, which is resolved on demand. */
  ip: string | null;
}

export interface DomainCheck {
  verdict: Verdict;
  reason: string;
  /** The primary MX host name, or null when the domain is DEAD. */
  mx: string | null;
  /** The hosts to try in order. Empty when DEAD. */
  mxHosts: MxHost[];
}

interface Addresses {
  v4: string[];
  v6: string[];
  all: string[];
}

const isNullMx = (mx: readonly MxRecord[]): boolean => mx.length === 1 && mx[0]?.exchange === "" && mx[0]?.priority === 0;

async function lookupAny(resolver: Resolver, host: string): Promise<Addresses> {
  const [v4, v6] = await Promise.all([resolver.resolve4(host).catch(() => [] as string[]), resolver.resolve6(host).catch(() => [] as string[])]);
  return { v4, v6, all: [...v4, ...v6] };
}

async function reverseName(resolver: Resolver, ip: string, ms: number): Promise<string | null> {
  try {
    const names = await withTimeout(resolver.reverse(ip), "reverse", ms);
    return names[0] ?? null;
  } catch {
    return null;
  }
}

/** Name the web host behind an A record from its IP and reverse name. */
export function labelWebHost(ip: string, ptr: string | null): string {
  const p = (ptr ?? "").toLowerCase();
  if (ip === "75.2.60.5" || ip === "99.83.190.102" || p.includes("netlify")) return "Netlify";
  if (ip.startsWith("76.76.21.") || ip.startsWith("216.198.79.") || p.includes("vercel")) return "Vercel";
  if (ip.startsWith("104.21.") || ip.startsWith("172.67.") || ip.startsWith("188.114.9") || p.includes("cloudflare")) return "Cloudflare";
  if (p.includes("amazonaws") || p.includes("awsglobalaccelerator")) return "AWS";
  if (p.includes("github")) return "GitHub Pages";
  if (p.includes("squarespace") || p.includes("wixdns") || p.includes("webflow")) return "site builder";
  return ptr ?? "unknown host";
}

const dead = (reason: string): DomainCheck => ({ verdict: "DEAD", reason, mx: null, mxHosts: [] });

/**
 * The DNS tier for one domain. Returns the verdict, the primary MX host name
 * (null when the domain is DEAD) and the sorted list of hosts to try.
 */
export async function checkDomain(domain: string, opts: VerifierOptions = {}): Promise<DomainCheck> {
  const o = resolveOptions(opts);
  const { resolver } = o;
  let mx: MxRecord[];
  try {
    mx = await withTimeout(resolver.resolveMx(domain), "MX", o.dnsTimeoutMs);
  } catch (err) {
    const code = errorCode(err) ?? "";
    if (code === "ENOTFOUND") return dead("domain does not exist (NXDOMAIN)");
    if (code !== "ENODATA" && !/timed out/.test(errorMessage(err))) return dead(`MX lookup failed (${code || errorMessage(err)})`);
    mx = [];
  }

  if (mx.length === 0) {
    const ips = await withTimeout(lookupAny(resolver, domain), "A/AAAA", o.dnsTimeoutMs);
    const ip = ips.all[0];
    if (ip === undefined) return dead("no MX and no A/AAAA record");
    const host = labelWebHost(ip, await reverseName(resolver, ip, o.dnsTimeoutMs));
    return dead(`no MX record; mail falls back to the A record ${ip} (${host}), which does not take mail`);
  }

  if (isNullMx(mx)) return dead("null MX (RFC 7505): the domain accepts no mail");

  const sorted = [...mx].sort((x, y) => x.priority - y.priority).map((r) => r.exchange.replace(/\.$/, "").toLowerCase());
  const primary = sorted[0] as string;
  const secondary = sorted[1];

  if (WEBHOST_MX.some((re) => re.test(primary))) return dead(`MX ${primary} is a web or parking host, not a mail server`);

  const primaryIps = await withTimeout(lookupAny(resolver, primary), "MX host", o.dnsTimeoutMs);
  const primaryIp = primaryIps.v4[0] ?? primaryIps.v6[0];
  if (primaryIp === undefined) return dead(`MX host ${primary} does not resolve`);

  const mxHosts: MxHost[] = [{ host: primary, ip: primaryIp }];
  if (secondary !== undefined && secondary !== primary) mxHosts.push({ host: secondary, ip: null });

  if (FORWARDER_MX.some((re) => re.test(primary))) {
    return { verdict: "WEAK", reason: `MX ${primary} is a forwarder; it bounces when the forward target is dead`, mx: primary, mxHosts };
  }
  return { verdict: "OK", reason: `MX ${primary}`, mx: primary, mxHosts };
}
