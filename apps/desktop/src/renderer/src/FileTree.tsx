import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileIcon } from './FileIcon.js'
import type { IpcResponse } from '../../shared/ipc.js'

type TreeRead = IpcResponse<'workspace:tree'>
type TreeEntry = TreeRead['entries'][number]

/**
 * The project, one directory at a time.
 *
 * **Lazy, and the laziness is the design.** A directory is read when it is
 * expanded and not before, so a repository with `node_modules` costs nothing
 * until someone opens it — and `readDirectory` in main drops what `.gitignore`
 * covers, so they cannot.
 *
 * **Flat rows, not nested elements.** The tree is rendered as one list with an
 * indent per depth rather than as nested `<ul>`s. That keeps the DOM shallow
 * for a deep path, and it is what makes a single roving `tabIndex` work: with
 * nesting, arrow-key movement has to walk a structure rather than an index.
 */
export function FileTree({
  conversationId,
  expanded,
  selectedPath,
  onToggle,
  onSelect,
  onError,
}: {
  conversationId: string
  expanded: readonly string[]
  selectedPath: string | null
  onToggle: (path: string) => void
  onSelect: (path: string) => void
  onError: (message: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()

  /*
   * One entry per directory read, keyed by its path. `''` is the root.
   *
   * Held here rather than in the store: it is a cache of what is on disk, not a
   * decision anyone made, and persisting it would mean restoring a listing that
   * may be months stale. Expansion — which *is* a decision — lives in the store.
   */
  const [listings, setListings] = useState<Record<string, TreeEntry[]>>({})
  const [loading, setLoading] = useState<Record<string, boolean>>({})

  const load = useCallback(
    (path: string): void => {
      setLoading((current) => ({ ...current, [path]: true }))
      window.chorus
        .readTree({ conversationId, path })
        .then((result) => {
          if (result.problem !== null) {
            onError(result.problem)
            return
          }
          setListings((current) => ({ ...current, [path]: result.entries }))
        })
        .catch((e: unknown) => {
          onError(e instanceof Error ? e.message : String(e))
        })
        .finally(() => {
          setLoading((current) => ({ ...current, [path]: false }))
        })
    },
    [conversationId, onError]
  )

  // The root, and every directory the store says is open — on mount, so a
  // restored expansion is filled in rather than showing as empty.
  useEffect(() => {
    load('')
    for (const path of expanded) load(path)
    // `expanded` deliberately absent: this is the initial fill. Expanding after
    // mount loads through `toggle` below, and re-running here on every change
    // would re-read every open directory each time one of them moved.
    //
    // No lint suppression, because this project does not enable
    // `react-hooks/exhaustive-deps` — a disable comment naming a rule that is
    // not configured is itself an error.
  }, [load])

  const toggle = (path: string): void => {
    if (!expanded.includes(path) && listings[path] === undefined) load(path)
    onToggle(path)
  }

  /** Flattened depth-first, so the DOM is a list and the indent carries the shape. */
  const rows: { entry: TreeEntry; depth: number }[] = []
  const walk = (path: string, depth: number): void => {
    for (const entry of listings[path] ?? []) {
      rows.push({ entry, depth })
      if (entry.directory && expanded.includes(entry.path)) walk(entry.path, depth + 1)
    }
  }
  walk('', 0)

  if (rows.length === 0) {
    return (
      <p className="muted changes-empty">
        {loading[''] === true ? t('changesPanel.loading') : t('changesPanel.emptyTree')}
      </p>
    )
  }

  return (
    <nav className="changes-tree" aria-label={t('changesPanel.tree')}>
      {rows.map(({ entry, depth }) => (
        <button
          key={entry.path}
          type="button"
          className="changes-tree-row"
          // The indent is a custom property rather than inline padding so the
          // rule that draws it stays in the stylesheet with the rest.
          style={{ ['--depth' as string]: String(depth) }}
          data-on={entry.path === selectedPath}
          data-directory={entry.directory}
          title={entry.path}
          aria-expanded={entry.directory ? expanded.includes(entry.path) : undefined}
          onClick={() => {
            if (entry.directory) toggle(entry.path)
            else onSelect(entry.path)
          }}
        >
          <span className="changes-tree-twist" aria-hidden>
            {entry.directory ? (expanded.includes(entry.path) ? '▾' : '▸') : ''}
          </span>
          {entry.directory ? null : <FileIcon path={entry.path} />}
          <span className="changes-tree-name">{entry.name}</span>
        </button>
      ))}
    </nav>
  )
}
