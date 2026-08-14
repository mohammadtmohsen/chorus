/** @vitest-environment jsdom */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { StateMark } from './SessionRow.js'

/**
 * Whose turn the working mark is drawing.
 *
 * The colour is decided in the stylesheet from `data-voice`, so the contract
 * between the projection and the sheet is this attribute — and it was missing
 * entirely: `projectRow` worked out the voice, the mark ignored it, and
 * `.state-mark[data-state='working']` named `--voice-codex` outright. A
 * Claude-only session breathed in Codex's colour, and a session with both agents
 * working named one of them.
 *
 * A rendered test rather than a pure one because the defect *is* the rendered
 * attribute; there is nothing to extract that would have caught it. jsdom is
 * asked for at the top of the file, since `node` is this project's default.
 */

afterEach(() => {
  cleanup()
})

const mark = (element: HTMLElement): HTMLElement => {
  const found = element.querySelector<HTMLElement>('.state-mark')
  expect(found).not.toBeNull()
  return found!
}

describe('StateMark', () => {
  it('names the agent that is working', () => {
    const claude = mark(render(<StateMark state="working" voice="claude" />).container)
    expect(claude.dataset['state']).toBe('working')
    expect(claude.dataset['voice']).toBe('claude')

    cleanup()
    const codex = mark(render(<StateMark state="working" voice="codex" />).container)
    expect(codex.dataset['voice']).toBe('codex')
  })

  /*
   * Several agents working has no single voice, and the mark must not pick one.
   * Absent rather than empty: the stylesheet matches on the attribute existing.
   */
  it('names nobody when more than one agent is working', () => {
    const both = mark(render(<StateMark state="working" voice={null} />).container)
    expect(both.dataset['state']).toBe('working')
    expect(both.dataset['voice']).toBeUndefined()
    expect(both.hasAttribute('data-voice')).toBe(false)
  })

  /*
   * A voice on a state that is not "working" would colour a blocked triangle, an
   * asked square or a failed diamond by whoever happened to run last.
   */
  it('carries no voice on the other four states', () => {
    for (const state of ['idle', 'approval', 'question', 'failed'] as const) {
      cleanup()
      const drawn = mark(render(<StateMark state={state} voice="codex" />).container)
      expect(drawn.dataset['state']).toBe(state)
      expect(drawn.hasAttribute('data-voice')).toBe(false)
    }
  })

  /* The words are in the control's accessible name; the shape is decoration. */
  it('stays out of the accessible name', () => {
    const drawn = mark(render(<StateMark state="approval" />).container)
    expect(drawn.getAttribute('aria-hidden')).toBe('true')
  })
})
