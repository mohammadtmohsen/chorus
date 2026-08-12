# Status

| Phase                                | State                          | Commit |
| ------------------------------------ | ------------------------------ | ------ |
| 0 — prove it packages                | **shipped**, strategy A chosen | —      |
| 1 — the terminal service in main     | not started                    | —      |
| 2 — IPC and flow control             | not started                    | —      |
| 3 — the two panels, `⌘J`, the button | not started                    | —      |
| 4 — persistence                      | not started                    | —      |

Nothing is committed. Everything below is in the working tree.

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
| `apps/desktop/build/pty-smoke.cjs`     | **throwaway** — delete in Phase 1                                                       |

### One thing to decide before Phase 1

`pnpm install` runs the root `postinstall`, but pnpm short-circuits on "Already
up to date" and skips it — even with `--force`. On a genuine fresh clone
node_modules is absent, so the install does real work and the hook fires; that
path was **not** exercised here, because forcing it from this checkout was not
possible. `dev` calls the script directly, so the common case is covered either
way. If it turns out pnpm does not run it on a fresh clone either, the repair
moves into the app's own startup for the unpackaged case.
