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
