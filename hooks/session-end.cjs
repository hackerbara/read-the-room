#!/usr/bin/env node
// Orientation — SessionEnd hook. Removes the ending session's state files
// (all `<sid>.*` under the base dir) so they don't linger past the turn
// they belong to. reinject.cjs's mtime sweep is the crash-cover backstop
// for sessions that never reach here (see spec §13/§14).

const fs = require('fs');
const os = require('os');
const path = require('path');

function jqStr(v, fb) {
  if (v === undefined || v === null || v === false) return fb;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return fb;
}

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

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { data += c; });
process.stdin.on('end', () => {
  try { run(data); } catch {}
});
