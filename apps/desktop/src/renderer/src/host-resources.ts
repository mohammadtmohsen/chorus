import { NOTE_IMAGE_URL_PREFIX } from './attach.js'
import { localFilePath } from './drop-uris.js'

export interface ContinuousRowBridge {
  readonly wheel: (paneId: string, delta: number) => boolean
  readonly rowMoved: (paneId: string) => void
}

export interface HostResources {
  readonly noteImageUrl: (url: string) => string
  readonly resolveDropUris?: (uris: readonly string[]) => Promise<readonly string[]>
  readonly continuousRow?: ContinuousRowBridge
}

const desktopResources: HostResources = { noteImageUrl: (url) => url }
let resources = desktopResources

export function configureHostResources(next: HostResources = desktopResources): void {
  resources = next
}

export function continuousRowBridge(): ContinuousRowBridge | undefined {
  return resources.continuousRow
}

export function resolveNoteImageUrl(url: string): string {
  return url.startsWith(NOTE_IMAGE_URL_PREFIX) ? resources.noteImageUrl(url) : url
}

export function resolveDropUris(uris: readonly string[]): Promise<readonly string[]> {
  return (
    resources.resolveDropUris?.(uris) ??
    Promise.resolve(
      uris.flatMap((uri) => {
        const path = localFilePath(uri)
        return path === null ? [] : [path]
      })
    )
  )
}
