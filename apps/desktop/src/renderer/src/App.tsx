import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { AgentProbeResult } from '../../shared/ipc.js'
import { ChorusLogo } from './ChorusLogo.js'
import { LogViewer } from './LogViewer.js'
import { fail, Session, type AgentId, type SessionCarry, type SessionInfo } from './Session.js'
import { trimCarry } from './carry.js'
import { EMPTY_VIEW } from './transcript.js'
import { noticesFrom, roomsWaiting, shouldRaise, trackPending, type Notice } from './notify.js'
import { HistoryPanel } from './HistoryPanel.js'
import { Settings, type Defaults } from './Settings.js'
import { Workspace } from './workspace/Workspace.js'
import { ConfirmSessionAction } from './workspace/ConfirmSessionAction.js'
import { useWorkspaceStore, workspaceSnapshot } from './workspace/store.js'
import { reorderSessions } from './workspace/session-row.js'

/**
 * Raises one banner, and makes clicking it land somewhere useful.
 *
 * Bringing the window forward is not enough on its own: a notification that
 * drops you into whichever pane you left open is a second thing to do rather
 * than the thing done, so it opens the conversation it was about.
 */
function raise(notice: Notice, title: string, t: TFunction): void {
  try {
    const banner = new Notification(t(`notify.${notice.kind}`, { agent: notice.actor }), {
      body: title,
      // One banner per conversation: a room that finishes twice while you are
      // away should replace its own notice, not stack.
      tag: notice.conversationId,
    })
    banner.onclick = () => {
      void window.chorus.focusWindow()
      useWorkspaceStore.getState().openSession(notice.conversationId)
    }
  } catch {
    // Denied at the OS level, or unsupported. Silence is the only sane response
    // to a failure whose only symptom would be another failure.
  }
}

/**
 * How long to sit on read-watermarks before writing them down.
 *
 * `open-sessions.json` is rewritten whole on every `markSeen`, and a streaming
 * turn would otherwise trigger one per push. A second of lag costs nothing: the
 * worst case is a card that says one unread instead of none.
 */
const SEEN_DEBOUNCE_MS = 1_000

export function App(): React.JSX.Element {
  const { t } = useTranslation()
  const [appVersion, setAppVersion] = useState<string | null>(null)
  /** Where "no folder" resolves to, so a card can say which it is looking at. */
  const [home, setHome] = useState('')
  const [probes, setProbes] = useState<AgentProbeResult[] | null>(null)
  const [profiles, setProfiles] = useState<{ id: string; name: string; summary: string }[]>([])
  const [defaults, setDefaults] = useState<Defaults>({
    /* Matches the main process's default. It only stands until `readSettings`
       answers, but a session started in that window used to open with both. */
    agents: ['claude'],
    cwd: '',
    profileId: 'read-only',
  })
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const sessionsRef = useRef<SessionInfo[]>([])
  const carries = useRef(new Map<string, SessionCarry>())
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
  const [starting, setStarting] = useState(false)
  const [showingLogs, setShowingLogs] = useState(false)
  const [showingSettings, setShowingSettings] = useState(false)
  const [showingHistory, setShowingHistory] = useState(false)
  const [restoring, setRestoring] = useState(true)
  const [restored, setRestored] = useState(false)
  const [zoom, setZoom] = useState<number | null>(null)

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
    setSessions((current) => {
      const next = change(current)
      sessionsRef.current = next
      return next
    })
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
      if (sessionsRef.current.some((session) => session.conversationId === conversationId)) {
        useWorkspaceStore.getState().openSession(conversationId)
        return
      }
      const reopened = await window.chorus.reopenConversation({ conversationId })
      updateSessions((current) => [...current, reopened])
      useWorkspaceStore.getState().openSession(reopened.conversationId)
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
        useWorkspaceStore.getState().ingestEvents(events)
      }),
    []
  )

  /*
   * Notifications and the dock badge.
   *
   * Beside the other global listeners, and for the same reason: this has to work
   * for conversations whose `Session` is not mounted, which is most of them once
   * more than four are open. The judgement about what deserves a banner lives in
   * `notify.ts` so it can be tested; this is only the plumbing.
   */
  useEffect(
    () =>
      window.chorus.onEvents((events) => {
        pending.current = trackPending(pending.current, events)
        void window.chorus.setBadge({ count: roomsWaiting(pending.current) })

        const panes = useWorkspaceStore.getState().panes
        const visibleConversationIds = Object.values(panes)
          .map((pane) => pane.activeTabId)
          .filter((id): id is string => id !== null)

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

        // Absent in a test renderer, and not worth a failed turn.
        if (!('Notification' in window)) return
        for (const notice of noticesFrom(events)) {
          if (
            !shouldRaise(notice, { windowFocused: document.hasFocus(), visibleConversationIds })
          ) {
            continue
          }
          const session = sessionsRef.current.find(
            (s) => s.conversationId === notice.conversationId
          )
          raise(notice, session?.title ?? '', t)
        }
      }),
    [t, markSeenSoon]
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

  /* What each agent left running, on its own channel and for the same reason. */
  useEffect(
    () =>
      window.chorus.onTasks((push) => {
        useWorkspaceStore.getState().ingestTasks(push)
      }),
    []
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
          window.chorus
            .writeConversationLayout({
              order: sessionsRef.current.map((session) => session.conversationId),
              workspace: {
                layout: next.layout,
                panes: next.panes,
                focusedPaneId: next.focusedPaneId,
                sidebarHidden: next.sidebarHidden,
                sidebarWidth: next.sidebarWidth,
                terminals: next.terminals,
                globalTerminal: next.globalTerminal,
              },
            })
            .catch(fail(setError))
        }, 180)
      },
      {
        equalityFn: (left, right) =>
          left.hydrated === right.hydrated &&
          left.layout === right.layout &&
          left.panes === right.panes &&
          left.focusedPaneId === right.focusedPaneId &&
          left.sidebarHidden === right.sidebarHidden &&
          left.sidebarWidth === right.sidebarWidth,
      }
    )
    return () => {
      clearTimeout(timer)
      stop()
    }
  }, [])

  useEffect(() => {
    window.chorus
      .getAppInfo()
      .then(({ appVersion: version, home: where }) => {
        setAppVersion(version)
        setHome(where)
      })
      .catch(() => {
        setAppVersion(null)
      })
    window.chorus.probeAgents().then(setProbes).catch(fail(setError))
    window.chorus.profiles().then(setProfiles).catch(fail(setError))
    window.chorus
      .readSettings()
      .then(({ agents, cwd, profileId }) => {
        setDefaults({ agents, cwd, profileId })
      })
      .catch(fail(setError))

    /*
     * The visual grace may expire, but a new session still waits for the real
     * restore result. That distinction prevents one slow provider from creating
     * another duplicate session on every launch.
     */
    const grace = setTimeout(() => {
      setRestoring(false)
    }, 1_500)
    window.chorus
      .restoreConversations()
      .then(({ sessions: reopened, workspace }) => {
        updateSessions((current) => {
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
              ideIncluded: held?.ideIncluded ?? true,
            })
          }
          useWorkspaceStore.getState().hydrate(
            workspace,
            merged.map((session) => session.conversationId),
            // Counted by the main process out of the log, against the watermark
            // saved when each card was last on screen.
            Object.fromEntries(reopened.map((session) => [session.conversationId, session.unread]))
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
          return merged
        })
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
  }, [updateSessions])

  const remember = useCallback((patch: Partial<Defaults>) => {
    setDefaults((current) => ({ ...current, ...patch }))
    window.chorus.writeSettings(patch).catch(fail(setError))
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

  const start = useCallback(() => {
    setError(null)
    setStarting(true)
    window.chorus
      .startConversation({
        agents: defaults.agents,
        cwd: defaults.cwd,
        profileId: defaults.profileId,
      })
      .then((session) => {
        updateSessions((current) => [...current, session])
        useWorkspaceStore.getState().openSession(session.conversationId)
        setDefaults((current) => ({ ...current, cwd: session.cwd }))
      })
      .catch(fail(setError))
      .finally(() => {
        setStarting(false)
      })
  }, [defaults, updateSessions])

  useEffect(() => {
    if (!restored || starting || sessions.length > 0 || error !== null) return
    start()
  }, [restored, starting, sessions.length, error, start])

  const applyRestart = useCallback(
    (previousId: string, restarted: SessionInfo) => {
      carries.current.delete(previousId)
      updateSessions((current) =>
        current.map((session) => (session.conversationId === previousId ? restarted : session))
      )
      useWorkspaceStore.getState().replaceSession(previousId, restarted.conversationId)
    },
    [updateSessions]
  )

  const restart = useCallback(
    (conversationId: string) => {
      window.chorus
        .restartConversation({ conversationId })
        .then((restarted) => {
          applyRestart(conversationId, restarted)
        })
        .catch(fail(setError))
    },
    [applyRestart]
  )

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
          useWorkspaceStore.getState().openSession(promoted.conversationId)
        } catch (error) {
          fail(setError)(error)
        }
      })()
    },
    [updateSessions]
  )

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
      window.chorus
        .writeConversationLayout({
          order: [...order],
          workspace: workspaceSnapshot(useWorkspaceStore.getState()),
        })
        .catch(fail(setError))
    },
    [updateSessions]
  )

  const endNow = useCallback(
    (conversationId: string) => {
      carries.current.delete(conversationId)
      updateSessions((current) =>
        current.filter((session) => session.conversationId !== conversationId)
      )
      useWorkspaceStore.getState().removeSession(conversationId)
      window.chorus.closeConversation({ conversationId }).catch(fail(setError))
    },
    [updateSessions]
  )

  /*
   * Both actions are confirmed, from every surface, by one dialog.
   *
   * They used to ask unevenly: End armed itself in the menu and the preview but
   * only while an agent was working, Restart asked nothing anywhere, and the
   * composer's buttons went straight through. Same key press, different amount of
   * destruction, depending on which control was nearest.
   *
   * Wrapping here rather than at each call site is the point. Every surface is
   * already handed `restart` and `endNow` — the comment further down says so —
   * so a confirmation on the funnel cannot be routed around by a fourth caller
   * added later.
   *
   * Still not `window.confirm`, for the reasons that removed it before: it is an
   * OS dialog in an app drawn entirely in one typeface, and it blocks the
   * renderer while three other sessions stream into it.
   */
  const [confirming, setConfirming] = useState<{
    readonly kind: 'restart' | 'end'
    readonly conversationId: string
    readonly working: boolean
  } | null>(null)

  /*
   * `working` read once, from the store, rather than subscribed to.
   *
   * `App` deliberately does not take a pulse subscription — that is what made
   * the shell re-render on every delta of every streaming session. The dialog
   * only needs the answer at the moment it opens, and a turn finishing while
   * someone reads a sentence does not change what the sentence should have said.
   */
  const ask = useCallback((kind: 'restart' | 'end', conversationId: string) => {
    const pulse = useWorkspaceStore.getState().pulses[conversationId]
    setConfirming({ kind, conversationId, working: (pulse?.working.length ?? 0) > 0 })
  }, [])

  const askRestart = useCallback(
    (conversationId: string) => {
      ask('restart', conversationId)
    },
    [ask]
  )

  const askEnd = useCallback(
    (conversationId: string) => {
      ask('end', conversationId)
    },
    [ask]
  )

  const rename = useCallback(
    (conversationId: string, title: string) => {
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
    [updateSessions]
  )

  const keepCarry = useCallback((conversationId: string, carry: SessionCarry) => {
    carries.current.set(conversationId, trimCarry(carry))
  }, [])

  /** Who is in a conversation, changed from wherever the cast is shown. */
  const setParticipants = useCallback(
    (conversationId: string, participants: AgentId[]) => {
      updateSessions((current) =>
        current.map((candidate) =>
          candidate.conversationId === conversationId ? { ...candidate, participants } : candidate
        )
      )
      if (participants.length > 0) remember({ agents: participants })
    },
    [updateSessions, remember]
  )

  /*
   * A panel the sidenav asked for, held until the session it belongs to is
   * mounted. Opening one means activating that session first — the panels read
   * a transcript, and a background session does not have one on screen.
   */
  const [panelRequest, setPanelRequest] = useState<{
    conversationId: string
    panel: 'review' | 'summary'
  } | null>(null)

  /** What a conversation may do, changed from wherever the profile is shown. */
  const applyProfile = useCallback(
    async (conversationId: string, profileId: string) => {
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
    [updateSessions, remember]
  )

  /** Where a conversation is pointed, changed from wherever the path is shown. */
  const setCwd = useCallback(
    (conversationId: string, cwd: string, title: string) => {
      updateSessions((current) =>
        current.map((candidate) =>
          candidate.conversationId === conversationId ? { ...candidate, cwd, title } : candidate
        )
      )
      remember({ cwd })
    },
    [updateSessions, remember]
  )

  const chooseFolder = useCallback(
    async (conversationId: string) => {
      try {
        const { cwd, title } = await window.chorus.chooseProjectDirectory({ conversationId })
        setCwd(conversationId, cwd, title)
      } catch (error) {
        fail(setError)(error)
      }
    },
    [setCwd]
  )

  /*
   * A path typed rather than picked, and an empty one meaning "no folder".
   *
   * The runtime has always read an empty directory as "start at home" — a
   * directory is a starting point, not a boundary — so clearing the field is
   * how a session goes back to having no project of its own.
   */
  const setFolder = useCallback(
    async (conversationId: string, cwd: string) => {
      try {
        const applied = await window.chorus.setProjectDirectory({ conversationId, cwd })
        setCwd(conversationId, applied.cwd, applied.title)
      } catch (error) {
        fail(setError)(error)
      }
    },
    [setCwd]
  )

  /*
   * The IPC and the error live here rather than in the control, because the
   * cast is now shown in two places and neither of them owns a place to report
   * a failure. The caller awaits this only to know when to stop disabling
   * itself.
   */
  const toggleAgent = useCallback(
    async (conversationId: string, agentId: AgentId, present: boolean) => {
      const session = sessionsRef.current.find((s) => s.conversationId === conversationId)
      if (session === undefined) return
      try {
        await (present
          ? window.chorus.removeAgent({ conversationId, agentId })
          : window.chorus.addAgent({ conversationId, agentId }))
        setParticipants(
          conversationId,
          present
            ? session.participants.filter((p) => p !== agentId)
            : [...session.participants, agentId]
        )
      } catch (error) {
        fail(setError)(error)
      }
    },
    [setParticipants]
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
    window.chorus
      .writeConversationLayout({
        order: sessionsRef.current.map((session) => session.conversationId),
        workspace: workspaceSnapshot(useWorkspaceStore.getState()),
      })
      .catch(fail(setError))
  }, [])

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

  const sheets = (
    <>
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
          onClose={() => {
            setShowingSettings(false)
          }}
          onOpenLogs={() => {
            setShowingSettings(false)
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

  if (restoring || (sessions.length === 0 && error === null)) {
    return <div className="empty" aria-busy="true" />
  }
  if (sessions.length === 0) {
    return (
      <>
        <Stuck
          error={error}
          starting={starting}
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
      </header>

      {error !== null && (
        <p className="notice notice--bad notice--workspace" role="alert">
          {error}
        </p>
      )}

      <Workspace
        sessions={sessions}
        starting={starting}
        onNewSession={start}
        onRename={rename}
        onRestart={askRestart}
        onEnd={askEnd}
        onCommitLayout={commitLayout}
        onReorderSessions={moveSession}
        onOpenSettings={() => {
          setShowingSettings(true)
        }}
        profiles={profiles}
        installed={installed}
        onToggleAgent={toggleAgent}
        onChooseFolder={chooseFolder}
        onSetFolder={setFolder}
        home={home}
        onChooseProfile={applyProfile}
        renderSession={(session, focused, paneId) => (
          <Session
            key={session.conversationId}
            session={session}
            active={focused}
            onActivate={() => {
              useWorkspaceStore.getState().focusPane(paneId)
            }}
            panelRequest={
              panelRequest?.conversationId === session.conversationId
                ? panelRequest.panel
                : undefined
            }
            onPanelOpened={() => {
              setPanelRequest(null)
            }}
            carry={carries.current.get(session.conversationId)}
            onCarry={keepCarry}
            onPromoteAside={promoteAside}
            /* The same two handlers the session menu is given, so a button in
               the composer and a row in the menu do one thing, not two. */
            onRestart={() => {
              askRestart(session.conversationId)
            }}
            onEnd={() => {
              askEnd(session.conversationId)
            }}
          />
        )}
      />

      {sheets}
      {/*
        Last, so it covers the sheets as well as the workspace. Restart and End
        are reachable from the composer, which is behind a sheet often enough.
      */}
      {confirming !== null && (
        <ConfirmSessionAction
          kind={confirming.kind}
          working={confirming.working}
          onCancel={() => {
            setConfirming(null)
          }}
          onConfirm={() => {
            const { kind, conversationId } = confirming
            setConfirming(null)
            if (kind === 'end') endNow(conversationId)
            else restart(conversationId)
          }}
        />
      )}
      {badge}
    </div>
  )
}

function Stuck(props: {
  error: string | null
  starting: boolean
  onRetry: () => void
  onSettings: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="empty">
      <div className="empty-inner">
        <h1 className="wordmark wordmark--large">
          <ChorusLogo className="wordmark-logo" label={t('app.name')} />
        </h1>
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
