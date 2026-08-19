# Codex Compatibility Design

**Status:** Approved for implementation
**Target release:** `1.1.0`

## Goal

Make the existing Read the Room plugin installable and usable in Codex while
preserving the current Claude Code experience.

Codex receives the same orientation file, `read_the_room` door, staleness
handling, and missed-door backstop. Codex does not pretend that pre-door
assistant language is hidden: ordinary assistant language remains visible in
that host until Codex provides a supported display-interception seam.

## Scope

This change includes:

- one repository and one release version for Claude Code and Codex;
- a Codex plugin manifest, Codex hook manifest, and Codex MCP configuration;
- small host adapters where the two hook protocols or display contracts differ;
- host-accurate orientation and tool wording;
- automated compatibility tests and a manual Codex acceptance pass;

This change does not include:

- a privacy policy, retention system, or legal/compliance work;
- universal Plugins Directory submission;
- a custom Codex client, renderer patch, or attempt to simulate hiding;
- a global skill that rewrites every response;
- redesigning the orientation discipline or the Claude Code experience.

## Experience contract

| Capability | Claude Code | Codex |
|---|---:|---:|
| Per-session orientation file | yes | yes |
| Session-start and post-compaction orientation | yes | yes |
| `read_the_room` MCP door | yes | yes |
| Missed-door Stop backstop | yes | yes |
| Pre-door language hidden and recoverable | yes | no |
| Host makes a false promise about hiding | no | no |

The Codex limitation is a degraded display capability, not a failed session.
The agent may still use ordinary language as workspace, but the Codex-facing
instructions must say that this language remains visible. The door still marks
the point where the agent reads its orientation and prepares the addressed
reply.

## Package architecture

The existing Claude package remains the default Claude path:

- `.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`
- `.mcp.json`
- `hooks/hooks.json`, including `MessageDisplay`

Codex adds:

- `.codex-plugin/plugin.json`
- `hooks/codex-hooks.json`
- `codex.mcp.json`

`.codex-plugin/plugin.json` explicitly points to `hooks/codex-hooks.json` and
`codex.mcp.json`. That explicit hook path prevents Codex from loading the
Claude default `hooks/hooks.json`, whose `MessageDisplay` event Codex does not
support. The repository `.gitignore` must explicitly allow `.codex-plugin/`.

Disposable runtime probes against both the Desktop-embedded Codex
`0.148.0-alpha.9` and standalone CLI `0.144.6` confirmed these two custom
manifest paths: `plugin/read` listed the hook from `hooks/codex-hooks.json` and
the MCP server from `codex.mcp.json`, and the fixture installed successfully.
The repository's current local plugin-creator validator has an older,
conflicting schema, so release validation uses the current runtime and official
contract rather than that helper alone.

The existing `.claude-plugin/marketplace.json` remains the shared marketplace
entry. A disposable local check with the installed `codex-cli 0.144.6`
recognized this repository through that legacy-compatible marketplace and
installed `read-the-room@read-the-room`. This design does not add a second
marketplace file unless the clean Git-backed installation test demonstrates a
need for one.

## Host selection

Codex hook commands invoke the shared scripts with `--host codex`, and the
Codex MCP configuration invokes the shared server with the same argument. An
absent host argument continues to mean Claude, preserving the existing package
behavior.

Host selection controls only genuine host differences:

- which orientation documents SessionStart loads;
- the Stop hook's continuation response shape;
- the MCP tool description and host-specific response lines;
- whether display/suppression bookkeeping is active.

It does not fork the orientation state machine or duplicate the MCP tool.

## Hooks

`hooks/codex-hooks.json` registers only:

- `SessionStart`
- `UserPromptSubmit`
- `Stop`

The existing JavaScript hook implementations remain shared.

### SessionStart

SessionStart creates the per-session orientation file, injects the appropriate
full or brief orientation document, and restores live orientation after resume
or compaction. Codex uses `PLUGIN_ROOT` and `PLUGIN_DATA`; Claude continues to
use its existing variables. Codex's compatibility variables may be accepted,
but host selection must not depend on them.

### UserPromptSubmit

UserPromptSubmit continues to publish the session pointers, advance the turn,
close the gate, and reinject stale orientation. Its model-context output is
kept within Codex's supported output shape.

### Stop

The state decision remains shared, but the emitted protocol differs:

- Claude keeps its existing continuation output.
- Codex emits `{"decision":"block","reason":"..."}` when the door was
  missed, which asks Codex to continue the turn.

The existing short-reply exemption and rerun cap remain. Missing state, an
unavailable orientation file, or a repeated continuation fails open rather
than looping or blocking the user.

Claude-only suppression files and messages (`hidden`, `workspace`,
`aftertalk`, and related counters) do not affect Codex output.

## Orientation and door wording

The current Claude orientation documents retain their display contract. The
shared orientation source isolates the host-dependent channel passages into a
small host fragment or substitution rather than maintaining two full copies.
The Codex rendering preserves the existing epistemic and threshold discipline
while removing claims that:

- pre-door language costs the user nothing;
- long text is replaced with a marker;
- hidden text can be expanded with Claude Code controls;
- workspace-character counts represent text withheld from the user.

The Codex variant states plainly that ordinary assistant language remains
visible. It does not tell the agent to compress its thinking or route it into a
tool argument.

The `read_the_room` tool name, input, state transition, and orientation return
remain shared. Its Codex description and response omit hidden-display claims
and suppression-derived measurements. Its Claude description remains
unchanged.

## Installed runtime

The plugin must run from the copy placed in the Codex plugin cache, not by
accidentally reaching back into the development checkout. The first packaging
test therefore uses a clean Git-backed installation with no repository
`node_modules` available.

A clean tracked-file installation into a disposable Codex home confirmed the
failure: Codex copied the plugin without `node_modules`, and the cached server
exited with `ERR_MODULE_NOT_FOUND` for `@modelcontextprotocol/sdk`. The release
therefore commits one bundled Node server artifact and points both host
configurations at it. This is packaging for the existing server, not a second
server implementation.

## Installation and acceptance

The verified local installation shape uses the existing marketplace identity:

```sh
CODEX_HOME=<temporary-home> codex plugin marketplace add /absolute/path/to/read-the-room
CODEX_HOME=<temporary-home> codex plugin add read-the-room@read-the-room
```

Before release, the equivalent Git-backed path must also succeed:

```sh
codex plugin marketplace add hackerbara/read-the-room --ref main
codex plugin add read-the-room@read-the-room
```

Installation and hook trust are separate. Codex skips changed, untrusted hooks
until the user reviews them. The README must include that one required trust
step and the need to start a new task after installation.

The manual Codex acceptance pass uses a fresh task and confirms:

1. the plugin installs and enables from its cached copy;
2. the three supported hooks load after trust;
3. SessionStart injects Codex-accurate orientation;
4. `read_the_room` is available and resolves the same session as the hooks;
5. crossing the door opens the current turn's gate;
6. missing the door follows the existing bounded rerun policy and never loops
   without limit;
7. pre-door language remains visible;
8. no Codex-facing text claims that it was hidden.

The session-resolution check is the first integration threshold: hook payloads
and the separately spawned MCP process must converge on the same orientation
and gate files.

## Verification

Automated verification covers:

- clean orientation startup under Claude and Codex plugin environments;
- preservation of user-edited orientation templates;
- the Claude hook manifest still containing `MessageDisplay`;
- the Codex hook manifest containing only supported events;
- host-correct SessionStart, UserPromptSubmit, and Stop output shapes;
- Stop continuation limits and fail-open cases;
- MCP session resolution and gate opening;
- absence of hidden-display claims and measurements in Codex mode;
- startup of the MCP server from a clean cached install without access to the
  development checkout;
- plugin discovery and installation inside a disposable `CODEX_HOME`;
- unchanged Claude hiding behavior through focused regression tests.

Before publishing, run a mechanical PII scan over the exact tracked release
files and test fixtures. Probe output, local absolute paths, real session data,
and the existing untracked `probes/` directory are not release inputs. This is
a release-content check, not a new product subsystem or policy document.

## Documentation and release

README changes are limited to:

- a short Claude/Codex capability table;
- Codex installation and hook-trust instructions;
- one explicit sentence that Codex does not currently hide pre-door language.

`how-it-works.md` receives only the qualification needed to keep its display
claims host-accurate.

The compatibility release is `1.1.0`. `package.json`, `package-lock.json`, the
Claude manifest, and the Codex manifest use the same version. Release occurs
only after the automated checks, clean-cache install, manual Codex acceptance,
Claude regression, and release-file PII pass succeed.
