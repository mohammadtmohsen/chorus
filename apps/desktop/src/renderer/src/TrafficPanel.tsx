import type { TFunction } from 'i18next'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  DEFAULT_LOGCAT_FILTER,
  DEFAULT_TRAFFIC_PORT,
  terminalRefKey,
  type TerminalRefShape,
  type TrafficRowShape,
  type TrafficSourceShape,
} from '../../shared/ipc.js'
import type {
  DetectedScriptsShape,
  RunCommandsShape,
  RunFailureShape,
  RunState,
} from '../../shared/run-ipc.js'
import {
  TRAFFIC_ENV_NAME,
  isTrafficHost,
  type TrafficFailure,
  type TrafficLegacy,
  type TrafficPush,
  type TrafficState,
} from '../../shared/traffic-ipc.js'
import { TrafficEndpoint } from './TrafficEndpoint.js'
import { TrafficRequestInspector } from './TrafficRequestInspector.js'
import { filterRows, isPending, pathOf, statusClassOf } from './traffic-filter.js'
import { onHostReconnected } from './host-actions.js'
import {
  applySnapshot,
  EMPTY_TRAFFIC,
  pendingUntilAttached,
  reduceTraffic,
  type TrafficAttachment,
  type TrafficStream,
} from './traffic-stream.js'
import { useTrafficPanel, useWorkspaceActions } from './workspace/hooks.js'

export interface TrafficTerminalOption {
  readonly ref: TerminalRefShape
  readonly label: string
}

export interface TrafficRunHost {
  readonly element: HTMLElement | null
  readonly reveal: () => void
}

const sourceValue = (source: TrafficSourceShape): string =>
  source.kind === 'off' ? '' : source.kind === 'logcat' ? 'logcat' : terminalRefKey(source.ref)

const hostOf = (state: TrafficState): string => state.host ?? state.address?.split(':')[0] ?? ''

const idle: TrafficState = {
  capturing: false,
  port: null,
  wantedPort: null,
  address: null,
  origin: null,
  access: 'lan',
  envVar: null,
  source: { kind: 'off' },
  failure: null,
  forwardedDevices: 0,
}

export const FAILURE_KEYS: Record<TrafficFailure, string> = {
  'in-use': 'traffic.portInUse',
  failed: 'traffic.startFailed',
  'source-busy': 'traffic.sourceBusy',
  'unknown-project': 'traffic.unknownProject',
  capturing: 'traffic.capturingChange',
  'no-port': 'traffic.noPort',
  'no-origin': 'traffic.noOrigin',
  'ownership-unknown': 'traffic.ownershipUnknown',
  unresolved: 'traffic.unresolved',
  'invalid-host': 'traffic.hostInvalid',
}

export const RUN_FAILURE_KEYS: Record<RunFailureShape, string> = {
  'not-local': 'run.failedNotLocal',
  'unsupported-platform': 'run.failedPlatform',
  'unsupported-shell': 'run.failedShell',
  'no-command': 'run.failedNoCommand',
  'no-origin': 'run.failedNoOrigin',
  'no-variable': 'run.failedNoVariable',
  'capture-failed': 'run.failedCapture',
  'no-redirect': 'run.failedRedirect',
  'spawn-failed': 'run.failedSpawn',
  cancelled: 'run.failedCancelled',
  'stop-incomplete': 'run.failedStopIncomplete',
}

export function runBusy(run: RunState | null): boolean {
  const kind = run?.process.kind
  return kind === 'starting' || kind === 'running' || kind === 'stopping'
}

export function runStatusText(run: RunState | null, t: TFunction): string {
  const current = run?.process ?? { kind: 'idle' as const }
  switch (current.kind) {
    case 'idle':
      return t('run.notStarted')
    case 'starting':
      return t('run.starting', { label: current.active.label })
    case 'running':
      return t('run.running', { label: current.active.label })
    case 'stopping':
      return t('run.stopping')
    case 'exited':
      return current.code === null
        ? t('run.exitedUnknown', { label: current.active.label })
        : t('run.exited', { label: current.active.label, code: current.code })
    case 'failed':
      return t(RUN_FAILURE_KEYS[current.reason])
  }
}

const COMMAND_LIMIT = 500
const LABEL_LIMIT = 40
const ID_LIMIT = 64
const VARIABLE_LIMIT = 64
const DEFAULT_CALL_LIMIT = 10
const CALL_LIMITS = [DEFAULT_CALL_LIMIT, 20, 50, 100, 200, 1000]

interface RunChoice {
  readonly id: string
  readonly label: string
  readonly command: string
  readonly fits: boolean
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  const bounded = base.slice(0, ID_LIMIT)
  if (!taken.has(bounded)) return bounded
  for (let next = 2; ; next += 1) {
    const suffix = `~${String(next)}`
    const candidate = `${base.slice(0, ID_LIMIT - suffix.length)}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

function savedChoices(saved: RunCommandsShape | null): RunChoice[] {
  return (saved?.commands ?? []).map((each) => ({ ...each, fits: true }))
}

function withOffered(
  current: readonly RunChoice[],
  found: DetectedScriptsShape | null
): RunChoice[] {
  const known = new Set(current.map((each) => each.command))
  const taken = new Set(current.map((each) => each.id))
  const offered: RunChoice[] = []
  for (const script of found?.scripts ?? []) {
    if (known.has(script.command)) continue
    known.add(script.command)
    const id = uniqueId(`script:${script.name}`, taken)
    taken.add(id)
    offered.push({
      id,
      label: script.name.slice(0, LABEL_LIMIT),
      command: script.command,
      fits: script.command.length <= COMMAND_LIMIT,
    })
  }
  return [...current, ...offered]
}

function suggestedId(choices: readonly RunChoice[]): string | null {
  const usable = choices.filter((each) => each.fits)
  const preferred = ['dev', 'start']
    .map((name) => usable.find((each) => each.label === name))
    .find((each) => each !== undefined)
  return (preferred ?? usable[0])?.id ?? null
}

export function TrafficPanel(props: {
  readonly projectId: string
  readonly terminals: readonly TrafficTerminalOption[]
  readonly run?: RunState | null
  readonly runHost?: TrafficRunHost
  readonly collapsed?: boolean | undefined
}): React.JSX.Element {
  const { t } = useTranslation()
  const { projectId } = props
  const hiddenPathPrefix = useTrafficPanel(projectId).hiddenPathPrefix ?? ''
  const { setTrafficHiddenPathPrefix } = useWorkspaceActions()
  const collapsed = props.collapsed === true
  /*
   * One base for the setup fields' ids. Two panels can be mounted at once — a
   * pane split puts the traffic tab in each — and `htmlFor` takes a string, so
   * the labels would point at whichever field was rendered last.
   */
  const fields = useId()
  const [stream, setStream] = useState<TrafficStream>(EMPTY_TRAFFIC)
  const [reconnect, setReconnect] = useState(0)
  const [capture, setCapture] = useState<TrafficState>(idle)
  const [legacy, setLegacy] = useState<TrafficLegacy | null>(null)
  const [portDraft, setPortDraft] = useState(String(DEFAULT_TRAFFIC_PORT))
  const [originDraft, setOriginDraft] = useState('')
  const [envVarDraft, setEnvVarDraft] = useState('')
  const [hostDraft, setHostDraft] = useState('')
  const [hostSaving, setHostSaving] = useState(false)
  const [addressChanged, setAddressChanged] = useState(false)
  const [filters, setFilters] = useState(DEFAULT_LOGCAT_FILTER)
  const [failure, setFailure] = useState<TrafficFailure | 'action' | 'origin' | null>(null)
  /*
   * Which field the last refusal belongs to.
   *
   * The message is a fact about one control, and it used to render at the foot
   * of the panel — far enough away that a person whose correction had just been
   * refused went on reading their own text in the box as though it had been
   * taken. Naming the field is what lets it appear under the control it is
   * about, in the hint slot that is already there.
   */
  const [refusedAt, setRefusedAt] = useState<'origin' | 'port' | 'envVar' | 'host' | null>(null)
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null)
  const [setupOpen, setSetupOpen] = useState(false)
  const [detected, setDetected] = useState<DetectedScriptsShape | null>(null)
  const [choices, setChoicesState] = useState<readonly RunChoice[]>([])
  const [chosenCommand, setChosenCommand] = useState<string | null>(null)
  const [customLabel, setCustomLabel] = useState('')
  const [customCommand, setCustomCommand] = useState('')
  const [setupError, setSetupError] = useState<string | null>(null)
  const [runRefused, setRunRefused] = useState(false)
  const [savingChoice, setSavingChoice] = useState<RunChoice | null>(null)
  const [choiceRefused, setChoiceRefused] = useState(false)
  const [confirmed, setConfirmed] = useState<RunCommandsShape | null>(props.run?.commands ?? null)
  const actingFor = useRef<object | null>(null)
  const setupSession = useRef(0)
  const choicesNow = useRef<readonly RunChoice[]>([])
  const selectedNow = useRef<string | null>(null)
  const hostRequest = useRef<object | null>(null)
  const advertised = useRef<{ projectId: string; address: string | null; token: number | null }>({
    projectId,
    address: null,
    token: null,
  })
  const wantedChoice = useRef<RunChoice | null>(null)
  const sendingFor = useRef<object | null>(null)
  const confirmedNow = useRef<RunCommandsShape | null>(props.run?.commands ?? null)
  const variableEdited = useRef(false)
  const [search, setSearch] = useState('')
  const [callLimit, setCallLimit] = useState(DEFAULT_CALL_LIMIT)

  const rowsList = useRef<HTMLUListElement>(null)
  const captureSetup = useRef<HTMLDetailsElement>(null)
  const filtered = filterRows(stream.rows, search)
  const shown = filtered.slice(-callLimit)
  const newestSeq = shown.at(-1)?.seq ?? null
  const newestRequestSeq = shown.findLast((row) => row.source === 'http')?.seq ?? null
  const currentProcess = props.run?.process
  const runToken = currentProcess && 'token' in currentProcess ? currentProcess.token : null
  const runIsBusy = runBusy(props.run ?? null)
  const advertisedHost = hostOf(capture)

  useEffect(() => {
    const previous = advertised.current
    advertised.current = { projectId, address: capture.address, token: runToken }
    if (previous.projectId !== projectId || previous.token !== runToken || !runIsBusy) {
      setAddressChanged(false)
    } else if (
      previous.address !== null &&
      capture.address !== null &&
      previous.address !== capture.address
    ) {
      setAddressChanged(true)
    }
  }, [projectId, capture.address, runToken, runIsBusy])

  useEffect(() => {
    setHostDraft(advertisedHost)
  }, [projectId, advertisedHost])

  useEffect(() => {
    setSelectedSeq(stream.projectId === projectId ? newestRequestSeq : null)
  }, [projectId, stream.projectId, stream.captureId, newestRequestSeq])

  useEffect(() => {
    setupSession.current += 1
    wantedChoice.current = null
    setSetupOpen(false)
    setDetected(null)
    setSetupError(null)
    setRunRefused(false)
    setSavingChoice(null)
    setChoiceRefused(false)
    hostRequest.current = null
    setHostSaving(false)
    confirmedNow.current = props.run?.commands ?? null
    setConfirmed(confirmedNow.current)
  }, [projectId])

  useEffect(() => {
    const lifetime = {}
    actingFor.current = lifetime
    return () => {
      actingFor.current = null
    }
  }, [projectId])

  useLayoutEffect(() => {
    const list = rowsList.current
    if (list === null || collapsed || stream.projectId !== projectId) return
    list.scrollTop = list.scrollHeight
  }, [newestSeq, callLimit, search, projectId, stream.projectId, stream.captureId, collapsed])

  useEffect(() => {
    return onHostReconnected(() => {
      setReconnect((current) => current + 1)
    })
  }, [])

  useEffect(() => {
    let attachment: TrafficAttachment | null = null
    let queued: TrafficPush[] = []
    let cancelled = false

    const stopListening = window.chorus.onTraffic((push) => {
      if (push.projectId !== projectId) return
      if (attachment === null) {
        queued.push(push)
        return
      }
      if (push.subscriptionId !== attachment.subscriptionId) return
      setStream((previous) => reduceTraffic(previous, push))
      /*
       * Every kind, and that is the fix rather than a tidy-up.
       *
       * The credit model holds one delivery outstanding until it is
       * acknowledged, so a kind this handler did not name — `resync`, which is
       * sent when a stalled view's queue overflows — left main holding a push
       * forever and every later row queued behind it, with nothing on screen to
       * say so.
       */
      void window.chorus.ackTraffic({
        projectId,
        subscriptionId: attachment.subscriptionId,
        seq: push.kind === 'rows' ? push.seq : attachment.seq,
      })
      if (push.kind === 'state' && push.projectId === projectId) {
        setCapture(push.state)
        if (push.state.failure !== 'capturing') setFailure(push.state.failure)
      }
    })

    void window.chorus
      .attachTraffic({ projectId })
      .then((opened) => {
        if (cancelled) {
          void window.chorus.detachTraffic({
            projectId,
            subscriptionId: opened.subscriptionId,
          }).catch(() => undefined)
          return
        }
        attachment = {
          projectId,
          subscriptionId: opened.subscriptionId,
          captureId: opened.captureId,
          seq: opened.seq,
          rows: opened.rows,
        }
        setStream(pendingUntilAttached(queued, attachment))
        queued = []
        /*
         * Anything main sent between this listener being registered and the
         * attachment arriving was queued above and could not be acknowledged —
         * there was no subscription id to name yet. Main is holding its one
         * outstanding delivery on it, so the credit is released here or the
         * stream never starts.
         */
        void window.chorus.ackTraffic({
          projectId,
          subscriptionId: opened.subscriptionId,
          seq: opened.seq,
        })
        setCapture(opened.state)
        setFailure(opened.state.failure === 'capturing' ? null : opened.state.failure)
        setPortDraft(String(opened.state.wantedPort ?? DEFAULT_TRAFFIC_PORT))
        setOriginDraft(opened.state.origin ?? '')
        setEnvVarDraft(opened.state.envVar ?? '')
        setHostDraft(hostOf(opened.state))
        if (opened.state.source.kind === 'logcat') setFilters(opened.state.source.filters)
      })
      .catch(() => {
        setFailure('action')
      })

    return () => {
      cancelled = true
      stopListening()
      if (attachment !== null) {
        void window.chorus.detachTraffic({ projectId, subscriptionId: attachment.subscriptionId }).catch(() => undefined)
      }
    }
  }, [projectId, reconnect])

  useEffect(() => {
    setPortDraft(String(capture.wantedPort ?? DEFAULT_TRAFFIC_PORT))
  }, [capture.wantedPort])

  useEffect(() => {
    void window.chorus
      .readTrafficLegacy({})
      .then(setLegacy)
      .catch(() => {
        setLegacy(null)
      })
  }, [])

  /** A paused view asks for one snapshot rather than retrying by itself. */
  const resume = useCallback((): void => {
    if (stream.subscriptionId === '') return
    void window.chorus
      .snapshotTraffic({ projectId, subscriptionId: stream.subscriptionId, seq: stream.seq })
      .then((page) => {
        setStream((previous) => applySnapshot(previous, page))
      })
      .catch(() => {
        setFailure('action')
      })
  }, [projectId, stream.subscriptionId, stream.seq])

  const select = useCallback(
    (next: TrafficSourceShape): void => {
      void window.chorus
        .selectTrafficSource({ projectId, source: next })
        .then(({ state }) => {
          setCapture(state)
          setFailure(state.failure)
        })
        .catch(() => {
          setFailure('action')
        })
    },
    [projectId]
  )

  const choose = useCallback(
    (value: string): void => {
      if (value === '') {
        select({ kind: 'off' })
        return
      }
      if (value === 'logcat') {
        select({ kind: 'logcat', filters })
        return
      }
      const ref = props.terminals.find((option) => terminalRefKey(option.ref) === value)?.ref
      select(ref === undefined ? { kind: 'off' } : { kind: 'terminal', ref })
    },
    [props.terminals, filters, select]
  )

  const commitFilters = useCallback((): void => {
    const next = filters.trim() === '' ? DEFAULT_LOGCAT_FILTER : filters.trim()
    setFilters(next)
    if (capture.source.kind === 'logcat') select({ kind: 'logcat', filters: next })
  }, [filters, capture.source, select])

  /*
   * **All three of these put the field back from `state`, taken or refused.**
   *
   * The two used to disagree, and the disagreement was the defect: `commitPort`
   * restored the field only when the change was *refused*, `commitOrigin` only
   * when it *succeeded*. So refusing an origin change — which `configure` does
   * on purpose while a capture is running, because the socket is already bound
   * and the forward target is read once at `Start` — left the rejected text
   * sitting in the box. The panel showed `:30081` and the listener went on
   * forwarding to `:3008`, and every row was a 502 against a port with nothing
   * on it. `commitEnvVar` already had the honest form.
   *
   * `state` is authoritative either way: `configure` returns before it stores
   * anything when it refuses, so the value it hands back is the stored one. One
   * rule for the three, and no branch to get wrong.
   */
  const commitOrigin = useCallback((): void => {
    void window.chorus
      .configureTraffic({ projectId, config: { origin: originDraft.trim() } })
      .then(({ state, failure: refused }) => {
        setCapture(state)
        setFailure(refused)
        setRefusedAt(refused === null ? null : 'origin')
        setOriginDraft(state.origin ?? '')
      })
      .catch(() => {
        setFailure('origin')
      })
  }, [projectId, originDraft])

  const commitPort = useCallback((): void => {
    const parsed = Number(portDraft.trim())
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
      setPortDraft(String(capture.wantedPort ?? DEFAULT_TRAFFIC_PORT))
      setFailure('action')
      return
    }
    void window.chorus
      .configureTraffic({ projectId, config: { port: parsed } })
      .then(({ state, failure: refused }) => {
        setCapture(state)
        setFailure(refused)
        setRefusedAt(refused === null ? null : 'port')
        setPortDraft(String(state.wantedPort ?? DEFAULT_TRAFFIC_PORT))
      })
      .catch(() => {
        setFailure('action')
      })
  }, [projectId, portDraft, capture.wantedPort])

  const commitEnvVar = useCallback((): void => {
    const name = envVarDraft.trim()
    void window.chorus
      .configureTraffic({ projectId, config: { envVar: name === '' ? null : name } })
      .then(({ state, failure: refused }) => {
        setCapture(state)
        setFailure(refused)
        /*
         * Nothing refuses an env-var change today — it is not one of the moves
         * `configure` guards — so this branch cannot fire yet. It is here so the
         * three handlers read the same, and so a guard added to that field
         * later reports at the field rather than at the foot of the panel.
         */
        setRefusedAt(refused === null ? null : 'envVar')
        setEnvVarDraft(state.envVar ?? '')
      })
      .catch(() => {
        setFailure('action')
      })
  }, [projectId, envVarDraft])

  const chooseAccess = useCallback(
    (value: string): void => {
      void window.chorus
        .configureTraffic({ projectId, config: { access: value === 'lan' ? 'lan' : 'loopback' } })
        .then(({ state, failure: refused }) => {
          setCapture(state)
          setFailure(refused)
        })
        .catch(() => {
          setFailure('action')
        })
    },
    [projectId]
  )

  const commitHost = useCallback(
    (host: string | null): void => {
      const lifetime = actingFor.current
      if (lifetime === null || hostRequest.current !== null) return
      if (host !== null && !isTrafficHost(host)) {
        setFailure('invalid-host')
        setRefusedAt('host')
        return
      }
      const request = {}
      hostRequest.current = request
      setHostSaving(true)
      void window.chorus
        .configureTraffic({ projectId, config: { host } })
        .then(({ state, failure: refused }) => {
          if (actingFor.current !== lifetime) return
          setCapture(state)
          setFailure(refused)
          setRefusedAt(refused === null ? null : 'host')
          setHostDraft(hostOf(state))
        })
        .catch(() => {
          if (actingFor.current === lifetime) setFailure('action')
        })
        .finally(() => {
          if (actingFor.current !== lifetime || hostRequest.current !== request) return
          hostRequest.current = null
          setHostSaving(false)
        })
    },
    [projectId]
  )

  const copy = useCallback((text: string): void => {
    void window.chorus.copyText({ text })
  }, [])

  const envLine =
    capture.address === null
      ? null
      : capture.envVar === null
        ? `http://${capture.address}`
        : `${capture.envVar}=http://${capture.address}`

  const toggle = useCallback((): void => {
    const lifetime = actingFor.current
    const call = capture.capturing
      ? window.chorus.stopTraffic({ projectId })
      : window.chorus.startTraffic({ projectId })
    void call
      .then(({ state }) => {
        if (lifetime === null || actingFor.current !== lifetime) return
        setCapture(state)
        setFailure(state.failure)
        setPortDraft(String(state.wantedPort ?? DEFAULT_TRAFFIC_PORT))
      })
      .catch(() => {
        if (lifetime === null || actingFor.current !== lifetime) return
        setFailure('action')
      })
  }, [projectId, capture.capturing])

  const run = props.run ?? null
  const managedRun = run?.available ? run : null
  const busy = runBusy(run)
  const commands = run?.commands ?? null
  const defaultCommand =
    confirmed === null
      ? null
      : (confirmed.commands.find((each) => each.id === confirmed.defaultId) ?? null)
  const commandsKey = commands === null ? '' : JSON.stringify(commands)
  const needsSetup = confirmed === null

  const setChoices = (next: readonly RunChoice[]): void => {
    choicesNow.current = next
    setChoicesState(next)
  }

  const selectCommand = (id: string | null): void => {
    selectedNow.current = id
    setChosenCommand(id)
  }

  const closeSetup = (): void => {
    setupSession.current += 1
    setSetupOpen(false)
    setSetupError(null)
  }

  const seedChoices = (
    saved: RunCommandsShape | null,
    found: DetectedScriptsShape | null
  ): void => {
    const pending = wantedChoice.current
    const base = withOffered(savedChoices(saved), found)
    setChoices(
      pending === null
        ? base
        : base.some((each) => each.id === pending.id)
          ? base.map((each) => (each.id === pending.id ? pending : each))
          : [...base, pending]
    )
    selectCommand(pending?.id ?? saved?.defaultId ?? null)
  }

  const sendChoice = async (): Promise<void> => {
    const lifetime = actingFor.current
    if (lifetime === null) return
    sendingFor.current = lifetime
    try {
      for (;;) {
        const choice = wantedChoice.current
        if (choice === null || actingFor.current !== lifetime) return
        let answered: RunCommandsShape | null
        try {
          const reply = await window.chorus.configureRun({
            projectId,
            commands: {
              version: 1,
              defaultId: choice.id,
              commands: [{ id: choice.id, label: choice.label, command: choice.command }],
            },
          })
          answered = reply.commands
        } catch {
          if (actingFor.current !== lifetime) return
          if (wantedChoice.current !== choice) continue
          wantedChoice.current = null
          setSavingChoice(null)
          setChoiceRefused(true)
          const fallback = confirmedNow.current
          const entry =
            fallback === null
              ? undefined
              : fallback.commands.find((each) => each.id === fallback.defaultId)
          if (entry !== undefined) {
            const restored: RunChoice = { ...entry, fits: true }
            setChoices(
              choicesNow.current.some((each) => each.id === entry.id)
                ? choicesNow.current.map((each) => (each.id === entry.id ? restored : each))
                : [...choicesNow.current, restored]
            )
          }
          selectCommand(fallback?.defaultId ?? null)
          return
        }
        if (actingFor.current !== lifetime) return
        confirmedNow.current = answered
        setConfirmed(answered)
        if (wantedChoice.current === choice) {
          wantedChoice.current = null
          setSavingChoice(null)
          return
        }
      }
    } finally {
      if (sendingFor.current === lifetime) sendingFor.current = null
    }
  }

  const applyChoice = (choice: RunChoice): void => {
    selectCommand(choice.id)
    setChoiceRefused(false)
    wantedChoice.current = choice
    setSavingChoice(choice)
    if (sendingFor.current === null || sendingFor.current !== actingFor.current) void sendChoice()
  }

  const commitSetup = (config: { readonly origin: string } | { readonly envVar: string }): void => {
    const lifetime = actingFor.current
    void window.chorus
      .configureTraffic({ projectId, config })
      .then(({ state, failure: refused }) => {
        if (lifetime === null || actingFor.current !== lifetime) return
        setCapture(state)
        const kept = 'origin' in config ? state.origin : state.envVar
        if (refused !== null || kept === null) {
          setSetupError(refused === 'capturing' ? 'run.whileRecording' : 'run.configFailed')
          return
        }
        setSetupError(null)
        if ('origin' in config) setOriginDraft(kept)
        else setEnvVarDraft(kept)
      })
      .catch(() => {
        if (lifetime === null || actingFor.current !== lifetime) return
        setSetupError('run.configFailed')
      })
  }

  const commitSetupOrigin = (): void => {
    const origin = originDraft.trim()
    if (origin === '') {
      setSetupError(null)
      return
    }
    commitSetup({ origin })
  }

  const commitSetupVariable = (name: string): void => {
    const variable = name.trim()
    if (variable === '') {
      setSetupError(null)
      return
    }
    if (variable.length > VARIABLE_LIMIT || !TRAFFIC_ENV_NAME.test(variable)) {
      setSetupError('run.badVariable')
      return
    }
    commitSetup({ envVar: variable })
  }

  const openSetup = (): void => {
    setupSession.current += 1
    const session = setupSession.current
    variableEdited.current = false
    seedChoices(confirmedNow.current, null)
    setSetupOpen(true)
    setSetupError(null)
    setDetected(null)
    void window.chorus
      .detectRunScripts({ projectId })
      .then((found) => {
        if (session !== setupSession.current) return
        setDetected(found)
        const merged = withOffered(choicesNow.current, found)
        setChoices(merged)
        if (selectedNow.current === null) {
          const suggestion = suggestedId(merged)
          const suggested = merged.find((each) => each.id === suggestion)
          if (suggested !== undefined) applyChoice(suggested)
        }
      })
      .catch(() => undefined)
  }

  const toggleSetup = (): void => {
    if (setupOpen) closeSetup()
    else openSetup()
  }

  useEffect(() => {
    const only = detected?.variables.length === 1 ? detected.variables[0] : undefined
    if (!setupOpen || only === undefined || variableEdited.current) return
    if (stream.projectId !== projectId || capture.envVar !== null) return
    variableEdited.current = true
    setEnvVarDraft(only)
    commitSetupVariable(only)
  }, [setupOpen, detected, stream.projectId, projectId, capture.envVar])

  useEffect(() => {
    confirmedNow.current = commands
    setConfirmed(commands)
    if (!setupOpen || wantedChoice.current !== null) return
    const incoming =
      commands === null
        ? undefined
        : commands.commands.find((each) => each.id === commands.defaultId)
    const shown = choicesNow.current.find((each) => each.id === selectedNow.current)
    if (
      incoming !== undefined &&
      incoming.id === shown?.id &&
      incoming.label === shown.label &&
      incoming.command === shown.command
    ) {
      return
    }
    seedChoices(commands, detected)
  }, [commandsKey])

  const addCustom = (): void => {
    const command = customCommand
    if (command.trim() === '') return
    if (command.length > COMMAND_LIMIT) {
      setSetupError('run.commandTooLong')
      return
    }
    const named = customLabel.trim()
    if (named.length > LABEL_LIMIT) {
      setSetupError('run.labelTooLong')
      return
    }
    const taken = new Set(choicesNow.current.map((each) => each.id))
    let next = 1
    while (taken.has(`custom:${String(next)}`)) next += 1
    const added: RunChoice = {
      id: `custom:${String(next)}`,
      label: named === '' ? command.trim().slice(0, LABEL_LIMIT) : named,
      command,
      fits: true,
    }
    setChoices([...choicesNow.current, added])
    applyChoice(added)
    setSetupError(null)
    setCustomLabel('')
    setCustomCommand('')
  }

  const act = (call: Promise<unknown>): void => {
    const lifetime = actingFor.current
    void call
      .then(() => {
        if (lifetime !== null && actingFor.current === lifetime) setRunRefused(false)
      })
      .catch(() => {
        if (lifetime === null || actingFor.current !== lifetime) return
        setRunRefused(true)
        props.runHost?.reveal()
      })
  }

  const runCommand = (): void => {
    if (wantedChoice.current !== null) return
    if (needsSetup) {
      if (captureSetup.current !== null) captureSetup.current.open = true
      if (!setupOpen) openSetup()
      props.runHost?.reveal()
      return
    }
    act(window.chorus.startRun({ projectId }))
  }

  /*
   * Emptying the history, which is a different question from forwarding.
   *
   * **The response's `{captureId, seq}` is deliberately dropped.** `registry.clear()`
   * mints a new capture generation and pushes a `reset`, and `reduceTraffic` is
   * the one place that applies it — through `belongs()`, which checks the project
   * and the subscription as well as the generation. Writing those two fields from
   * this response as well would be a second source of truth for state the push
   * already owns, with the faster of the two winning. So the list is not touched
   * here at all.
   *
   * Available whether capture is running or not: clearing what was captured and
   * forwarding what comes next are separate, and `clear()` leaves the socket up.
   */
  const clearCaptured = useCallback((): void => {
    void window.chorus.clearTraffic({ projectId }).catch(() => {
      setFailure('action')
    })
  }, [projectId])

  const decide = useCallback((keep: boolean): void => {
    void window.chorus
      .decideTrafficLegacy({ keep })
      .then(({ legacy: next }) => {
        setLegacy(next)
      })
      .catch(() => {
        setFailure('action')
      })
  }, [])

  /*
   * **The arrows move the selection as well as the focus.**
   *
   * They used to move focus alone, and selection was written only by `onClick`,
   * so walking the list left the inspector describing whatever had last been
   * clicked — the highlight moved past it and the panes did not.
   *
   * This is the same `setSelectedSeq` the click calls.
   *
   * Nothing here waits. The selection lands on the keystroke, so the highlight
   * and the inspector's header — both drawn from the row — change with it, and
   * only the detail read settles. That is what keeps a held arrow key from
   * putting a `readTrafficDetail` through a synchronous main thread per row
   * passed over: the reads still happen, but the panes never wait for the ones
   * you have already left.
   */
  const onRowKeyDown = (event: React.KeyboardEvent<HTMLUListElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>('.traffic-row-button')]
    const at = buttons.indexOf(document.activeElement as HTMLElement)
    const next = buttons[at + (event.key === 'ArrowDown' ? 1 : -1)]
    if (at === -1 || next === undefined) return
    event.preventDefault()
    next.focus()
    const seq = Number(next.dataset['seq'])
    if (Number.isInteger(seq)) setSelectedSeq(seq)
  }

  /*
   * One place that turns a failure into words, because it is now drawn in two —
   * under the field that was refused, and at the foot of the panel for the ones
   * that belong to no field. Two copies would agree until one was edited.
   */
  const failureText = (which: TrafficFailure | 'action' | 'origin'): string =>
    which === 'origin'
      ? t('traffic.originFailed')
      : which === 'action'
        ? t('traffic.actionFailed')
        : t(FAILURE_KEYS[which], { port: capture.wantedPort ?? DEFAULT_TRAFFIC_PORT })

  /*
   * `capturing` is the only failure `configure` can return — its guard refusing
   * an origin, port or reach change while a socket is bound. Testing the failure
   * rather than trusting `refusedAt` alone is what stops a later Start failure —
   * "set an address first" — from rendering under a setup field it has nothing
   * to do with, without having to clear `refusedAt` at every other call site.
   */
  const refusedField =
    failure === 'invalid-host' ? 'host' : failure === 'capturing' ? refusedAt : null

  const bodyOf = (row: TrafficRowShape): React.JSX.Element => {
    if (row.source === 'logcat') {
      return (
        <span className="traffic-line" title={row.line}>
          {row.line}
        </span>
      )
    }
    if (row.source === 'log') {
      return row.exit === null ? (
        <span className="traffic-line" title={row.line}>
          {row.line}
        </span>
      ) : (
        <span className="traffic-exit">{t('terminal.processExited', { code: row.exit })}</span>
      )
    }
    return (
      <>
        <span className="traffic-method" data-method={row.m.toUpperCase()}>
          {row.m}
        </span>
        <span className="traffic-status">
          {isPending(row) ? (
            <span className="traffic-pending" role="img" aria-label={t('traffic.pending')} />
          ) : (
            (row.status ?? '—')
          )}
        </span>
        <TrafficEndpoint label={pathOf(row.u, hiddenPathPrefix)} />
      </>
    )
  }

  /*
   * Selection is held by sequence, not by row object.
   *
   * A request writes its row twice, so holding the object would leave the
   * inspector showing the pending copy after the answer arrived — the row is
   * looked up again each render and the open detail follows it. A row that has
   * left the stream, because history was cleared or the window moved past it,
   * takes the selection with it rather than leaving a panel describing
   * something that is no longer listed.
   */
  const selected =
    stream.projectId !== projectId || selectedSeq === null
      ? null
      : (stream.rows.find(
          (row): row is Extract<TrafficRowShape, { source: 'http' }> =>
            row.source === 'http' && row.seq === selectedSeq
        ) ?? null)

  const indicator = (
    <>
      <span className="run-capture-icon" aria-hidden="true">
        ⇄
      </span>
      {capture.capturing && <span className="traffic-live-dot" aria-hidden="true" />}
    </>
  )

  const runLabel = needsSetup
    ? t('run.setUp')
    : t('run.run', { label: defaultCommand?.label ?? '' })

  const runKind = managedRun?.process.kind ?? 'idle'
  const cleanupShown =
    managedRun?.cleanupPending === true &&
    (runKind === 'idle' || runKind === 'exited' || runKind === 'failed')
  const stopShown =
    runKind === 'starting' || runKind === 'running' || runKind === 'stopping' || cleanupShown
  const stopTitle =
    runKind === 'stopping'
      ? t('run.stopping')
      : cleanupShown
        ? t('run.cleanupPending')
        : t('run.stop')
  const setupId = `${fields}-run-setup`
  const runHostElement = props.runHost?.element ?? null

  const runToggle =
    managedRun === null ? null : stopShown ? (
      <button
        type="button"
        className="traffic-action run-primary"
        data-run-action="stop"
        data-live={capture.capturing}
        disabled={managedRun.process.kind === 'stopping'}
        title={stopTitle}
        onClick={() => {
          act(window.chorus.stopRun({ projectId }))
        }}
      >
        {indicator}
        <span className="run-primary-label">
          {managedRun.process.kind === 'failed' ? t('run.retryStop') : t('run.stop')}
        </span>
      </button>
    ) : (
      <button
        type="button"
        className="traffic-action run-primary"
        data-run-action="run"
        data-live={capture.capturing}
        disabled={savingChoice !== null}
        title={savingChoice === null ? runLabel : t('run.saving')}
        onClick={runCommand}
      >
        {indicator}
        <span className="run-primary-label">
          {savingChoice === null ? runLabel : t('run.run', { label: savingChoice.label })}
        </span>
      </button>
    )

  const runControls =
    managedRun === null ? (
      <button
        type="button"
        className="traffic-action run-primary"
        data-live={capture.capturing}
        aria-pressed={capture.capturing}
        aria-label={capture.capturing ? t('traffic.stop') : t('traffic.start')}
        /*
         * Off, not silently refused. With no address committed, `start()`
         * returns before it binds and the panel's only answer was one line of
         * text under the fold — so the button read as dead when it had in fact
         * answered every time it was pressed.
         */
        disabled={!capture.capturing && capture.origin === null}
        title={!capture.capturing && capture.origin === null ? t('traffic.noOrigin') : undefined}
        onClick={toggle}
      >
        {indicator}
        <span className="run-primary-label">
          {capture.capturing ? t('traffic.stop') : t('traffic.start')}
        </span>
      </button>
    ) : (
      <div className="run-controls" data-run-state={managedRun.process.kind}>
        <span className="run-status" role="status" title={runStatusText(managedRun, t)}>
          {runStatusText(managedRun, t)}
        </span>
        {props.runHost === undefined && runToggle}
        <button
          type="button"
          className="traffic-action"
          data-run-action="edit"
          aria-expanded={setupOpen}
          aria-controls={setupId}
          onClick={toggleSetup}
        >
          {t('run.editCommands')}
        </button>
        {capture.capturing && !busy && (
          <button
            type="button"
            className="traffic-action"
            data-run-action="stop-recording"
            onClick={() => {
              act(window.chorus.stopRunRecording({ projectId }))
            }}
          >
            {t('run.stopRecording')}
          </button>
        )}
      </div>
    )

  /* Where to send the app, before there is anything to show — used whole-panel
   * before a capture and as the top half of the split while one is running. One
   * value rather than two copies, which would agree until one was edited. */
  const guidance = (
    <div className="traffic-empty">
      <p>
        {capture.address === null
          ? t('traffic.empty')
          : t('traffic.pointAt', { host: capture.address })}
      </p>
      <p>{capture.source.kind === 'off' ? t('traffic.noTerminal') : t('traffic.waiting')}</p>
    </div>
  )

  return (
    <section className="traffic-panel" aria-label={t('traffic.title')}>
      <header className="traffic-head">
        <span className="traffic-title">{t('traffic.title')}</span>
        <span className="traffic-count">
          {shown.length === stream.rows.length
            ? t('traffic.total', { total: stream.rows.length })
            : t('traffic.matching', { shown: shown.length, total: stream.rows.length })}
        </span>
        <span className="traffic-port">
          {capture.address === null
            ? t('traffic.notListening')
            : t('traffic.listeningOn', { host: capture.address })}
        </span>
        {managedRun === null && runControls}
      </header>
      {runToggle !== null && runHostElement !== null && createPortal(runToggle, runHostElement)}

      {run !== null && !run.available && <p className="run-unavailable">{t('run.unavailable')}</p>}

      {runRefused && <p className="traffic-stopped">{t('run.actionFailed')}</p>}

      {choiceRefused && (
        <p className="traffic-stopped" role="alert">
          {t('run.saveFailed')}
        </p>
      )}

      {cleanupShown && <p className="traffic-stopped">{t('run.cleanupPending')}</p>}

      {legacy !== null && !legacy.completed && (
        <div className="traffic-legacy">
          <p className="traffic-legacy-text">{t('traffic.legacyQuestion')}</p>
          <button
            type="button"
            className="traffic-action"
            onClick={() => {
              decide(true)
            }}
          >
            {t('traffic.legacyKeep')}
          </button>
          <button
            type="button"
            className="traffic-action"
            onClick={() => {
              decide(false)
            }}
          >
            {t('traffic.legacyFresh')}
          </button>
        </div>
      )}

      {stream.needsSnapshot && (
        <div className="traffic-legacy">
          <p className="traffic-legacy-text">{t('traffic.lagging')}</p>
          <button type="button" className="traffic-action" onClick={resume}>
            {t('traffic.resume')}
          </button>
        </div>
      )}

      <details className="traffic-setup" ref={captureSetup}>
        <summary className="traffic-setup-summary">{t('traffic.setup')}</summary>
        {managedRun !== null && <div className="traffic-source-row">{runControls}</div>}
        {managedRun !== null && setupOpen && (
          <section className="run-setup" id={setupId} aria-label={t('run.setupTitle')}>
            <p className="traffic-field-name">{t('run.scripts')}</p>
            {detected !== null && detected.scripts.length === 0 && (
              <p className="traffic-field-hint">{t('run.noScripts')}</p>
            )}
            <ul className="run-choices">
              {choices.map((choice) => (
                <li key={choice.id} className="run-choice" data-run-choice={choice.id}>
                  <label className="run-choice-pick">
                    <input
                      type="radio"
                      name={`${fields}-run-choice`}
                      checked={chosenCommand === choice.id}
                      disabled={!choice.fits}
                      onChange={() => {
                        applyChoice(choice)
                      }}
                    />
                    {choice.label}
                  </label>
                  <code className="run-command">{choice.command}</code>
                  {!choice.fits && (
                    <span className="traffic-field-hint">{t('run.scriptTooLong')}</span>
                  )}
                </li>
              ))}
            </ul>
            <div className="traffic-source-row">
              <div className="traffic-field" data-run-field="custom-label">
                <label className="traffic-field-name" htmlFor={`${fields}-run-label`}>
                  {t('run.customLabel')}
                </label>
                <input
                  id={`${fields}-run-label`}
                  className="traffic-origin"
                  type="text"
                  spellCheck={false}
                  value={customLabel}
                  onChange={(event) => {
                    setCustomLabel(event.target.value)
                  }}
                />
              </div>
              <div className="traffic-field" data-run-field="custom-command">
                <label className="traffic-field-name" htmlFor={`${fields}-run-command`}>
                  {t('run.customCommand')}
                </label>
                <input
                  id={`${fields}-run-command`}
                  className="traffic-origin"
                  type="text"
                  spellCheck={false}
                  value={customCommand}
                  onChange={(event) => {
                    setCustomCommand(event.target.value)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') addCustom()
                  }}
                />
              </div>
              <button
                type="button"
                className="traffic-action"
                data-run-action="add"
                onClick={addCustom}
              >
                {t('run.add')}
              </button>
            </div>
            <p className="traffic-field-hint">{t('run.captureHint')}</p>
            {capture.origin === null && (
              <div className="traffic-field" data-run-field="origin">
                <label className="traffic-field-name" htmlFor={`${fields}-run-origin`}>
                  {t('run.origin')}
                </label>
                <input
                  id={`${fields}-run-origin`}
                  className="traffic-origin"
                  type="text"
                  spellCheck={false}
                  placeholder={t('traffic.originPlaceholder')}
                  value={originDraft}
                  onChange={(event) => {
                    setOriginDraft(event.target.value)
                  }}
                  onBlur={commitSetupOrigin}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitSetupOrigin()
                  }}
                />
              </div>
            )}
            {capture.envVar === null && (
              <div className="traffic-field" data-run-field="variable">
                <label className="traffic-field-name" htmlFor={`${fields}-run-variable`}>
                  {t('run.variable')}
                </label>
                <input
                  id={`${fields}-run-variable`}
                  className="traffic-origin"
                  type="text"
                  spellCheck={false}
                  placeholder={t('traffic.envVarPlaceholder')}
                  value={envVarDraft}
                  onChange={(event) => {
                    variableEdited.current = true
                    setEnvVarDraft(event.target.value)
                  }}
                  onBlur={() => {
                    commitSetupVariable(envVarDraft)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitSetupVariable(envVarDraft)
                  }}
                />
                {detected !== null && detected.variables.length > 1 && (
                  <span className="run-variables">
                    <span className="traffic-field-hint">{t('run.variableChoices')}</span>
                    {detected.variables.map((name) => (
                      <button
                        key={name}
                        type="button"
                        className="traffic-tab"
                        data-run-variable={name}
                        onClick={() => {
                          variableEdited.current = true
                          setEnvVarDraft(name)
                          commitSetupVariable(name)
                        }}
                      >
                        {name}
                      </button>
                    ))}
                  </span>
                )}
              </div>
            )}
            {capture.capturing && <p className="traffic-field-hint">{t('run.whileRecording')}</p>}
            {setupError !== null && <p className="traffic-stopped">{t(setupError)}</p>}
          </section>
        )}
        {capture.address !== null && capture.forwardedDevices > 0 && (
          <div className="traffic-source-row">
            <span className="traffic-forwarded">
              {t('traffic.androidForwarded', { count: capture.forwardedDevices })}
            </span>
          </div>
        )}
        <div className="traffic-source-row">
          <div className="traffic-field" data-traffic-field="host">
            <label className="traffic-field-name" htmlFor={`${fields}-host`}>
              {t('traffic.hostField')}
            </label>
            <div className="traffic-env-row traffic-host-controls">
              <input
                id={`${fields}-host`}
                className="traffic-origin"
                type="text"
                spellCheck={false}
                maxLength={15}
                aria-describedby={`${fields}-host-hint`}
                aria-invalid={refusedField === 'host'}
                value={hostDraft}
                disabled={capture.access !== 'lan' || hostSaving || stream.projectId !== projectId}
                onChange={(event) => {
                  setHostDraft(event.target.value)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commitHost(hostDraft.trim() || null)
                }}
              />
              <button
                type="button"
                className="traffic-action"
                disabled={capture.access !== 'lan' || hostSaving || stream.projectId !== projectId}
                onClick={() => {
                  commitHost(hostDraft.trim() || null)
                }}
              >
                {t('traffic.applyHost')}
              </button>
              <button
                type="button"
                className="traffic-action"
                disabled={capture.access !== 'lan' || hostSaving || stream.projectId !== projectId}
                onClick={() => {
                  commitHost(null)
                }}
              >
                {t('traffic.detectHost')}
              </button>
            </div>
            <span
              className="traffic-field-hint"
              id={`${fields}-host-hint`}
              data-refused={refusedField === 'host' ? 'true' : 'false'}
            >
              {refusedField === 'host'
                ? t('traffic.hostInvalid')
                : capture.access === 'loopback'
                  ? t('traffic.accessLoopbackHint')
                  : t(capture.hostOverridden ? 'traffic.hostManualHint' : 'traffic.hostAutoHint')}
            </span>
            {addressChanged && (
              <div className="traffic-env-row traffic-host-controls" role="status">
                <span className="traffic-field-hint">{t('traffic.hostRestartHint')}</span>
                {managedRun?.process.kind === 'running' && (
                  <button
                    type="button"
                    className="traffic-action"
                    onClick={() => {
                      act(window.chorus.restartRun({ projectId }))
                    }}
                  >
                    {t('traffic.restartDev')}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        {/*
          A visible label tied to each field, and **the `aria-label` removed
          rather than kept beside it**. Both would leave two names for one
          input, and the `aria-label` is the one that wins — so a screen reader
          would announce something other than the words on the screen, which is
          worse than the unlabelled state this replaces. One name each, and the
          hints are descriptions through `aria-describedby`, not part of it.
        */}
        <div className="traffic-source-row">
          <div className="traffic-field" data-traffic-field="source">
            <label className="traffic-field-name" htmlFor={`${fields}-source`}>
              {t('traffic.source')}
            </label>
            <select
              id={`${fields}-source`}
              className="traffic-source"
              value={sourceValue(capture.source)}
              onChange={(event) => {
                choose(event.target.value)
              }}
            >
              <option value="">{t('traffic.none')}</option>
              {props.terminals.map((option) => (
                <option key={terminalRefKey(option.ref)} value={terminalRefKey(option.ref)}>
                  {option.label}
                </option>
              ))}
              <option value="logcat">{t('traffic.logcat')}</option>
            </select>
          </div>
          <div className="traffic-field" data-traffic-field="origin">
            <label className="traffic-field-name" htmlFor={`${fields}-origin`}>
              {t('traffic.origin')}
            </label>
            <input
              id={`${fields}-origin`}
              className="traffic-origin"
              type="text"
              spellCheck={false}
              aria-describedby={`${fields}-origin-hint`}
              placeholder={t('traffic.originPlaceholder')}
              value={originDraft}
              onChange={(event) => {
                setOriginDraft(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitOrigin()
              }}
              onBlur={commitOrigin}
            />
            <span
              className="traffic-field-hint"
              id={`${fields}-origin-hint`}
              data-refused={refusedField === 'origin' ? 'true' : 'false'}
            >
              {refusedField === 'origin' && failure !== null
                ? failureText(failure)
                : t('traffic.originHint')}
            </span>
          </div>
        </div>

        <div className="traffic-source-row">
          <div className="traffic-field" data-traffic-field="hiddenPathPrefix">
            <label className="traffic-field-name" htmlFor={`${fields}-hidden-path-prefix`}>
              {t('traffic.hiddenPathPrefix')}
            </label>
            <input
              id={`${fields}-hidden-path-prefix`}
              className="traffic-origin"
              type="text"
              spellCheck={false}
              aria-describedby={`${fields}-hidden-path-prefix-hint`}
              placeholder={t('traffic.hiddenPathPrefixPlaceholder')}
              value={hiddenPathPrefix}
              onChange={(event) => {
                setTrafficHiddenPathPrefix(projectId, event.target.value)
              }}
            />
            <span className="traffic-field-hint" id={`${fields}-hidden-path-prefix-hint`}>
              {t('traffic.hiddenPathPrefixHint')}
            </span>
          </div>
        </div>

        <div className="traffic-source-row">
          <div className="traffic-field" data-traffic-field="port">
            <label className="traffic-field-name" htmlFor={`${fields}-port`}>
              {t('traffic.portField')}
            </label>
            <input
              id={`${fields}-port`}
              className="traffic-origin"
              type="text"
              spellCheck={false}
              aria-describedby={`${fields}-port-hint`}
              placeholder={String(DEFAULT_TRAFFIC_PORT)}
              value={portDraft}
              onChange={(event) => {
                setPortDraft(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitPort()
              }}
              onBlur={commitPort}
            />
            <span
              className="traffic-field-hint"
              id={`${fields}-port-hint`}
              data-refused={refusedField === 'port' ? 'true' : 'false'}
            >
              {refusedField === 'port' && failure !== null
                ? failureText(failure)
                : t('traffic.portHint')}
            </span>
          </div>
          <div className="traffic-field" data-traffic-field="envVar">
            <label className="traffic-field-name" htmlFor={`${fields}-env`}>
              {t('traffic.envVarField')}
            </label>
            <input
              id={`${fields}-env`}
              className="traffic-origin"
              type="text"
              spellCheck={false}
              aria-describedby={`${fields}-env-hint`}
              placeholder={t('traffic.envVarPlaceholder')}
              value={envVarDraft}
              onChange={(event) => {
                setEnvVarDraft(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitEnvVar()
              }}
              onBlur={commitEnvVar}
            />
            <span className="traffic-field-hint" id={`${fields}-env-hint`}>
              {t('traffic.envVarHint')}
            </span>
          </div>
        </div>

        {/*
          On its own row rather than paired, unlike the four above it: the hint
          is the only one in this block that describes a consequence rather than
          a setting, and it swaps with the choice. Two columns would have broken
          it mid-sentence at 300px.
        */}
        <div className="traffic-source-row">
          <div className="traffic-field" data-traffic-field="access">
            <label className="traffic-field-name" htmlFor={`${fields}-access`}>
              {t('traffic.access')}
            </label>
            <select
              id={`${fields}-access`}
              className="traffic-source"
              aria-describedby={`${fields}-access-hint`}
              value={capture.access}
              onChange={(event) => {
                chooseAccess(event.target.value)
              }}
            >
              <option value="loopback">{t('traffic.accessLoopback')}</option>
              <option value="lan">{t('traffic.accessLan')}</option>
            </select>
            <span className="traffic-field-hint" id={`${fields}-access-hint`}>
              {capture.access === 'lan'
                ? t('traffic.accessLanHint')
                : t('traffic.accessLoopbackHint')}
            </span>
          </div>
        </div>

        {envLine !== null && (
          <div className="traffic-env-row">
            <code className="traffic-env">{envLine}</code>
            <button
              type="button"
              className="traffic-tab"
              onClick={() => {
                copy(envLine)
              }}
            >
              {t('traffic.copy')}
            </button>
          </div>
        )}

        {capture.source.kind === 'logcat' && (
          <div className="traffic-source-row">
            <div className="traffic-field" data-traffic-field="filters">
              <label className="traffic-field-name" htmlFor={`${fields}-filters`}>
                {t('traffic.filters')}
              </label>
              <input
                id={`${fields}-filters`}
                className="traffic-origin"
                type="text"
                spellCheck={false}
                placeholder={t('traffic.filtersPlaceholder')}
                value={filters}
                onChange={(event) => {
                  setFilters(event.target.value)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commitFilters()
                }}
                onBlur={commitFilters}
              />
            </div>
          </div>
        )}
      </details>

      <div className="traffic-source-row">
        <span className="traffic-find-box">
          <input
            className="traffic-find"
            type="text"
            spellCheck={false}
            aria-label={t('traffic.search')}
            placeholder={t('traffic.searchPlaceholder')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
            }}
            onKeyDown={(event) => {
              /*
               * The one thing `type="search"` would have given that is worth
               * having, for a line. The native control it would also have given
               * was declined — see `.traffic-find-clear`.
               */
              if (event.key === 'Escape' && search !== '') setSearch('')
            }}
          />
          {/*
            Only while there is something to clear. A control that is always
            there and sometimes greyed is how this started: the button beside the
            field was `disabled` whenever the field was empty, so pressing it did
            nothing at all and it read as broken.
          */}
          {search !== '' && (
            <button
              type="button"
              className="traffic-find-clear"
              data-traffic-clear="search"
              aria-label={t('traffic.clearSearch')}
              onClick={() => {
                setSearch('')
              }}
            >
              ×
            </button>
          )}
        </span>
        <select
          className="traffic-action"
          aria-label={t('traffic.callLimit')}
          value={callLimit}
          onChange={(event) => {
            setCallLimit(Number(event.target.value))
          }}
        >
          {CALL_LIMITS.map((limit) => (
            <option key={limit} value={limit}>
              {t('traffic.lastCalls', { limit })}
            </option>
          ))}
        </select>
        {/*
          The capture's Clear, out of the header and down beside the field.

          It was beside Start/Stop, six pixels from a control that stops the
          capture rather than emptying it — and it began this whole thread by
          sharing the word "Clear" with the search button that used to sit here,
          which the person pressed expecting the rows to go. Two controls in one
          row still clear different things, so what separates them is position
          (the X is inside the field, this is outside it) and a name that says
          which: the visible word is the same "Clear", and the title and the
          accessible name both say what it clears.
        */}
        <button
          type="button"
          className="traffic-action"
          data-traffic-clear="captured"
          title={t('traffic.clearCaptured')}
          aria-label={t('traffic.clearCaptured')}
          onClick={clearCaptured}
        >
          {t('traffic.clear')}
        </button>
      </div>

      {failure !== null && refusedField === null && (
        <p className="traffic-stopped">{failureText(failure)}</p>
      )}

      {/*
        **The split is drawn from the moment a capture starts, not from the
        moment a row arrives.**

        It used to appear only once there were rows *and* something selected, so
        a started capture opened on a table with no detail region and jumped to
        its share of the panel on the first click. The region is now always
        there, with its own empty state.

        Before a capture the guidance still takes the whole panel. Rendering the
        split around it would put a seventy-percent box under a sentence about
        pointing an app at an address, which is a worse trade than the jump it
        would avoid — and there is no jump there, because there is nothing yet
        to jump to.
      */}
      {stream.rows.length === 0 && !capture.capturing ? (
        guidance
      ) : (
        <div className="traffic-split">
          <div className="traffic-list">
            {stream.rows.length === 0 ? (
              guidance
            ) : filtered.length === 0 ? (
              <p className="traffic-stopped">{t('traffic.noMatches')}</p>
            ) : (
              <ul className="traffic-rows" ref={rowsList} onKeyDown={onRowKeyDown}>
                {/*
                The header is a grid item of the list, not a block above it.

                It adopts the same `subgrid` tracks every row does, which is the
                only reason its columns line up with theirs — a header outside this
                element would be laid out against the panel's width and drift from
                the rows the moment a column changed size. `sticky` keeps it there
                while the list scrolls; without that it is visible only to somebody
                who has not scrolled yet, which is nobody who needs it.

                No column roles. The rows are buttons wrapping five cells, and a
                `row` may only contain `cell`s — so marking this up as a table
                would mean rebuilding focus and selection on `<tr>`, which is the
                trade this layout was chosen to avoid. The labels are ordinary
                text, and the first list item a screen reader meets.
              */}
                <li className="traffic-head-row">
                  <span className="traffic-head-cell">{t('traffic.columnMethod')}</span>
                  <span className="traffic-head-cell">{t('traffic.columnStatus')}</span>
                  <span className="traffic-head-cell">{t('traffic.columnEndpoint')}</span>
                </li>
                {shown.map((row) => (
                  <li
                    className={
                      row.seq === selectedSeq ? 'traffic-row traffic-row--selected' : 'traffic-row'
                    }
                    key={row.seq}
                    data-source={row.source}
                  >
                    {row.source === 'http' ? (
                      <button
                        type="button"
                        className="traffic-row-button"
                        aria-pressed={row.seq === selectedSeq}
                        /* What the arrow walk selects by: the button is the row's box, so it is the row. */
                        data-seq={row.seq}
                        /*
                         * On the row rather than on the status cell, so the endpoint
                         * can read the same signal the status is coloured by. See
                         * the rule in `styles.css`.
                         */
                        data-class={statusClassOf(row)}
                        onClick={() => {
                          setSelectedSeq(row.seq)
                        }}
                      >
                        {bodyOf(row)}
                      </button>
                    ) : (
                      bodyOf(row)
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {selected !== null ? (
            <TrafficRequestInspector
              key={`${stream.captureId}:${selected.requestId}`}
              projectId={projectId}
              subscriptionId={stream.subscriptionId}
              captureId={stream.captureId}
              row={selected}
            />
          ) : (
            <section
              className="traffic-inspector traffic-inspector--empty"
              aria-label={t('traffic.detailTitle')}
            >
              <p className="traffic-stopped">{t('traffic.noSelection')}</p>
            </section>
          )}
        </div>
      )}
    </section>
  )
}
