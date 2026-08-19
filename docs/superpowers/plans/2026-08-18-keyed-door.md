# Keyed Door Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The door issues content-blind keys (setup / freshness / pruning) that must be returned before entry, staying-in becomes a legal counted end state, and every liberty leaves a ledger trace.

**Architecture:** Section-granular freshness lives in a sidecar appended to the existing `.state` file (line 1 unchanged for old parsers; one atomic rename). The MCP server computes/verifies keys from stats alone; hooks gain two gate tokens (`KEYED`, `STAYED`). Pure decision logic goes in a new `server/logic.mjs` so it is unit-testable without stdio.

**Tech Stack:** Node ≥18 (node:test, node:crypto), CommonJS hooks + ESM server, @modelcontextprotocol/sdk, zod.

**Spec:** `docs/superpowers/specs/2026-08-18-keyed-door-design.md`

## Global Constraints

- Content-blind always: no code reads section *meaning*; only hashes, bytes, turns.
- Ordinary Edit/Write stays the only write path to the orientation file.
- Every state write fails open (bare try/catch, as the codebase does today).
- Gate file line stays `<status> <turn> [stopped]` — parse with first-line `readTokens` everywhere.
- Env names: `CLAUDE_ORIENTATION_FRESH_AT` (6), `_PRUNE_AT` (5000), `_SETUP_KEY` (on; `0/off/false/no` disables), `_STAY_CAP` (3), `_SNOOZE` (6), `_STOP_MIN_CHARS` (100, was 180), `_SHORT_CHARS` (150, was 400), `_STOP_MAX_RERUNS` (2).
- Fast sections are matched case-insensitively by prefix: `what they are doing right now`, `what they have not seen`, `still open`.
- Commit style: plain imperative sentence, no prefix (match `git log`).
- Tests: `node --test tests/` (all) or `node --test tests/<file>` (one). Test files are ESM, spawnSync the hook under a sandboxed `TMPDIR`/`HOME` exactly like `tests/session-start.test.js`.

## File map

- Create: `server/logic.mjs` (pure key/section logic), `hooks/session-end.cjs`, `tests/sidecar.test.js`, `tests/logic.test.js`, `tests/display-gate.test.js`, `tests/stop-gate.test.js`, `tests/cleanup.test.js`
- Modify: `hooks/session-start.cjs`, `hooks/reinject.cjs`, `hooks/message-display.cjs`, `hooks/stop-gate.cjs`, `server/index.js`, `hooks/hooks.json`, `docs/orientation-template.txt`, `docs/orientation.md`, `docs/orientation-brief.md`, `how-it-works.md`, `README.md`, `tests/session-start.test.js`

## Shared formats (referenced by every task; defined once here, restated in each task's Interfaces)

- **`<sid>.state` v2** — line 1: `<turn> <sha256-of-file>` (unchanged). Lines 2+: `<turnChanged> <turnAffirmed|-> <sectionHash|gone> <header text…>` (header is the remainder — it contains spaces). Written whole-file via temp+rename.
- **`<sid>.seed`** — written once at seed time: line 1 `<sha256-of-seeded-file>`, lines 2+ `<sectionHash> <header text…>`.
- **`<sid>.key`** — line 1: `<nonce> <turn> <attempts>`. Lines 2+, one reason each: `setup <fileHashAtIssue>` · `fresh <sectionHashAtIssue> <header text…>` · `prune <bytesAtIssue>`.
- **`<sid>.ledger`** — append-only: `<turn> <event> <delta|-> <reason text…>`; events: issued, satisfied, affirmed, fumbled, stood-down, lapsed, stayed-keyed, snoozed.
- **`<sid>.snooze`** — lines: `<expiryTurn> <reason text…>` (reason text: `setup`, `fresh <header>`, `prune`).
- **`<sid>.staynote`** — one line of stay note text; written by server on stay, consumed by message-display.
- **`<sid>.staystreak`** — integer; maintained by stop-gate.
- **Setup satisfaction** is whole-file: pass when the file's hash ≠ `<fileHashAtIssue>`. (Spec §10 says "writing the gap counts fully"; the gap section is not a fast section, so per-fast-section verification would contradict §10. Whole-file change is the lol-rule applied literally. This is the plan's one deliberate refinement of §6 — carry it back into the spec at the end of Task 6.)

---

### Task 1: Sidecar seeding at session start

**Files:**
- Modify: `hooks/session-start.cjs`
- Test: `tests/sidecar.test.js` (new)

**Interfaces:**
- Produces: `.state` v2 (formats above) and `.seed`, both written when and only when the orientation file is first seeded. Helper functions (CJS, local to the hook — the codebase duplicates helpers per hook deliberately): `splitSections(text)` → `[{header, hash}]`, `renderStateV2(turn, fileHash, entries)` → string, `writeAtomic(path, content)`.

- [ ] **Step 1: Write the failing test**

```js
// tests/sidecar.test.js
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

export function runHook(name, { temp, sessionId, source = "startup", extraEnv = {} }) {
  return spawnSync(process.execPath, [join(pluginRoot, "hooks", name)], {
    cwd: pluginRoot,
    env: { ...process.env, TMPDIR: temp, CLAUDE_PLUGIN_ROOT: pluginRoot,
           CLAUDE_PLUGIN_DATA: join(temp, "plugin-data"), ...extraEnv },
    input: JSON.stringify({ session_id: sessionId, source }),
    encoding: "utf8",
  });
}

test("seeding writes state v2 with one sidecar line per template section, plus a seed file", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "rtr-sidecar-"));
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const temp = join(sandbox, "tmp");
  const sid = "sidecar-seed-session";

  const r = runHook("session-start.cjs", { temp, sessionId: sid });
  assert.equal(r.status, 0, r.stderr);

  const base = join(temp, "claude-orientation");
  const state = readFileSync(join(base, `${sid}.state`), "utf8").trimEnd().split("\n");
  assert.match(state[0], /^0 [0-9a-f]{64}$/);            // line 1: turn 0 + file hash
  const sidecar = state.slice(1);
  assert.ok(sidecar.length >= 6, "one line per ## section");
  for (const line of sidecar)
    assert.match(line, /^0 - [0-9a-f]{64} \S/);           // turn 0, no affirm, hash, header
  assert.ok(sidecar.some(l => l.endsWith("What they are doing right now")));

  const seed = readFileSync(join(base, `${sid}.seed`), "utf8").trimEnd().split("\n");
  assert.match(seed[0], /^[0-9a-f]{64}$/);
  assert.equal(seed.length, sidecar.length + 1);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `node --test tests/sidecar.test.js`
Expected: FAIL — `.state` today is only written by reinject, and never at seed time (ENOENT reading `${sid}.state`).

- [ ] **Step 3: Implement in session-start.cjs**

Add below `stripTrailingNL` (crypto is not yet required in this file — add `const crypto = require('crypto');` at the top):

```js
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function splitSections(text) {
  const out = []; let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) { if (cur) out.push(cur); cur = { header: line.slice(3).trim(), body: [] }; }
    else if (cur) cur.body.push(line);
  }
  if (cur) out.push(cur);
  return out.map(s => ({ header: s.header, hash: sha256(s.body.join('\n')) }));
}

function renderStateV2(turn, fileHash, entries) {
  return [`${turn} ${fileHash}`,
    ...entries.map(e => `${e.changed} ${e.affirmed || '-'} ${e.hash} ${e.header}`)].join('\n') + '\n';
}

function writeAtomic(p, content) {
  const tmp = `${p}.tmp${process.pid}`;
  fs.writeFileSync(tmp, content); fs.renameSync(tmp, p);
}
```

In `run()`, immediately after the block that seeds `orientFile` from the template (the `if (!fs.existsSync(orientFile) && readable(template))` block), extend it so seeding also stamps state and seed — inside the same `try`:

```js
      const seeded = tpl.split('{{SESSION_ID}}').join(sessionId);
      fs.writeFileSync(orientFile, seeded);
      const sections = splitSections(seeded);
      const fileHash = sha256(seeded);
      const entries = sections.map(s => ({ changed: '0', affirmed: null, hash: s.hash, header: s.header }));
      writeAtomic(path.join(base, `${sessionId}.state`), renderStateV2('0', fileHash, entries));
      writeAtomic(path.join(base, `${sessionId}.seed`),
        [fileHash, ...sections.map(s => `${s.hash} ${s.header}`)].join('\n') + '\n');
```

- [ ] **Step 4: Run the new test and the whole suite**

Run: `node --test tests/`
Expected: all PASS (the two existing session-start tests must still pass untouched).

- [ ] **Step 5: Commit**

```bash
git add hooks/session-start.cjs tests/sidecar.test.js
git commit -m "Seed the section sidecar and seed-hash file at session start"
```

---

### Task 2: Sidecar maintenance in reinject; nudges retired; interrupts cover KEYED

**Files:**
- Modify: `hooks/reinject.cjs`
- Test: `tests/sidecar.test.js` (extend)

**Interfaces:**
- Consumes: `.state` v2 + `.seed` from Task 1 (same helper shapes, duplicated into this file per codebase convention).
- Produces: `.state` v2 maintained every turn — unchanged sections keep `turnChanged`, changed sections stamp the current turn, vanished sections keep their line with hash `gone`, `affirmed` carried through. The 5-turn nudge and 10+/repeat reinjection are gone: reinject emits NOTHING on stdout ever again. Interrupt detection fires for prev status `CLOSED` or `KEYED`.

- [ ] **Step 1: Write the failing tests (append to tests/sidecar.test.js)**

```js
import { writeFileSync, appendFileSync } from "node:fs";

function promptTurn(temp, sid) {
  return runHook("reinject.cjs", { temp, sessionId: sid, source: undefined });
}

test("reinject stamps changed sections with the current turn and keeps unchanged stamps", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "rtr-sidecar2-"));
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const temp = join(sandbox, "tmp");
  const sid = "sidecar-maint-session";
  runHook("session-start.cjs", { temp, sessionId: sid });
  const base = join(temp, "claude-orientation");
  const orient = join(base, `${sid}.orientation.txt`);

  promptTurn(temp, sid);                                   // turn 1, nothing changed
  appendFileSync(orient, "\nnew fact about them\n");       // touches the LAST section only
  promptTurn(temp, sid);                                   // turn 2

  const rows = readFileSync(join(base, `${sid}.state`), "utf8").trimEnd().split("\n").slice(1);
  const last = rows[rows.length - 1];
  assert.match(last, /^2 /);                               // changed at turn 2
  assert.match(rows[0], /^0 /);                            // first section untouched since seed
});

test("a vanished section keeps its line marked gone; reinject emits nothing on stdout", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "rtr-sidecar3-"));
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const temp = join(sandbox, "tmp");
  const sid = "sidecar-gone-session";
  runHook("session-start.cjs", { temp, sessionId: sid });
  const base = join(temp, "claude-orientation");
  const orient = join(base, `${sid}.orientation.txt`);

  const text = readFileSync(orient, "utf8");
  writeFileSync(orient, text.replace(/^## Their words$/m, "## Renamed by the agent"));
  const r = promptTurn(temp, sid);
  assert.equal(r.stdout, "", "reinject must no longer emit context");

  const rows = readFileSync(join(base, `${sid}.state`), "utf8");
  assert.match(rows, /gone Their words$/m);
  assert.match(rows, /^1 - [0-9a-f]{64} Renamed by the agent$/m);
});

test("an interrupted KEYED turn stamps .interrupted", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "rtr-int-"));
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const temp = join(sandbox, "tmp");
  const sid = "keyed-interrupt-session";
  runHook("session-start.cjs", { temp, sessionId: sid });
  const base = join(temp, "claude-orientation");
  promptTurn(temp, sid);                                   // turn 1, gate CLOSED 1
  writeFileSync(join(base, `${sid}.gate`), "KEYED 1");     // door keyed it, turn never stopped
  promptTurn(temp, sid);                                   // turn 2 arrives
  assert.equal(readFileSync(join(base, `${sid}.interrupted`), "utf8"), "1");
});
```

- [ ] **Step 2: Run, verify the three fail**

Run: `node --test tests/sidecar.test.js`
Expected: FAIL — no sidecar maintenance exists; the second test also fails while the old 5-turn nudge still emits; the third fails on the `CLOSED`-only interrupt check.

- [ ] **Step 3: Implement in reinject.cjs**

(a) Copy in `splitSections`, `renderStateV2`, `writeAtomic` exactly as written in Task 1 Step 3 (plus a `parseStateV2`):

```js
function parseStateV2(content) {
  const lines = (content || '').split('\n').filter(Boolean);
  const head = (lines[0] || '').trim().split(/\s+/);
  const entries = lines.slice(1).map(l => {
    const m = l.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    return m ? { changed: m[1], affirmed: m[2] === '-' ? null : m[2], hash: m[3], header: m[4] } : null;
  }).filter(Boolean);
  return { turn: head[0] || '', hash: head[1] || '', entries };
}
```

(b) Replace everything from `const nowHash = sha256File(orientFile);` to the end of `run()` with:

```js
  const content = (() => { try { return fs.readFileSync(orientFile, 'utf8'); } catch { return null; } })();
  if (content === null) return;
  const nowHash = crypto.createHash('sha256').update(content).digest('hex');

  let prev = { turn: '', hash: '', entries: [] };
  try { prev = parseStateV2(fs.readFileSync(stateFile, 'utf8')); } catch {}

  const sections = splitSections(content);
  const seen = new Set();
  const entries = sections.map(s => {
    seen.add(s.header);
    const old = prev.entries.find(e => e.header === s.header);
    if (!old) return { changed: String(count), affirmed: null, hash: s.hash, header: s.header };
    if (old.hash !== s.hash && old.hash !== 'gone') return { ...old, changed: String(count), hash: s.hash };
    if (old.hash === 'gone') return { ...old, changed: String(count), hash: s.hash }; // section returned
    return old;
  });
  for (const e of prev.entries) if (!seen.has(e.header))
    entries.push(e.hash === 'gone' ? e : { ...e, hash: 'gone' });

  try { writeAtomic(stateFile, renderStateV2(String(count), nowHash, entries)); } catch {}
```

(c) In the interrupt check, change `prevStatus === 'CLOSED'` to `(prevStatus === 'CLOSED' || prevStatus === 'KEYED')`.

(d) Delete: the `stale` computation, the `nudgeAt/reinjectAt/repeat` reads, and both `emitJson(...)` blocks. `emitJson` itself and the `digitsOrDefault` helper stay (the msg-sweep still uses `digitsOrDefault`).

- [ ] **Step 4: Run the whole suite**

Run: `node --test tests/`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add hooks/reinject.cjs tests/sidecar.test.js
git commit -m "Maintain the section sidecar each turn and retire the reinject nudges"
```

---

### Task 3: message-display learns KEYED and STAYED

**Files:**
- Modify: `hooks/message-display.cjs`
- Test: `tests/display-gate.test.js` (new)

**Interfaces:**
- Consumes: gate tokens `KEYED`/`STAYED` (written by the server from Task 6 on; inert until then), `.staynote` (one line, server-written).
- Produces: KEYED hides exactly like CLOSED. STAYED replaces the message with the stay marker: `■ stayed in this turn — <note> (nothing was said; ctrl+O for the workspace)` (note omitted cleanly when absent). Default `SHORT_CHARS` drops 400 → 150.

- [ ] **Step 1: Write the failing tests**

```js
// tests/display-gate.test.js
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

function display(temp, payload, extraEnv = {}) {
  return spawnSync(process.execPath, [join(pluginRoot, "hooks", "message-display.cjs")], {
    cwd: pluginRoot,
    env: { ...process.env, TMPDIR: temp, ...extraEnv },
    input: JSON.stringify(payload), encoding: "utf8",
  });
}

function setup(status, note) {
  const sandbox = mkdtempSync(join(tmpdir(), "rtr-disp-"));
  const temp = join(sandbox, "tmp");
  const base = join(temp, "claude-orientation");
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "s1.gate"), `${status} 3`);
  writeFileSync(join(base, "s1.turns"), "3");
  if (note !== undefined) writeFileSync(join(base, "s1.staynote"), note);
  return { sandbox, temp };
}

const longText = "x".repeat(400) + "\n";

test("KEYED hides long text exactly like CLOSED", () => {
  const { sandbox, temp } = setup("KEYED");
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const r = display(temp, { session_id: "s1", message_id: "m1", turn_id: "t1",
                            index: "0", delta: longText, final: "true" });
  const out = JSON.parse(r.stdout);
  assert.match(out.hookSpecificOutput.displayContent, /working notes/);
  assert.ok(!out.hookSpecificOutput.displayContent.includes(longText.trim()));
});

test("STAYED renders the stay marker with the note", () => {
  const { sandbox, temp } = setup("STAYED", "waiting on the retrieval agent");
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const r = display(temp, { session_id: "s1", message_id: "m1", turn_id: "t1",
                            index: "0", delta: longText, final: "true" });
  const out = JSON.parse(r.stdout);
  assert.match(out.hookSpecificOutput.displayContent,
    /^■ stayed in this turn — waiting on the retrieval agent \(nothing was said; ctrl\+O for the workspace\)/);
});

test("default hide threshold is now 150 characters", () => {
  const { sandbox, temp } = setup("CLOSED");
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const r = display(temp, { session_id: "s1", message_id: "m2", turn_id: "t1",
                            index: "0", delta: "y".repeat(200) + "\n", final: "true" });
  const out = JSON.parse(r.stdout);
  assert.match(out.hookSpecificOutput.displayContent, /working notes/);  // 200 > 150 → hidden
});
```

- [ ] **Step 2: Run, verify all three fail**

Run: `node --test tests/display-gate.test.js`
Expected: FAIL — KEYED falls through both status checks (original text displayed), STAYED unknown, 200 chars < 400 passes through.

- [ ] **Step 3: Implement in message-display.cjs**

(a) Change the default: `digitsOrDefault(process.env.CLAUDE_ORIENTATION_SHORT_CHARS, '400')` → `'150'`.

(b) After the `if (status === 'OPEN') {...}` block, add the STAYED branch:

```js
  if (status === 'STAYED') {
    if (!isFinal) { emit(emptyVal); return; }
    let note = '';
    try {
      note = fs.readFileSync(path.join(base, `${sessionId}.staynote`), 'utf8').trim();
      fs.unlinkSync(path.join(base, `${sessionId}.staynote`));
    } catch {}
    emit(`■ stayed in this turn${note ? ` — ${note}` : ''} (nothing was said; ctrl+O for the workspace)`);
    return;
  }
```

(c) Change the fall-through guard to include KEYED:
`if (status !== 'CLOSED' && status !== 'SPOKEN' && status !== 'KEYED') return;`

- [ ] **Step 4: Run the whole suite**

Run: `node --test tests/`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add hooks/message-display.cjs tests/display-gate.test.js
git commit -m "Hide keyed turns like closed ones and render the stay marker"
```

---

### Task 4: stop-gate learns KEYED and STAYED

**Files:**
- Modify: `hooks/stop-gate.cjs`
- Test: `tests/stop-gate.test.js` (new)

**Interfaces:**
- Consumes: gate tokens; `.key` (line 2+ reasons, remainder-encoded); `.staystreak`.
- Produces: KEYED end → nudge naming the outstanding reasons, `lapsed` ledger line, same `suppressed` counter as CLOSED, and the MIN_CHARS exemption does NOT apply. STAYED end → stamps `STAYED <turn> stopped`, increments `.staystreak`; over STAY_CAP (default 3) emits the ordinary come-through nudge. SPOKEN/OPEN reset `.staystreak` to 0. Default MIN_CHARS drops 180 → 100.

- [ ] **Step 1: Write the failing tests**

```js
// tests/stop-gate.test.js
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

function stop(temp, sid, lastMessage, extraEnv = {}) {
  return spawnSync(process.execPath, [join(pluginRoot, "hooks", "stop-gate.cjs")], {
    cwd: pluginRoot, env: { ...process.env, TMPDIR: temp, ...extraEnv },
    input: JSON.stringify({ session_id: sid, last_assistant_message: lastMessage,
                            stop_hook_active: "false" }),
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
  assert.match(readFileSync(join(base, "s1.ledger"), "utf8"), /^5 lapsed - /m);
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
```

- [ ] **Step 2: Run, verify failures**

Run: `node --test tests/stop-gate.test.js`
Expected: FAIL — KEYED/STAYED are unknown statuses today (silent return), no ledger/staystreak logic exists.

- [ ] **Step 3: Implement in stop-gate.cjs**

(a) Default change: `digitsOrDefault(process.env.CLAUDE_ORIENTATION_STOP_MIN_CHARS, '180')` → `'100'`.

(b) Add small helpers near the top (fs/path already required):

```js
function appendLedger(base, sessionId, turn, event, delta, reason) {
  try { fs.appendFileSync(path.join(base, `${sessionId}.ledger`),
    `${turn} ${event} ${delta || '-'} ${reason || ''}\n`.replace(/ +\n$/, '\n')); } catch {}
}
function readKeyReasons(p) {
  try { return fs.readFileSync(p, 'utf8').split('\n').slice(1).filter(Boolean); } catch { return []; }
}
```

(c) In the OPEN and SPOKEN branches, reset the streak alongside the existing suppressed reset: `try { fs.writeFileSync(path.join(base, `${sessionId}.staystreak`), '0'); } catch {}`.

(d) New STAYED branch after the SPOKEN branch:

```js
  if (status === 'STAYED') {
    stamp('STAYED');
    let streak = 0;
    try { streak = parseInt(fs.readFileSync(path.join(base, `${sessionId}.staystreak`), 'utf8').replace(/[^0-9]/g, ''), 10) || 0; } catch {}
    streak += 1;
    try { fs.writeFileSync(path.join(base, `${sessionId}.staystreak`), String(streak)); } catch {}
    const stayCap = parseInt(digitsOrDefault(process.env.CLAUDE_ORIENTATION_STAY_CAP, '3'), 10);
    const rerun = jqStr(input.stop_hook_active, 'false') === 'true';
    if (!rerun && stayCap > 0 && streak > stayCap) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop',
        additionalContext: `You have stayed in for ${streak} consecutive turns. Staying is legal and counted, but the person has heard nothing in all that time. Either go through the door with something for them, or tell them plainly you are holding and why.` } }) + '\n');
    }
    return;
  }
```

(e) New KEYED branch after it — mirrors the CLOSED branch's shape (stopActive short-circuit, suppressed increment, STOP_MAX_RERUNS stand-down, stamp) with three differences: no MIN_CHARS exemption, a `lapsed` ledger line, and reason-naming copy. Reuse the CLOSED branch's code as the base and replace the context text with:

```js
    const reasons = readKeyReasons(path.join(base, `${sessionId}.key`));
    appendLedger(base, sessionId, curTurn, 'lapsed', null, reasons.join('; '));
    const ctx = `A key was issued and not returned — the door asked for upkeep before entry and the turn is ending without it.
Outstanding: ${reasons.join(' · ') || 'unknown'}
Call read_the_room again: a bare call re-presents the key (not a fumble). Update or affirm what it names, return the key, then reply.`;
```

Also: KEYED skips the `minChars` block entirely (do not copy it into this branch).

- [ ] **Step 4: Run the whole suite**

Run: `node --test tests/`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add hooks/stop-gate.cjs tests/stop-gate.test.js
git commit -m "Teach the stop gate keyed and stayed ends with streak and ledger accounting"
```

---

### Task 5: Pure key logic module

**Files:**
- Create: `server/logic.mjs`
- Test: `tests/logic.test.js` (new)

**Interfaces:**
- Produces (exact signatures, consumed by Task 6):

```js
export const FAST_PREFIXES = ['what they are doing right now', 'what they have not seen', 'still open'];
export function isFast(header)                                  // boolean, case-insensitive prefix
export function computeReasons({ entries, seedFileHash, fileHash, fileBytes, turn, cfg, snoozes })
// entries: [{changed, affirmed, hash, header}] · cfg: {freshAt, pruneAt, setupKey}
// snoozes: [{expiry, reason}] · returns [{kind:'setup', baseline}|{kind:'fresh', header, baseline}|{kind:'prune', baseline}]
export function verifyReturn({ reasons, entries, fileHash, fileBytes, affirm, pruneAt })
// returns {pass, failures: [reason-text...], affirmed: [header...]}
export function renderAges(text, entries, turn)                 // header lines gain " (changed turn N, M ago[; affirmed turn A])"
```

- [ ] **Step 1: Write the failing tests**

```js
// tests/logic.test.js
import assert from "node:assert/strict";
import test from "node:test";
import { computeReasons, verifyReturn, renderAges, isFast } from "../server/logic.mjs";

const cfg = { freshAt: 6, pruneAt: 5000, setupKey: true };
const e = (header, changed, hash, affirmed = null) => ({ header, changed: String(changed), hash, affirmed });

test("virgin file yields a setup reason and suppresses fresh", () => {
  const entries = [e("What they are doing right now", 0, "aaa"), e("What they have not seen", 0, "bbb")];
  const r = computeReasons({ entries, seedFileHash: "F0", fileHash: "F0", fileBytes: 900, turn: 9, cfg, snoozes: [] });
  assert.deepEqual(r.map(x => x.kind), ["setup"]);
});

test("a fast section older than freshAt yields fresh; affirmation counts as touch", () => {
  const entries = [e("What they are doing right now", 1, "aaa"), e("What they have not seen", 1, "bbb", "8")];
  const r = computeReasons({ entries, seedFileHash: "F0", fileHash: "F1", fileBytes: 900, turn: 10, cfg, snoozes: [] });
  assert.deepEqual(r, [{ kind: "fresh", header: "What they are doing right now", baseline: "aaa" }]);
});

test("prune fires over the limit and respects a snooze", () => {
  const entries = [e("What they are doing right now", 9, "aaa")];
  const over = { entries, seedFileHash: "F0", fileHash: "F1", fileBytes: 5100, turn: 10, cfg };
  assert.deepEqual(computeReasons({ ...over, snoozes: [] }).map(x => x.kind), ["prune"]);
  assert.deepEqual(computeReasons({ ...over, snoozes: [{ expiry: 14, reason: "prune" }] }), []);
});

test("verifyReturn: setup passes on any whole-file change; fresh by hash move or affirm; prune strictly", () => {
  const reasons = [{ kind: "setup", baseline: "F0" },
                   { kind: "fresh", header: "What they have not seen", baseline: "bbb" },
                   { kind: "prune", baseline: 5100 }];
  const entries = [e("What they have not seen", 3, "bbb")];
  const fail = verifyReturn({ reasons, entries, fileHash: "F0", fileBytes: 5100, affirm: [], pruneAt: 5000 });
  assert.equal(fail.pass, false);
  assert.equal(fail.failures.length, 3);
  const ok = verifyReturn({ reasons, entries, fileHash: "F9", fileBytes: 4400,
                            affirm: ["What they have not seen"], pruneAt: 5000 });
  assert.equal(ok.pass, true);
  assert.deepEqual(ok.affirmed, ["What they have not seen"]);
});

test("renderAges annotates headers as tuples", () => {
  const text = "## What they are doing right now\nbody\n";
  const out = renderAges(text, [e("What they are doing right now", 3, "aaa", "7")], 9);
  assert.match(out, /^## What they are doing right now \(changed turn 3, 6 ago; affirmed turn 7\)$/m);
});

test("isFast matches by case-insensitive prefix", () => {
  assert.ok(isFast("Still open — asked, not delivered"));
  assert.ok(!isFast("Their words"));
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test tests/logic.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement server/logic.mjs**

```js
// Pure decisions for the keyed door. No fs, no env — callers pass everything in.
export const FAST_PREFIXES = ['what they are doing right now', 'what they have not seen', 'still open'];

export function isFast(header) {
  const h = (header || '').toLowerCase();
  return FAST_PREFIXES.some(p => h.startsWith(p));
}

function snoozed(snoozes, reason, turn) {
  return snoozes.some(s => s.reason === reason && Number(s.expiry) > turn);
}

export function computeReasons({ entries, seedFileHash, fileHash, fileBytes, turn, cfg, snoozes }) {
  const reasons = [];
  if (cfg.setupKey && seedFileHash && fileHash === seedFileHash && !snoozed(snoozes, 'setup', turn)) {
    reasons.push({ kind: 'setup', baseline: fileHash });
    return reasons; // a virgin room owes setup before anything else; fresh would be noise
  }
  for (const e of entries) {
    if (!isFast(e.header)) continue;
    const touch = Math.max(Number(e.changed) || 0, Number(e.affirmed) || 0);
    if (turn - touch > cfg.freshAt && !snoozed(snoozes, `fresh ${e.header}`, turn))
      reasons.push({ kind: 'fresh', header: e.header, baseline: e.hash });
  }
  if (fileBytes > cfg.pruneAt && !snoozed(snoozes, 'prune', turn))
    reasons.push({ kind: 'prune', baseline: fileBytes });
  return reasons;
}

export function verifyReturn({ reasons, entries, fileHash, fileBytes, affirm, pruneAt }) {
  const failures = [], affirmed = [];
  for (const r of reasons) {
    if (r.kind === 'setup') {
      if (fileHash === r.baseline) failures.push('setup: the file has not changed at all');
    } else if (r.kind === 'fresh') {
      const e = entries.find(x => x.header === r.header);
      const moved = e && e.hash !== r.baseline && e.hash !== 'gone';
      const aff = (affirm || []).includes(r.header);
      if (aff) affirmed.push(r.header);
      if (!moved && !aff) failures.push(`fresh: "${r.header}" neither changed nor affirmed`);
    } else if (r.kind === 'prune') {
      if (fileBytes >= pruneAt) failures.push(`prune: still ${fileBytes} bytes, limit ${pruneAt}`);
    }
  }
  return { pass: failures.length === 0, failures, affirmed };
}

export function renderAges(text, entries, turn) {
  return text.split('\n').map(line => {
    if (!line.startsWith('## ')) return line;
    const e = entries.find(x => x.header === line.slice(3).trim());
    if (!e || e.hash === 'gone') return line;
    const changed = Number(e.changed) || 0;
    const aff = e.affirmed ? `; affirmed turn ${e.affirmed}` : '';
    return `${line} (changed turn ${changed}, ${turn - changed} ago${aff})`;
  }).join('\n');
}
```

- [ ] **Step 4: Run the whole suite**

Run: `node --test tests/`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add server/logic.mjs tests/logic.test.js
git commit -m "Add the pure key-decision module"
```

---

### Task 6: The server issues, re-presents, and verifies keys; stay lands

**Files:**
- Modify: `server/index.js`
- Modify: `docs/superpowers/specs/2026-08-18-keyed-door-design.md` (carry back the whole-file setup refinement)
- Test: `tests/logic.test.js` (extend with the state-transition helpers) — plus a manual stdio smoke check

**Interfaces:**
- Consumes: everything above. Produces the full tool behavior of spec §6, with §6b copy.

- [ ] **Step 1: Extend the schema and description in server/index.js**

Import at top: `import { computeReasons, verifyReturn, renderAges } from "./logic.mjs";` and `import { randomBytes } from "node:crypto";`

Replace the `inputSchema` with:

```js
    inputSchema: {
      note: z.string().optional().describe(
        "What you are about to carry into their room, in a sentence. " +
        "Nothing stores it and nothing reads it — writing it is the point."),
      key: z.string().optional().describe(
        "Return the nonce from a keyed door call after doing what its reasons ask. " +
        "A bare call without it just shows you the key again — that is not a fumble."),
      affirm: z.array(z.string()).optional().describe(
        "Section headers you re-read just now and checked are still current. " +
        "Answers freshness only; never answers pruning."),
      stay: z.boolean().optional().describe(
        "End this turn in your room — nothing enters theirs but a one-line marker. " +
        "Legal, counted; waiting is not a failure. Use note for the marker text."),
    },
```

- [ ] **Step 2: Implement the handler flow**

Inside the tool handler, after `resolveSessionId()`, in order (each block wrapped in the codebase's usual try/catch tolerance):

```js
    // Files
    const stateFile = join(BASE, `${sessionId}.state`);
    const seedFile = join(BASE, `${sessionId}.seed`);
    const keyFile = join(BASE, `${sessionId}.key`);
    const snoozeFile = join(BASE, `${sessionId}.snooze`);
    const ledgerFile = join(BASE, `${sessionId}.ledger`);

    // 1. Stay short-circuits everything: stamp, note, return.
    if (args.stay) {
      writeFileSync(join(BASE, `${sessionId}.gate`), "STAYED");   // carries turn via openGate-style read
      if (args.note) writeFileSync(join(BASE, `${sessionId}.staynote`), args.note.slice(0, 200));
      if (existsSync(keyFile)) appendLedger(ledgerFile, count, 'stayed-keyed', null, readReasonLines(keyFile).join('; '));
      return text("Stayed in. The marker is all they will see this turn. The room keeps counting.");
    }

    // 2. Load stats.
    const { entries } = parseStateV2(readFileSync(stateFile, 'utf8'));      // parser from Task 2, ESM copy
    const seedFileHash = firstLine(seedFile);
    const fileBytes = statSync(orientFile).size;
    const cfg = { freshAt: num('CLAUDE_ORIENTATION_FRESH_AT', 6),
                  pruneAt: num('CLAUDE_ORIENTATION_PRUNE_AT', 5000),
                  setupKey: !['0','off','false','no'].includes(process.env.CLAUDE_ORIENTATION_SETUP_KEY || '') };
    const snoozes = readSnoozes(snoozeFile);

    // 3. Outstanding same-turn key?
    const held = readKeyFile(keyFile);                                       // {nonce, turn, attempts, reasons} | null
    const sameTurn = held && held.turn === String(count);

    if (sameTurn && args.key === held.nonce) {
      // A RETURN: verify.
      const verdict = verifyReturn({ reasons: held.reasons, entries, fileHash: nowHash,
                                     fileBytes, affirm: args.affirm, pruneAt: cfg.pruneAt });
      if (verdict.pass) {
        unlinkSync(keyFile); openGate(sessionId);
        for (const h of verdict.affirmed) { markAffirmed(stateFile, h, count); appendLedger(ledgerFile, count, 'affirmed', null, h); }
        appendLedger(ledgerFile, count, 'satisfied', byteDelta(held, fileBytes), reasonText(held.reasons));
        return text(orientationWithAges + statsBlock + "\nKey returned. The door is open — say the thing, once, addressed to them.");
      }
      held.attempts += 1;
      if (held.attempts >= num('CLAUDE_ORIENTATION_STOP_MAX_RERUNS', 2)) {
        unlinkSync(keyFile); openGate(sessionId);
        writeSnoozes(snoozeFile, held.reasons, count + num('CLAUDE_ORIENTATION_SNOOZE', 6));
        appendLedger(ledgerFile, count, 'stood-down', null, reasonText(held.reasons));
        appendLedger(ledgerFile, count, 'snoozed', null, reasonText(held.reasons));
        return text(orientationWithAges + statsBlock + "\nStand-down: the door opens anyway; the miss is on the record and this reason will not re-fire for a few turns. Go ahead.");
      }
      writeKeyFile(keyFile, held);
      appendLedger(ledgerFile, count, 'fumbled', null, verdict.failures.join('; '));
      return text(keyBlock(held, verdict.failures));                          // reasons restated WITH the nonce
    }

    if (sameTurn) {
      // Bare re-call (or wrong nonce): re-present, attempts unchanged.
      return text(orientationWithAges + statsBlock + keyBlock(held));
    }

    // 4. No live key: compute fresh reasons.
    const reasons = computeReasons({ entries, seedFileHash, fileHash: nowHash, fileBytes,
                                     turn: count, cfg, snoozes });
    if (reasons.length === 0) {
      openGate(sessionId);
      return text(orientationWithAges + statsBlock + recheckLine);            // today's shape
    }
    const issued = { nonce: randomBytes(16).toString('hex'), turn: String(count), attempts: 0, reasons };
    writeKeyFile(keyFile, issued);
    writeGate(sessionId, 'KEYED');
    appendLedger(ledgerFile, count, 'issued', null, reasonText(reasons));
    return text(orientationWithAges + statsBlock + keyBlock(issued));
```

With `keyBlock` producing the §6b copy:

```js
function keyBlock(k, failures) {
  const what = k.reasons.map(r =>
    r.kind === 'setup' ? '- setup: the room is still the seeded template. Write what you know of them from this conversation — writing the gap ("what I do not know yet") counts fully.' :
    r.kind === 'fresh' ? `- fresh: "${r.header}" has not been touched in a while. Update it, or affirm it if you re-read it just now and it still holds.` :
    `- prune: the file is ${r.baseline} bytes; it must land under the limit. Drop how things got decided, keep what is still live.`).join('\n');
  return `\n\nTHE DOOR IS KEYED — the room asks for upkeep before entry.\n${what}\n` +
    (failures ? `\nNot yet satisfied: ${failures.join('; ')}\n` : '') +
    `\nWhen done, call read_the_room again with key: "${k.nonce}"` +
    ` (and affirm: [...] for anything you re-checked). Any real change counts. A bare call just shows this again.`;
}
```

Also in this task: change the existing `Size: ${size} characters` line to `Size: ${size} bytes`, read PRUNE_AT from env for it, and fix the spec's §6 to record the whole-file setup-satisfaction refinement (edit the spec's setup bullet to "setup — the file's hash moved at all since issue").

- [ ] **Step 3: Add the transition tests (extend tests/logic.test.js) and smoke the server**

The fs-touching flow is exercised through the hooks tests already; for the server add one stdio smoke test manually:

Run: `printf '' | node server/index.js &` then a scripted `tools/call` with no orientation file, with a virgin file (expect keyBlock with setup), and with `stay: true` (expect STAYED gate on disk). Kill the server. If the repo later grows an MCP test client, promote this to a test file — for now record the three observed outputs in the PR/commit message.

- [ ] **Step 4: Run the whole suite**

Run: `node --test tests/`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add server/index.js server/logic.mjs docs/superpowers/specs/2026-08-18-keyed-door-design.md
git commit -m "Issue, re-present, and verify keys at the door; stays land as a gate state"
```

---

### Task 7: Template repair and the positive doc opening

**Files:**
- Modify: `docs/orientation-template.txt`, `docs/orientation.md`, `docs/orientation-brief.md`
- Test: `tests/session-start.test.js` (update header assertions)

**Interfaces:**
- Produces: the four template edits of spec §9 and the opening block of §10. The fast-set PREFIXES in `server/logic.mjs` (Task 5) already match the renamed header.

- [ ] **Step 1: Update the template**

In `docs/orientation-template.txt`: (a) retitle section `## What they asked for that has not been delivered` → `## Still open — asked, not delivered` (keep its comment lines); (b) under the title line at the top add:

```
# Mark provenance: [SAID] for their words and decisions, [INFERRED] for
# your hypotheses. Never launder an inference into a fact.
# Project state, task lists, and bug tracking do not live here — only
# where THEY stand.
```

(c) directly under each of the three fast headers (`What they are doing right now`, `What they have not seen`, `Still open — asked, not delivered`) add the line:

```
# fast — watched for freshness; keep this one current first
```

- [ ] **Step 2: Add the opening block to both docs**

At the very top of `docs/orientation.md` (below the title/reader-note, above "## Why this exists") and mirrored in compressed form at the top of `docs/orientation-brief.md`:

```markdown
## First, before the work

Your workspace is yours at any length — everything you write before
crossing stays out of their way, and nobody has to see it. The room
file (path at the bottom of this document) is where you keep what you
know of them. On your first turn, write what you already know from
their first message — writing the gap, "what I do not know yet",
counts fully — then cross through `read_the_room` before you first
speak. The door has a few rules that fire on their own; entering well
is how trust gets built from turn one.
```

- [ ] **Step 3: Update the session-start test's header regexes**

In `tests/session-start.test.js` the assertions reference `## What they asked for` and others — add one for the renamed header:

```js
  assert.match(orientation, /^## Still open — asked, not delivered$/m);
```

- [ ] **Step 4: Run the whole suite**

Run: `node --test tests/`
Expected: all PASS (Task 1/2 sidecar tests are header-agnostic except the fast-prefix logic test, which already targets the new name).

- [ ] **Step 5: Commit**

```bash
git add docs/orientation-template.txt docs/orientation.md docs/orientation-brief.md tests/session-start.test.js
git commit -m "Repair the template to match observed use and open the docs with the gift framing"
```

---

### Task 8: Cleanup — SessionEnd hook and the mtime sweep

**Files:**
- Create: `hooks/session-end.cjs`
- Modify: `hooks/hooks.json`, `hooks/reinject.cjs`
- Test: `tests/cleanup.test.js` (new)

**Interfaces:**
- Produces: SessionEnd removes the ending session's state files (all `<sid>.*` under the base dir, never the orientation docs dir). reinject sweeps any session file older than 14 days (mtime), extending its existing msg/ sweep. Empirical rider: run one manual `kill -9` session and note in `.tasks.md` whether SessionEnd fired (spec §13 flags it undocumented).

- [ ] **Step 1: Write the failing tests**

```js
// tests/cleanup.test.js
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

test("session-end removes the ending session's files and nothing else", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "rtr-clean-"));
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const temp = join(sandbox, "tmp");
  const base = join(temp, "claude-orientation");
  mkdirSync(base, { recursive: true });
  for (const f of ["gone.orientation.txt", "gone.state", "gone.gate", "keep.state"])
    writeFileSync(join(base, f), "x");
  const r = spawnSync(process.execPath, [join(pluginRoot, "hooks", "session-end.cjs")], {
    cwd: pluginRoot, env: { ...process.env, TMPDIR: temp },
    input: JSON.stringify({ session_id: "gone", reason: "clear" }), encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(join(base, "gone.state")));
  assert.ok(!existsSync(join(base, "gone.orientation.txt")));
  assert.ok(existsSync(join(base, "keep.state")));
});

test("reinject sweeps session files older than 14 days", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "rtr-sweep-"));
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const temp = join(sandbox, "tmp");
  const base = join(temp, "claude-orientation");
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "old.state"), "x");
  const past = new Date(Date.now() - 15 * 24 * 3600 * 1000);
  utimesSync(join(base, "old.state"), past, past);
  writeFileSync(join(base, "fresh.state"), "x");
  spawnSync(process.execPath, [join(pluginRoot, "hooks", "reinject.cjs")], {
    cwd: pluginRoot, env: { ...process.env, TMPDIR: temp },
    input: JSON.stringify({ session_id: "live" }), encoding: "utf8",
  });
  assert.ok(!existsSync(join(base, "old.state")));
  assert.ok(existsSync(join(base, "fresh.state")));
});
```

- [ ] **Step 2: Run, verify both fail**

Run: `node --test tests/cleanup.test.js`
Expected: FAIL — no session-end.cjs; no sweep.

- [ ] **Step 3: Implement**

`hooks/session-end.cjs` (same stdin/JSON scaffold as every hook — copy the `jqStr` + stdin harness from stop-gate.cjs):

```js
function run(raw) {
  let input; try { input = JSON.parse(raw); } catch { input = {}; }
  if (typeof input !== 'object' || input === null) input = {};
  const sessionId = jqStr(input.session_id, '');
  if (!sessionId || !/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId.includes('..')) return;
  const base = path.join(os.tmpdir(), 'claude-orientation');
  let names = []; try { names = fs.readdirSync(base); } catch { return; }
  for (const name of names)
    if (name.startsWith(`${sessionId}.`)) { try { fs.unlinkSync(path.join(base, name)); } catch {} }
}
```

`hooks/hooks.json` — add alongside the existing entries:

```json
    "SessionEnd": [
      { "hooks": [ { "type": "command", "command": "node",
          "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/session-end.cjs"] } ] }
    ]
```

`hooks/reinject.cjs` — extend the existing msg-sweep block with a sibling sweep of `base` itself (14-day cutoff, files only, skip the `msg` dir):

```js
  try {
    const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
    for (const name of fs.readdirSync(base)) {
      const p = path.join(base, name);
      try { const st = fs.statSync(p);
        if (st.isFile() && st.mtimeMs < cutoff) fs.unlinkSync(p); } catch {}
    }
  } catch {}
```

- [ ] **Step 4: Run the whole suite**

Run: `node --test tests/`
Expected: all PASS.

- [ ] **Step 5: Commit, then do the manual kill -9 check and record it**

```bash
git add hooks/session-end.cjs hooks/hooks.json hooks/reinject.cjs tests/cleanup.test.js
git commit -m "Clean up session state on session end with a fourteen-day sweep as crash cover"
```

Manual: open a scratch `claude` session with the plugin, `kill -9` its pid, check whether the session's files were removed. Append the observed answer to `.tasks.md`.

---

### Task 9: Ship docs

**Files:**
- Modify: `README.md`, `how-it-works.md`

**Interfaces:** none — prose only, but factual claims must match the code as built in Tasks 1–8.

- [ ] **Step 1: how-it-works.md** — update the turn diagram with the KEYED branch (door → keyed → update/affirm → key return → open) and the STAYED end; add a "The key" section stating: the three reasons, any-real-change satisfaction (setup is whole-file), strict pruning, stand-down after 2 with a snooze, stays legal/counted/capped; update the configuration section with the new env vars and the CHANGED defaults (150/100/5000-strict labeled as deliberate pressure-experiment values, was 400/180/6000-advisory); note the reinject nudges are gone.
- [ ] **Step 2: README.md** — one new bullet in "What it does" for the key ("the door can ask for upkeep before it opens — content-blind: it checks that things changed, never what they say") and one for stays; update "What it doesn't do" ("it still never reads or judges what the file says").
- [ ] **Step 3: Verify claims against code** — grep each number stated in the docs against the source defaults.

Run: `node --test tests/` one more time.

- [ ] **Step 4: Commit**

```bash
git add README.md how-it-works.md
git commit -m "Document the keyed door, stays, and the new defaults"
```

---

### Task 10: Negative control and final verification

**Files:** none new.

- [ ] **Step 1: Negative control** — `git stash` the working tree at the pre-Task-1 commit in a scratch worktree (`git worktree add ../rtr-negative <pre-task-1-sha>`), copy `tests/` from the branch over it, run `node --test tests/`. Expected: the NEW tests fail there (proving the suite discriminates); the two original session-start tests pass. Record the counts in the final commit message. Remove the worktree.
- [ ] **Step 2: Full suite on the branch** — `node --test tests/` → all pass.
- [ ] **Step 3: Live smoke** — one real session in a scratch dir with the plugin loaded: confirm (a) setup key on first door call of a fresh session, (b) normal one-call shape after upkeep, (c) `stay: true` produces the marker, (d) prune key at >5000 bytes. These four were all previously untestable-by-unit means.
- [ ] **Step 4: Final commit**

```bash
git add -u
git commit -m "Verify the keyed door round with a negative control and live smoke"
```

---

## Self-review (run after writing — done once, results here)

- **Spec coverage:** §4 state machine → T3/T4/T6; §5 formats → T1/T2/T6; §6 tool → T6; §6b copy → T3 (marker), T4 (nudge), T6 (describes + keyBlock); §7 → T1–T6; §8 numbers → T3/T4/T6 defaults + docs T9; §9 template → T7; §10 opening → T7; §11 edges → T2 (interrupt), T6 (re-present/snooze/stand-down), T8 (crash sweep); §12 migration → T2 (lazy sidecar seed on absent state comes free: parseStateV2 of a v1 file yields entries=[], so every section stamps as changed-now — exactly the spec'd cold-start); §13 tests → spread across T1–T8 + T10 negative control; §14 riders → T1 (atomic write), T8 (cleanup); §15/§16 → untouched, as decided.
- **Placeholder scan:** clean — every step has runnable content or an exact edit location.
- **Type consistency:** `splitSections/renderStateV2/parseStateV2/writeAtomic` identical shapes in T1/T2 (CJS) and referenced from T6 (ESM copies live in logic.mjs's caller, same shapes); `computeReasons/verifyReturn/renderAges` signatures match between T5 definition and T6 use; `.key`/`.ledger`/`.snooze` line formats match between T4 (reader) and T6 (writer).
- **Assumed-settled:** STAY_CAP=3 / SNOOZE=6 (proposed in review, "looks good" taken as assent); one-back retention stays out (§16 flag untaken).
