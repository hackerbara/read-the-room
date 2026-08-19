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

// Duplicated from session-start.cjs — same shapes, per codebase convention.
function splitSections(text) {
  const out = []; let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) { if (cur) out.push(cur); cur = { header: line.slice(3).trim(), body: [] }; }
    else if (cur) cur.body.push(line);
  }
  if (cur) out.push(cur);
  return out.map(s => ({ header: s.header, hash: crypto.createHash('sha256').update(s.body.join('\n')).digest('hex') }));
}

function renderStateV2(turn, fileHash, entries) {
  return [`${turn} ${fileHash}`,
    ...entries.map(e => `${e.changed} ${e.affirmed || '-'} ${e.hash} ${e.header}`)].join('\n') + '\n';
}

function writeAtomic(p, content) {
  const tmp = `${p}.tmp${process.pid}`;
  fs.writeFileSync(tmp, content); fs.renameSync(tmp, p);
}

function parseStateV2(content) {
  const lines = (content || '').split('\n').filter(Boolean);
  const head = (lines[0] || '').trim().split(/\s+/);
  const entries = lines.slice(1).map(l => {
    const m = l.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    return m ? { changed: m[1], affirmed: m[2] === '-' ? null : m[2], hash: m[3], header: m[4] } : null;
  }).filter(Boolean);
  return { turn: head[0] || '', hash: head[1] || '', entries };
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
  if ((prevStatus === 'CLOSED' || prevStatus === 'KEYED') && prevTurn !== String(count) && prevFlag !== 'stopped') {
    writeSafe(path.join(base, `${sessionId}.interrupted`), prevTurn || 'unknown');
    try {
      for (const name of fs.readdirSync(msgDir)) {
        if (name.startsWith(`${sessionId}.`)) { try { fs.unlinkSync(path.join(msgDir, name)); } catch {} }
      }
    } catch {}
  }
  writeSafe(gateFile, `CLOSED ${count}`);

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
}

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { data += c; });
process.stdin.on('end', () => {
  try { run(data); } catch {}
});
