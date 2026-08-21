/**
 * A file-type icon, from VS Code's own default icon theme.
 *
 * Seti rather than a hand-drawn set, and rather than the two obvious
 * alternatives, for reasons recorded in
 * `docs/plans/the-editor-you-already-know-2026-08-20/plan.md`:
 *
 *  - `vscode-icons` is the trap. Its LICENSE file says MIT and only its README
 *    says the *icons* are CC-BY-SA-4.0 with a branded carve-out, so reading the
 *    LICENSE — the careful thing to do — gets it wrong.
 *  - `material-icon-theme` is MIT and well maintained, but it is a third-party
 *    theme, not what VS Code looks like out of the box. 1.67 MB unpacked across
 *    1,387 files against Seti's 45 KB shipped: unfamiliarity at 18x the weight.
 *
 * **Seti is a font, and that is why it fits here.** An icon is a codepoint and a
 * colour, so it is set as `textContent` — never markup. That satisfies the
 * no-`dangerouslySetInnerHTML` rule by construction rather than by discipline,
 * the same way xterm does.
 *
 * **Seti has no folder icons, and that is not a gap.** VS Code's default has
 * none either. Directories keep the `▾`/`▸` chevron they already had; the icon
 * occupies the same fixed-width slot for files, which is why this drops in
 * without restructuring either tree.
 *
 * Pure and exported, per the renderer convention: the judgement is here and
 * testable, the components are plumbing.
 */
import rawTheme from './assets/seti-icons.json'

export interface FileIcon {
  /** The Seti codepoint, set as text. Never interpolated into markup. */
  readonly char: string
  readonly color: string
}

interface Definition {
  readonly fontCharacter?: string
  readonly fontColor?: string
}

type Lookup = Record<string, string | undefined>

/** One set of mappings. The theme carries two: the base, and a light override. */
interface SetiMaps {
  readonly file: string
  readonly fileExtensions: Lookup
  readonly fileNames: Lookup
  readonly languageIds: Lookup
}

interface SetiTheme extends SetiMaps {
  readonly iconDefinitions: Record<string, Definition | undefined>
  /**
   * **The light theme is a real second set, not a tint.**
   *
   * 238 extensions, 98 filenames, 82 language ids and its own `_default_light`
   * — TypeScript is `_typescript` in one and `_typescript_light` in the other.
   * Ignoring it does not produce slightly-off colours; it produces the *dark*
   * icons on a light ground, which is how this shipped for one round.
   */
  readonly light: SetiMaps
}

/*
 * One assertion at the boundary, rather than several against inferred literal
 * types. `resolveJsonModule` gives this file a ~1600-property literal type that
 * says nothing useful — every key is its own singleton — so narrowing it to the
 * maps actually read is both clearer and cheaper for the compiler.
 */
const theme = rawTheme as unknown as SetiTheme

export type ColorScheme = 'dark' | 'light'

/**
 * Which map sets to consult, in order.
 *
 * Light falls back to the base set, because the `light` block **overrides**
 * rather than replaces: it omits mappings that are identical in both, so a
 * light-only lookup would lose every one of them.
 */
function setsFor(scheme: ColorScheme): readonly SetiMaps[] {
  return scheme === 'light' ? [theme.light, theme] : [theme]
}

/**
 * Monaco omits `json` from its language definitions — 84 of them in 0.56, and
 * `json` is not one — while Seti's `languageIds` carries both `json` and
 * `jsonc`. Measured against this repo that single gap was **28 of the 32 files**
 * left unresolved after routing, so bridging it here takes coverage from 97.1%
 * to 99.6% — leaving four: `.gitignore`, `.prettierignore`, `.icns` and
 * `.codex-version`.
 *
 * This patches Monaco's omission, not Seti's: the key on the right is one Seti
 * already knows.
 */
const LANGUAGE_GAPS: Record<string, string> = { json: 'json' }

/**
 * `\E05A` is a CSS escape, not a character — five of them, not one.
 *
 * The theme file stores `fontCharacter` the way VS Code consumes it: as the
 * right-hand side of a CSS `content:` declaration, where the *stylesheet parser*
 * decodes the escape. Setting that string as `textContent`, which is what this
 * module does deliberately, would render a literal backslash followed by `E05A`.
 *
 * A guessed shape, caught by a test asserting the glyph was shorter than four
 * characters — an assertion written for a different reason entirely, about
 * markup safety. Read the format out of the file rather than assuming a
 * codepoint, which is the Adapters rule one level out.
 */
const CSS_ESCAPE = /^\\([0-9A-Fa-f]{1,6})$/

function decode(fontCharacter: string): string {
  const escaped = CSS_ESCAPE.exec(fontCharacter)
  return escaped === null
    ? fontCharacter
    : String.fromCodePoint(Number.parseInt(escaped[1] ?? '', 16))
}

function resolve(id: string | undefined): FileIcon | null {
  if (id === undefined) return null
  const definition = theme.iconDefinitions[id]
  if (definition?.fontCharacter === undefined) return null
  return { char: decode(definition.fontCharacter), color: definition.fontColor ?? 'currentColor' }
}

/** First hit across the ordered map sets — light overriding base, or base alone. */
function lookup(
  sets: readonly SetiMaps[],
  pick: (m: SetiMaps) => string | undefined
): FileIcon | null {
  for (const set of sets) {
    const found = resolve(pick(set))
    if (found !== null) return found
  }
  return null
}

/**
 * The icon for a path. Never null — an unrecognised file gets Seti's own
 * `_default`, which is what VS Code shows.
 *
 * Order follows VS Code: exact filename, then extension, then language id, then
 * the default. An earlier version returned `null` for no match and called that
 * a feature — "the caller decides what unknown looks like". It is not a feature
 * when the goal is parity: VS Code draws a generic file glyph there, and
 * returning nothing leaves a ragged column where every unmatched row is blank.
 *
 * `languageId` is what makes this worth doing at all. Seti maps mostly by
 * language rather than by suffix, so extension-only resolution covers **13.1%**
 * of this repo — 145 files out of 1,107, which reads as broken rather than
 * sparse. Routed through the language id it is **97.1%**.
 *
 * The lookup folds case, and that is not cosmetic: Seti's `fileNames` keys are
 * lowercase without exception, so a real `LICENSE` on disk resolves only
 * because of it. The first coverage measurement of this compared raw names and
 * undercounted naive matching by more than four times.
 */
export function iconFor(path: string, languageId?: string, scheme: ColorScheme = 'dark'): FileIcon {
  const sets = setsFor(scheme)
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()

  const exact = lookup(sets, (m) => m.fileNames[name])
  if (exact !== null) return exact

  /*
   * Longest suffix first, so `component.test.ts` can match a `test.ts` rule
   * before falling back to `ts`. VS Code resolves these by CSS specificity;
   * walking longest-to-shortest is the same order without the cascade.
   */
  const parts = name.split('.')
  for (let i = 1; i < parts.length; i++) {
    const suffix = parts.slice(i).join('.')
    const found = lookup(sets, (m) => m.fileExtensions[suffix])
    if (found !== null) return found
  }

  const extension = parts[parts.length - 1] ?? ''
  for (const language of [languageId, LANGUAGE_GAPS[extension]]) {
    if (language === undefined) continue
    const found = lookup(sets, (m) => m.languageIds[language])
    if (found !== null) return found
  }

  /*
   * Seti's own fallback, which the theme file names in its top-level `file` key
   * (`_default`, and `_default_light` in the light block). VS Code draws this
   * for anything it cannot place, so parity means drawing it too.
   */
  const fallback = lookup(sets, (m) => m.file)
  return fallback ?? { char: '', color: 'currentColor' }
}
