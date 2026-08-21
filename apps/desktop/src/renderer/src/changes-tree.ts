/**
 * Changed files as a folder tree, the same shape the project tree draws.
 *
 * A flat list of shortened paths was fine while a change touched three files.
 * It stops being fine at thirty: `…/renderer/Panel.tsx` and
 * `…/renderer/Panel.css` sit next to each other with no indication they are
 * siblings, and the part of the path that distinguishes them is the part that
 * was cut. A tree puts the shared prefix in one row and the difference at the
 * leaf, which is what makes a large change scannable.
 *
 * Pure and exported, like `transcript.ts`'s reducer, because the judgement is
 * here and the component is plumbing.
 */

export interface ChangeRow<T> {
  readonly kind: 'dir' | 'file'
  /** Repo-relative: the file's path, or the directory's. Unique per row. */
  readonly path: string
  /** What the row draws — a segment, or a compacted run of them. */
  readonly label: string
  readonly depth: number
  /** The changed file itself, on a leaf. */
  readonly file?: T
}

interface Node<T> {
  readonly children: Map<string, Node<T>>
  readonly files: { name: string; file: T }[]
}

const emptyNode = <T>(): Node<T> => ({ children: new Map(), files: [] })

/**
 * Group changed files into directory rows.
 *
 * **Single-child directory chains are compacted** into one row — `src/main`
 * rather than `src` containing `main` — for the same reason editors do it: a
 * column of one-child folders is indentation carrying no information, and in a
 * panel this narrow the indentation is the scarce thing.
 *
 * Everything is expanded. The list exists to show what changed, so hiding part
 * of it behind a disclosure would be answering a question nobody asked; that
 * is the difference between this and the project tree, where laziness is the
 * whole point.
 */
export function changeRows<T extends { path: string }>(files: readonly T[]): ChangeRow<T>[] {
  const root = emptyNode<T>()

  for (const file of files) {
    const segments = file.path.split('/')
    const name = segments.pop() ?? file.path
    let node = root
    for (const segment of segments) {
      let next = node.children.get(segment)
      if (next === undefined) {
        next = emptyNode<T>()
        node.children.set(segment, next)
      }
      node = next
    }
    node.files.push({ name, file })
  }

  const rows: ChangeRow<T>[] = []

  const walk = (node: Node<T>, prefix: string, depth: number): void => {
    for (const [segment, child] of node.children) {
      /*
       * Absorb a chain of directories that each hold exactly one directory and
       * no files of their own.
       */
      let label = segment
      let path = prefix === '' ? segment : `${prefix}/${segment}`
      let current = child
      while (current.files.length === 0 && current.children.size === 1) {
        // Read out rather than asserted: `size === 1` guarantees an entry, but
        // saying so with `!` or a cast buys nothing over letting the loop end.
        const only = [...current.children.entries()][0]
        if (only === undefined) break
        label = `${label}/${only[0]}`
        path = `${path}/${only[0]}`
        current = only[1]
      }

      rows.push({ kind: 'dir', path, label, depth })
      walk(current, path, depth + 1)
    }

    // Files after directories, matching the project tree's order.
    for (const { name, file } of node.files) {
      rows.push({ kind: 'file', path: file.path, label: name, depth, file })
    }
  }

  walk(root, '', 0)
  return rows
}
