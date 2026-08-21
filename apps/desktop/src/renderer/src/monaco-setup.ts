/*
 * `monaco-editor/editor/…`, not the `monaco-editor/esm/vs/editor/…` every
 * recipe on the web shows.
 *
 * Monaco 0.56 added an `exports` map whose pattern is `"./*": "./esm/vs/*.js"`,
 * so the old deep path now resolves to `esm/vs/esm/vs/…` and fails. Worth the
 * comment because the wrong form is what every search result still says.
 *
 * `editor.api` rather than the package root: the root is the full IDE bundle,
 * including the TypeScript, JSON, CSS and HTML language services. The
 * contribution below adds Monarch grammars — colouring, and nothing that needs
 * a language server.
 */
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/basic-languages/monaco.contribution'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'

/**
 * Monaco, wired for a sandboxed renderer, and nothing else.
 *
 * **Why a real editor here when the markdown parser is hand-written.** The
 * house rule is that xterm's exception "does not generalise", and the test it
 * sets is whether the mistakes are cosmetic or structural. A hand-rolled
 * markdown parser gets a paragraph slightly wrong; a hand-rolled *text editor*
 * gets composed IME input, bidi runs, undo across folded regions and a
 * 20k-line file wrong, and the failure mode is a corrupted buffer rather than
 * an ugly one. Same argument as the VT emulator, one level up.
 *
 * **Why only `editor.worker`.** The language services — TypeScript, JSON, CSS,
 * HTML — are separate workers, and none is imported. They exist for completion
 * and validation, which this app does not offer: an agent is the thing that
 * knows what the code means. Skipping them keeps the bundle to the editor and
 * avoids shipping a second TypeScript compiler. Syntax colouring is unaffected;
 * Monaco tokenises with Monarch on the main thread.
 *
 * The one worker that *is* needed is not optional: the diff editor computes its
 * alignment there, so without it a `DiffEditor` renders two panes and no
 * diff.
 *
 * **Why `?worker` rather than a CDN or `getWorkerUrl`.** The renderer runs with
 * `sandbox: true` and `webSecurity: true`. Monaco's default advice is to build
 * a `blob:` URL or point at a CDN, and both are exactly what those flags exist
 * to refuse. Vite's `?worker` import emits a real bundled file and hands back a
 * constructor, so the worker is same-origin and part of the app.
 *
 * If this ever stops loading in a *packaged* build, the answer is CodeMirror 6,
 * not `webSecurity: false`.
 */

interface MonacoWindow {
  MonacoEnvironment?: { getWorker: (moduleId: string, label: string) => Worker }
}

;(self as unknown as MonacoWindow).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
}

/**
 * The app's own colours, read off the stylesheet.
 *
 * Monaco does not understand CSS custom properties — it takes hex strings and
 * builds its own theme. So the tokens are resolved here and pushed in, which is
 * the same thing `readTheme` does for xterm, and for the same reason: the
 * terminal once painted itself on black in both colour schemes because nobody
 * checked the rendered colour, only that the tokens resolved.
 *
 * Every value has a fallback. A token renamed in `styles.css` should make the
 * editor slightly wrong, not invisible.
 */
function read(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  // A custom property that resolves to `` is not an error at the CSS layer, so
  // this is the only place the miss can be caught.
  return value === '' ? fallback : value
}

/**
 * Monaco rejects a colour it cannot parse and throws, taking the panel with it.
 * `styles.css` is free to use any CSS colour, so anything that is not plain hex
 * falls back rather than being handed over.
 */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const hex = (name: string, fallback: string): string => {
  const value = read(name, fallback)
  return HEX.test(value) ? value : fallback
}

export const CHORUS_DARK = 'chorus-dark'
export const CHORUS_LIGHT = 'chorus-light'

export function defineThemes(): void {
  const base: Omit<monaco.editor.IStandaloneThemeData, 'base'> = {
    inherit: true,
    // Empty: `inherit` takes vs-dark's token rules wholesale, and restating
    // them here would be a second, worse syntax theme to keep in step.
    rules: [],
    colors: {
      'editor.background': hex('--bg-chrome', '#16181c'),
      'editor.foreground': hex('--bone', '#e6e6e6'),
      'editorLineNumber.foreground': hex('--muted', '#8a8f98'),
      'editorGutter.background': hex('--bg-chrome', '#16181c'),
      ...diffColors(),
    },
  }

  monaco.editor.defineTheme(CHORUS_DARK, { ...base, base: 'vs-dark' })
  monaco.editor.defineTheme(CHORUS_LIGHT, {
    ...base,
    base: 'vs',
    colors: {
      ...base.colors,
      'editor.background': hex('--bg-chrome', '#ffffff'),
      'editor.foreground': hex('--bone', '#1c1c1c'),
    },
  })
}

/**
 * The two-tier wash, read from the same custom properties the hunks view uses.
 *
 * Four keys rather than two. Only the *word* tiers were set before, so Monaco
 * fell back to its own built-in line backgrounds — a palette nobody chose,
 * sitting under colours somebody did. Setting both makes the stack deliberate:
 * a line wash, and a second wash over the changed words on top of it.
 *
 * These are **theme colour keys**, not hand-authored decorations. Monaco owns
 * the decorating; all it needs is the palette.
 *
 * **Both themes get whichever palette is live when this runs**, because
 * `getComputedStyle` answers for the current scheme and cannot be asked about
 * the other one. That is not a bug only because `defineThemes` is re-called on
 * every scheme change before `setTheme` — so the *active* theme is always
 * current, and the inactive one is stale but never drawn. Remove that listener
 * and the diff silently keeps the old scheme's colours.
 */
function diffColors(): Record<string, string> {
  return {
    'diffEditor.insertedLineBackground': hex('--diff-line-added', '#347d3926'),
    'diffEditor.insertedTextBackground': hex('--diff-word-added', '#57ab5a4d'),
    'diffEditor.removedLineBackground': hex('--diff-line-removed', '#c93c3726'),
    'diffEditor.removedTextBackground': hex('--diff-word-removed', '#f470674d'),
    'editorGutter.addedBackground': hex('--diff-gutter-added', '#72c892'),
    'editorGutter.deletedBackground': hex('--diff-gutter-removed', '#f28772'),
  }
}

/** Which theme the current colour scheme wants. Re-read on every scheme change. */
export function themeNow(): string {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? CHORUS_LIGHT : CHORUS_DARK
}

/**
 * A language id from a filename, by extension.
 *
 * Monaco's own registry is the source of truth — it already knows which
 * extensions belong to which language, so a hand-written map here would be a
 * second, worse one that drifts.
 */
export function languageFor(path: string): string {
  const dot = path.lastIndexOf('.')
  const extension = dot < 0 ? '' : path.slice(dot)
  const name = path.slice(path.lastIndexOf('/') + 1)
  const match = monaco.languages
    .getLanguages()
    .find(
      (language) =>
        (extension !== '' && (language.extensions ?? []).includes(extension)) ||
        (language.filenames ?? []).includes(name)
    )
  return match?.id ?? 'plaintext'
}

export { monaco }
