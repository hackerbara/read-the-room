import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const json = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));

test("Codex package metadata and release versions are coherent", () => {
  const manifest = json(".codex-plugin/plugin.json");
  const packageJson = json("package.json");
  const packageLock = json("package-lock.json");
  const claudeManifest = json(".claude-plugin/plugin.json");

  assert.equal(manifest.name, "read-the-room");
  assert.equal(manifest.version, "1.1.0");
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.version, packageLock.version);
  assert.equal(manifest.version, packageLock.packages[""].version);
  assert.equal(manifest.version, claudeManifest.version);
  assert.equal(packageJson.engines.node, ">=18");
  assert.equal(packageLock.packages[""].engines.node, ">=18");
});

test("Codex selects only its supported package components", () => {
  const manifest = json(".codex-plugin/plugin.json");
  const codexHooks = json("hooks/codex-hooks.json");

  assert.equal(manifest.hooks, "./hooks/codex-hooks.json");
  assert.equal(manifest.mcpServers, "./codex.mcp.json");
  assert.deepEqual(Object.keys(codexHooks.hooks).sort(), [
    "SessionStart", "Stop", "UserPromptSubmit",
  ]);
  assert.equal(JSON.stringify(codexHooks).includes("MessageDisplay"), false);
  assert.equal(json("hooks/hooks.json").hooks.MessageDisplay.length > 0, true);
});

test("every Codex hook has exact portable plugin-root commands and selects Codex", () => {
  const hooks = json("hooks/codex-hooks.json").hooks;
  const paths = {
    SessionStart: "session-start.cjs",
    UserPromptSubmit: "reinject.cjs",
    Stop: "stop-gate.cjs",
  };

  for (const [event, file] of Object.entries(paths)) {
    const hook = hooks[event][0].hooks[0];
    assert.equal(hook.type, "command");
    assert.equal(hook.command, `node "\${PLUGIN_ROOT}/hooks/${file}" --host codex`);
    assert.equal(hook.commandWindows, `node "%PLUGIN_ROOT%\\hooks\\${file}" --host codex`);
    assert.doesNotMatch(JSON.stringify(hook), /CLAUDE_PLUGIN_(?:ROOT|DATA)/);
  }

  const sessionStart = readFileSync(join(root, "hooks/session-start.cjs"), "utf8");
  assert.match(sessionStart, /['"]PLUGIN_ROOT['"]/);
  assert.match(sessionStart, /['"]PLUGIN_DATA['"]/);
});

test("Codex MCP config uses the keyed plugin-relative bundle and selects Codex", () => {
  const mcp = json("codex.mcp.json")["read-the-room"];
  assert.equal(mcp.command, "node");
  assert.equal(mcp.cwd, ".");
  assert.deepEqual(mcp.args, ["./dist/read-the-room-server.js", "--host", "codex"]);
  assert.doesNotMatch(readFileSync(join(root, "codex.mcp.json"), "utf8"), /server\/index\.js|\$\{PLUGIN_ROOT\}/);
});

test("git includes the Codex manifest", () => {
  const result = spawnSync("git", ["check-ignore", ".codex-plugin/plugin.json"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0, result.stdout || result.stderr);
});
