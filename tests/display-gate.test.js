// tests/display-gate.test.js
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

function display(temp, payload, extraEnv = {}) {
  return spawnSync(process.execPath, [join(pluginRoot, "hooks", "message-display.cjs")], {
    cwd: pluginRoot,
    env: { ...process.env, TMPDIR: temp, ...extraEnv },
    input: JSON.stringify(payload), encoding: "utf8",
  });
}

function setup(status, note) {
  const sandbox = mkdtempSync(join(tmpdir(), "rtr-disp-"));
  const temp = join(sandbox, "tmp");
  const base = join(temp, "claude-orientation");
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "s1.gate"), `${status} 3`);
  writeFileSync(join(base, "s1.turns"), "3");
  if (note !== undefined) writeFileSync(join(base, "s1.staynote"), note);
  return { sandbox, temp };
}

const longText = "x".repeat(400) + "\n";

test("KEYED hides long text exactly like CLOSED", () => {
  const { sandbox, temp } = setup("KEYED");
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const r = display(temp, { session_id: "s1", message_id: "m1", turn_id: "t1",
                            index: "0", delta: longText, final: "true" });
  const out = JSON.parse(r.stdout);
  assert.match(out.hookSpecificOutput.displayContent, /working notes/);
  assert.ok(!out.hookSpecificOutput.displayContent.includes(longText.trim()));
});

test("STAYED renders the stay marker with the note", () => {
  const { sandbox, temp } = setup("STAYED", "waiting on the retrieval agent");
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const r = display(temp, { session_id: "s1", message_id: "m1", turn_id: "t1",
                            index: "0", delta: longText, final: "true" });
  const out = JSON.parse(r.stdout);
  assert.match(out.hookSpecificOutput.displayContent,
    /^■ stayed in this turn — waiting on the retrieval agent \(nothing was said; ctrl\+O for the workspace\)/);
});

test("STAYED holds the screen on a non-final chunk: empty displayContent, exit 0", () => {
  const { sandbox, temp } = setup("STAYED", "waiting on the retrieval agent");
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const r = display(temp, { session_id: "s1", message_id: "m1", turn_id: "t1",
                            index: "0", delta: "some streaming chunk", final: "false" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.displayContent, "");
});

test("default hide threshold is now 150 characters", () => {
  const { sandbox, temp } = setup("CLOSED");
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const r = display(temp, { session_id: "s1", message_id: "m2", turn_id: "t1",
                            index: "0", delta: "y".repeat(200) + "\n", final: "true" });
  const out = JSON.parse(r.stdout);
  assert.match(out.hookSpecificOutput.displayContent, /working notes/);  // 200 > 150 → hidden
});
