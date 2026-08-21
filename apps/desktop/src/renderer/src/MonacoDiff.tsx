import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { CHORUS_DARK, defineThemes, languageFor, monaco, themeNow } from './monaco-setup.js'
import type { FileVersionShape } from '../../shared/ipc.js'

/**
 * How long a pause counts as "stopped typing".
 *
 * VS Code's own `files.autoSaveDelay`. Shorter turns a sentence into several
 * writes and several `file.edited.byUser` events, each of which `catchup.ts`
 * replays to the other agent; longer and the file on disk lags visibly behind
 * what is on screen, which is the thing autosave is for.
 */
const AUTOSAVE_PAUSE_MS = 1_000

/**
 * One file's change, as a real editor draws it.
 *
 * `FileDiff` renders the hunks git produced — three lines of context and no
 * way to see what is above them. This takes both whole files and lets Monaco
 * align them, which is what buys scrolling through the rest of the file,
 * folding the unchanged parts, and a minimap of where the changes are.
 *
 * **The modified side is editable; the original never is.** The original is a
 * commit — there is nothing to save it to, and an editable pane that silently
 * discarded what you typed would be worse than a locked one. `⌘S` saves the
 * modified side through `onSave`, which is the only path in the app that writes
 * into a project tree.
 */
export function MonacoDiff({
  path,
  original,
  modified,
  sha,
  onSave,
  autoSave,
  mode,
}: {
  path: string
  original: FileVersionShape
  modified: FileVersionShape
  /** The digest of the text being loaded, echoed back on save. */
  sha: string | null
  /**
   * Saves the buffer, with the digest of what this editor actually loaded.
   *
   * The digest comes from here rather than from the panel's latest read on
   * purpose: the panel re-reads whenever the repository moves, so by the time
   * you press ⌘S its `sha` may describe a version this editor never showed.
   * Saving against that would defeat the conflict check exactly when it
   * matters.
   */
  onSave?: ((content: string, expectedSha: string | null) => Promise<string | null>) | undefined
  /**
   * Write on a pause in typing, rather than only on `⌘S`.
   *
   * Off while a conflict is unresolved: the file has moved, every write will be
   * refused for the same reason, and retrying once a second turns one question
   * into a stream of them. The user answers the conflict, and this resumes.
   */
  autoSave?: boolean | undefined
  /**
   * A diff of two versions, or one file on its own.
   *
   * **A file with nothing to compare does not belong in a diff widget.** Monaco's
   * inline diff draws an original *and* a modified line-number column, so an
   * unchanged file opened from the Explorer numbered every line twice — `1 1`,
   * `2 2`, `3 3`. Hiding the second gutter in CSS would paper over the real
   * fault, which is the wrong widget: VS Code opens a plain editor from the
   * Explorer and a diff from Source Control, and so does this.
   *
   * Fixed for the life of the editor and keyed by the caller, so a file that
   * starts changing gets a fresh editor rather than a widget swapped underneath
   * it.
   */
  mode: 'diff' | 'file'
}): React.JSX.Element {
  const { t } = useTranslation()
  const host = useRef<HTMLDivElement | null>(null)

  /*
   * `onSave` through a ref, read at keystroke time.
   *
   * The command is registered once with the editor, so a callback captured then
   * would be the first render's — saving against a stale path after the user
   * clicked another file. This is the `useCallback`-dependency trap CLAUDE.md
   * records, in the one shape where the dependency array cannot fix it.
   */
  const save = useRef(onSave)
  save.current = onSave
  const autoSaveOn = useRef(autoSave !== false)
  autoSaveOn.current = autoSave !== false
  /** The pending autosave, so a keystroke can push it back and unmount can flush it. */
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * Write the buffer, and remember the digest of what was written.
   *
   * One path for both `⌘S` and autosave, so the digest chaining cannot be right
   * in one and missing in the other — which is exactly the shape of bug that
   * would only show up on the *second* save.
   *
   * Refs only, so `[]` is honest and the function is stable enough to register
   * with the editor once.
   */
  const flush = useCallback(() => {
    const modified = writable()
    const write = save.current
    if (modified === null || write === undefined) return
    const content = modified.getValue()
    const was = loaded.current
    /*
     * Nothing has been loaded, so there is nothing to save — and saving anyway
     * is actively harmful.
     *
     * A freshly created editor has an empty buffer until the model-feeding
     * effect runs. Without this guard the unmount flush fired on every file
     * switch that happened inside that window and sent `('', null)`: empty
     * content, claiming the file did not exist. The write is refused as a
     * conflict rather than truncating anything — but a spurious conflict
     * disables autosave, puts a banner over the panel, and cascades. It cost
     * four assertions in `changes-panel.mjs` and looked like a rendering bug.
     *
     * The narrower reading matters: `was === null` is "no baseline", which is
     * not the same as "the baseline is empty".
     */
    if (was === null) return
    // Nothing moved since the last write or read: a no-op save would still
    // append a log event, which sends the other agent to re-read for nothing.
    if (was.modified === content) return
    void write(content, was.sha).then((written) => {
      if (written === null) return
      loaded.current = { original: was.original, modified: content, sha: written }
    })
  }, [])

  /*
   * The editor is built once and *fed* on later renders.
   *
   * Rebuilding it per file would throw away scroll position, folding and the
   * worker's computed alignment on every click in the file list. The models are
   * what change; `setModel` is the cheap operation Monaco is designed around.
   */
  const editor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  /** The plain editor, in `file` mode. Exactly one of the two is ever set. */
  const plain = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)

  /**
   * The editable editor, whichever kind is mounted.
   *
   * Save, autosave and the keybinding all want "the thing holding the text the
   * user can change" — the modified side in a diff, the editor itself on its
   * own. Asked once here so that difference does not spread.
   */
  const writable = (): monaco.editor.IStandaloneCodeEditor | null =>
    plain.current ?? editor.current?.getModifiedEditor() ?? null

  useEffect(() => {
    const element = host.current
    if (element === null) return

    defineThemes()

    if (mode === 'file') {
      /*
       * One file, one gutter — the Explorer case, and the whole reason for the
       * mode. A diff of a file against itself renders two identical line-number
       * columns, which is what this avoids by not being a diff at all.
       */
      const only = monaco.editor.create(element, {
        readOnly: false,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 12,
        theme: themeNow(),
      })
      plain.current = only
      const command = only.addAction({
        id: 'chorus.save',
        label: 'Save',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: () => {
          flush()
        },
      })
      const typing = only.onDidChangeModelContent(() => {
        if (!autoSaveOn.current) return
        if (pending.current !== null) clearTimeout(pending.current)
        pending.current = setTimeout(() => {
          pending.current = null
          flush()
        }, AUTOSAVE_PAUSE_MS)
      })
      const light = window.matchMedia('(prefers-color-scheme: light)')
      const redraw = (): void => {
        defineThemes()
        monaco.editor.setTheme(themeNow())
      }
      light.addEventListener('change', redraw)
      return () => {
        if (pending.current !== null) {
          clearTimeout(pending.current)
          pending.current = null
          flush()
        }
        typing.dispose()
        command.dispose()
        light.removeEventListener('change', redraw)
        const model = only.getModel()
        only.dispose()
        model?.dispose()
        plain.current = null
        /*
         * The editor is gone, so nothing is loaded any more.
         *
         * `loaded` describes what is in *this* editor; disposing it invalidates
         * that, and leaving the ref set is what broke the plain editor under
         * StrictMode. React double-invokes effects in development only, so:
         * mount, feed the model, set `loaded`, dispose, remount. The second
         * editor is new and empty — but `monaco.editor.create` gives it a
         * *default empty model* rather than none, so the guard below saw a live
         * model and a `loaded` that already matched the incoming text, decided
         * nothing had changed, and returned. The file never arrived.
         *
         * The diff editor escaped it by accident: `createDiffEditor` starts
         * with `getModel() === null`, so its guards were skipped and it re-fed.
         * That is why this only ever showed up in `pnpm dev`, and why a
         * production build looked fine.
         */
        loaded.current = null
      }
    }

    const instance = monaco.editor.createDiffEditor(element, {
      // The modified side only. `originalEditable: false` keeps the commit
      // locked — there is nowhere to save it to.
      readOnly: false,
      originalEditable: false,
      automaticLayout: true,
      /*
       * Side by side, but only when there is room — VS Code's own behaviour.
       *
       * **Measured: it never has room, and that is the correct outcome.**
       * `CHANGES_WIDTH.max` is 820 and the editor measured 347px at a default
       * panel, both under the 900px breakpoint — so this resolves to inline
       * every time, which is precisely what VS Code renders in a pane this
       * narrow. The setting is faithful and currently inert.
       *
       * Kept rather than reverted to a hardcoded `false` for two reasons: it
       * states the rule instead of one of its outcomes, and it starts working
       * on its own if the panel's max width ever rises above 900. A bare
       * `false` would silently keep inline forever and nobody would know why.
       *
       * Do not "fix" this by lowering the breakpoint. Two ~400px columns of
       * code at the panel's maximum is worse than one 820px column, and
       * diverging from 900 would be diverging from the thing being matched.
       */
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: true,
      renderSideBySideInlineBreakpoint: 900,
      /*
       * Fold the unchanged middle. Defaults to OFF in the library, which is why
       * a diff of one line in a 500-line file scrolled like a 500-line file.
       * The four numbers are VS Code's, not chosen here.
       */
      hideUnchangedRegions: {
        enabled: true,
        contextLineCount: 3,
        minimumLineCount: 3,
        revealLineCount: 20,
      },
      // The panel is a docked strip, not a full window: a minimap and a
      // scrollbar overview would take a third of the width it has.
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 12,
      theme: themeNow(),
    })
    editor.current = instance

    /*
     * Repaint on a colour-scheme change, the same way `TerminalView` does.
     *
     * Monaco holds resolved hex, so a scheme change is invisible to it — this
     * is the listener whose absence made the terminal draw on black in both
     * schemes, and it is cheaper to copy than to rediscover.
     */
    const scheme = window.matchMedia('(prefers-color-scheme: light)')
    const repaint = (): void => {
      defineThemes()
      monaco.editor.setTheme(themeNow())
    }
    scheme.addEventListener('change', repaint)

    /*
     * ⌘S on the editable side.
     *
     * Registered on the modified editor rather than on the document, so it
     * fires only while the caret is in the buffer — a document-level handler
     * would swallow ⌘S from the composer, and from a terminal that wants to
     * send it to a shell.
     */
    const saveCommand = instance.getModifiedEditor().addAction({
      id: 'chorus.save',
      label: 'Save',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      // Through `flush` rather than calling `save` directly, so a manual save
      // updates the digest the same way an automatic one does.
      run: () => {
        flush()
      },
    })

    /*
     * Autosave: a pause in typing, not a keystroke.
     *
     * ~1s of quiet, which is VS Code's own `afterDelay`. Per keystroke would
     * write to disk and append a `file.edited.byUser` event per character —
     * every one of which `catchup.ts` replays to the other agent — so the
     * debounce is not a nicety, it is what keeps the log readable.
     *
     * **`loaded.current` is updated with what was written, digest included.**
     * That is the whole of why this is safe. The model-feeding guard below
     * skips a re-read when the buffer differs from what was loaded, so without
     * this the editor would be permanently "dirty" against a stale baseline and
     * would ignore a genuine change made by an agent. Updating it keeps the
     * next external write detectable, and hands the next save a digest that is
     * not already superseded.
     */
    const autoSaving = instance.getModifiedEditor().onDidChangeModelContent(() => {
      if (!autoSaveOn.current) return
      if (pending.current !== null) clearTimeout(pending.current)
      pending.current = setTimeout(() => {
        pending.current = null
        flush()
      }, AUTOSAVE_PAUSE_MS)
    })

    return () => {
      /*
       * Flush before unmounting, or a file switched away from inside the
       * debounce window loses whatever was typed in it — the one failure an
       * editor may not have.
       */
      if (pending.current !== null) {
        clearTimeout(pending.current)
        pending.current = null
        flush()
      }
      autoSaving.dispose()
      saveCommand.dispose()
      scheme.removeEventListener('change', repaint)
      // Both models are ours, and disposing the editor does not dispose them:
      // left alone they accumulate, one pair per file ever opened.
      const models = instance.getModel()
      instance.dispose()
      models?.original.dispose()
      models?.modified.dispose()
      editor.current = null
      // Same invariant as the plain editor's cleanup above: a disposed editor
      // holds nothing, so what `loaded` remembers is no longer true of it.
      loaded.current = null
    }
    // `mode` decides which widget exists, so it belongs here even though the
    // caller keys on it too — a dependency list that lies is worse than a
    // redundant one.
  }, [mode, flush])

  /**
   * What was last loaded into each side, so an unchanged re-read does nothing.
   *
   * The panel re-reads whenever the repository moves — its own save, any
   * agent's write, a `git add` from a terminal — and each read arrives as a new
   * object, so this effect runs far more often than the file actually changes.
   * Without this it disposes and re-creates both models every time, which
   * throws away the caret, the scroll position, and any unsaved typing.
   *
   * It also broke rendering outright: re-creating models while the worker is
   * mid-diff discards the computation, and the panel drew an editor with no
   * decorations and sometimes no lines at all. That is what this guard was
   * found to fix — the first version compared the *buffer* against what was
   * loaded, which sounds like the same thing and is not, because it also
   * blocked the legitimate update and left the editor empty.
   */
  const loaded = useRef<{ original: string; modified: string; sha: string | null } | null>(null)

  useEffect(() => {
    const instance = editor.current
    const single = plain.current
    if (instance === null && single === null) return
    if (original.kind !== 'text' && modified.kind !== 'text') return

    const incoming = {
      original: original.kind === 'text' ? original.text : '',
      modified: modified.kind === 'text' ? modified.text : '',
      sha,
    }

    /*
     * One model in `file` mode, and the same two questions asked one-sidedly:
     * skip when nothing moved, and never replace a buffer being typed in.
     */
    if (single !== null) {
      const current = single.getModel()
      const was = loaded.current
      if (was !== null && current !== null) {
        if (was.modified === incoming.modified) return
        if (current.getValue() !== was.modified) return
      }
      const next = monaco.editor.createModel(incoming.modified, languageFor(path))
      single.setModel(next)
      loaded.current = incoming
      current?.dispose()
      return
    }
    if (instance === null) return

    const model = instance.getModel()
    /*
     * Both skips below require that something was *already* loaded into a
     * *live* model.
     *
     * That pair is the whole correctness of this guard. An earlier version
     * skipped on a dirty-buffer test alone, which is also true before anything
     * has been loaded — so it blocked the update that puts the file on screen
     * and drew an empty editor with no decorations.
     */
    const was = loaded.current
    if (was !== null && model !== null) {
      // Nothing to do when the file has not actually changed. The panel
      // re-reads on every repository move, so this is most of the calls.
      if (was.original === incoming.original && was.modified === incoming.modified) return

      /*
       * The file moved while there are unsaved edits: leave the buffer alone.
       *
       * Replacing it would discard what the person is typing, silently, which is
       * the one failure an editor may not have. Staying stale is safe *because
       * the save is checked*: `⌘S` carries the digest this editor loaded, so the
       * write is refused with a conflict and the choice is offered there rather
       * than taken here.
       */
      if (model.modified.getValue() !== was.modified) return
    }

    const language = languageFor(path)
    const previous = instance.getModel()
    instance.setModel({
      original: monaco.editor.createModel(incoming.original, language),
      modified: monaco.editor.createModel(incoming.modified, language),
    })
    loaded.current = incoming
    // After `setModel`, not before: disposing a model still attached to the
    // editor leaves it reading a disposed buffer.
    previous?.original.dispose()
    previous?.modified.dispose()
  }, [path, original, modified, sha])

  const unreadable = notText(original) ?? notText(modified)

  return (
    <div className="monaco-diff">
      {unreadable !== null && (
        <p className="muted changes-empty">{t(`changesPanel.${unreadable}`)}</p>
      )}
      <div className="monaco-diff-host" ref={host} data-hidden={unreadable !== null} />
    </div>
  )
}

/**
 * Why a side cannot be shown, or null if it can.
 *
 * `absent` is not a reason: a file added on this branch has no original, and
 * an empty left-hand side is the correct picture of that.
 */
function notText(version: FileVersionShape): string | null {
  if (version.kind === 'binary') return 'binaryFile'
  if (version.kind === 'tooLarge') return 'fileTooLarge'
  return null
}

export { CHORUS_DARK }
