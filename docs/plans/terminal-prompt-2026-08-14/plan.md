# A prompt Chorus can call its own

**State:** **parked, unscheduled** — written from a misreading and kept only for the mechanism it documents

> Parked the day it was written. The reference image was read as a request for a
> themed _prompt_; what was actually asked for was colour in **commands and their
> output**, which turned out to be two shell settings and no Chorus change at all
> — see [`docs/terminal-colour.md`](../../terminal-colour.md).
>
> It is kept rather than deleted for one section: §"Why the obvious implementation
> does not work". Setting `PROMPT` in the PTY environment cannot work, because
> `shell.ts` spawns a login shell and `.zshrc` runs after us. Anyone who tries this
> later will otherwise rediscover that the slow way. Nothing below is scheduled.

**Date:** 2026-08-14

**Scope:** `apps/desktop/src/main/terminal.ts`, `apps/desktop/src/main/shell.ts`, a new prompt-init module, settings

## The problem

The reference is a terminal whose prompt carries information and colour:

```text
dev@chorus ~/projects/payments-api (main) $ pnpm install
└─ green ─┘ └──── blue ─────────┘ └magenta┘ └green┘
```

Chorus draws none of that today, and the reason is worth stating precisely
because a day was spent finding it: **there is nothing wrong with the rendering.**
Driven in both the dev build and the installed `/Applications/Chorus.app`, a
terminal paints `\033[31m` as `rgb(239, 127, 146)`, matching `--ansi-red`, and
re-themes on `prefers-color-scheme`. `git log --decorate` arrives with 22 colour
SGRs. The emulator, the palette and the PTY are all doing their jobs.

What produces the reference is the **shell prompt**, and a prompt is a string the
shell computes. This machine's is line 1 of `~/.zshrc`:

```sh
export PROMPT="MT %~ % "
```

Plain, monochrome, no branch. Chorus renders it perfectly. That is the whole gap:
we are asking the app to supply something that has always come from the user's
dotfiles, and no change to `TerminalView`, the `--ansi-*` tokens or `node-pty`
can produce it.

So this is a **product decision** rather than a bug, and it is the first time
Chorus would write into the user's shell rather than merely host it.

## Why the obvious implementation does not work

Set `PROMPT` in the PTY environment and it is gone before the first prompt draws.
`shell.ts` spawns `$SHELL -l` — an interactive login shell — and the order is:

```text
Chorus sets env  →  zsh starts  →  .zprofile  →  .zshrc  →  first prompt
                                                    ↑
                                   `export PROMPT="MT %~ % "` runs here,
                                   after us, and wins
```

Any variable we export is a default the user's own config overwrites. That is not
a bug to route around; it is what sourcing a profile means.

The mechanism that does work is `ZDOTDIR` redirection, which is what VS Code uses
for its shell integration. Chorus points `ZDOTDIR` at a directory it owns, whose
`.zshrc` sources the user's real one **first** and then acts with full knowledge
of what the user configured:

```text
ZDOTDIR=<chorus>  →  <chorus>/.zshrc
                        1. restore ZDOTDIR to the user's real value
                        2. source the user's .zshrc (if any)
                        3. decide about the prompt, knowing what they set
```

Step 3 is where the whole design lives, and it is the part this plan cannot
settle alone.

## Whose prompt wins — the decision this needs

The tempting rule is "only set ours when the user has not themed one". It is the
polite rule, and on this machine it produces **nothing**: `MT %~ %` is a themed
prompt. The person asking for this feature would install it and see no change.

The options, with what each costs:

| rule                              | this machine gets   | cost                                                         |
| --------------------------------- | ------------------- | ------------------------------------------------------------ |
| only when prompt is zsh's default | nothing             | the requester is the case it excludes                        |
| always                            | the reference       | silently overrides a line the user wrote on purpose          |
| setting, default on               | the reference       | a surprise once, then a switch — but it is still an override |
| setting, default off              | nothing until asked | discoverability; the feature ships switched off              |

There is a fifth shape worth considering rather than assuming: **do not replace
the prompt, add to it.** Keep whatever the user has and append the branch and a
colour accent, so `MT ~/code/chorus (main) $` rather than a wholesale swap. It
respects the dotfile and still answers the actual complaint, which was that the
terminal looks inert.

This plan does not choose. It is the approval gate.

## The shape

**Phase 1 — the redirection, with no prompt in it.** `ZDOTDIR` plumbing,
Chorus's `.zshrc` sourcing the user's and restoring every variable it borrowed,
and a spec proving a shell opened this way is indistinguishable from one opened
today: same `PATH`, same aliases, same prompt, same `$ZDOTDIR` as seen from a
subshell. Shipping the mechanism inert is what makes the next phase reversible,
and it is the phase most likely to find that someone's `.zshrc` calls `exec` or
runs powerlevel10k's instant prompt.

**Phase 2 — the prompt itself**, in whichever shape §"Whose prompt wins"
settles on, with the escape hatch that decision implies. Colours come from the
same sixteen `--ansi-*` slots the emulator already themes, so the prompt follows
light and dark rather than pinning hexes the way the reference image does.

**Phase 3 — the other shells, or an honest note that there are none.** `zsh` is
the macOS default and the only shell this phase covers. `bash` needs
`--init-file`, which does not compose with `-l` the way `ZDOTDIR` does; `fish`
shares neither mechanism. `shell.ts` already falls back to `/bin/bash` and
`/bin/sh`, so those users must get _their own_ prompt untouched rather than a
broken one.

## What this deliberately does not do

- **No shell integration.** No command tracking, no exit-code capture, no marking
  where output began. VS Code's `ZDOTDIR` does all of that; we are borrowing the
  mechanism and none of the ambition. Command capture is also the sharpest form
  of C-021's unsolved half, and `CLAUDE.md` already rules terminal contents out
  of the event log.
- **No change to `PATH`, aliases, or anything else the profile sets.** The prompt
  is the only variable in scope.
- **Nothing for non-interactive shells.** A shell with no tty has no prompt, and
  anything we inject there is corruption of someone's pipeline.
- **No new dependency.** Not starship, not oh-my-zsh. Both are excellent and both
  are the user's choice to make, not ours to make for them.

## Open questions

1. **Which rule from §"Whose prompt wins"?** Blocking; everything else is
   plumbing.
2. **Does the prompt show `user@host` at all?** The reference does, but
   `dev@chorus` is invented. On a laptop where every shell is the same user on
   the same host it is two words of noise before the part that matters.
3. **What happens to a prompt the user changes mid-session?** Ours would be set
   once at startup; a `PROMPT=` typed later should win and probably does, but
   that is an assumption until driven.
4. **Does this belong to the session terminal, the global one, or both?** They
   are separate panels with separate shells and the same `TerminalService`.
5. **Is `git` in the prompt affordable?** `vcs_info` runs per prompt. In a large
   repo that is measurable, and Chorus's own repo is not small.

## Risks

- **A prompt is not the only thing `.zshrc` sets.** Sourcing it from a different
  `ZDOTDIR` is a behaviour change for every line in it, not just the prompt one.
  Phase 1 exists to prove that claim empirically rather than argue it.
- **Failure has to be invisible.** If Chorus's `.zshrc` is missing or errors, the
  user must get their normal shell, not a broken one. That means the file guards
  every step and never `set -e`.
- **The suite is currently red at eight specs**
  (`readable-control-rail-2026-08-13/STATUS.md` §10), so a new terminal spec
  lands next to failures that are not its own. Say which are which.
