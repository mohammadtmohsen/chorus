/** @vitest-environment jsdom */
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuickRail } from './QuickRail.js'

/**
 * The rail has a door to the history sheet.
 *
 * **This is the guard for a feature that silently disappeared.** `HistoryPanel`
 * was never deleted — it rendered, `.history-row` existed, every row carried
 * `data-history-conversation` — but the control-rail redesign (`debaae0`)
 * dropped `onOpenHistory` when it replaced the drawer with this component, and
 * `setShowingHistory(true)` was then called from nowhere. The log keeps every
 * conversation forever and the UI had no way to reach any of them. Nothing
 * failed: not typecheck, not lint, not the suite.
 *
 * A rendered test rather than a pure one because the defect *is* the rendered
 * button — there is no pure part to extract. The e2e spec that would have caught
 * it reaches the sheet through the drawer this component replaced, so it cannot
 * catch anything either; that is exactly why the guard belongs in the fast suite
 * instead.
 */

/*
 * The rail's usage meters subscribe to the preload bridge on mount, so the
 * component cannot render without one. Every method is a no-op returning an
 * unsubscribe — the meters are not what is under test, they are just in the way.
 */
beforeEach(() => {
  const unsubscribe = (): void => undefined
  ;(window as unknown as { chorus: Record<string, unknown> }).chorus = new Proxy(
    {},
    {
      get: () => () => unsubscribe,
    }
  )
})

afterEach(() => {
  cleanup()
})

function railWith(onOpenHistory: () => void): HTMLElement {
  return render(
    <QuickRail
      sessions={[]}
      starting={false}
      preview={{ open: null, show: () => undefined, hide: () => undefined } as never}
      onNewSession={() => undefined}
      onOpenSettings={() => undefined}
      onOpenHistory={onOpenHistory}
      terminalOpen={false}
      onToggleTerminal={() => undefined}
      onReorderSessions={() => undefined}
      draggingId={null}
      onSessionPointerDown={() => undefined}
      consumeSuppressedClick={() => false}
    />
  ).container
}

describe('the rail’s history button', () => {
  it('exists', () => {
    const button = railWith(() => undefined).querySelector('[data-rail-history]')
    expect(button).not.toBeNull()
  })

  it('is reachable by name, not only by test hook', () => {
    // The label is what a screen reader and a person both use. A button present
    // in the DOM but unlabelled is not a door.
    const button = railWith(() => undefined).querySelector<HTMLElement>('[data-rail-history]')
    expect(button?.getAttribute('aria-label')).toBeTruthy()
    expect(button?.getAttribute('title')).toBeTruthy()
  })

  it('actually opens the sheet when pressed', () => {
    // The failure was a dropped *callback*, not a missing button, so pressing it
    // is the assertion that matters.
    const opened = vi.fn()
    railWith(opened).querySelector<HTMLElement>('[data-rail-history]')?.click()
    expect(opened).toHaveBeenCalledTimes(1)
  })
})
