const CLAUDE_TOOL_DESCRIPTION =
  "Write your answer first, then call this. It is permission to speak " +
  "into their room, not a check you pass. Everything you write before " +
  "calling it is yours — think at whatever length you need, the display " +
  "keeps it out of their way. What comes back is the standing model of " +
  "the user for this session, plus facts about the orientation file itself. " +
  "Then say the thing, once, addressed to them. If what comes back does " +
  "not match what you drafted, revise before you speak; calling again " +
  "after revising is expected.";

const CODEX_TOOL_DESCRIPTION = `Write your answer first, then call this before the final addressed reply.
Use ordinary language as workspace at whatever length the work needs, but know
that Read the Room does not hide it: ordinary assistant language streams visibly
while the turn is active, though the surrounding client may later group completed
work in an expandable interface. This tool returns the standing orientation for
this session and opens the current turn's door. If the orientation disagrees with
what you were about to say, revise it and cross the door again.`;

const CLAUDE_STAY_DESCRIPTION =
  "End this turn in your room — nothing enters theirs but a one-line marker. " +
  "Legal, counted; waiting is not a failure. Use note for the marker text.";

const CODEX_STAY_DESCRIPTION =
  "End this turn; no new addressed reply is produced. The streamed workspace remains visible. " +
  "Legal, counted; waiting is not a failure. Use note to record why you stayed.";

export function hostFromArgs(argv) {
  const index = argv.indexOf("--host");
  return index >= 0 && argv[index + 1] === "codex" ? "codex" : "claude";
}

export function toolDescription(host) {
  return host === "codex" ? CODEX_TOOL_DESCRIPTION : CLAUDE_TOOL_DESCRIPTION;
}

export function stayDescription(host) {
  return host === "codex" ? CODEX_STAY_DESCRIPTION : CLAUDE_STAY_DESCRIPTION;
}

export function stayResponse(host) {
  return host === "codex"
    ? "Stayed in. The streamed workspace remains visible; no new addressed reply is produced. The room keeps counting."
    : "Stayed in. The marker is all they will see this turn. The room keeps counting.";
}
