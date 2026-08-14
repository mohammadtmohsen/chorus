import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The palette, checked against the stylesheet rather than against a copy of it.
 *
 * This reads `styles.css` and pulls the token values out of the two blocks that
 * declare them, so it cannot pass because someone updated a table in a test
 * while changing a hex in the sheet. That is the failure mode worth guarding:
 * the tokens this replaces were below AA for years with a plan document
 * asserting otherwise.
 *
 * What it enforces:
 *
 * - every readable text token is at least 4.5:1 on every surface it is
 *   documented against;
 * - anything a pointer has to find — a control boundary, the focus ring — is at
 *   least 3:1;
 * - the two exceptions, disabled text and decorative marks, are named here
 *   rather than reached by falling through a generic token. If a new token
 *   appears and is not in one of these lists, the last test fails.
 */

const CSS = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8')

/**
 * The `:root` block, and the `prefers-color-scheme: light` block after it.
 *
 * Sliced by index rather than parsed: the light block is the only
 * `@media (prefers-color-scheme: light)` in the file, and everything before it
 * that declares a token declares the dark one.
 */
function tokens(theme: 'dark' | 'light'): Record<string, string> {
  const boundary = CSS.indexOf('@media (prefers-color-scheme: light)')
  expect(boundary).toBeGreaterThan(0)
  const dark = CSS.slice(0, boundary)
  const light = CSS.slice(boundary, CSS.indexOf('\n}\n', CSS.indexOf('}', boundary + 100)) + 3)
  const found: Record<string, string> = {}
  for (const source of theme === 'dark' ? [dark] : [dark, light]) {
    for (const [, name, value] of source.matchAll(/^\s*(--[a-z-]+):\s*(#[0-9a-f]{6});$/gm)) {
      if (name !== undefined && value !== undefined) found[name] = value
    }
  }
  return found
}

function channel(value: number): number {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function luminance(hex: string): number {
  const r = channel(Number.parseInt(hex.slice(1, 3), 16))
  const g = channel(Number.parseInt(hex.slice(3, 5), 16))
  const b = channel(Number.parseInt(hex.slice(5, 7), 16))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (Number(light) + 0.05) / (Number(dark) + 0.05)
}

/** Every surface a token is allowed to be drawn on. */
const ALL_SURFACES = ['--bg-canvas', '--bg-chrome', '--bg-surface', '--bg-control'] as const

/**
 * Readable text, and where each one is documented to appear.
 *
 * `--danger` omits `--bg-control` deliberately and not by oversight: dark
 * `#f85149` reaches only 3.88:1 there, so no rule may put a failure notice on a
 * pressed control or an input. That is a constraint on the components, which is
 * why it is written down as one rather than left to be rediscovered.
 */
const READABLE: Readonly<Record<string, readonly string[]>> = {
  '--text-primary': ALL_SURFACES,
  '--text-secondary': ALL_SURFACES,
  '--text-muted': ALL_SURFACES,
  '--text-placeholder': ALL_SURFACES,
  '--accent-text': ALL_SURFACES,
  '--danger': ['--bg-canvas', '--bg-chrome', '--bg-surface'],
  '--voice-codex': ALL_SURFACES,
  '--voice-claude': ALL_SURFACES,
}

/** Boundaries and marks a pointer has to find. Not text; 3:1 is the bar. */
const MEANINGFUL_EDGES: Readonly<Record<string, readonly string[]>> = {
  '--border-strong': ALL_SURFACES,
  '--focus-ring': ALL_SURFACES,
}

/**
 * The named exceptions, and the reason each is allowed to be quieter.
 *
 * `--border-default` is here because it separates two surfaces rather than
 * marking a control — the sheet has `--border-strong` for anything that does.
 */
const EXCEPTIONS: Readonly<Record<string, string>> = {
  '--text-disabled': 'a control that cannot be operated',
  '--mark-decorative': 'a tick, a dot, a rule — nothing readable',
  '--border-default': 'separates surfaces; --border-strong marks controls',
}

describe.each(['dark', 'light'] as const)('the %s theme', (theme) => {
  const palette = tokens(theme)

  it('declares every token the components read', () => {
    for (const name of [
      ...ALL_SURFACES,
      ...Object.keys(READABLE),
      ...Object.keys(MEANINGFUL_EDGES),
      ...Object.keys(EXCEPTIONS),
    ]) {
      expect(palette[name], `${name} is declared`).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('keeps readable text at 4.5:1 on every surface it may sit on', () => {
    for (const [token, surfaces] of Object.entries(READABLE)) {
      for (const surface of surfaces) {
        const foreground = palette[token]
        const background = palette[surface]
        expect(foreground).toBeDefined()
        expect(background).toBeDefined()
        const ratio = contrast(String(foreground), String(background))
        expect(
          Number(ratio.toFixed(2)),
          `${token} on ${surface} in ${theme}`
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('keeps meaningful boundaries and the focus ring at 3:1', () => {
    for (const [token, surfaces] of Object.entries(MEANINGFUL_EDGES)) {
      for (const surface of surfaces) {
        const ratio = contrast(String(palette[token]), String(palette[surface]))
        expect(
          Number(ratio.toFixed(2)),
          `${token} on ${surface} in ${theme}`
        ).toBeGreaterThanOrEqual(3)
      }
    }
  })

  /*
   * Not "is it quiet enough" — that is not a requirement — but "is it actually
   * a different decision". A disabled token that happened to equal a readable
   * one would pass every test above and mean nothing.
   */
  it('keeps the exceptions distinct from the readable tokens', () => {
    for (const token of Object.keys(EXCEPTIONS)) {
      for (const readable of Object.keys(READABLE)) {
        expect(palette[token], `${token} is not ${readable}`).not.toBe(palette[readable])
      }
    }
  })
})

/**
 * The body of one rule, by its exact selector.
 *
 * Crude on purpose: the selector has to be written the way the sheet writes it,
 * so a rule that is renamed fails here rather than quietly matching nothing and
 * passing. `undefined` means the rule is gone, which every caller treats as a
 * failure.
 */
function rule(selector: string): string | undefined {
  const at = CSS.indexOf(`\n${selector} {`)
  if (at < 0) return undefined
  return CSS.slice(at + selector.length + 3, CSS.indexOf('\n}', at))
}

/** What `opacity: a` over `background` actually leaves, as a hex. */
function composite(foreground: string, background: string, alpha: number): string {
  const mix = (from: number, to: number): string =>
    Math.round(alpha * from + (1 - alpha) * to)
      .toString(16)
      .padStart(2, '0')
  const channels = [1, 3, 5].map((at) =>
    mix(
      Number.parseInt(foreground.slice(at, at + 2), 16),
      Number.parseInt(background.slice(at, at + 2), 16)
    )
  )
  return `#${channels.join('')}`
}

/**
 * Three rules where the *cascade* is the behaviour, not the value.
 *
 * A token can be perfect and the rule that reads it still wrong, and each of
 * these shipped that way: a translucent mark measured below the floor its token
 * clears comfortably, a danger colour beaten by a more specific neighbour, and a
 * state colour hard-coded to one agent. None of them fail a token test, and
 * nothing in the app fails at all — it simply draws the wrong thing.
 */
describe.each(['dark', 'light'] as const)('the %s theme, at the rules', (theme) => {
  const palette = tokens(theme)

  /*
   * The overflow control on a drawer row. It rested at `opacity: 0.55` over
   * `--text-muted`, which composites to 2.87:1 on the dark drawer and 2.31:1 on
   * the light one — under the 3:1 a control someone has to find is held to,
   * while the token it names clears 4.5:1 on its own. Translucency is how a
   * readable token turns decorative with nothing in the sheet saying so.
   */
  it('keeps the resting More mark at 3:1 after its own opacity', () => {
    const body = rule('.session-row-more')
    expect(body, '.session-row-more is still a rule').toBeDefined()
    const colour = /color:\s*var\((--[a-z-]+)\)/.exec(String(body))?.[1]
    expect(colour, 'it names a token rather than a hex').toBeDefined()
    const alpha = Number(/^\s*opacity:\s*([\d.]+);/m.exec(String(body))?.[1] ?? '1')

    for (const surface of ['--bg-chrome', '--bg-surface'] as const) {
      const drawn = composite(String(palette[String(colour)]), String(palette[surface]), alpha)
      expect(
        Number(contrast(drawn, String(palette[surface])).toFixed(2)),
        `${String(colour)} at ${String(alpha)} on ${surface} in ${theme}`
      ).toBeGreaterThanOrEqual(3)
    }
  })

  /*
   * The armed End confirmation, which is ordinary text and held to 4.5:1.
   *
   * It filled with `color-mix(in srgb, var(--danger) 16%, transparent)` and kept
   * its label in `--danger`: 3.76:1 in dark, on the one label in the app that
   * asks whether you are sure. Any tint of a light colour into a surface moves
   * the surface *towards* the foreground, so no percentage of that mix could
   * have reached the floor — which is why the check below refuses a translucent
   * fill outright rather than measuring one.
   *
   * All three armed rules are read, not just the base one: hover and focus each
   * restate the pair, and a rule that dropped the foreground while keeping the
   * fill would put `--text-primary` on red without failing anything else here.
   */
  const ARMED = [
    ".session-menu button.session-menu-danger[data-armed='true']",
    ".session-menu button.session-menu-danger[data-armed='true']:hover:not(:disabled)",
    ".session-menu button.session-menu-danger[data-armed='true']:focus-visible",
  ]

  it.each(ARMED)('keeps the armed End confirmation at 4.5:1 — %s', (selector) => {
    const body = rule(selector)
    expect(body, `${selector} is still a rule`).toBeDefined()

    /*
     * A named token on both sides. A mix, a raw hex or a missing half is the
     * shape the 3.76:1 version had, and each is rejected by name so the failure
     * says which one came back.
     */
    expect(body, 'the armed fill is a solid token, not a translucent mix').not.toContain(
      'color-mix'
    )
    const background = /background:\s*var\((--[a-z-]+)\);/.exec(String(body))?.[1]
    const foreground = /\n\s*color:\s*var\((--[a-z-]+)\);/.exec(String(body))?.[1]
    expect(background, `${selector} names a background token`).toBeDefined()
    expect(foreground, `${selector} names a foreground token`).toBeDefined()

    const ratio = contrast(String(palette[String(foreground)]), String(palette[String(background)]))
    expect(
      Number(ratio.toFixed(2)),
      `${String(foreground)} on ${String(background)} in ${theme}`
    ).toBeGreaterThanOrEqual(4.5)
  })

  /*
   * And the ring stays findable on that fill. It is drawn outside the button, so
   * its neighbour is the menu's own surface rather than the red — asserting the
   * offset is positive is asserting exactly that.
   */
  it('keeps the armed confirmation focusable in view', () => {
    const body = String(
      rule(".session-menu button.session-menu-danger[data-armed='true']:focus-visible")
    )
    expect(body).toContain('var(--focus-ring)')
    const offset = /outline-offset:\s*(-?[\d.]+)px;/.exec(body)?.[1]
    expect(Number(offset), 'the ring sits outside the fill, on --bg-surface').toBeGreaterThan(0)
    expect(
      Number(contrast(String(palette['--focus-ring']), String(palette['--bg-surface'])).toFixed(2)),
      `--focus-ring on --bg-surface in ${theme}`
    ).toBeGreaterThanOrEqual(3)
  })
})

/*
 * `.session-menu button` is a class and a type; `.session-menu-danger` is one
 * class. The sheet said danger and the app drew `--text-primary`, which is the
 * worst kind of styling bug — the intent is written down and contradicted, and
 * nothing anywhere fails.
 */
it('lets End actually win the cascade', () => {
  expect(rule('.session-menu button.session-menu-danger')).toContain('var(--danger)')
  // The losing form, which is what this replaced.
  expect(CSS).not.toMatch(/\n\.session-menu-danger \{/)
})

/*
 * The working mark is the one place a state colour names an agent, so it has to
 * name the right one. It read `--voice-codex` outright, which made every Claude
 * session's mark Codex-coloured; the base is now neutral for a turn with both
 * agents in it, and each voice is its own rule.
 */
it('draws the working mark in the voice of whoever is working', () => {
  expect(rule(".state-mark[data-state='working']")).not.toContain('--voice-')
  expect(rule(".state-mark[data-state='working'][data-voice='codex']")).toContain(
    'var(--voice-codex)'
  )
  expect(rule(".state-mark[data-state='working'][data-voice='claude']")).toContain(
    'var(--voice-claude)'
  )
})

/**
 * The token that started this.
 *
 * `--faint` was the app's general-purpose quiet text colour and was below AA on
 * every surface in both themes. Its absence is a rule, not a side effect: a
 * reintroduction would be a single line and would put every label it touched
 * back under the floor.
 */
it('has no general-purpose faint text token', () => {
  // Declaration or use, not any mention: the comment that records why it went
  // has to be allowed to name it.
  expect(CSS).not.toMatch(/--faint\s*:/)
  expect(CSS).not.toContain('var(--faint)')
})

/**
 * Both themes decide the same set of tokens.
 *
 * The light block redeclares only the semantic tokens; the aliases above it are
 * written as `var(--…)` so they follow. A token added to one block and not the
 * other resolves to the dark value in light mode, which is the exact shape of
 * the bug this file exists to prevent.
 */
it('decides every semantic token in both themes', () => {
  const boundary = CSS.indexOf('@media (prefers-color-scheme: light)')
  const light = CSS.slice(boundary)
  const semantic = [
    ...ALL_SURFACES,
    ...Object.keys(READABLE),
    ...Object.keys(MEANINGFUL_EDGES),
    ...Object.keys(EXCEPTIONS),
  ]
  for (const token of semantic) {
    expect(light, `${token} is re-decided for the light theme`).toContain(`${token}:`)
  }
})
