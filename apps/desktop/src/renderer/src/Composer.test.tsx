/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from './Composer.js'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

class FakeObserver {
  observe(): void {
    return undefined
  }

  disconnect(): void {
    return undefined
  }
}

const sendMessage = vi.fn((_request: { conversationId: string; text: string }) =>
  Promise.resolve({ targets: [] })
)
const setAnswerStyle = vi.fn((_request: { conversationId: string; on?: boolean }) =>
  Promise.resolve({ styleOn: false })
)

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', FakeObserver)
  const dom = globalThis as typeof globalThis & { jsdom: { window: Window } }
  vi.stubGlobal('localStorage', dom.jsdom.window.localStorage)
})

describe('Discussion mode', () => {
  it('can send Work while only Chat is busy without treating it as a Work steer', async () => {
    const { container } = render(
      <Composer
        {...props(false)}
        busy
        workBusy={false}
        working={['codex']}
        initial={{ attached: [] }}
      />
    )
    fireEvent.change(parts(container).box, { target: { value: 'Implement the change.' } })
    expect(parts(container).send.getAttribute('data-steering')).toBeNull()
    expect(parts(container).send.title).toBe('conversation.send')
    act(() => {
      fireEvent.keyDown(parts(container).box, { key: 'Enter' })
    })
    await act(() => Promise.resolve())
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'work' }))
  })

  it('changes only future prompts and keeps its selection after sending', async () => {
    const { container, getByRole } = render(<Composer {...props(false)} />)
    const work = getByRole('button', { name: 'live.work' })
    const discussion = getByRole('button', { name: 'live.chat' })
    const box = parts(container).box
    expect(work.closest('[role="group"]')).toBe(getByRole('group', { name: 'live.mode' }))
    expect(discussion.closest('[role="group"]')).toBe(work.closest('[role="group"]'))
    expect(work.getAttribute('aria-pressed')).toBe('true')
    expect(discussion.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(work)
    expect(work.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(discussion)
    expect(sendMessage).not.toHaveBeenCalled()
    expect(work.getAttribute('aria-pressed')).toBe('false')
    expect(discussion.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(discussion)
    expect(discussion.getAttribute('aria-pressed')).toBe('true')
    fireEvent.change(box, { target: { value: 'Write a plan file.' } })
    act(() => {
      fireEvent.keyDown(box, { key: 'Enter' })
    })
    await act(() => Promise.resolve())
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'discussion' }))
    expect(discussion.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(work)
    expect(work.getAttribute('aria-pressed')).toBe('true')
    expect(discussion.getAttribute('aria-pressed')).toBe('false')
    fireEvent.change(box, { target: { value: 'Implement the plan.' } })
    act(() => {
      fireEvent.keyDown(box, { key: 'Enter' })
    })
    await act(() => Promise.resolve())
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'work' }))
  })

  it('keeps the submitted mode when the selection changes before delivery', async () => {
    const { container, getByRole } = render(<Composer {...props(false)} />)
    const discussion = getByRole('button', { name: 'live.chat' })
    const work = getByRole('button', { name: 'live.work' })
    fireEvent.click(discussion)
    fireEvent.change(parts(container).box, { target: { value: 'Discuss this.' } })
    fireEvent.keyDown(parts(container).box, { key: 'Enter' })
    fireEvent.click(work)
    await act(async () => {
      await Promise.resolve()
    })
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'discussion' }))
    expect(discussion.getAttribute('aria-pressed')).toBe('false')
    expect(work.getAttribute('aria-pressed')).toBe('true')
  })

  it('restores Discussion selection from the conversation carry', () => {
    const input = props(false)
    const { getByRole } = render(<Composer {...input} initial={{ mode: 'discussion' }} />)
    expect(getByRole('button', { name: 'live.chat' }).getAttribute('aria-pressed')).toBe('true')
    expect(getByRole('button', { name: 'live.work' }).getAttribute('aria-pressed')).toBe('false')
    expect(input.report.current.mode).toBe('discussion')
  })

  it('remembers Discussion selection when reopened without an in-memory carry', () => {
    const first = render(<Composer {...props(false)} />)
    fireEvent.click(first.getByRole('button', { name: 'live.chat' }))
    first.unmount()
    const reopened = render(<Composer {...props(false)} />)
    expect(reopened.getByRole('button', { name: 'live.chat' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
  })
})

afterAll(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  window.localStorage.clear()
  sendMessage.mockClear()
  setAnswerStyle.mockClear()
  Object.assign(window, {
    chorus: {
      sendMessage,
      setAnswerStyle,
      listCommands: () => Promise.resolve({ commands: [] }),
      rememberDraft: () => Promise.resolve({ ok: true }),
      ideSnapshot: () => Promise.resolve({ outcome: 'unavailable' }),
      interrupt: () => Promise.resolve({ ok: true }),
    },
  })
})

afterEach(() => {
  cleanup()
})

type Props = ComponentProps<typeof Composer>

const props = (starting: boolean): Props => ({
  conversationId: 'c1',
  participants: ['claude', 'codex'],
  starting,
  busy: false,
  working: [],
  backgroundAgents: '',
  ide: null,
  onRestart: () => undefined,
  history: [],
  report: { current: { draft: '', attached: [] } },
  onError: () => undefined,
  onSending: () => undefined,
  onSendFailed: () => undefined,
  initial: {
    attached: [{ path: '/tmp/shot.png', name: 'shot.png', bytes: 3, dataUrl: null }],
  },
})

const parts = (container: HTMLElement) => {
  const box = container.querySelector('textarea')
  const send = container.querySelector<HTMLButtonElement>('button.send')
  const style = container.querySelector<HTMLButtonElement>('button.composer-style')
  if (box === null || send === null || style === null) throw new Error('composer did not render')
  return { box, send, style }
}

describe('a composer whose agents are still starting', () => {
  it('takes a draft and attachments but sends nothing, by Enter or by button', async () => {
    const { container, queryByText } = render(<Composer {...props(true)} />)
    const { box, send, style } = parts(container)

    fireEvent.change(box, { target: { value: 'first question' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    fireEvent.submit(box.closest('form') ?? box)
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
    })

    expect(sendMessage).not.toHaveBeenCalled()
    expect(box.value).toBe('first question')
    expect(send.disabled).toBe(true)
    expect(send.getAttribute('aria-busy')).toBe('true')
    expect(box.disabled).toBe(false)
    expect(style.disabled).toBe(true)
    expect(queryByText('conversation.agentsStarting')).toBeNull()
    expect(container.textContent).toContain('shot.png')
  })

  it('keeps the draft, attachments and caret on the same mount once ready, then sends', async () => {
    const view = render(<Composer {...props(true)} />)
    const { box } = parts(view.container)
    fireEvent.change(box, { target: { value: 'first question' } })
    box.focus()
    box.setSelectionRange(6, 14)

    view.rerender(<Composer {...props(false)} />)
    const after = parts(view.container)

    expect(after.box).toBe(box)
    expect(after.box.value).toBe('first question')
    expect(document.activeElement).toBe(box)
    expect(after.box.selectionStart).toBe(6)
    expect(after.box.selectionEnd).toBe(14)
    expect(after.send.disabled).toBe(false)
    expect(after.send.getAttribute('aria-busy')).toBe('false')
    expect(view.queryByText('conversation.readyToSend')).toBeNull()
    expect(view.queryByText('conversation.agentsStarting')).toBeNull()
    expect(view.container.textContent).toContain('shot.png')

    fireEvent.keyDown(after.box, { key: 'Enter' })
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
    })
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0]?.[0].text).toContain('first question')
    expect(sendMessage.mock.calls[0]?.[0].text).toContain('/tmp/shot.png')
  })
})

describe('a composer waiting for a restart', () => {
  it('locks the old input and send action until the original chat is usable again', async () => {
    const onRestart = vi.fn()
    const input = { ...props(false), onRestart }
    const view = render(<Composer {...input} restarting />)
    const { box, send } = parts(view.container)
    const restart = view.container.querySelector<HTMLButtonElement>(
      '.composer-more[aria-busy="true"]'
    )
    if (restart === null) throw new Error('Missing restarting control')
    expect(box.disabled).toBe(true)
    expect(send.disabled).toBe(true)
    expect(send.getAttribute('aria-busy')).toBe('true')
    expect(restart).toHaveProperty('disabled', true)
    expect(view.queryByText('conversation.restartingHint')).toBeNull()
    act(() => {
      fireEvent.submit(box.closest('form') ?? box)
      fireEvent.click(restart)
    })
    await act(() => Promise.resolve())
    expect(sendMessage).not.toHaveBeenCalled()
    expect(onRestart).not.toHaveBeenCalled()

    view.rerender(<Composer {...input} restarting={false} />)
    expect(parts(view.container).box.disabled).toBe(false)
    expect(parts(view.container).send.disabled).toBe(false)
    expect(view.queryByText('conversation.readyToSend')).toBeNull()
    expect(view.queryByText('conversation.restartingHint')).toBeNull()
  })
})
