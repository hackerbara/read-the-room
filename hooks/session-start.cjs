#!/usr/bin/env node
// Orientation — SessionStart hook. Ensures this session has an orientation
// file and injects its text into context on startup/resume/clear/compact/fork.
// Ported from session-start.sh.

const fs = require('fs');
const os = require('os');
const path = require('path');

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

// Docs directory, in priority order: CLAUDE_PLUGIN_DATA (persists across
// plugin updates) > legacy ~/.claude/orientation (non-plugin install) >
// CLAUDE_PLUGIN_ROOT/docs (plugin install, no data dir available).
function resolveDocsDir(legacyHome) {
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginData) {
    if (pluginRoot) {
      const srcDir = path.join(pluginRoot, 'docs');
      copyTemplateIfMissing(pluginData, srcDir, 'orientation.md');
      copyTemplateIfMissing(pluginData, srcDir, 'orientation-brief.md');
    }
    return { dir: pluginData, fullName: 'orientation.md', briefName: 'orientation-brief.md' };
  }
  if (!pluginRoot) {
    return { dir: legacyHome, fullName: 'ORIENTATION.md', briefName: 'ORIENTATION-BRIEF.md' };
  }
  return { dir: path.join(pluginRoot, 'docs'), fullName: 'orientation.md', briefName: 'orientation-brief.md' };
}

function run(raw) {
  const orientHome = path.join(os.homedir(), '.claude', 'orientation');
  const docs = resolveDocsDir(orientHome);
  const fullDoc = path.join(docs.dir, docs.fullName);
  const briefDoc = path.join(docs.dir, docs.briefName);
  const template = path.join(orientHome, 'orientation-template.txt');
  let text = fullDoc;
  if (!readable(text)) return;

  let input;
  try { input = JSON.parse(raw); } catch { input = {}; }
  if (typeof input !== 'object' || input === null) input = {};

  let sessionId = jqStr(input.session_id, '');
  // jq's `// "startup"` only fires on null/false/missing; an empty string
  // source would pass through as "" in bash too, then get caught by the
  // `[ -n "$SOURCE" ] || SOURCE="startup"` fallback line — same net effect.
  let source = jqStr(input.source, 'startup');
  if (!source) source = 'startup';

  if (source !== 'startup' && readable(briefDoc)) text = briefDoc;
  if (!sessionId) sessionId = process.env.CLAUDE_CODE_SESSION_ID || 'unknown';

  const base = path.join(os.tmpdir(), 'claude-orientation');
  try { fs.mkdirSync(base, { recursive: true }); } catch { return; }

  const orientFile = path.join(base, `${sessionId}.orientation.txt`);
  const turnsFile = path.join(base, `${sessionId}.turns`);

  if (!fs.existsSync(orientFile) && readable(template)) {
    try {
      const tpl = fs.readFileSync(template, 'utf8');
      fs.writeFileSync(orientFile, tpl.split('{{SESSION_ID}}').join(sessionId));
    } catch {}
  }
  if (!fs.existsSync(turnsFile)) {
    try { fs.writeFileSync(turnsFile, '0'); } catch {}
  }

  // Hook stdout is truncated at 102400 bytes; the text plus the live slice
  // below stays well under that.
  let context = stripTrailingNL(fs.readFileSync(text, 'utf8'));
  context = `${context}

---

## This session's files

- orientation file: \`${orientFile}\`

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
