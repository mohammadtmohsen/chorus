/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrafficRowShape } from '../../shared/ipc.js'
import type { DetectedScriptsShape, RunPush, RunResponse, RunState } from '../../shared/run-ipc.js'
import type {
  TrafficLive,
  TrafficPush,
  TrafficRequest,
  TrafficState,
} from '../../shared/traffic-ipc.js'
import { TrafficPanel, type TrafficRunHost } from './TrafficPanel.js'
import { useProjectRun, useTrafficLive } from './workspace/hooks.js'
import { useWorkspaceStore } from './workspace/store.js'

/**
 * A refused change must not be left sitting in the field as though it had been
 * taken.
 *
 * The reported defect: `Forward to` was corrected from `:3008` to `:30081`
 * while a capture was running. `configure` refuses an origin change mid-capture
 * on purpose — the socket is bound and the forward target is read once at
 * `Start` — but `commitOrigin` only synced its field when the change
 * *succeeded*, so the rejected text stayed in the box. The panel displayed one
 * address and the listener went on forwarding to another, and every row was a
 * 502 against a port with nothing on it.
 *
 * Mounted rather than reduced, because the defect is the async settle: a
 * `.then` that wrote the wrong thing into state. There is no pure part that
 * could have failed here — a test of "what should the field show" would have
 * asserted `state.origin`, which is what the fixed code already does.
 *
 * i18n is stubbed to the key, so this asserts *which* string a surface carries
 * rather than the wording of it; the wording lives in `en.json` and is allowed
 * to change without breaking this.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const STORED = 'http://127.0.0.1:3008'
const TYPED = 'http://127.0.0.1:30081'

const state = (over: Partial<TrafficState> = {}): TrafficState => ({
  capturing: true,
  port: 30_100,
  wantedPort: 30_100,
  address: '127.0.0.1:30100',
  origin: STORED,
  access: 'lan',
  envVar: null,
  source: { kind: 'off' },
  failure: null,
  forwardedDevices: 0,
  ...over,
})

type Chorus = typeof window.chorus

const bridge = (
  configure: Chorus['configureTraffic'],
  rows: Record<string, readonly TrafficRowShape[]> = {}
): Partial<Chorus> => ({
  onTraffic: () => () => undefined,
  onSettings: () => () => undefined,
  readSettings: () => Promise.reject(new Error('settings are not part of this test')),
  /* Per project, because the attach is what carries a project's rows. */
  attachTraffic: (request) =>
    Promise.resolve({
      subscriptionId: `sub-${request.projectId}`,
      captureId: `cap-${request.projectId}`,
      rows: [...(rows[request.projectId] ?? [])],
      seq: rows[request.projectId]?.at(-1)?.seq ?? 0,
      state: state(),
    }),
  ackTraffic: () => Promise.resolve({ ok: true as const }),
  detachTraffic: () => Promise.resolve({ ok: true as const }),
  setWorkbenchVisible: () => Promise.resolve({ ok: true as const, stills: [] }),
  /*
   * Needed as soon as a row is picked, because a selected row mounts the
   * inspector. `not-found` rather than a detail: what these tests assert is
   * which row is selected, and an empty inspector is the shortest way to have
   * one without describing an exchange.
   */
  readTrafficDetail: (request) =>
    Promise.resolve({
      kind: 'not-found' as const,
      key: {
        projectId: request.projectId,
        captureId: request.captureId,
        requestId: request.requestId,
      },
    }),
  readTrafficLegacy: () =>
    Promise.resolve({
      completed: true,
      assignedProjectId: null,
      origin: null,
      port: null,
      access: null,
      error: null,
    }),
  configureTraffic: configure,
})

const installed: Partial<Chorus> = {}

beforeEach(() => {
  Object.assign(window, { chorus: installed })
  useWorkspaceStore.setState({ trafficPanels: {} })
})

afterEach(() => {
  cleanup()
})

const draw = async (configure: Chorus['configureTraffic']): Promise<HTMLInputElement> => {
  Object.assign(installed, bridge(configure))
  const { container } = render(<TrafficPanel projectId="p1" terminals={[]} />)
  /* The attach promise seeds every draft, so nothing is typed before it lands. */
  await act(() => Promise.resolve())
  const field = container.querySelector<HTMLInputElement>('[data-traffic-field="origin"] input')
  if (field === null) throw new Error('the origin field is not drawn')
  return field
}

const hintFor = (field: HTMLElement): HTMLElement => {
  const hint = field.parentElement?.querySelector<HTMLElement>('.traffic-field-hint')
  if (hint === undefined || hint === null) throw new Error('the field has no hint')
  return hint
}

const commit = async (field: HTMLInputElement, text: string): Promise<void> => {
  fireEvent.change(field, { target: { value: text } })
  fireEvent.keyDown(field, { key: 'Enter' })
  await act(() => Promise.resolve())
}

describe('a refused change to Forward to', () => {
  it('puts the stored address back, and says why under the field', async () => {
    const field = await draw(() =>
      /* What `configure` really does when the guard refuses: nothing is stored. */
      Promise.resolve({ state: state(), failure: 'capturing' })
    )

    await commit(field, TYPED)

    /*
     * The assertion the defect fails. Leaving `TYPED` here is the bug: the
     * person reads their own correction back and believes it was taken, while
     * the listener forwards somewhere else entirely.
     */
    expect(field.value).toBe(STORED)

    const hint = hintFor(field)
    expect(hint.dataset['refused']).toBe('true')
    expect(hint.textContent).toBe('traffic.capturingChange')
    /*
     * And not also at the foot of the panel — one fact, one place.
     *
     * Asserted on the refusal's own words rather than on the class: the empty
     * inspector draws a `.traffic-stopped` of its own, so counting the class
     * would now fail for a reason that has nothing to do with where a refusal
     * is reported.
     */
    const shown = [...document.querySelectorAll('.traffic-stopped')].map((node) => node.textContent)
    expect(shown).not.toContain('traffic.capturingChange')
  })

  it('takes the new address and goes back to the ordinary hint when it is accepted', async () => {
    const field = await draw(() =>
      Promise.resolve({ state: state({ origin: TYPED }), failure: null })
    )

    await commit(field, TYPED)

    expect(field.value).toBe(TYPED)
    const hint = hintFor(field)
    expect(hint.dataset['refused']).toBe('false')
    expect(hint.textContent).toBe('traffic.originHint')
  })

  /*
   * The other half of the same rule, and the one that was already right before
   * this change: a refusal must not leave the field showing the rejected value.
   * The port is the field the guard also refuses, so it is the one that proves
   * the two handlers now agree rather than one of them carrying the fix.
   */
  it('does the same for the port, refused and accepted', async () => {
    Object.assign(
      installed,
      bridge(() => Promise.resolve({ state: state(), failure: 'capturing' }))
    )
    const { container } = render(<TrafficPanel projectId="p1" terminals={[]} />)
    await act(() => Promise.resolve())
    const port = container.querySelector<HTMLInputElement>('[data-traffic-field="port"] input')
    if (port === null) throw new Error('the port field is not drawn')

    await commit(port, '39999')
    expect(port.value).toBe('30100')
    expect(hintFor(port).dataset['refused']).toBe('true')
  })
})

/** One settled request. Enough of the shape for a row to draw and be selected. */
const httpRow = (seq: number): TrafficRowShape => ({
  source: 'http',
  seq,
  requestId: `r${String(seq)}`,
  m: 'GET',
  u: `http://127.0.0.1:9000/n/${String(seq)}`,
  dpop: false,
  status: 200,
  aborted: false,
  parsed: true,
  code: 'OK',
  nextAction: null,
  transport: null,
})

describe('hiding a project path prefix', () => {
  it('updates the table, preserves the full URL and restores each project preference', async () => {
    const configure = vi.fn<Chorus['configureTraffic']>(() =>
      Promise.resolve({ state: state(), failure: null })
    )
    Object.assign(installed, bridge(configure, { p1: [httpRow(1)], p2: [httpRow(2)] }))
    const { container, getByLabelText, rerender } = render(
      <TrafficPanel projectId="p1" terminals={[]} />
    )
    await act(() => Promise.resolve())

    const field = getByLabelText('traffic.hiddenPathPrefix')
    expect(field.closest('.traffic-setup')).not.toBeNull()
    expect(field).toHaveProperty('value', '')
    fireEvent.change(field, { target: { value: '/n' } })
    const cell = container.querySelector('.traffic-url')
    expect(cell?.textContent).toBe('/1')
    if (cell === null) throw new Error('the endpoint cell is not drawn')
    expect(cell.getAttribute('title')).toBeNull()
    fireEvent.pointerEnter(cell)
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('/1')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
    expect(configure).not.toHaveBeenCalled()

    fireEvent.change(getByLabelText('traffic.search'), {
      target: { value: 'http://127.0.0.1:9000/n/1' },
    })
    expect(container.querySelector('.traffic-url')?.textContent).toBe('/1')
    fireEvent.change(getByLabelText('traffic.search'), { target: { value: '' } })

    rerender(<TrafficPanel projectId="p2" terminals={[]} />)
    await act(() => Promise.resolve())
    expect(getByLabelText('traffic.hiddenPathPrefix')).toHaveProperty('value', '')
    expect(container.querySelector('.traffic-url')?.textContent).toBe('/n/2')

    rerender(<TrafficPanel projectId="p1" terminals={[]} />)
    await act(() => Promise.resolve())
    const restored = getByLabelText('traffic.hiddenPathPrefix')
    expect(restored).toHaveProperty('value', '/n')
    expect(container.querySelector('.traffic-url')?.textContent).toBe('/1')
    fireEvent.change(restored, { target: { value: '' } })
    expect(container.querySelector('.traffic-url')?.textContent).toBe('/n/1')
  })
})

describe('picking a call', () => {
  const pickedSeq = (container: HTMLElement): string | null =>
    container.querySelector('.traffic-row-button[aria-pressed="true"]')?.getAttribute('data-seq') ??
    null

  const pick = async (container: HTMLElement, seq: number): Promise<void> => {
    const row = container.querySelector(`.traffic-row-button[data-seq="${String(seq)}"]`)
    if (row === null) throw new Error(`row ${String(seq)} is not listed`)
    fireEvent.click(row)
    await act(() => Promise.resolve())
  }

  const installWithPushes = (
    rows: Record<string, readonly TrafficRowShape[]>
  ): ((push: TrafficPush) => void) => {
    const listeners: ((push: TrafficPush) => void)[] = []
    Object.assign(
      installed,
      bridge(() => Promise.resolve({ state: state(), failure: null }), rows),
      {
        onTraffic: (listener: (push: TrafficPush) => void) => {
          listeners.push(listener)
          return () => undefined
        },
      }
    )
    return (push) => {
      act(() => {
        for (const listener of listeners) listener(push)
      })
    }
  }

  it('selects nothing until a call is picked, and a newer call leaves the pick alone', async () => {
    const emit = installWithPushes({ p1: [httpRow(1), httpRow(2)] })
    const { container } = render(<TrafficPanel projectId="p1" terminals={[]} />)
    await act(() => Promise.resolve())

    expect(pickedSeq(container)).toBeNull()
    expect(container.querySelector('.traffic-inspector--empty')).not.toBeNull()

    await pick(container, 1)
    expect(pickedSeq(container)).toBe('1')

    emit({
      kind: 'rows',
      projectId: 'p1',
      subscriptionId: 'sub-p1',
      captureId: 'cap-p1',
      seq: 3,
      rows: [httpRow(3)],
    })

    expect(container.querySelector('.traffic-row-button[data-seq="3"]')).not.toBeNull()
    expect(pickedSeq(container)).toBe('1')
  })

  it('forgets the pick when the capture is cleared, even if the next call reuses its sequence', async () => {
    const emit = installWithPushes({ p1: [httpRow(1)] })
    const { container } = render(<TrafficPanel projectId="p1" terminals={[]} />)
    await act(() => Promise.resolve())
    await pick(container, 1)
    expect(pickedSeq(container)).toBe('1')

    emit({
      kind: 'reset',
      projectId: 'p1',
      subscriptionId: 'sub-p1',
      captureId: 'cap-p1-cleared',
      seq: 0,
      reason: 'cleared',
    })
    emit({
      kind: 'rows',
      projectId: 'p1',
      subscriptionId: 'sub-p1',
      captureId: 'cap-p1-cleared',
      seq: 1,
      rows: [httpRow(1)],
    })

    expect(container.querySelector('.traffic-row-button[data-seq="1"]')).not.toBeNull()
    expect(pickedSeq(container)).toBeNull()
  })

  it('forgets the pick on switching project, even if that project has the same sequence', async () => {
    installWithPushes({ p1: [httpRow(7)], p2: [httpRow(7)] })
    const { container, rerender } = render(<TrafficPanel projectId="p1" terminals={[]} />)
    await act(() => Promise.resolve())
    await pick(container, 7)
    expect(pickedSeq(container)).toBe('7')

    rerender(<TrafficPanel projectId="p2" terminals={[]} />)
    await act(() => Promise.resolve())
    await act(() => Promise.resolve())

    expect(container.querySelector('.traffic-row-button[data-seq="7"]')).not.toBeNull()
    expect(pickedSeq(container)).toBeNull()
  })
})

describe('pushes meant for another panel', () => {
  it('neither draws nor acknowledges a push for another project or subscription', async () => {
    const listeners: ((push: TrafficPush) => void)[] = []
    const acked: { subscriptionId: string; seq: number }[] = []
    Object.assign(
      installed,
      bridge(() => Promise.resolve({ state: state(), failure: null })),
      {
        onTraffic: (listener: (push: TrafficPush) => void) => {
          listeners.push(listener)
          return () => undefined
        },
        ackTraffic: (request: { subscriptionId: string; seq: number }) => {
          acked.push({ subscriptionId: request.subscriptionId, seq: request.seq })
          return Promise.resolve({ ok: true as const })
        },
      }
    )
    const { container } = render(<TrafficPanel projectId="p1" terminals={[]} />)
    await act(() => Promise.resolve())
    acked.length = 0
    const emit = (push: TrafficPush): void => {
      for (const listener of listeners) listener(push)
    }
    const rows = (projectId: string, subscriptionId: string): TrafficPush => ({
      kind: 'rows',
      projectId,
      subscriptionId,
      captureId: `cap-${projectId}`,
      seq: 1,
      rows: [httpRow(1)],
    })

    act(() => {
      emit(rows('p2', 'sub-p2'))
      emit(rows('p1', 'sub-elsewhere'))
    })
    expect(acked).toEqual([])
    expect(container.querySelector('.traffic-row-button')).toBeNull()

    act(() => {
      emit(rows('p1', 'sub-p1'))
    })
    expect(acked).toEqual([{ subscriptionId: 'sub-p1', seq: 1 }])
    expect(container.querySelector('.traffic-row-button[data-seq="1"]')).not.toBeNull()
  })
})

describe('the header live state', () => {
  it('keeps a live push that lands before the initial read resolves', async () => {
    const listeners: ((live: TrafficLive) => void)[] = []
    const reads: ((live: TrafficLive) => void)[] = []
    Object.assign(installed, {
      onTrafficLive: (listener: (live: TrafficLive) => void) => {
        listeners.push(listener)
        return () => undefined
      },
      readTrafficLive: () =>
        new Promise<TrafficLive>((resolve) => {
          reads.push(resolve)
        }),
    })
    const { result } = renderHook(() => useTrafficLive('p1'))

    act(() => {
      listeners[0]?.({ projectIds: ['p1'] })
    })
    reads[0]?.({ projectIds: [] })
    await act(() => Promise.resolve())

    expect(result.current).toBe(true)
  })

  it('takes the initial read when no push has arrived', async () => {
    Object.assign(installed, {
      onTrafficLive: () => () => undefined,
      readTrafficLive: () => Promise.resolve({ projectIds: ['p1'] }),
    })
    const { result } = renderHook(() => useTrafficLive('p1'))

    await act(() => Promise.resolve())

    expect(result.current).toBe(true)
  })
})

const RUN_COMMANDS = {
  version: 1 as const,
  defaultId: 'script:dev',
  commands: [
    { id: 'script:dev', label: 'dev', command: 'npm run dev' },
    { id: 'script:dev:clean', label: 'dev:clean', command: 'npm run dev:clean' },
  ],
}

const DEV = { id: 'script:dev', label: 'dev', command: 'npm run dev' }

const IDLE_RUN: RunResponse<'run:start'> = { process: { kind: 'idle' }, cleanupPending: false }

const runState = (over: Partial<RunState> = {}): RunState => ({
  ...IDLE_RUN,
  commands: RUN_COMMANDS,
  available: true,
  ...over,
})

const DETECTED: DetectedScriptsShape = {
  manager: 'npm',
  managerSource: 'packageManager',
  conflictingLockfiles: [],
  scripts: [
    { name: 'dev', command: 'npm run dev' },
    { name: 'dev:clean', command: 'npm run dev:clean' },
    { name: 'lint', command: 'npm run lint' },
  ],
  expo: true,
  variables: ['EXPO_PUBLIC_API_BASE_URL'],
}

const READY = { capturing: false, envVar: 'EXPO_PUBLIC_API_BASE_URL' }

const canonical = (
  over: Partial<TrafficState>,
  config: TrafficRequest<'traffic:configure'>['config']
): TrafficState =>
  state({
    ...over,
    ...(config.origin === undefined ? {} : { origin: config.origin }),
    ...(config.envVar === undefined ? {} : { envVar: config.envVar }),
  })

const drawRun = async (
  run: RunState,
  over: Partial<TrafficState> = READY,
  detected: DetectedScriptsShape = DETECTED,
  replaced: Partial<Chorus> = {},
  runHost?: TrafficRunHost
) => {
  const calls = {
    startRun: vi.fn<Chorus['startRun']>(() => Promise.resolve(IDLE_RUN)),
    stopRun: vi.fn<Chorus['stopRun']>(() => Promise.resolve(IDLE_RUN)),
    restartRun: vi.fn<Chorus['restartRun']>(() => Promise.resolve(IDLE_RUN)),
    stopRunRecording: vi.fn<Chorus['stopRunRecording']>(() => Promise.resolve(IDLE_RUN)),
    configureRun: vi.fn<Chorus['configureRun']>((request) =>
      Promise.resolve({ ...IDLE_RUN, commands: request.commands, available: true })
    ),
    detectRunScripts: vi.fn<Chorus['detectRunScripts']>(() => Promise.resolve(detected)),
    configureTraffic: vi.fn<Chorus['configureTraffic']>((request) =>
      Promise.resolve({ state: canonical(over, request.config), failure: null })
    ),
    startTraffic: vi.fn<Chorus['startTraffic']>(() => Promise.resolve({ state: state(over) })),
    stopTraffic: vi.fn<Chorus['stopTraffic']>(() => Promise.resolve({ state: state(over) })),
  }
  Object.assign(
    installed,
    bridge(calls.configureTraffic),
    calls,
    {
      attachTraffic: () =>
        Promise.resolve({
          subscriptionId: 'sub-p1',
          captureId: 'cap-p1',
          rows: [],
          seq: 0,
          state: state(over),
        }),
    },
    replaced
  )
  const view = render(
    <TrafficPanel
      projectId="p1"
      terminals={[]}
      run={run}
      {...(runHost === undefined ? {} : { runHost })}
    />
  )
  await act(() => Promise.resolve())
  return { ...view, calls }
}

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
  })
}

const control = (container: HTMLElement, action: string): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>(`[data-run-action="${action}"]`)

const press = async (button: HTMLElement | null): Promise<void> => {
  if (button === null) throw new Error('the control is not drawn')
  fireEvent.click(button)
  await act(() => Promise.resolve())
}

const labelOf = (button: HTMLElement | null): string | null | undefined =>
  button?.querySelector('.run-primary-label')?.textContent

const picked = (container: HTMLElement, id: string): HTMLInputElement | null =>
  container.querySelector<HTMLInputElement>(`[data-run-choice="${id}"] input[type="radio"]`)

const chosenIds = (container: HTMLElement): string[] =>
  [...container.querySelectorAll<HTMLElement>('[data-run-choice]')]
    .filter((each) => each.querySelector<HTMLInputElement>('input[type="radio"]')?.checked)
    .map((each) => each.dataset['runChoice'] ?? '')

const choose = async (container: HTMLElement, id: string): Promise<void> => {
  await press(picked(container, id))
}

const savedOnly = (id: string, label: string, command: string) => ({
  version: 1 as const,
  defaultId: id,
  commands: [{ id, label, command }],
})

const lastSaved = (calls: { configureRun: { mock: { calls: unknown[][] } } }): unknown =>
  (calls.configureRun.mock.calls.at(-1)?.[0] as { commands?: unknown } | undefined)?.commands

describe('Run in Traffic', () => {
  it('keeps Start and Stop, and says why, where Run is not available', async () => {
    const { container } = await drawRun(runState({ available: false, commands: null }))
    expect(container.querySelector('.run-controls')).toBeNull()
    expect(container.querySelector('.run-unavailable')?.textContent).toBe('run.unavailable')
    expect(container.querySelector('.traffic-head .traffic-action[aria-pressed]')).not.toBeNull()
  })

  it('runs the saved default with no setup once a project is configured', async () => {
    const { container, calls } = await drawRun(runState())
    expect(labelOf(control(container, 'run'))).toBe('run.run')
    await press(control(container, 'run'))
    expect(calls.startRun).toHaveBeenCalledWith({ projectId: 'p1' })
    expect(calls.detectRunScripts).not.toHaveBeenCalled()
    expect(container.querySelector('.run-setup')).toBeNull()
  })

  const missingCaptureSettings: readonly Partial<TrafficState>[] = [
    { origin: null, envVar: null },
    { origin: null },
    { envVar: null },
  ]

  it.each(missingCaptureSettings)(
    'runs the saved command with optional capture settings %j',
    async (settings) => {
      const { container, calls } = await drawRun(runState(), {
        ...READY,
        ...settings,
      })

      expect(labelOf(control(container, 'run'))).toBe('run.run')
      expect(control(container, 'run')?.disabled).toBe(false)
      await press(control(container, 'run'))
      expect(calls.startRun).toHaveBeenCalledWith({ projectId: 'p1' })
      expect(calls.configureTraffic).not.toHaveBeenCalled()
      expect(container.querySelector('.run-setup')).toBeNull()
    }
  )

  it('enables Run after choosing Chorus dev without HTTP capture settings', async () => {
    const { container, calls } = await drawRun(
      runState({ commands: null }),
      { capturing: false, origin: null, envVar: null },
      {
        ...NO_VARIABLES,
        manager: 'pnpm',
        scripts: [{ name: 'dev', command: 'pnpm run dev' }],
        expo: false,
      }
    )

    await press(control(container, 'run'))
    await settle()

    expect(lastSaved(calls)).toEqual(savedOnly('script:dev', 'dev', 'pnpm run dev'))
    expect(labelOf(control(container, 'run'))).toBe('run.run')
    expect(control(container, 'run')?.disabled).toBe(false)
    expect(calls.configureTraffic).not.toHaveBeenCalled()
    expect(calls.startRun).not.toHaveBeenCalled()

    await press(control(container, 'run'))
    expect(calls.startRun).toHaveBeenCalledWith({ projectId: 'p1' })
  })

  it('keeps Run, its status and Edit command inside Capture setup, with no menu or Capture only', async () => {
    const { container } = await drawRun(runState())
    const head = container.querySelector('.traffic-head')
    const setup = container.querySelector('.traffic-setup .traffic-source-row')
    expect(head?.querySelector('[data-run-action="run"]')).toBeNull()
    expect(head?.querySelector('[data-run-action="edit"]')).toBeNull()
    expect(setup?.querySelector('[data-run-action="run"]')).not.toBeNull()
    expect(setup?.querySelector('[data-run-action="edit"]')).not.toBeNull()
    expect(setup?.querySelector('.run-status')).not.toBeNull()
    expect(head?.querySelector('details')).toBeNull()
    expect(container.querySelector('[data-run-action="capture-only"]')).toBeNull()
    expect(container.querySelector('[data-run-command]')).toBeNull()
    expect(container.querySelector('[data-run-action="restart"]')).toBeNull()
  })

  it('opens and closes the command panel with Edit command, keeping what was applied', async () => {
    const { container, calls } = await drawRun(runState())
    const edit = control(container, 'edit')
    expect(edit?.getAttribute('aria-expanded')).toBe('false')

    await press(edit)
    await settle()
    const panel = container.querySelector('.run-setup')
    expect(edit?.getAttribute('aria-expanded')).toBe('true')
    expect(panel?.id).not.toBe('')
    expect(edit?.getAttribute('aria-controls')).toBe(panel?.id)
    expect(control(container, 'save')).toBeNull()
    expect(control(container, 'close')).toBeNull()

    await choose(container, 'script:dev:clean')
    await settle()
    await press(edit)

    expect(edit?.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.run-setup')).toBeNull()
    expect(calls.configureRun).toHaveBeenCalledTimes(1)
    expect(lastSaved(calls)).toEqual(
      savedOnly('script:dev:clean', 'dev:clean', 'npm run dev:clean')
    )
  })

  it('applies the detected default and the single variable at once, without running', async () => {
    const { container, calls } = await drawRun(runState({ commands: null }), {
      capturing: false,
      envVar: null,
    })
    expect(labelOf(control(container, 'run'))).toBe('run.setUp')

    await press(control(container, 'run'))
    await settle()

    expect(calls.startRun).not.toHaveBeenCalled()
    expect(chosenIds(container)).toEqual(['script:dev'])
    expect(calls.configureRun).toHaveBeenCalledTimes(1)
    expect(calls.configureRun).toHaveBeenCalledWith({
      projectId: 'p1',
      commands: { version: 1, defaultId: 'script:dev', commands: [DEV] },
    })
    expect(calls.configureTraffic).toHaveBeenCalledWith({
      projectId: 'p1',
      config: { envVar: 'EXPO_PUBLIC_API_BASE_URL' },
    })
    expect(container.querySelector('[data-run-field="origin"]')).toBeNull()
    expect(container.querySelector('.run-setup')).not.toBeNull()
  })

  it('applies an added custom command at once as the only one saved', async () => {
    const { container, calls } = await drawRun(runState({ commands: null }))
    await press(control(container, 'run'))
    await settle()

    const name = container.querySelector<HTMLInputElement>('[data-run-field="custom-label"] input')
    const command = container.querySelector<HTMLInputElement>(
      '[data-run-field="custom-command"] input'
    )
    if (name === null || command === null) throw new Error('the custom fields are not drawn')
    fireEvent.change(name, { target: { value: 'Expo' } })
    fireEvent.change(command, { target: { value: 'npx expo start --clear' } })
    await press(control(container, 'add'))
    await settle()

    expect(chosenIds(container)).toEqual(['custom:1'])
    expect(container.querySelector('[data-run-choice="script:dev"]')).not.toBeNull()
    expect(lastSaved(calls)).toEqual(savedOnly('custom:1', 'Expo', 'npx expo start --clear'))
    expect(container.querySelector('.run-setup')).not.toBeNull()
  })

  it('keeps one command chosen in one group, and saves each choice alone', async () => {
    const { container, calls } = await drawRun(runState())
    await press(control(container, 'edit'))
    await settle()

    const names = new Set(
      [...container.querySelectorAll<HTMLInputElement>('.run-choices input')].map(
        (each) => each.name
      )
    )
    expect(names.size).toBe(1)
    expect([...names][0]).not.toBe('')
    expect(container.querySelectorAll('.run-choices input[type="checkbox"]')).toHaveLength(0)
    expect(calls.configureRun).not.toHaveBeenCalled()

    await choose(container, 'script:dev:clean')
    await settle()
    await choose(container, 'script:lint')
    await settle()

    expect(chosenIds(container)).toEqual(['script:lint'])
    expect(calls.configureRun.mock.calls.map(([request]) => request.commands)).toEqual([
      savedOnly('script:dev:clean', 'dev:clean', 'npm run dev:clean'),
      savedOnly('script:lint', 'lint', 'npm run lint'),
    ])
  })

  it('applies a suggested variable when it is chosen among several', async () => {
    const { container, calls } = await drawRun(
      runState({ commands: null }),
      { capturing: false, envVar: null },
      { ...DETECTED, variables: ['EXPO_PUBLIC_API_BASE_URL', 'EXPO_PUBLIC_MAPS_KEY'] }
    )
    await press(control(container, 'run'))
    await settle()

    const variable = container.querySelector<HTMLInputElement>('[data-run-field="variable"] input')
    expect(variable?.value).toBe('')
    expect(calls.configureTraffic).not.toHaveBeenCalled()
    await press(container.querySelector<HTMLElement>('[data-run-variable="EXPO_PUBLIC_MAPS_KEY"]'))
    await settle()
    expect(calls.configureTraffic).toHaveBeenCalledWith({
      projectId: 'p1',
      config: { envVar: 'EXPO_PUBLIC_MAPS_KEY' },
    })
  })

  it('turns Run into one Stop while starting and running, with no Restart', async () => {
    const starting = await drawRun(
      runState({ process: { kind: 'starting', token: 1, active: DEV } }),
      { capturing: true, envVar: 'EXPO_PUBLIC_API_BASE_URL' }
    )
    expect(labelOf(control(starting.container, 'stop'))).toBe('run.stop')
    expect(control(starting.container, 'run')).toBeNull()
    expect(control(starting.container, 'cancel')).toBeNull()
    expect(control(starting.container, 'restart')).toBeNull()
    expect(control(starting.container, 'stop-recording')).toBeNull()
    await press(control(starting.container, 'stop'))
    expect(starting.calls.stopRun).toHaveBeenCalledWith({ projectId: 'p1' })

    starting.rerender(
      <TrafficPanel
        projectId="p1"
        terminals={[]}
        run={runState({ process: { kind: 'running', token: 1, active: DEV, pgid: 4 } })}
      />
    )
    const { container } = starting
    expect(container.querySelectorAll('[data-run-action="stop"]')).toHaveLength(1)
    expect(control(container, 'stop')?.disabled).toBe(false)
    expect(control(container, 'restart')).toBeNull()
    expect(control(container, 'run')).toBeNull()
    expect(control(container, 'stop-recording')).toBeNull()
    await press(control(container, 'stop'))
    expect(starting.calls.stopRun).toHaveBeenCalledTimes(2)
    expect(starting.calls.restartRun).not.toHaveBeenCalled()
    expect(starting.calls.stopTraffic).not.toHaveBeenCalled()
  })

  it('keeps Stop disabled while stopping, and says so', async () => {
    const { container, calls } = await drawRun(
      runState({ process: { kind: 'stopping', token: 1, active: DEV } })
    )
    expect(control(container, 'stop')?.disabled).toBe(true)
    expect(control(container, 'stop')?.title).toBe('run.stopping')
    expect(control(container, 'run')).toBeNull()
    await press(control(container, 'stop'))
    expect(calls.stopRun).not.toHaveBeenCalled()
  })

  it('makes the same Stop finish cleanup, with the reason shown and no second button', async () => {
    const { container, calls } = await drawRun(
      runState({
        process: { kind: 'exited', token: 1, active: DEV, code: 0 },
        cleanupPending: true,
      })
    )
    expect(control(container, 'run')).toBeNull()
    expect(container.querySelectorAll('[data-run-action="stop"]')).toHaveLength(1)
    expect(labelOf(control(container, 'stop'))).toBe('run.stop')
    expect(control(container, 'restart')).toBeNull()
    expect(
      [...container.querySelectorAll('.traffic-stopped')].map((each) => each.textContent)
    ).toContain('run.cleanupPending')
    await press(control(container, 'stop'))
    expect(calls.stopRun).toHaveBeenCalledWith({ projectId: 'p1' })
  })

  it('offers Retry Stop after a stop that did not finish', async () => {
    const { container } = await drawRun(
      runState({
        process: { kind: 'failed', reason: 'stop-incomplete', active: DEV },
        cleanupPending: true,
      })
    )
    expect(labelOf(control(container, 'stop'))).toBe('run.retryStop')
    expect(control(container, 'run')).toBeNull()
  })

  it('shows Stop recording beside Run only while recording and not busy', async () => {
    const recording = await drawRun(runState(), {
      capturing: true,
      envVar: 'EXPO_PUBLIC_API_BASE_URL',
    })
    await press(control(recording.container, 'stop-recording'))
    expect(recording.calls.stopRunRecording).toHaveBeenCalledWith({ projectId: 'p1' })
    recording.unmount()

    const quiet = await drawRun(runState())
    expect(control(quiet.container, 'stop-recording')).toBeNull()
  })

  it('follows a command saved in another window into an open panel', async () => {
    const view = await drawRun(runState())
    await press(control(view.container, 'edit'))
    await settle()
    expect(chosenIds(view.container)).toEqual(['script:dev'])

    const elsewhere = savedOnly('script:lint', 'lint', 'npm run lint')
    view.rerender(
      <TrafficPanel projectId="p1" terminals={[]} run={runState({ commands: elsewhere })} />
    )
    await act(() => Promise.resolve())

    expect(chosenIds(view.container)).toEqual(['script:lint'])
    expect(view.calls.configureRun).not.toHaveBeenCalled()
  })
})

const MISSING = { capturing: false, envVar: null }

const NO_VARIABLES: DetectedScriptsShape = { ...DETECTED, variables: [] }

const openSetupIn = async (container: HTMLElement): Promise<void> => {
  await press(control(container, 'run'))
  await settle()
}

const typeInto = (container: HTMLElement, field: string, value: string): void => {
  const input = container.querySelector<HTMLInputElement>(`[data-run-field="${field}"] input`)
  if (input === null) throw new Error(`the ${field} field is not drawn`)
  fireEvent.change(input, { target: { value } })
}

const enterIn = async (container: HTMLElement, field: string): Promise<void> => {
  const input = container.querySelector<HTMLInputElement>(`[data-run-field="${field}"] input`)
  if (input === null) throw new Error(`the ${field} field is not drawn`)
  fireEvent.keyDown(input, { key: 'Enter' })
  await settle()
}

const fieldValue = (container: HTMLElement, field: string): string | undefined =>
  container.querySelector<HTMLInputElement>(`[data-run-field="${field}"] input`)?.value

const setupError = (container: HTMLElement): string | null | undefined =>
  container.querySelector('.run-setup .traffic-stopped')?.textContent

describe('setup fields without Save', () => {
  it('accepts blank capture fields and rejects invalid variables before sending', async () => {
    const { container, calls } = await drawRun(
      runState({ commands: null }),
      { capturing: false, origin: null, envVar: null },
      NO_VARIABLES
    )
    await openSetupIn(container)

    await enterIn(container, 'origin')
    expect(setupError(container)).toBeUndefined()
    await enterIn(container, 'variable')
    expect(setupError(container)).toBeUndefined()
    typeInto(container, 'variable', 'API-URL')
    await enterIn(container, 'variable')
    expect(setupError(container)).toBe('run.badVariable')

    expect(calls.configureTraffic).not.toHaveBeenCalled()
    expect(container.querySelector('.run-setup')).not.toBeNull()
  })

  it('commits Forward to on Enter and on blur, each on its own', async () => {
    const { container, calls } = await drawRun(
      runState({ commands: null }),
      { capturing: false, origin: null, envVar: null },
      NO_VARIABLES
    )
    await openSetupIn(container)
    typeInto(container, 'origin', 'http://10.0.0.5:8080')
    await enterIn(container, 'origin')

    expect(calls.configureTraffic).toHaveBeenCalledWith({
      projectId: 'p1',
      config: { origin: 'http://10.0.0.5:8080' },
    })

    typeInto(container, 'variable', 'EXPO_PUBLIC_API_BASE_URL')
    const variable = container.querySelector<HTMLInputElement>('[data-run-field="variable"] input')
    if (variable === null) throw new Error('the variable field is not drawn')
    fireEvent.blur(variable)
    await settle()

    expect(calls.configureTraffic).toHaveBeenLastCalledWith({
      projectId: 'p1',
      config: { envVar: 'EXPO_PUBLIC_API_BASE_URL' },
    })
  })

  it('says why a variable was refused while recording, and keeps the draft', async () => {
    const configureTraffic = vi.fn<Chorus['configureTraffic']>(() =>
      Promise.resolve({ state: state(MISSING), failure: 'capturing' })
    )
    const { container } = await drawRun(runState({ commands: null }), MISSING, NO_VARIABLES, {
      configureTraffic,
    })
    await openSetupIn(container)
    typeInto(container, 'variable', 'EXPO_PUBLIC_API_BASE_URL')
    await enterIn(container, 'variable')

    expect(setupError(container)).toBe('run.whileRecording')
    expect(fieldValue(container, 'variable')).toBe('EXPO_PUBLIC_API_BASE_URL')
  })

  it('says so when storing a field fails outright, and keeps the draft', async () => {
    const configureTraffic = vi.fn<Chorus['configureTraffic']>(() =>
      Promise.reject(new Error('main went away'))
    )
    const { container } = await drawRun(runState({ commands: null }), MISSING, NO_VARIABLES, {
      configureTraffic,
    })
    await openSetupIn(container)
    typeInto(container, 'variable', 'EXPO_PUBLIC_API_BASE_URL')
    await enterIn(container, 'variable')

    expect(setupError(container)).toBe('run.configFailed')
    expect(fieldValue(container, 'variable')).toBe('EXPO_PUBLIC_API_BASE_URL')
  })
})

describe('commands Run keeps exactly', () => {
  it('refuses a 501-character command, and keeps a 500-character one exactly', async () => {
    const { container, calls } = await drawRun(runState({ commands: null }))
    await openSetupIn(container)

    const tooLong = 'x'.repeat(501)
    typeInto(container, 'custom-command', tooLong)
    await press(control(container, 'add'))
    expect(setupError(container)).toBe('run.commandTooLong')
    expect(container.querySelector('[data-run-choice="custom:1"]')).toBeNull()
    expect(fieldValue(container, 'custom-command')).toBe(tooLong)

    const longest = `npx expo start ${'y'.repeat(485)}`
    expect(longest).toHaveLength(500)
    typeInto(container, 'custom-command', longest)
    await press(control(container, 'add'))
    await settle()

    const saved = calls.configureRun.mock.calls.at(-1)?.[0].commands?.commands ?? []
    expect(saved.map((each) => each.command)).toEqual([longest])
  })

  it('gives two long script names sharing a prefix their own bounded ids', async () => {
    const shared = 'release:'.repeat(9)
    const { container, calls } = await drawRun(runState({ commands: null }), READY, {
      ...NO_VARIABLES,
      scripts: [
        { name: `${shared}ios`, command: 'npm run release-ios' },
        { name: `${shared}android`, command: 'npm run release-android' },
      ],
    })
    await openSetupIn(container)
    const ids = [...container.querySelectorAll<HTMLElement>('[data-run-choice]')].map(
      (each) => each.dataset['runChoice'] ?? ''
    )
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    expect(ids.every((id) => id.length <= 64)).toBe(true)

    const [first, second] = ids
    expect(chosenIds(container)).toEqual([first])
    if (second === undefined) throw new Error('the second script is not drawn')
    await choose(container, second)
    await settle()
    expect(chosenIds(container)).toEqual([second])

    const sent = calls.configureRun.mock.calls.at(-1)?.[0].commands
    expect(sent?.defaultId).toBe(second)
    expect(sent?.commands.map((each) => each.command)).toEqual(['npm run release-android'])
  })

  it('cannot keep a script longer than a command may be, and never shortens it', async () => {
    const long = `node scripts/start.js ${'z'.repeat(500)}`
    const { container } = await drawRun(runState({ commands: null }), READY, {
      ...NO_VARIABLES,
      scripts: [
        { name: 'dev', command: long },
        { name: 'start', command: 'npm start' },
      ],
    })
    await openSetupIn(container)

    expect(picked(container, 'script:dev')?.disabled).toBe(true)
    expect(picked(container, 'script:dev')?.checked).toBe(false)
    expect(picked(container, 'script:start')?.checked).toBe(true)
    expect(container.querySelector('[data-run-choice="script:dev"] code')?.textContent).toBe(long)
  })

  it('applies nothing when no script can be chosen', async () => {
    const { container, calls } = await drawRun(runState({ commands: null }), READY, {
      ...NO_VARIABLES,
      scripts: [{ name: 'dev', command: `node ${'z'.repeat(600)}` }],
    })
    await openSetupIn(container)
    expect(chosenIds(container)).toEqual([])
    expect(calls.configureRun).not.toHaveBeenCalled()
    expect(labelOf(control(container, 'run'))).toBe('run.setUp')
  })
})

describe('a scan that answers late', () => {
  const pendingScans = (): {
    readonly detectRunScripts: Chorus['detectRunScripts']
    readonly answers: ((found: DetectedScriptsShape) => void)[]
  } => {
    const answers: ((found: DetectedScriptsShape) => void)[] = []
    return {
      answers,
      detectRunScripts: () =>
        new Promise((resolve) => {
          answers.push(resolve)
        }),
    }
  }

  it('never fills another project’s setup', async () => {
    const scans = pendingScans()
    const view = await drawRun(runState({ commands: null }), MISSING, DETECTED, scans)
    await openSetupIn(view.container)

    view.rerender(<TrafficPanel projectId="p2" terminals={[]} run={runState({ commands: null })} />)
    await settle()
    await openSetupIn(view.container)
    scans.answers[0]?.(DETECTED)
    await settle()

    expect(view.container.querySelectorAll('[data-run-choice]')).toHaveLength(0)
    expect(fieldValue(view.container, 'variable')).toBe('')
    expect(view.calls.configureRun).not.toHaveBeenCalled()
    expect(view.calls.configureTraffic).not.toHaveBeenCalled()

    scans.answers[1]?.({ ...DETECTED, variables: ['EXPO_PUBLIC_P2_URL'] })
    await settle()
    expect(view.container.querySelectorAll('[data-run-choice]')).toHaveLength(3)
    expect(view.calls.configureRun).toHaveBeenCalledTimes(1)
    expect(view.calls.configureRun.mock.calls[0]?.[0].projectId).toBe('p2')
    expect(view.calls.configureTraffic).toHaveBeenCalledWith({
      projectId: 'p2',
      config: { envVar: 'EXPO_PUBLIC_P2_URL' },
    })
  })

  it('is ignored once the panel it was for has closed and opened again', async () => {
    const scans = pendingScans()
    const { container, calls } = await drawRun(
      runState({ commands: null }),
      MISSING,
      DETECTED,
      scans
    )
    await openSetupIn(container)
    await press(control(container, 'edit'))
    await press(control(container, 'edit'))

    scans.answers[0]?.({ ...DETECTED, variables: ['EXPO_PUBLIC_STALE'] })
    await settle()
    expect(container.querySelectorAll('[data-run-choice]')).toHaveLength(0)
    expect(fieldValue(container, 'variable')).toBe('')
    expect(calls.configureTraffic).not.toHaveBeenCalled()

    scans.answers[1]?.(DETECTED)
    await settle()
    expect(calls.configureTraffic).toHaveBeenCalledWith({
      projectId: 'p1',
      config: { envVar: 'EXPO_PUBLIC_API_BASE_URL' },
    })
  })

  it('keeps a variable the person typed while it was scanning', async () => {
    const scans = pendingScans()
    const { container, calls } = await drawRun(
      runState({ commands: null }),
      MISSING,
      DETECTED,
      scans
    )
    await openSetupIn(container)
    typeInto(container, 'variable', 'MY_OWN_URL')

    scans.answers[0]?.(DETECTED)
    await settle()
    expect(fieldValue(container, 'variable')).toBe('MY_OWN_URL')
    expect(calls.configureTraffic).not.toHaveBeenCalled()
  })

  it('keeps a custom command added while scanning, and suggests nothing over it', async () => {
    const scans = pendingScans()
    const { container, calls } = await drawRun(runState({ commands: null }), READY, DETECTED, scans)
    await openSetupIn(container)
    typeInto(container, 'custom-command', 'npx expo start --clear')
    await press(control(container, 'add'))
    await settle()

    scans.answers[0]?.(DETECTED)
    await settle()

    expect(chosenIds(container)).toEqual(['custom:1'])
    expect(container.querySelectorAll('[data-run-choice]')).toHaveLength(4)
    expect(calls.configureRun).toHaveBeenCalledTimes(1)
    expect(lastSaved(calls)).toEqual(
      savedOnly('custom:1', 'npx expo start --clear', 'npx expo start --clear')
    )
  })

  it('keeps a saved command chosen while it was scanning', async () => {
    const scans = pendingScans()
    const { container } = await drawRun(runState(), READY, DETECTED, scans)
    await press(control(container, 'edit'))
    await choose(container, 'script:dev:clean')

    scans.answers[0]?.(DETECTED)
    await settle()

    expect(chosenIds(container)).toEqual(['script:dev:clean'])
    expect(container.querySelector('[data-run-choice="script:lint"]')).not.toBeNull()
  })
})

describe('the run state a project row reads', () => {
  it('takes a push that arrives before the first read, and ignores the stale read', async () => {
    let listener: (push: RunPush) => void = () => undefined
    let answer: (state: RunState) => void = () => undefined
    Object.assign(installed, {
      onRun: (next: (push: RunPush) => void) => {
        listener = next
        return () => undefined
      },
      readRunState: () =>
        new Promise<RunState>((resolve) => {
          answer = resolve
        }),
    })
    const { result } = renderHook(() => useProjectRun('p1'))

    act(() => {
      listener({ projectId: 'p1', ...runState({ cleanupPending: true }) })
    })
    answer(runState())
    await act(() => Promise.resolve())

    expect(result.current?.cleanupPending).toBe(true)
  })

  it('ignores another project’s push, and forgets the last project when switched', () => {
    return new Promise<void>((resolve) => {
      let listener: (push: RunPush) => void = () => undefined
      const reads: string[] = []
      Object.assign(installed, {
        onRun: (next: (push: RunPush) => void) => {
          listener = next
          return () => undefined
        },
        readRunState: (request: { projectId: string }) => {
          reads.push(request.projectId)
          return new Promise<RunState>(() => undefined)
        },
      })
      const { result, rerender } = renderHook(({ id }) => useProjectRun(id), {
        initialProps: { id: 'p1' },
      })

      act(() => {
        listener({ projectId: 'p2', ...runState() })
      })
      expect(result.current).toBeNull()
      act(() => {
        listener({ projectId: 'p1', ...runState() })
      })
      expect(result.current?.available).toBe(true)

      rerender({ id: 'p2' })
      expect(result.current).toBeNull()
      expect(reads).toEqual(['p1', 'p2'])
      resolve()
    })
  })
})

describe('Run beside Notes', () => {
  const made: HTMLElement[] = []

  afterEach(() => {
    for (const element of made.splice(0)) element.remove()
  })

  const hostFor = (): { readonly host: TrafficRunHost; readonly element: HTMLDivElement } => {
    const element = document.createElement('div')
    document.body.append(element)
    made.push(element)
    return { host: { element, reveal: vi.fn<() => void>() }, element }
  }

  it('draws only Run/Stop beside Notes, and keeps the rest in Traffic', async () => {
    const { host, element } = hostFor()
    const { container, calls } = await drawRun(
      runState(),
      { capturing: true, envVar: 'EXPO_PUBLIC_API_BASE_URL' },
      DETECTED,
      {},
      host
    )

    expect(element.querySelector('[data-run-action="run"]')).not.toBeNull()
    expect(element.querySelector('.run-capture-icon')?.textContent).toBe('⇄')
    expect(element.querySelector('[data-run-action="edit"]')).toBeNull()
    expect(container.querySelector('[data-run-action="run"]')).toBeNull()
    expect(document.querySelectorAll('[data-run-action="run"]')).toHaveLength(1)
    const setup = container.querySelector('.traffic-setup .traffic-source-row')
    expect(setup?.querySelector('[data-run-action="edit"]')).not.toBeNull()
    expect(setup?.querySelector('[data-run-action="stop-recording"]')).not.toBeNull()
    expect(setup?.querySelector('.run-status')).not.toBeNull()

    await press(element.querySelector<HTMLElement>('[data-run-action="run"]'))
    expect(calls.startRun).toHaveBeenCalledWith({ projectId: 'p1' })
  })

  it('stops from beside Notes with stopRun alone', async () => {
    const { host, element } = hostFor()
    const { calls } = await drawRun(
      runState({ process: { kind: 'running', token: 1, active: DEV, pgid: 4 } }),
      READY,
      DETECTED,
      {},
      host
    )
    await press(element.querySelector<HTMLElement>('[data-run-action="stop"]'))
    expect(calls.stopRun).toHaveBeenCalledWith({ projectId: 'p1' })
    expect(calls.stopTraffic).not.toHaveBeenCalled()
  })

  it('opens missing setup in Traffic and asks for Traffic to be shown', async () => {
    const { host, element } = hostFor()
    const { container } = await drawRun(runState({ commands: null }), MISSING, DETECTED, {}, host)
    await press(element.querySelector<HTMLElement>('[data-run-action="run"]'))
    await settle()

    expect(container.querySelector('.run-setup')).not.toBeNull()
    expect(element.querySelector('.run-setup')).toBeNull()
    expect(host.reveal).toHaveBeenCalledTimes(1)
  })

  it('draws nothing until the host exists, then exactly one Run', async () => {
    const { host, element } = hostFor()
    const view = await drawRun(runState(), READY, DETECTED, {}, { ...host, element: null })
    expect(document.querySelectorAll('[data-run-action="run"]')).toHaveLength(0)

    view.rerender(<TrafficPanel projectId="p1" terminals={[]} run={runState()} runHost={host} />)
    await act(() => Promise.resolve())

    expect(element.querySelectorAll('[data-run-action="run"]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-run-action="run"]')).toHaveLength(1)
  })
})

describe('replies that arrive late', () => {
  const unmanaged = runState({ available: false, commands: null })

  const toggleIn = (container: HTMLElement): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>('.traffic-head [aria-pressed]')

  const stoppedTexts = (container: HTMLElement): (string | null)[] =>
    [...container.querySelectorAll('.traffic-stopped')].map((each) => each.textContent)

  it('says why capture failed where Run is unavailable', async () => {
    const startTraffic = vi.fn<Chorus['startTraffic']>(() =>
      Promise.resolve({ state: state({ capturing: false, failure: 'in-use' }) })
    )
    const { container, calls } = await drawRun(unmanaged, { capturing: false }, DETECTED, {
      startTraffic,
    })
    await press(toggleIn(container))
    await settle()

    expect(startTraffic).toHaveBeenCalledWith({ projectId: 'p1' })
    expect(calls.startRun).not.toHaveBeenCalled()
    expect(stoppedTexts(container)).toContain('traffic.portInUse')
  })

  it('refuses capture while there is nowhere to forward to', async () => {
    const { container, calls } = await drawRun(unmanaged, { capturing: false, origin: null })
    expect(toggleIn(container)?.disabled).toBe(true)
    expect(toggleIn(container)?.title).toBe('traffic.noOrigin')
    expect(calls.startTraffic).not.toHaveBeenCalled()
  })

  it('drops a capture reply or failure that belongs to the previous project', async () => {
    for (const ending of ['reply', 'failure'] as const) {
      const pending = deferred<Awaited<ReturnType<Chorus['startTraffic']>>>()
      const startTraffic = vi.fn<Chorus['startTraffic']>(() => pending.promise)
      const view = await drawRun(unmanaged, { capturing: false }, DETECTED, { startTraffic })
      await press(toggleIn(view.container))

      view.rerender(<TrafficPanel projectId="p2" terminals={[]} run={unmanaged} />)
      await settle()
      if (ending === 'reply') pending.resolve({ state: state({ capturing: true }) })
      else pending.reject(new Error('main went away'))
      await settle()

      expect(toggleIn(view.container)?.getAttribute('aria-pressed'), ending).toBe('false')
      expect(stoppedTexts(view.container)).not.toContain('traffic.actionFailed')
      view.unmount()
    }
  })

  it('drops a Run failure from the previous project, and reports the current one', async () => {
    const stale = deferred<RunResponse<'run:start'>>()
    const fresh = deferred<RunResponse<'run:start'>>()
    const startRun = vi
      .fn<Chorus['startRun']>()
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => fresh.promise)
    const view = await drawRun(runState(), READY, DETECTED, { startRun })
    await press(control(view.container, 'run'))

    for (const projectId of ['p2', 'p1']) {
      view.rerender(<TrafficPanel projectId={projectId} terminals={[]} run={runState()} />)
      await settle()
    }
    stale.reject(new Error('refused'))
    await settle()
    expect(stoppedTexts(view.container)).not.toContain('run.actionFailed')

    await press(control(view.container, 'run'))
    expect(startRun).toHaveBeenCalledTimes(2)
    fresh.reject(new Error('refused'))
    await settle()
    expect(stoppedTexts(view.container)).toContain('run.actionFailed')
  })

  it('ignores an old capture reply after leaving and returning, and takes a new one', async () => {
    const stale = deferred<Awaited<ReturnType<Chorus['startTraffic']>>>()
    const fresh = deferred<Awaited<ReturnType<Chorus['startTraffic']>>>()
    const startTraffic = vi
      .fn<Chorus['startTraffic']>()
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => fresh.promise)
    const view = await drawRun(unmanaged, { capturing: false }, DETECTED, { startTraffic })
    await press(toggleIn(view.container))

    for (const projectId of ['p2', 'p1']) {
      view.rerender(<TrafficPanel projectId={projectId} terminals={[]} run={unmanaged} />)
      await settle()
    }
    stale.resolve({ state: state({ capturing: true }) })
    await settle()
    expect(toggleIn(view.container)?.getAttribute('aria-pressed')).toBe('false')

    await press(toggleIn(view.container))
    expect(startTraffic).toHaveBeenCalledTimes(2)
    fresh.resolve({ state: state({ capturing: true }) })
    await settle()
    expect(toggleIn(view.container)?.getAttribute('aria-pressed')).toBe('true')
  })
})

describe('choosing a command applies it at once', () => {
  const held = (): {
    readonly configureRun: ReturnType<typeof vi.fn<Chorus['configureRun']>>
    readonly answers: ReturnType<typeof deferred<RunResponse<'run:configure'>>>[]
  } => {
    const answers: ReturnType<typeof deferred<RunResponse<'run:configure'>>>[] = []
    const configureRun = vi.fn<Chorus['configureRun']>(() => {
      const answer = deferred<RunResponse<'run:configure'>>()
      answers.push(answer)
      return answer.promise
    })
    return { configureRun, answers }
  }

  const reply = (commands: RunState['commands']): RunResponse<'run:configure'> => ({
    ...IDLE_RUN,
    commands,
    available: true,
  })

  it('saves the last of two choices made while the first was still saving', async () => {
    const sync = held()
    const view = await drawRun(runState(), READY, DETECTED, { configureRun: sync.configureRun })
    await press(control(view.container, 'edit'))
    await settle()

    await choose(view.container, 'script:dev:clean')
    await choose(view.container, 'script:lint')
    expect(sync.configureRun).toHaveBeenCalledTimes(1)
    expect(control(view.container, 'run')?.disabled).toBe(true)
    expect(control(view.container, 'run')?.title).toBe('run.saving')

    const first = savedOnly('script:dev:clean', 'dev:clean', 'npm run dev:clean')
    view.rerender(
      <TrafficPanel projectId="p1" terminals={[]} run={runState({ commands: first })} />
    )
    await act(() => Promise.resolve())
    expect(chosenIds(view.container)).toEqual(['script:lint'])

    sync.answers[0]?.resolve(reply(first))
    await settle()
    expect(sync.configureRun).toHaveBeenCalledTimes(2)
    expect(sync.configureRun.mock.calls[1]?.[0].commands).toEqual(
      savedOnly('script:lint', 'lint', 'npm run lint')
    )
    expect(control(view.container, 'run')?.disabled).toBe(true)

    sync.answers[1]?.resolve(reply(savedOnly('script:lint', 'lint', 'npm run lint')))
    await settle()
    expect(chosenIds(view.container)).toEqual(['script:lint'])
    expect(control(view.container, 'run')?.disabled).toBe(false)
  })

  it('puts the saved command back and says so when a choice is refused', async () => {
    const sync = held()
    const view = await drawRun(runState(), READY, DETECTED, { configureRun: sync.configureRun })
    await press(control(view.container, 'edit'))
    await settle()

    await choose(view.container, 'script:lint')
    sync.answers[0]?.reject(new Error('refused'))
    await settle()

    expect(chosenIds(view.container)).toEqual(['script:dev'])
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('run.saveFailed')
    expect(control(view.container, 'run')?.disabled).toBe(false)
    await press(control(view.container, 'run'))
    expect(view.calls.startRun).toHaveBeenCalledWith({ projectId: 'p1' })

    await choose(view.container, 'script:lint')
    expect(view.container.querySelector('[role="alert"]')).toBeNull()
    expect(sync.configureRun).toHaveBeenCalledTimes(2)
  })

  it('never runs while a choice is saving', async () => {
    const sync = held()
    const view = await drawRun(runState(), READY, DETECTED, { configureRun: sync.configureRun })
    await press(control(view.container, 'edit'))
    await settle()
    await choose(view.container, 'script:lint')

    await press(control(view.container, 'run'))
    expect(view.calls.startRun).not.toHaveBeenCalled()
    expect(labelOf(control(view.container, 'run'))).toBe('run.run')
  })

  it('keeps a choice saving across closing and reopening the panel', async () => {
    const sync = held()
    const view = await drawRun(runState(), READY, DETECTED, { configureRun: sync.configureRun })
    await press(control(view.container, 'edit'))
    await settle()
    await choose(view.container, 'script:lint')
    await press(control(view.container, 'edit'))
    await press(control(view.container, 'edit'))
    await settle()

    expect(chosenIds(view.container)).toEqual(['script:lint'])
    sync.answers[0]?.resolve(reply(savedOnly('script:lint', 'lint', 'npm run lint')))
    await settle()
    expect(control(view.container, 'run')?.disabled).toBe(false)
  })

  it('keeps a choice confirmed only by its answer when the next one fails', async () => {
    const sync = held()
    const view = await drawRun(runState({ commands: null }), READY, DETECTED, {
      configureRun: sync.configureRun,
    })
    await press(control(view.container, 'run'))
    await settle()
    expect(chosenIds(view.container)).toEqual(['script:dev'])

    await choose(view.container, 'script:lint')
    sync.answers[0]?.resolve(reply({ version: 1, defaultId: 'script:dev', commands: [DEV] }))
    await settle()
    expect(sync.configureRun).toHaveBeenCalledTimes(2)
    sync.answers[1]?.reject(new Error('refused'))
    await settle()

    expect(chosenIds(view.container)).toEqual(['script:dev'])
    expect(labelOf(control(view.container, 'run'))).toBe('run.run')
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('run.saveFailed')

    await press(control(view.container, 'edit'))
    await press(control(view.container, 'edit'))
    await settle()
    expect(chosenIds(view.container)).toEqual(['script:dev'])
  })

  it('keeps a single saved choice across closing and reopening before any push', async () => {
    const sync = held()
    const view = await drawRun(runState(), READY, DETECTED, { configureRun: sync.configureRun })
    await press(control(view.container, 'edit'))
    await settle()
    await choose(view.container, 'script:lint')
    sync.answers[0]?.resolve(reply(savedOnly('script:lint', 'lint', 'npm run lint')))
    await settle()

    await press(control(view.container, 'edit'))
    await press(control(view.container, 'edit'))
    await settle()
    expect(chosenIds(view.container)).toEqual(['script:lint'])
    expect(sync.configureRun).toHaveBeenCalledTimes(1)
  })

  it('shows and sends what another window saved under the same id', async () => {
    const before = savedOnly('custom:1', 'Expo', 'npx expo start')
    const view = await drawRun(runState({ commands: before }))
    await press(control(view.container, 'edit'))
    await settle()
    const code = (): string | null | undefined =>
      view.container.querySelector('[data-run-choice="custom:1"] code')?.textContent
    expect(code()).toBe('npx expo start')

    const after = savedOnly('custom:1', 'Expo web', 'npx expo start --web')
    view.rerender(
      <TrafficPanel projectId="p1" terminals={[]} run={runState({ commands: after })} />
    )
    await act(() => Promise.resolve())
    expect(code()).toBe('npx expo start --web')
    expect(view.container.querySelector('[data-run-choice="custom:1"] label')?.textContent).toBe(
      'Expo web'
    )

    await choose(view.container, 'script:dev')
    await settle()
    await choose(view.container, 'custom:1')
    await settle()
    expect(view.calls.configureRun.mock.calls.at(-1)?.[0].commands).toEqual(after)
  })

  it('shows a saving choice over an older entry with the same id when reopened', async () => {
    const sync = held()
    const view = await drawRun(
      runState({ commands: null }),
      READY,
      { ...NO_VARIABLES, scripts: [] },
      { configureRun: sync.configureRun }
    )
    await press(control(view.container, 'run'))
    await settle()
    typeInto(view.container, 'custom-command', 'npx expo start')
    await press(control(view.container, 'add'))

    const other = savedOnly('custom:1', 'Other', 'npm run other')
    view.rerender(
      <TrafficPanel projectId="p1" terminals={[]} run={runState({ commands: other })} />
    )
    await act(() => Promise.resolve())
    await press(control(view.container, 'edit'))
    await press(control(view.container, 'edit'))
    await settle()

    expect(chosenIds(view.container)).toEqual(['custom:1'])
    expect(view.container.querySelector('[data-run-choice="custom:1"] code')?.textContent).toBe(
      'npx expo start'
    )
  })

  it('falls back to what another window saved while a refused choice was saving', async () => {
    const sync = held()
    const view = await drawRun(runState(), READY, DETECTED, { configureRun: sync.configureRun })
    await press(control(view.container, 'edit'))
    await settle()
    await choose(view.container, 'script:lint')

    const other = savedOnly('custom:9', 'Other', 'npm run other')
    view.rerender(
      <TrafficPanel projectId="p1" terminals={[]} run={runState({ commands: other })} />
    )
    await act(() => Promise.resolve())
    expect(chosenIds(view.container)).toEqual(['script:lint'])

    sync.answers[0]?.reject(new Error('refused'))
    await settle()

    expect(chosenIds(view.container)).toEqual(['custom:9'])
    expect(view.container.querySelector('[data-run-choice="custom:9"] code')?.textContent).toBe(
      'npm run other'
    )
  })

  it('drops a choice’s answer once the panel has moved to another project', async () => {
    const sync = held()
    const view = await drawRun(runState(), READY, DETECTED, { configureRun: sync.configureRun })
    await press(control(view.container, 'edit'))
    await settle()
    await choose(view.container, 'script:lint')
    expect(sync.configureRun.mock.calls[0]?.[0].projectId).toBe('p1')

    view.rerender(<TrafficPanel projectId="p2" terminals={[]} run={runState()} />)
    await settle()
    sync.answers[0]?.reject(new Error('refused'))
    await settle()

    expect(view.container.querySelector('[role="alert"]')).toBeNull()
    expect(control(view.container, 'run')?.disabled).toBe(false)
    await press(control(view.container, 'edit'))
    await settle()
    await choose(view.container, 'script:dev:clean')
    expect(sync.configureRun.mock.calls.at(-1)?.[0].projectId).toBe('p2')
  })
})

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: Error) => void
} {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: Error) => void = () => undefined
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}
