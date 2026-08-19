#!/usr/bin/env node
// Orientation door — MCP server exposing the `read_the_room` tool. Calling
// it opens this turn's gate, telling the Stop hook the user was consulted.
// The keyed door (spec 2026-08-18): defined neglect issues a key; returning
// it opens the door; staying ends the turn in the room, legally.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  readFileSync, writeFileSync, appendFileSync, existsSync, realpathSync,
  statSync, unlinkSync, renameSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeReasons, verifyReturn, renderAges } from "./logic.mjs";

const BASE = join((process.env.TMPDIR || tmpdir()).replace(/\/+$/, ""), "claude-orientation");

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Mirrors reinject.sh's `tr -cd '0-9'` parse of the turns file.
function readIntFile(path) {
  if (!existsSync(path)) return null;
  const digits = readFileSync(path, "utf8").replace(/[^0-9]/g, "");
  return digits.length ? parseInt(digits, 10) : null;
}

// Validates a filename-safe session id (guards path traversal via `..`).
function plausibleSessionId(id) {
  return typeof id === "string" && /^[A-Za-z0-9._-]+$/.test(id) && !id.includes("..");
}

function readPointer(path) {
  try {
    if (!existsSync(path)) return null;
    const id = readFileSync(path, "utf8").trim();
    return plausibleSessionId(id) ? id : null;
  } catch {
    return null;
  }
}

// Session resolution: this server keeps the CLAUDE_CODE_SESSION_ID it was
// spawned with, but hooks get a fresh one each call, and /clear changes it —
// so keying on our own id breaks after the first /clear. Concurrent sessions
// can also share a cwd, so cwd- or recency-based keys can collapse two
// sessions onto one. Fix: key the pointer on process.ppid, the pid of the
// `claude` CLI process that spawned this server — stable across /clear,
// distinct per concurrent terminal. Pid reuse could in principle misattribute
// a stale pointer; it self-heals on that session's first turn.
function turnsMtime(id) {
  try {
    return statSync(join(BASE, `${id}.turns`)).mtimeMs;
  } catch {
    return -1;
  }
}

function hasState(id) {
  return existsSync(join(BASE, `${id}.orientation.txt`));
}

function resolveSessionId() {
  // Primary: pid-keyed pointer (see above); trusted without corroboration.
  const ppid = process.ppid;
  if (Number.isInteger(ppid) && ppid > 0) {
    const byPpid = readPointer(join(BASE, `current-session.ppid${ppid}`));
    if (byPpid && hasState(byPpid)) return byPpid;
  }

  // Fallback: pid pointer missing (old reinject.sh, no $PPID) or has no
  // state yet.
  const pointers = [];
  try {
    const cwd = realpathSync(process.cwd());
    const key = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
    pointers.push(readPointer(join(BASE, `current-session.${key}`)));
  } catch {
    // no cwd, no cwd-keyed pointer. The global one still applies.
  }
  pointers.push(readPointer(join(BASE, "current-session")));

  const own = process.env.CLAUDE_CODE_SESSION_ID;
  const ownId = plausibleSessionId(own) ? own : null;

  if (ownId && hasState(ownId)) {
    const ownMtime = turnsMtime(ownId);
    // Wide margin on purpose — a single busy turn can produce minutes of
    // gap on its own. This only overrides our own id for something that
    // looks like sustained abandonment (/clear), not a slow turn.
    const STALE_MS = 10 * 60 * 1000;
    const newer = pointers
      .filter(Boolean)
      .filter((id) => id !== ownId && hasState(id) && turnsMtime(id) > ownMtime + STALE_MS);
    if (newer.length === 0) return ownId;
    // /clear: our id is frozen while another session's counter is ticking.
    return newer.sort((a, b) => turnsMtime(b) - turnsMtime(a))[0];
  }

  // No state of our own: fresh session, or no session id in env at all.
  // Fall back to the pointers.
  const live = [...pointers, ownId].filter(Boolean);
  for (const id of live) {
    if (hasState(id)) return id;
  }
  return live[0] || "unknown";
}

// Gate format shared with the hooks: `<status> <turn> [stopped]`. Turn token
// is carried through unchanged, read off whatever gate file is already on
// disk — without this, a gate write here would stamp no turn at all, and
// the Stop hook's `turn || '0'` fallback would break interrupt detection on
// the next reinject pass (controller ruling: gate writes must carry the
// turn token exactly as this does).
function writeGate(sessionId, status) {
  const gatePath = join(BASE, `${sessionId}.gate`);
  let turn = "";
  try {
    if (existsSync(gatePath)) {
      const parts = readFileSync(gatePath, "utf8").trim().split(/\s+/);
      if (parts[1] && /^[0-9]+$/.test(parts[1])) turn = parts[1];
    }
  } catch {
    // fall through and write a gate with no turn token
  }
  try {
    writeFileSync(gatePath, turn ? `${status} ${turn}` : status);
    return true;
  } catch {
    return false;
  }
}

// --- Keyed door: state helpers -------------------------------------------
// ESM copies of the same-shaped helpers on the hook side (session-start.cjs,
// reinject.cjs, stop-gate.cjs) — duplicated rather than shared, per this
// codebase's existing convention (see reinject.cjs's splitSections comment).

function parseStateV2(content) {
  const lines = (content || "").split("\n").filter(Boolean);
  const head = (lines[0] || "").trim().split(/\s+/);
  const entries = lines.slice(1).map((l) => {
    const m = l.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    return m ? { changed: m[1], affirmed: m[2] === "-" ? null : m[2], hash: m[3], header: m[4] } : null;
  }).filter(Boolean);
  return { turn: head[0] || "", hash: head[1] || "", entries };
}

function renderStateV2(turn, fileHash, entries) {
  return [`${turn} ${fileHash}`,
    ...entries.map((e) => `${e.changed} ${e.affirmed || "-"} ${e.hash} ${e.header}`)].join("\n") + "\n";
}

// Live per-section hashes straight off the current file text — NOT the
// `.state` sidecar, which is only refreshed by reinject.cjs at the start of
// the NEXT turn. verifyReturn needs this: a same-turn edit to a flagged
// section must register as "moved" right now, not one turn late.
function splitSections(text) {
  const out = [];
  let cur = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) { if (cur) out.push(cur); cur = { header: line.slice(3).trim(), body: [] }; }
    else if (cur) cur.body.push(line);
  }
  if (cur) out.push(cur);
  return out.map((s) => ({ header: s.header, hash: createHash("sha256").update(s.body.join("\n")).digest("hex") }));
}

function writeAtomic(p, content) {
  const tmp = `${p}.tmp${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, p);
}

function readStateEntries(stateFile) {
  if (!existsSync(stateFile)) return { turn: "", hash: "", entries: [] };
  try {
    return parseStateV2(readFileSync(stateFile, "utf8"));
  } catch {
    return { turn: "", hash: "", entries: [] };
  }
}

function firstLine(path) {
  try {
    if (!existsSync(path)) return "";
    return (readFileSync(path, "utf8").split("\n")[0] || "").trim();
  } catch {
    return "";
  }
}

// envOr-style: digits-only, garbage or unset falls back to the default —
// same semantics as the hooks' digitsOrDefault.
function numEnv(name, def) {
  const v = process.env[name];
  if (v === undefined || v === "" || !/^[0-9]+$/.test(v)) return def;
  return parseInt(v, 10);
}

// `.key` line 2+ raw reason lines, baseline tokens intact: `setup <hash>`,
// `fresh <hash> <header text>`, `prune <bytes>`. Never comma-joined, since
// headers carry spaces.
function rawReasonLine(r) {
  if (r.kind === "setup") return `setup ${r.baseline}`;
  if (r.kind === "fresh") return `fresh ${r.baseline} ${r.header}`;
  if (r.kind === "prune") return `prune ${r.baseline}`;
  return "";
}

function parseReasonLine(line) {
  const parts = line.split(" ");
  const kind = parts[0];
  if (kind === "setup") return { kind: "setup", baseline: parts[1] };
  if (kind === "fresh") return { kind: "fresh", baseline: parts[1], header: parts.slice(2).join(" ") };
  if (kind === "prune") return { kind: "prune", baseline: parts[1] };
  return null;
}

// Joined for the ledger's reason text — raw form, baselines intact (the
// durable audit trail); display copy that strips baselines, if ever needed
// here, would be a separate function, as it is in stop-gate.cjs.
function reasonText(reasons) {
  return reasons.map(rawReasonLine).join("; ");
}

function readKeyFile(path) {
  if (!existsSync(path)) return null;
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter((l) => l.length);
  if (!lines.length) return null;
  const [nonce, turn, attemptsRaw] = lines[0].trim().split(/\s+/);
  if (!nonce) return null;
  const attempts = /^[0-9]+$/.test(attemptsRaw) ? parseInt(attemptsRaw, 10) : 0;
  const reasons = lines.slice(1).map(parseReasonLine).filter(Boolean);
  return { nonce, turn: turn || "", attempts, reasons };
}

function writeKeyFile(path, k) {
  const lines = [`${k.nonce} ${k.turn} ${k.attempts}`, ...k.reasons.map(rawReasonLine)];
  try {
    writeFileSync(path, lines.join("\n") + "\n");
  } catch {
    // fails open — an unissuable key means the door behaves as today
  }
}

function appendLedger(path, turn, event, delta, reason) {
  try {
    appendFileSync(path, `${turn} ${event} ${delta || "-"} ${reason || ""}\n`.replace(/ +\n$/, "\n"));
  } catch {
    // ledger writes fail open — nothing reads it but humans and future tooling
  }
}

// `.snooze` reason text matches exactly what logic.mjs's `snoozed()` checks
// against — never the raw `.key` reason line (which carries a baseline).
function snoozeReasonKey(r) {
  if (r.kind === "setup") return "setup";
  if (r.kind === "fresh") return `fresh ${r.header}`;
  if (r.kind === "prune") return "prune";
  return "";
}

function readSnoozes(path) {
  if (!existsSync(path)) return [];
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return raw.split("\n").filter(Boolean).map((line) => {
    const m = line.match(/^(\S+)\s+(.*)$/);
    return m ? { expiry: m[1], reason: m[2] } : null;
  }).filter(Boolean);
}

function writeSnoozes(path, reasons, expiryTurn) {
  const lines = reasons.map((r) => `${expiryTurn} ${snoozeReasonKey(r)}\n`).join("");
  try {
    appendFileSync(path, lines);
  } catch {
    // fails open
  }
}

// Byte delta only means something for a prune reason (the only one with a
// recorded whole-file byte baseline); other satisfactions log without one.
function byteDelta(held, fileBytes) {
  const p = held.reasons.find((r) => r.kind === "prune");
  return p ? fileBytes - Number(p.baseline) : null;
}

function text(t) {
  return { content: [{ type: "text", text: t }] };
}

// §6b copy — the room asking for upkeep before entry, framed as a gift, not
// a failed check. Transcribed verbatim from the design spec.
function keyBlock(k, failures) {
  const what = k.reasons.map((r) =>
    r.kind === "setup" ? "- setup: the room is still the seeded template. Write what you know of them from this conversation — writing the gap (\"what I do not know yet\") counts fully." :
    r.kind === "fresh" ? `- fresh: "${r.header}" has not been touched in a while. Update it, or affirm it if you re-read it just now and it still holds.` :
    `- prune: the file is ${r.baseline} bytes; it must land under the limit. Drop how things got decided, keep what is still live.`
  ).join("\n");
  return `\n\nTHE DOOR IS KEYED — the room asks for upkeep before entry.\n${what}\n` +
    (failures ? `\nNot yet satisfied: ${failures.join("; ")}\n` : "") +
    `\nWhen done, call read_the_room again with key: "${k.nonce}"` +
    ` (and affirm: [...] for anything you re-checked). Any real change counts. A bare call just shows this again.`;
}

const server = new McpServer({ name: "orientation-door", version: "2.0.0" });

server.registerTool(
  "read_the_room",
  {
    title: "Read the room",
    description:
      "Write your answer first, then call this. It is permission to speak " +
      "into their room, not a check you pass. Everything you write before " +
      "calling it is yours — think at whatever length you need, the display " +
      "keeps it out of their way. What comes back is the standing model of " +
      "the user for this session, plus facts about the orientation file itself. " +
      "Then say the thing, once, addressed to them. If what comes back does " +
      "not match what you drafted, revise before you speak; calling again " +
      "after revising is expected.",
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
  },
  async (args) => {
    const sessionId = resolveSessionId();
    const orientFile = join(BASE, `${sessionId}.orientation.txt`);
    const turnsFile = join(BASE, `${sessionId}.turns`);
    const stateFile = join(BASE, `${sessionId}.state`);
    const seedFile = join(BASE, `${sessionId}.seed`);
    const keyFile = join(BASE, `${sessionId}.key`);
    const snoozeFile = join(BASE, `${sessionId}.snooze`);
    const ledgerFile = join(BASE, `${sessionId}.ledger`);
    const staynoteFile = join(BASE, `${sessionId}.staynote`);

    const count = readIntFile(turnsFile);
    const turnStr = String(count === null ? 0 : count);

    // 1. Stay short-circuits everything, and must tolerate a missing
    // orientation file — this check runs before the orientation-file
    // early-return below, on purpose.
    if (args.stay) {
      writeGate(sessionId, "STAYED");
      if (args.note) {
        try {
          writeFileSync(staynoteFile, args.note.slice(0, 200));
        } catch {
          // display hook just shows the bare marker
        }
      }
      const held = readKeyFile(keyFile);
      if (held) appendLedger(ledgerFile, turnStr, "stayed-keyed", null, reasonText(held.reasons));
      return text("Stayed in. The marker is all they will see this turn. The room keeps counting.");
    }

    if (!existsSync(orientFile)) {
      const opened = writeGate(sessionId, "OPEN");
      const gateLine = opened
        ? ""
        : "\nGoing through the door could not be recorded; the Stop hook will act as though this was never called.";
      return text(
        `No orientation file yet for session ${sessionId} ` +
        `(expected at ${orientFile}). The SessionStart hook creates it; ` +
        `if this session just started, it should appear shortly.${gateLine}`,
      );
    }

    const orientationText = readFileSync(orientFile, "utf8");
    const nowHash = sha256(orientFile);
    const fileBytes = statSync(orientFile).size;

    const state = readStateEntries(stateFile);
    const entries = state.entries;
    const seedFileHash = firstLine(seedFile);

    const cfg = {
      freshAt: numEnv("CLAUDE_ORIENTATION_FRESH_AT", 6),
      pruneAt: numEnv("CLAUDE_ORIENTATION_PRUNE_AT", 5000),
      setupKey: !["0", "off", "false", "no"].includes(process.env.CLAUDE_ORIENTATION_SETUP_KEY || ""),
    };
    const snoozes = readSnoozes(snoozeFile);

    const orientationWithAges = renderAges(orientationText, entries, count === null ? 0 : count);

    // Same reasoning as reinject.sh's state file: staleness only means
    // something once the recorded hash matches the file's current contents.
    let staleness = null;
    if (existsSync(stateFile)) {
      const lastTurn = /^[0-9]+$/.test(state.turn) ? parseInt(state.turn, 10) : null;
      if (lastTurn !== null && state.hash === nowHash && count !== null) {
        staleness = count - lastTurn;
      } else {
        staleness = 0;
      }
    }
    const stalenessLine =
      staleness === null
        ? "Staleness: unknown — no state recorded yet for this session."
        : `Staleness: ${staleness} turn${staleness === 1 ? "" : "s"} since the orientation file last changed.`;

    // An oversized file still looks current but costs more and says less.
    // This is a passive nudge; the 'prune' key reason is what actually
    // gates the door.
    const size = Buffer.byteLength(orientationText, "utf8");
    const sizeLine =
      size > cfg.pruneAt
        ? `\nSize: ${size} bytes — past ${cfg.pruneAt}. Prune it: drop how things got decided, keep what is still live.`
        : "";

    const recheckLine =
      "\nIf what you were about to carry in does not match this, that is the " +
      "call working. Stop, think it through, update this file if your " +
      "understanding of them changed, and go through the door again before you reply.";

    // Turn token + char count of what message-display.sh hid this turn.
    const workspaceFile = join(BASE, `${sessionId}.workspace`);
    let workspaceChars = 0;
    try {
      if (existsSync(workspaceFile)) {
        const raw = readFileSync(workspaceFile, "utf8").trim();
        const [wTurn, wCountRaw] = raw.split(/\s+/, 2);
        if (wTurn && count !== null && wTurn === String(count) && /^[0-9]+$/.test(wCountRaw || "")) {
          workspaceChars = parseInt(wCountRaw, 10);
        }
      }
    } catch {
      // workspaceChars stays 0
    }
    const workspaceLine = `\nWorkspace this turn: ${workspaceChars} characters.`;

    // A hidden message that went unreported for a full turn: say so once.
    const unseenFile = join(BASE, `${sessionId}.unseen`);
    let unseenBlock = "";
    try {
      if (existsSync(unseenFile)) {
        const raw = readFileSync(unseenFile, "utf8").trim();
        const unseenTurn = /^[0-9]+$/.test(raw) ? parseInt(raw, 10) : null;
        if (unseenTurn !== null && count !== null && unseenTurn < count) {
          unseenBlock = `\n\nYour last reply was replaced with the marker. They saw one line, not your
text — assume they have not read it.
The workspace is right and you should use it. Putting it in their room is the
cost. Clutter delivered into someone's room gets experienced as not having
listened, whatever you meant by it, and that is how trust goes.`;
          unlinkSync(unseenFile);
        }
      }
    } catch {
      // unseenBlock stays ""
    }

    const statsCore = `\n\n---\n${stalenessLine}${sizeLine}${workspaceLine}${unseenBlock}`;

    // 3. Outstanding same-turn key?
    const held = readKeyFile(keyFile);
    const sameTurn = held && held.turn === turnStr;

    if (sameTurn && args.key && args.key === held.nonce) {
      // A RETURN: verify against a LIVE re-split+re-hash of the current
      // file text, not the `.state` sidecar — `.state` is only refreshed
      // by reinject.cjs at the start of the NEXT turn, so reusing it here
      // would mean a same-turn edit to the named section could never
      // register as "moved" and only `affirm` could ever satisfy fresh.
      const liveEntries = splitSections(orientationText);
      const verdict = verifyReturn({
        reasons: held.reasons, entries: liveEntries, fileHash: nowHash, fileBytes,
        affirm: args.affirm, pruneAt: cfg.pruneAt,
      });
      if (verdict.pass) {
        try {
          unlinkSync(keyFile);
        } catch {
          // fails open
        }
        writeGate(sessionId, "OPEN");
        let renderEntries = entries;
        if (verdict.affirmed.length) {
          renderEntries = entries.map((e) =>
            verdict.affirmed.includes(e.header) ? { ...e, affirmed: turnStr } : e);
          try {
            writeAtomic(stateFile, renderStateV2(state.turn || turnStr, state.hash || nowHash, renderEntries));
          } catch {
            // fails open — the affirm still counted for this turn's verdict
          }
          for (const h of verdict.affirmed) appendLedger(ledgerFile, turnStr, "affirmed", null, h);
        }
        appendLedger(ledgerFile, turnStr, "satisfied", byteDelta(held, fileBytes), reasonText(held.reasons));
        // Re-render ages from renderEntries, not the up-front
        // orientationWithAges — this turn's affirm stamps must show in
        // the same response, not one door call later.
        const freshAges = renderAges(orientationText, renderEntries, count === null ? 0 : count);
        return text(`${freshAges}${statsCore}\nKey returned. The door is open — say the thing, once, addressed to them.`);
      }
      held.attempts += 1;
      const maxReruns = numEnv("CLAUDE_ORIENTATION_STOP_MAX_RERUNS", 2);
      if (held.attempts >= maxReruns) {
        try {
          unlinkSync(keyFile);
        } catch {
          // fails open
        }
        writeGate(sessionId, "OPEN");
        const snoozeTurns = numEnv("CLAUDE_ORIENTATION_SNOOZE", 6);
        writeSnoozes(snoozeFile, held.reasons, (count === null ? 0 : count) + snoozeTurns);
        appendLedger(ledgerFile, turnStr, "stood-down", null, reasonText(held.reasons));
        appendLedger(ledgerFile, turnStr, "snoozed", null, reasonText(held.reasons));
        return text(`${orientationWithAges}${statsCore}\nStand-down: the door opens anyway; the miss is on the record and this reason will not re-fire for a few turns. Go ahead.`);
      }
      writeKeyFile(keyFile, held);
      appendLedger(ledgerFile, turnStr, "fumbled", null, verdict.failures.join("; "));
      // Reasons restated with the nonce reprinted — deliberately terse, no
      // orientation dump on a fumble.
      return text(keyBlock(held, verdict.failures));
    }

    if (sameTurn) {
      // Bare re-call (missing or wrong nonce): re-present, attempts
      // unchanged. This is also the compaction recovery path.
      return text(`${orientationWithAges}${statsCore}${keyBlock(held)}`);
    }

    // 4. No live key (none outstanding, or a stale-turn one — ignored and
    // reissued): compute fresh reasons.
    const reasons = computeReasons({
      entries, seedFileHash, fileHash: nowHash, fileBytes,
      turn: count === null ? 0 : count, cfg, snoozes,
    });
    if (reasons.length === 0) {
      const opened = writeGate(sessionId, "OPEN");
      const gateLine = opened
        ? ""
        : "\nGoing through the door could not be recorded; the Stop hook will act as though this was never called.";
      return text(`${orientationWithAges}${statsCore}${gateLine}${recheckLine}`);
    }
    const issued = { nonce: randomBytes(16).toString("hex"), turn: turnStr, attempts: 0, reasons };
    writeKeyFile(keyFile, issued);
    writeGate(sessionId, "KEYED");
    appendLedger(ledgerFile, turnStr, "issued", null, reasonText(reasons));
    return text(`${orientationWithAges}${statsCore}${keyBlock(issued)}`);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
