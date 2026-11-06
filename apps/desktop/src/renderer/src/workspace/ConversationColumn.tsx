import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionInfo } from '../Session.js'
import { useWorkspaceActions } from './hooks.js'
import { TabState } from './TabState.js'
import type { ConversationDrag } from './useConversationDrag.js'
import type { WorkspacePane } from '../../../shared/workspace-layout.js'

/**
 * It renders the transcript through `renderSession` rather than mounting
 * `Session` itself: the pane owns what a session needs — the carry, the panel
 * request, every callback `App` threads down — and duplicating that here would
 * be a second place for it to drift.
 */
export function ConversationColumn(props: {
  readonly projectId: string
  readonly group: WorkspacePane
  /** Every conversation in the project; this box shows the one it holds. */
  readonly sessions: readonly SessionInfo[]
  readonly paneId: string
  /** The pane has the caret **and** this is the arrangement's focused box. */
  readonly focused: boolean
  /** Ends one conversation — the × in the header. Confirms first; see the markup. */
  readonly onEndConversation: (conversationId: string) => void
  /**
   * Names one conversation — a double-click on the header.
   *
   * **The project tab strip says rename does not live on a tab, and that note is
   * about the project tab.** Its argument is a redirection: the hover card shows
   * the whole name and is already where you go to ask about a project. A
   * conversation has no such card — `SessionRow`, which had the double-click, is
   * no longer mounted anywhere — so `conversation:rename` was wired end to end
   * with nothing in the running app able to reach it. The header is the only
   * place a conversation appears, which makes it the only place its name can be
   * changed.
   */
  readonly onRename: (conversationId: string, title: string) => void
  /** The pane's one conversation drag, shared by every box in it. */
  readonly drag: ConversationDrag
  readonly renderSession: (
    session: SessionInfo,
    focused: boolean,
    paneId: string
  ) => React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  const { showConversationIn, focusConversationGroup } = useWorkspaceActions()

  /*
   * Which header is being renamed, held here rather than lifted, because nothing
   * outside this box can act on it: a rename starts and ends inside one header,
   * and the committed name goes to main rather than to a parent.
   */
  const [renaming, setRenaming] = useState(false)

  const tabId = props.group.activeTabId ?? props.group.tabs[0] ?? null
  const session = props.sessions.find((candidate) => candidate.conversationId === tabId)
  const canEnd = props.sessions.some(
    (candidate) => candidate.projectId === props.projectId && candidate.conversationId !== tabId
  )

  /*
   * What a drop here would do, for the highlight. Read off the live drag rather
   * than from a hover handler, so the zone shown is the one the drop will
   * actually take — a second source for "where would this land" is a second
   * thing to keep in step, and the one that lies is always the feedback.
   */
  const drop = props.drag.drag?.target?.groupId === props.group.id ? props.drag.drag.target : null

  return (
    <div
      className="conversation-column"
      data-group={props.group.id}
      data-project={props.projectId}
      data-focused={props.focused}
      data-drop={
        drop === null
          ? undefined
          : drop.direction === 'left' || drop.direction === 'right'
            ? 'reorder'
            : 'split'
      }
      data-drop-direction={drop?.direction}
      /*
       * Focus follows the pointer *down*, not the caret. A click anywhere in a
       * box is a statement about which one you are working in, and it has to
       * land before the click reaches a control inside.
       */
      onPointerDownCapture={() => {
        if (!props.focused) focusConversationGroup(props.projectId, props.group.id)
      }}
    >
      <div className="conversation-dock">
        <div className="conversation-dock-tabs">
          {session !== undefined && (
            <div
              className="conversation-dock-tab"
              data-tab-id={session.conversationId}
              data-dragging={props.drag.drag?.tabId === session.conversationId ? 'true' : undefined}
              data-active="true"
            >
              {renaming ? (
                /*
                 * The input takes the whole header, replacing the × as well as
                 * the label. A destructive control sitting beside a text field
                 * you are typing in is one press away from ending the session
                 * you meant to name, and there is nothing the × could usefully
                 * mean mid-rename anyway.
                 *
                 * Uncontrolled, like the project card's: the value is read off
                 * the element when the edit ends, so typing does not re-render
                 * the box and an abandoned edit leaves no state behind.
                 *
                 * **Empty is not rejected here.** `renameConversation` in main
                 * treats a blank field as a request for the folder name back
                 * (runtime.ts), trims, and no-ops when the name is unchanged —
                 * so it decides, and `App`'s rename applies the title main
                 * returns rather than the one that was typed. A second guard
                 * here would be a second rule to keep in step with that one.
                 */
                <input
                  className="conversation-dock-tab-rename"
                  size={1}
                  autoFocus
                  defaultValue={session.title}
                  aria-label={t('conversation.renameTitle')}
                  placeholder={t('conversation.titlePlaceholder')}
                  onKeyDown={(event) => {
                    /* Escape abandons; the name is whatever it already was. */
                    if (event.key === 'Escape') {
                      setRenaming(false)
                      return
                    }
                    /*
                     * `isComposing` guards an IME: Enter while a candidate is
                     * open picks the candidate, and committing there would file
                     * the half-composed text as the name.
                     */
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                      props.onRename(session.conversationId, event.currentTarget.value)
                      setRenaming(false)
                    }
                  }}
                  /*
                   * Blur commits rather than cancels, which is the behaviour the
                   * project card already has — clicking away from a field you
                   * typed in means keep it everywhere else in this app.
                   */
                  onBlur={(event) => {
                    props.onRename(session.conversationId, event.currentTarget.value)
                    setRenaming(false)
                  }}
                />
              ) : (
                <>
                  <button
                    type="button"
                    className="conversation-dock-tab-main"
                    title={session.title}
                    onPointerDown={(event) => {
                      props.drag.onPointerDown(
                        props.group.id,
                        session.conversationId,
                        session.title,
                        event
                      )
                    }}
                    onClick={() => {
                      /*
                       * A drag that moved suppresses the click the browser fires
                       * next. Without this, letting go over the header's own strip
                       * both reorders it and switches to it — and the switch is
                       * the one you did not ask for.
                       */
                      if (props.drag.consumeSuppressedClick()) return
                      showConversationIn(props.projectId, props.group.id, session.conversationId)
                    }}
                    /*
                     * Both clicks of the double still run `onClick` first, and
                     * that is wanted rather than tolerated: renaming a box you
                     * were not looking at switches to it on the way in, so the
                     * transcript under the name is the one being named. The
                     * second click is a no-op on an already-open conversation.
                     */
                    onDoubleClick={() => {
                      setRenaming(true)
                    }}
                  >
                    <span className="conversation-dock-tab-title">{session.title}</span>
                    {/*
                      The project tab's mark, in the project tab's place.

                      A project tab reads the state of one conversation — the
                      newest in that project — so a room going quiet or blocking
                      on an approval showed on the outer tab and nowhere else,
                      and a second conversation's approval showed nowhere at all.
                      Same `TabState`, same `useSessionRowState`, so the two
                      strips cannot disagree about what a session is doing.

                      The title needs its own element for this: with the name as
                      a bare text node it is an anonymous flex item, which cannot
                      take the `min-width: 0` that lets it ellipsis instead of
                      pushing the mark out of the header.
                    */}
                    <TabState conversationIds={[session.conversationId]} />
                  </button>
                  {/*
                    **Ends the session, and does not merely close the tab.**

                    That is the difference from the project tab's ×, which closes
                    a view and leaves the conversations inside running in main. A
                    conversation has no equivalent — a box is the only place it
                    appears, so a × that hid it would leave agents running in a
                    room with no door. It goes through `App`'s confirmation
                    dialog for the same reason the card's End Session does.
                  */}
                  {canEnd && (
                    <button
                      type="button"
                      className="conversation-dock-tab-close"
                      aria-label={t('conversation.endTitled', { title: session.title })}
                      title={t('conversation.endTitled', { title: session.title })}
                      onClick={(event) => {
                        event.stopPropagation()
                        props.onEndConversation(session.conversationId)
                      }}
                    >
                      <span aria-hidden="true">×</span>
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
      {/*
        No empty branch here. A box cannot stay empty — the tree collapses one
        the moment its last conversation leaves — so the case worth drawing is a
        *project* with no conversations, and that has no box to draw it in.
        `EditorPane` owns it.
      */}
      {/*
        Wrapped, so the focus outline can sit on the body rather than round the
        whole box — the header has to stay outside it, or the active tab's own
        border and the box's collide in the same two pixels. See the stylesheet's
        note on `.conversation-body`.
      */}
      <div className="conversation-body">
        {session !== undefined && props.renderSession(session, props.focused, props.paneId)}
      </div>
    </div>
  )
}
