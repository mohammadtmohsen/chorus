import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dialog, protocol } from 'electron'
import { NOTE_IMAGE_SCHEME, TYPES, NAME, folderIn, saveNoteImage } from './note-image-store.js'
export {
  NOTE_IMAGE_SCHEME,
  saveNoteImage,
  copyNoteImageTo,
  fetchNoteImage,
} from './note-image-store.js'

/**
 * Declares the scheme before the app is ready, which is the only time it can be.
 *
 * `standard` so the URL parses with a host and a path rather than as an opaque
 * blob, and `secure` so a page on it is not treated as mixed content. No
 * `supportFetchAPI` and no `corsEnabled`: an `<img>` needs neither, and every
 * privilege granted here is one the renderer could reach for later.
 */
export function registerNoteImageScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: NOTE_IMAGE_SCHEME, privileges: { standard: true, secure: true } },
  ])
}

/** Serves the folder, after the app is ready. */
export function serveNoteImages(userDataPath: string): void {
  protocol.handle(NOTE_IMAGE_SCHEME, async (request) => {
    /*
     * The name is the whole path, taken from `pathname` and nothing else. A
     * `standard` scheme gives `chorus-note://image/<name>`, so the host carries
     * no information and is ignored; reading anything from it would be a second
     * place a caller could put a path.
     */
    const name = new URL(request.url).pathname.replace(/^\//, '')
    const type = NAME.test(name) ? TYPES[name.split('.').pop() ?? ''] : undefined
    if (type === undefined) return new Response(null, { status: 404 })
    try {
      const bytes = await readFile(join(folderIn(userDataPath), name))
      return new Response(new Uint8Array(bytes), { headers: { 'content-type': type } })
    } catch {
      // Deleted by hand, or written by a build that stored them elsewhere. A
      // note holding a broken image is better than a window that will not load.
      return new Response(null, { status: 404 })
    }
  })
}

/**
 * The picker, opened and read in main.
 *
 * Here rather than in the renderer so that choosing a file never hands the
 * renderer a path: it receives the same URL a paste would produce, and the only
 * thing that ever reads the filesystem is this process.
 *
 * Null when the dialog was cancelled, which is not an error and must not be
 * reported as one.
 */
export async function pickNoteImage(userDataPath: string): Promise<{ url: string | null }> {
  const picked = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: Object.keys(TYPES) }],
  })
  const path = picked.filePaths[0]
  if (picked.canceled || path === undefined) return { url: null }
  const bytes = await readFile(path)
  return saveNoteImage(userDataPath, new Uint8Array(bytes), path.split('.').pop() ?? '')
}
