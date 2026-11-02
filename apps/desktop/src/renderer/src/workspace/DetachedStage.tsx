import { useCallback, useMemo } from 'react'
import type { SessionInfo } from '../Session.js'
import type { NoteSize } from '../noteSize.js'
import { EditorPane } from './EditorPane.js'
import { useWorkspaceActions, useWorkspaceLayout } from './hooks.js'
import { DETACHED_PANE_ID, type SplitDirection } from './layout.js'
import { useShellOverlay } from './overlay.js'
import type { ProjectInfo } from './session-row.js'
import { useTabDrag } from './useTabDrag.js'

export function DetachedStage(props: {
  /**
   * The one project this window may inspect, and it comes from the window's
   * role in main rather than from anything the renderer decided. A detached
   * window is scoped to the project it was opened for, so there is no focused
   * pane to follow and no selector to offer.
   */
  readonly sessions: readonly SessionInfo[]
  readonly projects: readonly ProjectInfo[]
  readonly onStartInProject: (projectId: string) => void
  readonly onRename: (conversationId: string, title: string) => void
  readonly onEnd: (conversationId: string) => void
  readonly onCloseProject: (projectId: string) => void
  readonly closingProjects: readonly string[]
  readonly onCommitLayout: () => void
  readonly onReorderSessions: (conversationId: string, slot: number) => void
  readonly onRenameProject: (projectId: string, name: string) => void
  readonly onSetProjectNotes: (projectId: string, notes: string) => void
  readonly onSetProjectNoteSize: (projectId: string, size: NoteSize) => void
  readonly onSendProjectNoteSelection: (conversationId: string, text: string) => void
  readonly onRedockProject: (projectId: string) => void
  readonly renderSession: (
    session: SessionInfo,
    focused: boolean,
    paneId: string
  ) => React.ReactNode
}): React.JSX.Element {
  const { focusedPaneId } = useWorkspaceLayout()
  const { placeSession, splitWithSession, activateTab, focusPane, reorderTab } =
    useWorkspaceActions()
  const sessions = useMemo(
    () => new Map(props.sessions.map((session) => [session.conversationId, session])),
    [props.sessions]
  )
  const commit = props.onCommitLayout
  const drag = useTabDrag({
    onInsert: useCallback(
      (conversationId: string, paneId: string, slot: number) => {
        placeSession(conversationId, paneId, slot)
        commit()
      },
      [placeSession, commit]
    ),
    onSplit: useCallback(
      (conversationId: string, paneId: string, direction: SplitDirection) => {
        splitWithSession(conversationId, paneId, direction)
        commit()
      },
      [splitWithSession, commit]
    ),
    onReorder: props.onReorderSessions,
    onMoveProject: useCallback(() => undefined, []),
    onDropOutside: props.onRedockProject,
  })
  useShellOverlay(drag.drag !== null)

  return (
    <div className="workspace-shell">
      <main className="workspace-editor">
        <EditorPane
          paneId={DETACHED_PANE_ID}
          node={{ kind: 'leaf', paneId: DETACHED_PANE_ID }}
          path={[]}
          sessions={sessions}
          focusedPaneId={focusedPaneId}
          drag={drag.drag}
          onTabPointerDown={drag.onPointerDown}
          consumeSuppressedClick={drag.consumeSuppressedClick}
          onStartInProject={props.onStartInProject}
          onEndConversation={props.onEnd}
          onActivate={activateTab}
          onFocus={focusPane}
          onClose={(_paneId, projectId) => {
            props.onCloseProject(projectId)
          }}
          closingProjects={props.closingProjects}
          onReorder={reorderTab}
          onRename={props.onRename}
          projects={props.projects}
          onRenameProject={props.onRenameProject}
          onSetProjectNotes={props.onSetProjectNotes}
          onSetProjectNoteSize={props.onSetProjectNoteSize}
          onSendProjectNoteSelection={props.onSendProjectNoteSelection}
          onCommitLayout={props.onCommitLayout}
          trafficTerminals={[]}
          renderSession={props.renderSession}
        />
      </main>
    </div>
  )
}
