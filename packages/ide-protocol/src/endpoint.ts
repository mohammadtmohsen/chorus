import { posix, win32 } from 'node:path'

/**
 * Where the bridge listens, and where the extension looks — decided once.
 *
 * These two facts were duplicated as two bare `join(tmpdir(), 'chorus-ide')`
 * expressions, one in `ide-bridge.ts` and one in the extension's `extension.ts`,
 * with nothing tying them together. They agreed by luck. Adding a second
 * platform is exactly the change that breaks that kind of agreement, so the
 * rule moved here before the platform did.
 */

/**
 * `path` for the platform being reasoned about, which in tests is not this one.
 *
 * These three take a platform and then joined with `node:path`'s bare `join`,
 * which is bound to the *running* one. Harmless in production, where the two are
 * the same machine — and exactly the inconsistency `paths.ts` two files over
 * exists to avoid, which is how the Windows CI run found it: `endpointFor(...,
 * 'darwin')` on a Windows host returned `\tmp\chorus-ide\4242.sock`.
 */
function ops(platform: NodeJS.Platform): typeof win32 {
  return platform === 'win32' ? win32 : posix
}

/** The directory holding one `<pid>.json` descriptor per running Chorus. */
export function runtimeDirectory(
  tmp: string,
  platform: NodeJS.Platform = process.platform
): string {
  return ops(platform).join(tmp, 'chorus-ide')
}

/**
 * What `net.listen` binds and `net.connect` dials.
 *
 * On Windows a named pipe is not a filesystem path — it is a name in the
 * `\\.\pipe\` namespace, and `join()` cannot produce one. Node's `net` accepts
 * such a name wherever it accepts a socket path, so this is the only line that
 * has to know the difference; `connection.ts` on the extension side needs no
 * change at all.
 *
 * The pid is in the name because it already keys the descriptor, so two Chorus
 * instances cannot collide.
 *
 * **The pipe has no ACL of its own.** A Unix socket inherits 0600 from a chmod;
 * a named pipe created through Node's `net` is reachable by any process in the
 * session, because Node exposes no way to set a security descriptor on it. What
 * guards the channel on Windows is therefore the handshake token alone, and the
 * token is only as private as the descriptor file holding it. That is a real
 * reduction in defence-in-depth and it is recorded rather than papered over —
 * see `descriptorIsPrivate`.
 */
export function endpointFor(directory: string, pid: number, platform: NodeJS.Platform): string {
  if (platform === 'win32') return `\\\\.\\pipe\\chorus-ide-${String(pid)}`
  return ops(platform).join(directory, `${String(pid)}.sock`)
}

/** The descriptor is a real file on both platforms; only its contents differ. */
export function descriptorFor(
  directory: string,
  pid: number,
  platform: NodeJS.Platform = process.platform
): string {
  return ops(platform).join(directory, `${String(pid)}.json`)
}

/**
 * Whether a listening endpoint leaves something behind to clean up.
 *
 * A Unix socket is a filesystem node that outlives a crash and makes `listen`
 * fail on the next run. A named pipe vanishes when its last handle closes, so
 * there is nothing to unlink — and calling `chmod` or `rm` on the pipe name
 * throws ENOENT rather than doing nothing.
 */
export function endpointIsFile(platform: NodeJS.Platform): boolean {
  return platform !== 'win32'
}

/**
 * Whether a `stat` says only this user can read the thing.
 *
 * Pure, so both ends can share the judgement, and platform-aware because the
 * inputs are meaningless on Windows. libuv synthesises `mode` there from the
 * read-only attribute alone — a normal file reports `0o666` — so `mode & 0o077`
 * is non-zero for everything and the check rejected every descriptor. Both ends
 * failed closed independently: the bridge threw on startup and was swallowed by
 * a `try`/`catch` that only logs, and the extension skipped every descriptor and
 * reported "not running" forever. Two silent failures that looked like one
 * missing feature.
 *
 * `uid` is worse than meaningless: `process.getuid` is undefined on Windows, so
 * the old comparison was `0 !== undefined`, which is always true.
 *
 * Returning `true` on Windows is an admission that this layer of defence is
 * absent there, not a claim that it passed. The real guarantee that remains is
 * that `%TEMP%` is per-user on Windows by default.
 */
export function descriptorIsPrivate(
  stat: { readonly mode: number; readonly uid: number },
  processUid: number | undefined,
  platform: NodeJS.Platform
): boolean {
  if (platform === 'win32') return true
  if ((stat.mode & 0o077) !== 0) return false
  return stat.uid === processUid
}
