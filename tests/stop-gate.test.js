import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

function stop(temp, sid, lastMessage, extraEnv = {}, stopHookActive = "false", host = "claude") {
  const args = [join(pluginRoot, "hooks", "stop-gate.cjs")];
  if (host === "codex") args.push("--host", "codex");
  return spawnSync(process.execPath, args, {
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

test("Codex CLOSED blocks with its own turn-keyed cap and leaves Claude display state alone", () => {
  const { sandbox, temp, base } = seed("CLOSED", {
    "s1.hidden": "5", "s1.suppressed": "99", "s1.unseen": "old", "s1.aftertalk": "5",
    "s1.codex-reruns": "4 99",
  });
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const message = "x".repeat(101);

  const first = stop(temp, "s1", message, {}, "false", "codex");
  const firstOut = JSON.parse(first.stdout);
  assert.deepEqual(Object.keys(firstOut), ["decision", "reason"]);
  assert.equal(firstOut.decision, "block");
  assert.match(firstOut.reason, /read_the_room/);
  assert.equal(readFileSync(join(base, "s1.codex-reruns"), "utf8"), "5 1");

  const second = stop(temp, "s1", message, {}, "false", "codex");
  assert.equal(JSON.parse(second.stdout).decision, "block");
  assert.equal(readFileSync(join(base, "s1.codex-reruns"), "utf8"), "5 2");
  const third = stop(temp, "s1", message, {}, "false", "codex");
  assert.equal(third.stdout, "");
  assert.equal(readFileSync(join(base, "s1.codex-reruns"), "utf8"), "5 3");

  assert.equal(readFileSync(join(base, "s1.suppressed"), "utf8"), "99");
  assert.equal(readFileSync(join(base, "s1.hidden"), "utf8"), "5");
  assert.equal(readFileSync(join(base, "s1.unseen"), "utf8"), "old");
  assert.equal(readFileSync(join(base, "s1.aftertalk"), "utf8"), "5");
});

test("Codex Stop never creates Claude display-coupling files", () => {
  const { sandbox, temp, base } = seed("CLOSED");
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const result = stop(temp, "s1", "x".repeat(101), {}, "false", "codex");
  assert.equal(JSON.parse(result.stdout).decision, "block");
  for (const suffix of ["suppressed", "hidden", "unseen", "aftertalk"]) {
    assert.equal(existsSync(join(base, `s1.${suffix}`)), false, suffix);
  }
});

test("Codex KEYED shares the rerun counter, ignores MIN_CHARS, and records one lapse per logical turn", () => {
  const { sandbox, temp, base } = seed("CLOSED", {
    "s1.codex-reruns": "5 1", "s1.suppressed": "8",
    "s1.key": "abc123 5 0\nfresh 0000 What they have not seen\nprune 6480\n",
  });
  writeFileSync(join(base, "s1.gate"), "KEYED 5");
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));

  const secondAttempt = stop(temp, "s1", "Done.", {}, "false", "codex");
  const out = JSON.parse(secondAttempt.stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /key was issued and not returned/);
  assert.match(out.reason, /fresh: What they have not seen/);
  assert.equal(readFileSync(join(base, "s1.codex-reruns"), "utf8"), "5 2");

  const capped = stop(temp, "s1", "Done.", {}, "false", "codex");
  assert.equal(capped.stdout, "");
  assert.equal(readFileSync(join(base, "s1.codex-reruns"), "utf8"), "5 3");
  assert.equal(readFileSync(join(base, "s1.ledger"), "utf8"),
    "5 lapsed - fresh 0000 What they have not seen; prune 6480\n");
  assert.equal(readFileSync(join(base, "s1.suppressed"), "utf8"), "8");
});

test("Codex capped STAY blocks safely but increments the logical stay exactly once", () => {
  const { sandbox, temp, base } = seed("STAYED", {
    "s1.staystreak": "3", "s1.suppressed": "11",
  });
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));

  const first = stop(temp, "s1", "", {}, "false", "codex");
  assert.equal(JSON.parse(first.stdout).decision, "block");
  assert.match(JSON.parse(first.stdout).reason, /stayed in .* consecutive/i);
  assert.equal(readFileSync(join(base, "s1.staystreak"), "utf8"), "4");
  assert.equal(readFileSync(join(base, "s1.codex-reruns"), "utf8"), "5 1");

  const second = stop(temp, "s1", "", {}, "false", "codex");
  assert.equal(JSON.parse(second.stdout).decision, "block");
  assert.equal(readFileSync(join(base, "s1.staystreak"), "utf8"), "4");
  const third = stop(temp, "s1", "", {}, "false", "codex");
  assert.equal(third.stdout, "");
  assert.equal(readFileSync(join(base, "s1.staystreak"), "utf8"), "4");
  assert.equal(readFileSync(join(base, "s1.suppressed"), "utf8"), "11");
});

test("Codex OPEN, SPOKEN, and a legal STAY cannot inherit stale rerun counts", () => {
  for (const status of ["OPEN", "SPOKEN"]) {
    const state = seed(status, {
      "s1.codex-reruns": "4 99", "s1.staystreak": "2",
      "s1.aftertalk": "5", "s1.suppressed": "7",
    });
    test.after(() => rmSync(state.sandbox, { recursive: true, force: true }));
    const result = stop(state.temp, "s1", "", {}, "false", "codex");
    assert.equal(result.stdout, "");
    assert.equal(existsSync(join(state.base, "s1.codex-reruns")), false);
    assert.equal(readFileSync(join(state.base, "s1.staystreak"), "utf8"), "0");
    assert.equal(readFileSync(join(state.base, "s1.aftertalk"), "utf8"), "5");
    assert.equal(readFileSync(join(state.base, "s1.suppressed"), "utf8"), "7");
  }

  const stayed = seed("STAYED", { "s1.codex-reruns": "4 99", "s1.staystreak": "1" });
  test.after(() => rmSync(stayed.sandbox, { recursive: true, force: true }));
  const first = stop(stayed.temp, "s1", "", {}, "false", "codex");
  assert.equal(first.stdout, "");
  assert.equal(readFileSync(join(stayed.base, "s1.staystreak"), "utf8"), "2");
  assert.equal(existsSync(join(stayed.base, "s1.codex-reruns")), false);
  const duplicate = stop(stayed.temp, "s1", "", {}, "false", "codex");
  assert.equal(duplicate.stdout, "");
  assert.equal(readFileSync(join(stayed.base, "s1.staystreak"), "utf8"), "2");
});

test("Claude continuation output and keyed state remain unchanged", () => {
  const { sandbox, temp, base } = seed("KEYED", {
    "s1.key": "abc123 5 0\nsetup 0000\n",
  });
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const result = stop(temp, "s1", "Done.");
  const out = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(out), ["hookSpecificOutput"]);
  assert.deepEqual(Object.keys(out.hookSpecificOutput), ["hookEventName", "additionalContext"]);
  assert.equal(out.hookSpecificOutput.hookEventName, "Stop");
  assert.equal(readFileSync(join(base, "s1.suppressed"), "utf8"), "1");
  assert.equal(existsSync(join(base, "s1.codex-reruns")), false);
});
