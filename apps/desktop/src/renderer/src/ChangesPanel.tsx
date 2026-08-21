import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileDiff } from './FileDiff.js'
import { FileIcon } from './FileIcon.js'
import { mergeChanges } from './changed-files.js'
import { changeRows } from './changes-tree.js'
import { FileTree } from './FileTree.js'
import { MonacoDiff } from './MonacoDiff.js'
import {
  CHANGES_HEIGHT,
  CHANGES_LIST,
  CHANGES_WIDTH,
  TRANSCRIPT_MIN_WIDTH,
  type ChangesPanelState,
} from '../../shared/workspace-layout.js'
import type { IpcResponse } from '../../shared/ipc.js'

type WorkspaceRead = IpcResponse<'workspace:read'>
type BranchList = IpcResponse<'workspace:branches'>
type FileVersions = IpcResponse<'workspace:fileVersions'>

/**
 * Below this the list column gives up room to the diff.
 *
 * `240px` of list plus the body's padding leaves the diff under 300px here,
 * and the diff is the half that cannot be truncated. Both columns stay — the
 * two are read against each other, and a panel that stacks them is a different
 * panel rather than a smaller one.
 */
const CHANGES_NARROW_BELOW = 560

/**
 * The two views the rail switches between, drawn rather than imported.
 *
 * Stroke paths on a 24-grid, the same shape as `QuickRail`'s icons and reusing
 * its `.rail-icon` sizing. Hand-drawn because the alternative is `@vscode/codicons`,
 * which is CC-BY-4.0 and would need an attribution notice shipped for two glyphs
 * — see the Seti decision in `file-icon.ts` for the same trade made the other way,
 * where a whole file-type set was worth the notice and two icons are not.
 */
function ExplorerIcon(): React.JSX.Element {
  return (
    <svg className="rail-icon" viewBox="0 0 24 24" aria-hidden="true">
      {/* Two sheets, the back one offset — a project rather than a document. */}
      <path d="M15.5 2H8.6a1.6 1.6 0 0 0-1.6 1.6v12.8A1.6 1.6 0 0 0 8.6 18h9.8a1.6 1.6 0 0 0 1.6-1.6V6.5Z" />
      <path d="M15 2v5h5" />
      <path d="M3 7.6v12.8A1.6 1.6 0 0 0 4.6 22h9.8" />
    </svg>
  )
}

function SourceControlIcon(): React.JSX.Element {
  return (
    <svg className="rail-icon" viewBox="0 0 24 24" aria-hidden="true">
      {/* A branch leaving a trunk: the shape git tooling has settled on. */}
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  )
}

/**
 * What this branch has done, docked beside the transcript.
 *
 * The modal Review sheet answers a narrower question — index versus worktree,
 * once, on mount — and closes when you look away. This one stays open while an
 * agent works, and can compare against the branch the work will merge into,
 * which is the question someone actually asks before pushing.
 *
 * Reads git rather than the event log, for the reason `ReviewPanel` gives: the
 * log records what agents *proposed*, git records what is on disk.
 *
 * Shaped after `TerminalPanel` deliberately — a docked, resizable strip whose
 * state lives in the workspace store rather than here, so it survives the tab
 * switch that unmounts this component.
 */
export function ChangesPanel({
  conversationId,
  panel,
  orientation,
  onHeightChange,
  onWidthChange,
  onListWidthChange,
  onClose,
  onBaseChange,
  onCommittedOnlyChange,
  onSelect,
  onViewChange,
  onColumnChange,
  onToggleExpanded,
  onError,
}: {
  conversationId: string
  panel: ChangesPanelState
  /**
   * Beside the transcript, or under it.
   *
   * Decided by the pane's measured width in `Session` and handed down rather
   * than read from a container query here, so the drag arithmetic and the
   * layout can never disagree about which axis is being resized. A container
   * query would be a second source of truth for the same fact, and the one
   * that the pointer handler cannot see.
   */
  orientation: 'side' | 'under'
  onHeightChange: (height: number) => void
  onWidthChange: (width: number) => void
  onListWidthChange: (listWidth: number) => void
  onClose: () => void
  onBaseChange: (base: string | null) => void
  onCommittedOnlyChange: (committedOnly: boolean) => void
  onSelect: (path: string | null) => void
  onViewChange: (view: ChangesPanelState['view']) => void
  onColumnChange: (column: ChangesPanelState['column']) => void
  onToggleExpanded: (path: string) => void
  onError: (message: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [workspace, setWorkspace] = useState<WorkspaceRead | null>(null)
  const [branches, setBranches] = useState<BranchList['branches']>([])
  const [loading, setLoading] = useState(true)
  const [fetching, setFetching] = useState(false)
  const [saving, setSaving] = useState(false)
  /** A save the disk refused, holding what was typed so it can still be kept. */
  const [conflict, setConflict] = useState<{ path: string; content: string } | null>(null)
  /** Which source-control command is running, so the controls can refuse a second. */
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  /** Paths awaiting the discard confirmation. Null when nothing is being asked. */
  const [discarding, setDiscarding] = useState<string[] | null>(null)
  const element = useRef<HTMLElement | null>(null)

  /*
   * Which read is the current one.
   *
   * Changing the base fires a read, and the watcher can fire another while it is
   * still in flight. Without this, the slower of the two wins and the panel
   * shows a diff against a base nobody selected — the same class of bug as a
   * stale terminal epoch, one layer up.
   */
  const generation = useRef(0)

  const refresh = useCallback((): void => {
    const mine = ++generation.current
    setLoading(true)
    window.chorus
      .readWorkspace({
        conversationId,
        ...(panel.base === null ? {} : { base: panel.base }),
        ...(panel.committedOnly ? { committedOnly: true } : {}),
        /*
         * Only the hunks view reads a hunk.
         *
         * The editor view aligns two whole files fetched through
         * `workspace:fileVersions`, so every line object built for it was
         * parsed, validated on both sides of the IPC boundary, cloned, and
         * rendered nowhere. Measured on Chorus itself at 26 files and 3,272
         * diff lines. The file list is unaffected: it needs `path`, `status`
         * and the two counts, and those still come back for every file.
         */
        ...(panel.view === 'hunks' ? {} : { hunks: false }),
      })
      .then((result) => {
        if (mine !== generation.current) return
        setWorkspace(result)
      })
      .catch((e: unknown) => {
        if (mine !== generation.current) return
        onError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (mine === generation.current) setLoading(false)
      })
  }, [conversationId, panel.base, panel.committedOnly, panel.view, onError])

  useEffect(refresh, [refresh])

  /*
   * Re-read when the repository moves.
   *
   * The push carries only a conversation id — see `WORKSPACE_PUSH_CHANNEL`. This
   * panel knows its own base, so it asks for what it is displaying rather than
   * being handed something main guessed at.
   */
  useEffect(() => {
    return window.chorus.onWorkspaceChanged((push) => {
      if (push.conversationId === conversationId) refresh()
    })
  }, [conversationId, refresh])

  // The branch list changes on a different clock from the diff: only when
  // someone might pick from it.
  useEffect(() => {
    window.chorus
      .readBranches({ conversationId })
      .then((result) => {
        setBranches(result.branches)
      })
      .catch(() => {
        // A missing branch list leaves the picker showing the working tree and
        // whatever base is already selected. Not worth an error banner.
      })
  }, [conversationId])

  /*
   * The diff and the status, reconciled — see `mergeChanges`.
   *
   * The diff alone cannot say what is staged, and never lists untracked files
   * at all, so a panel that offered staging from it could not stage a new file.
   */
  const files = useMemo(
    () => mergeChanges(workspace?.diff ?? [], workspace?.status.files ?? []),
    [workspace]
  )
  /*
   * The selection is a *path*, not a diff entry.
   *
   * Until the tree existed those were the same thing — you could only select
   * something that had changed. Now a file reached through the tree has no diff
   * at all, and that is a legitimate thing to be looking at: the editor shows
   * it with no decorations, which is the honest picture of an unchanged file.
   */
  const selectedPath = panel.selectedPath ?? files[0]?.path ?? null
  /*
   * The raw diff entry, which is a different thing from the merged one.
   *
   * `mergeChanges` produces a row for the *list* — path, counts, staged-ness —
   * and deliberately carries no hunks, because an untracked file has none. The
   * hunks view needs the diff itself, so it looks it up rather than being handed
   * a row that cannot describe one.
   */
  const selectedDiff = (workspace?.diff ?? []).find((f) => f.path === selectedPath) ?? null

  /*
   * The two whole versions of the selected file, fetched per file.
   *
   * Only for the editor view: the hunks view already has everything it needs in
   * the diff, and reading two full files to draw three lines of context would
   * be work nobody asked for.
   */
  /*
   * Tagged with the path they describe, and that tag is load-bearing.
   *
   * This held the versions alone, and nothing cleared them when the selection
   * moved — so `MonacoDiff` mounted for the newly clicked file carrying the
   * *previous* file's text, and depended on a second effect pass to correct
   * itself. That is the same "reads the file you just left" defect the driver's
   * own polls hit three times, and it is the likeliest source of the run in
   * four where the editor showed nothing: the guard inside `MonacoDiff`
   * compares the buffer against what was last loaded, and a foreign baseline is
   * exactly what it cannot tell from an unsaved edit.
   *
   * Tagged rather than cleared on every run: the effect re-runs on every
   * watcher push, and clearing would unmount the editor each time — the churn
   * the guard exists to prevent.
   */
  const [versions, setVersions] = useState<{ path: string; data: FileVersions } | null>(null)
  /*
   * The editor is also what reads a file that has no diff.
   *
   * This was `panel.view === 'editor'` alone, which made the tree half useless:
   * it can open any file in the project, but only the editor can *read* one, so
   * clicking an unchanged file in the hunks view produced "no changes in this
   * file" and nothing else. Browsing a tree is exactly when you want to read
   * something.
   *
   * The saved preference is deliberately **not** changed — a file with hunks
   * still opens as hunks. This only says that when there is no diff to draw, the
   * thing to draw is the file. That is VS Code's own split: the Explorer opens
   * files in an editor, the SCM view opens diffs.
   *
   * It does mean Monaco instantiates on the hunks path for unchanged files.
   * Phase 1 priced that at ~156 ms and made hunks the default *for reviewing a
   * change*; reading a whole file is the case Monaco was kept for.
   */
  /**
   * Which view you came from, which is what decides diff-or-file.
   *
   * **VS Code's actual rule, and the one this got wrong twice.** The Explorer
   * opens a *regular editor*; Source Control opens a *diff*. It is the view you
   * clicked from that decides, not whether the file happens to have changes —
   * an earlier version keyed on `selectedDiff === null`, which meant a changed
   * file opened from the Explorer still came up as a diff. Right for Source
   * Control, wrong for a file browser, and confusing because the same file
   * looked different depending on something invisible.
   */
  const fromTree = panel.column === 'tree'
  const editorMode: 'diff' | 'file' = fromTree || selectedDiff === null ? 'file' : 'diff'
  /** Hunks are a Source Control idea; the Explorer only ever shows the file. */
  const showsHunks = panel.view === 'hunks' && !fromTree && selectedDiff !== null
  const wantsEditor = selectedPath !== null && !showsHunks
  /** Only ever the versions of the file actually selected. */
  const shown = versions !== null && versions.path === selectedPath ? versions.data : null

  useEffect(() => {
    // No `selectedPath === null` here: `wantsEditor` already carries it, and
    // TypeScript narrows through the alias — restating it is dead code the
    // linter can prove.
    if (!wantsEditor) {
      setVersions(null)
      return
    }
    let cancelled = false
    window.chorus
      .readFileVersions({
        conversationId,
        path: selectedPath,
        ...(panel.base === null ? {} : { base: panel.base }),
        ...(panel.committedOnly ? { committedOnly: true } : {}),
      })
      .then((result) => {
        if (!cancelled) setVersions({ path: selectedPath, data: result })
      })
      .catch((e: unknown) => {
        if (!cancelled) onError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
    // `workspace` is in the deps so a push that changes the file re-reads it —
    // otherwise the list updates and the editor keeps showing the old text.
  }, [
    conversationId,
    selectedPath,
    panel.base,
    panel.committedOnly,
    wantsEditor,
    workspace,
    onError,
  ])
  const totals = files.reduce(
    (acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }),
    { added: 0, removed: 0 }
  )

  /**
   * How wide the panel is allowed to get *right now*.
   *
   * `CHANGES_WIDTH.max` is a constant and the pane is not, so the static clamp
   * alone would let a drag in a pane barely over the threshold leave the
   * transcript at a couple of hundred pixels. Read from the parent on each
   * drag rather than stored, because a window resize moves it and a stale
   * ceiling is worse than none.
   */
  const widthCeiling = (): number => {
    const pane = element.current?.parentElement?.clientWidth ?? 0
    if (pane === 0) return CHANGES_WIDTH.max
    return Math.max(CHANGES_WIDTH.min, Math.min(CHANGES_WIDTH.max, pane - TRANSCRIPT_MIN_WIDTH))
  }

  /**
   * The divider between the file list and the diff.
   *
   * Same trade as `startResize` above and for the same reason: the width is
   * written straight to the element on each pointer move, and the store hears
   * once on release. A store write per move re-renders the diff beside it,
   * which is the most expensive thing on the panel.
   *
   * Not inverted, unlike the panel's own grip — this divider is to the *right*
   * of what it sizes, so dragging right grows the list.
   */
  const startListResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    const startX = event.clientX
    const startWidth = panel.listWidth
    const node = element.current
    event.currentTarget.setPointerCapture(event.pointerId)
    let latest = startWidth

    const move = (e: PointerEvent): void => {
      latest = Math.min(
        Math.max(startWidth + (e.clientX - startX), CHANGES_LIST.min),
        CHANGES_LIST.max
      )
      node?.style.setProperty('--changes-list', `${String(latest)}px`)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      onListWidthChange(latest)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    const startY = event.clientY
    const startX = event.clientX
    const startHeight = panel.height
    const startWidth = panel.width
    const side = orientation === 'side'
    const ceiling = widthCeiling()
    const node = element.current
    event.currentTarget.setPointerCapture(event.pointerId)
    let latest = side ? startWidth : startHeight

    const move = (e: PointerEvent): void => {
      // Both deltas are inverted: the grip is on the edge nearest the
      // transcript, so dragging *away* from the panel's body is what grows it.
      latest = side
        ? Math.min(Math.max(startWidth - (e.clientX - startX), CHANGES_WIDTH.min), ceiling)
        : Math.min(
            Math.max(startHeight - (e.clientY - startY), CHANGES_HEIGHT.min),
            CHANGES_HEIGHT.max
          )
      // Written straight to the element per frame; the store hears once, on
      // release. Same trade as the terminal's grip — a store write per pointer
      // move re-renders the transcript beside it.
      node?.style.setProperty(side ? '--changes-width' : '--changes-height', `${String(latest)}px`)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (side) onWidthChange(latest)
      else onHeightChange(latest)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /*
   * Saving, and telling the room.
   *
   * The event is appended in main beside the write — see `writeUserFile` — so
   * there is no path here that lands a change without the other agent hearing
   * about it. Nothing is refreshed on success either: the repository watcher
   * fires on our own write like any other, so the panel updates through the
   * channel it already listens on rather than through a second route that could
   * disagree with it.
   */
  /*
   * Returns the digest of what landed, or null when nothing did.
   *
   * Autosave chains off it: without a fresh digest the *second* write of a
   * typing session is refused as stale, because the editor would still be
   * saving against the version its own first write replaced.
   */
  const save = (
    path: string,
    content: string,
    expectedSha: string | null,
    force = false
  ): Promise<string | null> => {
    setSaving(true)
    return window.chorus
      .writeProjectFile({ conversationId, path, content, expectedSha, ...(force ? { force } : {}) })
      .then((result) => {
        if (result.outcome === 'conflict') {
          /*
           * Not an error banner. The file moved, which is a thing that happens
           * in a shared workspace, and the answer is a choice rather than an
           * apology — so it is held as state and rendered with two buttons.
           */
          setConflict({ path, content })
          return null
        }
        setConflict(null)
        if (result.problem !== null) onError(result.problem)
        return result.sha
      })
      .catch((e: unknown) => {
        onError(e instanceof Error ? e.message : String(e))
        return null
      })
      .finally(() => {
        setSaving(false)
      })
  }

  /**
   * Source control, driven from the panel.
   *
   * Every action refreshes on success and *only* on success — the watcher fires
   * for these too, but a staged file changes only the index, which no file on
   * disk reflects, so waiting for the watcher would leave the checkbox looking
   * stuck.
   */
  const runGit = (
    action: 'stage' | 'unstage' | 'discard' | 'commit' | 'push',
    extra: { paths?: string[]; message?: string; setUpstream?: boolean } = {}
  ): void => {
    setBusy(action)
    window.chorus
      .runGitAction({
        conversationId,
        action,
        paths: extra.paths ?? [],
        ...(extra.message === undefined ? {} : { message: extra.message }),
        ...(extra.setUpstream === undefined ? {} : { setUpstream: extra.setUpstream }),
      })
      .then((result) => {
        if (result.problem !== null) {
          onError(result.problem)
          return
        }
        if (action === 'commit') setMessage('')
        refresh()
      })
      .catch((e: unknown) => {
        onError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        setBusy(null)
      })
  }

  const staged = files.filter((f) => f.staged)
  const unstaged = files.filter((f) => !f.staged)

  const fetchRemote = (): void => {
    setFetching(true)
    window.chorus
      .fetchRemote({ conversationId })
      .then((result) => {
        if (result.problem !== null) onError(result.problem)
        refresh()
      })
      .catch((e: unknown) => {
        onError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        setFetching(false)
      })
  }

  /** One folder-grouped list, used for the staged and unstaged groups alike. */
  const renderRows = (group: typeof files): React.JSX.Element[] =>
    changeRows(group).map((row) =>
      row.kind === 'dir' ? (
        <div
          key={`d:${row.path}`}
          className="changes-tree-row changes-tree-row--dir"
          style={{ ['--depth' as string]: String(row.depth) }}
          title={row.path}
        >
          <span className="changes-tree-twist" aria-hidden>
            ▾
          </span>
          <span className="changes-tree-name">{row.label}</span>
        </div>
      ) : (
        <div
          key={row.path}
          className="changes-file"
          style={{ ['--depth' as string]: String(row.depth) }}
          data-on={row.path === selectedPath}
          // Carries the state to CSS, which is what strikes through a deletion.
          data-status={row.file?.status ?? 'modified'}
        >
          <button
            type="button"
            className="changes-file-open"
            title={row.path}
            onClick={() => {
              onSelect(row.path)
            }}
          >
            {/*
              The status letter git computed, rather than one inferred from the
              hunks: a rewritten file is all-additions too. `changes.letter.*`
              rather than a fresh key group — the turn card in `Entry.tsx`
              already draws these four letters.
            */}
            <span
              className={`changes-file-mark changes-file-mark--${row.file?.status ?? 'modified'}`}
              // The letter alone is not self-explaining — `C` and `T` least of
              // all, and `!` not at all. VS Code titles these too.
              title={t(`changes.of.${row.file?.status ?? 'modified'}`, { from: '' })}
            >
              {t(`changes.letter.${row.file?.status ?? 'modified'}`)}
            </span>
            {/* The leaf name: the folders above already carry the rest. */}
            <FileIcon path={row.path} />
            <span className="changes-file-path">{row.label}</span>
            <span className="changes-file-counts">
              <span className="added">+{row.file?.added ?? 0}</span>
              <span className="removed">−{row.file?.removed ?? 0}</span>
            </span>
          </button>
          {/*
            Discard is the only control here that destroys work, so it is the
            only one behind a confirmation — and it names the file, because
            "are you sure" without a subject is a dialog people learn to click
            through.
          */}
          <button
            type="button"
            className="changes-discard"
            disabled={busy !== null}
            aria-label={t('changesPanel.discardOne', { path: row.path })}
            onClick={() => {
              setDiscarding([row.path])
            }}
          >
            ⟲
          </button>
          {/*
            Stage and unstage as `+` and `−`, the way VS Code's inline actions
            do it.

            **This was a checkbox**, on the argument that staging is the inverse
            of itself and nothing it does destroys work — which is true, and was
            not the problem. A checkbox reads as a *selection*: it looks like it
            marks rows for some later action, and the later action is what a
            reader then goes looking for. `+` and `−` say the row is being acted
            on now.

            Still one control rather than two, because the two are never both
            available: a staged file can only be unstaged and an unstaged one
            can only be staged. Showing both and disabling one would be a menu
            of a single option.

            **On the trailing edge, after discard.** That is where VS Code keeps
            its inline actions, and it is the better place for a second reason:
            leading it put the control someone presses *often* in front of the
            filename they are reading, so every row began with a button rather
            than with what the row is about.
          */}
          <button
            type="button"
            className="changes-stage"
            data-staged={row.file?.staged === true}
            disabled={busy !== null}
            aria-label={t(
              row.file?.staged === true ? 'changesPanel.unstage' : 'changesPanel.stage'
            )}
            title={t(row.file?.staged === true ? 'changesPanel.unstage' : 'changesPanel.stage')}
            onClick={() => {
              runGit(row.file?.staged === true ? 'unstage' : 'stage', { paths: [row.path] })
            }}
          >
            {row.file?.staged === true ? '−' : '+'}
          </button>
        </div>
      )
    )

  return (
    <section
      ref={element}
      className="changes-panel"
      /*
       * Which axis this panel is sized along. CSS reads it too, so the grip's
       * edge and the drag's arithmetic come from one attribute rather than
       * from a media query and a prop that could drift apart.
       */
      data-orientation={orientation}
      /*
       * Too narrow for a full-width file list, so the list column gives way.
       *
       * Read from the stored width rather than measured, so it flips on
       * release rather than mid-drag — one reflow of the body at the end of a
       * gesture instead of one every frame across the threshold. Only reachable
       * while the panel is beside the transcript; under it, the panel is as
       * wide as the pane.
       */
      data-narrow={orientation === 'side' && panel.width < CHANGES_NARROW_BELOW}
      style={{
        ['--changes-height' as string]: `${String(panel.height)}px`,
        ['--changes-width' as string]: `${String(panel.width)}px`,
        ['--changes-list' as string]: `${String(panel.listWidth)}px`,
      }}
      aria-label={t('changesPanel.heading')}
    >
      <div
        className="changes-grip"
        role="separator"
        aria-orientation={orientation === 'side' ? 'vertical' : 'horizontal'}
        aria-label={t('changesPanel.resize')}
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={(e) => {
          if (orientation === 'side') {
            // Same ceiling the drag respects, so the keys cannot reach a width
            // the pointer is refused.
            const ceiling = widthCeiling()
            if (e.key === 'ArrowLeft') onWidthChange(Math.min(panel.width + 24, ceiling))
            if (e.key === 'ArrowRight') onWidthChange(Math.max(panel.width - 24, CHANGES_WIDTH.min))
            return
          }
          if (e.key === 'ArrowUp') onHeightChange(Math.min(panel.height + 24, CHANGES_HEIGHT.max))
          if (e.key === 'ArrowDown') onHeightChange(Math.max(panel.height - 24, CHANGES_HEIGHT.min))
        }}
      />

      <header className="changes-head">
        <strong className="changes-title">{t('changesPanel.heading')}</strong>

        <label className="changes-base">
          {/*
            `sr-only`, not `visually-hidden` — the latter is not a class this
            stylesheet defines, and never was. An undefined class is not an
            error at any layer: the span rendered at full size inside a flex
            header, pushed the toolbar sideways and clipped the last control off
            the right edge. It looked like a layout bug in the header and was a
            typo in a label nobody was supposed to see.
          */}
          <span className="sr-only">{t('changesPanel.base')}</span>
          <select
            value={panel.base ?? ''}
            onChange={(e) => {
              onBaseChange(e.target.value === '' ? null : e.target.value)
            }}
          >
            <option value="">{t('changesPanel.workingTree')}</option>
            {branches.map((branch) => (
              <option key={branch.name} value={branch.name}>
                {branch.name}
                {branch.head ? ' •' : ''}
              </option>
            ))}
          </select>
        </label>

        {panel.base !== null && (
          <label className="changes-committed">
            <input
              type="checkbox"
              checked={panel.committedOnly}
              onChange={(e) => {
                onCommittedOnlyChange(e.target.checked)
              }}
            />
            {t('changesPanel.committedOnly')}
          </label>
        )}

        {/*
          The branch, and how far it has drifted from its upstream.

          `ahead`/`behind` come off `# branch.ab`. They answer a different
          question from the base picker: that one is "what has this branch
          done", this is "have I pushed it". Hidden at zero rather than shown
          as ↑0 ↓0, and absent entirely with no upstream — which is when the
          counts mean nothing rather than zero.
        */}
        <span className="changes-branch" title={workspace?.status.upstream ?? undefined}>
          {workspace?.status.branch ?? t('changesPanel.detached')}
          {workspace !== null && workspace.status.ahead > 0 && (
            <span className="changes-ahead">{`↑${String(workspace.status.ahead)}`}</span>
          )}
          {workspace !== null && workspace.status.behind > 0 && (
            <span className="changes-behind">{`↓${String(workspace.status.behind)}`}</span>
          )}
        </span>
        <span className="changes-totals">
          <span className="added">+{totals.added}</span>{' '}
          <span className="removed">−{totals.removed}</span>
        </span>

        <button
          type="button"
          className="btn btn--quiet"
          onClick={fetchRemote}
          disabled={fetching}
          title={t('changesPanel.fetchHint')}
        >
          {t('changesPanel.fetch')}
        </button>
        {/*
          Hidden in the Explorer, where it would be a control that does nothing.
          There are no hunks to show for a file browser — VS Code has no such
          toggle there either — and a button that stays visible while its effect
          is ignored teaches people the panel is unreliable.
        */}
        {!fromTree && (
          <button
            type="button"
            className="btn btn--quiet"
            aria-pressed={panel.view === 'hunks'}
            onClick={() => {
              onViewChange(panel.view === 'editor' ? 'hunks' : 'editor')
            }}
          >
            {t(panel.view === 'editor' ? 'changesPanel.showHunks' : 'changesPanel.showEditor')}
          </button>
        )}
        <button type="button" className="btn btn--quiet" onClick={refresh} disabled={loading}>
          {t('changesPanel.refresh')}
        </button>
        <button
          type="button"
          className="btn btn--quiet"
          onClick={onClose}
          aria-label={t('changesPanel.close')}
        >
          ✕
        </button>
      </header>

      {workspace?.problem != null && (
        <p className="notice notice--bad" role="alert">
          {workspace.problem}
        </p>
      )}

      {/*
        The file moved while it was open, so the save was refused. Two buttons
        and no default: Reload throws away what was typed, Overwrite throws away
        what arrived, and neither is safe enough to pick for someone.
      */}
      {conflict !== null && (
        <p className="notice notice--bad changes-conflict" role="alert">
          <span>{t('changesPanel.conflict', { path: conflict.path })}</span>
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => {
              setConflict(null)
              refresh()
            }}
          >
            {t('changesPanel.conflictReload')}
          </button>
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => {
              // `save` reports its own failures through `onError`; the digest it
              // returns is only useful to the editor, which is not this button.
              void save(conflict.path, conflict.content, null, true)
            }}
          >
            {t('changesPanel.conflictOverwrite')}
          </button>
        </p>
      )}

      {/*
        Discard names what it will destroy. "Are you sure" without a subject is
        a dialog people learn to click through, and this is the one action here
        with no git-side recovery.
      */}
      {discarding !== null && (
        <p className="notice notice--bad changes-conflict" role="alert">
          <span>
            {t('changesPanel.discardConfirm', {
              count: discarding.length,
              path: discarding[0] ?? '',
            })}
          </span>
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => {
              setDiscarding(null)
            }}
          >
            {t('changesPanel.discardCancel')}
          </button>
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => {
              const paths = discarding
              setDiscarding(null)
              runGit('discard', { paths })
            }}
          >
            {t('changesPanel.discardConfirmAction')}
          </button>
        </p>
      )}

      {loading && workspace === null ? (
        <p className="muted changes-empty">{t('changesPanel.loading')}</p>
      ) : (
        <div className="changes-body">
          <div className="changes-column">
            {/*
              An activity rail, the way VS Code switches its side bar.

              Two text tabs said "Changed 2 | Files", which read as two lists of
              the same kind. They are not: one is the project and one is what
              this branch did to it. VS Code separates them into Explorer and
              Source Control and switches with an icon rail, and the rail is
              what carries that — an icon per *view*, one selected, the count
              riding on Source Control as a badge rather than in a tab label.

              `tablist` is kept rather than swapped for a listbox: the thing
              being switched is which panel body shows, which is what tabs are.
              The rail is a visual arrangement of tabs, not a different control.
            */}
            <div
              className="changes-activity"
              role="tablist"
              aria-orientation="vertical"
              aria-label={t('changesPanel.views')}
            >
              <button
                type="button"
                role="tab"
                className="changes-activity-btn"
                aria-selected={panel.column === 'tree'}
                title={t('changesPanel.columnTree')}
                aria-label={t('changesPanel.columnTree')}
                onClick={() => {
                  onColumnChange('tree')
                }}
              >
                <ExplorerIcon />
              </button>
              <button
                type="button"
                role="tab"
                className="changes-activity-btn"
                aria-selected={panel.column === 'changed'}
                title={t('changesPanel.columnChanged')}
                aria-label={t('changesPanel.columnChanged')}
                onClick={() => {
                  onColumnChange('changed')
                }}
              >
                <SourceControlIcon />
                {/*
                  The count as a badge, as VS Code does it. Hidden at zero
                  rather than shown as a `0`: an empty badge is a claim that
                  something is waiting, and nothing is.
                */}
                {files.length > 0 && <span className="changes-badge">{files.length}</span>}
              </button>
            </div>

            {panel.column === 'tree' ? (
              <FileTree
                conversationId={conversationId}
                expanded={panel.expanded}
                selectedPath={selectedPath}
                onToggle={onToggleExpanded}
                onSelect={onSelect}
                onError={onError}
              />
            ) : files.length === 0 ? (
              /*
               * Empty is a state of the *column*, not of the panel: a clean
               * tree is exactly when someone wants to browse the project.
               */
              <p className="muted changes-empty">
                {panel.base === null
                  ? workspace?.status.clean === true
                    ? t('changesPanel.clean')
                    : t('changesPanel.untrackedOnly')
                  : t('changesPanel.sameAsBase', { base: panel.base })}
              </p>
            ) : (
              <nav className="changes-files" aria-label={t('changesPanel.files')}>
                {/*
                  Two groups, staged above unstaged, each a folder tree. A
                  heading is drawn only when both groups exist — "Staged" over
                  an empty region is furniture.
                */}
                {staged.length > 0 && (
                  <div className="changes-group">
                    <span className="changes-group-name">{t('changesPanel.staged')}</span>
                    <button
                      type="button"
                      className="btn btn--quiet"
                      disabled={busy !== null}
                      onClick={() => {
                        runGit('unstage', { paths: staged.map((f) => f.path) })
                      }}
                    >
                      {t('changesPanel.unstageAll')}
                    </button>
                  </div>
                )}
                {staged.length > 0 && renderRows(staged)}

                {staged.length > 0 && unstaged.length > 0 && (
                  <div className="changes-group">
                    <span className="changes-group-name">{t('changesPanel.unstaged')}</span>
                    <button
                      type="button"
                      className="btn btn--quiet"
                      disabled={busy !== null}
                      onClick={() => {
                        runGit('stage', { paths: unstaged.map((f) => f.path) })
                      }}
                    >
                      {t('changesPanel.stageAll')}
                    </button>
                  </div>
                )}
                {renderRows(unstaged)}
              </nav>
            )}
          </div>

          {/*
            The divider between the list and the diff, and it is draggable.

            The list was a fixed 240px, which truncated nearly every path in a
            real project — a file list whose filenames cannot be read is a list
            of status letters. `separator` with an orientation and arrow keys,
            like the panel's own grip: a control that only answers a pointer is
            one a keyboard user does not have.
          */}
          <div
            className="changes-split"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('changesPanel.resizeList')}
            tabIndex={0}
            onPointerDown={startListResize}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') {
                onListWidthChange(Math.min(panel.listWidth + 24, CHANGES_LIST.max))
              }
              if (e.key === 'ArrowLeft') {
                onListWidthChange(Math.max(panel.listWidth - 24, CHANGES_LIST.min))
              }
            }}
          />

          <div className="changes-right">
            <div className="changes-diff">
              {/*
                Hunks when there are hunks; the file itself when there are not.
                The `wantsEditor` comment above carries the reasoning — the two
                conditions have to agree, or the content is fetched and never
                drawn, or drawn and never fetched.
              */}
              {selectedPath === null ? null : showsHunks ? (
                <FileDiff file={selectedDiff} path={selectedDiff.path} />
              ) : shown === null ? (
                <p className="muted changes-empty">{t('changesPanel.loading')}</p>
              ) : shown.problem !== null ? (
                <p className="notice notice--bad" role="alert">
                  {shown.problem}
                </p>
              ) : (
                /* Keyed by path so the host element is stable per file. */
                <MonacoDiff
                  /*
                   * Keyed by mode as well as path: the two are different
                   * widgets, and a key change remounts rather than swapping one
                   * for the other inside an effect. It only fires when a file
                   * crosses between changed and unchanged.
                   */
                  key={`${selectedPath}:${editorMode}`}
                  path={selectedPath}
                  original={shown.original}
                  modified={shown.modified}
                  sha={shown.sha}
                  // No diff entry means nothing to compare — the Explorer case.
                  mode={editorMode}
                  onSave={(content, expectedSha) => save(selectedPath, content, expectedSha)}
                  /*
                   * Paused while a conflict is open. The file has moved, so
                   * every write fails the same check, and retrying once a
                   * second would turn one question into a stream of them.
                   */
                  autoSave={conflict === null}
                />
              )}
            </div>

            {/*
              The commit box sits under the diff rather than above the file
              list. VS Code puts it at the top because its panel is a tall
              column; this one is a wide strip, and the thing you read before
              committing is the diff.
            */}
            <form
              className="changes-commit"
              onSubmit={(e) => {
                e.preventDefault()
                if (message.trim() !== '' && staged.length > 0) runGit('commit', { message })
              }}
            >
              <input
                type="text"
                value={message}
                placeholder={t('changesPanel.commitPlaceholder', {
                  branch: workspace?.status.branch ?? '',
                })}
                onChange={(e) => {
                  setMessage(e.target.value)
                }}
              />
              <button
                type="submit"
                className="btn"
                disabled={busy !== null || message.trim() === '' || staged.length === 0}
                title={staged.length === 0 ? t('changesPanel.nothingStaged') : undefined}
              >
                {t('changesPanel.commit')}
              </button>
              <button
                type="button"
                className="btn btn--go"
                disabled={busy !== null}
                onClick={() => {
                  // No upstream yet makes this a publish rather than a push,
                  // and git needs telling which.
                  runGit('push', { setUpstream: workspace?.status.upstream === null })
                }}
              >
                {workspace?.status.upstream == null
                  ? t('changesPanel.publish')
                  : t('changesPanel.push')}
              </button>
            </form>
          </div>
        </div>
      )}

      <footer className="changes-foot">
        {saving && <span className="hint changes-saving">{t('changesPanel.saving')}</span>}
        <span className="hint">
          {workspace?.comparison == null
            ? t('changesPanel.sourceWorking')
            : t('changesPanel.sourceBase', {
                base: workspace.comparison.base,
                // Seven characters is what git itself abbreviates to, and the
                // panel has to be able to say which commit it compared against.
                commit: workspace.comparison.mergeBase.slice(0, 7),
              })}
        </span>
      </footer>
    </section>
  )
}
