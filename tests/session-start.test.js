import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const channelStart = "<!-- read-the-room:channel:start -->";
const channelEnd = "<!-- read-the-room:channel:end -->";
const claudeDocumentDigests = {
  "orientation.md": "7e588fe0f37d2d4c0b8b5db097cdd124227378bd474a4c4548ea6368e653218a",
  "orientation-brief.md": "0e97f7646b0513fa486a99f3af6b3a1fd44d4fef2bee5d5642b16215f694714a",
};

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), "read-the-room-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    home: join(dir, "home"),
    temp: join(dir, "tmp"),
    pluginData: join(dir, "plugin-data"),
  };
}

function runSessionStart({
  home,
  temp,
  pluginData,
  sessionId,
  host = "claude",
  source = "startup",
  env: extraEnv = {},
}) {
  const args = [join(pluginRoot, "hooks", "session-start.cjs")];
  if (host === "codex") args.push("--host", "codex");
  const env = { ...process.env, HOME: home, TMPDIR: temp, ...extraEnv };
  delete env.PLUGIN_ROOT;
  delete env.PLUGIN_DATA;
  delete env.CLAUDE_PLUGIN_ROOT;
  delete env.CLAUDE_PLUGIN_DATA;
  Object.assign(env, extraEnv);
  if (host === "codex") {
    env.PLUGIN_ROOT ??= pluginRoot;
    env.PLUGIN_DATA ??= pluginData;
  } else {
    env.CLAUDE_PLUGIN_ROOT ??= pluginRoot;
    env.CLAUDE_PLUGIN_DATA ??= pluginData;
  }
  return spawnSync(process.execPath, args, {
    cwd: pluginRoot,
    env,
    input: JSON.stringify({ session_id: sessionId, source }),
    encoding: "utf8",
  });
}

function context(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(result.stdout, "", "SessionStart should emit its context");
  return JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
}

test("Codex receives truthful full and compact workspace language", (t) => {
  const box = sandbox(t);

  for (const source of ["startup", "compact"]) {
    const output = context(runSessionStart({
      ...box,
      pluginData: join(box.dir, `plugin-data-${source}`),
      sessionId: `codex-${source}`,
      host: "codex",
      source,
    }));

    assert.match(output, /ordinary assistant language\s+streams visibly/i);
    assert.match(output, /use language as workspace at whatever length/i);
    assert.doesNotMatch(output, /stays in your room/i);
    assert.doesNotMatch(output, /Nobody has to receive it/i);
    assert.doesNotMatch(output, /nothing in it costs them anything/i);
    assert.doesNotMatch(output, /costs them nothing/i);
    assert.doesNotMatch(output, /display may replace it with (?:a )?(?:short )?marker/i);
    assert.doesNotMatch(output, /nothing is hidden/i);
    assert.doesNotMatch(output, /ctrl\+O/i);
    assert.doesNotMatch(output, /full orientation document:/i);
    assert.doesNotMatch(
      output,
      new RegExp(join(box.dir, `plugin-data-${source}`, source === "startup"
        ? "orientation.md"
        : "orientation-brief.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
});

test("Claude rendered documents match pinned pre-marker digests", (t) => {
  const box = sandbox(t);

  for (const [source, name] of [["startup", "orientation.md"], ["resume", "orientation-brief.md"]]) {
    const output = context(runSessionStart({
      ...box,
      pluginData: join(box.dir, `claude-data-${source}`),
      sessionId: `claude-${source}`,
      source,
    }));
    const document = output.split("\n\n---\n\n## This session's files")[0];
    assert.equal(createHash("sha256").update(document).digest("hex"), claudeDocumentDigests[name]);
    assert.doesNotMatch(output, /read-the-room:channel/);
    assert.match(output, /The door\. It opens for you|the\s+door has a few small rules/i);
    assert.match(output, /Generation is free\. Delivery is the cost\./);
  }
});

test("Claude injects markerless persisted documents unchanged", (t) => {
  const box = sandbox(t);
  mkdirSync(box.pluginData, { recursive: true });
  const full = "# Existing full orientation\n\nUser-owned stays in your room text.\n";
  const brief = "# Existing brief orientation\n\nUser-owned brief text.\n";
  writeFileSync(join(box.pluginData, "orientation.md"), full);
  writeFileSync(join(box.pluginData, "orientation-brief.md"), brief);
  writeFileSync(join(box.pluginData, "orientation-template.txt"), "# Session {{SESSION_ID}}\n");

  const startup = context(runSessionStart({ ...box, sessionId: "legacy-startup" }));
  const resume = context(runSessionStart({ ...box, sessionId: "legacy-resume", source: "resume" }));

  assert.ok(startup.startsWith(full.trimEnd()));
  assert.ok(resume.startsWith(brief.trimEnd()));
  assert.equal(readFileSync(join(box.pluginData, "orientation.md"), "utf8"), full);
  assert.equal(readFileSync(join(box.pluginData, "orientation-brief.md"), "utf8"), brief);
});

test("Codex omits markerless persisted document context and leaves it untouched", (t) => {
  const box = sandbox(t);
  mkdirSync(box.pluginData, { recursive: true });
  const full = "# User-owned Codex orientation\n\nNobody has to receive it.\n";
  writeFileSync(join(box.pluginData, "orientation.md"), full);
  writeFileSync(join(box.pluginData, "orientation-brief.md"), "# User-owned brief\n");
  writeFileSync(join(box.pluginData, "orientation-template.txt"), "# Session {{SESSION_ID}}\n");

  const output = context(runSessionStart({ ...box, sessionId: "codex-markerless", host: "codex" }));

  assert.doesNotMatch(output, /User-owned Codex orientation|Nobody has to receive it/);
  assert.match(output, /## This session's files/);
  assert.equal(readFileSync(join(box.pluginData, "orientation.md"), "utf8"), full);
});

test("Codex fails open when a marked document has no channel fragment", (t) => {
  const box = sandbox(t);
  mkdirSync(box.pluginData, { recursive: true });
  const marked = `${channelStart}\nFalse hidden-workspace promise.\n${channelEnd}\n`;
  writeFileSync(join(box.pluginData, "orientation.md"), marked);
  writeFileSync(join(box.pluginData, "orientation-brief.md"), marked);
  writeFileSync(join(box.pluginData, "orientation-template.txt"), "# Session {{SESSION_ID}}\n");

  const output = context(runSessionStart({
    ...box,
    sessionId: "codex-missing-fragment",
    host: "codex",
    env: { PLUGIN_ROOT: join(box.dir, "missing-root"), PLUGIN_DATA: box.pluginData },
  }));

  assert.doesNotMatch(output, /False hidden-workspace promise/);
  assert.match(output, /## This session's files/);
  assert.match(
    readFileSync(join(box.temp, "claude-orientation", "codex-missing-fragment.state"), "utf8"),
    /^0 [a-f0-9]{64}$/m,
  );
});

test("host selection comes only from --host and resolves the matching environment", (t) => {
  const box = sandbox(t);
  const claudeData = join(box.dir, "claude-data");
  const codexData = join(box.dir, "codex-data");
  mkdirSync(claudeData, { recursive: true });
  mkdirSync(codexData, { recursive: true });
  for (const [dir, label] of [[claudeData, "CLAUDE-DOCUMENT"], [codexData, "CODEX-DOCUMENT"]]) {
    writeFileSync(join(dir, "orientation.md"), `# ${label}\n`);
    writeFileSync(join(dir, "orientation-brief.md"), `# ${label}-BRIEF\n`);
    writeFileSync(join(dir, "orientation-template.txt"), `# ${label} {{SESSION_ID}}\n`);
  }
  const both = {
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    CLAUDE_PLUGIN_DATA: claudeData,
    PLUGIN_ROOT: pluginRoot,
    PLUGIN_DATA: codexData,
  };

  const claude = context(runSessionStart({ ...box, pluginData: claudeData, sessionId: "host-claude", env: both }));
  const codex = context(runSessionStart({ ...box, pluginData: codexData, sessionId: "host-codex", host: "codex", env: both }));

  assert.match(claude, /CLAUDE-DOCUMENT/);
  assert.doesNotMatch(claude, /CODEX-DOCUMENT/);
  assert.doesNotMatch(codex, /CLAUDE-DOCUMENT|CODEX-DOCUMENT/,
    "Codex must select PLUGIN_DATA, then omit its markerless document");
});

test("a clean install seeds orientation, state, seed, and turns", (t) => {
  const box = sandbox(t);
  const sessionId = "clean-install-session";

  context(runSessionStart({ ...box, sessionId }));

  const base = join(box.temp, "claude-orientation");
  const orientation = readFileSync(join(base, `${sessionId}.orientation.txt`), "utf8");
  const state = readFileSync(join(base, `${sessionId}.state`), "utf8");
  const seed = readFileSync(join(base, `${sessionId}.seed`), "utf8");
  assert.match(orientation, new RegExp(`session ${sessionId}`));
  assert.match(orientation, /^## What they are doing right now$/m);
  assert.match(orientation, /^## What they asked for$/m);
  assert.match(orientation, /^## Still open — asked, not delivered$/m);
  assert.match(orientation, /^## What I do not know about where they are$/m);
  assert.match(state, /^0 [a-f0-9]{64}$/m);
  assert.match(state, /^0 - [a-f0-9]{64} What they are doing right now$/m);
  assert.match(seed, /^[a-f0-9]{64}$/m);
  assert.equal(readFileSync(join(base, `${sessionId}.turns`), "utf8"), "0");
});

test("a persistent user-edited template is not overwritten by a later startup", (t) => {
  const box = sandbox(t);
  context(runSessionStart({ ...box, sessionId: "first-session" }));
  const customTemplate = "# User-owned session {{SESSION_ID}}\n\n## Custom schema\n";
  writeFileSync(join(box.pluginData, "orientation-template.txt"), customTemplate);

  const secondSessionId = "second-session";
  context(runSessionStart({ ...box, sessionId: secondSessionId }));

  assert.equal(readFileSync(join(box.pluginData, "orientation-template.txt"), "utf8"), customTemplate);
  assert.equal(
    readFileSync(join(box.temp, "claude-orientation", `${secondSessionId}.orientation.txt`), "utf8"),
    customTemplate.replace("{{SESSION_ID}}", secondSessionId),
  );
});

test("compact mode reports an outstanding same-turn key", (t) => {
  const box = sandbox(t);
  const sessionId = "compact-key-session";
  context(runSessionStart({ ...box, sessionId }));
  const base = join(box.temp, "claude-orientation");
  writeFileSync(join(base, `${sessionId}.turns`), "7");
  writeFileSync(join(base, `${sessionId}.key`), "0123456789abcdef 7 0\nsetup\n");

  const output = context(runSessionStart({ ...box, sessionId, source: "compact" }));

  assert.match(output, /outstanding upkeep key from before the compaction/);
  assert.match(output, /bare `read_the_room` call re-presents it/);
});
