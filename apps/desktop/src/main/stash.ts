import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Somewhere for pasted bytes to live.
 *
 * Chorus passes agents **paths**, not attachments — the filesystem is not scoped
 * (§4.4), so an agent reads a file the same way you would. That works for
 * anything dragged from Finder, which already has a path, and not at all for an
 * image pasted from the clipboard, which is bytes and nothing else.
 *
 * So those bytes are written down and the path is what gets pasted. It lives
 * beside the log rather than in `/tmp`, because a conversation that refers to a
 * file should still find it tomorrow.
 */

/** Keeps one paste from overwriting another within the same second. */
let counter = 0

export function stashFile(userDataPath: string, name: string, base64: string): string {
  const directory = join(userDataPath, 'pasted')
  mkdirSync(directory, { recursive: true })

  counter += 1
  const safe = name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'paste'
  const path = join(directory, `${String(Date.now())}-${String(counter)}-${safe}`)
  writeFileSync(path, Buffer.from(base64, 'base64'))
  return path
}
