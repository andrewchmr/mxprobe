#!/usr/bin/env node
import { main } from "../src/cli.mjs";

// No forced exit on success: the MCP server may still be answering a call
// when stdin closes, and `check` has nothing left to wait for anyway.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code ?? 0;
  },
  (err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  },
);
