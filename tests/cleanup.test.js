import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

test("reinject sweeps session files older than 14 days", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "rtr-sweep-"));
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const temp = join(sandbox, "tmp");
  const base = join(temp, "claude-orientation");
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "old.state"), "x");
  const past = new Date(Date.now() - 15 * 24 * 3600 * 1000);
  utimesSync(join(base, "old.state"), past, past);
  writeFileSync(join(base, "fresh.state"), "x");
  spawnSync(process.execPath, [join(pluginRoot, "hooks", "reinject.cjs")], {
    cwd: pluginRoot, env: { ...process.env, TMPDIR: temp },
    input: JSON.stringify({ session_id: "live" }), encoding: "utf8",
  });
  assert.ok(!existsSync(join(base, "old.state")));
  assert.ok(existsSync(join(base, "fresh.state")));
});
