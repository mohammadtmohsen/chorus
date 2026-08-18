/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalCard } from './Session.js'
import type { PendingApproval } from './transcript.js'

/**
 * Which button an approval arms, and which keys it refuses.
 *
 * Mounted rather than reduced, because the behaviour *is* the lifecycle: focus
 * is taken in an effect when the card appears, and the guard exists precisely
 * because that focus was not asked for. There is no pure part to extract.
 *
 * `@vitest-environment jsdom` at the top, because `node` is this project's
 * default and a DOM is an exception that has to be asked for.
 *
 * i18n is stubbed to the key, so what is asserted is *which* string a button
 * carries rather than the wording of it — the wording lives in `en.json` and is
 * allowed to change without breaking this.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const approval = (kind: string): PendingApproval => ({
  approvalId: `a-${kind}`,
  agentId: 'claude',
  kind,
  summary: 'WebFetch',
  detail: 'https://letsencrypt.org/docs/rate-limits/',
  expiresAt: 0,
})

function draw(kind: string): { buttons: HTMLButtonElement[]; hint: string } {
  const { container } = render(
    <ApprovalCard
      approval={approval(kind)}
      waiting={0}
      active
      onAllow={() => undefined}
      onAllowAlways={() => undefined}
      onDeny={() => undefined}
    />
  )
  return {
    buttons: [...container.querySelectorAll<HTMLButtonElement>('.approval-actions button')],
    hint: container.querySelector('.approval-hint')?.textContent ?? '',
  }
}

afterEach(() => {
  cleanup()
})

describe('an approval card', () => {
  /*
   * The session grant is the default, which reverses the original choice.
   *
   * It used to arm Allow once on the argument that the wider grant should cost
   * a deliberate press. A session grant dies with the window, and answering the
   * same ask four times is the failure the card exists to prevent.
   */
  it('arms the session grant, and says so', () => {
    const { buttons, hint } = draw('command')
    const armed = buttons.find((b) => b === document.activeElement)
    expect(armed?.textContent).toBe('approval.allowAlways')
    expect(armed?.className).toContain('btn--go')
    expect(hint).toBe('approval.enterHintSession')
  })

  /*
   * The exception, and the reason it is not a detail: for `mcpToolCall` the
   * wider button is `always`, not `session` — an MCP call may never be
   * auto-decided, so a session grant for one is silently refused and the button
   * has to widen further. A permanent policy change may not be what an
   * already-armed keystroke does.
   */
  it('leaves an MCP tool call on the narrow grant', () => {
    const { buttons, hint } = draw('mcpToolCall')
    const armed = buttons.find((b) => b === document.activeElement)
    expect(armed?.textContent).toBe('approval.allowOnce')
    expect(armed?.className).toContain('btn--go')
    expect(hint).toBe('approval.enterHint')
    // The wider button is still offered — it is only not the default.
    expect(buttons.map((b) => b.textContent)).toContain('approval.allowRemembered')
  })

  /*
   * The guards travel with the focus rather than staying on Allow once.
   *
   * Space, because a card can land mid-sentence and the next space of ordinary
   * prose would answer it. Held Enter, because auto-repeat would walk the whole
   * queue on one press.
   */
  it('refuses Space and a held Enter on whichever button is armed', () => {
    for (const kind of ['command', 'mcpToolCall']) {
      const { buttons } = draw(kind)
      const armed = buttons.find((b) => b === document.activeElement)
      expect(armed).toBeDefined()
      expect(fireEvent.keyDown(armed!, { key: ' ' })).toBe(false)
      expect(fireEvent.keyDown(armed!, { key: 'Enter', repeat: true })).toBe(false)
      // A deliberate press is untouched.
      expect(fireEvent.keyDown(armed!, { key: 'Enter' })).toBe(true)
      cleanup()
    }
  })

  /* A background pane's card must not steal the caret from the pane in front. */
  it('takes no focus when its pane is not active', () => {
    const { container } = render(
      <ApprovalCard
        approval={approval('command')}
        waiting={0}
        active={false}
        onAllow={() => undefined}
        onAllowAlways={() => undefined}
        onDeny={() => undefined}
      />
    )
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.approval-actions button')]
    expect(buttons.some((b) => b === document.activeElement)).toBe(false)
  })

  it('calls the session grant when the armed button is pressed', () => {
    const calls: string[] = []
    const { container } = render(
      <ApprovalCard
        approval={approval('command')}
        waiting={0}
        active
        onAllow={() => calls.push('once')}
        onAllowAlways={() => calls.push('session')}
        onDeny={() => calls.push('deny')}
      />
    )
    const armed = [
      ...container.querySelectorAll<HTMLButtonElement>('.approval-actions button'),
    ].find((b) => b === document.activeElement)
    act(() => {
      armed?.click()
    })
    expect(calls).toEqual(['session'])
  })
})
