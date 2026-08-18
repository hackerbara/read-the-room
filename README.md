# Read the Room

**Read the Room gives Claude Code somewhere to think, and keeps a file of what
you actually asked for that Claude reads back to itself in the moment before it
replies.**

Claude finishes thinking, finishes its tool calls, and then the only way to end
its turn is to say something to you. Nothing sits in that gap. So whatever was
last in its hands goes into your lap — half-finished reasoning, the thing it
just got interested in, a confident answer to a question you didn't ask.

This puts something in the gap.

## Two rooms

The idea the rest of this depends on:

**Claude's room** is where the work happens — the reading, the false starts,
the four attempts before one holds. It's large and costs you nothing.

**Your room** is where you're sitting. It's small, and what enters it, you have
to deal with.

Read the Room puts one step between them: before Claude speaks to you, it calls
a tool, `read_the_room`, and gets back what it's been keeping about you.

## What it does

**Keeps an orientation file.** Claude writes and maintains it itself, one per
session: what you're working on, what you asked for, what hasn't been delivered
yet, your words for things, what you've already settled. You never have to open
it. It lasts the session and then it's gone — this is orientation, not memory.

**Reads that file right before speaking.** Not at the start of the session,
where it scrolls out of reach — at the last moment, when it can still change
what gets said.

**Hides Claude's working notes** — the drafting and thinking-out-loud that
happens before a reply. Long stretches of it are replaced on your screen by one
line. Nothing is deleted; the text stays in the transcript and `ctrl+O` opens
it. The first time it happens in a session, the line expands to explain itself.
**To see everything instead, set `CLAUDE_ORIENTATION_SUPPRESS=0`.**

## What it can't do

Worth knowing before you install, because it shapes what to expect.

Nothing inspects Claude's reply or blocks it. The tool hands over the file;
acting on it is Claude's choice, driven by instructions in a document you can
read and edit, not by anything mechanical. The file's contents are written by
Claude, so they're as good as its read on you — and when you correct it, what
updates the file is Claude choosing to update it.

So this doesn't guarantee better answers. It puts a step where there wasn't
one. Whether that step does anything is visible to you and not to us: you'll
know it's working if a reply ever changes because of something you said three
messages ago.

## What it's aimed at

- Claude answers a more interesting question than the one you asked.
- You correct it and get a defence of its reading instead of a change.
- It hands you its reasoning and leaves you to find the answer inside it.
- It uses words you never used and can't quite pin down.
- You explain your situation twice in one session.

## Requirements

Claude Code, and **Node.js on your PATH** — the hooks and the server all run on
it. Without Node, nothing here runs and it fails quietly.

## Install

```sh
claude plugin marketplace add hackerbara/read-the-room && claude plugin install read-the-room@read-the-room
```

Restart Claude Code. Nothing else to configure.

If you would rather see everything Claude writes, including its working notes:

```sh
export CLAUDE_ORIENTATION_SUPPRESS=0
```

The orientation file works the same either way.

## Use

Nothing to invoke. It runs on every session.

The one thing worth knowing: if a reply doesn't meet where you are — your
terms, your sense of the problem, something you already told it — say so. The
orientation file is Claude's read on you, and that's what corrects it.

## More

[How it works](how-it-works.md) — the mechanism, with diagrams, and what it
costs.

## Licence

MIT.
