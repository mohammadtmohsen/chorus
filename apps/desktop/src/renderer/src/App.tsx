import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentProbeResult } from '../../shared/ipc.js'
import { ChorusLogo } from './ChorusLogo.js'
import { Limits } from './Limits.js'
import { LogViewer } from './LogViewer.js'
import { fail, Session, type AgentId, type SessionCarry, type SessionInfo } from './Session.js'
import { Settings, type Defaults } from './Settings.js'
import { Workspace } from './workspace/Workspace.js'
import { useWorkspaceStore, workspaceSnapshot } from './workspace/store.js'

export function App(): React.JSX.Element {
  const { t } = useTranslation()
  const [appVersion, setAppVersion] = useState<string | null>(null)
  /** Where "no folder" resolves to, so a card can say which it is looking at. */
  const [home, setHome] = useState('')
  const [probes, setProbes] = useState<AgentProbeResult[] | null>(null)
  const [profiles, setProfiles] = useState<{ id: string; name: string; summary: string }[]>([])
  const [defaults, setDefaults] = useState<Defaults>({
    agents: ['codex', 'claude'],
    cwd: '',
    profileId: 'read-only',
  })
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const sessionsRef = useRef<SessionInfo[]>([])
  const carries = useRef(new Map<string, SessionCarry>())
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [showingLogs, setShowingLogs] = useState(false)
  const [showingSettings, setShowingSettings] = useState(false)
  const [restoring, setRestoring] = useState(true)
  const [restored, setRestored] = useState(false)
  const [zoom, setZoom] = useState<number | null>(null)

  const updateSessions = useCallback((change: (current: SessionInfo[]) => SessionInfo[]) => {
    setSessions((current) => {
      const next = change(current)
      sessionsRef.current = next
      return next
    })
  }, [])

  /*
   * Status is global and deliberately tiny. Active Session components still
   * reduce full transcripts; this listener lets closed/background tabs say an
   * agent is working or waiting without keeping markdown trees mounted.
   */
  useEffect(
    () => window.chorus.onEvents((events) => { useWorkspaceStore.getState().ingestEvents(events); }),
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
      .catch(() => { setAppVersion(null); })
    window.chorus.probeAgents().then(setProbes).catch(fail(setError))
    window.chorus.profiles().then(setProfiles).catch(fail(setError))
    window.chorus
      .readSettings()
      .then(({ agents, cwd, profileId }) => { setDefaults({ agents, cwd, profileId }); })
      .catch(fail(setError))

    /*
     * The visual grace may expire, but a new session still waits for the real
     * restore result. That distinction prevents one slow provider from creating
     * another duplicate session on every launch.
     */
    const grace = setTimeout(() => { setRestoring(false); }, 1_500)
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
          useWorkspaceStore
            .getState()
            .hydrate(
              workspace,
              merged.map((session) => session.conversationId)
            )
          return merged
        })
      })
      .catch(fail(setError))
      .finally(() => {
        clearTimeout(grace)
        setRestoring(false)
        setRestored(true)
      })
    return () => { clearTimeout(grace); }
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
      timer = setTimeout(() => { setZoom(null); }, 1_400)
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
      .finally(() => { setStarting(false); })
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
        .then((restarted) => { applyRestart(conversationId, restarted); })
        .catch(fail(setError))
    },
    [applyRestart]
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
   * Ending asks twice while an agent is working, and the asking is done by the
   * control you pressed — the menu item arms itself, exactly as the pane's ✕
   * does. A `window.confirm` was doing this job and had to go: it is an OS
   * dialog in an app drawn entirely in one typeface, and it blocks the renderer
   * while three other sessions are still streaming into it.
   */
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
    carries.current.set(conversationId, carry)
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

  const openPanel = useCallback((conversationId: string, panel: 'review' | 'summary') => {
    useWorkspaceStore.getState().openSession(conversationId)
    setPanelRequest({ conversationId, panel })
  }, [])

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
  const reorderSessions = useCallback(
    (order: readonly string[]) => {
      const current = sessionsRef.current
      const named = new Set(order)
      const byId = new Map(current.map((session) => [session.conversationId, session]))
      const next = [
        ...order.flatMap((id) => {
          const session = byId.get(id)
          return session === undefined ? [] : [session]
        }),
        ...current.filter((session) => !named.has(session.conversationId)),
      ]
      updateSessions(() => next)
      window.chorus
        .writeConversationLayout({
          order: next.map((session) => session.conversationId),
          workspace: workspaceSnapshot(useWorkspaceStore.getState()),
        })
        .catch(fail(setError))
    },
    [updateSessions]
  )

  const installed = (probes ?? []).filter((probe) => probe.installed).map((probe) => probe.id)

  const badge =
    zoom === null ? null : (
      <div className="zoom-badge" role="status" aria-live="polite">
        {`${String(Math.round(zoom * 100))}%`}
      </div>
    )

  const sheets = (
    <>
      {showingSettings && (
        <Settings
          probes={probes}
          onClose={() => { setShowingSettings(false); }}
          onOpenLogs={() => {
            setShowingSettings(false)
            setShowingLogs(true)
          }}
        />
      )}
      {showingLogs && <LogViewer onClose={() => { setShowingLogs(false); }} onError={setError} />}
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
          onRetry={() => { setError(null); }}
          onSettings={() => { setShowingSettings(true); }}
        />
        {sheets}
      </>
    )
  }

  return (
    <div className="stage">
      <header className="masthead">
        <h1 className="wordmark">
          <ChorusLogo className="wordmark-logo" label={t('app.name')} />
          {appVersion !== null && <span className="app-version">{appVersion}</span>}
        </h1>
        <Limits />
        <div className="masthead-actions">
          <button
            type="button"
            className="btn btn--chip"
            onClick={() => { setShowingSettings(true); }}
          >
            {t('settings.open')}
          </button>
        </div>
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
        onRestart={restart}
        onEnd={endNow}
        onReorderSessions={reorderSessions}
        onCommitLayout={commitLayout}
        profiles={profiles}
        installed={installed}
        onToggleAgent={toggleAgent}
        onChooseFolder={chooseFolder}
        onSetFolder={setFolder}
        home={home}
        onChooseProfile={applyProfile}
        onOpenPanel={openPanel}
        renderSession={(session, focused, paneId) => (
          <Session
            key={session.conversationId}
            session={session}
            active={focused}
            onActivate={() => { useWorkspaceStore.getState().focusPane(paneId); }}
            panelRequest={
              panelRequest?.conversationId === session.conversationId
                ? panelRequest.panel
                : undefined
            }
            onPanelOpened={() => { setPanelRequest(null); }}
            carry={carries.current.get(session.conversationId)}
            onCarry={keepCarry}
          />
        )}
      />

      {sheets}
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

