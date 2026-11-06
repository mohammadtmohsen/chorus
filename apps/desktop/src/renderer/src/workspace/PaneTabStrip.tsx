import { useHostCapabilities } from '../host-context.js'
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProjectInfo } from './session-row.js'
import { TabState } from './TabState.js'
import { TabJoin } from './TabJoin.js'
import type { LayoutViewProps } from './EditorPane.js'
import { WebTabStrip } from './WebTabStrip.js'

/**
 * The last segment of a root, by either platform's separator.
 *
 * Both, rather than the host's: a registry written on Windows can be read on a
 * Mac and the stored root keeps the separators it was adopted with.
 */
function folderOf(root: string): string {
  const segments = root.split(/[\\/]/).filter((segment) => segment !== '')
  return segments.at(-1) ?? root
}

/**
 * What a project tab reads: the name, and the folder it can never rename.
 *
 * `subscriber feature (tpa-web-2)` — the name leads because it is the thing that
 * was chosen, and the folder trails because it is the thing that identifies. A
 * project renames its *row*, never its directory, so the parenthesis is the only
 * place the two can be told apart once several projects are open under names
 * that describe work rather than paths.
 *
 * Omitted when they are the same string, which is every project nobody has
 * renamed — `tpa-web-2 (tpa-web-2)` says nothing twice.
 */
function projectLabel(project: ProjectInfo): string {
  const folder = folderOf(project.root)
  return project.name === folder ? project.name : `${project.name} (${folder})`
}

export function PaneTabStrip(
  props: LayoutViewProps & {
    readonly paneId: string
    readonly pane: { tabs: string[]; activeTabId: string | null }
  }
): React.JSX.Element {
  const { t } = useTranslation()
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  /*
   * Which tab is being renamed, and how wide it was when the rename began.
   *
   * The conversation strip carries the same pair for the same reason: the width
   * comes from the label, and the label is gone the moment the field replaces
   * it. See `ConversationColumn` — the two strips are one behaviour here as
   * everywhere else, and a fix that landed on only one of them would be the
   * thing that makes them drift.
   */
  const capabilities = useHostCapabilities()
  const [renaming, setRenaming] = useState<{ id: string; width: number } | null>(null)

  /* A strip that scrolls can hold the active tab off screen. */
  useEffect(() => {
    const index = props.pane.tabs.indexOf(props.pane.activeTabId ?? '')
    if (index < 0) return
    tabRefs.current[index]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [props.pane.activeTabId, props.pane.tabs])

  const focusAt = (index: number): void => {
    const count = props.pane.tabs.length
    if (count === 0) return
    tabRefs.current[(index + count) % count]?.focus()
  }
  const onTabKeyDown = (index: number, event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      focusAt(index + (event.key === 'ArrowLeft' ? -1 : 1))
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      focusAt(event.key === 'Home' ? 0 : props.pane.tabs.length - 1)
    }
  }

  return (
    <div className="workspace-tab-strip" data-tab-strip role="tablist">
      <div className="workspace-tabs">
        {/*
          A tab is a **project**, and this strip was still resolving it as a
          conversation — `sessions.get(tabId)` against a map keyed by
          conversation id.

          The `flatMap` is why it looked plausible for three slices instead of
          throwing: an id it could not resolve was dropped, so a pane keyed by
          project rendered whichever conversations happened to share those ids
          and silently omitted the rest. `EditorPane` and `reconcileWorkspace`
          were re-keyed in Phase 3 and this was missed.
        */}
        {props.pane.tabs.flatMap((projectId, index) => {
          /*
           * The project's newest conversation, which is still what the tab's
           * state mark and its drag are about — a pane shows one conversation
           * per project. A project with none of them open has nothing to draw
           * and is dropped, which is the one case the old `flatMap` handled
           * correctly by accident.
           *
           * It no longer *names* the tab. That was the only string the strip
           * could reach, and it read correctly only for as long as a
           * conversation was titled after its folder.
           */
          const projectSessions = [...props.sessions.values()].filter(
            (candidate) => candidate.projectId === projectId
          )
          const session = projectSessions.at(-1)
          if (session === undefined) return []
          const closing = props.closingProjects?.includes(projectId) === true
          const conversationId = session.conversationId
          /* Every conversation in the project, because the mark folds them —
             see `TabState`. The drag and the pane still follow the newest. */
          const conversationIds = projectSessions.map((candidate) => candidate.conversationId)
          const active = props.pane.activeTabId === projectId && props.webShowing !== true
          const project = props.projects.find((candidate) => candidate.id === projectId) ?? null
          /* A project the registry cannot resolve has no name to show, and the
             conversation's title is the same string it used to show anyway. */
          const label = project === null ? session.title : projectLabel(project)
          return [
            <div
              key={projectId}
              className="workspace-tab"
              data-active={active}
              aria-busy={closing}
              data-dragging={props.drag?.conversationId === conversationId}
              /*
               * Held at the width it had, for as long as the field is open —
               * the conversation strip's rule, with the conversation strip's
               * reasoning. A project tab carries a name *and* its folder in
               * parentheses, so it is usually the wider of the two and the
               * collapse to the 160px floor is that much more visible.
               */
              style={
                renaming !== null && renaming.id === projectId && renaming.width > 0
                  ? { width: renaming.width }
                  : undefined
              }
            >
              {active && <TabJoin />}
              {renaming !== null && renaming.id === projectId && project !== null ? (
                /*
                 * Renaming happens here now, and the note this replaces argued
                 * it could not: a tab was 160px of truncated name, too narrow a
                 * box to edit a title in, so the rename lived on the hover
                 * card. The tab grows to its content now, which removes that
                 * objection — and the card keeps its own field, because this is
                 * a second way in rather than a move.
                 *
                 * **Only the name is editable.** The folder sits beside the
                 * field as static text, so the part that cannot change is
                 * visible while you change the part that can — a project's
                 * directory is renamed by moving it, never by typing here.
                 *
                 * Uncontrolled, and blur commits: both are the conversation
                 * tab's rules one level in, and the two strips being one
                 * behaviour is worth more than either rule on its own.
                 */
                <span className="workspace-tab-rename">
                  <input
                    className="workspace-tab-rename-field"
                    defaultValue={project.name}
                    /* See the conversation tab's note: `size` defaults to 20,
                       which is a 20-character intrinsic width, and the tab takes
                       its width from its content. */
                    size={1}
                    autoFocus
                    aria-label={t('project.renameTitle')}
                    placeholder={t('project.namePlaceholder')}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        setRenaming(null)
                        return
                      }
                      /* `isComposing` guards an IME: Enter while a candidate is
                         open picks the candidate, not the name. */
                      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                        props.onRenameProject(projectId, event.currentTarget.value)
                        setRenaming(null)
                      }
                    }}
                    onBlur={(event) => {
                      props.onRenameProject(projectId, event.currentTarget.value)
                      setRenaming(null)
                    }}
                  />
                  <span className="workspace-tab-folder">{`(${folderOf(project.root)})`}</span>
                </span>
              ) : (
                <>
                  <button
                    ref={(element) => {
                      tabRefs.current[index] = element
                    }}
                    type="button"
                    className="workspace-tab-main"
                    data-workspace-tab={projectId}
                    id={`tab-${props.paneId}-${projectId}`}
                    role="tab"
                    tabIndex={active ? 0 : -1}
                    aria-selected={active}
                    aria-controls={`panel-${props.paneId}-${projectId}`}
                    title={label}
                    onPointerDown={(event) => {
                      /*
                       * The **project**, matching `data-workspace-tab` two lines
                       * up and `onClick` below — and the last place in this file
                       * that was still handing a conversation id to something
                       * keyed by projects.
                       *
                       * Dragging a tab carried the conversation, so
                       * `splitWithSession` looked it up in `pane.tabs` (project
                       * ids), found nothing, and took its *insert* branch: a new
                       * pane whose only tab was a conversation id.
                       * `WorkbenchFrame` then opened that as a project and main
                       * answered `UnknownProjectError`, which is the one place
                       * the mistake finally became visible. Everything before
                       * it — the drag, the drop, the split, the new pane — was a
                       * silent success.
                       */
                      props.onTabPointerDown(projectId, label, props.paneId, event)
                    }}
                    onClick={() => {
                      if (props.consumeSuppressedClick()) return
                      /*
                       * The project, not the conversation. `activateTab` matches
                       * against `pane.tabs`, which holds project ids — so a
                       * conversation id matched nothing and clicking a tab did
                       * nothing at all, silently, because activating an absent
                       * tab is a no-op rather than an error.
                       */
                      props.onActivate(props.paneId, projectId)
                    }}
                    /*
                     * Both clicks of the double run `onClick` first, and that is
                     * wanted rather than tolerated — the same reading the
                     * conversation tab gives: renaming a project you were not in
                     * switches to it on the way, so the pane under the name is
                     * the one being named.
                     */
                    /* Measured before the swap; see the conversation tab's note.
                       The wrapper is the rectangle that matters — it holds the
                       icon, the label and the × — and a miss pins nothing. */
                    onDoubleClick={(event) => {
                      const tab = event.currentTarget.closest<HTMLElement>('.workspace-tab')
                      setRenaming({ id: projectId, width: tab === null ? 0 : tab.offsetWidth })
                    }}
                    onAuxClick={(event) => {
                      if (event.button === 1 && !closing) props.onClose(props.paneId, projectId)
                    }}
                    onKeyDown={(event) => {
                      onTabKeyDown(index, event)
                    }}
                  >
                    <svg className="workspace-tab-icon" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M20 12a8 8 0 0 1-8 8H5l-1.5 2v-4.5A8 8 0 1 1 20 12Z" />
                    </svg>
                    <span className="workspace-tab-title">{label}</span>
                    {/*
                      What the session is *doing*, where its cast used to be.

                      The dots said which agents were in the room, which does not
                      change and so is never news. What a tab has to say is the
                      thing that changed while you were looking at another one: an
                      approval holding a tool, a question waiting, an agent
                      working, an agent that stopped.

                      The same `StateMark` the sidebar card draws, folded from the
                      same pulses. Deliberately not a second derivation: a tab
                      and its card disagreeing about whether a session is blocked
                      is worse than either being wrong alone.

                      **Every conversation in the project, not just the one this
                      pane shows.** A tab is a project, so what it reports has to
                      be the most urgent thing anybody in the project is waiting
                      for — the rail's tile has always folded them this way.
                    */}
                    <TabState conversationIds={conversationIds} />
                  </button>
                  <button
                    type="button"
                    className="workspace-tab-close"
                    disabled={closing}
                    aria-label={t('workspace.closeTab', { title: label })}
                    title={t('workspace.closeTab', { title: label })}
                    onClick={(event) => {
                      event.stopPropagation()
                      props.onClose(props.paneId, projectId)
                    }}
                  >
                    <span aria-hidden="true">{closing ? '…' : '×'}</span>
                  </button>
                </>
              )}
            </div>,
          ]
        })}
      </div>
      {capabilities.nativeBrowserViews && props.webTabsPaneId === props.paneId && <WebTabStrip />}
    </div>
  )
}

/*
 * A split target paints the pane it will make, at the size it will be.
 *
 * This drew a 52px strip along the edge until 2026-08-14 — `SPLIT_STRIP_PX` and
 * a `stripFor` helper, both gone — on the argument that a translucent slab over
 * half a transcript reads as "this half is selected" rather than as "a pane will
 * open here". Reversed on request, and the request is the better reading: what a
 * person wants from a drop target is *where the thing lands*, and a strip makes
 * them infer that from a seam. Half a pane is not a selection when it is wearing
 * a "Split right" chip.
 *
 * Nothing about the geometry moved. `target.rect` was always the real
 * destination and the hit area was always the full half — only the paint was a
 * strip. So a two-way split now shows a half and a split of an already-split
 * pane shows a quarter, with no arithmetic here: whatever the resolver says the
 * drop makes is what gets drawn.
 *
 * The dashed edge survives and matters more now. It marks the seam the split
 * opens along, which is the one thing a filled rectangle cannot say by itself.
 */
