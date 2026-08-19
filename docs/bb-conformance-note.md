# BB conformance note

**Tracking ID:** `BB-RTR-001`

## Preserve streamed assistant text when completed content differs

BB can receive one body while an assistant message streams and a different
body when that same message completes. The completed body currently replaces
the streamed body in BB's projection. If a provider applied a display-only
transformation, text the user already saw may no longer be recoverable.

A narrow upstream BB issue could ask BB to retain the accumulated streamed
body as inspectable archival detail when it differs from the completed body.
The provider's completed body would remain the default presentation; raw event
logs would remain unchanged.

This is broader than Read the Room because it makes provider display
transformations reversible. It is distinct from BB issues #1355 and #1656,
which concern which complete assistant messages remain outside a completed
turn's `Worked for` summary.

`BB-RTR-001` is not required for the Read the Room plugin to work. It is a
separate upstream BB conformance question about recoverability when completed
content differs from streamed content.

The Read the Room Codex plugin's normal door-crossing path was smoke-tested in
BB thread `thr_9wjgja8st7`. Before filing, reproduce the completion-replacement
behavior on the BB version being targeted.
