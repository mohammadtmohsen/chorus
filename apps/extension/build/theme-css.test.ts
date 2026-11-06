import { beforeAll, describe, expect, it } from 'vitest'
import { preprocessCSS, resolveConfig } from 'vite'
import { chorusThemeCss } from './theme-css.js'

let config: Awaited<ReturnType<typeof resolveConfig>>

beforeAll(async () => {
  config = await resolveConfig(
    { configFile: false, logLevel: 'silent', css: { postcss: { plugins: [chorusThemeCss()] } } },
    'build'
  )
})

async function transform(source: string): Promise<string> {
  return (await preprocessCSS(source, 'theme.css', config)).code
}

const light = ':where(html.chorus-theme-light, html.chorus-theme-light *)'
const dark = ':where(html.chorus-theme-dark, html.chorus-theme-dark *)'

describe('chorusThemeCss', () => {
  it('keeps the Chorus palette and scopes root, element, and pseudo-element selectors', async () => {
    const css = await transform(`
      :root { --bg-canvas: #1f1f1f; }
      @media (prefers-color-scheme: light) {
        :root { --bg-canvas: #ffffff; }
        select, .note::before, .note:after { color: var(--bg-canvas); }
      }
    `)
    expect(css).toContain(':root { --bg-canvas: #1f1f1f; }')
    expect(css).toContain(`:root${light} { --bg-canvas: #ffffff; }`)
    expect(css).toContain(`select${light}`)
    expect(css).toContain(`.note${light}::before`)
    expect(css).toContain(`.note${light}:after`)
    expect(css).not.toContain('prefers-color-scheme')
    expect(css).not.toContain('--vscode-')
  })

  it('preserves unrelated breakpoint and reduced-motion media queries', async () => {
    const css = await transform(`
      @media (max-width: 720px) { .grid { display: block; } }
      @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
      @media (prefers-color-scheme: light) { .note { color: red; } }
    `)
    expect(css).toContain('@media (max-width: 720px) { .grid { display: block; } }')
    expect(css).toContain(
      '@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }'
    )
    expect(css).toContain(`.note${light}`)
  })

  it('preserves compound conditions while removing only the scheme condition', async () => {
    const css = await transform(`
      @media only screen and (prefers-color-scheme: light) and (max-width: 720px) {
        .note { color: red; }
      }
    `)
    expect(css).toContain('@media only screen and (max-width: 720px)')
    expect(css).toContain(`.note${light}`)
    expect(css).not.toContain('prefers-color-scheme')
    expect(css).not.toContain(dark)
  })

  it('preserves query-list alternatives independently for light and dark', async () => {
    const css = await transform(`
      @media print, (prefers-color-scheme: light) { .note { color: red; } }
    `)
    expect(css).toContain(`.note${light}`)
    expect(css).toContain(`@media print { .note${dark}`)
    expect(css).not.toContain('prefers-color-scheme')
  })

  it('handles negation, including the media-type modifier applying to the whole query', async () => {
    const css = await transform(`
      @media not screen and (prefers-color-scheme: light) { .note { color: red; } }
      @media not (prefers-color-scheme: light) { .other { color: blue; } }
    `)
    expect(css).toContain(`@media not screen { .note${light}`)
    expect(css).toContain(`.note${dark}`)
    expect(css).toContain(`.other${dark}`)
    expect(css).not.toContain(`.other${light}`)
    expect(css).not.toContain('prefers-color-scheme')
  })

  it('preserves grouped or conditions and selector functions containing commas', async () => {
    const css = await transform(`
      @media ((prefers-color-scheme: light) or (hover: hover)) and (width > 200px) {
        :is(:root, .note):not([data-value='::after'])::before { color: red; }
      }
    `)
    expect(css).toContain('@media (width > 200px)')
    expect(css).toContain('@media ((hover: hover)) and (width > 200px)')
    expect(css).toContain(`:is(:root, .note):not([data-value='::after'])${light}::before`)
    expect(css).toContain(`:is(:root, .note):not([data-value='::after'])${dark}::before`)
  })

  it('transforms nested theme queries before cloning their parent queries', async () => {
    const css = await transform(`
      @media (max-width: 720px) {
        @media (prefers-color-scheme: light) {
          @supports (display: grid) {
            @media (prefers-color-scheme: light) { .note { color: red; } }
          }
        }
      }
    `)
    expect(css).toContain('@media (max-width: 720px)')
    expect(css).toContain('@supports (display: grid)')
    expect(css).toContain(`.note${light}${light}`)
    expect(css).not.toContain('prefers-color-scheme')
  })

  it('keeps declarations and nested selectors inside their existing style rule', async () => {
    const css = await transform(`
      .note {
        @media (prefers-color-scheme: light) {
          color: red;
          @supports (display: grid) { & > .label { display: grid; } }
        }
      }
    `)
    expect(css).toContain(`&${light}`)
    expect(css).toContain('color: red;')
    expect(css).toContain('@supports (display: grid) { & > .label { display: grid; } }')
    expect(css).not.toContain('prefers-color-scheme')
  })

  it('keeps non-theme keyframes untouched and rejects theme-only global definitions', async () => {
    const source = '@keyframes pulse { from { opacity: 0; } to { opacity: 1; } }'
    expect(await transform(source)).toContain(source)
    await expect(transform(`@media (prefers-color-scheme: light) { ${source} }`)).rejects.toThrow(
      'Theme media queries must contain style rules'
    )
  })
})
