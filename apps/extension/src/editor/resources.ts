import { posix, win32 } from 'node:path'
import {
  resolveDocument,
  type DocumentUri,
  type Provenance,
} from '@chorus/ide-protocol/document-identity'
import {
  hasRoot,
  isInside,
  platformForRoot,
  relativeInside,
  type Platform,
} from '@chorus/ide-protocol/paths'
import { remotePath } from '../../../desktop/src/shared/workbench-ipc.js'
import type { WorkbenchPlace } from '../../../desktop/src/main/project-root.js'

export interface ResourceUri extends DocumentUri {
  readonly authority: string
}

export interface DocumentLocation {
  readonly host: string
  readonly filePath: string
  readonly provenance: Provenance
}

export interface MappedResource {
  readonly scheme: string
  readonly authority: string
  readonly path: string
}

export function pathPlatform(root: string): Platform {
  return /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(root) ? 'win32' : platformForRoot(root, 'linux')
}

export function normalizedPath(path: string): string {
  if (pathPlatform(path) !== 'win32') return posix.normalize(path)
  return win32.normalize(/^[\\/][A-Za-z]:/.test(path) ? path.slice(1) : path)
}

export function hostForAuthority(authority: string): string | null {
  if (!authority.startsWith('ssh-remote+')) return null
  const name = authority.slice('ssh-remote+'.length)
  if (/^[a-zA-Z0-9][a-zA-Z0-9._@-]*$/.test(name)) return name.toLowerCase()
  return null
}

export function samePlace(a: WorkbenchPlace, b: WorkbenchPlace): boolean {
  if (a.host !== b.host) return false
  const platform = pathPlatform(a.root)
  const left = normalizedPath(a.root)
  const right = normalizedPath(b.root)
  return isInside(left, right, platform) && isInside(right, left, platform)
}

export function relativePath(place: WorkbenchPlace, location: DocumentLocation): string | null {
  if (place.host !== location.host) return null
  const relative = relativeInside(
    normalizedPath(place.root),
    normalizedPath(location.filePath),
    pathPlatform(place.root)
  )
  if (relative === null || relative === '') return null
  return pathPlatform(place.root) === 'win32' ? relative.replace(/\\/g, '/') : relative
}

export function locateDocument(
  uri: ResourceUri,
  resources: readonly ResourceUri[],
  localPlatform: Platform
): DocumentLocation | null {
  const platform = platformForRoot(
    uri.fsPath,
    uri.scheme === 'vscode-remote' ? 'linux' : localPlatform
  )
  const resolved =
    resolveDocument(uri, platform) ?? resolveDocument(uri, 'win32') ?? resolveDocument(uri, 'linux')
  if (resolved === null) return null
  if (uri.scheme === 'file') return { ...resolved, host: '' }
  const remote = hostForAuthority(uri.authority)
  if (remote !== null) return { ...resolved, host: remote }
  if (uri.authority !== '') return null
  if (uri.scheme === 'vscode-remote') return null

  const remoteResources = resources.filter((candidate) => candidate.scheme === 'vscode-remote')
  const matches = remoteResources.filter((candidate) =>
    isInside(
      normalizedPath(candidate.fsPath),
      normalizedPath(resolved.filePath),
      pathPlatform(candidate.fsPath)
    )
  )
  if (remoteResources.length > 0 && matches.length === 0) return null
  if (matches.length > 0) {
    if (
      resources.some(
        (candidate) =>
          candidate.scheme === 'file' &&
          isInside(
            normalizedPath(candidate.fsPath),
            normalizedPath(resolved.filePath),
            pathPlatform(candidate.fsPath)
          )
      )
    )
      return null
    const hosts = new Set(matches.map((candidate) => hostForAuthority(candidate.authority)))
    if (hosts.size !== 1 || hosts.has(null)) return null
    const host = hostForAuthority(matches[0]?.authority ?? '')
    return host === null ? null : { ...resolved, host }
  }
  return { ...resolved, host: '' }
}

export function isProjectRelativePath(path: string): boolean {
  if (
    path === '' ||
    path.includes('\0') ||
    /^[\\/]/.test(path) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)
  )
    return false
  const segments = path.split(/[\\/]/)
  return !segments.includes('..') && segments.some((segment) => segment !== '' && segment !== '.')
}

export function projectPath(place: WorkbenchPlace, path: string): string | null {
  if (!isProjectRelativePath(path)) return null
  const ops = pathPlatform(place.root) === 'win32' ? win32 : posix
  const joined = ops.join(place.root, ...path.split(/[\\/]/))
  const contained = relativePath(place, {
    host: place.host,
    filePath: joined,
    provenance: { kind: 'worktree' },
  })
  return contained === null ? null : joined
}

export function mapResource(
  place: WorkbenchPlace,
  filePath: string,
  resources: readonly ResourceUri[]
): MappedResource | null {
  const platform = pathPlatform(place.root)
  const normalized = normalizedPath(filePath)
  if (!hasRoot(normalized, platform)) return null
  if (
    relativePath(place, {
      host: place.host,
      filePath: normalized,
      provenance: { kind: 'worktree' },
    }) === null
  )
    return null
  return mapPath(place, normalized, resources)
}

export function mapProjectRoot(
  place: WorkbenchPlace,
  resources: readonly ResourceUri[]
): MappedResource | null {
  const root = normalizedPath(place.root)
  return hasRoot(root, pathPlatform(place.root)) ? mapPath(place, root, resources) : null
}

function mapPath(
  place: WorkbenchPlace,
  normalized: string,
  resources: readonly ResourceUri[]
): MappedResource | null {
  if (place.host === '') {
    const path = remotePath(normalized)
    if (path.startsWith('//')) {
      const boundary = path.indexOf('/', 2)
      if (boundary < 0) return null
      return { scheme: 'file', authority: path.slice(2, boundary), path: path.slice(boundary) }
    }
    return { scheme: 'file', authority: '', path }
  }
  const matching = resources.filter(
    (uri) => uri.scheme === 'vscode-remote' && hostForAuthority(uri.authority) === place.host
  )
  const authorities = new Set(matching.map((uri) => uri.authority))
  if (authorities.size !== 1) return null
  const template = matching[0]
  return template === undefined
    ? null
    : { scheme: template.scheme, authority: template.authority, path: remotePath(normalized) }
}
