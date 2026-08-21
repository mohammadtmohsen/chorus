import { useEffect, useState } from 'react'
import { iconFor, type ColorScheme } from './file-icon.js'
import { languageFor } from './monaco-setup.js'

const QUERY = '(prefers-color-scheme: light)'

/**
 * The current scheme, and it re-renders when the OS flips.
 *
 * Same shape as `TerminalView` and `MonacoDiff` already use. Reading the media
 * query once at module load would be worse than useless: the icons would be
 * right until the user changed theme and then silently wrong, which is the
 * failure mode hardest to notice and hardest to attribute.
 */
function useColorScheme(): ColorScheme {
  const [scheme, setScheme] = useState<ColorScheme>(() =>
    window.matchMedia(QUERY).matches ? 'light' : 'dark'
  )
  useEffect(() => {
    const media = window.matchMedia(QUERY)
    const update = (): void => {
      setScheme(media.matches ? 'light' : 'dark')
    }
    media.addEventListener('change', update)
    update()
    return () => {
      media.removeEventListener('change', update)
    }
  }, [])
  return scheme
}

/**
 * One file-type icon. The judgement is in `file-icon.ts`; this is plumbing.
 *
 * **The glyph is set as a child, never as markup.** `iconFor` returns a
 * codepoint and React sets it as text, so there is no path by which a theme file
 * could inject anything — the no-`dangerouslySetInnerHTML` rule holds by
 * construction rather than by review.
 *
 * `aria-hidden`, because the filename beside it already says what this is. A
 * screen reader announcing "TypeScript icon, main.ts" is noise, not information.
 *
 * **Why the language id comes from Monaco.** Seti maps mostly by language rather
 * than by suffix: extension-only resolution covers 13.1% of this repo against
 * 97.1% routed. `languageFor` reads Monaco's own registry, which already knows
 * every extension-to-language pairing, so a hand-written map here would be a
 * second and worse one that drifts — the same argument `monaco-setup.ts` makes
 * for its own existence.
 *
 * That does couple the tree to Monaco, which is a real cost worth naming: if
 * Monaco is ever removed, this needs its own extension table. It is not an
 * *added* cost today, because `ChangesPanel` already imports Monaco statically
 * and that import was measured and deliberately kept.
 */
export function FileIcon({ path }: { readonly path: string }): React.JSX.Element | null {
  const scheme = useColorScheme()
  const icon = iconFor(path, languageFor(path), scheme)
  if (icon.char === '') return null
  return (
    <span className="file-icon" style={{ color: icon.color }} aria-hidden>
      {icon.char}
    </span>
  )
}
