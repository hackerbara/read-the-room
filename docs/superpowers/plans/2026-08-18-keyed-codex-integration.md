# Keyed Door + Codex Integration Plan

**Goal:** Integrate the proven Codex/BB Read the Room workflow into the newly merged keyed-door implementation on `main` without regressing Claude, key, stay, compaction, or existing-install behavior.

**Architecture:** Start from a fresh worktree at current `main`. Treat main's keyed state machine and prose as authoritative, then deliberately port the Codex host boundary from `codex/codex-compat-implementation`. Do not merge the branches wholesale and do not import the Codex branch's pre-keyed server or bundle.

**Specs:**
- `docs/superpowers/specs/2026-08-18-keyed-door-design.md`
- `docs/superpowers/specs/2026-08-18-codex-compatibility-design.md`

## Invariants

- Preserve main's key, return, affirm, stay, snooze, ledger, and compaction behavior.
- Codex registers only SessionStart, UserPromptSubmit, and Stop; it does not register MessageDisplay.
- Claude retains MessageDisplay/SPOKEN, unseen-marker, suppression, and aftertalk behavior.
- Codex continuation uses `{ "decision": "block", "reason": "..." }` and its own `.codex-reruns` accounting.
- Codex workspace text streams normally; BB may group that already-visible text into its native Worked-for presentation afterward.
- Never overwrite user-edited orientation documents. Markerless existing Claude documents continue to inject unchanged.
- Hooks fail open. Existing gate/state/seed formats remain readable.
- Do not restore SessionEnd cleanup.
- Runtime support is Node.js 18 or newer.
- Preserve unrelated worktree changes; perform integration in a new worktree from current main.

## Task 1: Establish the integration branch and reproducible keyed bundle

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Regenerate: `dist/read-the-room-server.js`
- Modify: `tests/bundle.test.js`

- [ ] Create a fresh integration branch/worktree from current `main`; record the main SHA and Codex source SHA in the work log.
- [ ] Port/adapt the bundle provenance tests from `codex/codex-compat-implementation`. Do **not** copy `server/door.js` or `dist/read-the-room-server.js`.
- [ ] Add the build script and pinned build dependency used by the verified Codex package.
- [ ] Build `dist/read-the-room-server.js` only from main's keyed `server/index.js`, prove the committed bundle starts, and record its source SHA/hash.
- [ ] Run `node --test tests/bundle.test.js` and make it pass.
- [ ] Commit: `build: make keyed server bundle reproducible`

## Task 2: Make keyed SessionStart rendering host-aware

**Files:**
- Create or adapt: `docs/codex-channel.md`
- Create or adapt: `docs/codex-channel-brief.md`
- Modify: `docs/orientation.md`
- Modify: `docs/orientation-brief.md`
- Modify: `hooks/session-start.cjs`
- Modify: `tests/session-start.test.js`

- [ ] Inventory every host-dependent sentence in both current main documents before choosing marker seams. The opening and the later workspace section are independently host-dependent; either make shared prose host-neutral or support multiple marked regions.
- [ ] Add failing tests proving that Codex receives truthful workspace language and deny-list every false Claude-only promise, including `stays in your room`, `Nobody has to receive it`, hidden/marker cost claims, and `ctrl+O` language.
- [ ] Add regression tests proving Claude output is unchanged, markerless persisted Claude documents inject unchanged, user-edited files are not overwritten, `.state` and `.seed` initialization survives, and compact mode still reports an outstanding key.
- [ ] Add channel markers around every channel-specific region in the current main documents; preserve main's gift/keyed-door prose and use the existing `codex-channel*.md` fragment convention.
- [ ] Implement one rendering path with these explicit fallbacks:
  - Claude + marked source: strip marker comments and keep the Claude block.
  - Claude + markerless source: inject the document unchanged.
  - Codex + marked source: replace the channel block with the Codex fragment.
  - Codex + markerless source: omit document context rather than claim hidden-message behavior that Codex does not provide.
- [ ] Preserve main's state, seed, and compact-reminder logic byte-for-byte where host rendering does not require a change.
- [ ] Prove host selection comes only from `--host`; Codex resolves `PLUGIN_ROOT`/`PLUGIN_DATA`, Claude resolves `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA`, and existing files remain untouched.
- [ ] Run `node --test tests/session-start.test.js`.
- [ ] Commit: `feat: render keyed orientation for Codex`

## Task 3: Preserve UserPromptSubmit-to-MCP session identity

**Files:**
- Modify: `hooks/reinject.cjs`
- Modify: `tests/reinject.test.js`
- Modify: integration tests covering hook-to-MCP session resolution

- [ ] Add a failing direct integration test that runs Codex SessionStart and then `reinject.cjs --host codex` with distinct `PLUGIN_ROOT` and `PLUGIN_DATA`.
- [ ] Assert UserPromptSubmit emits no stdout, closes the same gate as `CLOSED 1`, maintains the v2 sidecar plus global/cwd/ppid pointers, and never selects Codex from environment inference alone.
- [ ] Start the separately spawned bundled MCP and prove it resolves the same session id, key, gate, and orientation file created by the hooks.
- [ ] Preserve Claude reinjection and sidecar behavior unchanged; defer installed-manifest command assertions to Task 6.
- [ ] Run the focused reinject and hook-to-MCP integration tests.
- [ ] Commit: `feat: share keyed session identity with Codex`

## Task 4: Make the keyed MCP door truthful on Codex

**Files:**
- Create: `server/host.mjs`
- Modify: `server/index.js`
- Modify: `tests/door.test.js`
- Regenerate: `dist/read-the-room-server.js`

- [ ] Add failing tests that start the real stdio MCP server with `--host codex` and verify:
  - Codex-facing tool and stay descriptions are truthful.
  - Every Codex response path omits `Workspace this turn` and unseen-marker warnings: missing orientation, no-key open, key issue, bare replay, failed return/fumble, successful return, stand-down, and stay with/without an outstanding key.
  - Setup-key issuance, fact append, nonce return, and gate reopening still work.
  - `stay` preserves keyed state and says streamed workspace remains visible while no new addressed reply is produced.
- [ ] Add Claude counterparts proving its workspace/unseen presentation remains intact across the same meaningful paths.
- [ ] Add a small pure presentation module (`hostFromArgs`, `toolDescription`, `stayDescription`, `stayResponse`). Do not move or fork keyed state-machine logic.
- [ ] Keep main's `server/logic.mjs`, key verification, ledger writes, and gate transitions authoritative.
- [ ] Select only host-facing description/response text in `server/index.js`; do not create separate Claude and Codex servers.
- [ ] Run source tests before rebuilding the bundle: `node --test tests/door.test.js`.
- [ ] Run `npm run build`, then rerun the door tests against the packaged entry point.
- [ ] Commit: `feat: adapt keyed door presentation for Codex`

## Task 5: Add Codex continuation semantics to the keyed Stop gate

**Files:**
- Modify: `hooks/stop-gate.cjs`
- Modify: `tests/stop-gate.test.js`

- [ ] Add failing tests for Codex output at CLOSED, KEYED, and the STAY cap.
- [ ] Add failing tests for a turn-keyed `.codex-reruns` counter: CLOSED and KEYED share and increment it, OPEN/success resets it, and the cap prevents an infinite rerun loop.
- [ ] Prove one logical KEYED turn records exactly one raw `lapsed` ledger event and one logical STAYED turn increments the stay streak exactly once, even when Codex reruns without Claude's `stop_hook_active` signal.
- [ ] Prove OPEN, SPOKEN, and legal STAY completion cannot inherit stale rerun counts; preserve KEYED's exemption from `MIN_CHARS`.
- [ ] Add regression tests proving Codex never creates or consumes Claude `.suppressed`, `.hidden`, `.unseen`, or `.aftertalk` coupling.
- [ ] Preserve Claude's existing output shape and all current KEYED/STAYED/stay-streak/ledger behavior.
- [ ] Preserve main's `MIN_CHARS=100` default unless an existing spec test establishes another value.
- [ ] Centralize only host selection and continuation emission; keep the gate state machine shared.
- [ ] Run `node --test tests/stop-gate.test.js`.
- [ ] Commit: `feat: continue keyed turns safely on Codex`

## Task 6: Add and exercise the coherent Codex package boundary

**Files:**
- Create: `.codex-plugin/plugin.json`
- Create: `codex.mcp.json`
- Create: `hooks/codex-hooks.json`
- Create or adapt: `tests/codex-package.test.js`
- Modify: cached hook-to-MCP integration tests
- Modify: `.gitignore`

- [ ] Add failing package tests for manifest/version consistency, exact plugin-relative MCP cwd/args, Windows command forms, Node `>=18`, `PLUGIN_ROOT`/`PLUGIN_DATA`, exclusion of Claude-only MessageDisplay, and `--host codex` on every registered hook/MCP command.
- [ ] Port the manifests from `codex/codex-compat-implementation` per file and point them only at the already tested keyed bundle from Task 4 and the Codex-correct hooks from Tasks 2, 3, and 5.
- [ ] Through a disposable cached install, run the actual manifest commands for SessionStart, UserPromptSubmit, separately spawned bundled MCP, and Stop; prove they resolve one session id/key/gate and use Codex continuation semantics.
- [ ] Prove the package starts through the manifest entry point in the same commit; never land an installable-looking manifest whose runtime is absent, pre-keyed, or still Claude-shaped.
- [ ] Run `node --test tests/codex-package.test.js tests/bundle.test.js` plus the cached hook-to-MCP integration test.
- [ ] Commit: `feat: add keyed Codex package boundary`

## Task 7: Reconcile release metadata, docs, and cached-install verification

**Files:**
- Create or port: `scripts/verify-codex-install.mjs`
- Create or port: `tests/codex-install.test.js`
- Create or port: `tests/release-metadata.test.js`
- Modify: `tests/codex-package.test.js`
- Modify: `tests/bundle.test.js`
- Modify: `README.md`
- Modify: `how-it-works.md`
- Modify: `docs/bb-conformance-note.md`
- Modify: package and plugin version files as required
- Regenerate: `dist/read-the-room-server.js`

- [ ] Port/adapt the cached-install, bundle, and release-metadata tests, including timeout behavior, cached-source/cached-runtime non-alias checks, symlink/path handling, synchronized metadata, and documentation assertions.
- [ ] Update the cached-install verifier for the keyed handshake: receive a setup key, append the fact, return the nonce, and assert the gate returns to OPEN.
- [ ] Synchronize release version `1.1.0`, Node `>=18`, manifest paths, and the committed bundle.
- [ ] Preserve main's key/stay explanation while adding the Codex/BB distinction: live workspace output remains visible and BB may subsequently group it into native work presentation.
- [ ] Keep `BB-RTR-001` as a separate upstream conformance note about recoverability when completed content differs from streamed content; do not describe it as required for the plugin to work.
- [ ] Run `npm ci`, `npm test`, `npm run build`, and `npm run verify:codex-install`.
- [ ] Assert the committed bundle is reproducible: `git diff --exit-code -- dist/read-the-room-server.js`.
- [ ] Commit: `docs: publish keyed Codex compatibility`

## Task 8: Publication gate and live acceptance

**Files:**
- No product changes unless a failed check identifies a specific defect.

- [ ] Run the full mechanical gate:
  - `npm ci`
  - `npm test`
  - `npm run build`
  - `git diff --exit-code -- dist/read-the-room-server.js`
  - `npm run verify:codex-install`
  - `git diff --check`
  - `test -z "$(git ls-files node_modules)"`
  - `git status --short`
- [ ] Run the exact tracked-release PII scan from the compatibility spec, excluding disposable probes and untracked runtime state.
- [ ] Verify a Git-backed install from the integration branch/ref when available. Record the required post-merge `hackerbara/read-the-room --ref main` verification as a publication blocker until main actually contains the commits.
- [ ] Validate the Claude plugin in a disposable Claude configuration and smoke the normal door, keyed return, affirm/edit, stay, and compaction paths.
- [ ] Install from a disposable cached Codex plugin directory and run BB smokes for:
  - normal door use;
  - missed-door recovery;
  - BB-RTR-001 sequence: stream substantial pre-door text, let Stop block, recover through the door with a different final completion, and verify BB retains/groups the earlier streamed body in a recoverable native Worked-for view (record whether keyboard `ctrl+O` is inapplicable rather than assuming it);
  - a normal-door case isolated from setup-key behavior, followed by a separate setup-key and correct-return case;
  - affirm/edit;
  - truthful stay plus cap;
  - compact mode with an outstanding key;
  - absence of Claude-only workspace/unseen text.
- [ ] Record thread IDs, commands, exact results, bundle provenance/hash, and any untested platform surface. State Windows as unverified unless it is actually tested.
- [ ] Review the final diff against both specs and the invariants above. Do not merge until the acceptance report has been reviewed.

## Self-review checklist

- [ ] Every behavioral change starts with a failing test.
- [ ] No instruction copies the pre-keyed Codex server or bundle over main.
- [ ] Main's keyed state machine has one implementation, not host-specific forks.
- [ ] Both Claude and Codex failure/cap paths have explicit assertions.
- [ ] Existing-user documents and state files have migration/fallback coverage.
- [ ] BB display behavior is described as observed presentation, not as hidden transcript transport.
- [ ] The plan stops before merge and leaves a reviewable acceptance report.
