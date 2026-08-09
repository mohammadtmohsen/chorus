# Board

Somewhere to drop a task so it is not lost, and somewhere to look when deciding
what is next.

**Not a plan.** Work of any size still goes through
`docs/plans/{slug}-{date}/plan.md`, and a plan's own progress belongs in its
`STATUS.md`. This file is for the things that sit outside any one plan: what needs
a person rather than a commit, what was noticed in passing and is worth doing, and
what is deliberately parked.

**An entry says three things** — what it is, why it matters, and what would make
it done. An entry that cannot answer the third is a thought, not a task, and
belongs in a plan's open questions instead.

Move an entry out when it ships. A board that keeps its finished work stops being
read, which is how the status summary went stale a day after it was written.

---

## Needs you

Nothing here can be finished by me alone.

### An application icon

`electron-builder.yml` sets `buildResources: build`, so the packager looks for
`apps/desktop/build/icon.icns`. That file does not exist, and the build says so
every time:

```
• default Electron icon is used  reason=application icon is not set
```

So `Chorus-0.7.0-arm64.dmg` ships the generic Electron icon — in the DMG window,
in the Dock, in the Applications folder, and in ⌘-Tab. It is the first thing
anyone sees of the product and currently says "an Electron app".

**Why it is here and not done:** wiring it is a one-line change once the artwork
exists. Inventing a logo and committing it as the product's identity is a design
decision, not a packaging one.

**Done when:** `apps/desktop/build/icon.icns` exists (1024×1024 source, macOS
iconset) and `pnpm package` no longer prints that line.

### Whether to notarize

The build is ad-hoc signed and **not** notarized, which is a documented decision
rather than an oversight — `electron-builder.yml` explains it at length, and
`docs/install-macos.md` walks a user through the dialogs. Ad-hoc signing is what
keeps macOS calling the app _untrusted_ rather than _damaged_, which is the
difference between a warning you can click past and one you cannot.

That is fine for `pnpm app:install` on your own machine. It is a blocker the
moment you hand the DMG to someone else.

**Done when:** either a Developer ID is available and notarization is wired, or
this entry is closed with "personal builds only" written down so nobody
re-litigates it.

---

## Open

### The residual menu failure

`typing a slash offers the commands this project actually has` still fails
occasionally after its fix. The mechanism behind the original bug is settled and
fixed on both sides of the IPC boundary; what remains is unexplained and looks
like load rather than a second bug.

Eight hypotheses are dead and written down in the plan's `STATUS.md`, along with
the instrumentation that killed them. That list is the head start.

**Done when:** either it is reproduced with a named cause, or it survives a long
quiet run often enough to call the earlier failures environmental — with the
number of runs stated rather than implied.

### Measure what catch-up actually costs

In a shared room each agent is fed what the other said, up to 12,000 characters a
turn, with activity capped at 40% so it cannot crowd out speech. It is the one
input Chorus invents, and it is careful — labelled `[Chorus]`, truncation
disclosed, the user's real message fenced off.

Nobody has measured it in practice. It does not make answers worse directly, but
it brings **compaction** forward, and compaction is the one moment the transcript
and an agent's memory stop agreeing.

**Done when:** a real two-agent room reports the catch-up size per turn and what
share of the context window it accounts for, so 12,000 can be judged as generous,
tight, or irrelevant on evidence.

### The composed catch-up is not recorded

`user.message` holds what you typed; the agent received that plus a preamble
composed at delivery. It is a pure function of the events, so it is
reconstructible in principle — but if an agent behaves oddly you cannot read back
the exact text it was given.

**Done when:** either the delivered text is recoverable for a past turn, or this
is closed with the reason the log deliberately records the conversation rather
than the prompts.

### Should any of the e2e suite run in CI

CI runs typecheck, lint, format, tests and a build. It **cannot** run the 26 e2e
specs or `verify:package`, because both drive real `claude` and `codex` CLIs with
real credentials. So a green PR is not evidence about the renderer, and this
session shipped a transcript change that way before a local run caught an
unrelated defect.

**Done when:** either a credential-free subset exists in CI (a launch, a window, a
store that opens — no agents), or the answer is written down as "run it locally
before tagging" and the release checklist says so.

---

## Parked, with reasons

Not open questions and not oversights: judgements already made, kept here so they
are not quietly reopened. The full reasoning is in the plan's `STATUS.md` and
`DONE.md`.

- **The todo panel.** The detail line shipped. The panel cannot be built honestly
  on this machine, whose config replaces `TodoWrite` with
  `TaskCreate`/`TaskUpdate` — there is nothing here to see it with.
- **Dialogs.** The CLI fails _closed_ on an undeclared kind, so today's behaviour
  is a defined degradation; declaring it promises Chorus can render an
  undocumented payload, and being wrong parks the turn.
- **Checkpoints.** `rewindFiles()` needs a uuid the CLI never emits. It exists
  only in the CLI's private transcript, and reading that to revert files on disk
  risks the working tree on a format change.
- **The context breakdown.** `totalTokens` excludes deferred categories, so the
  obvious panel overstates usage by more than twice the total.
- **Terminal sessions in the history sheet.** Chorus's log is authoritative; a CLI
  session is a different unit, and merged rows would look reopenable when they are
  not. `sessionRef` is already recorded if a correlation is ever wanted.
