#!/usr/bin/env node
// Orientation — SessionStart hook. Ensures this session has an orientation
// file and injects its text into context on startup/resume/clear/compact/fork.
// Ported from session-start.sh.

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

function readable(p) {
  try { fs.accessSync(p, fs.constants.R_OK); return true; } catch { return false; }
}

// bash `$(...)` command substitution strips all trailing newlines from what
// it captures; both CONTEXT=$(cat ...) and LIVE=$(head -c ...) rely on this.
function stripTrailingNL(s) {
  return s.replace(/\n+$/, '');
}

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function readTokens(content, n) {
  const line = (content || '').split(/\r?\n/)[0] || '';
  const parts = line.trim().split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < n; i++) out.push(parts[i] || '');
  return out;
}

function splitSections(text) {
  const out = []; let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) { if (cur) out.push(cur); cur = { header: line.slice(3).trim(), body: [] }; }
    else if (cur) cur.body.push(line);
  }
  if (cur) out.push(cur);
  return out.map(s => ({ header: s.header, hash: sha256(s.body.join('\n')) }));
}

function renderStateV2(turn, fileHash, entries) {
  return [`${turn} ${fileHash}`,
    ...entries.map(e => `${e.changed} ${e.affirmed || '-'} ${e.hash} ${e.header}`)].join('\n') + '\n';
}

function writeAtomic(p, content) {
  const tmp = `${p}.tmp${process.pid}`;
  fs.writeFileSync(tmp, content); fs.renameSync(tmp, p);
}

// Copies name from srcDir to destDir if absent at dest. Never overwrites.
// Fails open: any error (unwritable dest, missing src) is swallowed.
function copyTemplateIfMissing(destDir, srcDir, name) {
  const dest = path.join(destDir, name);
  if (fs.existsSync(dest)) return;
  const src = path.join(srcDir, name);
  if (!readable(src)) return;
  try {
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
  } catch {}
}

// Docs directory, in priority order: host data (persists across plugin
// updates) > host root > the legacy Claude orientation directory.
function resolveDocsDir(host, legacyHome) {
  const codex = host === 'codex';
  const pluginData = process.env[codex ? 'PLUGIN_DATA' : 'CLAUDE_PLUGIN_DATA'];
  const pluginRoot = process.env[codex ? 'PLUGIN_ROOT' : 'CLAUDE_PLUGIN_ROOT'];
  if (pluginData) {
    if (pluginRoot) {
      const srcDir = path.join(pluginRoot, 'docs');
      copyTemplateIfMissing(pluginData, srcDir, 'orientation.md');
      copyTemplateIfMissing(pluginData, srcDir, 'orientation-brief.md');
      copyTemplateIfMissing(pluginData, srcDir, 'orientation-template.txt');
    }
    return {
      dir: pluginData,
      fullName: 'orientation.md',
      briefName: 'orientation-brief.md',
      templateName: 'orientation-template.txt',
    };
  }
  if (!pluginRoot) {
    if (codex) {
      return {
        dir: legacyHome,
        fullName: 'orientation.md',
        briefName: 'orientation-brief.md',
        templateName: 'orientation-template.txt',
      };
    }
    return {
      dir: legacyHome,
      fullName: 'ORIENTATION.md',
      briefName: 'ORIENTATION-BRIEF.md',
      templateName: 'orientation-template.txt',
    };
  }
  return {
    dir: path.join(pluginRoot, 'docs'),
    fullName: 'orientation.md',
    briefName: 'orientation-brief.md',
    templateName: 'orientation-template.txt',
  };
}

function hostFromArgs(argv) {
  const index = argv.indexOf('--host');
  return index >= 0 && argv[index + 1] === 'codex' ? 'codex' : 'claude';
}

function renderChannels(text, host, replacement = '') {
  const pattern = /<!-- read-the-room:channel:start -->\r?\n([\s\S]*?)\r?\n<!-- read-the-room:channel:end -->/g;
  const blocks = [...text.matchAll(pattern)];
  if (blocks.length === 0) return host === 'claude' ? text : null;
  if (host === 'claude') return text.replace(pattern, (_, body) => body);
  const replacements = [...replacement.matchAll(pattern)];
  if (replacements.length !== blocks.length) return null;
  let index = 0;
  return text.replace(pattern, () => replacements[index++][1]);
}

function normalizeCodexBrief(text) {
  const marker = '<!-- read-the-room:channel:start -->';
  const legacyPreamble = `You have been here before in this session; this is the short form. The full
document is listed at the end of this message if you want it.

`;
  if (!text.startsWith(legacyPreamble + marker)) return text;
  return text.slice(legacyPreamble.length);
}

function run(raw) {
  const host = hostFromArgs(process.argv.slice(2));
  const orientHome = path.join(os.homedir(), '.claude', 'orientation');
  const docs = resolveDocsDir(host, orientHome);
  const fullDoc = path.join(docs.dir, docs.fullName);
  const briefDoc = path.join(docs.dir, docs.briefName);
  const template = path.join(docs.dir, docs.templateName);

  let input;
  try { input = JSON.parse(raw); } catch { input = {}; }
  if (typeof input !== 'object' || input === null) input = {};

  let sessionId = jqStr(input.session_id, '');
  // jq's `// "startup"` only fires on null/false/missing; an empty string
  // source would pass through as "" in bash too, then get caught by the
  // `[ -n "$SOURCE" ] || SOURCE="startup"` fallback line — same net effect.
  let source = jqStr(input.source, 'startup');
  if (!source) source = 'startup';

  if (!sessionId) sessionId = process.env.CLAUDE_CODE_SESSION_ID || 'unknown';

  const base = path.join(os.tmpdir(), 'claude-orientation');
  try { fs.mkdirSync(base, { recursive: true }); } catch { return; }

  const orientFile = path.join(base, `${sessionId}.orientation.txt`);
  const turnsFile = path.join(base, `${sessionId}.turns`);

  if (!fs.existsSync(orientFile) && readable(template)) {
    try {
      const tpl = fs.readFileSync(template, 'utf8');
      const seeded = tpl.split('{{SESSION_ID}}').join(sessionId);
      fs.writeFileSync(orientFile, seeded);
      const sections = splitSections(seeded);
      const fileHash = sha256(seeded);
      const entries = sections.map(s => ({ changed: '0', affirmed: null, hash: s.hash, header: s.header }));
      writeAtomic(path.join(base, `${sessionId}.state`), renderStateV2('0', fileHash, entries));
      writeAtomic(path.join(base, `${sessionId}.seed`),
        [fileHash, ...sections.map(s => `${s.hash} ${s.header}`)].join('\n') + '\n');
    } catch {}
  }
  if (!fs.existsSync(turnsFile)) {
    try { fs.writeFileSync(turnsFile, '0'); } catch {}
  }

  let text = fullDoc;
  if (source !== 'startup' && readable(briefDoc)) text = briefDoc;
  let sourceText = '';
  try { sourceText = fs.readFileSync(text, 'utf8'); } catch {
    if (host === 'claude') return;
  }
  if (host === 'codex' && text === briefDoc) sourceText = normalizeCodexBrief(sourceText);
  let replacement = '';
  if (host === 'codex') {
    const root = process.env.PLUGIN_ROOT;
    const channelName = text === briefDoc ? 'codex-channel-brief.md' : 'codex-channel.md';
    try { replacement = fs.readFileSync(path.join(root, 'docs', channelName), 'utf8'); } catch {}
  }
  const rendered = renderChannels(sourceText, host, replacement);

  // Hook stdout is truncated at 102400 bytes; the text plus the live slice
  // below stays well under that.
  let context = rendered === null ? '' : stripTrailingNL(rendered);
  const divider = context ? '\n\n---\n\n' : '';
  const fileLines = [`- orientation file: \`${orientFile}\``];
  if (host === 'claude') fileLines.push(`- full orientation document: \`${fullDoc}\``);
  context = `${context}${divider}## This session's files

${fileLines.join('\n')}

The workspace is not a file. It is the text you write in the turn, before
calling \`read_the_room\`.
`;

  // Restores prior orientation text here, which is what survives a compaction.
  if (source !== 'startup') {
    let stat = null;
    try { stat = fs.statSync(orientFile); } catch {}
    if (stat && stat.size > 0) {
      const live = stripTrailingNL(fs.readFileSync(orientFile).subarray(0, 4000).toString('utf8'));
      context = `${context}
This session already has orientation on file. It was written before this
point in the conversation and survives what was just dropped. Read it as
current unless something in view contradicts it, and bring it up to date as
you go.

\`\`\`
${live}
\`\`\`
`;
    }
  }

  // Compaction can strand a same-turn key: the nonce itself still lives in
  // `<sid>.key` and comes back via a bare door re-call (spec §6/§7), but a
  // freshly-compacted context has no way to know one is outstanding unless
  // this says so. Content-blind, like the rest of the door: existence and
  // turn-currency only, never what the key's reasons are about.
  if (source === 'compact') {
    let keyTurn = '';
    try { [, keyTurn] = readTokens(fs.readFileSync(path.join(base, `${sessionId}.key`), 'utf8'), 2); } catch {}
    let curTurn = '';
    try { curTurn = fs.readFileSync(turnsFile, 'utf8').replace(/[^0-9]/g, ''); } catch {}
    if (keyTurn && curTurn && keyTurn === curTurn) {
      context = `${context}
This session has an outstanding upkeep key from before the compaction — a
bare \`read_the_room\` call re-presents it.
`;
    }
  }

  // jq -c always appends a trailing newline.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context }
  }) + '\n');
}

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { data += c; });
process.stdin.on('end', () => {
  try { run(data); } catch {}
});
