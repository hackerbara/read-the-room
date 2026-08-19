import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

function runHook(name, { temp, pluginData, input, args = [], extraEnv = {} }) {
  return spawnSync(process.execPath, [join(pluginRoot, "hooks", name), ...args], {
    cwd: pluginRoot,
    env: {
      ...process.env,
      TMPDIR: temp,
      PLUGIN_ROOT: pluginRoot,
      PLUGIN_DATA: pluginData,
      ...extraEnv,
    },
    input: JSON.stringify(input),
    encoding: "utf8",
  });
}

test("Codex SessionStart, UserPromptSubmit, and the separately spawned bundle share one keyed session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rtr-hook-mcp-session-"));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  const temp = join(dir, "tmp");
  const pluginData = join(dir, "persisted-plugin-data");
  const base = join(temp, "claude-orientation");
  const sid = "codex-hook-mcp-session";

  const started = runHook("session-start.cjs", {
    temp,
    pluginData,
    input: { session_id: sid, source: "startup" },
    args: ["--host", "codex"],
  });
  assert.equal(started.status, 0, started.stderr);
  assert.notEqual(started.stdout, "", "SessionStart should inject Codex orientation context");

  const orientationPath = join(base, `${sid}.orientation.txt`);
  const orientation = readFileSync(orientationPath, "utf8");
  assert.match(orientation, /## What they are doing right now/);
  assert.match(readFileSync(join(base, `${sid}.state`), "utf8"), /^0 [0-9a-f]{64}\n/m);
  assert.match(readFileSync(join(base, `${sid}.seed`), "utf8"), /^[0-9a-f]{64}\n/m);

  const submitted = runHook("reinject.cjs", {
    temp,
    pluginData,
    input: { session_id: sid, cwd: pluginRoot },
    args: ["--host", "codex"],
    extraEnv: { CLAUDE_CODE_SESSION_ID: "claude-decoy" },
  });
  assert.equal(submitted.status, 0, submitted.stderr);
  assert.equal(submitted.stdout, "");
  assert.equal(readFileSync(join(base, `${sid}.gate`), "utf8"), "CLOSED 1");
  assert.match(readFileSync(join(base, `${sid}.state`), "utf8"), /^1 [0-9a-f]{64}\n/m);
  assert.equal(readFileSync(join(base, "current-session"), "utf8"), sid);
  assert.equal(readFileSync(join(base, `current-session.ppid${process.pid}`), "utf8"), sid);
  const cwdKey = createHash("sha256").update(pluginRoot).digest("hex").slice(0, 16);
  assert.equal(readFileSync(join(base, `current-session.${cwdKey}`), "utf8"), sid);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(pluginRoot, "dist", "read-the-room-server.js")],
    cwd: pluginRoot,
    env: { ...process.env, TMPDIR: temp },
    stderr: "pipe",
  });
  const client = new Client({ name: "hook-mcp-session-test", version: "1.0.0" });
  test.after(() => client.close());
  await client.connect(transport);
  const response = await client.callTool({ name: "read_the_room", arguments: {} });
  const text = response.content[0].text;

  assert.match(text, /THE DOOR IS KEYED/);
  assert.match(text, new RegExp(`^# Where they are — session ${sid}$`, "m"));
  assert.match(text, /# A wrong line here is cheap to fix and expensive to leave\./);
  const key = readFileSync(join(base, `${sid}.key`), "utf8");
  const nonce = key.split(/\s+/)[0];
  assert.match(key, new RegExp(`^${nonce} 1 0\\nsetup `));
  assert.match(text, new RegExp(`key: "${nonce}"`));
  assert.equal(readFileSync(join(base, `${sid}.gate`), "utf8"), "KEYED 1");

  const codexWithoutPayload = runHook("reinject.cjs", {
    temp,
    pluginData,
    input: {},
    args: ["--host", "codex"],
    extraEnv: { CLAUDE_CODE_SESSION_ID: sid },
  });
  assert.equal(codexWithoutPayload.status, 0, codexWithoutPayload.stderr);
  assert.equal(readFileSync(join(base, `${sid}.turns`), "utf8"), "1");
});
