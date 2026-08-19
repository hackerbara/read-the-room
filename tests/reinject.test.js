import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

function sandbox(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const temp = join(dir, "tmp");
  const base = join(temp, "claude-orientation");
  mkdirSync(base, { recursive: true });
  return { dir, temp, base };
}

function runReinject({ temp, input = {}, args = [], extraEnv = {} }) {
  return spawnSync(process.execPath, [join(pluginRoot, "hooks", "reinject.cjs"), ...args], {
    cwd: pluginRoot,
    env: { ...process.env, TMPDIR: temp, ...extraEnv },
    input: JSON.stringify(input),
    encoding: "utf8",
  });
}

function seed(base, sid) {
  const orientation = "## What they are doing right now\nTesting session identity.\n";
  writeFileSync(join(base, `${sid}.orientation.txt`), orientation);
  writeFileSync(join(base, `${sid}.turns`), "0");
  writeFileSync(join(base, `${sid}.state`), `0 ${createHash("sha256").update(orientation).digest("hex")}\n`);
}

test("Claude reinjection still publishes pointers, closes the gate, and maintains state v2 without stdout", () => {
  const { dir, temp, base } = sandbox("rtr-reinject-claude-");
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  const sid = "claude-reinject-session";
  seed(base, sid);

  const result = runReinject({ temp, input: { session_id: sid, cwd: pluginRoot } });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(readFileSync(join(base, `${sid}.gate`), "utf8"), "CLOSED 1");
  assert.equal(readFileSync(join(base, "current-session"), "utf8"), sid);
  assert.equal(readFileSync(join(base, `current-session.ppid${process.pid}`), "utf8"), sid);
  const cwdKey = createHash("sha256").update(pluginRoot).digest("hex").slice(0, 16);
  assert.equal(readFileSync(join(base, `current-session.${cwdKey}`), "utf8"), sid);
  const state = readFileSync(join(base, `${sid}.state`), "utf8").trimEnd().split("\n");
  assert.match(state[0], /^1 [0-9a-f]{64}$/);
  assert.match(state[1], /^1 - [0-9a-f]{64} What they are doing right now$/);
});

test("plugin environment variables alone never select Codex", () => {
  const { dir, temp, base } = sandbox("rtr-reinject-host-");
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  const claudeSid = "claude-env-session";
  seed(base, claudeSid);

  const result = runReinject({
    temp,
    extraEnv: {
      CLAUDE_CODE_SESSION_ID: claudeSid,
      PLUGIN_ROOT: join(dir, "codex-root"),
      PLUGIN_DATA: join(dir, "codex-data"),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(readFileSync(join(base, `${claudeSid}.gate`), "utf8"), "CLOSED 1");
});

test("explicit Codex mode does not borrow Claude's environment-only session identity", () => {
  const { dir, temp, base } = sandbox("rtr-reinject-codex-host-");
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  const claudeSid = "claude-decoy-session";
  seed(base, claudeSid);

  const result = runReinject({
    temp,
    args: ["--host", "codex"],
    extraEnv: {
      CLAUDE_CODE_SESSION_ID: claudeSid,
      PLUGIN_ROOT: join(dir, "codex-root"),
      PLUGIN_DATA: join(dir, "codex-data"),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(readFileSync(join(base, `${claudeSid}.turns`), "utf8"), "0");
});
