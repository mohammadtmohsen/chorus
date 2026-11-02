import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { IpcResponse } from '../../shared/ipc.js'
import type { WindowRole } from '../../shared/detached-window-ipc.js'
import type { SessionInfo } from './Session.js'
import { useWorkspaceStore } from './workspace/store.js'

/*
 * An object rather than two optional strings in a row, and that is a
 * decision about the next mistake rather than about this call.
 *
 * Both are conversation ids, both are optional, and they mean opposite
 * things — one is the room being thrown away, the other the room being
 * carried forward. Positionally, transposing them is invisible at the
 * call site and silent at runtime: you would end the wrong conversation
 * and carry the one you meant to end. Named, it cannot happen.
 */
export interface StartOptions {
  /**
   * A conversation this one replaces, ended once the new one exists.
   *
   * **After, never before**, and the ordering is the whole of why this is
   * a parameter rather than two calls at the call site. `endNow` closes
   * the project's tab when the conversation it ends was the last one in
   * it — so ending first would tear the project down and rebuild it
   * around the replacement, which is a visible flash and a pane that
   * loses its place. Started first, the new conversation is the sibling
   * that keeps the project open, and the end is a tab closing beside it.
   *
   * It also means a failed start ends nothing. The failure path is
   * reached instead, and the person still has the conversation they were
   * in.
   */
  readonly replacing?: string
  /**
   * A conversation the new one goes on from, transcript and all.
   *
   * **Always named by a caller, never inferred here.** An earlier build
   * guessed it — the conversation active in the project's focused group —
   * so every `+` silently carried whatever happened to be on screen. That
   * makes the cheapest gesture in the app the expensive one, and gives no
   * way to say "start clean" except by starting and restarting. Continuing
   * is now its own control on the conversation you want to continue, and
   * `+` means what it says again.
   */
  readonly continueFrom?: string
  readonly objective?: string
  readonly sourceEventIds?: readonly string[]
  readonly signal?: AbortSignal
  readonly onSettled?: (error: Error | null) => void
}

export interface ConversationStartsDeps {
  readonly role: WindowRole
  readonly profileId: string
  readonly sessionsRef: RefObject<SessionInfo[]>
  readonly revision: RefObject<number>
  readonly closedIds: RefObject<Set<string>>
  readonly retainedCloseIds?: RefObject<Set<string>>
  readonly closingProjectIds?: RefObject<Set<string>>
  readonly projectCloseVersions?: RefObject<Map<string, number>>
  readonly updateSessions: (change: (current: SessionInfo[]) => SessionInfo[]) => void
  readonly finishEnd: (conversationId: string) => Promise<void>
  readonly refreshProjects: () => Promise<unknown>
  readonly reportError: (error: unknown) => void
  readonly clearError: () => void
  readonly forgetDetached: (projectId: string) => void
}

type StartOutcome = IpcResponse<'conversation:awaitStart'>

interface PendingRestart {
  readonly source: string
  readonly projectId: string
  cancelled: boolean
  replacement: string | null
  closed: Promise<void> | null
  begun: Promise<void>
}

function forget(restarts: Map<string, PendingRestart>, record: PendingRestart): void {
  if (restarts.get(record.source) === record) restarts.delete(record.source)
}

const sameAgents = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((agent, index) => agent === b[index])

function copyMessageMode(source: string | undefined, target: string): void {
  if (source === undefined) return
  try {
    const mode = localStorage.getItem(`chorus:message-mode:${source}`)
    if (mode === 'work' || mode === 'discussion') {
      localStorage.setItem(`chorus:message-mode:${target}`, mode)
    }
  } catch {
    return
  }
}

export function advanceSession(session: SessionInfo, latest: SessionInfo): SessionInfo {
  if (latest.starting === true) return session
  if (session.starting !== true && sameAgents(session.participants, latest.participants)) {
    return session
  }
  return { ...session, participants: latest.participants, starting: false }
}

export function useConversationStarts(deps: ConversationStartsDeps): {
  readonly starting: boolean
  readonly startIn: (projectId: string, options?: StartOptions) => void
  readonly cancelRestartOf: (source: string) => Promise<void>
  readonly holdRestarts: (projectId: string) => Promise<() => void>
} {
  const {
    role,
    profileId,
    sessionsRef,
    revision,
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
  } = deps
  const [inFlight, setInFlight] = useState(0)
  const pendingBegins = useRef(0)
  const restarts = useRef(new Map<string, PendingRestart>())
  const heldProjects = useRef(new Map<string, number>())
  const latestRead = useRef(0)
  const heldRead = useRef(false)

  const reconcile = useCallback(() => {
    const apply = (active: readonly SessionInfo[]): void => {
      const scoped =
        role.kind === 'detached'
          ? active.filter((session) => session.projectId === role.projectId)
          : active
      const listed = new Set(scoped.map((session) => session.conversationId))
      if (pendingBegins.current === 0) {
        for (const id of [...closedIds.current]) {
          if (!listed.has(id)) closedIds.current.delete(id)
        }
      }
      const held = sessionsRef.current.filter(
        (session) =>
          retainedCloseIds?.current.has(session.conversationId) === true &&
          !listed.has(session.conversationId)
      )
      const visible = [...scoped, ...held].filter(
        (session) => !closedIds.current.has(session.conversationId)
      )
      const latest = new Map<string, SessionInfo>(
        visible.map((session) => [session.conversationId, session])
      )
      const current = sessionsRef.current
      const known = new Set(current.map((session) => session.conversationId))
      const added = visible.filter((session) => !known.has(session.conversationId))
      const removed = current.filter((session) => !latest.has(session.conversationId))
      const kept = current.flatMap((session) => {
        const fresh = latest.get(session.conversationId)
        return fresh === undefined ? [] : [advanceSession(session, fresh)]
      })
      const changed = kept.some((session, index) => session !== current[index])
      if (added.length === 0 && removed.length === 0 && !changed) return
      updateSessions(() => [...added, ...kept])
      const store = useWorkspaceStore.getState()
      for (const session of removed) store.removeSession(session.conversationId)
      if (role.kind === 'detached') {
        for (const session of added) {
          store.adoptConversation(session.projectId, session.conversationId)
        }
        return
      }
      for (const projectId of Object.keys(store.detached)) {
        if (!scoped.some((session) => session.projectId === projectId)) {
          store.clearDetached(projectId)
          forgetDetached(projectId)
        }
      }
    }
    const read = (): void => {
      const ticket = ++latestRead.current
      const seen = revision.current
      heldRead.current = false
      window.chorus
        .readActiveSessions()
        .then(({ sessions: active }) => {
          if (ticket !== latestRead.current) return
          if (pendingBegins.current > 0) {
            heldRead.current = true
            return
          }
          if (seen !== revision.current) {
            read()
            return
          }
          apply(active)
        })
        .catch(reportError)
    }
    read()
  }, [
    role,
    sessionsRef,
    revision,
    closedIds,
    retainedCloseIds,
    updateSessions,
    reportError,
    forgetDetached,
  ])

  useEffect(() => window.chorus.onConversationsChanged(reconcile), [reconcile])

  const settle = useCallback(
    (
      conversationId: string,
      outcome: StartOutcome,
      restart: PendingRestart | undefined,
      reportFailure = true
    ) => {
      const open = (id: string): boolean =>
        sessionsRef.current.some((session) => session.conversationId === id)
      if (outcome.status !== 'ready') {
        closedIds.current.add(conversationId)
        if (open(conversationId)) {
          updateSessions((current) =>
            current.filter((session) => session.conversationId !== conversationId)
          )
          useWorkspaceStore.getState().removeSession(conversationId)
        }
        if (outcome.status === 'failed' && reportFailure) reportError(new Error(outcome.message))
        reconcile()
        return
      }
      if (!open(conversationId)) return
      if (restart !== undefined && (restart.cancelled || !open(restart.source))) {
        restart.cancelled = true
        restart.closed = finishEnd(conversationId)
        reconcile()
        return
      }
      const ready = { participants: outcome.conversation.participants, starting: false }
      updateSessions((current) =>
        current.map((session) =>
          session.conversationId === conversationId
            ? advanceSession(session, { ...session, ...ready })
            : session
        )
      )
      if (restart !== undefined) {
        forget(restarts.current, restart)
        const store = useWorkspaceStore.getState()
        const { projectId, source } = restart
        if (
          !store.replaceConversation(projectId, source, conversationId) &&
          store.detached[projectId] === undefined
        ) {
          store.adoptConversation(projectId, conversationId)
        }
        // `finishEnd` and not `endNow`: restart has already asked its own
        // question by the time this runs, and asking again would be two
        // dialogs for one gesture.
        void finishEnd(source)
      }
      reconcile()
      void refreshProjects()
    },
    [sessionsRef, closedIds, updateSessions, reportError, reconcile, finishEnd, refreshProjects]
  )

  const startIn = useCallback(
    (projectId: string, options: StartOptions = {}) => {
      if (options.signal?.aborted === true || closingProjectIds?.current.has(projectId) === true)
        return
      const closeVersion = projectCloseVersions?.current.get(projectId) ?? 0
      const source = options.replacing
      if (
        source !== undefined &&
        (restarts.current.has(source) || heldProjects.current.has(projectId))
      ) {
        return
      }
      const restart: PendingRestart | undefined =
        source === undefined
          ? undefined
          : {
              source,
              projectId,
              cancelled: false,
              replacement: null,
              closed: null,
              begun: Promise.resolve(),
            }
      if (restart !== undefined) {
        restarts.current.set(restart.source, restart)
        updateSessions((current) =>
          current.map((session) =>
            session.conversationId === restart.source ? { ...session, restarting: true } : session
          )
        )
      }
      clearError()
      setInFlight((count) => count + 1)
      pendingBegins.current += 1
      const open = (id: string): boolean =>
        sessionsRef.current.some((session) => session.conversationId === id)
      let createdId: string | undefined
      let completed = false
      const cancel = (): void => {
        if (!completed && createdId !== undefined) void finishEnd(createdId).catch(reportError)
      }
      const finish = (error: Error | null): void => {
        if (completed) return
        completed = true
        options.signal?.removeEventListener('abort', cancel)
        options.onSettled?.(error)
      }
      options.signal?.addEventListener('abort', cancel, { once: true })
      const releaseHeldRead = (): void => {
        if (pendingBegins.current === 0 && heldRead.current) reconcile()
      }
      const begin = window.chorus
        .beginConversation({
          projectId,
          profileId,
          ...(options.continueFrom === undefined ? {} : { continueFrom: options.continueFrom }),
          ...(options.objective === undefined ? {} : { objective: options.objective }),
          ...(options.sourceEventIds === undefined
            ? {}
            : { sourceEventIds: [...options.sourceEventIds] }),
        })
        .then(
          (begun) => {
            pendingBegins.current -= 1
            createdId = begun.conversationId
            if (
              options.signal?.aborted === true ||
              closingProjectIds?.current.has(projectId) === true ||
              (projectCloseVersions?.current.get(projectId) ?? 0) !== closeVersion
            ) {
              cancel()
              releaseHeldRead()
              return null
            }
            if (closedIds.current.has(begun.conversationId)) {
              releaseHeldRead()
              return null
            }
            if (restart !== undefined && (restart.cancelled || !open(restart.source))) {
              restart.cancelled = true
              restart.closed = finishEnd(begun.conversationId)
              releaseHeldRead()
              return null
            }
            if (restart !== undefined) restart.replacement = begun.conversationId
            copyMessageMode(options.continueFrom, begun.conversationId)
            if (!open(begun.conversationId)) {
              updateSessions((current) => [...current, { ...begun, starting: true }])
            }
            const store = useWorkspaceStore.getState()
            if (restart === undefined) {
              store.openProject(begun.projectId)
              /* A tab for it, in the focused group. Without this the conversation
                 streams into a project that has nowhere to show it until relaunch. */
              if (store.detached[begun.projectId] === undefined) {
                store.adoptConversation(begun.projectId, begun.conversationId)
              }
            }
            store.clearConversationUnread(begun.conversationId)
            reconcile()
            return begun.conversationId
          },
          (error: unknown) => {
            pendingBegins.current -= 1
            releaseHeldRead()
            throw error
          }
        )
      if (restart !== undefined) {
        restart.begun = begin.then(
          () => undefined,
          () => undefined
        )
      }
      begin
        .then(async (conversationId) => {
          if (conversationId === null) {
            finish(new Error('forwardTask.cancelled'))
            return
          }
          const outcome = await window.chorus
            .awaitStart({ conversationId })
            .catch((error: unknown) => {
              if (
                (restart !== undefined || options.continueFrom !== undefined) &&
                open(conversationId)
              ) {
                void finishEnd(conversationId).catch(reportError)
              }
              throw error
            })
          settle(conversationId, outcome, restart, options.onSettled === undefined)
          finish(
            outcome.status === 'ready'
              ? null
              : new Error(outcome.status === 'failed' ? outcome.message : 'forwardTask.cancelled')
          )
        })
        .catch((error: unknown) => {
          if (options.onSettled === undefined && options.signal?.aborted !== true)
            reportError(error)
          finish(error instanceof Error ? error : new Error('forwardTask.failed'))
        })
        .finally(() => {
          options.signal?.removeEventListener('abort', cancel)
          if (restart !== undefined && restarts.current.get(restart.source) === restart) {
            forget(restarts.current, restart)
            updateSessions((current) =>
              current.map((session) =>
                session.conversationId === restart.source
                  ? { ...session, restarting: false }
                  : session
              )
            )
          }
          setInFlight((count) => count - 1)
        })
    },
    [
      profileId,
      closingProjectIds,
      projectCloseVersions,
      closedIds,
      sessionsRef,
      updateSessions,
      finishEnd,
      reconcile,
      settle,
      reportError,
      clearError,
    ]
  )

  const cancel = useCallback(
    (restart: PendingRestart): Promise<void> => {
      if (!restart.cancelled) {
        restart.cancelled = true
        const known = restart.replacement
        if (known !== null && sessionsRef.current.some((s) => s.conversationId === known)) {
          restart.closed = finishEnd(known)
        }
      }
      return restart.begun.then(() => restart.closed ?? undefined)
    },
    [sessionsRef, finishEnd]
  )

  const cancelRestartOf = useCallback(
    (source: string): Promise<void> => {
      const restart = restarts.current.get(source)
      return restart === undefined ? Promise.resolve() : cancel(restart)
    },
    [cancel]
  )

  const holdRestarts = useCallback(
    (projectId: string): Promise<() => void> => {
      const holds = heldProjects.current
      holds.set(projectId, (holds.get(projectId) ?? 0) + 1)
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        const left = (holds.get(projectId) ?? 1) - 1
        if (left > 0) holds.set(projectId, left)
        else holds.delete(projectId)
      }
      const pending = [...restarts.current.values()].filter(
        (restart) => restart.projectId === projectId
      )
      return Promise.all(pending.map((restart) => cancel(restart))).then(
        () => release,
        (error: unknown) => {
          release()
          throw error
        }
      )
    },
    [cancel]
  )

  return { starting: inFlight > 0, startIn, cancelRestartOf, holdRestarts }
}
