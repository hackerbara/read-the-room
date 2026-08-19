import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

function runSessionStart({ home, temp, pluginData, sessionId }) {
  return spawnSync(process.execPath, [join(pluginRoot, "hooks", "session-start.cjs")], {
    cwd: pluginRoot,
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: temp,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      CLAUDE_PLUGIN_DATA: pluginData,
    },
    input: JSON.stringify({ session_id: sessionId, source: "startup" }),
    encoding: "utf8",
  });
}

test("a clean plugin install creates the session orientation from its bundled template", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "read-the-room-test-"));
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const home = join(sandbox, "home");
  const temp = join(sandbox, "tmp");
  const pluginData = join(sandbox, "plugin-data");
  const sessionId = "clean-install-session";

  const result = runSessionStart({ home, temp, pluginData, sessionId });

  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(result.stdout, "", "SessionStart should emit its context");

  const orientation = readFileSync(
    join(temp, "claude-orientation", `${sessionId}.orientation.txt`),
    "utf8",
  );
  assert.match(orientation, new RegExp(`session ${sessionId}`));
  assert.match(orientation, /^## What they are doing right now$/m);
  assert.match(orientation, /^## What they asked for$/m);
  assert.match(orientation, /^## Still open — asked, not delivered$/m);
  assert.match(orientation, /^## What I do not know about where they are$/m);
});

test("a persistent user-edited template is not overwritten by a later startup", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "read-the-room-test-"));
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const home = join(sandbox, "home");
  const temp = join(sandbox, "tmp");
  const pluginData = join(sandbox, "plugin-data");

  const first = runSessionStart({ home, temp, pluginData, sessionId: "first-session" });
  assert.equal(first.status, 0, first.stderr);

  const customTemplate = "# User-owned session {{SESSION_ID}}\n\n## Custom schema\n";
  writeFileSync(join(pluginData, "orientation-template.txt"), customTemplate);

  const secondSessionId = "second-session";
  const second = runSessionStart({ home, temp, pluginData, sessionId: secondSessionId });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(
    readFileSync(join(pluginData, "orientation-template.txt"), "utf8"),
    customTemplate,
  );
  assert.equal(
    readFileSync(
      join(temp, "claude-orientation", `${secondSessionId}.orientation.txt`),
      "utf8",
    ),
    customTemplate.replace("{{SESSION_ID}}", secondSessionId),
  );
});
