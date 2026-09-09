#!/usr/bin/env node
// Hand-run operations. DB_PATH points at the live file.
//   node bin/admin.mjs stats
//   node bin/admin.mjs keys
//   node bin/admin.mjs revoke <email> | unrevoke <email>
//   node bin/admin.mjs credits <email> <delta> [note]
import { openDb } from "../src/db.mjs";

const db = openDb(process.env.DB_PATH || "./data/mxprobe.sqlite");
const [cmd, a, b, c] = process.argv.slice(2);

switch (cmd) {
  case "stats":
    console.log(JSON.stringify(db.stats(), null, 2));
    break;
  case "keys":
    console.table(db.listKeys());
    break;
  case "revoke":
  case "unrevoke": {
    if (!a) throw new Error("email required");
    const ok = db.setRevoked(a, cmd === "revoke");
    console.log(ok ? `${cmd}d ${a}` : `no key for ${a}`);
    break;
  }
  case "credits": {
    const k = db.keyByEmail(a);
    if (!k) throw new Error(`no key for ${a}`);
    const delta = Number.parseInt(b, 10);
    if (!Number.isFinite(delta) || delta === 0) throw new Error("delta must be a non-zero integer");
    const after = db.addCredits(k.id, delta, "manual", c ?? null);
    console.log(`${a}: ${k.credits} -> ${after.credits}`);
    break;
  }
  default:
    console.error("usage: admin.mjs stats | keys | revoke <email> | unrevoke <email> | credits <email> <delta> [note]");
    process.exit(2);
}
db.close();
