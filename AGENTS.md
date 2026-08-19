# Working in this repo

## What this is

Read the Room is a Claude Code plugin. It makes the agent read a file it keeps
about the person it is working with — what they asked for, their words, what
they have already settled — in the moment before it replies, and decide whether
what it is about to say is what was wanted.

That moment is *the door*. The file is the *orientation file*. Nothing here
inspects or blocks a reply; the plugin creates the moment, and what happens in
it is the agent's.

`README.md` explains it to users. `how-it-works.md` describes the mechanism.

## The pieces

Four hooks and one MCP server. They do not call each other — they coordinate
through small files in a per-session state directory under the system temp dir.

| file | event | job |
|---|---|---|
| `hooks/session-start.cjs` | `SessionStart` | creates the session's orientation file from a template; injects the guidance document — full on startup, brief on resume or compact |
| `hooks/reinject.cjs` | `UserPromptSubmit` | owns the turn counter; shuts the door at the top of each turn; writes the session pointers the server resolves against |
| `hooks/message-display.cjs` | `MessageDisplay` | replaces long pre-door text with a one-line marker; marks the gate `SPOKEN` once a reply has crossed |
| `hooks/stop-gate.cjs` | `Stop` | if the turn ended without the door, says so; if text was written after the reply, says that instead |
| `server/index.js` | MCP | exposes `read_the_room`: opens the gate, returns the orientation file and facts about it |

The **gate** is the shared state, a file containing `<status> <turn> [stopped]`:

- `CLOSED` — the door has not been used this turn; long text is hidden
- `OPEN` — it has; the next message reaches the user
- `SPOKEN` — a reply has crossed; hiding resumes, and a second reply needs a
  second crossing

All four hooks and the server read or write this format. Changing it means
changing all five.

## Where things live

```
.claude-plugin/plugin.json       plugin manifest
.claude-plugin/marketplace.json  the repo is its own marketplace
.mcp.json                        registers the server; the key becomes the tool's namespace
hooks/hooks.json                 binds hooks to events
hooks/*.cjs                      the four hooks
server/index.js                  the MCP server
docs/orientation.md              guidance for the agent, full — users edit this
docs/orientation-brief.md        guidance, short form — users edit this
docs/orientation-template.txt    the empty orientation file a session starts from
tests/session-start.test.js      clean install, and not clobbering user edits
README.md, how-it-works.md       user-facing
```

Everything in `docs/` is copied on first run into `CLAUDE_PLUGIN_DATA`, which
survives plugin updates, and read from there. The copy uses `COPYFILE_EXCL`, so
user edits are never overwritten — which also means editing a template does not
reach anyone who already installed.

## Invariants

**Fail open.** Every hook wraps its work, prints nothing on any error path, and
never exits non-zero. A hook that throws can leave a user unable to see their
agent.

**Only the reply reaches the user.** The orientation file is never displayed in
any mode. Hidden text is display-only: it stays in the transcript and `ctrl+O`
opens it. Nothing is deleted.

**Hiding must be able to switch itself off.** Two consecutive turns without a
`read_the_room` call and it stops. Any new path that hides output needs the
same escape.

**Nothing judges the reply.** No code here reads what the agent wrote and scores
it. A change that requires that is a different project.

## Conventions

**Comments under 15%, and only mechanical facts not visible from the code** —
that `jq` appends a trailing newline where `JSON.stringify` does not, that a
value is inferred rather than documented, that two files share a format. No
design rationale, no explaining why a decision was made, no second person, no
restating the line below. If a comment reads as persuasion, delete it.

**Vocabulary is fixed**, in code and in any string a human or the model reads:
*Claude*, *you*, *reply*, *working notes*, *the orientation file*, *the door*,
*hiding*, *the marker*. `gate` is an implementation word and must not appear in
text anyone reads.

**Node core only** — `fs`, `os`, `path`, `crypto`. The MCP SDK is the server's
only dependency.

**Hooks are `.cjs` on purpose.** The root `package.json` sets `"type": "module"`
for the ESM server; renaming them `.js` breaks all four.

**Hooks are declared in exec form** — `"command": "node", "args": [...]`. Shell
form falls through to PowerShell on Windows without Git Bash and fails with no
error. This is why they are Node and not shell.

**Platform rules with no local symptom:** `os.tmpdir()`, never
`process.env.TMPDIR`, which Windows does not set. Read stdin asynchronously via
`process.stdin` events — `fs.readFileSync(0)` is broken on Windows when stdin is
a pipe. Split on `/\r?\n/`. Build paths with `path.join`.

**`package-lock.json` is required.** Without it the plugin installer skips
`npm ci` and the server starts with no SDK. It must be an npm lockfile; yarn and
pnpm lockfiles are ignored.

## Testing

```sh
node --test tests/session-start.test.js
```

Exercise a hook directly. Use a scratch state directory, never the live one:

```sh
TMPDIR=$(mktemp -d) node hooks/stop-gate.cjs <<< '{"session_id":"x","stop_hook_active":false}'
```

Check the manifests:

```sh
claude plugin validate .
```

Validation passing does not mean the plugin works. Because every hook fails
silently by design, a broken one and a working one look identical from outside.
Install it somewhere disposable and run a real session before believing a
change landed.
