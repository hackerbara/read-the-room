import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalizeInstalledPath,
  closeMcp,
  copyTrackedFiles,
  resolveHookLaunch,
  resolveMcpLaunch,
  withTimeout,
} from "../scripts/verify-codex-install.mjs";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

test("a tracked-file Codex install starts cached hooks and MCP", {
  skip: !process.env.CODEX_BIN,
}, () => {
  const result = spawnSync(process.execPath, [join(root, "scripts", "verify-codex-install.mjs")], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    timeout: 180_000,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
});

function gitRepoWithSymlink({ target, linkTarget }) {
  const repo = mkdtempSync(join(tmpdir(), "read-the-room-symlink-repo-"));
  mkdirSync(join(repo, ".git"), { recursive: true });
  const init = spawnSync("git", ["init", "--quiet", repo], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  writeFileSync(join(repo, target), "safe target\n");
  symlinkSync(linkTarget, join(repo, "link.txt"));
  const add = spawnSync("git", ["add", target, "link.txt"], { cwd: repo, encoding: "utf8" });
  assert.equal(add.status, 0, add.stderr);
  return repo;
}

test("copyTrackedFiles preserves a safe internal tracked symlink", () => {
  const repo = gitRepoWithSymlink({ target: "target.txt", linkTarget: "target.txt" });
  const destination = mkdtempSync(join(tmpdir(), "read-the-room-symlink-destination-"));
  try {
    copyTrackedFiles(destination, repo);
    const copiedLink = join(destination, "link.txt");
    assert.equal(readlinkSync(copiedLink), "target.txt");
    assert.equal(readFileSync(copiedLink, "utf8"), "safe target\n");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(destination, { recursive: true, force: true });
  }
});

test("copyTrackedFiles rejects a tracked symlink escaping the repository", () => {
  const outside = mkdtempSync(join(tmpdir(), "read-the-room-symlink-outside-"));
  const outsideFile = join(outside, "outside.txt");
  writeFileSync(outsideFile, "outside\n");
  const repo = gitRepoWithSymlink({ target: "target.txt", linkTarget: outsideFile });
  const destination = mkdtempSync(join(tmpdir(), "read-the-room-symlink-destination-"));
  try {
    assert.throws(
      () => copyTrackedFiles(destination, repo),
      /tracked symlink.*(outside|repository|escape)/i,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(destination, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("canonicalizeInstalledPath rejects fake or checkout-alias cache paths", () => {
  const work = mkdtempSync(join(tmpdir(), "read-the-room-installed-path-"));
  const codexHome = join(work, "codex-home");
  const source = join(work, "source");
  const fake = join(work, "fake-cache");
  mkdirSync(codexHome);
  mkdirSync(source);
  mkdirSync(fake);
  try {
    assert.throws(
      () => canonicalizeInstalledPath(fake, { codexHome, source }),
      /inside disposable CODEX_HOME|outside disposable CODEX_HOME/i,
    );
    const alias = join(codexHome, "alias");
    symlinkSync(realpathSync(source), alias);
    assert.throws(
      () => canonicalizeInstalledPath(alias, { codexHome, source }),
      /symlink|checkout|alias/i,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("MCP operations time out and cleanup closes both client and transport", async () => {
  await assert.rejects(
    withTimeout(new Promise(() => {}), "test MCP operation", 20),
    /test MCP operation timed out after 20ms/,
  );
  const closed = [];
  await closeMcp(
    { close: async () => closed.push("client") },
    { close: async () => closed.push("transport") },
  );
  assert.deepEqual(closed, ["client", "transport"]);
});

test("manifest-derived hook and MCP launches resolve inside the cached plugin", () => {
  const work = mkdtempSync(join(tmpdir(), "read-the-room-launch-safe-"));
  const installed = join(work, "installed");
  const source = join(work, "source");
  const project = join(work, "unrelated-project");
  mkdirSync(source);
  mkdirSync(project);
  mkdirSync(join(installed, "hooks"), { recursive: true });
  mkdirSync(join(installed, "dist"), { recursive: true });
  writeFileSync(join(installed, "hooks", "session-start.cjs"), "");
  writeFileSync(join(installed, "dist", "read-the-room-server.js"), "");
  try {
    const hook = resolveHookLaunch(
      'node "${PLUGIN_ROOT}/hooks/session-start.cjs" --host codex',
      installed,
      source,
      project,
    );
    assert.equal(hook.cwd, realpathSync(project));
    assert.notEqual(hook.cwd, realpathSync(source));
    assert.notEqual(hook.cwd, root);
    assert.deepEqual(hook.args, [join(realpathSync(installed), "hooks", "session-start.cjs"), "--host", "codex"]);

    const mcp = resolveMcpLaunch(
      { command: "node", args: ["./dist/read-the-room-server.js", "--host", "codex"], cwd: "." },
      installed,
      source,
    );
    assert.equal(mcp.cwd, realpathSync(installed));
    assert.deepEqual(mcp.args, [join(realpathSync(installed), "dist", "read-the-room-server.js"), "--host", "codex"]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("manifest launch validation rejects absolute and parent-traversal paths", () => {
  const work = mkdtempSync(join(tmpdir(), "read-the-room-launch-paths-"));
  const installed = join(work, "installed");
  const source = join(work, "source");
  mkdirSync(installed);
  mkdirSync(source);
  try {
    assert.throws(
      () => resolveHookLaunch('node "/tmp/elsewhere.cjs" --host codex', installed, source),
      /absolute|PLUGIN_ROOT|installed/i,
    );
    assert.throws(
      () => resolveMcpLaunch({ command: "node", args: ["/tmp/elsewhere.js", "--host", "codex"], cwd: "." }, installed, source),
      /absolute|relative|installed/i,
    );
    assert.throws(
      () => resolveMcpLaunch({ command: "node", args: ["./server.js", "--host", "codex"], cwd: "../source" }, installed, source),
      /parent|traversal|installed/i,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("manifest launch validation rejects a symlinked runtime escape", () => {
  const work = mkdtempSync(join(tmpdir(), "read-the-room-launch-symlink-"));
  const installed = join(work, "installed");
  const source = join(work, "source");
  const outside = join(work, "outside.js");
  mkdirSync(join(installed, "dist"), { recursive: true });
  mkdirSync(source);
  writeFileSync(outside, "");
  symlinkSync(outside, join(installed, "dist", "read-the-room-server.js"));
  try {
    assert.throws(
      () => resolveMcpLaunch(
        { command: "node", args: ["./dist/read-the-room-server.js", "--host", "codex"], cwd: "." },
        installed,
        source,
      ),
      /symlink|escape|installed/i,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
