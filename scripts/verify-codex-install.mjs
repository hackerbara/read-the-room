#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const codexBin = process.env.CODEX_BIN || "codex";
const MCP_TIMEOUT_MS = 30_000;
const MCP_CLOSE_TIMEOUT_MS = 5_000;

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    env: options.env || process.env,
    input: options.input,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: options.timeout || 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().replace(/\s+/g, " ");
    fail(`${command} ${args.join(" ")} exited ${result.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }
  return result.stdout || "";
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${label} did not return JSON (${error.message})`);
  }
}

function isWithin(base, candidate) {
  const suffix = relative(base, candidate);
  return suffix === "" || (!suffix.startsWith(".." + sep) && suffix !== "..");
}

export function copyTrackedFiles(destination, repositoryRoot = root) {
  const sourceRoot = realpathSync(repositoryRoot);
  const listing = spawnSync("git", ["ls-files", "-z"], {
    cwd: sourceRoot,
    encoding: "buffer",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (listing.error) throw listing.error;
  if (listing.status !== 0) fail(`git ls-files failed: ${(listing.stderr || "").toString().trim()}`);

  const files = listing.stdout.toString("utf8").split("\0").filter(Boolean);
  for (const file of files) {
    const from = resolve(sourceRoot, file);
    const to = resolve(destination, file);
    if (!isWithin(sourceRoot, from) || !isWithin(destination, to)) fail(`tracked path escapes source: ${file}`);
    const stat = lstatSync(from);
    mkdirSync(dirname(to), { recursive: true });
    if (stat.isSymbolicLink()) {
      let target;
      try {
        target = realpathSync(from);
      } catch {
        fail(`tracked symlink target is missing or invalid: ${file}`);
      }
      if (!isWithin(sourceRoot, target)) {
        fail(`tracked symlink escapes repository: ${file}`);
      }
      const rawTarget = readlinkSync(from);
      const targetInDestination = resolve(destination, relative(sourceRoot, target));
      const copiedTarget = isAbsolute(rawTarget)
        ? relative(dirname(to), targetInDestination)
        : rawTarget;
      symlinkSync(copiedTarget, to);
      continue;
    }
    if (!stat.isFile()) fail(`tracked release input is not a regular file: ${file}`);
    writeFileSync(to, readFileSync(from), { mode: stat.mode & 0o777 });
  }
  return files;
}

export function canonicalizeInstalledPath(installedPath, { codexHome, source }) {
  if (typeof installedPath !== "string" || !isAbsolute(installedPath)) {
    fail("Codex install JSON must contain an absolute installedPath");
  }
  let homeRoot;
  let sourceRoot;
  let cachedRoot;
  try {
    homeRoot = realpathSync(codexHome);
    sourceRoot = realpathSync(source);
    cachedRoot = realpathSync(installedPath);
  } catch {
    fail("installedPath must resolve to an existing cached directory");
  }
  if (isWithin(sourceRoot, cachedRoot)) {
    fail("installedPath aliases the source checkout");
  }
  if (!isWithin(homeRoot, cachedRoot)) {
    fail("installedPath is outside disposable CODEX_HOME");
  }
  let installedStat;
  try {
    installedStat = lstatSync(installedPath);
  } catch {
    fail("installedPath must resolve to an existing cached directory");
  }
  if (installedStat.isSymbolicLink()) fail("installedPath must not be a symlink");
  if (!installedStat.isDirectory()) fail("installedPath must resolve to a cached directory");
  return cachedRoot;
}

function hookEnv({ codexHome, pluginRoot, pluginData, temp }) {
  return {
    ...process.env,
    HOME: codexHome,
    CODEX_HOME: codexHome,
    PLUGIN_ROOT: pluginRoot,
    PLUGIN_DATA: pluginData,
    TMPDIR: temp,
  };
}

function runCachedHook(installedPath, hook, input, env, source) {
  const result = spawnSync(process.execPath, [join(installedPath, "hooks", hook), "--host", "codex"], {
    cwd: source,
    env,
    input: JSON.stringify(input),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().replace(/\s+/g, " ");
    fail(`cached ${hook} exited ${result.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }
  return result.stdout.trim() ? parseJson(result.stdout, `cached ${hook}`) : null;
}

export function withTimeout(operation, label, milliseconds = MCP_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
    timer.unref?.();
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

export function resolveMcpLaunch(mcp, installedPath) {
  return {
    command: mcp.command,
    args: [...mcp.args],
    cwd: resolve(installedPath, mcp.cwd || "."),
  };
}

export async function closeMcp(client, transport) {
  try {
    await withTimeout(client.close(), "MCP client close", MCP_CLOSE_TIMEOUT_MS);
  } catch {}
  try {
    await withTimeout(transport.close(), "MCP transport close", MCP_CLOSE_TIMEOUT_MS);
  } catch {}
}

export async function verify() {
  let work;

  try {
    work = mkdtempSync(join(tmpdir(), "read-the-room-codex-install-"));
    const source = join(work, "source");
    const codexHome = join(work, "codex-home");
    const pluginData = join(work, "plugin-data");
    const temp = join(work, "tmp");
    for (const directory of [source, codexHome, pluginData, temp]) mkdirSync(directory, { recursive: true });

    const files = copyTrackedFiles(source);
    assert.ok(files.includes(".codex-plugin/plugin.json"), "tracked source must include the Codex manifest");
    assert.ok(existsSync(join(source, ".codex-plugin/plugin.json")), "source Codex manifest is missing");
    assert.equal(existsSync(join(source, "node_modules")), false, "source must not contain node_modules");
    assert.equal(existsSync(join(source, "probes")), false, "source must not contain probes");

    const env = { ...process.env, HOME: codexHome, CODEX_HOME: codexHome };
    run(codexBin, ["plugin", "marketplace", "add", source, "--json"], { env });
    const available = parseJson(
      run(codexBin, ["plugin", "list", "--marketplace", "read-the-room", "--available", "--json"], { env }),
      "Codex plugin list",
    );
    assert.ok(
      (available.available || []).some((entry) => entry.pluginId === "read-the-room@read-the-room"),
      "read-the-room must be available from the temporary marketplace",
    );
    const installed = parseJson(
      run(codexBin, ["plugin", "add", "read-the-room@read-the-room", "--json"], { env }),
      "Codex plugin install",
    );
    const installedPath = canonicalizeInstalledPath(installed.installedPath, { codexHome, source });
    assert.ok(existsSync(join(installedPath, ".codex-plugin", "plugin.json")), "cached Codex manifest is missing");
    assert.ok(existsSync(join(installedPath, "hooks", "codex-hooks.json")), "cached Codex hooks are missing");
    assert.ok(existsSync(join(installedPath, "codex.mcp.json")), "cached Codex MCP config is missing");
    assert.ok(existsSync(join(installedPath, "dist", "read-the-room-server.js")), "cached MCP bundle is missing");

    const runtimeEnv = hookEnv({ codexHome, pluginRoot: installedPath, pluginData, temp });
    const sessionId = "clean-install-session";
    const hookInput = { session_id: sessionId, source: "startup", cwd: source };
    const sessionStart = runCachedHook(installedPath, "session-start.cjs", hookInput, runtimeEnv, source);
    assert.ok(sessionStart?.hookSpecificOutput?.additionalContext, "SessionStart must emit context");
    assert.match(sessionStart.hookSpecificOutput.additionalContext, /ordinary assistant language streams visibly/i);
    assert.doesNotMatch(sessionStart.hookSpecificOutput.additionalContext, /display may replace it with a short marker/i);

    const prompt = runCachedHook(installedPath, "reinject.cjs", hookInput, runtimeEnv, source);
    const stateBase = join(temp, "claude-orientation");
    assert.equal(readFileSync(join(stateBase, `${sessionId}.gate`), "utf8"), "CLOSED 1");
    assert.equal(readFileSync(join(stateBase, "current-session"), "utf8"), sessionId);
    assert.equal(prompt, null, "the first prompt should not reinject unchanged orientation");

    const config = parseJson(readFileSync(join(installedPath, "codex.mcp.json"), "utf8"), "cached Codex MCP config");
    const mcp = config["read-the-room"];
    assert.ok(mcp && mcp.command && Array.isArray(mcp.args), "cached MCP config must define read-the-room");
    const launch = resolveMcpLaunch(mcp, installedPath);
    const transport = new StdioClientTransport({
      ...launch,
      env: runtimeEnv,
      stderr: "pipe",
    });
    let serverStderr = "";
    transport.stderr?.on("data", (chunk) => {
      serverStderr += chunk.toString();
    });
    assert.ok(isWithin(installedPath, launch.cwd), "cached MCP cwd must remain inside installed runtime");
    assert.equal(isWithin(source, launch.cwd), false, "cached MCP runtime must not alias source checkout");

    const client = new Client({ name: "clean-codex-install", version: "1.0.0" });
    try {
      await withTimeout(client.connect(transport), "MCP connect");
      const tools = await withTimeout(client.listTools(), "MCP listTools");
      assert.ok(tools.tools.some(({ name }) => name === "read_the_room"), "cached MCP must expose read_the_room");

      const keyed = await withTimeout(
        client.callTool({ name: "read_the_room", arguments: {} }),
        "MCP setup-key issue",
      );
      assert.equal(keyed?.isError, undefined, "setup-key call must succeed");
      const keyedText = keyed?.content?.find((entry) => entry.type === "text")?.text || "";
      assert.match(keyedText, /# Where they are — session clean-install-session/);
      assert.match(keyedText, /THE DOOR IS KEYED/);
      assert.doesNotMatch(keyedText, /Workspace this turn:/);
      assert.doesNotMatch(keyedText, /Your last reply was replaced with the marker|suppression-derived|hidden display/i);
      assert.equal(readFileSync(join(stateBase, `${sessionId}.gate`), "utf8"), "KEYED 1");
      const nonce = readFileSync(join(stateBase, `${sessionId}.key`), "utf8").split(/\s+/)[0];
      assert.match(keyedText, new RegExp(`key: "${nonce}"`));

      const orientationPath = join(stateBase, `${sessionId}.orientation.txt`);
      writeFileSync(orientationPath, `${readFileSync(orientationPath, "utf8")}\nA fact learned during cached-install verification.\n`);
      const opened = await withTimeout(
        client.callTool({ name: "read_the_room", arguments: { key: nonce } }),
        "MCP setup-key return",
      );
      assert.equal(opened?.isError, undefined, "setup-key return must succeed");
      const openedText = opened?.content?.find((entry) => entry.type === "text")?.text || "";
      assert.match(openedText, /Key returned\. The door is open/);
      assert.doesNotMatch(openedText, /Workspace this turn:/);
      assert.equal(readFileSync(join(stateBase, `${sessionId}.gate`), "utf8"), "OPEN 1");
    } catch (error) {
      const detail = serverStderr.trim().replace(/\s+/g, " ");
      if (detail) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}: ${detail.slice(0, 500)}`, {
          cause: error,
        });
      }
      throw error;
    } finally {
      await closeMcp(client, transport);
    }

    return "PASS: tracked cache, cached Codex hooks, shared setup key, and MCP door verified (OPEN 1)";
  } finally {
    if (work) rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(await verify());
  } catch (error) {
    console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
