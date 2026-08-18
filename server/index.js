#!/usr/bin/env node
// Orientation door — MCP server exposing the `read_the_room` tool. Calling
// it opens this turn's gate, telling the Stop hook the user was consulted.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
// is carried through unchanged; `stopped` is dropped here since a gate we
// just opened has not been stopped on.
function openGate(sessionId) {
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
    writeFileSync(gatePath, turn ? `OPEN ${turn}` : "OPEN");
    return true;
  } catch {
    return false;
  }
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
      note: z
        .string()
        .optional()
        .describe(
          "What you are about to carry into their room, in a sentence. " +
            "Nothing stores it and nothing reads it — writing it is the point.",
        ),
    },
  },
  async () => {
    const sessionId = resolveSessionId();
    const orientFile = join(BASE, `${sessionId}.orientation.txt`);
    const turnsFile = join(BASE, `${sessionId}.turns`);
    const stateFile = join(BASE, `${sessionId}.state`);

    // Open the gate unconditionally — crossing the door counts even if
    // there's no orientation file yet to consult.
    const opened = openGate(sessionId);

    if (!existsSync(orientFile)) {
      return {
        content: [
          {
            type: "text",
            text:
              `No orientation file yet for session ${sessionId} ` +
              `(expected at ${orientFile}). The SessionStart hook creates it; ` +
              `if this session just started, it should appear shortly.`,
          },
        ],
      };
    }

    const orientationText = readFileSync(orientFile, "utf8");
    const count = readIntFile(turnsFile);
    const nowHash = sha256(orientFile);

    // Same reasoning as reinject.sh's state file: staleness only means
    // something once the recorded hash matches the file's current contents.
    let staleness = null;
    if (existsSync(stateFile)) {
      const raw = readFileSync(stateFile, "utf8").trim();
      const [lastTurnRaw, lastHash] = raw.split(/\s+/, 2);
      const lastTurn = lastTurnRaw && /^[0-9]+$/.test(lastTurnRaw) ? parseInt(lastTurnRaw, 10) : null;
      if (lastTurn !== null && lastHash === nowHash && count !== null) {
        staleness = count - lastTurn;
      } else {
        staleness = 0;
      }
    }

    const stalenessLine =
      staleness === null
        ? "Staleness: unknown — no state recorded yet for this session."
        : `Staleness: ${staleness} turn${staleness === 1 ? "" : "s"} since the orientation file last changed.`;

    const gateLine = opened
      ? ""
      : "\nGoing through the door could not be recorded; the Stop hook will act as though this was never called.";

    // An oversized file still looks current but costs more and says less.
    // Nothing enforces pruning; this just puts the size in view.
    const PRUNE_AT = 6000;
    const size = Buffer.byteLength(orientationText, "utf8");
    const sizeLine =
      size > PRUNE_AT
        ? `\nSize: ${size} characters — past ${PRUNE_AT}. Prune it: drop how things got decided, keep what is still live.`
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

    return {
      content: [
        {
          type: "text",
          text: `${orientationText}\n\n---\n${stalenessLine}${sizeLine}${workspaceLine}${unseenBlock}${gateLine}${recheckLine}`,
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
