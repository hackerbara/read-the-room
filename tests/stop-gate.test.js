import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

function stop(temp, sid, lastMessage, extraEnv = {}, stopHookActive = "false") {
  return spawnSync(process.execPath, [join(pluginRoot, "hooks", "stop-gate.cjs")], {
    cwd: pluginRoot, env: { ...process.env, TMPDIR: temp, ...extraEnv },
    input: JSON.stringify({ session_id: sid, last_assistant_message: lastMessage,
                            stop_hook_active: stopHookActive }),
    encoding: "utf8",
  });
}

function seed(status, files = {}) {
  const sandbox = mkdtempSync(join(tmpdir(), "rtr-stop-"));
  const temp = join(sandbox, "tmp");
  const base = join(temp, "claude-orientation");
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "s1.gate"), `${status} 5`);
  writeFileSync(join(base, "s1.turns"), "5");
  writeFileSync(join(base, "s1.orientation.txt"), "## What they are doing right now\nstuff\n");
  for (const [name, content] of Object.entries(files)) writeFileSync(join(base, name), content);
  return { sandbox, temp, base };
}

test("a KEYED end nudges with the reasons, logs lapsed, and ignores the short-reply exemption", () => {
  const { sandbox, temp, base } = seed("KEYED",
    { "s1.key": "abc123 5 0\nfresh 0000 What they have not seen\nprune 6480\n" });
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const r = stop(temp, "s1", "Done.");                     // 5 chars — under any MIN_CHARS
  const out = JSON.parse(r.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /key was issued and not returned/);
  assert.match(out.hookSpecificOutput.additionalContext, /What they have not seen/);
  // Ledger records the RAW reason lines (baseline tokens intact) — the
  // durable audit trail; only the nudge's display copy strips baselines.
  assert.match(readFileSync(join(base, "s1.ledger"), "utf8"),
    /^5 lapsed - fresh 0000 What they have not seen; prune 6480$/m);
  assert.equal(readFileSync(join(base, "s1.suppressed"), "utf8"), "1");
});

test("a CLOSED end with a short reply still gets the exemption", () => {
  const { sandbox, temp } = seed("CLOSED");
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const r = stop(temp, "s1", "Done.");
  assert.equal(r.stdout, "");                              // exempt, no nudge
});

test("STAYED is quiet, stamps stopped, and increments the streak — until the cap trips", () => {
  const { sandbox, temp, base } = seed("STAYED", { "s1.staystreak": "3" });
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const r = stop(temp, "s1", "");
  assert.equal(readFileSync(join(base, "s1.gate"), "utf8"), "STAYED 5 stopped");
  assert.equal(readFileSync(join(base, "s1.staystreak"), "utf8"), "4");
  const out = JSON.parse(r.stdout);                        // 4 > cap(3) → nudge
  assert.match(out.hookSpecificOutput.additionalContext, /stayed in .* consecutive/i);
});

test("a SPOKEN end resets the stay streak", () => {
  const { sandbox, temp, base } = seed("SPOKEN", { "s1.staystreak": "2" });
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));
  stop(temp, "s1", "a real reply that is long enough to not matter here");
  assert.equal(readFileSync(join(base, "s1.staystreak"), "utf8"), "0");
});

test("KEYED nudge strips the baseline token from reason lines for display", () => {
  const { sandbox, temp } = seed("KEYED",
    { "s1.key": "abc123 5 0\nfresh 0000 What they have not seen\nprune 6480\n" });
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const r = stop(temp, "s1", "Done.");
  const out = JSON.parse(r.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /fresh: What they have not seen/);
  assert.match(out.hookSpecificOutput.additionalContext, /prune: 6480 bytes/);
  assert.ok(!out.hookSpecificOutput.additionalContext.includes("0000"),
    "the setup/fresh baseline hash must not appear in the nudge copy");
});

test("STAYED does not double-count the streak on a Stop-hook rerun", () => {
  const { sandbox, temp, base } = seed("STAYED", { "s1.staystreak": "3" });
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));

  const r1 = stop(temp, "s1", "");                          // real call, not a rerun
  assert.equal(readFileSync(join(base, "s1.staystreak"), "utf8"), "4");
  const out1 = JSON.parse(r1.stdout);
  assert.match(out1.hookSpecificOutput.additionalContext, /stayed in .* consecutive/i);

  const r2 = stop(temp, "s1", "", {}, "true");              // harness rerun for this same turn
  assert.equal(readFileSync(join(base, "s1.staystreak"), "utf8"), "4",
    "a rerun must not re-increment the streak");
  assert.equal(r2.stdout, "", "a rerun must not re-emit the nudge");
});

test("an OPEN end also resets the stay streak", () => {
  const { sandbox, temp, base } = seed("OPEN", { "s1.staystreak": "2" });
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));
  stop(temp, "s1", "");
  assert.equal(readFileSync(join(base, "s1.staystreak"), "utf8"), "0");
});
