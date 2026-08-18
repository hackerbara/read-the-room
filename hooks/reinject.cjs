#!/usr/bin/env node
// Orientation — UserPromptSubmit hook. Re-injects the orientation file when
// it has gone stale, and maintains v2's session-pointer and gate-file state.
// Ported from reinject.sh; see that file for design rationale.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function jqStr(v, fb) {
  if (v === undefined || v === null || v === false) return fb;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return fb;
}

// Bash: `case "$V" in (''|*[!0-9]*) V=default ;; esac` — only some vars go
// through this; NUDGE_AT/REINJECT_AT/REPEAT deliberately do not (see below).
function digitsOrDefault(v, def) {
  if (v === undefined || v === '' || !/^[0-9]+$/.test(v)) return def;
  return v;
}

// Bash: `${VAR:-default}` — default applies when unset OR empty.
function envOr(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

function readTokens(content, n) {
  const line = (content || '').split(/\r?\n/)[0] || '';
  const parts = line.trim().split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < n; i++) out.push(parts[i] || '');
  return out;
}

function writeSafe(p, c) {
  try { fs.writeFileSync(p, c); } catch {}
}

function sha256File(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
  catch { return ''; }
}

// jq -c always appends a trailing newline; bash `$(...)` capture always
// strips trailing newlines from what it captures. Both are reproduced by hand.
function emitJson(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
function stripTrailingNL(s) {
  return s.replace(/\n+$/, '');
}

function run(raw) {
  let input;
  try { input = JSON.parse(raw); } catch { input = {}; }
  if (typeof input !== 'object' || input === null) input = {};

  let sessionId = jqStr(input.session_id, '');
  if (!sessionId) sessionId = process.env.CLAUDE_CODE_SESSION_ID || 'unknown';

  const base = path.join(os.tmpdir(), 'claude-orientation');
  try { fs.mkdirSync(base, { recursive: true }); } catch { return; }

  const orientFile = path.join(base, `${sessionId}.orientation.txt`);
  const turnsFile = path.join(base, `${sessionId}.turns`);
  const stateFile = path.join(base, `${sessionId}.state`);
  const gateFile = path.join(base, `${sessionId}.gate`);
  const msgDir = path.join(base, 'msg');

  // v2: publishes session-id pointers, read by the door / MCP server.
  //   current-session.ppid<PID>  checked first; PID is this hook's parent pid.
  //   current-session            the pointer the door's spec asks for.
  //   current-session.<cwd>      fallback keyed on a hash of the real cwd.
  if (sessionId !== 'unknown') {
    writeSafe(path.join(base, 'current-session'), sessionId);
    const ppid = process.ppid;
    if (Number.isInteger(ppid) && ppid > 0) {
      writeSafe(path.join(base, `current-session.ppid${ppid}`), sessionId);
    }
    let cwd = jqStr(input.cwd, '');
    if (!cwd) cwd = process.cwd();
    let cwdReal = '';
    try { cwdReal = fs.realpathSync(cwd); } catch { cwdReal = ''; }
    if (cwdReal) {
      const cwdKey = crypto.createHash('sha256').update(cwdReal, 'utf8').digest('hex').slice(0, 16);
      if (cwdKey) writeSafe(path.join(base, `current-session.${cwdKey}`), sessionId);
    }
  }

  // v2: sweeps orphaned message-display buffers older than MSG_STALE_MIN minutes.
  const msgStaleMin = parseInt(digitsOrDefault(process.env.CLAUDE_ORIENTATION_MSG_STALE_MIN, '10'), 10);
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(msgDir)) {
      const p = path.join(msgDir, name);
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) continue;
        if ((now - st.mtimeMs) / 60000 > msgStaleMin) fs.unlinkSync(p);
      } catch {}
    }
  } catch {}

  if (!fs.existsSync(orientFile)) return;

  let count = 0;
  try {
    const digits = fs.readFileSync(turnsFile, 'utf8').replace(/[^0-9]/g, '');
    count = digits ? parseInt(digits, 10) : 0;
  } catch { count = 0; }
  count += 1;
  writeSafe(turnsFile, String(count));

  // v2: closes the gate. Format: `<status> <turn> [stopped]`.
  //   status: CLOSED until the door runs, then OPEN.
  //   turn: this hook's turn counter, used as the turn's identity.
  //   stopped: stamped by the Stop hook; its absence marks an interrupted turn.
  let [prevStatus, prevTurn, prevFlag] = ['', '', ''];
  try { [prevStatus, prevTurn, prevFlag] = readTokens(fs.readFileSync(gateFile, 'utf8'), 3); } catch {}
  if (prevStatus === 'CLOSED' && prevTurn !== String(count) && prevFlag !== 'stopped') {
    writeSafe(path.join(base, `${sessionId}.interrupted`), prevTurn || 'unknown');
    try {
      for (const name of fs.readdirSync(msgDir)) {
        if (name.startsWith(`${sessionId}.`)) { try { fs.unlinkSync(path.join(msgDir, name)); } catch {} }
      }
    } catch {}
  }
  writeSafe(gateFile, `CLOSED ${count}`);

  const nowHash = sha256File(orientFile);
  if (!nowHash) return;

  let [lastTurn, lastHash] = ['', ''];
  try { [lastTurn, lastHash] = readTokens(fs.readFileSync(stateFile, 'utf8'), 2); } catch {}
  if (!/^[0-9]+$/.test(lastTurn)) lastTurn = '';

  if (!lastTurn || nowHash !== lastHash) {
    writeSafe(stateFile, `${count} ${nowHash}`);
    return;
  }

  const stale = count - parseInt(lastTurn, 10);

  // NUDGE_AT/REINJECT_AT/REPEAT skip bash's digit-sanitizing case pattern; a
  // non-numeric override there fails `-eq`/`-ge` silently (no emission ever).
  // Number() on a non-numeric string is NaN, and every NaN comparison below
  // is false too, so the effect matches without replicating the mechanism.
  const nudgeAt = Number(envOr('CLAUDE_ORIENTATION_NUDGE_AT', '5'));
  const reinjectAt = Number(envOr('CLAUDE_ORIENTATION_REINJECT_AT', '10'));
  const repeat = Number(envOr('CLAUDE_ORIENTATION_REPEAT', '5'));

  if (stale === nudgeAt) {
    emitJson({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `Orientation: you have not changed \`${orientFile}\` in ${stale} turns.

That may be right — if nothing has moved, nothing needs writing. But what they
are doing right now, and what they have not seen, are the two lines that go
stale fastest, and the conversation has had ${stale} turns to move under them.

Worth a look. No contents included here on purpose; go read your own file.`
      }
    });
    return;
  }

  if (stale >= reinjectAt && repeat > 0 && (stale - reinjectAt) % repeat === 0) {
    let live = '';
    try { live = stripTrailingNL(fs.readFileSync(orientFile).subarray(0, 5000).toString('utf8')); } catch {}
    emitJson({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `Orientation: unchanged for ${stale} turns. This is what it still says.

Treat the age as part of the content. It was accurate when written; the
conversation has moved ${stale} turns since, so read it as a record of where
they were, not a report of where they are. It probably needs updating — and
if it turns out to still be right, that is worth knowing too.

\`\`\`
${live}
\`\`\`

Update \`${orientFile}\`.`
      }
    });
    return;
  }
}

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { data += c; });
process.stdin.on('end', () => {
  try { run(data); } catch {}
});
