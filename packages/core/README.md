# mxprobe-core

The MX Probe engine. Zero dependencies, Node 20+. Two tiers:

1. **DNS.** Free and local. Finds every domain that cannot receive mail: no MX
   and a web host behind the A record, a null MX, an MX that does not
   resolve, a domain that does not exist, a parking host as MX. Forwarder MX
   hosts (Cloudflare Email Routing, Namecheap, ImprovMX) are a `hold`.
2. **SMTP probe.** Connects to the MX on port 25, EHLO, MAIL FROM, RCPT TO for
   the address and for a random local part (the catch-all test), QUIT. No
   message is ever sent. Needs outbound port 25, which most laptops and
   clouds block; the hosted API at https://api.mxprobe.dev runs it for you.

```js
import { verify, verifyBatch, createVerifier } from "mxprobe-core";

await verify("hello@example.com");
// { email, action: "send" | "hold" | "kill", verdict: "OK" | "WEAK" | "DEAD", reason, checks: { syntax, mx, smtp, catch_all } }

await verifyBatch(["a@b.com", "c@d.org"], { smtp: true, helo: "probe.example.com", from: "probe@example.com" });

const v = createVerifier({ smtp: true, smtpConcurrency: 3, autoDisableSmtp: false }); // shared limits across calls
```

`checks.smtp` is `skipped` on the DNS tier, else `accepted`, `rejected`,
`refused`, `deferred`, `unreachable` or `dropped`. Only `rejected` (a 5xx that
names the mailbox) kills; everything else that is not `accepted` holds.

Options (all optional): `smtp`, `helo`, `from`, `port`, `hostOverride`,
`dnsTimeoutMs`, `smtpTimeoutMs`, `smtpConcurrency`, `dnsConcurrency`,
`autoDisableSmtp`, `resolver` (an object with `resolveMx`, `resolve4`,
`resolve6`, `reverse`, for tests).

MIT. Part of https://github.com/andrewchmr/mxprobe.
