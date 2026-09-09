export interface ParsedAddress {
  /** The address with the domain lowercased and the trailing dot removed. */
  email: string;
  local: string;
  domain: string;
  error?: undefined;
}

export interface AddressError {
  email: string;
  error: string;
  local?: undefined;
  domain?: undefined;
}

export type ParseResult = ParsedAddress | AddressError;

/** Split an address into local part and domain, or return { email, error }. */
export function parseAddress(raw: unknown): ParseResult {
  const email = String(raw ?? "").trim();
  const m = email.match(/^([^\s@]+)@([^\s@]+\.[^\s@]+)$/);
  if (!m || m[1] === undefined || m[2] === undefined) return { email, error: "not an email address" };
  const local = m[1];
  const domain = m[2].toLowerCase().replace(/\.$/, "");
  if (local.length > 64 || domain.length > 253 || /\.\./.test(domain) || /[^a-z0-9.-]/.test(domain)) {
    return { email, error: "malformed address" };
  }
  return { email: `${local}@${domain}`, local, domain };
}
