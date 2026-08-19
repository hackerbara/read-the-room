import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
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

function promptTurn(temp, sid) {
  return runHook("reinject.cjs", { temp, sessionId: sid, source: undefined });
}

test("reinject stamps changed sections with the current turn and keeps unchanged stamps", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "rtr-sidecar2-"));
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const temp = join(sandbox, "tmp");
  const sid = "sidecar-maint-session";
  runHook("session-start.cjs", { temp, sessionId: sid });
  const base = join(temp, "claude-orientation");
  const orient = join(base, `${sid}.orientation.txt`);

  promptTurn(temp, sid);                                   // turn 1, nothing changed
  appendFileSync(orient, "\nnew fact about them\n");       // touches the LAST section only
  promptTurn(temp, sid);                                   // turn 2

  const rows = readFileSync(join(base, `${sid}.state`), "utf8").trimEnd().split("\n").slice(1);
  const last = rows[rows.length - 1];
  assert.match(last, /^2 /);                               // changed at turn 2
  assert.match(rows[0], /^0 /);                            // first section untouched since seed
});

test("a vanished section keeps its line marked gone; reinject emits nothing on stdout", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "rtr-sidecar3-"));
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const temp = join(sandbox, "tmp");
  const sid = "sidecar-gone-session";
  runHook("session-start.cjs", { temp, sessionId: sid });
  const base = join(temp, "claude-orientation");
  const orient = join(base, `${sid}.orientation.txt`);

  const text = readFileSync(orient, "utf8");
  writeFileSync(orient, text.replace(/^## Their words$/m, "## Renamed by the agent"));
  const r = promptTurn(temp, sid);
  assert.equal(r.stdout, "", "reinject must no longer emit context");

  const rows = readFileSync(join(base, `${sid}.state`), "utf8");
  assert.match(rows, /gone Their words$/m);
  assert.match(rows, /^1 - [0-9a-f]{64} Renamed by the agent$/m);
});

test("an interrupted KEYED turn stamps .interrupted", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "rtr-int-"));
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const temp = join(sandbox, "tmp");
  const sid = "keyed-interrupt-session";
  runHook("session-start.cjs", { temp, sessionId: sid });
  const base = join(temp, "claude-orientation");
  promptTurn(temp, sid);                                   // turn 1, gate CLOSED 1
  writeFileSync(join(base, `${sid}.gate`), "KEYED 1");     // door keyed it, turn never stopped
  promptTurn(temp, sid);                                   // turn 2 arrives
  assert.equal(readFileSync(join(base, `${sid}.interrupted`), "utf8"), "1");
});

test("SessionStart(compact) notes an outstanding same-turn key; a stale-turn key gets no note", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "rtr-compact-key-"));
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const temp = join(sandbox, "tmp");
  const sid = "compact-key-session";
  runHook("session-start.cjs", { temp, sessionId: sid });
  const base = join(temp, "claude-orientation");
  writeFileSync(join(base, `${sid}.turns`), "3");

  // A key issued this same turn: the restored context should note it.
  writeFileSync(join(base, `${sid}.key`), "nonce1 3 0\nsetup deadbeef\n");
  const current = runHook("session-start.cjs", { temp, sessionId: sid, source: "compact" });
  assert.equal(current.status, 0, current.stderr);
  const currentCtx = JSON.parse(current.stdout).hookSpecificOutput.additionalContext;
  assert.match(currentCtx, /outstanding upkeep key/);

  // A key left over from an earlier turn: no note — turn-currency only.
  writeFileSync(join(base, `${sid}.key`), "nonce2 2 0\nsetup deadbeef\n");
  const stale = runHook("session-start.cjs", { temp, sessionId: sid, source: "compact" });
  assert.equal(stale.status, 0, stale.stderr);
  const staleCtx = JSON.parse(stale.stdout).hookSpecificOutput.additionalContext;
  assert.ok(!staleCtx.includes("outstanding upkeep key"));
});
