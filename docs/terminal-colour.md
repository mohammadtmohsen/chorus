# Why your terminal looks grey

Chorus's terminal renders colour. If yours looks flat, the shell is almost
certainly not sending any — and this page is the two-minute fix, plus how to
prove which half is at fault before changing anything.

It is written down because a full day went into diagnosing it once, across the
PTY, `node-pty`'s `TERM`, the renderer and the theme, before the answer turned out
to be a shell setting that had never been switched on.

## First, prove where the problem is

Open a terminal in Chorus (`⌘J` for the session's, `⌘⇧J` for the global one) and
run exactly this, on one line:

```sh
printf '\033[31mRED\033[0m \033[32mGRN\033[0m \033[34mBLU\033[0m\n'
```

Those are literal escape sequences, so no program is deciding anything.

- **Three coloured words** — the emulator, the palette and the PTY are all fine.
  Everything below applies; the fix is in your shell.
- **Three grey words** — that is a real Chorus bug. Please file it, and say which
  colour scheme you were in.

Paste the line on its own. A block with `#` comments or multi-line loops goes into
zsh's paste buffer and waits for you to press Return, which looks exactly like a
command producing no output.

## What is already coloured, and needs nothing

`git log --decorate`, `git status`, `git diff`, and most test runners and build
tools emit colour on their own as soon as they detect a terminal. Measured inside
Chorus, `git log --oneline --decorate` produces 22 colour escapes and `pnpm check`
between 5 and 17 depending on scheme. If these look grey to you, check the two
settings below before assuming anything about Chorus.

One thing that legitimately produces no colour: a command whose output is
**piped**. `git status | head` disables colour by design, in every terminal, because
the program is no longer writing to a tty. That is correct behaviour, not a fault.

## Fix 1 — `ls`

macOS ships BSD `ls`, which is monochrome unless asked. This is the single most
common cause of "my terminal has no colour", and it is not specific to Chorus —
`ls` is grey in Terminal.app and iTerm too until you set this.

Add to `~/.zshrc`:

```sh
export CLICOLOR=1
```

`ls -G` gets you the same thing for one command without changing any config,
which is useful for checking before you commit to the setting.

## Fix 2 — colour the command as you type it

Valid commands green, typos red, quoted strings yellow. This is a shell plugin
rather than anything Chorus does:

```sh
brew install zsh-syntax-highlighting
```

Then add to `~/.zshrc`, and it must be the **last** line — the plugin wraps the
line editor and anything sourced afterwards can unhook it:

```sh
source /opt/homebrew/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh
```

On an Intel Mac the prefix is `/usr/local` rather than `/opt/homebrew`.

## Both changes take effect in the next terminal

`~/.zshrc` is read when a shell starts, so a terminal that is already open keeps
the old settings. Open a new one (`⌘J`) rather than expecting the current one to
change.

## What Chorus does and does not control

| thing                       | whose job                                           |
| --------------------------- | --------------------------------------------------- |
| drawing ANSI colour         | Chorus — themed from `--ansi-*`, follows light/dark |
| `TERM=xterm-256color`       | Chorus — set on every PTY                           |
| whether `ls` emits colour   | your shell (`CLICOLOR`)                             |
| colouring what you type     | your shell (`zsh-syntax-highlighting`)              |
| the prompt, and its colours | your shell (`PROMPT` in `~/.zshrc`)                 |

The last row is worth spelling out because it is the one people expect Chorus to
own. A prompt like `user@host ~/projects/thing (main) $` is a string **the shell
computes**, and Chorus draws whatever it is handed. If your prompt is plain, that
is `PROMPT` in your `~/.zshrc`, and a themed one is either a few lines of zsh or
a prompt framework such as [starship](https://starship.rs).

## A note on secrets

While you are in `~/.zshrc`: it is a plain file that every process you launch can
read, and API keys are commonly parked in it. Chorus's permission engine cannot
help you there — an agent with a shell can read it like anything else. Prefer a
secret manager, or at least know which keys are in there and rotate them if the
file is ever shared, pasted, or screen-shared.
