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

function readTokens(content, n) {
  const line = (content || '').split(/\r?\n/)[0] || '';
  const parts = line.trim().split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < n; i++) out.push(parts[i] || '');
  return out;
}

// bash `$(...)` command substitution strips all trailing newlines from what
// it captures — LAST_ASSISTANT_MESSAGE's length check is measured post-strip.
function stripTrailingNL(s) {
  return s.replace(/\n+$/, '');
}

function run(raw) {
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
    try { fs.writeFileSync(suppressedFile, '0'); } catch {}
    stamp('OPEN');
    return;
  }

  // Gate SPOKEN: door was called and answered. Same reset as OPEN, plus a
  // one-shot signal if text was hidden after the reply went out.
  if (status === 'SPOKEN') {
    try { fs.writeFileSync(suppressedFile, '0'); } catch {}
    stamp('SPOKEN');
    const aftertalkFile = path.join(base, `${sessionId}.aftertalk`);
    let aftertalk = '';
    try { aftertalk = fs.readFileSync(aftertalkFile, 'utf8').replace(/[^0-9]/g, ''); } catch {}
    let curTurn = '';
    try { curTurn = fs.readFileSync(turnsFile, 'utf8').replace(/[^0-9]/g, ''); } catch {}
    try { fs.unlinkSync(aftertalkFile); } catch {}
    if (aftertalk && curTurn && aftertalk === curTurn) {
      const ctx = `The door closed behind you and you wrote more after it. Did you mean that for
them? Either way, the room is probably worth a one-line update.`;
      // jq -c always appends a trailing newline.
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'Stop', additionalContext: ctx }
      }) + '\n');
    }
    return;
  }

  if (status !== 'CLOSED') return;

  // This turn's hidden message matched this turn's reply, not working notes.
  let hiddenTurn = '';
  try { hiddenTurn = fs.readFileSync(hiddenFile, 'utf8').replace(/[^0-9]/g, ''); } catch {}
  let curTurn = '';
  try { curTurn = fs.readFileSync(turnsFile, 'utf8').replace(/[^0-9]/g, ''); } catch {}
  if (hiddenTurn && hiddenTurn === curTurn) {
    try { fs.writeFileSync(unseenFile, curTurn); } catch {}
  }

  // The harness re-runs the turn after this hook injects context, with
  // stop_hook_active true; returning here caps the increment below to once
  // per turn.
  const stopActive = jqStr(input.stop_hook_active, 'false') === 'true';
  if (stopActive) return;

  let orientStat = null;
  try { orientStat = fs.statSync(orientFile); } catch {}
  if (!orientStat || orientStat.size === 0) { stamp('CLOSED'); return; }

  // MIN_CHARS: skip the nudge when the reply was shorter than N chars (0 = off).
  const minChars = parseInt(digitsOrDefault(process.env.CLAUDE_ORIENTATION_STOP_MIN_CHARS, '0'), 10);
  if (minChars > 0) {
    const last = stripTrailingNL(jqStr(input.last_assistant_message, ''));
    if (Array.from(last).length < minChars) { stamp('CLOSED'); return; }
  }

  // Consecutive closed-gate turns. Read by message-display.js, which stops
  // suppressing at 2.
  let suppressed = 0;
  try {
    const digits = fs.readFileSync(suppressedFile, 'utf8').replace(/[^0-9]/g, '');
    suppressed = digits ? parseInt(digits, 10) : 0;
  } catch { suppressed = 0; }
  suppressed += 1;
  try { fs.writeFileSync(suppressedFile, String(suppressed)); } catch {}

  // Past STOP_MAX_RERUNS, stand down: stamp the gate (for interrupt
  // detection) and stop re-running.
  const stopMaxReruns = parseInt(digitsOrDefault(process.env.CLAUDE_ORIENTATION_STOP_MAX_RERUNS, '2'), 10);
  if (stopMaxReruns > 0 && suppressed > stopMaxReruns) { stamp('CLOSED'); return; }

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
  if (suppressed >= 2) {
    backstopLine = `
This is turn ${suppressed} in a row where the door was not gone through. Hiding
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
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'Stop', additionalContext: ctx }
  }) + '\n');
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
