# Status

| Phase                                | State                          | Commit    |
| ------------------------------------ | ------------------------------ | --------- |
| 0 — prove it packages                | **shipped**, strategy A chosen | `88668c4` |
| 1 — the terminal service in main     | **shipped**                    | —         |
| 2 — IPC and flow control             | not started                    | —         |
| 3 — the two panels, `⌘J`, the button | not started                    | —         |
| 4 — persistence                      | not started                    | —         |

On `feat/a-terminal-in-every-session`, branched from `main` rather than from
`fix/a-suite-that-can-go-red`. The plan's §8.3 asked whether the terminal work
depends on that branch landing; it does not — the two touch no file in common,
so the dependency was avoided rather than accepted.

## Phase 0 — shipped

The question was whether Chorus can carry a second native module without a
toolchain, and whether `pnpm dev` and the packaged app load the same thing. Both
are now answered by running rather than by reading, which is the whole reason
this phase came before any UI.

### The finding, in one line

**`node-pty`'s `spawn-helper` ships mode 0644, and a PTY cannot spawn without the
executable bit.** Reproduced on demand:

```
FAIL  spawn-helper is executable — mode 644
FAIL  pty.spawn + echo hi — posix_spawnp failed.
```

`chmod +x` and the same probe returns `exit 0, got "hi\r\n"` — the `\r` being the
tell that this is a real TTY and not a pipe. Nothing in node-pty repairs it: its
`install` script only checks a prebuild exists, and its `postinstall` prints
`SKIPPED (not Windows)` on macOS. Projects that compile from source never see it,
because `lib/utils.js` prefers `build/Release` and the linker sets the bit there.

### Strategy A, and the reason the choice mattered

The plan framed a choice: **A** ship the prebuilds with `npmRebuild: false` and
own the chmod, or **B** compile from source and accept a native toolchain.

**A**, because the prebuild is N-API and loads in Electron 43.2.0 unmodified —
verified by running the probe under Electron's own binary, not merely under node.
That is the same property that made `better-sqlite3` free, and it keeps the
posture the build plan chose deliberately.

**The choice was not cosmetic.** With electron-builder's default `npmRebuild:
true`, `@electron/rebuild` would have compiled node-pty — it recognises prebuilds
only from `prebuildify` or `prebuild-install`, and node-pty uses neither. The
packaged app would then load a compiled `build/Release` while `pnpm dev` loaded
the broken 0644 prebuilt helper. **The two would have diverged silently**, and a
Phase 0 that tested only the packaged app — which is what revision 2 specified —
would have gone green while dev was broken for everyone.

### What was verified, and how

|                                                 | result                             |
| ----------------------------------------------- | ---------------------------------- |
| prebuild is N-API, loads in Electron 43.2.0     | no rebuild, no toolchain           |
| `pnpm dev` path, before repair                  | **fails** — `posix_spawnp failed.` |
| `pnpm dev` path, after repair                   | `exit 0, got "hi\r\n"`             |
| packaged app carries helper at source mode      | **644** — mode propagates verbatim |
| packaged app after `afterPack` repair           | 755, signed, PTY spawns            |
| `codesign --verify --deep --strict` after chmod | **passes** — ordering is right     |
| `pnpm check`                                    | green — 1288 passed                |

### Two things that cost time and are worth recording

**The chmod has to happen before `codesign`, not after.** Changing a file inside
a signed bundle invalidates the signature, which would turn a working build into
the "damaged" dialog `sign-adhoc.cjs` exists to prevent. The repair is therefore
inside that hook, ahead of the signing calls, rather than in a step of its own.

**The first packaged run reported a failure that was not there.** The probe was
given node-pty's path under `app.asar.unpacked`, and node-pty rewrites its own
helper path with `.replace('app.asar', 'app.asar.unpacked')` — so an
already-unpacked path became `app.asar.unpacked.unpacked` and the helper was not
found. The app was fine; the harness was wrong. It cost a detour into signing and
quarantine before `exit=139` from the helper — a segfault, meaning it had
_executed_ — showed the exec bit was never the problem. Suspect the driver before
the code; the smoke script now applies the same rewrite, with a comment saying
why.

### Not verified, and why

- **`pnpm dev` was not launched as a GUI app.** The probe runs under the same
  Electron binary via `ELECTRON_RUN_AS_NODE`, which exercises the ABI, the
  helper and the spawn — but not the app's own window. There is no terminal in
  the UI to look at until Phase 3.
- **`pnpm verify:package` was not run end to end.** The new `spawn-helper`
  assertions were mutation-tested directly (they flip to `executable: false` at
  644 and back at 755), but the full script boots the bundle and waits on a real
  agent handshake, which is minutes and needs credentials. It should be run at
  the next release gate.
- **Only darwin-arm64.** The repair script walks every triple it finds, so
  darwin-x64 is repaired too, but nothing was run on it. Windows ships no
  `spawn-helper` at all and is untested per the plan.

### Files

| file                                   | why                                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| `apps/desktop/package.json`            | `node-pty@^1.1.0`                                                                       |
| `pnpm-workspace.yaml`                  | `allowBuilds: node-pty` — belt and braces; §3 shows it is not what produces the binding |
| `apps/desktop/electron.vite.config.ts` | external, so it stays a real file                                                       |
| `apps/desktop/electron-builder.yml`    | `files`, `asarUnpack`, and **`npmRebuild: false`**                                      |
| `apps/desktop/build/sign-adhoc.cjs`    | the packaged repair, before signing                                                     |
| `scripts/fix-spawn-helper.mjs`         | the dev repair; idempotent, walks every installed copy                                  |
| `package.json`                         | `postinstall`, plus `dev` calling it directly                                           |
| `eslint.config.mjs`                    | `scripts/**/*.mjs` has no tsconfig, like the other build scripts                        |
| `apps/desktop/e2e/packaged.mjs`        | the regression guard                                                                    |
| `apps/desktop/build/pty-smoke.cjs`     | **throwaway** — extended in Phase 1, deleted when the panel lands                       |

### The open question from this phase, since answered

Phase 0 could not prove pnpm runs the root `postinstall`, because install
short-circuits on "Already up to date" even under `--force`. Adding the two xterm
packages at the start of Phase 1 gave it real work, and it fired:

```
. postinstall$ node scripts/fix-spawn-helper.mjs
```

So the hook works on any install that does something, which includes a fresh
clone. `dev` calling the script directly stays as the belt to that braces.

## Phase 1 — shipped

The service that owns the shells. No IPC and no UI yet: this is the part that has
to be right before either of those can be built against it.

### What it is

`src/main/terminal.ts` — a `Pty` port, a `TerminalService`, and the real
`node-pty` spawner at the bottom. `src/main/shell.ts` — which shell, and how.

The port is the same move as `event-store`'s `port.ts`: one file knows what a PTY
is, and all 30 service tests drive a fake. That is what makes the lifecycle
testable at all without spawning shells in `pnpm check`.

### The three design claims, and the tests that would catch losing them

Each was mutation-tested — the guard was broken on purpose and the right tests
went red. A guard whose test passes without it is not a guard.

| claim                                   | mutation                          | result |
| --------------------------------------- | --------------------------------- | ------ |
| global and session storage are separate | `forget` also clears `global`     | 2 red  |
| a stale epoch is ignored                | epoch check dropped from `live()` | 3 red  |
| `detach` is not `dispose`               | `detach` also kills               | 1 red  |

The storage mutation exposed a weak assertion, which is the more useful half:
"ending a conversation leaves the global shell running" originally checked only
that the global PTY was not killed, and **passed while the global terminal was
orphaned** — dropped from storage, process leaked, user's terminal gone. It now
asserts the service still holds it.

That failure mode is not hypothetical here. `runtime.close()` carries a comment
about asides that describes it exactly: separate storage was right, _and_
quitting still left them running because nothing drained them. `TerminalService.close()`
drains the global slot for that reason, and the wiring comment says so.

### Verified against a real tty

The fake proves lifecycle; it cannot prove a tty. Run against a real shell:

```
PASS  a command runs, on a real tty — saw "hi\r\n"
PASS  ⌃C interrupts a foreground process — was sleep, now zsh
PASS  a full-screen program draws and exits cleanly — alt-screen entered and left
```

`was sleep, now zsh` is the one worth keeping: the foreground process actually
changed back, so the interrupt reached the process group as a signal rather than
closing a pipe. And `vi` both entered (`?1049h`) and left (`?1049l`) the alternate
screen, which is the property §4.4 rests on.

Snapshot fidelity was checked the same way, in the unit tests: colour set before
the retained output and an alternate-screen entry both survive
serialize-and-remount. A byte ring would lose both.

### Decisions taken here

**The live-child policy is expressible, not chosen.** The plan said settle it in
this phase because it shapes the disposal signature. What it actually shapes is
whether the service can _answer_ the question, so `describe(ref)` reports
`{ running, foreground, busy }` — busy meaning something other than the shell is
in the foreground, which is how a "this will lose work" prompt would decide. All
three candidate policies — never ask, ask when busy, ask only on quit — sit on
top of that without changing a signature. The product choice is still open and is
now cheap.

**Backpressure is paced by the headless mirror**, not by a renderer, and this
phase is where that matters most: with no panel open there is no renderer to
apply any, and a firehose would corrupt the very snapshot the panel exists to
restore. Tested with nobody attached.

**`reap.ts` is untouched.** Adding a shell name to `AGENT_PATTERNS` would
`SIGKILL` every `zsh` the user has open outside Chorus — the file's own rationale
is that matching by pattern is what keeps it from killing something unrelated,
and a bare shell name defeats it.

### Not verified

- **No UI.** Nothing is on screen; `⌘J` and the panels are Phase 3. Everything
  here was driven from tests and a probe.
- **The `⌃C` and `vi` probe is dev-path only.** It takes a node-pty path
  argument and was run against the packaged bundle for `echo hi` in Phase 0, but
  the interactive checks were not re-run there.
- **Sizes are forwarded, not observed.** `resize` reaches the PTY and the mirror,
  but nothing has yet watched a real `vim` reflow — that needs the panel.
