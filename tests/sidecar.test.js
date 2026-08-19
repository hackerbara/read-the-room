import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

export function runHook(name, { temp, sessionId, source = "startup", extraEnv = {} }) {
  return spawnSync(process.execPath, [join(pluginRoot, "hooks", name)], {
    cwd: pluginRoot,
    env: { ...process.env, TMPDIR: temp, CLAUDE_PLUGIN_ROOT: pluginRoot,
           CLAUDE_PLUGIN_DATA: join(temp, "plugin-data"), ...extraEnv },
    input: JSON.stringify({ session_id: sessionId, source }),
    encoding: "utf8",
  });
}

test("seeding writes state v2 with one sidecar line per template section, plus a seed file", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "rtr-sidecar-"));
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const temp = join(sandbox, "tmp");
  const sid = "sidecar-seed-session";

  const r = runHook("session-start.cjs", { temp, sessionId: sid });
  assert.equal(r.status, 0, r.stderr);

  const base = join(temp, "claude-orientation");
  const state = readFileSync(join(base, `${sid}.state`), "utf8").trimEnd().split("\n");
  assert.match(state[0], /^0 [0-9a-f]{64}$/);            // line 1: turn 0 + file hash
  const sidecar = state.slice(1);
  assert.ok(sidecar.length >= 6, "one line per ## section");
  for (const line of sidecar)
    assert.match(line, /^0 - [0-9a-f]{64} \S/);           // turn 0, no affirm, hash, header
  assert.ok(sidecar.some(l => l.endsWith("What they are doing right now")));

  const seed = readFileSync(join(base, `${sid}.seed`), "utf8").trimEnd().split("\n");
  assert.match(seed[0], /^[0-9a-f]{64}$/);
  assert.equal(seed.length, sidecar.length + 1);
});
