const DROP_TYPES = [
  'text/uri-list',
  'resourceurls',
  'application/vnd.code.resources',
  'application/vnd.code.resource',
  'application/vnd.code.editors',
  'codeeditors',
  'CodeEditors',
  'ResourceURLs',
]

export function hasUriDrop(types: readonly string[]): boolean {
  return DROP_TYPES.some((type) => types.includes(type))
}

export function localFilePath(value: string): string | null {
  try {
    const uri = new URL(value)
    if (uri.protocol !== 'file:') return null
    const path = decodeURIComponent(uri.pathname)
    if (uri.hostname !== '' && uri.hostname !== 'localhost') return `//${uri.hostname}${path}`
    return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path
  } catch {
    return null
  }
}

export function droppedUris(data: { readonly getData: (type: string) => string }): string[] {
  const found = new Set<string>()
  const add = (value: string): void => {
    try {
      const uri = new URL(value)
      if (uri.protocol !== 'file:' && uri.protocol !== 'vscode-remote:') return
      uri.hash = ''
      uri.search = ''
      found.add(uri.toString())
    } catch {
      return
    }
  }
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 5 || found.size >= 64) return
    if (typeof value === 'string') {
      add(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    if (typeof value !== 'object' || value === null) return
    const record = value as Record<string, unknown>
    if (
      (record['scheme'] === 'file' || record['scheme'] === 'vscode-remote') &&
      typeof record['path'] === 'string'
    ) {
      const scheme = record['scheme']
      const authority = typeof record['authority'] === 'string' ? record['authority'] : ''
      const path = record['path']
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/')
      add(`${scheme}://${authority}${path}`)
    }
    for (const key of ['resource', 'uri', 'original', 'modified']) visit(record[key], depth + 1)
  }
  for (const type of DROP_TYPES) {
    const raw = data.getData(type)
    if (raw === '') continue
    if (type === 'text/uri-list')
      for (const line of raw.split(/\r?\n/)) {
        if (!line.startsWith('#')) add(line.trim())
      }
    else {
      try {
        visit(JSON.parse(raw) as unknown)
      } catch {
        add(raw)
      }
    }
  }
  return [...found]
}
