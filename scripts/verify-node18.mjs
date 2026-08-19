#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { delimiter, dirname } from "node:path";

if (process.versions.node.split(".")[0] !== "18") {
  console.error(`FAIL: verify:node18 must run under Node 18.x, received ${process.version}`);
  process.exit(1);
}

const env = {
  ...process.env,
  PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH || ""}`,
  CODEX_BIN: process.env.CODEX_BIN || "codex",
};
const result = spawnSync(process.execPath, [
  "--test",
  "tests/bundle.test.js",
  "tests/codex-install.test.js",
], {
  cwd: process.cwd(),
  env,
  encoding: "utf8",
  stdio: "inherit",
  timeout: 180_000,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
