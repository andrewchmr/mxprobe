// Who runs the mail server, read from the primary MX host name. Information
// only: the verdict never reads it. It helps an agent weigh a hold: a
// catch-all on Google Workspace is a setting of the domain, while a security
// gateway in front of the real server often accepts any address.

// [MX host pattern, provider]. The first match wins.
const MX_PROVIDERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\.)google(mail)?\.com$/i, "google"],
  [/\.olc\.protection\.outlook\.com$/i, "outlook"],
  [/\.mail\.protection\.outlook\.com$|\.mx\.microsoft$/i, "microsoft_365"],
  [/\.yahoodns\.net$/i, "yahoo"], // AOL too
  [/\.mail\.icloud\.com$/i, "icloud"],
  [/(^|\.)mail\.ru$/i, "mailru"],
  [/(^|\.)yandex\.(ru|net)$/i, "yandex"],
  [/(^|\.)zoho(mail|cloud)?\.(com|eu|in|jp|sa|uk|ca|com\.au|com\.cn)$/i, "zoho"],
  [/(^|\.)protonmail\.ch$/i, "proton"],
  [/(^|\.)messagingengine\.com$/i, "fastmail"],
  [/(^|\.)privateemail\.com$/i, "privateemail"], // Namecheap
  [/(^|\.)secureserver\.net$/i, "godaddy"],
  [/(^|\.)(pphosted|ppe-hosted)\.com$/i, "proofpoint"],
  [/(^|\.)mimecast(-offshore)?\.(com|co\.za)$/i, "mimecast"],
  [/(^|\.)barracudanetworks\.com$/i, "barracuda"],
  [/(^|\.)iphmx\.com$/i, "cisco"],
];

// Google's MX serves both; only these domains are consumer Gmail.
const GMAIL_DOMAINS: ReadonlySet<string> = new Set(["gmail.com", "googlemail.com"]);

/**
 * The provider behind an MX host (gmail, google_workspace, microsoft_365,
 * outlook, yahoo, proofpoint, ...), or null when the name is not a known one.
 */
export function mailProvider(mx: string, domain: string): string | null {
  const name = MX_PROVIDERS.find(([re]) => re.test(mx))?.[1] ?? null;
  if (name === "google") return GMAIL_DOMAINS.has(domain.toLowerCase()) ? "gmail" : "google_workspace";
  return name;
}
