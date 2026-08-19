import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const json = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const read = (path) => readFileSync(join(root, path), "utf8");

const packageJson = json("package.json");
const packageLock = json("package-lock.json");
const claudeManifest = json(".claude-plugin/plugin.json");
const codexManifest = json(".codex-plugin/plugin.json");
const readme = read("README.md");
const howItWorks = read("how-it-works.md");
const compatibilitySpec = read("docs/superpowers/specs/2026-08-18-codex-compatibility-design.md");

 test("release metadata is synchronized at 1.1.0 with Node 18 support", () => {
  assert.equal(packageJson.version, "1.1.0");
  assert.equal(packageLock.version, "1.1.0");
  assert.equal(packageLock.packages[""].version, "1.1.0");
  assert.equal(claudeManifest.version, "1.1.0");
  assert.equal(codexManifest.version, "1.1.0");
  assert.equal(packageJson.engines.node, ">=18");
  assert.equal(packageLock.packages[""].engines.node, ">=18");
});

test("README documents Codex installation, trust, and visible workspace truthfully", () => {
  assert.match(readme, /Needs Claude Code or Codex, plus Node\.js 18 or newer on your PATH\./i);
  assert.match(readme, /codex plugin marketplace add hackerbara\/read-the-room --ref main/);
  assert.match(readme, /codex plugin add read-the-room@read-the-room/);
  assert.match(readme, /review and trust the hooks.*start a new task/is);
  assert.match(readme, /Codex.*workspace.*remain(?:s)? visible/is);
  assert.match(readme, /BB.*group.*native.*work\s+presentation/is);
  assert.match(readme, /does not inspect or judge.*Codex reply/is);
  assert.match(readme, /bounded Stop decision may\s+delay completion.*backstop/is);
});

test("host qualification preserves the keyed and stay explanations", () => {
  assert.match(howItWorks, /Codex.*workspace.*visible/is);
  assert.match(howItWorks, /BB.*group.*native.*work\s+presentation/is);
  assert.match(howItWorks, /## The key/);
  assert.match(howItWorks, /A turn can also end without a reply at all/);
  assert.doesNotMatch(compatibilitySpec, /\/Users\/MAC\//);
});

test("BB-RTR-001 stays a separate optional upstream conformance note", () => {
  const bbNote = read("docs/bb-conformance-note.md");
  assert.match(bbNote, /BB-RTR-001/);
  assert.match(bbNote, /completed.*differs.*streamed/is);
  assert.match(bbNote, /not required.*plugin.*work/is);
  assert.match(bbNote, /upstream BB/i);
});
