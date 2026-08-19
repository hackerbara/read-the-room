// tests/door.test.js — server flow, exercised over real stdio via the MCP
// SDK's Client + StdioClientTransport, same TMPDIR-sandboxing convention as
// the hook tests. Session resolution is pinned with CLAUDE_CODE_SESSION_ID
// plus a pre-seeded `<sid>.orientation.txt`; resolveSessionId() trusts that
// combination directly (server/index.js's "No state of our own" fallback
// still returns it even when hasState() is false, which is what lets the
// missing-orientation-file stay test below skip seeding a file at all).
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

function splitSections(text) {
  const out = [];
  let cur = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) { if (cur) out.push(cur); cur = { header: line.slice(3).trim(), body: [] }; }
    else if (cur) cur.body.push(line);
  }
  if (cur) out.push(cur);
  return out.map((s) => ({ header: s.header, hash: sha256(s.body.join("\n")) }));
}

function renderStateV2(turn, fileHash, entries) {
  return [`${turn} ${fileHash}`,
    ...entries.map((e) => `${e.changed} ${e.affirmed || "-"} ${e.hash} ${e.header}`)].join("\n") + "\n";
}

// Seeds a session's on-disk files the way session-start.cjs + reinject.cjs
// would have left them by the time the door is called: orientation file,
// turn counter, a CLOSED gate at that turn, the state v2 sidecar, and the
// seed file. `seedText` is what session-start originally wrote (what setup
// compares against); `currentText` (default: same as seedText, i.e. a
// virgin file) is what's on disk now. `changedAt` stamps every section the
// same; `changedAtBySection` (parallel array, same order as `## ` headers
// appear in `currentText`) overrides it per section, for fixtures where
// only some fast sections are meant to be stale.
function seedSession(base, sid, { seedText, currentText, turn, changedAt = 0, changedAtBySection }) {
  currentText = currentText ?? seedText;
  const orientPath = join(base, `${sid}.orientation.txt`);
  writeFileSync(orientPath, currentText);

  const curHash = sha256(currentText);
  const curSections = splitSections(currentText);
  const entries = curSections.map((s, i) => ({
    changed: String(changedAtBySection ? changedAtBySection[i] : changedAt),
    affirmed: null, hash: s.hash, header: s.header,
  }));
  writeFileSync(join(base, `${sid}.state`), renderStateV2(String(changedAt), curHash, entries));

  const seedHash = sha256(seedText);
  const seedSections = splitSections(seedText);
  writeFileSync(join(base, `${sid}.seed`),
    [seedHash, ...seedSections.map((s) => `${s.hash} ${s.header}`)].join("\n") + "\n");

  writeFileSync(join(base, `${sid}.turns`), String(turn));
  writeFileSync(join(base, `${sid}.gate`), `CLOSED ${turn}`);
  return { orientPath };
}

function sandbox(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const temp = join(dir, "tmp");
  const base = join(temp, "claude-orientation");
  mkdirSync(base, { recursive: true });
  return { dir, temp, base };
}

function startClient(temp, sessionId, extraEnv = {}, host = "claude") {
  const entry = process.env.DOOR_SERVER_ENTRY || join(pluginRoot, "server", "index.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, "--host", host],
    cwd: pluginRoot,
    env: { ...process.env, TMPDIR: temp, CLAUDE_CODE_SESSION_ID: sessionId, ...extraEnv },
    stderr: "pipe",
  });
  const client = new Client({ name: "door-test-client", version: "1.0.0" });
  return { client, transport };
}

async function call(client, args = {}) {
  const res = await client.callTool({ name: "read_the_room", arguments: args });
  return res.content[0].text;
}

const TEMPLATE = "## What they are doing right now\nfoo\n## What they have not seen\nbar\n";

function seedClaudeDisplayState(base, sid, turn) {
  writeFileSync(join(base, `${sid}.workspace`), `${turn} 37`);
  writeFileSync(join(base, `${sid}.unseen`), String(turn - 1));
}

function assertNoClaudeDisplayClaims(response) {
  assert.doesNotMatch(response, /Workspace this turn:/);
  assert.doesNotMatch(response, /replaced with the marker/i);
  assert.doesNotMatch(response, /They saw one line/i);
}

test("live MCP descriptions state each host's real display and stay contract", async () => {
  for (const host of ["claude", "codex"]) {
    const { dir, temp } = sandbox(`rtr-door-description-${host}-`);
    const { client, transport } = startClient(temp, `description-${host}`, {}, host);
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const tool = listed.tools.find((candidate) => candidate.name === "read_the_room");
      assert.ok(tool);
      const stay = tool.inputSchema.properties.stay.description;
      if (host === "codex") {
        assert.match(tool.description, /ordinary assistant language streams visibly/i);
        assert.match(tool.description, /client may later group completed\s+work/i);
        assert.match(tool.description, /opens the door when nothing is due/i);
        assert.match(tool.description, /presents a key that must be returned/i);
        assert.doesNotMatch(tool.description, /returns the standing orientation[\s\S]*and opens the current turn's door/i);
        assert.doesNotMatch(tool.description, /display keeps it out of their way/i);
        assert.match(stay, /streamed workspace remains visible/i);
        assert.match(stay, /no new addressed reply/i);
        assert.doesNotMatch(stay, /one-line marker/i);
      } else {
        assert.match(tool.description, /display keeps it out of their way/i);
        assert.match(stay, /nothing enters theirs but a one-line marker/i);
      }
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("Codex response matrix omits Claude display state while preserving keyed transitions", async () => {
  const missing = sandbox("rtr-door-codex-missing-");
  const missingClient = startClient(missing.temp, "codex-missing", {}, "codex");
  try {
    await missingClient.client.connect(missingClient.transport);
    assertNoClaudeDisplayClaims(await call(missingClient.client));
  } finally {
    await missingClient.client.close();
    rmSync(missing.dir, { recursive: true, force: true });
  }

  const clean = sandbox("rtr-door-codex-clean-");
  const cleanSid = "codex-clean";
  seedSession(clean.base, cleanSid, {
    seedText: TEMPLATE,
    currentText: TEMPLATE.replace("foo", "a live fact"),
    turn: 5,
    changedAt: 4,
  });
  seedClaudeDisplayState(clean.base, cleanSid, 5);
  const cleanClient = startClient(clean.temp, cleanSid, {}, "codex");
  try {
    await cleanClient.client.connect(cleanClient.transport);
    assertNoClaudeDisplayClaims(await call(cleanClient.client));
    assert.equal(readFileSync(join(clean.base, `${cleanSid}.gate`), "utf8"), "OPEN 5");
    assert.ok(existsSync(join(clean.base, `${cleanSid}.unseen`)), "Codex must not consume Claude unseen state");
  } finally {
    await cleanClient.client.close();
    rmSync(clean.dir, { recursive: true, force: true });
  }

  const keyed = sandbox("rtr-door-codex-keyed-");
  const keyedSid = "codex-keyed";
  const { orientPath } = seedSession(keyed.base, keyedSid, { seedText: TEMPLATE, turn: 1 });
  seedClaudeDisplayState(keyed.base, keyedSid, 1);
  const keyedClient = startClient(keyed.temp, keyedSid, {}, "codex");
  try {
    await keyedClient.client.connect(keyedClient.transport);
    const issued = await call(keyedClient.client);
    assertNoClaudeDisplayClaims(issued);
    assert.match(issued, /THE DOOR IS KEYED/);
    const nonce = readFileSync(join(keyed.base, `${keyedSid}.key`), "utf8").split(/\s+/)[0];
    assertNoClaudeDisplayClaims(await call(keyedClient.client));
    assertNoClaudeDisplayClaims(await call(keyedClient.client, { key: nonce }));
    appendFileSync(orientPath, "\nA fact learned in this turn.\n");
    const returned = await call(keyedClient.client, { key: nonce });
    assertNoClaudeDisplayClaims(returned);
    assert.match(returned, /Key returned\. The door is open/);
    assert.equal(readFileSync(join(keyed.base, `${keyedSid}.gate`), "utf8"), "OPEN 1");
    assert.match(readFileSync(join(keyed.base, `${keyedSid}.ledger`), "utf8"), /^1 satisfied /m);
  } finally {
    await keyedClient.client.close();
    rmSync(keyed.dir, { recursive: true, force: true });
  }

  const stoodDown = sandbox("rtr-door-codex-standdown-");
  const stoodDownSid = "codex-standdown";
  seedSession(stoodDown.base, stoodDownSid, { seedText: TEMPLATE, turn: 1 });
  seedClaudeDisplayState(stoodDown.base, stoodDownSid, 1);
  const stoodDownClient = startClient(stoodDown.temp, stoodDownSid, {}, "codex");
  try {
    await stoodDownClient.client.connect(stoodDownClient.transport);
    assertNoClaudeDisplayClaims(await call(stoodDownClient.client));
    const nonce = readFileSync(join(stoodDown.base, `${stoodDownSid}.key`), "utf8").split(/\s+/)[0];
    assertNoClaudeDisplayClaims(await call(stoodDownClient.client, { key: nonce }));
    const response = await call(stoodDownClient.client, { key: nonce });
    assertNoClaudeDisplayClaims(response);
    assert.match(response, /Stand-down:/);
  } finally {
    await stoodDownClient.client.close();
    rmSync(stoodDown.dir, { recursive: true, force: true });
  }
});

test("Codex stay leaves any key outstanding and describes the visible streamed workspace", async () => {
  for (const keyed of [false, true]) {
    const { dir, temp, base } = sandbox(`rtr-door-codex-stay-${keyed}-`);
    const sid = `codex-stay-${keyed}`;
    seedSession(base, sid, { seedText: TEMPLATE, turn: 3 });
    if (keyed) writeFileSync(join(base, `${sid}.key`), "nonce 3 0\nsetup baseline\n");
    const { client, transport } = startClient(temp, sid, {}, "codex");
    try {
      await client.connect(transport);
      const response = await call(client, { stay: true, note: "waiting" });
      assert.equal(response, "Stayed in. The streamed workspace remains visible; no new addressed reply is produced. The room keeps counting.");
      assertNoClaudeDisplayClaims(response);
      assert.equal(existsSync(join(base, `${sid}.key`)), keyed);
      if (keyed) assert.match(readFileSync(join(base, `${sid}.ledger`), "utf8"), /^3 stayed-keyed /m);
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("Claude response matrix retains workspace and unseen presentation on full responses", async () => {
  for (const scenario of ["clean", "issued", "replay", "success", "stand-down"]) {
    const { dir, temp, base } = sandbox(`rtr-door-claude-${scenario}-`);
    const sid = `claude-${scenario}`;
    const clean = scenario === "clean";
    const { orientPath } = seedSession(base, sid, {
      seedText: TEMPLATE,
      currentText: clean ? TEMPLATE.replace("foo", "a live fact") : undefined,
      turn: 1,
      changedAt: clean ? 1 : 0,
    });
    seedClaudeDisplayState(base, sid, 1);
    const { client, transport } = startClient(temp, sid);
    try {
      await client.connect(transport);
      let response;
      if (scenario === "clean" || scenario === "issued") {
        response = await call(client);
      } else {
        await call(client);
        const nonce = readFileSync(join(base, `${sid}.key`), "utf8").split(/\s+/)[0];
        seedClaudeDisplayState(base, sid, 1);
        if (scenario === "replay") response = await call(client);
        if (scenario === "success") {
          appendFileSync(orientPath, "\nA fact learned in this turn.\n");
          response = await call(client, { key: nonce });
        }
        if (scenario === "stand-down") {
          await call(client, { key: nonce });
          seedClaudeDisplayState(base, sid, 1);
          response = await call(client, { key: nonce });
        }
      }
      assert.match(response, /Workspace this turn: 37 characters\./);
      assert.match(response, /replaced with the marker/i);
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("virgin file issues a setup key; a bare re-call re-presents it unchanged; a real edit satisfies it", async () => {
  const { dir, temp, base } = sandbox("rtr-door-setup-");
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  const sid = "door-setup-session";
  const { orientPath } = seedSession(base, sid, { seedText: TEMPLATE, turn: 1 });

  const { client, transport } = startClient(temp, sid);
  test.after(() => client.close());
  await client.connect(transport);

  const first = await call(client);
  assert.match(first, /THE DOOR IS KEYED/);
  assert.match(first, /- setup: the room is still the seeded template/);
  assert.equal(readFileSync(join(base, `${sid}.gate`), "utf8"), "KEYED 1");
  const keyRaw1 = readFileSync(join(base, `${sid}.key`), "utf8");
  assert.match(keyRaw1, /^\S+ 1 0\nsetup /);
  const nonce = keyRaw1.split(/\s+/)[0];
  assert.match(readFileSync(join(base, `${sid}.ledger`), "utf8"), /^1 issued - setup /m);

  // Bare re-call: same nonce, attempts unchanged, no new ledger line.
  const second = await call(client);
  assert.match(second, /THE DOOR IS KEYED/);
  const keyRaw2 = readFileSync(join(base, `${sid}.key`), "utf8");
  assert.equal(keyRaw2, keyRaw1, "a bare re-call must not mutate the key file");
  assert.equal(
    readFileSync(join(base, `${sid}.ledger`), "utf8").trim().split("\n").length, 1,
    "a bare re-call must not append to the ledger",
  );

  // A real edit changes the whole-file hash — satisfies setup on return.
  appendFileSync(orientPath, "\nnew fact about them\n");
  const third = await call(client, { key: nonce });
  assert.match(third, /Key returned\. The door is open/);
  assert.ok(!existsSync(join(base, `${sid}.key`)), "the key file is deleted on a satisfied return");
  assert.equal(readFileSync(join(base, `${sid}.gate`), "utf8"), "OPEN 1");
  assert.match(readFileSync(join(base, `${sid}.ledger`), "utf8"), /^1 satisfied /m);
});

test("two failed returns stand the reason down: gate OPEN, key gone, snoozed, both events ledgered", async () => {
  const { dir, temp, base } = sandbox("rtr-door-standdown-");
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  const sid = "door-standdown-session";
  seedSession(base, sid, { seedText: TEMPLATE, turn: 1 });

  const { client, transport } = startClient(temp, sid);
  test.after(() => client.close());
  await client.connect(transport);

  await call(client); // issues the setup key
  const nonce = readFileSync(join(base, `${sid}.key`), "utf8").split(/\s+/)[0];

  // First failed return: file untouched, no affirm — setup cannot pass.
  const fumble = await call(client, { key: nonce });
  assert.match(fumble, /THE DOOR IS KEYED/);
  assert.match(fumble, /Not yet satisfied:/);
  assert.match(readFileSync(join(base, `${sid}.key`), "utf8"), /^\S+ 1 1\n/, "attempts should read 1 after one fumble");
  assert.match(readFileSync(join(base, `${sid}.ledger`), "utf8"), /^1 fumbled /m);

  // Second failed return: still untouched — stand-down.
  const standDown = await call(client, { key: nonce });
  assert.match(standDown, /Stand-down:/);
  assert.ok(!existsSync(join(base, `${sid}.key`)), "the key is deleted on a stand-down");
  assert.equal(readFileSync(join(base, `${sid}.gate`), "utf8"), "OPEN 1");
  const ledger = readFileSync(join(base, `${sid}.ledger`), "utf8");
  assert.match(ledger, /^1 stood-down /m);
  assert.match(ledger, /^1 snoozed /m);
  assert.match(readFileSync(join(base, `${sid}.snooze`), "utf8"), /^7 setup$/m); // turn 1 + default SNOOZE 6
});

test("a fresh reason is satisfied by a live same-turn edit to the named section, not just affirm", async () => {
  const { dir, temp, base } = sandbox("rtr-door-fresh-edit-");
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  const sid = "door-fresh-edit-session";
  const currentText = "## What they are doing right now\nworking on the deploy script\n## What they have not seen\nbar\n";
  // First section stale since turn 0 (due at turn 10, freshAt default 6);
  // second touched last turn (not due) — isolates the key to one reason.
  const { orientPath } = seedSession(base, sid, {
    seedText: TEMPLATE, currentText, turn: 10, changedAtBySection: [0, 9],
  });

  const { client, transport } = startClient(temp, sid);
  test.after(() => client.close());
  await client.connect(transport);

  const first = await call(client);
  assert.match(first, /- fresh: "What they are doing right now"/);
  assert.ok(!first.includes('"What they have not seen"'), "only the stale section should be keyed");
  const nonce = readFileSync(join(base, `${sid}.key`), "utf8").split(/\s+/)[0];

  // A real, same-turn edit to the named section — no affirm at all. Before
  // the fix, verifyReturn reused the turn-stale `.state` snapshot for this
  // check, so this edit could never register as "moved" and only `affirm`
  // could ever satisfy a fresh reason.
  writeFileSync(orientPath, currentText.replace(
    "working on the deploy script", "working on the deploy script and the release notes"));

  const res = await call(client, { key: nonce });
  assert.match(res, /Key returned\. The door is open/);
  // The edited section's age must render as changed THIS turn, not the
  // pre-edit turn 0 still sitting in `.state` — `.state` itself only
  // catches up on the next reinject pass.
  assert.match(res, /## What they are doing right now \(changed turn 10, 0 ago\)/);
  assert.ok(!existsSync(join(base, `${sid}.key`)), "the key file is deleted on a satisfied return");
  assert.equal(readFileSync(join(base, `${sid}.gate`), "utf8"), "OPEN 10");
  assert.match(readFileSync(join(base, `${sid}.ledger`), "utf8"), /^10 satisfied /m);
});

test("affirm alone (no edit) satisfies a fresh reason: sidecar stamped, ledgered, and shown in the same response", async () => {
  const { dir, temp, base } = sandbox("rtr-door-fresh-affirm-");
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  const sid = "door-fresh-affirm-session";
  const currentText = "## What they are doing right now\nworking on the deploy script\n## What they have not seen\nbar\n";
  seedSession(base, sid, { seedText: TEMPLATE, currentText, turn: 10, changedAtBySection: [0, 9] });

  const { client, transport } = startClient(temp, sid);
  test.after(() => client.close());
  await client.connect(transport);

  await call(client); // issues the fresh key for "What they are doing right now"
  const nonce = readFileSync(join(base, `${sid}.key`), "utf8").split(/\s+/)[0];

  const res = await call(client, { key: nonce, affirm: ["What they are doing right now"] });
  assert.match(res, /Key returned\. The door is open/);
  // The just-affirmed stamp must show in THIS response, not one door call
  // later — the age rendering has to be recomputed after the write-back.
  assert.match(res, /## What they are doing right now \(changed turn 0, 10 ago; affirmed turn 10\)/);
  assert.ok(!existsSync(join(base, `${sid}.key`)));
  assert.equal(readFileSync(join(base, `${sid}.gate`), "utf8"), "OPEN 10");

  const stateAfter = readFileSync(join(base, `${sid}.state`), "utf8");
  assert.match(stateAfter, /^0 10 \S+ What they are doing right now$/m, "sidecar gains the affirmed turn stamp");

  const ledger = readFileSync(join(base, `${sid}.ledger`), "utf8");
  assert.match(ledger, /^10 affirmed - What they are doing right now$/m);
  assert.match(ledger, /^10 satisfied /m);
});

test("stay lands as STAYED and writes the staynote, tolerating a missing orientation file", async () => {
  const { dir, temp, base } = sandbox("rtr-door-stay-");
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  const sid = "door-stay-session"; // deliberately: no orientation.txt, no turns, no gate seeded

  const { client, transport } = startClient(temp, sid);
  test.after(() => client.close());
  await client.connect(transport);

  const res = await call(client, { stay: true, note: "waiting on the retrieval agent" });
  assert.equal(res, "Stayed in. The marker is all they will see this turn. The room keeps counting.");
  assert.match(readFileSync(join(base, `${sid}.gate`), "utf8"), /^STAYED/);
  assert.equal(readFileSync(join(base, `${sid}.staynote`), "utf8"), "waiting on the retrieval agent");
});

test("stay ledgers stayed-keyed only for a key on disk that matches the current turn", async () => {
  const { dir, temp, base } = sandbox("rtr-door-stay-keyed-");
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  const sid = "door-stay-keyed-session";
  seedSession(base, sid, { seedText: TEMPLATE, turn: 5 });

  const { client, transport } = startClient(temp, sid);
  test.after(() => client.close());
  await client.connect(transport);

  // A current-turn key on disk: staying in must ledger stayed-keyed.
  writeFileSync(join(base, `${sid}.key`), "nonce1 5 0\nsetup deadbeef\n");
  await call(client, { stay: true });
  assert.match(readFileSync(join(base, `${sid}.ledger`), "utf8"), /^5 stayed-keyed - setup /m);

  // A stale-turn key (left over from an earlier, interrupted turn): staying
  // in must not ledger it — every other .key consumer checks turn-currency
  // and this branch used to be the exception.
  writeFileSync(join(base, `${sid}.key`), "nonce2 3 0\nsetup deadbeef\n");
  const before = readFileSync(join(base, `${sid}.ledger`), "utf8");
  await call(client, { stay: true });
  const after = readFileSync(join(base, `${sid}.ledger`), "utf8");
  assert.equal(after, before, "a stale-turn key must not produce a stayed-keyed line");
});

test("a clean, recently-touched file needs no key: gate opens, header ages are rendered", async () => {
  const { dir, temp, base } = sandbox("rtr-door-clean-");
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  const sid = "door-clean-session";
  const edited = "## What they are doing right now\nediting the deploy script\n## What they have not seen\nbar\n";
  seedSession(base, sid, { seedText: TEMPLATE, currentText: edited, turn: 5, changedAt: 3 });

  const { client, transport } = startClient(temp, sid);
  test.after(() => client.close());
  await client.connect(transport);

  const res = await call(client);
  assert.ok(!res.includes("THE DOOR IS KEYED"), "a clean file must not key the door");
  assert.match(res, /## What they are doing right now \(changed turn 3, 2 ago\)/);
  assert.equal(readFileSync(join(base, `${sid}.gate`), "utf8"), "OPEN 5");
});
