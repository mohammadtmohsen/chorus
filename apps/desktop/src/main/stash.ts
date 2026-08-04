import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

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

/** Big enough for a screenshot, small enough not to hand the renderer a bomb. */
export const MAX_PREVIEW_BYTES = 12 * 1024 * 1024

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
}

export interface FilePreview {
  readonly name: string
  readonly bytes: number
  /** A `data:` URL when this is an image small enough to show, else null. */
  readonly dataUrl: string | null
}

/**
 * What a pane needs to show an attachment.
 *
 * A `data:` URL rather than a path the renderer loads itself: the CSP allows
 * `img-src 'self' data:` and nothing else, deliberately — a renderer that can
 * fetch arbitrary local files is a renderer that can exfiltrate them if anything
 * ever gets injected into it. Reading here keeps that door shut, at the cost of
 * one copy in memory for something the size of a screenshot.
 */
export function previewFile(path: string): FilePreview {
  const name = basename(path)
  const stats = statSync(path)
  const type = IMAGE_TYPES[extname(path).toLowerCase()]

  if (type === undefined || !stats.isFile() || stats.size > MAX_PREVIEW_BYTES) {
    return { name, bytes: stats.size, dataUrl: null }
  }
  return {
    name,
    bytes: stats.size,
    dataUrl: `data:${type};base64,${readFileSync(path).toString('base64')}`,
  }
}
