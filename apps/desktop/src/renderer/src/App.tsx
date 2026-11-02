import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ErrorNotice } from './ErrorNotice.js'
import { ToastStack } from './ToastStack.js'
import { useTranslation } from 'react-i18next'
import type { AgentProbeResult, IpcRequest, IpcResponse } from '../../shared/ipc.js'
import type { WindowRole } from '../../shared/detached-window-ipc.js'
import { ChorusLogo } from './ChorusLogo.js'
import { LogViewer } from './LogViewer.js'
import { fail, type SessionCarry, type SessionInfo } from './Session.js'
import { holdShellCloses } from './project-shell-closes.js'
import { SessionHost } from './SessionHost.js'
import { useConversationStarts } from './useConversationStarts.js'
import { trimCarry } from './carry.js'
import { EMPTY_VIEW } from './transcript.js'
import { roomsWaiting, trackPending } from './notify.js'
import { addToast, NOTICE_KEY, pruneToasts } from './toasts.js'
import { HistoryPanel } from './HistoryPanel.js'
import { RemoteProjectDialog } from './workspace/RemoteProjectDialog.js'
import { INSTALL, Settings, type Defaults } from './Settings.js'
import { Workspace } from './workspace/Workspace.js'
import { DetachedStage } from './workspace/DetachedStage.js'
import { GlobalNotes } from './GlobalNotes.js'
import { KeptNotes } from './KeptNotes.js'
import type { NoteSize } from './noteSize.js'
import { ConfirmEndSession } from './ConfirmEndSession.js'
import {
  pulseWorking,
  sameWorkspaceSnapshot,
  useWorkspaceStore,
  workspaceSnapshot,
} from './workspace/store.js'
import {
  applyDetachedEntries,
  detachTab,
  detachedSnapshot,
  mergeSlice,
  onScreenConversations,
  returnTab,
  sliceOf,
  virtualIndex,
  withDetachedReturned,
} from './workspace/layout.js'
import { measureTabGeometry, resolveTarget } from './workspace/useTabDrag.js'
import { reorderSessions } from './workspace/session-row.js'
import { useShellOverlay } from './workspace/overlay.js'
import { NOTE_SIZE } from '../../shared/workspace-layout.js'
import { setRunningPlatform } from './shortcuts.js'

/**
 * How long to sit on read-watermarks before writing them down.
 *
 * `open-sessions.json` is rewritten whole on every `markSeen`, and a streaming
 * turn would otherwise trigger one per push. A second of lag costs nothing: the
 * worst case is a card that says one unread instead of none.
 */
const SEEN_DEBOUNCE_MS = 1_000

export function App({ role }: { readonly role: WindowRole }): React.JSX.Element {
  const { t } = useTranslation()
  const [appVersion, setAppVersion] = useState<string | null>(null)
  /** Where "no folder" resolves to, so a card can say which it is looking at. */
  const [home, setHome] = useState('')
  const [probes, setProbes] = useState<AgentProbeResult[] | null>(null)
  const [profiles, setProfiles] = useState<{ id: string; name: string; summary: string }[]>([])
  /** The registry, most recently opened first — the order the rail draws in. */
  const [projects, setProjects] = useState<IpcResponse<'project:list'>['projects']>([])
  /**
   * The note that belongs to no project, and how wide it was last dragged.
   *
   * Held here rather than in the workspace store, and the two are different
   * kinds of thing: the store holds the arrangement, which is written to a
   * snapshot file on every change, while this is one row in the database read
   * once at start. It is also read by exactly one component, so a store slice
   * would be reach without a second reader to justify it.
   *
   * **Null until the row has been read, and the note is not mounted before
   * that.** The editor seeds its document once, from the value it is handed at
   * mount. Rendering it against a placeholder and letting the real note arrive a
   * moment later would mean either ignoring what was read — the note appears
   * empty forever, which is what happened — or writing into a document somebody
   * may already be typing in. Waiting for the read costs one IPC and removes the
   * choice.
   */
  const [appNote, setAppNote] = useState<IpcResponse<'app:getNote'> | null>(null)
  const [defaults, setDefaults] = useState<Defaults>({
    /* Matches the main process's default, and has to keep matching it: this
       stands only until `readSettings` answers, but a session started inside
       that window opens with whatever is written here. The cast used to be part
       of it and is not a default any more — main seats every agent. */
    cwd: '',
    profileId: 'read-only',
  })
  /**
   * Whether `readSettings` has answered yet.
   *
   * Not "did it succeed" — only that the question has been asked and returned,
   * so the auto-start effect below knows `defaults` is as good as it is going
   * to get. Without this the first session of a launch could be created from
   * the placeholder above, which is the home-directory bug.
   */
  const [settingsRead, setSettingsRead] = useState(false)
  /**
   * The language explanations come back in, or empty when none is set.
   *
   * Held here rather than in each pane because it decides whether a button
   * exists under every reply, so a pane cannot wait for a selection to learn it.
   * Read on mount and again whenever the settings sheet closes — the sheet is
   * the only place it can change from inside the app, and `readSettings` is a
   * file read, so re-reading on a dialog close costs nothing worth measuring.
   *
   * Kept out of `defaults`, which is what a *new session* opens with. This is
   * about every session already open.
   */
  const [explainLanguage, setExplainLanguage] = useState('')
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const sessionsRef = useRef<SessionInfo[]>([])
  const sessionsRevision = useRef(0)
  /** So the opening session of a launch is opened once, and only on a launch. */
  const autoStarted = useRef(false)
  const carries = useRef(new Map<string, SessionCarry>())
  const closingChats = useRef(new Map<string, Promise<void>>())
  const closingProjects = useRef(new Map<string, Promise<void>>())
  const closingWindows = useRef(new Map<string, Promise<void>>())
  const retainedCloseIds = useRef(new Set<string>())
  const closingProjectIds = useRef(new Set<string>())
  const projectCloseVersions = useRef(new Map<string, number>())
  const [stoppingChats, setStoppingChats] = useState<readonly string[]>([])
  const [stoppingProjects, setStoppingProjects] = useState<readonly string[]>([])
  const stopping = stoppingChats.length > 0 || stoppingProjects.length > 0
  // Native editor views otherwise cover the floating close-pending message.
  useShellOverlay(stopping)
  /**
   * A way to read each mounted session's draft, lent by the session itself.
   *
   * A ref rather than state: nothing here renders, and the map changes whenever
   * a tab mounts. It is read once, when somebody asks to end a room.
   */
  const draftReaders = useRef(new Map<string, () => string>())
  /** The room somebody asked to end, and what ending it would throw away. */
  const [confirmingEnd, setConfirmingEnd] = useState<{
    readonly target: { kind: 'conversation'; id: string } | { kind: 'project'; id: string }
    readonly working: readonly string[]
    readonly decisions: number
    readonly draft: boolean
  } | null>(null)
  /**
   * Unanswered approvals and questions per conversation, for the dock badge.
   *
   * A ref rather than state: nothing renders from it, and holding it outside the
   * subscription means a language change re-subscribing cannot reset the count.
   */
  const pending = useRef<Readonly<Record<string, readonly string[]>>>({})
  /**
   * How far each on-screen conversation has been read, waiting to be written down.
   *
   * Batched rather than sent per push: a streaming turn produces many, the file
   * behind it is rewritten whole on every call, and being a second behind costs
   * nothing — the worst case is a card that says one unread instead of none.
   */
  const seen = useRef<Readonly<Record<string, number>>>({})
  const seenTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const detachedVisibility = useRef(
    new Map<
      string,
      { readonly focused: boolean; readonly visibleConversationIds: readonly string[] }
    >()
  )
  const closedIds = useRef(new Set<string>())
  const pendingRestarts = useRef<{
    readonly cancelRestartOf: (source: string) => Promise<void>
    readonly holdRestarts: (projectId: string) => Promise<() => void>
  }>({
    cancelRestartOf: () => Promise.resolve(),
    holdRestarts: () => Promise.resolve(() => undefined),
  })
  const [showingLogs, setShowingLogs] = useState(false)
  const [showingSettings, setShowingSettings] = useState(false)
  const [showingHistory, setShowingHistory] = useState(false)
  const [addingRemoteProject, setAddingRemoteProject] = useState(false)
  const [restoring, setRestoring] = useState(true)
  const [restored, setRestored] = useState(false)
  const [zoom, setZoom] = useState<number | null>(null)

  /*
   * What the detached windows say they are showing, and only while one of them
   * has focus — a window behind another is not where anybody is reading.
   *
   * One derivation because two effects ask the same question: the unread fold
   * and the notice gate both need to know that a conversation being read in a
   * detached window is being read. Written twice, they would be the drift the
   * `onScreenConversations` parameter exists to prevent, one level up.
   */
  const detachedShown = useCallback(
    (): readonly string[] =>
      [...detachedVisibility.current.values()]
        .filter((visibility) => visibility.focused)
        .flatMap((visibility) => visibility.visibleConversationIds),
    []
  )

  const markSeenSoon = useCallback(() => {
    clearTimeout(seenTimer.current)
    seenTimer.current = setTimeout(() => {
      const batch = seen.current
      seen.current = {}
      for (const [conversationId, seq] of Object.entries(batch)) {
        // Fire and forget: the runtime ignores a watermark that moves backwards,
        // and a lost one costs a card that overstates by one after the next launch.
        void window.chorus.markSeen({ conversationId, seq })
      }
    }, SEEN_DEBOUNCE_MS)
  }, [])

  useEffect(
    () => () => {
      clearTimeout(seenTimer.current)
    },
    []
  )

  const updateSessions = useCallback((change: (current: SessionInfo[]) => SessionInfo[]) => {
    const next = change(sessionsRef.current)
    sessionsRef.current = next
    sessionsRevision.current += 1
    setSessions(next)
  }, [])

  /**
   * Puts a conversation from the history list on screen.
   *
   * One that is already open only needs focusing — reopening it would ask the
   * runtime to start a second set of agents for a room that already has them.
   * Anything else comes back through the runtime, which starts its agents and
   * hands them the transcript as catch-up.
   */
  const openFromHistory = useCallback(
    async (conversationId: string) => {
      closedIds.current.delete(conversationId)
      const already = sessionsRef.current.find(
        (session) => session.conversationId === conversationId
      )
      if (already !== undefined) {
        useWorkspaceStore.getState().openProject(already.projectId)
        useWorkspaceStore.getState().clearConversationUnread(conversationId)
        return
      }
      const reopened = await window.chorus.reopenConversation({ conversationId })
      updateSessions((current) => [...current, reopened])
      useWorkspaceStore.getState().openProject(reopened.projectId)
      useWorkspaceStore.getState().adoptConversation(reopened.projectId, reopened.conversationId)
      useWorkspaceStore.getState().clearConversationUnread(reopened.conversationId)
      /*
       * After the unread clear, not before: one is about what was missed and
       * the other about what is still outstanding, and a room reopened from
       * history can easily be caught up and blocked at the same time.
       */
      useWorkspaceStore.getState().seedPendingDecisions(reopened.conversationId, {
        approvalIds: reopened.pendingApprovalIds,
        questionIds: reopened.pendingQuestionIds,
      })
    },
    [updateSessions]
  )

  /*
   * Status is global and deliberately tiny. Active Session components still
   * reduce full transcripts; this listener lets closed/background tabs say an
   * agent is working or waiting without keeping markdown trees mounted.
   */
  useEffect(
    () =>
      window.chorus.onEvents((events) => {
        useWorkspaceStore.getState().ingestEvents(events, detachedShown())
        pruneToasts(events)
      }),
    [detachedShown]
  )

  /*
   * A rename the shell did not ask for.
   *
   * Renaming used to be something only a person did here, so the tab was updated
   * by the same call that requested it and nothing listened. The topic namer
   * renames from main, on its own schedule, and a tab that only learns about
   * renames it initiated would keep showing the old name until relaunch.
   *
   * The log is the channel, and no new one was needed: `conversation.renamed` is
   * appended like anything else and forwarded to every window unfiltered. It is
   * marked `ignore` for the *transcript*, which is a statement about drawing it
   * as an entry — not about whether it arrives.
   *
   * The last rename in a batch wins, because they are ordered and an older one
   * is a name that has already been superseded.
   */
  useEffect(
    () =>
      window.chorus.onEvents((events) => {
        const renames = events.filter((event) => event.type === 'conversation.renamed')
        if (renames.length === 0) return
        updateSessions((current) =>
          current.map((session) => {
            const latest = renames
              .filter((event) => event.conversationId === session.conversationId)
              .at(-1)
            const title = latest?.payload['title']
            return typeof title === 'string' ? { ...session, title } : session
          })
        )
      }),
    [updateSessions]
  )

  /*
   * The dock badge.
   *
   * Beside the other global listeners, and for the same reason: this has to work
   * for conversations whose `Session` is not mounted, which is most of them once
   * more than four are open.
   */
  useEffect(
    () =>
      window.chorus.onEvents((events) => {
        if (role.kind === 'detached') return
        pending.current = trackPending(pending.current, events)
        void window.chorus.setBadge({ count: roomsWaiting(pending.current) })

        /*
         * Read through the one helper rather than off `panes` — which is where
         * this went wrong. `panes[i].activeTabId` names a *project*, so the ids
         * this collected were projects wearing a conversation's name, and the
         * watermark below was answering about a conversation id that could
         * never appear.
         */
        const detached = detachedShown()
        const visibleConversationIds = [
          ...onScreenConversations(useWorkspaceStore.getState(), detached),
        ]

        /*
         * Record how far each visible card has been read, so the next launch can
         * count what was missed rather than claiming nothing happened.
         *
         * The sequence comes from the batch, not from the store: two subscribers
         * read the same push and their order is undefined, so the pulse may not
         * have folded these events yet. What is in hand cannot be stale.
         */
        for (const id of visibleConversationIds) {
          const highest = events.reduce(
            (best, event) => (event.conversationId === id && event.seq > best ? event.seq : best),
            0
          )
          if (highest > (seen.current[id] ?? 0)) {
            seen.current = { ...seen.current, [id]: highest }
          }
        }
        markSeenSoon()
      }),
    [markSeenSoon, detachedShown, role.kind]
  )

  useEffect(
    () =>
      window.chorus.onAttention((attention) => {
        if (attention.mode === 'banner') {
          if (role.kind === 'detached') return
          void window.chorus.notify({
            title: t(NOTICE_KEY[attention.reason], { agent: attention.agentId }),
            body: attention.title,
            projectId: attention.projectId,
          })
          return
        }
        const showing = onScreenConversations(useWorkspaceStore.getState())
        if (showing.has(attention.conversationId)) return
        addToast(attention)
      }),
    [t, role.kind]
  )

  useEffect(
    () =>
      window.chorus.onRevealConversation(({ projectId, conversationId }) => {
        if (role.kind === 'main') useWorkspaceStore.getState().openProject(projectId)
        useWorkspaceStore.getState().adoptConversation(projectId, conversationId)
        useWorkspaceStore.getState().showConversation(projectId, conversationId)
      }),
    [role.kind]
  )

  /*
   * Context fill, on its own channel because it is not a logged event.
   *
   * Subscribed here beside the event listener for the same reason: it has to
   * reach cards whose `Session` is not mounted, and this is the one place that
   * is always listening.
   */
  useEffect(
    () =>
      window.chorus.onContextUsage((usage) => {
        useWorkspaceStore.getState().ingestContextUsage(usage)
      }),
    []
  )

  /*
   * The editor's context, on the same footing and for the same reason — Phase 6.
   *
   * It was a listener inside `Session`, and only the active tab of each group is
   * mounted: a push for a conversation in a background tab reached nothing, and
   * switching back re-created the component with both slots empty. Nothing put
   * it back, because main replays on runtime events and not on a React component
   * mounting — so the composer's `ideAttached` was false for a reason that had
   * nothing to do with the editor.
   *
   * Context is state, not history. It belongs where the pulse lives.
   */
  useEffect(
    () =>
      window.chorus.onIdeContext((push) => {
        useWorkspaceStore.getState().ingestIdeContext(push)
      }),
    []
  )

  /* What each agent left running, on its own channel and for the same reason. */
  useEffect(
    () =>
      window.chorus.onTasks((push) => {
        useWorkspaceStore.getState().ingestTasks(push)
      }),
    []
  )

  /*
   * What each agent says it is doing, on its own channel for the same reason
   * again — and this one is the reason the family exists. It arrives many times
   * a turn, which is exactly what must never be written to the log.
   */
  useEffect(
    () =>
      window.chorus.onActivity((push) => {
        useWorkspaceStore.getState().ingestActivity(push)
      }),
    []
  )

  const persistLayout = useCallback(
    (request: IpcRequest<'conversation:layout'>): Promise<unknown> =>
      role.kind === 'detached'
        ? Promise.resolve()
        : window.chorus.writeConversationLayout({
            ...request,
            workspace: withDetachedReturned(
              request.workspace,
              useWorkspaceStore.getState().detached
            ),
          }),
    [role.kind]
  )

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    /*
     * The hydration itself is not a rearrangement, and echoing it back to disk
     * is actively destructive.
     *
     * `hydrate` flips `hydrated` false→true, which the selector below counts as
     * a change, so the very first emission is the store repeating what was just
     * read. On a *first* run that is worse than redundant: the file's `null`
     * workspace is what tells `reconcileWorkspace` "this predates the shell,
     * open everything", and overwriting it with the seeded empty snapshot
     * relabels it "the user closed every tab". That write also lands before the
     * auto-started session has opened its pane, so the next launch restores a
     * running session into an empty editor and the force-open path can never
     * fire again.
     *
     * Only what happens after the seed is the user's doing.
     */
    let seeded = false
    const stop = useWorkspaceStore.subscribe(
      (state) => ({ ...workspaceSnapshot(state), hydrated: state.hydrated }),
      (next) => {
        if (!next.hydrated) return
        if (!seeded) {
          seeded = true
          return
        }
        clearTimeout(timer)
        timer = setTimeout(() => {
          persistLayout({
            order: sessionsRef.current.map((session) => session.conversationId),
            /*
             * Taken from the snapshot function, not typed out field by field.
             *
             * It *was* typed out, and that is the same defect the equality
             * comment below records from the other side: a field added to
             * `WorkspaceSnapshot` and forgotten here is silently never
             * persisted. Reading it through `workspaceSnapshot` means adding a
             * field cannot be forgotten, because there is nothing to remember.
             *
             * Current state rather than the `next` that triggered this: the
             * write is 180ms debounced, so `next` is by then one of several
             * changes that have happened, and the last one is the one worth
             * saving. The other two write paths — `reorder` and `commitLayout`
             * — already send the whole current snapshot for the same reason.
             */
            workspace: workspaceSnapshot(useWorkspaceStore.getState()),
          }).catch(fail(setError))
        }, 180)
      },
      {
        /*
         * Compare every field the write above sends, not a list of them.
         *
         * This was six fields typed out by hand, and it silently stopped
         * matching what `workspaceSnapshot` carries: `terminals` and
         * `globalTerminal` were never added, so opening or resizing a terminal
         * panel compared *equal* and was never written. `sameWorkspaceSnapshot`
         * reads its keys off the schema, so the next field is covered by
         * construction. `hydrated` stays explicit because it is not part of the
         * snapshot — it is the guard that stops hydration echoing back to disk.
         */
        equalityFn: (left, right) =>
          left.hydrated === right.hydrated && sameWorkspaceSnapshot(left, right),
      }
    )
    return () => {
      clearTimeout(timer)
      stop()
    }
  }, [persistLayout])

  useEffect(() => {
    if (role.kind !== 'detached') return undefined
    const projectId = role.projectId
    let seeded = false
    return useWorkspaceStore.subscribe(
      (state) => ({ slice: sliceOf(state, projectId), hydrated: state.hydrated }),
      (next) => {
        if (!next.hydrated) return
        if (!seeded) {
          seeded = true
          return
        }
        window.chorus.sendProjectSlice({ projectId, slice: next.slice }).catch(fail(setError))
      },
      {
        equalityFn: (left, right) =>
          left.hydrated === right.hydrated &&
          JSON.stringify(left.slice) === JSON.stringify(right.slice),
      }
    )
  }, [role])

  useEffect(() => {
    if (role.kind !== 'detached') return undefined
    const projectId = role.projectId
    const report = (): void => {
      const arrangement = useWorkspaceStore.getState().conversationGroups[projectId]
      const visibleConversationIds = Object.values(arrangement?.panes ?? {})
        .map((pane) => pane.activeTabId)
        .filter((id): id is string => id !== null)
      window.chorus
        .sendProjectVisibility({ projectId, focused: document.hasFocus(), visibleConversationIds })
        .catch(fail(setError))
    }
    report()
    window.addEventListener('focus', report)
    window.addEventListener('blur', report)
    const stop = useWorkspaceStore.subscribe((state) => state.conversationGroups[projectId], report)
    return () => {
      window.removeEventListener('focus', report)
      window.removeEventListener('blur', report)
      stop()
    }
  }, [role])

  useEffect(() => {
    if (role.kind !== 'detached') return undefined
    const projectId = role.projectId
    return window.chorus.onFlushRequest(({ requestId }) => {
      let release = (): void => undefined
      let releaseRestarts = (): void => undefined
      pendingRestarts.current
        .holdRestarts(projectId)
        .then((held) => {
          releaseRestarts = held
        }, fail(setError))
        .then(() =>
          Promise.all(
            [...draftReaders.current].map(([conversationId, read]) =>
              window.chorus.rememberDraft({ conversationId, draft: read() })
            )
          )
        )
        .then(async () => {
          release = await holdShellCloses(projectId)
          return window.chorus.sendFlushResult({
            requestId,
            slice: sliceOf(useWorkspaceStore.getState(), projectId),
          })
        })
        .finally(() => {
          release()
          releaseRestarts()
        })
        .catch(fail(setError))
    })
  }, [role])

  useEffect(() => {
    window.chorus
      .getAppInfo()
      .then(({ appVersion: version, home: where, platform }) => {
        setAppVersion(version)
        setHome(where)
        // Held at module scope in `shortcuts.ts` rather than in state: the
        // keyboard handlers read it at event time, and Workspace's listener
        // effect is deliberately `[]` so a prop would be captured stale.
        setRunningPlatform(platform)
      })
      .catch(() => {
        setAppVersion(null)
      })
    /*
     * One listener for the app, writing into the store — Phase 6.
     *
     * It was a listener per `Session`, and only the active tab of each group is
     * mounted: a push for a conversation whose tab was in the background reached
     * nothing, and switching back re-created the component with empty state. The
     * editor context is state rather than an event, so it belongs where the
     * pulse does — outside the component that draws it.
     */
    window.chorus.probeAgents().then(setProbes).catch(fail(setError))
    window.chorus.profiles().then(setProfiles).catch(fail(setError))
    // Read once and kept in state after that. The only writer is the panel this
    // feeds, so there is nothing to re-read from and no second view to drift.
    window.chorus.getAppNote({}).then(setAppNote).catch(fail(setError))
    window.chorus
      .listProjects({})
      .then(({ projects: listed }) => {
        setProjects(listed)
      })
      .catch(fail(setError))
    window.chorus
      .readSettings()
      .then(({ cwd, profileId, explainLanguage: language }) => {
        setDefaults({ cwd, profileId })
        setExplainLanguage(language)
      })
      .catch(fail(setError))
      /*
       * Answered, whether or not it answered well.
       *
       * The auto-start effect waits on this, so it has to be set on the failure
       * path too — a settings file that cannot be read must still leave the app
       * able to open a session, just with the built-in defaults.
       */
      .finally(() => {
        setSettingsRead(true)
      })

    /*
     * The visual grace may expire, but a new session still waits for the real
     * restore result. That distinction prevents one slow provider from creating
     * another duplicate session on every launch.
     */
    const grace = setTimeout(() => {
      setRestoring(false)
    }, 1_500)
    const reopen: Promise<IpcResponse<'conversation:restore'>> =
      role.kind === 'detached'
        ? window.chorus.readDetachedBootstrap().then(({ projectId, slice, conversations }) => ({
            sessions: conversations,
            workspace: detachedSnapshot(projectId, slice),
          }))
        : Promise.all([
            window.chorus.restoreConversations(),
            window.chorus.readDetachedState(),
          ]).then(([restored, { entries }]) => {
            useWorkspaceStore
              .getState()
              .setDetached(
                Object.fromEntries(entries.map((entry) => [entry.projectId, entry.returnSlot]))
              )
            return {
              ...restored,
              workspace:
                restored.workspace === null
                  ? null
                  : applyDetachedEntries(restored.workspace, entries),
            }
          })
    reopen
      .then(({ sessions: reopened, workspace }) => {
        /*
         * Merged out here, and the store written after — C-048.
         *
         * This whole block used to sit inside `updateSessions`, which passes its
         * argument to `setSessions` as an **updater**. React invokes an updater
         * during the render phase, so every store write in here was a write
         * while `App` was rendering, and `EditorPane` subscribes to that store:
         * "Cannot update a component (EditorPane) while rendering a different
         * component (App)", once, at boot.
         *
         * The board had cleared `hydrate` on the grounds that it is "inside a
         * promise rather than render". It is inside a promise — the promise
         * merely *calls* `updateSessions`, and the body runs later, when React
         * gets to it. That is the gap the entry was missing.
         *
         * `sessionsRef.current` is what the updater's `current` would have been:
         * `updateSessions` keeps it in step on every write, and restore happens
         * once at boot with nothing else racing it.
         */
        const current = sessionsRef.current
        {
          const merged = [
            ...reopened.filter(
              (candidate) =>
                !current.some((session) => session.conversationId === candidate.conversationId)
            ),
            ...current,
          ]
          /*
           * A draft typed before the last quit.
           *
           * Seeded into the carry rather than passed to the pane directly,
           * because the carry is already the one path a draft travels — the
           * composer reads it there whether it came from a backgrounded tab or
           * from disk.
           */
          for (const session of reopened) {
            if (session.draft === '') continue
            const held = carries.current.get(session.conversationId)
            carries.current.set(session.conversationId, {
              view: held?.view ?? EMPTY_VIEW,
              draft: session.draft,
              attached: held?.attached ?? [],
              following: held?.following ?? true,
              scrollTop: held?.scrollTop ?? 0,
            })
          }
          useWorkspaceStore.getState().hydrate(
            workspace,
            merged.map((session) => session.conversationId),
            [...new Set(merged.map((session) => session.projectId))],
            // Counted by the main process out of the log, against the watermark
            // saved when each card was last on screen.
            Object.fromEntries(reopened.map((session) => [session.conversationId, session.unread])),
            /*
             * Which conversations each project holds. The two flat lists above
             * cannot express it, and the inner columns are built from exactly
             * this — a project missing here has its arrangement dropped rather
             * than kept pointing at conversations nobody is running.
             */
            merged.reduce<Record<string, string[]>>((byProject, session) => {
              ;(byProject[session.projectId] ??= []).push(session.conversationId)
              return byProject
            }, {}),
            /*
             * What is still waiting to be answered, so a tab's mark says so from
             * the first frame. Only `reopened` carries it — a session already in
             * `current` has been folding its own events all along.
             */
            Object.fromEntries(
              reopened.map((session) => [
                session.conversationId,
                {
                  approvalIds: session.pendingApprovalIds,
                  questionIds: session.pendingQuestionIds,
                },
              ])
            )
          )
          /*
           * Plan mode, seeded after the hydrate that clears it.
           *
           * It used to live inside the toggle that set it, so nothing outside
           * that one control could say whether a session was reading-only. The
           * preview says it now, and the runtime is the only thing that knows —
           * the mode belongs to a running agent, not to a saved file.
           */
          for (const session of reopened) {
            if (session.planning) {
              useWorkspaceStore.getState().setPlanning(session.conversationId, true)
            }
          }
          /*
           * Last, and not through an updater. Everything above has already been
           * decided from `current`, so this is a plain assignment of a value
           * rather than a function React may call whenever it likes.
           */
          updateSessions(() => merged)
        }
      })
      .catch(fail(setError))
      .finally(() => {
        clearTimeout(grace)
        setRestoring(false)
        setRestored(true)
      })
    return () => {
      clearTimeout(grace)
    }
  }, [updateSessions, role.kind])

  const remember = useCallback((patch: Partial<Defaults>) => {
    setDefaults((current) => ({ ...current, ...patch }))
    window.chorus.writeSettings(patch).catch(fail(setError))
  }, [])

  /*
   * The one setting a pane draws continuously, kept current from anywhere.
   *
   * Main echoes every write to every window, so this covers the sheet, a second
   * window and anything writing through the channel directly. `closeSettings`
   * below still re-reads: a push can only report a write that happened, and a
   * sheet closed without one should still leave this holding the truth.
   */
  useEffect(
    () =>
      window.chorus.onSettings((settings) => {
        setExplainLanguage(settings.explainLanguage)
      }),
    []
  )

  /**
   * Closing the settings sheet, and re-reading the one setting the panes draw.
   *
   * The sheet owns the language field and persists it on every keystroke, so the
   * file is authoritative and this component's copy is not. Re-read here rather
   * than lifted into a prop the sheet writes back: the sheet is `Settings`'s to
   * own, and the alternative — a push channel — is what `SCALE_PUSH_CHANNEL`
   * exists for and is worth its five files only for something that changes
   * behind the user's back. This does not.
   */
  const closeSettings = useCallback(() => {
    setShowingSettings(false)
    window.chorus
      .readSettings()
      .then(({ explainLanguage: language }) => {
        setExplainLanguage(language)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = window.chorus.onScale((next) => {
      setZoom(next)
      clearTimeout(timer)
      timer = setTimeout(() => {
        setZoom(null)
      }, 1_400)
    })
    return () => {
      clearTimeout(timer)
      stop()
    }
  }, [])

  /*
   * The projects rail's data. Refreshed rather than patched after anything that
   * could change it, because `openConversations` is a count main computes and a
   * renderer guessing at it would drift the moment a session ended anywhere else.
   */
  const refreshProjects = useCallback(async () => {
    try {
      const { projects: listed } = await window.chorus.listProjects({})
      setProjects(listed)
      return listed
    } catch (error) {
      fail(setError)(error)
      return []
    }
  }, [])

  /*
   * Two rail tiles trading places.
   *
   * Sets the list main answers with rather than calling `refreshProjects`: the
   * reply is already a full `project:list`, counts included, so a second round
   * trip would only let the rail redraw twice for one gesture. Nothing is applied
   * optimistically — the order lives in SQLite, and a rail that moved before the
   * write landed would be showing an arrangement that might not exist.
   */
  const moveProject = useCallback(async (projectId: string, beforeId: string | null) => {
    try {
      const { projects: listed } = await window.chorus.reorderProjects({ projectId, beforeId })
      setProjects(listed)
    } catch (error) {
      fail(setError)(error)
    }
  }, [])

  /**
   * A session card dropped at a new place in the rail.
   *
   * The order is computed once, here, and the same value is both rendered and
   * written down. Reading it back off `sessionsRef` to persist would write the
   * order as it was *before* React applied the update — the list would look
   * right until the next launch and then come back as it started.
   */
  const moveSession = useCallback(
    (conversationId: string, slot: number) => {
      const current = sessionsRef.current
      const order = reorderSessions(
        current.map((session) => session.conversationId),
        conversationId,
        slot
      )
      const byId = new Map(current.map((session) => [session.conversationId, session]))
      const next = order.flatMap((id) => {
        const session = byId.get(id)
        return session === undefined ? [] : [session]
      })
      updateSessions(() => next)
      persistLayout({
        order: [...order],
        workspace: workspaceSnapshot(useWorkspaceStore.getState()),
      }).catch(fail(setError))
    },
    [updateSessions, persistLayout]
  )

  const removeClosedProject = useCallback(
    (projectId: string) => {
      projectCloseVersions.current.set(
        projectId,
        (projectCloseVersions.current.get(projectId) ?? 0) + 1
      )
      const removed = sessionsRef.current.filter((session) => session.projectId === projectId)
      for (const session of removed) {
        closedIds.current.add(session.conversationId)
        retainedCloseIds.current.delete(session.conversationId)
        carries.current.delete(session.conversationId)
        useWorkspaceStore.getState().removeSession(session.conversationId)
      }
      updateSessions((current) => current.filter((session) => session.projectId !== projectId))
      closingProjectIds.current.delete(projectId)
      useWorkspaceStore.getState().clearDetached(projectId)
      useWorkspaceStore.getState().removeProject(projectId)
      detachedVisibility.current.delete(projectId)
    },
    [updateSessions]
  )

  const closeDetachedProject = useCallback(
    (projectId: string): Promise<void> => {
      if (role.kind !== 'detached' || role.projectId !== projectId) return Promise.resolve()
      const existing = closingWindows.current.get(projectId)
      if (existing !== undefined) return existing
      const work = window.chorus
        .closeEmptyProject({ projectId })
        .then(() => undefined)
        .catch((error: unknown) => {
          closingWindows.current.delete(projectId)
          throw error
        })
      closingWindows.current.set(projectId, work)
      return work
    },
    [role]
  )

  const finishCloseProject = useCallback(
    (projectId: string): Promise<void> => {
      const existing = closingProjects.current.get(projectId)
      if (existing !== undefined) return existing
      const closing = sessionsRef.current.filter((session) => session.projectId === projectId)
      for (const session of closing) retainedCloseIds.current.add(session.conversationId)
      closingProjectIds.current.add(projectId)
      setStoppingProjects((current) => [...current, projectId])
      setError(null)
      const work = Promise.resolve()
        .then(async () => {
          await window.chorus.closeProject({ projectId })
          removeClosedProject(projectId)
          await closeDetachedProject(projectId)
          await refreshProjects()
        })
        .finally(() => {
          closingProjects.current.delete(projectId)
          closingProjectIds.current.delete(projectId)
          setStoppingProjects((current) => current.filter((id) => id !== projectId))
        })
      closingProjects.current.set(projectId, work)
      void work.catch(fail(setError))
      return work
    },
    [refreshProjects, removeClosedProject, closeDetachedProject]
  )

  const finishEnd = useCallback(
    (conversationId: string): Promise<void> => {
      const existing = closingChats.current.get(conversationId)
      if (existing !== undefined) return existing
      const ending = sessionsRef.current.find(
        (session) => session.conversationId === conversationId
      )
      if (
        ending !== undefined &&
        !sessionsRef.current.some(
          (session) =>
            session.projectId === ending.projectId && session.conversationId !== conversationId
        )
      ) {
        return finishCloseProject(ending.projectId)
      }
      retainedCloseIds.current.add(conversationId)
      setStoppingChats((current) => [...current, conversationId])
      setError(null)
      const work = Promise.resolve()
        .then(async () => {
          await Promise.all([
            pendingRestarts.current.cancelRestartOf(conversationId),
            window.chorus.closeConversation({ conversationId }),
          ])
          if (
            ending !== undefined &&
            !sessionsRef.current.some(
              (session) =>
                session.projectId === ending.projectId && session.conversationId !== conversationId
            )
          ) {
            await finishCloseProject(ending.projectId)
            return
          }
          closedIds.current.add(conversationId)
          retainedCloseIds.current.delete(conversationId)
          carries.current.delete(conversationId)
          updateSessions((current) =>
            current.filter((session) => session.conversationId !== conversationId)
          )
          useWorkspaceStore.getState().removeSession(conversationId)
          await refreshProjects()
        })
        .finally(() => {
          closingChats.current.delete(conversationId)
          setStoppingChats((current) => current.filter((id) => id !== conversationId))
        })
      closingChats.current.set(conversationId, work)
      void work.catch(fail(setError))
      return work
    },
    [updateSessions, refreshProjects, finishCloseProject]
  )

  /**
   * What ending this room would throw away, or null when it would throw away
   * nothing.
   *
   * **Three things, and each is unrecoverable in a different way.** A turn in
   * flight is discarded by the provider. A decision nobody answered is a room
   * that was waiting on a person. A draft exists nowhere else — the log holds
   * what was sent, and an unsent line was never an event.
   *
   * Everything else about a conversation survives ending: the log is
   * append-only and the transcript stays in History, which is why ending a quiet
   * room asks nothing at all.
   *
   * The draft is read through a lent getter for the mounted session and out of
   * the carry for one that is not, and that split is the whole reason the getter
   * exists — `onCarry` fires on unmount, so the room you are looking at is
   * exactly the one whose draft the carry does not have yet.
   */
  const wouldLose = useCallback(
    (conversationId: string): { working: string[]; decisions: number; draft: boolean } | null => {
      const pulse = useWorkspaceStore.getState().pulses[conversationId]
      const working = pulseWorking(pulse)
      const decisions = (pulse?.approvalIds.length ?? 0) + (pulse?.questionIds.length ?? 0)
      const read = draftReaders.current.get(conversationId)
      const draft = (read === undefined ? carries.current.get(conversationId)?.draft : read()) ?? ''
      if (working.length === 0 && decisions === 0 && draft.trim() === '') return null
      return { working, decisions, draft: draft.trim() !== '' }
    },
    []
  )

  /**
   * What the UI calls, and the only path that asks.
   *
   * A conversation tab's × ends the room rather than hiding it — a conversation
   * appears in exactly one place, so a × that merely closed the tab would leave
   * agents running behind no door. That is why it comes through here and not
   * through a lighter close.
   */
  const endNow = useCallback(
    (conversationId: string) => {
      const ending = sessionsRef.current.find(
        (session) => session.conversationId === conversationId
      )
      if (
        ending !== undefined &&
        !sessionsRef.current.some(
          (session) =>
            session.projectId === ending.projectId && session.conversationId !== conversationId
        )
      )
        return
      const losing = wouldLose(conversationId)
      if (losing === null) {
        void finishEnd(conversationId)
        return
      }
      setConfirmingEnd({ target: { kind: 'conversation', id: conversationId }, ...losing })
    },
    [wouldLose, finishEnd]
  )

  const closeProjectNow = useCallback(
    (projectId: string) => {
      if (closingProjects.current.has(projectId)) return
      const losses = sessionsRef.current
        .filter((session) => session.projectId === projectId)
        .flatMap((session) => {
          const loss = wouldLose(session.conversationId)
          return loss === null ? [] : [loss]
        })
      if (losses.length === 0) {
        void finishCloseProject(projectId)
        return
      }
      setConfirmingEnd({
        target: { kind: 'project', id: projectId },
        working: [...new Set(losses.flatMap((loss) => loss.working))],
        decisions: losses.reduce((total, loss) => total + loss.decisions, 0),
        draft: losses.some((loss) => loss.draft),
      })
    },
    [wouldLose, finishCloseProject]
  )

  useEffect(
    () =>
      window.chorus.onProjectClosed(({ projectId }) => {
        removeClosedProject(projectId)
        void closeDetachedProject(projectId).catch(fail(setError))
        void refreshProjects()
      }),
    [removeClosedProject, refreshProjects, closeDetachedProject]
  )

  useEffect(
    () =>
      window.chorus.onProjectCloseRequested(({ projectId }) => {
        if (role.kind === 'detached' && role.projectId === projectId) closeProjectNow(projectId)
      }),
    [role, closeProjectNow]
  )

  /*
   * Starting a session, now in a project rather than in a directory.
   *
   * `defaults.cwd` used to decide this, which meant a session could be created
   * in a folder nobody had adopted — and on the first launch of all, before
   * settings had loaded, in the home directory. There is no path in this
   * function any more: without a project there is nothing to start, and Add
   * Project is the affordance that fixes that.
   */
  const reportError = useMemo(() => fail(setError), [])
  const clearError = useCallback(() => {
    setError(null)
  }, [])
  const forgetDetached = useCallback((projectId: string) => {
    detachedVisibility.current.delete(projectId)
  }, [])
  const { starting, startIn, cancelRestartOf, holdRestarts } = useConversationStarts({
    role,
    profileId: defaults.profileId,
    sessionsRef,
    revision: sessionsRevision,
    closedIds,
    retainedCloseIds,
    closingProjectIds,
    projectCloseVersions,
    updateSessions,
    finishEnd,
    refreshProjects,
    reportError,
    clearError,
    forgetDetached,
  })
  pendingRestarts.current = { cancelRestartOf, holdRestarts }

  /*
   * `+` starts in the most recently opened project, which is what the list is
   * ordered by. It is disabled when there are none, so this is a guard rather
   * than a fallback — silently adopting something would be inventing a project
   * the person did not choose.
   */
  /*
   * The most recent project **whose folder is still there**.
   *
   * Skipping the missing ones is what stops one stale project taking the app
   * down with it. `startConversation` resolves the root in main and throws
   * `ProjectRootMissingError` when it has gone; on launch that rejection reached
   * `setError`, and because a boot error renders `Stuck` instead of the
   * workspace, a renamed checkout meant the whole app was one error screen —
   * with no route to the project card that could have fixed it.
   *
   * Restore already worked this way: `restoreOpenConversations` catches the same
   * refusal per conversation and carries on. This is the same rule one level up,
   * and the two now agree.
   */
  const start = useCallback(() => {
    const mostRecent = projects.find((project) => !project.missing)
    if (mostRecent === undefined) return
    startIn(mostRecent.id)
  }, [projects, startIn])

  /*
   * A rail tile switches to a project. It does not start a conversation.
   *
   * It used to call `startIn`, so every click on a project opened a *new* room —
   * clicking the project you were already in gave you a second one, and there is
   * no way to click a tile meaning "show me that project" without also creating
   * something. Switching is what the gesture reads as.
   *
   * A project with nothing open lands on an empty column, which is the honest
   * result and not a dead end: the strip's `+` starts a conversation there, and
   * that is the one control whose whole job is to say so.
   */
  const showProject = useCallback((projectId: string) => {
    useWorkspaceStore.getState().openProject(projectId)
  }, [])

  const detachProject = useCallback(
    (projectId: string) => {
      const title = projects.find((project) => project.id === projectId)?.name ?? projectId
      let release = (): void => undefined
      let releaseRestarts = (): void => undefined
      window.chorus
        .prepareDetach({ projectId, title })
        .then(async (prepared) => {
          if (!('ticket' in prepared)) return
          releaseRestarts = await holdRestarts(projectId)
          release = await holdShellCloses(projectId)
          await Promise.all(
            sessionsRef.current
              .filter((session) => session.projectId === projectId)
              .flatMap((session) => {
                const read = draftReaders.current.get(session.conversationId)
                return read === undefined
                  ? []
                  : [
                      window.chorus.rememberDraft({
                        conversationId: session.conversationId,
                        draft: read(),
                      }),
                    ]
              })
          )
          const state = useWorkspaceStore.getState()
          const detached = detachTab(workspaceSnapshot(state), projectId, state.detached)
          if (detached === null) return
          await window.chorus.commitDetach({
            ticket: prepared.ticket,
            returnSlot: detached.slot,
            slice: sliceOf(state, projectId),
          })
          useWorkspaceStore.setState(detached.workspace)
          useWorkspaceStore.getState().markDetached(projectId, detached.slot)
        })
        .finally(() => {
          release()
          releaseRestarts()
        })
        .catch(fail(setError))
    },
    [projects, holdRestarts]
  )

  const redockProject = useCallback(
    (projectId: string) => {
      let release = (): void => undefined
      let releaseRestarts = (): void => undefined
      window.chorus
        .prepareRedock({ projectId })
        .then(async (prepared) => {
          if (!('ticket' in prepared)) return
          releaseRestarts = await holdRestarts(projectId)
          release = await holdShellCloses(projectId)
          await Promise.all(
            [...draftReaders.current].map(([conversationId, read]) =>
              window.chorus.rememberDraft({ conversationId, draft: read() })
            )
          )
          await window.chorus.commitRedock({
            ticket: prepared.ticket,
            slice: sliceOf(useWorkspaceStore.getState(), projectId),
          })
        })
        .finally(() => {
          release()
          releaseRestarts()
        })
        .catch(fail(setError))
    },
    [holdRestarts]
  )

  const openAdopted = useCallback(
    async (project: { readonly id: string; readonly created: boolean }) => {
      const listed = await refreshProjects()
      // A folder that was already a project opens rather than announcing itself;
      // a new one starts its first conversation, because an empty project has
      // nothing to show and Add Project is not a filing exercise.
      if (project.created || listed.every((p) => p.openConversations === 0)) {
        startIn(project.id)
      }
    },
    [refreshProjects, startIn]
  )

  const addProject = useCallback(async () => {
    setError(null)
    try {
      const { project } = await window.chorus.adoptProject({})
      if (project === null) return
      await openAdopted(project)
    } catch (error) {
      fail(setError)(error)
    }
  }, [openAdopted])

  const addRemoteProject = useCallback(
    async (host: string, root: string) => {
      const { project } = await window.chorus.adoptRemoteProject({ host, root })
      if (project === null) return
      setAddingRemoteProject(false)
      await openAdopted(project)
    },
    [openAdopted]
  )

  /*
   * The first session waits for the settings, not just for the restore.
   *
   * `restored` and `readSettings` are two independent round trips, and this
   * effect used to fire on the first of them. When restore won — which it
   * usually does, being a database read against a small JSON read — `start()`
   * ran with `defaults.cwd` still at its placeholder `''`, and the runtime
   * reads an empty directory as "start at home". So the opening session of a
   * launch opened on the **home directory** instead of the configured folder,
   * and the Changes panel dutifully listed every dotfile in it.
   *
   * It looked like a path-resolution bug and was a race. Nothing resolved
   * wrongly: `''` really does mean home, and the session really was started
   * before anyone had said otherwise.
   *
   * Confirmed rather than assumed: the settings on this machine name a real
   * folder, and the session still opened at home.
   */
  /*
   * Two conditions were implicit before and are not any more.
   *
   * It needs a **project**, because `start()` cannot invent one; and it must fire
   * **once per launch**, because the moment it also waited on `projects` it
   * became able to fire when the first project was adopted — racing
   * `addProject`'s own start and giving two conversations for one click. "The
   * opening session of a launch" was always the intent; it used to be enforced
   * by the fact that `sessions.length > 0` right afterwards, which is a
   * consequence rather than a guard.
   */
  useEffect(() => {
    if (role.kind === 'detached') return
    if (autoStarted.current) return
    if (!restored || !settingsRead || starting || sessions.length > 0 || error !== null) return
    if (projects.length === 0) return
    autoStarted.current = true
    start()
  }, [restored, settingsRead, starting, sessions.length, error, projects.length, start, role.kind])

  /**
   * An aside stops being a footnote and becomes a room.
   *
   * The list is refreshed from main rather than assembled here: promotion gives
   * the conversation a profile, a title and a cwd, and guessing any of them in
   * the renderer is how a tab ends up describing something other than what was
   * opened.
   */
  const promoteAside = useCallback(
    (asideId: string, profileId: string) => {
      void (async () => {
        try {
          const promoted = await window.chorus.promoteAside({ asideId, profileId })
          updateSessions((current) => [...current, promoted])
          useWorkspaceStore.getState().openProject(promoted.projectId)
          useWorkspaceStore
            .getState()
            .adoptConversation(promoted.projectId, promoted.conversationId)
          useWorkspaceStore.getState().clearConversationUnread(promoted.conversationId)
        } catch (error) {
          fail(setError)(error)
        }
      })()
    },
    [updateSessions]
  )

  /**
   * A side task, branched off the conversation you are typing in.
   *
   * `promoteAside`'s twin, and deliberately the same three lines: main decides
   * the room's profile, title and cwd, the renderer adds the tab it is handed
   * and guesses none of them. The conversation it came from is left alone —
   * nothing is appended to it and its agent is not interrupted, which is the
   * entire point of the action.
   */

  /*
   * End takes effect immediately — there is no confirmation.
   *
   * There was one, and it asked "End this session?" with a warning when an agent
   * was mid-turn. It went because the question it asked was not the one that
   * mattered: the transcript is an append-only log, so ending a room destroys
   * nothing and reopening it from history brings it back. What the dialog cost
   * was a click on the one action people take dozens of times a day, and the
   * habit of clicking through a confirmation without reading it — which is worth
   * more than the keystroke, because the *other* confirmations in this app guard
   * things that genuinely cannot be undone.
   */
  const stillStarting = useCallback(
    (conversationId: string): boolean =>
      sessionsRef.current.some(
        (session) => session.conversationId === conversationId && session.starting === true
      ),
    []
  )

  const rename = useCallback(
    (conversationId: string, title: string) => {
      if (stillStarting(conversationId)) return
      window.chorus
        .renameConversation({ conversationId, title })
        .then(({ title: applied }) => {
          updateSessions((current) =>
            current.map((session) =>
              session.conversationId === conversationId ? { ...session, title: applied } : session
            )
          )
        })
        .catch(fail(setError))
    },
    [updateSessions, stillStarting]
  )

  const keepCarry = useCallback((conversationId: string, carry: SessionCarry) => {
    if (!closedIds.current.has(conversationId))
      carries.current.set(conversationId, trimCarry(carry))
  }, [])

  // Stable, because `Session` registers in an effect that depends on it: a fresh
  // function every render would withdraw and re-lend the reader on every paint.
  const keepDraftReader = useCallback((conversationId: string, read: (() => string) | null) => {
    if (read === null) draftReaders.current.delete(conversationId)
    else draftReaders.current.set(conversationId, read)
  }, [])

  /*
   * `setParticipants`, `toggleAgent` and `toggleProjectAgent` all stood here and
   * all three are gone.
   *
   * They were the renderer's half of a cast somebody chose — per conversation
   * first, then per project. The choice is what produced the bug: a project card
   * showing three agents, a settings file holding two, and a new chat opening
   * with the file's answer. A room now holds every agent, main decides that, and
   * the question the person actually has — which one am I asking — is the
   * composer's, where it was all along.
   */

  /** What a conversation may do, changed from wherever the profile is shown. */
  const applyProfile = useCallback(
    async (conversationId: string, profileId: string) => {
      if (stillStarting(conversationId)) return
      try {
        const { profileId: applied } = await window.chorus.setProfile({ conversationId, profileId })
        updateSessions((current) =>
          current.map((candidate) =>
            candidate.conversationId === conversationId
              ? { ...candidate, profileId: applied }
              : candidate
          )
        )
        remember({ profileId: applied })
      } catch (error) {
        fail(setError)(error)
      }
    },
    [updateSessions, remember, stillStarting]
  )

  /*
  /*
   * `setCwd`, `chooseFolder`, `setFolder` and then `chooseStartFolder` all stood
   * here in turn, and all four are gone.
   *
   * The first three were the renderer's half of a conversation owning a mutable
   * directory. `chooseStartFolder` replaced them for one slice as a picker that
   * chose where the *next* session opened — honest, but still a path in the
   * renderer's hands, and still a folder that nobody had adopted. `addProject`
   * above is what it becomes: the same dialog, opened by main, producing a
   * project rather than a string.
   */

  /**
   * The project-level writes the rail's card makes.
   *
   * Each refreshes the project list rather than patching it. The list is small,
   * main is the thing that decided what the value became — `setProjectProfile`
   * resolves the id through the policy engine — and patching it here would be a
   * second copy of that arithmetic, drifting. It is the same argument
   * `refreshProjects` already makes for adopt and forget.
   */
  const renameProject = useCallback(
    (projectId: string, name: string) => {
      /* Sent blank and all, because main answers a blank with the folder's own
         name — the rule conversation rename already has. Dropping it here made
         an emptied field a no-op, so the only way back to the default was to
         retype it exactly. */
      window.chorus
        .renameProject({ projectId, name })
        .then(() => refreshProjects())
        .catch(fail(setError))
    },
    [refreshProjects]
  )

  /*
   * The project's scratchpad, already debounced by the pad that calls this.
   *
   * Refreshed after the write for one reason: the pad seeds its draft from the
   * listing and is remounted on every tab switch, so a stale listing would show
   * a note one edit behind the moment you came back to it.
   */
  const setProjectNotes = useCallback(
    (projectId: string, notes: string) => {
      window.chorus
        .setProjectNotes({ projectId, notes })
        .then(() => refreshProjects())
        .catch(fail(setError))
    },
    [refreshProjects]
  )

  const sendNoteSelection = useCallback(
    (conversationId: string, text: string) => {
      if (stillStarting(conversationId)) return
      window.chorus.sendMessage({ conversationId, text }).catch(fail(setError))
    },
    [stillStarting]
  )

  /*
   * The app's own note, written straight into state as well as to disk.
   *
   * Its project-scoped neighbour above re-lists the registry after every write,
   * because the pad seeds from a listing that several other things also change.
   * This row has one reader and one writer, so a round trip would only confirm
   * what was just sent.
   *
   * `current` is never null in either of these: nothing can call them before the
   * note is mounted, and it is not mounted until the read has answered.
   */
  const saveAppNote = useCallback((notes: string) => {
    setAppNote((current) => (current === null ? current : { ...current, notes }))
    window.chorus.setAppNote({ notes }).catch(fail(setError))
  }, [])

  const saveAppNoteSize = useCallback((size: NoteSize) => {
    setAppNote((current) => (current === null ? current : { ...current, ...size }))
    /*
     * A width is never null for this note — the panel is drawn from the window's
     * edge and has to be *some* width, so the default stands in before the first
     * drag. A project's note is the one that can answer null, because until it is
     * dragged it is simply as wide as its column.
     */
    window.chorus
      .setAppNoteSize({ width: size.width ?? NOTE_SIZE.width.default, height: size.height })
      .catch(fail(setError))
  }, [])

  /*
   * The same for a project's note, and it re-lists for the same reason its text
   * does: the pad seeds from the listing and is remounted on every tab switch,
   * so a stale row would reopen at the size it had two drags ago.
   */
  const saveProjectNoteSize = useCallback(
    (projectId: string, size: NoteSize) => {
      window.chorus
        .setProjectNoteSize({ projectId, ...size })
        .then(() => refreshProjects())
        .catch(fail(setError))
    },
    [refreshProjects]
  )

  const chooseProjectProfile = useCallback(
    async (projectId: string, profileId: string) => {
      try {
        await window.chorus.setProjectProfile({ projectId, profileId })
        await refreshProjects()
      } catch (error) {
        fail(setError)(error)
      }
    },
    [refreshProjects]
  )

  /*
   * The two ways out of a project whose folder has gone, and the only place
   * either is offered.
   *
   * `setError(null)` first because the banner that is almost certainly on screen
   * is the one describing this exact project — leaving it up through a successful
   * relocate would say the folder is missing directly above a card showing its
   * new path.
   *
   * Neither starts a conversation afterwards. The project reappears in the rail
   * with its folder found, and opening a room in it is the person's next click
   * rather than something recovery does on their behalf.
   */
  const relocateProject = useCallback(
    async (projectId: string) => {
      setError(null)
      try {
        const { root } = await window.chorus.relocateProject({ projectId })
        // Cancelled the picker. Nothing changed and nothing is wrong.
        if (root === null) return
        await refreshProjects()
      } catch (error) {
        fail(setError)(error)
      }
    },
    [refreshProjects]
  )

  const forgetProject = useCallback(
    async (projectId: string) => {
      setError(null)
      try {
        await window.chorus.forgetProject({ projectId })
        /*
         * Main closed the project's rooms before deleting it, and their rows are
         * gone. The shell has to be told, because nothing else will: a closed
         * conversation reports through the pulse, but a *deleted* one has no
         * record left to report against, so a session left in this array would
         * be a tab whose transcript no longer exists anywhere.
         *
         * Ordered deliberately — sessions first, then the tab. `removeProject`
         * closes the project's tab in every pane, and doing that while its
         * conversations were still mounted would unmount them mid-teardown.
         */
        const gone = sessionsRef.current.filter((session) => session.projectId === projectId)
        for (const session of gone) {
          carries.current.delete(session.conversationId)
          useWorkspaceStore.getState().removeSession(session.conversationId)
        }
        updateSessions((current) => current.filter((session) => session.projectId !== projectId))
        useWorkspaceStore.getState().removeProject(projectId)
        await refreshProjects()
      } catch (error) {
        fail(setError)(error)
      }
    },
    [refreshProjects, updateSessions]
  )

  /*
   * Writes the arrangement now, without waiting on the 180ms debounce.
   *
   * For a change that ends the moment the pointer comes up — a finished resize,
   * a dropped row — the debounce is all risk and no benefit: it exists to
   * coalesce a stream of updates, and there is no stream. Quitting inside that
   * window would silently discard the change and reopen at the old value.
   */
  const commitLayout = useCallback(() => {
    persistLayout({
      order: sessionsRef.current.map((session) => session.conversationId),
      workspace: workspaceSnapshot(useWorkspaceStore.getState()),
    }).catch(fail(setError))
  }, [persistLayout])

  useEffect(() => {
    if (role.kind !== 'main') return undefined
    return window.chorus.onProjectSlice(({ projectId, slice }) => {
      useWorkspaceStore.setState((state) => mergeSlice(workspaceSnapshot(state), projectId, slice))
    })
  }, [role.kind])

  useEffect(() => {
    if (role.kind !== 'main') return undefined
    return window.chorus.onProjectVisibility(({ projectId, focused, visibleConversationIds }) => {
      detachedVisibility.current.set(projectId, { focused, visibleConversationIds })
    })
  }, [role.kind])

  useEffect(() => {
    if (role.kind !== 'main') return undefined
    return window.chorus.onHitTestRequest(({ requestId, x, y }) => {
      const state = useWorkspaceStore.getState()
      const target = resolveTarget(
        { ...measureTabGeometry(), sourceTabCount: 0 },
        null,
        '',
        x,
        y,
        false
      )
      window.chorus
        .sendHitTestResult(
          target?.kind === 'insert'
            ? {
                requestId,
                paneId: target.paneId,
                slot: virtualIndex(target.paneId, target.slot, state.detached),
              }
            : { requestId, paneId: null, slot: null }
        )
        .catch(fail(setError))
    })
  }, [role.kind])

  useEffect(() => {
    if (role.kind !== 'main') return undefined
    return window.chorus.onProjectReturned(({ projectId, returnSlot, slice }) => {
      const store = useWorkspaceStore.getState()
      store.clearDetached(projectId)
      detachedVisibility.current.delete(projectId)
      const merged = mergeSlice(workspaceSnapshot(store), projectId, slice)
      const hasSession = sessionsRef.current.some((session) => session.projectId === projectId)
      useWorkspaceStore.setState(
        hasSession
          ? returnTab(merged, projectId, returnSlot, useWorkspaceStore.getState().detached)
          : merged
      )
      commitLayout()
    })
  }, [role.kind, commitLayout])

  /*
   * Reorder writes through the same way, but builds its own order: the
   * debounced subscription only fires on *workspace store* changes, and the
   * sidebar's order lives in React state beside it, so a dragged row would
   * otherwise sit in the right place until the next relaunch and then jump
   * back. Anything the caller forgot keeps its place at the end, so a stale
   * list cannot drop a live session.
   */

  const installed = (probes ?? []).filter((probe) => probe.installed).map((probe) => probe.id)

  const badge =
    zoom === null ? null : (
      <div className="zoom-badge" role="status" aria-live="polite">
        {`${String(Math.round(zoom * 100))}%`}
      </div>
    )

  const toastStack = <ToastStack />

  const sheets = (
    <>
      {/*
        Here rather than beside the × that opened it, because both ways in — the
        card's End Session and a conversation tab's × — call one function in this
        file. A dialog per call site would be the same question twice, and the
        two would drift.
      */}
      {confirmingEnd !== null && (
        <ConfirmEndSession
          project={confirmingEnd.target.kind === 'project'}
          working={confirmingEnd.working.join(', ')}
          decisions={confirmingEnd.decisions}
          draft={confirmingEnd.draft}
          onCancel={() => {
            setConfirmingEnd(null)
          }}
          onConfirm={() => {
            const { target } = confirmingEnd
            setConfirmingEnd(null)
            if (target.kind === 'project') void finishCloseProject(target.id)
            else void finishEnd(target.id)
          }}
        />
      )}
      {addingRemoteProject && (
        <RemoteProjectDialog
          onClose={() => {
            setAddingRemoteProject(false)
          }}
          onAdd={addRemoteProject}
        />
      )}
      {showingHistory && (
        <HistoryPanel
          onClose={() => {
            setShowingHistory(false)
          }}
          onPick={openFromHistory}
        />
      )}
      {showingSettings && (
        <Settings
          probes={probes}
          onClose={closeSettings}
          onOpenLogs={() => {
            closeSettings()
            setShowingLogs(true)
          }}
        />
      )}
      {showingLogs && (
        <LogViewer
          onClose={() => {
            setShowingLogs(false)
          }}
          onError={setError}
        />
      )}
    </>
  )

  if (restoring) {
    return <div className="empty" aria-busy="true" />
  }
  /*
   * No projects yet: the first-launch screen, and the only way out of it.
   *
   * This branch used to be the same blank `aria-busy` div as `restoring`, and it
   * was survivable only because the auto-start effect immediately created a
   * session in `defaults.cwd`. A session cannot be created without a project any
   * more, so that escape is gone and the blank div became permanent — no rail,
   * therefore no Add Project, therefore no way to ever leave it. It rendered as
   * a black window.
   *
   * The plan describes exactly this screen: "the clean product starts with an
   * empty Projects rail and one primary action: Add Project."
   */
  if (sessions.length === 0 && projects.length === 0 && error === null) {
    return (
      <>
        <div className="empty">
          <ChorusLogo label={t('app.name')} />
          <h1>{t('app.name')}</h1>
          <p>{t('project.firstRun')}</p>
          <button
            type="button"
            className="primary"
            onClick={() => {
              void addProject()
            }}
          >
            {t('rail.addProject')}
          </button>
        </div>
        {sheets}
      </>
    )
  }
  /*
   * With projects but no open conversation we fall through to the full stage
   * rather than to a blank div. The rail is the way back in — clicking a project
   * starts a conversation in it — and hiding it because nothing is open is what
   * made the no-project case unrecoverable one branch above.
   *
   * **That paragraph described an intent the code did not have.** The condition
   * was `sessions.length === 0` alone, so having projects and no open room
   * returned `Stuck` — no rail, no project card, and therefore no route to the
   * one control that could fix whatever had gone wrong. A project whose folder
   * was renamed outside Chorus reached it on every launch: the auto-start threw
   * `ProjectRootMissingError`, the error screen printed the message, and its two
   * buttons were Try again, which threw again, and Settings.
   *
   * So `Stuck` is now only for the two cases that genuinely have nothing behind
   * them — **no projects at all**, or **no agent CLI installed**, which is the
   * screen it was written for and whose advice the stage does not carry. The
   * error itself is not lost by falling through: the stage renders it as a
   * dismissible `ErrorNotice`, which is the right weight for "one thing failed"
   * rather than "the app did not start".
   */
  if (sessions.length === 0 && (projects.length === 0 || noAgentInstalled(probes))) {
    return (
      <>
        <Stuck
          error={error}
          starting={starting}
          probes={probes}
          onRetry={() => {
            setError(null)
          }}
          onSettings={() => {
            setShowingSettings(true)
          }}
        />
        {sheets}
      </>
    )
  }

  const renderSession = (
    session: SessionInfo,
    focused: boolean,
    paneId: string
  ): React.ReactNode => (
    <SessionHost
      key={session.conversationId}
      session={session}
      active={focused}
      paneId={paneId}
      startIn={startIn}
      carry={carries.current.get(session.conversationId)}
      onCarry={keepCarry}
      onDraftReader={keepDraftReader}
      onPromoteAside={promoteAside}
      /* Read once here rather than per pane: it decides whether Explain
         exists under every reply, and four panes asking the same question
         of the same file is four answers that must agree. */
      explainLanguage={explainLanguage}
    />
  )

  if (role.kind === 'detached') {
    return (
      <div className="stage">
        {error !== null && (
          <ErrorNotice
            message={error}
            className="notice--workspace"
            onDismiss={() => {
              setError(null)
            }}
          />
        )}
        {stopping && (
          <p className="notice notice--workspace notice--closing" role="status">
            {t('workspace.stopping')}
          </p>
        )}
        <DetachedStage
          sessions={sessions}
          projects={projects}
          onStartInProject={startIn}
          onRename={rename}
          onEnd={endNow}
          onCloseProject={closeProjectNow}
          closingProjects={stoppingProjects}
          onCommitLayout={commitLayout}
          onReorderSessions={moveSession}
          onRenameProject={renameProject}
          onSetProjectNotes={setProjectNotes}
          onSetProjectNoteSize={saveProjectNoteSize}
          onSendProjectNoteSelection={sendNoteSelection}
          onRedockProject={redockProject}
          renderSession={renderSession}
        />
        {sheets}
        {badge}
        {toastStack}
      </div>
    )
  }

  return (
    <div className="stage">
      {/*
       * One compact row, and nothing in it but the name and the build.
       *
       * It was 40px of wrapping header with a padding rule that reserved the
       * sidebar's width; it is 31px now, holds the wordmark and the version, and
       * carries no actions — those all moved to the rail and the session menu.
       * That is the whole of its job, plus two it does by existing: it is the
       * window's drag region, and it is where `titleBarStyle: hiddenInset` puts
       * the traffic lights, so nothing below it has to leave room for them.
       */}
      <header className="masthead">
        <h1 className="wordmark">
          <ChorusLogo className="wordmark-logo" label={t('app.name')} />
          {appVersion !== null && (
            <span className="app-version" data-app-version>
              {appVersion}
            </span>
          )}
        </h1>
        {/*
          Inside the header, unlike the global note, and the difference is what
          each one is.

          That note *is* a note and has to be readable without opening anything,
          so it is fixed to the window and grows over the app. This is a button
          that opens one — 22px that never changes size — so it can live on the
          row it belongs to. What it opens is portalled out of here, because the
          row is one line tall inside a `.stage` that clips.
        */}
        <KeptNotes onSendSelection={sendNoteSelection} />
      </header>

      {/*
        Mounted as soon as the row has been read, and never unmounted after — it
        is the note, not a way to reach one.

        `ProjectNotes` is the same: one line always on screen, because a note you
        have to open is a note you forget you wrote. There is no button and
        nothing to toggle, so there is no open/closed state up here for it.

        The gate is about seeding, not about visibility — see `appNote` above.

        Not inside the header. It is fixed to the window's corner and grows down
        over the app, and `.stage` clips its overflow — a child of the masthead
        would be cut off at 31px the moment anyone typed a second line.
      */}
      {appNote !== null && (
        <GlobalNotes
          notes={appNote.notes}
          size={{ width: appNote.width ?? NOTE_SIZE.width.default, height: appNote.height }}
          onSave={saveAppNote}
          onSaveSize={saveAppNoteSize}
          onSendSelection={sendNoteSelection}
        />
      )}

      {error !== null && (
        <ErrorNotice
          message={error}
          className="notice--workspace"
          onDismiss={() => {
            setError(null)
          }}
        />
      )}

      {stopping && (
        <p className="notice notice--workspace notice--closing" role="status">
          {t('workspace.stopping')}
        </p>
      )}
      <Workspace
        sessions={sessions}
        starting={starting}
        onNewSession={start}
        onStartInProject={startIn}
        onRename={rename}
        onEnd={endNow}
        onCloseProject={closeProjectNow}
        closingProjects={stoppingProjects}
        onCommitLayout={commitLayout}
        onReorderSessions={moveSession}
        onMoveProject={(projectId, beforeId) => {
          void moveProject(projectId, beforeId)
        }}
        onDetachProject={detachProject}
        onOpenSettings={() => {
          setShowingSettings(true)
        }}
        onOpenHistory={() => {
          setShowingHistory(true)
        }}
        profiles={profiles}
        installed={installed}
        onRenameProject={renameProject}
        onSetProjectNotes={setProjectNotes}
        onSetProjectNoteSize={saveProjectNoteSize}
        onSendProjectNoteSelection={sendNoteSelection}
        onChooseProjectProfile={chooseProjectProfile}
        onRelocateProject={relocateProject}
        onForgetProject={forgetProject}
        projects={projects}
        onAddProject={addProject}
        onAddRemoteProject={() => {
          setAddingRemoteProject(true)
        }}
        onOpenProject={showProject}
        home={home}
        onChooseProfile={applyProfile}
        renderSession={renderSession}
      />

      {sheets}
      {badge}
      {toastStack}
    </div>
  )
}

/**
 * The screen a machine with no CLI actually reaches.
 *
 * Worth stating, because it was not obvious and the first attempt at improving
 * this put the advice somewhere else. With no agent, `startConversation` throws,
 * `sessions` stays empty and the workspace — with its rail, and the Settings
 * sheet the advice was written into — never mounts at all. This is the whole of
 * what a new user sees.
 *
 * So the same guidance is here, and it comes first. `props.error` still follows
 * it, because `spawn claude ENOENT` is the truth and someone will paste it into
 * a search box; it is simply not the first thing to read.
 *
 * Only when the probe says nothing is installed. Any other startup failure — a
 * missing directory, a corrupt store — is unrelated, and offering "install the
 * CLI" for it would be worse than the raw message.
 */
/**
 * Whether the probe came back saying no agent CLI is on this machine.
 *
 * Exported and pure because it is now asked in two places — `Stuck` draws the
 * install advice from it, and `App` uses it to decide whether `Stuck` is the
 * right screen at all. Two copies of this condition would drift into a screen
 * that offers install instructions and one that does not, for the same machine.
 *
 * `null` is "not probed yet" and is deliberately not "nothing installed": the
 * probe is a round trip, and answering `true` while it is in flight would flash
 * install instructions at everyone on every launch.
 */
export function noAgentInstalled(probes: AgentProbeResult[] | null): boolean {
  return probes !== null && probes.length > 0 && probes.every((probe) => !probe.installed)
}

function Stuck(props: {
  error: string | null
  starting: boolean
  probes: AgentProbeResult[] | null
  onRetry: () => void
  onSettings: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const nothingInstalled = noAgentInstalled(props.probes)
  return (
    <div className="empty">
      <div className="empty-inner">
        <h1 className="wordmark wordmark--large">
          <ChorusLogo className="wordmark-logo" label={t('app.name')} />
        </h1>
        {nothingInstalled && (
          <div className="empty-help">
            <p className="empty-help-lead">{t('agents.noneAtAll')}</p>
            {props.probes?.map((probe) => (
              <p key={probe.id} className="empty-help-row">
                <span className="empty-help-name">{probe.id}</span>
                <code className="cast-install">{INSTALL[probe.id]}</code>
              </p>
            ))}
            <p className="empty-help-foot">{t('agents.oneIsEnough')}</p>
          </div>
        )}
        <p className="notice notice--bad" role="alert">
          {props.error}
        </p>
        <button
          type="button"
          className="btn btn--go btn--wide"
          onClick={props.onRetry}
          disabled={props.starting}
        >
          {props.starting ? t('conversation.starting') : t('conversation.tryAgain')}
        </button>
        <button type="button" className="btn btn--quiet" onClick={props.onSettings}>
          {t('settings.open')}
        </button>
      </div>
    </div>
  )
}
