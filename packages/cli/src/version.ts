import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

/** The package version, read from package.json at runtime. */
export const version: string = pkg.version;
