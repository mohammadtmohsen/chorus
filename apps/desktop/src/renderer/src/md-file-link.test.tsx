/** @vitest-environment jsdom */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownView } from './MarkdownView.js'

/**
 * A link an agent writes to a file in the project.
 *
 * Mounted because the question is what pressing it *does*, and driving the app
 * cannot answer that: with an editor attached the click succeeds silently, and
 * without one it fails silently, so the observable difference between "the
 * handler ran" and "nothing happened" is nil. Verified against the real app
 * that the link renders and carries the path; this pins the click.
 */

afterEach(() => {
  cleanup()
})

const PATH = 'docs/plans/contract-workspace/08-rename-to-pact.md'

describe('a markdown link to a project file', () => {
  it('is a button that opens the path, not a browser link', () => {
    const opened: string[] = []
    const { container } = render(
      <MarkdownView
        source={`Plan written → [\`${PATH}\`](${PATH}) · board task **T-069**.`}
        onOpenFile={(path) => opened.push(path)}
      />
    )

    // The bug: with no rule for relative paths the whole link rendered as its
    // own source, brackets and all.
    expect(container.textContent).not.toContain('](')
    const link = container.querySelector<HTMLButtonElement>('.md-file-link')
    expect(link?.tagName).toBe('BUTTON')
    expect(link?.dataset['openFile']).toBe(PATH)
    // The path is usually written in backticks; the chip survives inside.
    expect(link?.querySelector('.md-inline-code')?.textContent).toBe(PATH)

    link?.click()
    expect(opened).toEqual([PATH])
  })

  it('stays plain words when the caller has no way to open anything', () => {
    const { container } = render(<MarkdownView source={`see [${PATH}](${PATH})`} />)
    expect(container.querySelector('.md-file-link')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain(PATH)
  })

  /*
   * The rule this must never blur: a path goes to the editor, a URL goes to the
   * browser, and a scheme that is neither goes nowhere at all.
   */
  it('leaves a real url as an anchor', () => {
    const { container } = render(
      <MarkdownView source="[docs](https://example.com/x)" onOpenFile={() => undefined} />
    )
    expect(container.querySelector('.md-file-link')).toBeNull()
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/x')
  })

  it('never turns a dangerous scheme into a control', () => {
    const { container } = render(
      <MarkdownView source="[click](javascript:alert(1))" onOpenFile={() => undefined} />
    )
    expect(container.querySelector('.md-file-link')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('[click](javascript:alert(1))')
  })
})
