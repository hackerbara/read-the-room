import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

function json(root, path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function runManifestHook(cachedRoot, event, { temp, pluginData, input }) {
  const hook = json(cachedRoot, "hooks/codex-hooks.json").hooks[event][0].hooks[0];
  return spawnSync(hook.command, {
    cwd: cachedRoot,
    env: {
      ...process.env,
      TMPDIR: temp,
      PLUGIN_ROOT: cachedRoot,
      PLUGIN_DATA: pluginData,
      CLAUDE_PLUGIN_ROOT: join(cachedRoot, "claude-decoy-root"),
      CLAUDE_PLUGIN_DATA: join(cachedRoot, "claude-decoy-data"),
    },
    input: JSON.stringify(input),
    encoding: "utf8",
    shell: true,
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

test("a disposable cached Codex package runs its manifest hooks and bundled MCP as one keyed session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rtr-cached-package-"));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  const cachedRoot = join(dir, "codex-home", "plugins", "cache", "read-the-room", "1.1.0");
  const pluginData = join(dir, "codex-home", "plugin-data", "read-the-room");
  const temp = join(dir, "tmp");
  const sid = "cached-codex-session";

  mkdirSync(cachedRoot, { recursive: true });
  for (const path of [".codex-plugin", "docs", "hooks", "dist"]) {
    cpSync(join(pluginRoot, path), join(cachedRoot, path), { recursive: true });
  }
  cpSync(join(pluginRoot, "codex.mcp.json"), join(cachedRoot, "codex.mcp.json"));

  const manifest = json(cachedRoot, ".codex-plugin/plugin.json");
  assert.equal(manifest.hooks, "./hooks/codex-hooks.json");
  assert.equal(manifest.mcpServers, "./codex.mcp.json");

  const started = runManifestHook(cachedRoot, "SessionStart", {
    temp,
    pluginData,
    input: { session_id: sid, source: "startup" },
  });
  assert.equal(started.status, 0, started.stderr);
  const additionalContext = JSON.parse(started.stdout).hookSpecificOutput.additionalContext;
  assert.match(additionalContext, /ordinary assistant language streams visibly/);
  assert.doesNotMatch(additionalContext, /Nobody has to receive it/);

  const base = join(temp, "claude-orientation");
  const orientationPath = join(base, `${sid}.orientation.txt`);
  assert.match(readFileSync(orientationPath, "utf8"), /## What they are doing right now/);

  const submitted = runManifestHook(cachedRoot, "UserPromptSubmit", {
    temp,
    pluginData,
    input: { session_id: sid, cwd: cachedRoot },
  });
  assert.equal(submitted.status, 0, submitted.stderr);
  assert.equal(submitted.stdout, "");
  assert.equal(readFileSync(join(base, `${sid}.gate`), "utf8"), "CLOSED 1");

  const mcp = json(cachedRoot, "codex.mcp.json")["read-the-room"];
  const transport = new StdioClientTransport({
    command: mcp.command,
    args: mcp.args,
    cwd: join(cachedRoot, mcp.cwd),
    env: { ...process.env, TMPDIR: temp },
    stderr: "pipe",
  });
  const client = new Client({ name: "cached-package-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const response = await client.callTool({ name: "read_the_room", arguments: {} });
    const text = response.content[0].text;
    assert.match(text, /THE DOOR IS KEYED/);
    assert.match(text, new RegExp(`^# Where they are — session ${sid}$`, "m"));
    assert.doesNotMatch(text, /Workspace this turn|only thing the user will see/);
    const key = readFileSync(join(base, `${sid}.key`), "utf8");
    const nonce = key.split(/\s+/)[0];
    assert.match(text, new RegExp(`key: "${nonce}"`));
    assert.equal(readFileSync(join(base, `${sid}.gate`), "utf8"), "KEYED 1");
  } finally {
    await client.close();
  }

  const stopped = runManifestHook(cachedRoot, "Stop", {
    temp,
    pluginData,
    input: { session_id: sid, stop_hook_active: false, last_assistant_message: "" },
  });
  assert.equal(stopped.status, 0, stopped.stderr);
  const continuation = JSON.parse(stopped.stdout);
  assert.deepEqual(Object.keys(continuation).sort(), ["decision", "reason"]);
  assert.equal(continuation.decision, "block");
  assert.match(continuation.reason, /key was issued and not returned/);
  assert.match(continuation.reason, /Outstanding: setup/);
  assert.equal(readFileSync(join(base, `${sid}.gate`), "utf8"), "KEYED 1 stopped");
  assert.equal(readFileSync(join(base, `${sid}.codex-reruns`), "utf8"), "1 1");
});
