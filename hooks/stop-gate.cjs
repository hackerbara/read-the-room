#!/usr/bin/env node
// Orientation — Stop hook (backstop). Fires on Stop; if the door's gate is
// still closed, hands back a pointer to call it and lets the turn continue.
// Ported from stop-gate.sh.

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

function digitsOrDefault(v, def) {
  if (v === undefined || v === '' || !/^[0-9]+$/.test(v)) return def;
  return v;
}

function appendLedger(base, sessionId, turn, event, delta, reason) {
  try { fs.appendFileSync(path.join(base, `${sessionId}.ledger`),
    `${turn} ${event} ${delta || '-'} ${reason || ''}\n`.replace(/ +\n$/, '\n')); } catch {}
}

// Reads .key lines 2+ verbatim — raw reason lines, baseline tokens intact.
// This is what the ledger records: the durable audit trail (spec §5) keeps
// the baseline (hash/byte count at issue) on the record.
function readKeyReasons(p) {
  try { return fs.readFileSync(p, 'utf8').split('\n').slice(1).filter(Boolean); } catch { return []; }
}

// Strips the baseline token from a raw .key reason line, for nudge display
// copy ONLY — the ledger and the file on disk keep the raw form untouched.
// `fresh <hash> <header>` -> `fresh: <header>`; `prune <bytes>` ->
// `prune: <bytes> bytes`; `setup <hash>` -> `setup`.
function displayReason(line) {
  const parts = line.split(' ');
  const kind = parts[0];
  if (kind === 'fresh') return `fresh: ${parts.slice(2).join(' ')}`;
  if (kind === 'prune') return `prune: ${parts[1]} bytes`;
  if (kind === 'setup') return 'setup';
  return line;
}

function readTokens(content, n) {
  const line = (content || '').split(/\r?\n/)[0] || '';
  const parts = line.trim().split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < n; i++) out.push(parts[i] || '');
  return out;
}

function hostFromArgs(argv) {
  const index = argv.indexOf('--host');
  return index >= 0 && argv[index + 1] === 'codex' ? 'codex' : 'claude';
}

function emitContinuation(host, ctx) {
  if (host === 'codex') {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: ctx }) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'Stop', additionalContext: ctx }
  }) + '\n');
}

function incrementCodexReruns(file, turn) {
  let recordedTurn = '', count = 0;
  try {
    [recordedTurn, count] = readTokens(fs.readFileSync(file, 'utf8'), 2);
    count = recordedTurn === turn && /^[0-9]+$/.test(count) ? parseInt(count, 10) : 0;
  } catch { count = 0; }
  count += 1;
  try { fs.writeFileSync(file, `${turn} ${count}`); } catch {}
  return count;
}

// bash `$(...)` command substitution strips all trailing newlines from what
// it captures — LAST_ASSISTANT_MESSAGE's length check is measured post-strip.
function stripTrailingNL(s) {
  return s.replace(/\n+$/, '');
}

function run(raw) {
  const host = hostFromArgs(process.argv.slice(2));
  // Rollback switch that does not require editing settings.json.
  const stopSwitch = envOrDefault('CLAUDE_ORIENTATION_STOP', '1');
  if (['0', 'off', 'false', 'no'].includes(stopSwitch)) return;

  let input;
  try { input = JSON.parse(raw); } catch { input = {}; }
  if (typeof input !== 'object' || input === null) input = {};

  let sessionId = jqStr(input.session_id, '');
  if (!sessionId) sessionId = process.env.CLAUDE_CODE_SESSION_ID || 'unknown';
  if (sessionId === 'unknown') return;

  const base = path.join(os.tmpdir(), 'claude-orientation');
  const gateFile = path.join(base, `${sessionId}.gate`);
  const orientFile = path.join(base, `${sessionId}.orientation.txt`);
  const suppressedFile = path.join(base, `${sessionId}.suppressed`);
  const codexRerunsFile = path.join(base, `${sessionId}.codex-reruns`);
  const turnsFile = path.join(base, `${sessionId}.turns`);
  const stateFile = path.join(base, `${sessionId}.state`);
  const hiddenFile = path.join(base, `${sessionId}.hidden`);
  const unseenFile = path.join(base, `${sessionId}.unseen`);

  // No gate file: UserPromptSubmit never ran for this session.
  if (!fs.existsSync(gateFile)) return;

  let status = '', turn = '', flag = '';
  try { [status, turn, flag] = readTokens(fs.readFileSync(gateFile, 'utf8'), 3); } catch {}

  // Marks the turn as ended (not interrupted), for the next UserPromptSubmit.
  const stamp = (s) => { try { fs.writeFileSync(gateFile, `${s} ${turn || '0'} stopped`); } catch {} };

  // Gate OPEN: the door was called. Reset the suppressed counter. Checked
  // before stop_hook_active so a re-run that calls the door still clears it.
  if (status === 'OPEN') {
    if (host === 'claude') {
      try { fs.writeFileSync(suppressedFile, '0'); } catch {}
    } else {
      try { fs.unlinkSync(codexRerunsFile); } catch {}
    }
    try { fs.writeFileSync(path.join(base, `${sessionId}.staystreak`), '0'); } catch {}
    stamp('OPEN');
    return;
  }

  // Gate SPOKEN: door was called and answered. Same reset as OPEN, plus a
  // one-shot signal if text was hidden after the reply went out.
  if (status === 'SPOKEN') {
    try { fs.writeFileSync(path.join(base, `${sessionId}.staystreak`), '0'); } catch {}
    stamp('SPOKEN');
    if (host === 'codex') {
      try { fs.unlinkSync(codexRerunsFile); } catch {}
      return;
    }
    try { fs.writeFileSync(suppressedFile, '0'); } catch {}
    const aftertalkFile = path.join(base, `${sessionId}.aftertalk`);
    let aftertalk = '';
    try { aftertalk = fs.readFileSync(aftertalkFile, 'utf8').replace(/[^0-9]/g, ''); } catch {}
    let curTurn = '';
    try { curTurn = fs.readFileSync(turnsFile, 'utf8').replace(/[^0-9]/g, ''); } catch {}
    try { fs.unlinkSync(aftertalkFile); } catch {}
    // On a re-run this signal has already fired for this turn, and the gate is
    // still SPOKEN, so anything written during the re-run gets hidden and
    // rewrites .aftertalk. Emitting again would loop.
    const rerun = jqStr(input.stop_hook_active, 'false') === 'true';
    if (!rerun && aftertalk && curTurn && aftertalk === curTurn) {
      const ctx = `The door closed behind you and you wrote more after it. Did you mean that for
them? Either way, the room is probably worth a one-line update.`;
      // jq -c always appends a trailing newline.
      emitContinuation(host, ctx);
    }
    return;
  }

  // Gate STAYED: the door was called with `stay` — a legal, quiet end.
  // Increments the consecutive-stay streak; past STAY_CAP, the ordinary
  // come-through nudge fires (waiting is legal, but not forever silent).
  if (status === 'STAYED') {
    stamp('STAYED');
    // The harness re-runs the turn after this hook injects context, with
    // stop_hook_active true — same guard as KEYED/CLOSED. Without it, a
    // real capped stay would re-read-increment-write the streak twice per
    // turn (once per run), inflating it by 2 instead of 1.
    const rerun = host === 'claude' && jqStr(input.stop_hook_active, 'false') === 'true';
    if (rerun) return;
    let streak = 0;
    try { streak = parseInt(fs.readFileSync(path.join(base, `${sessionId}.staystreak`), 'utf8').replace(/[^0-9]/g, ''), 10) || 0; } catch {}
    if (host === 'claude' || flag !== 'stopped') {
      streak += 1;
      try { fs.writeFileSync(path.join(base, `${sessionId}.staystreak`), String(streak)); } catch {}
    }
    const stayCap = parseInt(digitsOrDefault(process.env.CLAUDE_ORIENTATION_STAY_CAP, '3'), 10);
    if (stayCap > 0 && streak > stayCap) {
      if (host === 'codex') {
        const count = incrementCodexReruns(codexRerunsFile, turn || '0');
        const max = parseInt(digitsOrDefault(process.env.CLAUDE_ORIENTATION_STOP_MAX_RERUNS, '2'), 10);
        if (max > 0 && count > max) return;
      }
      emitContinuation(host, `You have stayed in for ${streak} consecutive turns. Staying is legal and counted, but the person has heard nothing in all that time. Either go through the door with something for them, or tell them plainly you are holding and why.`);
    } else if (host === 'codex') {
      try { fs.unlinkSync(codexRerunsFile); } catch {}
    }
    return;
  }

  // Gate KEYED: a key was issued and the turn ended without returning it —
  // an illegal end, like CLOSED, but the MIN_CHARS trivial-reply exemption
  // does not apply (a short reply must not silently void a due key).
  if (status === 'KEYED') {
    const stopActive = host === 'claude' && jqStr(input.stop_hook_active, 'false') === 'true';
    if (stopActive) return;

    let curTurn = '';
    try { curTurn = fs.readFileSync(turnsFile, 'utf8').replace(/[^0-9]/g, ''); } catch {}

    // Consecutive closed/keyed-gate turns. Read by message-display.js, which
    // stops suppressing at 2.
    let continuationCount = 0;
    if (host === 'claude') {
      try {
        const digits = fs.readFileSync(suppressedFile, 'utf8').replace(/[^0-9]/g, '');
        continuationCount = digits ? parseInt(digits, 10) : 0;
      } catch { continuationCount = 0; }
      continuationCount += 1;
      try { fs.writeFileSync(suppressedFile, String(continuationCount)); } catch {}
    } else {
      continuationCount = incrementCodexReruns(codexRerunsFile, turn || '0');
    }

    // Past STOP_MAX_RERUNS, stand down: stamp the gate (for interrupt
    // detection) and stop re-running.
    const stopMaxReruns = parseInt(digitsOrDefault(process.env.CLAUDE_ORIENTATION_STOP_MAX_RERUNS, '2'), 10);
    if (stopMaxReruns > 0 && continuationCount > stopMaxReruns) { stamp('KEYED'); return; }

    // Raw reasons (baseline tokens intact) go to the ledger — the durable
    // audit trail. Display copy strips the baseline (displayReason above).
    const reasons = readKeyReasons(path.join(base, `${sessionId}.key`));
    if (host === 'claude' || flag !== 'stopped') {
      appendLedger(base, sessionId, curTurn, 'lapsed', null, reasons.join('; '));
    }
    const ctx = `A key was issued and not returned — the door asked for upkeep before entry and the turn is ending without it.
Outstanding: ${reasons.map(displayReason).join(' · ') || 'unknown'}
Call read_the_room again: a bare call re-presents the key (not a fumble). Update or affirm what it names, return the key, then reply.`;

    stamp('KEYED');

    // jq -c always appends a trailing newline.
    emitContinuation(host, ctx);
    return;
  }

  if (status !== 'CLOSED') return;

  // This turn's hidden message matched this turn's reply, not working notes.
  if (host === 'claude') {
    let hiddenTurn = '';
    try { hiddenTurn = fs.readFileSync(hiddenFile, 'utf8').replace(/[^0-9]/g, ''); } catch {}
    let curTurn = '';
    try { curTurn = fs.readFileSync(turnsFile, 'utf8').replace(/[^0-9]/g, ''); } catch {}
    if (hiddenTurn && hiddenTurn === curTurn) {
      try { fs.writeFileSync(unseenFile, curTurn); } catch {}
    }
  }

  // The harness re-runs the turn after this hook injects context, with
  // stop_hook_active true; returning here caps the increment below to once
  // per turn.
  const stopActive = host === 'claude' && jqStr(input.stop_hook_active, 'false') === 'true';
  if (stopActive) return;

  let orientStat = null;
  try { orientStat = fs.statSync(orientFile); } catch {}
  if (!orientStat || orientStat.size === 0) { stamp('CLOSED'); return; }

  // MIN_CHARS: skip the nudge when the reply was shorter than N chars (0 = off).
  const minChars = parseInt(digitsOrDefault(process.env.CLAUDE_ORIENTATION_STOP_MIN_CHARS, '100'), 10);
  if (minChars > 0) {
    const last = stripTrailingNL(jqStr(input.last_assistant_message, ''));
    if (Array.from(last).length < minChars) { stamp('CLOSED'); return; }
  }

  // Consecutive closed-gate turns. Read by message-display.js, which stops
  // suppressing at 2.
  let continuationCount = 0;
  if (host === 'claude') {
    try {
      const digits = fs.readFileSync(suppressedFile, 'utf8').replace(/[^0-9]/g, '');
      continuationCount = digits ? parseInt(digits, 10) : 0;
    } catch { continuationCount = 0; }
    continuationCount += 1;
    try { fs.writeFileSync(suppressedFile, String(continuationCount)); } catch {}
  } else {
    continuationCount = incrementCodexReruns(codexRerunsFile, turn || '0');
  }

  // Past STOP_MAX_RERUNS, stand down: stamp the gate (for interrupt
  // detection) and stop re-running.
  const stopMaxReruns = parseInt(digitsOrDefault(process.env.CLAUDE_ORIENTATION_STOP_MAX_RERUNS, '2'), 10);
  if (stopMaxReruns > 0 && continuationCount > stopMaxReruns) { stamp('CLOSED'); return; }

  // Computed the same way reinject.js and the door do: valid only while the
  // recorded hash still matches.
  let staleLine = '';
  if (fs.existsSync(stateFile)) {
    let nowHash = '';
    try { nowHash = crypto.createHash('sha256').update(fs.readFileSync(orientFile)).digest('hex'); } catch {}
    let count = '';
    try { count = fs.readFileSync(turnsFile, 'utf8').replace(/[^0-9]/g, ''); } catch {}
    let stateContent = '';
    try { stateContent = fs.readFileSync(stateFile, 'utf8'); } catch {}
    let [lastTurn, lastHash] = readTokens(stateContent, 2);
    if (!/^[0-9]+$/.test(lastTurn)) lastTurn = '';
    if (count && lastTurn && lastHash === nowHash) {
      staleLine = `It was last changed ${parseInt(count, 10) - parseInt(lastTurn, 10)} turns ago.`;
    }
  }

  let backstopLine = '';
  if (host === 'claude' && continuationCount >= 2) {
    backstopLine = `
This is turn ${continuationCount} in a row where the door was not gone through. Hiding
is off while that is true, so everything renders.`;
  }

  // Deliberately excludes the orientation file's contents — only a pointer
  // to call the door.
  const ctx = `The door was not gone through before this reply — \`read_the_room\` was not
called, so the orientation file was never consulted.
${staleLine}
${backstopLine}

Go through the door, then reply.`;

  stamp('CLOSED');

  // jq -c always appends a trailing newline.
  emitContinuation(host, ctx);
}

function envOrDefault(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { data += c; });
process.stdin.on('end', () => {
  try { run(data); } catch {}
});
