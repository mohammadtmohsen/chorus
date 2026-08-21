import { describe, expect, it } from 'vitest'
import { iconFor } from './file-icon.js'

/**
 * The measurement that justified the phase, reduced to assertions.
 *
 * The point of these is not that some icon comes back — it is that the *routing*
 * works, because extension-only resolution covers 13.1% of this repo and would
 * ship a tree with 145 icons in 1,107 files.
 */
describe('iconFor', () => {
  it('does not resolve TypeScript by suffix alone', () => {
    // Seti maps .ts by language, not extension. Without a language id this
    // falls all the way through to the default glyph rather than the
    // TypeScript one — which is the whole reason the routing exists.
    expect(iconFor('src/main.ts').char).toBe(iconFor('nothing.unknownext').char)
  })

  it('resolves TypeScript once routed through its language id', () => {
    const icon = iconFor('src/main.ts', 'typescript')
    // A decoded glyph, not the `\E05A` escape the theme file stores.
    expect(icon.char).not.toMatch(/^\\/)
    expect(icon.color).toMatch(/^#/)
    expect(icon.char).not.toBe(iconFor('nothing.unknownext').char)
  })

  it('bridges the json gap Monaco leaves, with no language id', () => {
    // 28 of the 32 files unresolved after routing were .json, because Monaco
    // ships no `json` language definition. This is the line that closes it.
    expect(iconFor('tsconfig.json').char).not.toBe(iconFor('nothing.unknownext').char)
  })

  it('matches an exact filename, case-insensitively', () => {
    // Seti's `fileNames` keys are all lowercase — there is not one uppercase
    // character among them — so a real `LICENSE` on disk only resolves because
    // the lookup folds case. This is also the case the coverage measurement
    // originally got wrong by comparing raw names.
    expect(iconFor('LICENSE').char).toBe(iconFor('license').char)
    expect(iconFor('LICENSE').char).not.toBe(iconFor('nothing.unknownext').char)
  })

  it('falls back to Seti’s own default rather than nothing', () => {
    // An earlier version returned null here and called it a feature. It is not
    // one when the goal is parity: VS Code draws a generic file glyph, and
    // returning nothing leaves a ragged column of blanks.
    const fallback = iconFor('.codex-version')
    expect(fallback.char).not.toBe('')
    expect(fallback.color).toMatch(/^#/)
  })

  it('decodes the CSS escape into an actual glyph', () => {
    // The bug this file caught. Seti stores `\E05A` — five characters, meant for
    // a CSS `content:` where the stylesheet parser decodes it. Set as
    // textContent undecoded, the tree would have rendered a literal backslash
    // and four hex digits beside every filename.
    const icon = iconFor('src/main.ts', 'typescript')
    expect(icon.char).not.toMatch(/^\\/)
    // Seti's codepoints sit in the BMP private-use area, so one UTF-16 unit.
    expect(icon.char).toHaveLength(1)
    expect(icon.char.codePointAt(0)).toBeGreaterThan(0xe000)
  })

  it('uses the light palette in light mode, not the dark one tinted', () => {
    // The `light` block is a real second mapping set — 238 extensions, 98
    // filenames, 82 language ids, and its own `_default_light`. TypeScript is
    // `_typescript` in one and `_typescript_light` in the other. Ignoring it
    // does not give slightly-off colours, it gives the DARK icons on a light
    // ground, which is exactly how this shipped for one round.
    const dark = iconFor('src/main.ts', 'typescript', 'dark')
    const light = iconFor('src/main.ts', 'typescript', 'light')
    expect(light.color).not.toBe(dark.color)
  })

  it('falls back to the base mapping for anything light does not override', () => {
    // The light block OVERRIDES rather than replaces: it omits entries that are
    // identical in both. A light-only lookup would lose every one of them.
    const light = iconFor('LICENSE', undefined, 'light')
    expect(light.char).not.toBe('')
  })

  it('never returns markup', () => {
    // The whole safety argument for a font is that an icon is text rather than
    // markup. If a fontCharacter ever carried a tag, setting it as textContent
    // would still be safe -- but the theme file would not be what we think.
    expect(iconFor('src/main.ts', 'typescript').char).not.toContain('<')
  })
})
