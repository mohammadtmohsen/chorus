import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stashFile } from './stash.js'

/**
 * Where an image dropped into the global note actually lives.
 *
 * **A file beside the database, never inside the note.** A TipTap image node
 * carries a `src`, and the obvious `src` is a data URL — which would put the
 * bytes in the `app_note` row. That row is read whole on every launch, so ten
 * pasted screenshots would turn one startup read into tens of megabytes of
 * base64. The note holds a short URL instead and stays the size of its text.
 *
 * **Served by a private scheme rather than by path**, and that is forced rather
 * than chosen. `webSecurity` is on and the shell's own origin differs between
 * dev and a packaged build — `http://localhost` in one, `file://` in the other —
 * so an `<img src="file:///…">` works in exactly one of them. A scheme main owns
 * behaves the same in both and keeps the filesystem out of the renderer: the
 * renderer hands over bytes and receives a URL, and never learns a path.
 *
 * **The handler serves this one folder and nothing else.** Names are generated
 * here from a content hash, so anything that is not one is refused outright
 * rather than resolved and checked — there is no path to traverse when the only
 * accepted shape is sixteen hex characters and a known extension.
 */
export const NOTE_IMAGE_SCHEME = 'chorus-note'

/** The folder, under `userData`, holding every image any note refers to. */
const FOLDER = 'note-images'

/**
 * What may be stored and served.
 *
 * SVG is absent deliberately. It is a document rather than a bitmap, and while
 * an `<img>` will not run script in one, admitting it means the app stores a
 * file format whose safety depends on where it is later opened.
 */
export const TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** Generated here, so anything else is a request that cannot be for our file. */
export const NAME = /^[a-f0-9]{16}\.(png|jpg|jpeg|gif|webp)$/

export function folderIn(userDataPath: string): string {
  return join(userDataPath, FOLDER)
}

/**
 * Stores bytes and answers with the URL the note should hold.
 *
 * **Named by content hash, so the same image pasted twice is one file.** It also
 * means the name says nothing about where the image came from, which matters for
 * something typed into a note: a screenshot's original filename is often the
 * only private thing about it.
 *
 * Nothing is ever deleted here. An image whose note no longer mentions it is
 * left on disk — reference counting a document somebody is still editing is a
 * way to delete the picture in an undo buffer, and the cost of not doing it is
 * disk rather than correctness.
 */
export async function saveNoteImage(
  userDataPath: string,
  bytes: Uint8Array,
  extension: string
): Promise<{ url: string }> {
  const ext = extension.toLowerCase().replace(/^\./, '')
  if (!(ext in TYPES)) throw new Error(`Unsupported image type: ${extension}`)
  const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.${ext}`
  const folder = folderIn(userDataPath)
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, name), bytes)
  return { url: `${NOTE_IMAGE_SCHEME}://image/${name}` }
}

export async function copyNoteImageTo(
  userDataPath: string,
  url: string
): Promise<{ path: string }> {
  const parsed = new URL(url)
  if (parsed.protocol !== `${NOTE_IMAGE_SCHEME}:`) {
    throw new Error(`That address is not a note image: ${url}`)
  }
  const name = parsed.pathname.replace(/^\//, '')
  if (!NAME.test(name)) throw new Error(`That name is not a note image: ${name}`)
  const bytes = await readFile(join(folderIn(userDataPath), name))
  return { path: stashFile(userDataPath, name, bytes.toString('base64')) }
}

/**
 * An address, fetched here and stored like anything else.
 *
 * **The renderer cannot do this and must not be able to.** `img-src` admits only
 * this process's own scheme, so a remote address written straight into the note
 * would render as a broken image; and `connect-src 'self'` means the renderer
 * could not fetch it either. Bringing the bytes across here is what lets an
 * address work at all while the shell's policy stays exactly as narrow.
 *
 * `http` and `https` only. A `file:` address would turn a text field into a way
 * to read any file on the machine and copy it somewhere the renderer can see,
 * which is the whole thing `pickNoteImage` exists to avoid.
 */
export async function fetchNoteImage(
  userDataPath: string,
  address: string
): Promise<{ url: string }> {
  const parsed = new URL(address)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https addresses can be fetched')
  }
  const response = await fetch(parsed.href)
  if (!response.ok) throw new Error(`That address answered ${String(response.status)}`)
  /*
   * The type decides the extension, not the address. A URL ending in `.png` says
   * what somebody named a route; the response header says what arrived, and only
   * one of the two is that file.
   */
  const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? ''
  const ext = Object.keys(TYPES).find((candidate) => TYPES[candidate] === type)
  if (ext === undefined) throw new Error(`That address is not an image: ${type}`)
  return saveNoteImage(userDataPath, new Uint8Array(await response.arrayBuffer()), ext)
}
