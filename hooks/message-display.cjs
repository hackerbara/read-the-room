#!/usr/bin/env node
// Orientation — MessageDisplay. Replaces long pre-door assistant text with a
// placeholder. Display-only: the transcript and the model's context keep the
// original. Inert unless CLAUDE_ORIENTATION_SUPPRESS is 1/on/true/yes.
// Ported from message-display.sh. Never exits non-zero; any silent return
// displays the original.

const fs = require('fs');
const os = require('os');
const path = require('path');

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

// printf "%s" semantics for a single argument: first %s consumes it, any
// further %s in a custom PLACEHOLDER_FMT get "" (no more args to cycle).
function printfS(fmt, val) {
  let used = false;
  return fmt.replace(/%s/g, () => {
    if (used) return '';
    used = true;
    return val;
  });
}

// wc -m counts Unicode codepoints, not UTF-16 units.
function countChars(str) { return Array.from(str).length; }

function countNewlines(str) {
  const m = str.match(/\n/g);
  return m ? m.length : 0;
}

// jq -c always appends a trailing newline.
function emit(displayContent) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'MessageDisplay', displayContent }
  }) + '\n');
}

// bash `$(...)` command substitution strips all trailing newlines; the
// buffered-delta append path uses a direct pipe instead and is unaffected.
function stripTrailingNL(s) {
  return s.replace(/\n+$/, '');
}

function run(raw) {
  // On by default. Opt out with CLAUDE_ORIENTATION_SUPPRESS=0/off/false/no.
  const suppress = process.env.CLAUDE_ORIENTATION_SUPPRESS;
  if (['0', 'off', 'false', 'no', 'OFF', 'FALSE', 'NO'].includes(suppress)) return;

  if (!raw) return;
  let input;
  try { input = JSON.parse(raw); } catch { return; }
  if (typeof input !== 'object' || input === null) return;

  const sessionId = jqStr(input.session_id, '');
  if (!sessionId) return;
  const messageId = jqStr(input.message_id, '');
  if (!messageId) return;
  // Both fields are always present on a real MessageDisplay payload. If they
  // are not, this is not one, and guessing at defaults could hold the screen
  // on a message whose end we would never see.
  if (!('final' in input) || !('delta' in input)) return;

  const turnId = jqStr(input.turn_id, '');
  const index = parseInt(digitsOrDefault(jqStr(input.index, '0'), '0'), 10);
  const isFinal = jqStr(input.final, 'false') === 'true';

  const base = path.join(os.tmpdir(), 'claude-orientation');
  const gateFile = path.join(base, `${sessionId}.gate`);
  if (!fs.existsSync(gateFile)) return;

  let status = '', gateTurn = '';
  try {
    [status, gateTurn] = readTokens(fs.readFileSync(gateFile, 'utf8'), 2);
  } catch {}

  // OPEN: pass through; flip to SPOKEN once this message finishes.
  if (status === 'OPEN') {
    if (isFinal) {
      try { fs.writeFileSync(gateFile, gateTurn ? `SPOKEN ${gateTurn}` : 'SPOKEN'); } catch {}
    }
    return;
  }

  // displayContent:"" rendering nothing is inferred, not documented.
  const emptyVal = process.env.CLAUDE_ORIENTATION_EMPTY || '';

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

  if (status !== 'CLOSED' && status !== 'SPOKEN' && status !== 'KEYED') return;

  const shortChars = parseInt(digitsOrDefault(process.env.CLAUDE_ORIENTATION_SHORT_CHARS, '150'), 10);
  const placeholderFmt = process.env.CLAUDE_ORIENTATION_PLACEHOLDER ||
    '⋯ working notes — %s lines · press ctrl+O to expand';

  const suppressedFile = path.join(base, `${sessionId}.suppressed`);
  let suppressed = 0;
  try {
    const digits = fs.readFileSync(suppressedFile, 'utf8').replace(/[^0-9]/g, '');
    suppressed = digits ? parseInt(digits, 10) : 0;
  } catch { suppressed = 0; }

  // At 2 consecutive closed-gate turns the door is broken; stop suppressing.
  if (suppressed >= 2) {
    const notedFile = path.join(base, `${sessionId}.notedturn`);
    let noted = '';
    try { noted = fs.readFileSync(notedFile, 'utf8'); } catch {}
    if (index === 0 && turnId && noted !== turnId) {
      try { fs.writeFileSync(notedFile, turnId); } catch {}
      const delta = stripTrailingNL(jqStr(input.delta, ''));
      emit(`_(the door hasn't been gone through for ${suppressed} turns; nothing is being held back)_
${delta}`);
    }
    return;
  }

  // Buffer the whole message: the length threshold cannot be applied until it
  // ends, which is why the placeholder is emitted at `final`, not at index 0.
  const msgDir = path.join(base, 'msg');
  try { fs.mkdirSync(msgDir, { recursive: true }); } catch { return; }
  const safeMsg = messageId.replace(/[^A-Za-z0-9._-]/g, '');
  if (!safeMsg) return;
  const buf = path.join(msgDir, `${sessionId}.${safeMsg}`);

  const delta = jqStr(input.delta, '');
  try { fs.appendFileSync(buf, delta); } catch { return; }

  // Not the end yet. Hold the screen.
  if (!isFinal) { emit(emptyVal); return; }

  let content;
  try { content = fs.readFileSync(buf, 'utf8'); }
  catch { try { fs.unlinkSync(buf); } catch {} return; }

  const chars = countChars(content);

  if (chars < shortChars) {
    // The trivial-turn exemption. "ok, continue" never pays the ceremony.
    // Bash builds this one via $(jq ...) + printf '%s', which drops the
    try { fs.unlinkSync(buf); } catch {}
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'MessageDisplay', displayContent: content }
    }) + '\n');
    return;
  }

  // wc -l counts newlines, so a long single line with no trailing newline
  // reports zero. Report what a reader would count instead.
  let lines = countNewlines(content);
  if (lines <= 0) lines = 1;
  try { fs.unlinkSync(buf); } catch {}

  let placeholder = printfS(placeholderFmt, String(lines));

  // Once per session, on the first hidden message.
  const explainedFile = path.join(base, `${sessionId}.explained`);
  if (!fs.existsSync(explainedFile)) {
    try { fs.writeFileSync(explainedFile, ''); } catch {}
    placeholder = `${placeholder}

  Claude is working in its own room. Long stretches of working-out stay there
  instead of coming to you — nothing is deleted, and ctrl+O opens all of it.

  If a reply doesn't meet where you are — your terms, your sense of the
  problem, something you already told it — say so. It keeps a running model of
  you and will update it.

  (Shown once per session.)`;
  }

  // Record what this turn hid: turn token, and accumulated hidden char count.
  const turnsFile = path.join(base, `${sessionId}.turns`);
  let turnNow = '';
  try { turnNow = fs.readFileSync(turnsFile, 'utf8').replace(/[^0-9]/g, ''); } catch {}
  if (turnNow) {
    try { fs.writeFileSync(path.join(base, `${sessionId}.hidden`), turnNow); } catch {}
    // SPOKEN only: text hidden after the reply already crossed the gate.
    if (status === 'SPOKEN') {
      try { fs.writeFileSync(path.join(base, `${sessionId}.aftertalk`), turnNow); } catch {}
    }
    const workspaceFile = path.join(base, `${sessionId}.workspace`);
    let wsTurn = '', wsCount = '';
    try { [wsTurn, wsCount] = readTokens(fs.readFileSync(workspaceFile, 'utf8'), 2); } catch {}
    let wsCountNum = parseInt(digitsOrDefault(wsCount, '0'), 10);
    if (wsTurn !== turnNow) wsCountNum = 0;
    wsCountNum += chars;
    try { fs.writeFileSync(workspaceFile, `${turnNow} ${wsCountNum}`); } catch {}
  }

  emit(placeholder);
}

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { data += c; });
process.stdin.on('end', () => {
  try { run(data); } catch {}
});
