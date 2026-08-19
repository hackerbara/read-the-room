# Keyed Door — design specification

Status: draft for review · 2026-08-18
Origin: co-design session 5c6873a3 (this repo), grounded in a survey of 32
real orientation files and the reflection of the prior long-lived session.
Companions: `.turn-map.md` (hook surface, visibility planes),
`.round-spec.md` (working notes this spec supersedes).

## 1. Problem and evidence

The orientation file — the per-session map Claude keeps of where the user
stands — degrades two ways, and the existing machinery addresses neither
reliably:

- **Never started.** 27 of 32 real session files were blank seeded
  templates. The largest observed failure is that the room is never set
  up at all.
- **Degraded in use.** The 5 genuinely-used files show: template headers
  abandoned monotonically with session length (142-turn session kept 1 of
  7); append-accretion punctuated by crisis prunes that overshoot and
  regrow (16.9k → 5k → 12.9k → 5k → 10.8k → 5.4k → 7.5k over two days);
  at least one full rewrite forced because incremental editing left the
  file actively false, not merely long.
- **Passive signals underperform.** The size directive fired on five
  consecutive door calls of the prior session while staleness climbed
  0→5, unheeded — at the very moment that session credited the numbers
  with driving its behavior ("The counters did the work, not the
  writing"). Refined finding: numbers beat prose, but *displayed* numbers
  still get ignored in streaks. Instrumentation that only informs is
  exhortation with better credentials.
- **Dedicated tools get dodged** (the user's standing criterion, from
  years of building MCPs/skills/hooks), increasingly so deep in context.
  A mechanism survives only on a path the agent already walks, or if it
  pays the agent at the moment of use.

## 2. Design principle

**"Any update is allowed — you just gotta change it."** Change is the
proof. The gate never judges content; every check is content-blind (hash
and byte count only). Strictness lives in the recorded stats, where
streaks of trivial compliance are visible. Sole authorship is untouched:
ordinary Edit/Write remains the only write path to the file, and no
machinery ever composes or removes a word of its content.

The door remains permission to speak, not a check passed — with one
narrow, mechanical exception (the key), which is why the exception must
stay content-blind and carry a stand-down.

## 3. Goals / non-goals

Goals: the room gets set up at session start; neglect streaks end at the
door instead of compounding; pruning happens under continuous pressure
rather than crisis; honest waiting (stays) becomes legal; all of it
tunable via standard settings.

Non-goals this round: no diff-echo or previous-version retention; no
rewrite ritual for fast sections; no mid-turn (PostToolUse) placements;
no comparator or curator subagents; no cross-session standing file; no
content inspection of any kind.

## 4. The loop

Liberties are legal and counted. Defined cases issue a key. Returning
the key opens the door. The Stop hook asks one question: did the turn
end in a legal state?

### Gate state machine

Gate file format is unchanged: `<status> <turn> [stopped]`. One new
status token, `KEYED`, and one new legal end, `STAYED`.

| From | Event | To | Written by |
|---|---|---|---|
| — | UserPromptSubmit | CLOSED | reinject |
| CLOSED | door call, nothing due | OPEN | server |
| CLOSED | door call, reasons due | KEYED | server |
| KEYED | key returned, verified | OPEN | server |
| KEYED | second fumble | OPEN (miss recorded) | server |
| CLOSED / KEYED | door call with `stay` | STAYED | server |
| OPEN | reply rendered (final) | SPOKEN | message-display |

Legal ends: SPOKEN, OPEN, STAYED. Illegal ends: CLOSED, KEYED — both get
the existing Stop backstop (max 2 reruns, then stand down and stamp).

## 5. State on disk

All under `$TMPDIR/claude-orientation/`, per session id, alongside the
existing files. New:

- `<sid>.state` grows a second role (no new `.sections` file). Line 1
  keeps today's exact format, `<turn> <hash>` — every existing consumer
  reads only the first line via `readTokens`, so old code meeting the
  new file parses unchanged. Lines 2+ are the section sidecar, one line
  per `##` section: `<turn-last-changed> <turn-affirmed|-> <sha256>
  <header text>` — header text last, as remainder, because it contains
  spaces. One file means the stamp and the sidecar are written in ONE
  temp-file-plus-rename, which is what actually closes the existing
  stamp/content desync (two separate files cannot be renamed atomically
  as a pair). Seeded by session-start at the moment it seeds the
  orientation file (recording the seeded fast-section hashes);
  maintained by reinject each turn thereafter (split on `^## `, hash
  each body, carry turns forward; new header → current turn; vanished
  header → line kept, marked `gone`).
- `<sid>.key` — present only while a key is outstanding. Line 1:
  `<nonce> <turn> <attempts>`. Lines 2+: one reason per line, header as
  remainder text — `setup`, `fresh <header text>`, `prune <bytes>` —
  never comma-joined, so spaced headers survive parsing. Nonce: 16
  random hex bytes from the server. **Key lifetime, the one rule:** a
  key is valid only for the turn it was issued. The *conditions* persist
  across turns because they are recomputed from the stats at every door
  call; the *key* does not — a stale-turn key file is ignored and a
  fresh nonce issued. Deleted on successful return or stand-down.
- `<sid>.ledger` — append-only, one line per key event:
  `<turn> <event> <delta|-> <reason text…>` with events `issued`,
  `satisfied`, `affirmed`, `fumbled`, `stood-down`, `lapsed` (turn ended
  KEYED), `stayed-keyed` (stayed while a key was due), `snoozed`.
  Satisfactions record the byte delta of the change that satisfied them
  — still content-blind, but a streak of `satisfied +1` or batch
  `affirmed` entries is visible for what it is. This is where
  "strictness lives in the stats" becomes real; nothing reads it yet
  except humans and future tooling (comparator, if ever built).

## 6. Tool interface

`read_the_room` input gains three optional fields beside `note`:

- `key` (string) — the nonce being returned.
- `affirm` (array of strings) — section headers being affirmed as
  checked-and-still-current. Legal answer to `fresh` reasons only.
- `stay` (boolean) — end the turn in the room; optional short
  `note` doubles as the doorstep line.

Returns:

- **No reasons due:** the orientation file with tuple ages rendered onto
  each header — `## What they are doing right now (changed turn 41,
  9 ago)`, plus `affirmed turn N` when applicable — followed by the
  existing stats block. Gate OPEN. One call, today's shape.
- **Reasons due:** the same annotated file, no gate opening, plus the
  key block: nonce, each reason named concretely (`fresh: "What they
  have not seen" unchanged 7 turns` / `prune: 6480 bytes, limit 5000`),
  and what would satisfy each. Framed as the room asking for upkeep
  before entry, not as a failed check.
- **Key return:** per-reason verdicts. All due reasons must pass:
  `setup` — the file's hash moved at all since issue; `fresh` — the named
  section's hash moved since issue, or the section appears in `affirm`;
  `prune` — byte count now strictly under the limit. Pass: gate OPEN, key
  deleted, satisfaction logged with byte delta. Fail: a failed RETURN is
  a fumble — reasons restated **with the nonce reprinted** (attempts=1);
  second failed return → stand-down: gate OPEN, key deleted, logged. A
  bare re-call of the door while a same-turn key is outstanding is NOT a
  fumble: it re-presents the same nonce and reasons unchanged. (This is
  also the compaction recovery path: if the nonce fell out of context,
  call the door again and it comes back.) After a stand-down, that
  reason is snoozed — not re-issued — for SNOOZE turns, so a stand-down
  buys working room instead of an every-turn re-fire loop; the snooze is
  logged.
- **Stay:** gate STAYED, stamped as a legal end by the Stop hook. Stays
  consume turns, so freshness accrues during a stay streak and re-entry
  is naturally keyed. Two bounds, because unbounded staying would let a
  session end every turn in silence — the exact state "fails toward
  speech" forbids: staying while a key is due is legal but logged
  (`stayed-keyed`), and a streak of more than STAY_CAP consecutive
  stays trips the Stop backstop's ordinary nudge (come through, or say
  so to the user). Waiting stays cheap; permanent silence stops being
  free.

## 7. Stage behavior (per component)

- **session-start.cjs** — seed, inject, restore as today, plus: seeds
  the sidecar (lines 2+ of `.state`) with the seeded fast-section hashes
  at the moment it seeds the file — the setup check compares against
  THESE recorded seed hashes, never against the current template, so
  template edits in later plugin versions cannot break setup detection
  for sessions seeded earlier. The new doc opening ships in the
  documents it injects (§10). On SessionStart(compact), if a same-turn
  key is outstanding, note its existence in the restored context (the
  nonce itself comes back via a bare door re-call, §6).
- **reinject.cjs** — turn counter, pointers, gate CLOSED as today. NEW:
  sidecar maintenance (§5), one atomic write with line 1. Interrupt
  detection extends to KEYED (today's check is hardcoded to CLOSED —
  reinject.cjs:124). RETIRED: the 5-turn nudge and the 10+/repeat-5
  reinjection, and env vars `CLAUDE_ORIENTATION_NUDGE_AT`,
  `_REINJECT_AT`, `_REPEAT`. The keyed door replaces them; their removal
  is a per-turn token reduction.
- **server/index.js** — computes due reasons (setup: fast sections still
  hash as their recorded seed hashes; fresh: any fast section, and any
  `gone` fast section, unchanged/unaffirmed > FRESH_AT turns, unless
  snoozed; prune: file > PRUNE_AT bytes, unless snoozed); issues,
  re-presents, and verifies keys; renders section ages; writes gate
  transitions and ledger entries; all thresholds env-read. The existing
  "Size: N characters" line is corrected to say bytes.
- **message-display.cjs** — one new branch in the status dispatch:
  KEYED hides exactly like CLOSED (without this, everything written
  while doing keyed upkeep — the busiest workspace stretch in the new
  design — would render unhidden, since an unrecognized status falls
  through to display-original today: message-display.cjs:97-104).
  STAYED renders the stay marker (§6b). OPEN→SPOKEN flip as today.
- **stop-gate.cjs** — legal-state check. CLOSED: existing nudge. KEYED:
  nudge names the outstanding reasons; a KEYED end also logs `lapsed`
  and increments the same `suppressed` counter CLOSED uses (one display
  failsafe, both jam modes). STAYED: stamped legal and quiet, unless the
  consecutive-stay streak exceeds STAY_CAP (then the ordinary nudge).
  **The MIN_CHARS trivial-reply exemption applies to CLOSED only, never
  KEYED** — a five-character reply must not silently void a due key; the
  exemption spares turns that owe nothing, and a keyed turn owes.
  SPOKEN/OPEN: quiet (aftertalk unchanged). Same 2-rerun cap.

## 8. Numbers and configuration

All via standard Claude Code settings (`env` block in settings.json);
defaults in code via the existing `envOr` pattern. PRUNE_AT is today a
hardcoded const in the server — it becomes env-read like the rest.

| Knob | Default | Env var |
|---|---|---|
| Freshness key threshold | 6 turns | CLAUDE_ORIENTATION_FRESH_AT |
| Prune key threshold | 5000 bytes | CLAUDE_ORIENTATION_PRUNE_AT |
| Prune satisfaction | strict (< PRUNE_AT) | — |
| Setup key | on | CLAUDE_ORIENTATION_SETUP_KEY (0 disables) |
| Trivial-reply exemption | 100 chars | CLAUDE_ORIENTATION_STOP_MIN_CHARS |
| Display hide threshold | 150 chars | CLAUDE_ORIENTATION_SHORT_CHARS |
| Stand-down / rerun cap | 2 | CLAUDE_ORIENTATION_STOP_MAX_RERUNS |
| Compact-restore slice | 4000 bytes | — (unchanged) |
| Display backstop | 2 turns | — (unchanged) |

| Stay streak cap | 3 consecutive | CLAUDE_ORIENTATION_STAY_CAP |
| Reason snooze after stand-down | 6 turns | CLAUDE_ORIENTATION_SNOOZE |

Was-column, so this spec doesn't misstate current code: SHORT_CHARS was
400, STOP_MIN_CHARS was 180, PRUNE_AT was a hardcoded 6000. The tighter
values (150 / 100 / 5000-strict) are deliberate pressure experiments —
he wants to see what aggressive settings actually do — not derived
optima; expect tuning. STAY_CAP=3 and SNOOZE=6 are proposed values
pending his confirmation, added in review.

One key per turn; all due reasons ride on it; all must pass; `affirm`
answers `fresh` only.

### 6b. Copy (load-bearing, not deferrable)

The tool's field descriptions are the one documentation always in the
model's context; the return text must teach a zero-context agent what to
do. Ship with:

- `key` describe: "Return the nonce from a keyed door call after doing
  what its reasons ask. A bare call without it just shows you the key
  again — that is not a fumble."
- `affirm` describe: "Section headers you re-read just now and checked
  are still current. Answers freshness only; never answers pruning."
- `stay` describe: "End this turn in your room — nothing enters theirs
  but a one-line marker. Legal, counted; waiting is not a failure."
- Keyed return, shape of the text: what is due, why, what satisfies it,
  the nonce, and one sentence of stance: "The room asks for upkeep
  before entry. Update it (any real change counts), or affirm what you
  re-checked, then return the key."
- Stay marker (must not resemble the working-notes marker): `■ stayed
  in this turn — <note> (nothing was said; ctrl+O for the workspace)`.
  Distinct glyph, states explicitly that the turn is over and nothing
  was delivered.

## 9. Template changes (orientation-template.txt)

1. Rename "What they asked for that has not been delivered" →
   `## Still open — asked, not delivered`. (Survey: canonical header
   survived in 0 of 5 real files; every session independently invented
   "Still open".)
2. Provenance key at top: `[SAID]` / `[INFERRED]` — the convention
   disciplined sessions converged on. Comment: mark inferences; never
   launder one into a fact.
3. New guardrail comment: project state, task lists, and bug tracking do
   not live here — only where THEY stand. (The observed leak with no
   guardrail.)
4. Fast-section marker comment on: "What they are doing right now",
   "What they have not seen", "Still open — asked, not delivered".
   This list is the freshness watch set and the setup check set. The
   server matches these headers by case-insensitive prefix; renaming or
   deleting a fast header does not escape the mechanism (a vanished fast
   header counts as unchanged since last seen).

## 10. Doc opening (orientation.md and orientation-brief.md)

A short block above "Why this exists", positively framed — a gift, not a
prohibition: your workspace is yours at any length and nobody has to see
it; the room file at `<path>` is where you keep what you know of them;
on your first turn, write what you already know from their first message
— writing the gap ("what I do not know yet") counts fully — then cross
before you first speak; the door has a few rules that fire on their own,
and entering well is how trust gets built from turn one. The philosophy
stays; it stops going first.

## 11. Failure posture and edge cases

- **Fails toward speech, always.** Stand-down after 2 fumbles on any
  key, then the reason snoozes (no every-turn re-fire loop); stays are
  bounded by STAY_CAP; the KEYED display gap is closed (§7) and KEYED
  shares the display failsafe counter. No state can leave the user
  unable to hear the agent, and no legal path ends every turn in
  silence for free.
- **Known residue, accepted by design:** cosmetic satisfaction (a
  one-character edit moves a hash; batch-affirm is cheaper than
  re-reading). The gate stays content-blind on principle — the ledger
  records every satisfaction's byte delta and every affirm, so the
  cheap patterns are visible as streaks rather than silently laundered.
  Catching them is the comparator's job if it is ever built; armoring
  the gate further is explicitly rejected.
- **Stale key files** (turn advanced, /clear, crash): ignored and
  reissued; swept with the rest of the session state.
- **Compaction mid-KEYED:** same session id, same turn — the key file
  survives, and the nonce is recoverable by a bare door re-call (§6),
  which costs nothing and is not a fumble. A lost nonce can therefore
  never burn attempts.
- **Concurrent sessions:** key files are per session id; the existing
  ppid-pointer resolution already isolates them.
- **Disk full / unwritable state:** every write already fails open
  (bare try/catch); an unissuable key means the door behaves as today.
  Verified live this session — ENOSPC while the design was being made.
- **Thin first prompt:** writing the gap is a change; setup satisfied.
- **Interrupted turns:** existing `.interrupted` logic unchanged; an
  interrupted KEYED turn leaves a stale-turn key, which is ignored.

## 12. Migration and compatibility

- Sessions in flight across a plugin update: absent sidecar is seeded on
  the next reinject pass — which necessarily stamps every section as
  changed-now, discarding any staleness accumulated before the upgrade.
  Stated consequence, chosen deliberately: the seam fails toward speech
  (one free FRESH_AT cycle) rather than toward a key fired on history
  the sidecar never saw. Absent key file means no key outstanding; old
  gate files parse unchanged; old code meeting the new `.state` reads
  only line 1 via readTokens and is oblivious to the sidecar below it.
- The legacy bash hooks under `~/.claude/` predate all of this and are
  already divergent; this round targets the plugin's Node only.
- Docs (`README.md`, `how-it-works.md`) must gain: the key, the stay,
  the changed defaults, and the retirement of the reinject nudges. The
  how-it-works turn diagram gains the KEYED/STAYED branches.

## 13. Testing

Extend the existing byte-comparison harness (the repo's discipline: the
port was verified 42/42 byte-identical with a negative control):

- State-machine matrix: every transition in §4, including both fumble
  paths and stay.
- Sidecar determinism: same file bytes → same sidecar; rename, vanish,
  and reorder cases for fast headers.
- Key verification: each reason × (satisfied / unsatisfied / affirmed
  where legal) × turn-staleness of the nonce; bare re-call re-presents
  without incrementing attempts; fumble response includes the nonce;
  short reply on a KEYED turn still triggers the backstop; stay streak
  at/over STAY_CAP; snoozed reason not re-issued until expiry.
- Config: every env var read, default when unset/garbage (the existing
  digitsOrDefault / envOr semantics).
- Negative control: run the new suite against the pre-change code and
  confirm it discriminates.
- Empirical rider: does SessionEnd fire on kill -9? (undocumented;
  cleanup design assumes it may not and sweeps by mtime regardless).

## 14. Mechanical riders (ship with the round)

- Dead session file cleanup: no SessionEnd deletion — Claude Code sessions
  are resumable under the same session id after prompt_input_exit, terminal
  close, and `/clear` (old sessions stay in the resume picker), so an
  immediate delete would leave a resume finding no state and SessionStart
  silently reseeding a blank template. Reinject's existing msg/ sweep
  pattern extends to sweep any session's state files older than 14 days
  instead; that sweep is now the entire cleanup story, not just crash cover.
- Sidecar/state atomic write (§5) — closes the observed desync bug.

## 15. Out or resting (do not silently reopen)

Diff-echo and one-back retention (unsure, separable); two-speed's
rewrite ritual (the fast-section list is the kept part); mid-turn
placements (cost test unanswered); comparator subagent (cheap to pilot
later via prompt-handler hooks); curator (out); standing file (parked,
AGENTS.md overlap); unconditional reminders (dead).

## 16. Open questions

- Should `affirm` of a `gone` fast header be legal (agent says the
  section is intentionally merged elsewhere), or should the header be
  required to exist? Current spec: affirm is legal for it, like any
  fresh reason; the ledger records the affirm; the template guardrails
  discourage the rename in the first place.
- HIS CALLS, raised in review: (a) STAY_CAP=3 and SNOOZE=6 are proposed
  numbers, not settled ones; (b) the adversarial review argues strict
  pruning makes forced deletions routine enough that the one-back
  retention he set aside as "unsure" may be worth reopening — not
  reopened here, flagged only.
