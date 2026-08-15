/**
 * `env -u NAME -- command args`, for a machine that has no `env`.
 *
 * The desktop `dev` and `preview` scripts unset `ELECTRON_RUN_AS_NODE` before
 * launching electron-vite. That variable is set by whatever spawned the package
 * manager in some environments, and Electron respects it by starting as a bare
 * Node process — no window, no renderer, and an error that says nothing about
 * why. Unsetting it is not optional, and `env -u` does not exist on Windows.
 *
 * `cross-env` is the usual answer and it cannot do this: it sets variables and
 * has no syntax for removing one.
 *
 * Usage: `node scripts/without-env.mjs VAR_NAME -- command arg arg`
 */
import { spawn } from 'node:child_process'

const argv = process.argv.slice(2)
const separator = argv.indexOf('--')
if (separator === -1) {
  console.error('usage: without-env.mjs VAR [VAR...] -- command [args...]')
  process.exit(2)
}

const names = argv.slice(0, separator)
const [command, ...args] = argv.slice(separator + 1)
if (command === undefined) {
  console.error('without-env.mjs: no command given')
  process.exit(2)
}

// Built by filtering rather than by `delete`: same result, and it keeps the
// linter's no-dynamic-delete rule satisfied without an exception comment.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !names.includes(key)))

/*
 * `shell: true` on Windows, because the command is a package-manager binary
 * that arrives as a `.cmd` shim there — and `spawn` has refused to run those
 * without a shell since the CVE-2024-27980 fix. The arguments here are literals
 * from package.json rather than anything a user or an agent supplies, so the
 * usual objection to `shell: true` — that it re-reads metacharacters in
 * untrusted text — does not apply. `command.ts` in the app takes the other route
 * precisely because its arguments are untrusted.
 */
const child = spawn(command, args, {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
})

child.on('exit', (code, signal) => {
  // Signals have no exit code; 1 keeps a killed dev server from looking clean.
  process.exit(signal !== null ? 1 : (code ?? 0))
})
