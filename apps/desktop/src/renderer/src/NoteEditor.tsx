import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Extension, InputRule, Node, mergeAttributes } from '@tiptap/core'
import type { Editor, JSONContent } from '@tiptap/core'
import { Placeholder } from '@tiptap/extensions'
import { Color } from '@tiptap/extension-color'
import { TextStyle } from '@tiptap/extension-text-style'
import { DragHandle } from '@tiptap/extension-drag-handle-react'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { NOTE_IMAGE_DRAG_TYPE, NOTE_IMAGE_URL_PREFIX } from './attach.js'
import { NoteImageDialog } from './NoteImageDialog.js'
import { NoteImage } from './note-image.js'
import { resolveNoteImageUrl } from './host-resources.js'
import { useShellOverlay } from './workspace/overlay.js'

/**
 * The note, wherever a note is.
 *
 * **One editor for both notes, and the reason is that they are one thing.** The
 * global note and a project's note differ in where they sit, how wide they are
 * and which chord reaches them — and in nothing else. Two copies of this would
 * be two places to fix the focus trap below, and the second copy is always the
 * one that does not get fixed.
 *
 * What stays outside, in each caller: the box, its position, its width, and the
 * shortcut. What lives here: the document, the bar, images, the selection offer,
 * and every rule about what focus means.
 *
 * ## The dependency, and why it is this size
 *
 * `StarterKit` carries all eleven controls but the image — bold, italic,
 * underline, strike, link, both lists, blockquote, code and code block — so the
 * install is five packages rather than the twenty-five FlowDrive's document
 * editor needs for tables, colour, alignment and task lists. It was measured
 * before it was accepted, which is the rule the Monaco entry in `CLAUDE.md` set.
 *
 * **It does not breach the no-`dangerouslySetInnerHTML` rule**, and that is a
 * property of ProseMirror rather than a promise: a document is a typed tree and
 * the view builds nodes from it. Nothing is interpolated into markup.
 */
export interface NoteEditorProps {
  /**
   * What the registry holds: a serialised document, or the plain string an
   * older build wrote. Null for a note that was never written.
   */
  readonly notes: string | null
  /** Where a selection would be sent, or null when there is nowhere. */
  readonly conversationId: string | null
  readonly placeholder: string
  readonly label: string
  readonly onSave: (notes: string) => void
  readonly onSendSelection: (conversationId: string, text: string) => void
  /**
   * Whether the caret is in it.
   *
   * Reported rather than owned because the caller draws the box, and the box's
   * size is what focus decides. **Not the same as "the editor has focus"** — see
   * `holdsOpen` below.
   */
  readonly onFocusedChange: (focused: boolean) => void
  /** Only when it flips, so a caller can tint a row without re-rendering per key. */
  readonly onEmptyChange: (empty: boolean) => void
  /** Filled in during render, so a caller's shortcut can reach the caret. */
  readonly handle: React.RefObject<NoteEditorHandle | null>
  /**
   * The resize handles, drawn on the box's edges — see the slot in the markup.
   *
   * A node rather than a size and a callback, because this component has no
   * opinion about how big it is: the box is the caller's and so is the drag.
   */
  readonly grips: React.ReactNode
}

/** What a caller's keyboard shortcut needs, and nothing more. */
export interface NoteEditorHandle {
  /**
   * The caret in, or back where it came from.
   *
   * One method rather than the `focus`/`blur`/`isFocused` trio the two shells
   * used to assemble themselves, because the second half of the gesture needs
   * something neither shell can hold: *where focus was* when the note took it.
   * Both chords are the same behaviour and now share one implementation of it.
   */
  readonly toggle: () => void
}

/** Long enough that a sentence is one write rather than thirty. */
const SAVE_DEBOUNCE_MS = 600

/**
 * `---` anywhere a line starts, rather than only in a paragraph of its own.
 *
 * **StarterKit's own rule cannot fire in a note, and that is not a bug in it.**
 * It is `/^(?:---|—-|___\s|\*\*\*\s)$/`, and TipTap matches that against the text
 * of the whole *block* up to the caret — so `^` means the start of a paragraph,
 * not the start of a line. A note is written as one paragraph of hard-broken
 * lines, because that is what pasting anything produces and what Shift+Enter
 * produces, so the anchor is never satisfied and the third hyphen lands as a
 * third hyphen.
 *
 * Two details decide the shape of the looser version:
 *
 * - **A hard break reads as the literal `%leaf%`** — TipTap's stand-in for a
 *   node with no text — which is six characters for something one position wide.
 *   It has to sit in a lookbehind: inside `match[0]` it would fail TipTap's own
 *   re-check, which compares the match against the document's real text and
 *   finds nothing where the break was.
 * - **The indent is inside the match**, because spaces are real text and survive
 *   that check. Consuming them is what stops an indented line leaving its indent
 *   behind as a paragraph of blanks.
 *
 * Only the hyphen forms are loosened. `***` would otherwise take the third
 * keystroke of `***bold***` and turn it into a divider, which is why StarterKit
 * asks for a space after those two and why they are left to it.
 */
const DIVIDER_INPUT = /(?<=^|%leaf%)[ \t\u00a0]*(?:---|—-)$/

const NoteDivider = Extension.create({
  name: 'noteDivider',
  addInputRules() {
    return [
      new InputRule({
        find: DIVIDER_INPUT,
        /*
         * The range is the indent and the dashes, so deleting it first leaves a
         * caret where the line began; `setHorizontalRule` then splits the
         * paragraph around the node, which is what makes a divider possible
         * mid-block at all.
         */
        handler: ({ chain, range }) => {
          chain().deleteRange(range).setHorizontalRule().run()
        },
      }),
    ]
  },
})

/**
 * A box that holds a run of blocks, which is the whole of what a story is here.
 *
 * **A node rather than a mark, and the difference is what it can own.** A mark
 * spans text inside one block; this has to span whole blocks and contain them,
 * so that moving it moves everything in it. `Color` below is the nearby example
 * of the other kind, and colouring three paragraphs is precisely what does *not*
 * make those paragraphs one thing.
 *
 * **`content: 'block+'` is why there is no list of what a box may hold.** Every
 * block this note has — a paragraph, either list, a quote, a code block, an
 * image, a divider — is in `group: 'block'` and is therefore admitted, and so is
 * another box, which is the entirety of nesting. Allowing all of that is the
 * declaration; restricting any of it would be the work.
 *
 * `defining: true` for the reason a blockquote has it: pasting into a box should
 * land inside the box rather than replace it.
 */
const NoteBox = Node.create({
  name: 'noteBox',
  group: 'block',
  content: 'block+',
  defining: true,
  parseHTML() {
    return [{ tag: 'div[data-note-box]' }]
  },
  /* The class is the node's own rather than the stylesheet reaching into
     ProseMirror's markup, so a box copied out of the note still says what it is
     — and the attribute is what parses it back, because a class is a thing a
     paste could carry by accident. */
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-note-box': '', class: 'note-box' }), 0]
  },
})

/**
 * Focus the note, and leave every scroller alone.
 *
 * **TipTap scrolls the caret into view on `focus` by default**, and the nearest
 * scrollable ancestor of a project's note is the transcript underneath it. So
 * clicking into the note — or pressing its chord, or any button on its bar —
 * moved the conversation you were reading. The note is at the top of its own
 * column and is always visible; there is nothing to scroll it into.
 */
const STAY = { scrollIntoView: false } as const

/**
 * What the colour control offers, and deliberately not a picker.
 *
 * **Six and a way back, rather than a wheel.** A note is annotation, and the
 * question it answers is "mark this differently from the rest", not "which of
 * sixteen million". A fixed set also means every note in the app is coloured
 * from the same six, so two people's notes look like the same app.
 *
 * Concrete values rather than tokens, because these are stored *in the
 * document*. A `var()` would make an old note change colour when a token is
 * retuned, and break outright when one is renamed — a note should still read the
 * way it was written.
 */
const NOTE_COLOURS: readonly { readonly id: string; readonly value: string | null }[] = [
  { id: 'default', value: null },
  { id: 'red', value: '#f85149' },
  { id: 'amber', value: '#e9a05c' },
  { id: 'green', value: '#7ec98a' },
  { id: 'blue', value: '#4daafc' },
  { id: 'purple', value: '#c39aef' },
  { id: 'grey', value: '#8b949e' },
]

/**
 * One control on the bar.
 *
 * Declared rather than inferred, because the array is not uniform: only the
 * three that open a group carry `divided`, and an inferred element type would be
 * a union with no such property on the rest.
 */
interface NoteTool {
  readonly id: string
  readonly on: boolean
  readonly divided?: boolean
  readonly run: () => void
}

/**
 * The colour on the mark under the caret, or null.
 *
 * Narrowed rather than cast, and read through a bracket because `getAttributes`
 * answers with an index signature — trusting either would put an untyped value
 * straight into a `style` attribute.
 */
function readColour(attributes: Record<string, unknown>): string | null {
  const colour = attributes['color']
  return typeof colour === 'string' ? colour : null
}

/**
 * Whether the pointer is in a box's own top padding — the strip that takes hold
 * of the box rather than of what the box holds.
 *
 * **Bounded, and that is the whole reason it is written here.** The drag
 * extension's edge test is a half-plane rather than a band: `left` is
 * `coords.x - rect.left < threshold`, true for every point left of a block
 * however far away, and `top` is the same on the other axis. So it cannot express
 * a strip, and both settings were tried and both flipped the target — `left` sent
 * the handle to the box the moment the pointer left the text towards it, and
 * `top` made the upper half of every line belong to the box.
 *
 * The floor is the first child's top rather than a number agreeing with the
 * stylesheet, so the strip is whatever the padding actually is and the two cannot
 * drift apart. The fallback is only for a box the view has no DOM for, which is a
 * box that cannot be pointed at anyway.
 *
 * `unknown` rather than a DOM type because `view.nodeDOM` answers with one, and
 * the name `Node` in this file is ProseMirror's.
 */
function inBoxGrabStrip(box: unknown, first: unknown, y: number): boolean {
  if (!(box instanceof HTMLElement)) return false
  const top = box.getBoundingClientRect().top
  const floor = first instanceof HTMLElement ? first.getBoundingClientRect().top : top + 12
  return y >= top && y < floor
}

/**
 * Bytes as base64, in chunks.
 *
 * `String.fromCharCode(...bytes)` is the one-liner and it throws on anything
 * large: the spread becomes one argument per byte, and a screenshot is past the
 * engine's argument limit.
 */
function base64(bytes: Uint8Array): string {
  const CHUNK = 8192
  let binary = ''
  for (let at = 0; at < bytes.length; at += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK))
  }
  return btoa(binary)
}

/**
 * What a column holds, read as a document.
 *
 * **Converted here rather than by a migration**, which is why neither notes
 * column had to be rewritten: a plain string from an older build is read as one
 * paragraph per line and saved back as a document the next time it is edited.
 * Nothing is lost, nothing is rewritten up front, and a build that rolls back
 * still finds text it can display.
 *
 * A string becomes text nodes rather than being handed to TipTap as content:
 * TipTap reads a bare string as **HTML**, so a note containing `<div>` would come
 * back as a div rather than as the characters somebody typed.
 */
function asDocument(stored: string | null): JSONContent {
  const empty: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] }
  if (stored === null || stored.trim() === '') return empty
  try {
    const parsed: unknown = JSON.parse(stored)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'type' in parsed &&
      parsed.type === 'doc'
    ) {
      return parsed as JSONContent
    }
  } catch {
    /* not a document; it is the plain text an older build wrote */
  }
  return {
    type: 'doc',
    content: stored.split('\n').map((line) => ({
      type: 'paragraph',
      ...(line === '' ? {} : { content: [{ type: 'text', text: line }] }),
    })),
  }
}

export function NoteEditor(props: NoteEditorProps): React.JSX.Element {
  const { t } = useTranslation()
  const [selection, setSelection] = useState<{
    readonly text: string
    readonly left: number
    readonly top: number
  } | null>(null)
  /**
   * Whether the caret is in it, kept here as well as reported.
   *
   * **Both, and that is not duplication.** The caller needs it to size its box;
   * this component needs it to decide whether the bar exists at all. Reporting
   * it and then reading it back as a prop would make the bar depend on a
   * round trip through a parent that has no opinion about it — and when the
   * editor was extracted out of the global note, exactly that gate was left
   * behind, so every note in the window drew a toolbar it was not using.
   */
  const [focused, setFocused] = useState(false)
  /** The insert sheet, with whatever it is doing and whatever went wrong. */
  const [imageDialog, setImageDialog] = useState<{
    readonly busy: boolean
    readonly error: string | null
  } | null>(null)
  /**
   * The image being looked at, by its URL, or null.
   *
   * State rather than a class on the `<img>` ProseMirror drew: the document owns
   * that node and replaces it on the next transaction, taking any attribute
   * written onto it. Drawing a second image over the window leaves the document
   * alone, and is also the only way it can be larger than the note.
   */
  const [zoomed, setZoomed] = useState<string | null>(null)
  /** Whether the swatches are showing. Closed by picking one, or by leaving. */
  const [palette, setPalette] = useState(false)

  /*
   * The note's own surfaces cover the workbench, so the native views have to go
   * down for them — the caller does the same for a box grown over the app, and
   * `useShellOverlay` is refcounted precisely so two callers can both be right.
   */
  useShellOverlay(zoomed !== null || imageDialog !== null)

  const host = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<Editor | null>(null)

  /**
   * Whether one of this note's own surfaces is up, read at blur time.
   *
   * **Losing focus is not the same as being done with the note.** The caller
   * collapses its box on blur, which is right for clicking away and wrong for
   * every control this component puts on screen: the insert sheet takes focus
   * because `useDialog` moves it there deliberately, and the opened image takes
   * it because pressing a button does. Either one closed the note underneath it.
   *
   * A ref rather than state, because `onBlur` is handed to `useEditor` once and
   * closes over the render that built it.
   */
  const holdsOpen = useRef(false)

  /**
   * What had focus when the chord took it, so the chord can give it back.
   *
   * **Only the chord restores, never a click away.** Pressing ⌘N in the composer
   * and pressing it again is one gesture with two halves, and losing the caret
   * in between makes the second half useless — you have to reach for the mouse
   * to carry on typing, which is the whole thing the chord avoids. Clicking out
   * of the note is not that gesture: it already says where focus should go.
   *
   * A ref, because nothing about it is drawn and a render in the middle of a
   * keystroke would be a render nobody asked for.
   */
  const returnTo = useRef<HTMLElement | null>(null)

  /**
   * Put the caret down and give it back to whatever had it.
   *
   * One function rather than two, because pressing the chord again and pressing
   * Escape are the same act with different keys: "I am done with the note". They
   * differ only in what can reach them — the chord is the caller's and listens
   * on the document, Escape is the editor's own and only fires when the caret is
   * actually in here.
   *
   * Reads nothing but refs, so the copy `useEditor` captured on the first render
   * stays correct for every render after it.
   */
  const leave = (): void => {
    const back = returnTo.current
    returnTo.current = null
    editorRef.current?.commands.blur()
    if (back === null) return
    /*
     * **A frame later, and that is not a workaround.** TipTap's `blur` does not
     * blur: it schedules `view.dom.blur()` for the next animation frame and then
     * calls `window.getSelection().removeAllRanges()`. Restoring focus
     * synchronously therefore put the caret in the composer and let that
     * deferred line run afterwards — and Blink exposes a focused `textarea`'s
     * selection through the document's, so clearing every range took the caret
     * straight back out. The field looked unfocused because it effectively was.
     *
     * Callbacks run in the order they were registered, so asking for the frame
     * *after* TipTap did is enough to be last.
     *
     * `isConnected`, because the note can outlive what it took focus from: a
     * composer belongs to a conversation, and that tab can be closed while the
     * note is open. Focusing a detached element does nothing visible and leaves
     * the document with no focus at all.
     */
    requestAnimationFrame(() => {
      if (back.isConnected) back.focus({ preventScroll: true })
    })
  }

  /**
   * Whether a drag grip is being held, which counts as staying in the note.
   *
   * **The grip cannot cancel its own `mousedown` the way the toolbar does.** It
   * is a `draggable` element, and preventing that default is precisely what stops
   * a drag from ever starting — so it takes focus, the editor blurs, and the note
   * collapses under the pointer before the drag has begun.
   *
   * A ref and a document listener rather than a prop, because the handle is a
   * portal the extension renders and owns: there is nowhere to hang a handler on
   * it from here.
   */
  const grabbing = useRef(false)
  /**
   * A class only this editor's grip carries, so the listener can tell them apart.
   *
   * **Without it the listener answers for every note in the window.** It has to
   * be on the document — the handle is a portal the extension owns — and a drop
   * in one note then had every mounted note refocus itself. The last to run kept
   * the caret, so dragging in the global note opened a project's and closed the
   * one being dragged in.
   *
   * Sanitised because `useId` returns colons, which are not a class selector
   * without escaping.
   */
  const mine = `note-drag-${useId().replace(/[^a-zA-Z0-9]/g, '')}`

  /**
   * Where the pointer is, because a drag rule is handed the node, the document
   * and the view — and never the coordinates. See `inBoxGrabStrip`.
   *
   * Capture phase, so it is current before the extension's own `mousemove`
   * handler runs. That handler defers its work to an animation frame and would
   * read a fresh value either way, but relying on that is relying on somebody
   * else's scheduling.
   */
  const pointer = useRef({ x: 0, y: 0 })
  useEffect(() => {
    const move = (event: MouseEvent): void => {
      pointer.current = { x: event.clientX, y: event.clientY }
    }
    document.addEventListener('mousemove', move, true)
    return () => {
      document.removeEventListener('mousemove', move, true)
    }
  }, [])

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<string | null>(null)
  const save = useRef(props.onSave)
  save.current = props.onSave
  const report = useRef(props.onFocusedChange)
  report.current = props.onFocusedChange

  const flush = (): void => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    const value = pending.current
    if (value === null) return
    pending.current = null
    save.current(value)
  }

  const insertImage = (url: string): void => {
    editorRef.current?.chain().focus(null, STAY).setImage({ src: url }).run()
  }

  /**
   * An empty box, which is what the button means when nothing is selected.
   *
   * **Not a wrap of the block the caret happens to be in**, which is what
   * `toggleWrap` does with a collapsed selection: pressing the button in the
   * middle of a sentence would box that sentence, and nobody asked for that. With
   * nothing selected the gesture is "give me a box to drag things into", so it
   * gives one.
   *
   * **Inserted after the enclosing top-level block rather than at the caret**,
   * because inserting a block node at a caret splits the textblock around it —
   * the same sentence, cut in half by a button press. Depth 1 rather than the
   * caret's own depth, so a box made from inside a list lands after the list
   * instead of inside it, where it would be a box nobody can see the edges of.
   *
   * The one block wrapped in place is an empty one. Inserting after it would
   * leave the blank line sitting above the box it was about to become.
   */
  const addBox = (): void => {
    const live = editorRef.current
    if (live === null) return
    const { $from } = live.state.selection
    const chain = live.chain().focus(null, STAY)
    const top = $from.depth === 0 ? null : $from.node(1)
    if (top !== null && top.isTextblock && top.content.size === 0) {
      chain.wrapIn('noteBox').run()
      return
    }
    chain
      .insertContentAt($from.depth === 0 ? $from.pos : $from.after(1), {
        type: 'noteBox',
        content: [{ type: 'paragraph' }],
      })
      .run()
  }

  /**
   * Takes image files off a paste or a drop, if there are any.
   *
   * **Synchronous answer, asynchronous work.** ProseMirror needs to be told
   * immediately whether the event was handled, and the storing round trip cannot
   * be waited for — so this claims the event and inserts when main answers.
   *
   * False for anything that is not an image, and that is load-bearing: claiming
   * every paste would swallow ordinary text.
   */
  const takeImageFiles = (data: DataTransfer | null): boolean => {
    const files = [...(data?.files ?? [])].filter((file) => file.type.startsWith('image/'))
    if (files.length === 0) return false
    void (async () => {
      for (const file of files) {
        try {
          const stored = await window.chorus.addNoteImage({
            data: base64(new Uint8Array(await file.arrayBuffer())),
            extension: file.type.split('/')[1] ?? '',
          })
          insertImage(stored.url)
        } catch {
          /*
           * An unsupported type, or a write that failed. Silent on purpose: this
           * is a paste, not a command, and a dialog in front of somebody who
           * pasted the wrong thing is worse than the image not appearing.
           */
        }
      }
    })()
    return true
  }

  const editor = useEditor({
    /*
     * Seeded once, and the caller is what makes that safe: both notes are
     * mounted only after their row has been read, so there is no null-then-value
     * window for the content to miss.
     */
    content: asDocument(props.notes),
    extensions: [
      /*
       * Headings are off. This is a note, and a heading level in a box that is
       * one line at rest is a control with nothing to structure.
       *
       * **The horizontal rule is on, and it is the one block with no button.**
       * Its whole gesture is typing `---`, so it costs the bar nothing — which is
       * what makes it affordable where a heading was not. The node is this one's;
       * the gesture that reaches it is `NoteDivider` above, because StarterKit's
       * own pattern cannot fire in a note.
       */
      StarterKit.configure({ heading: false }),
      NoteDivider,
      NoteBox,
      Placeholder.configure({ placeholder: props.placeholder }),
      /*
       * `allowBase64` is off deliberately. Every route in stores bytes through
       * main and inserts a URL, so a base64 `src` could only arrive by someone
       * pasting HTML that already had one — and admitting it would put the bytes
       * back in the note's database row.
       */
      NoteImage.configure({ allowBase64: false }),
      /*
       * `TextStyle` is the span `Color` writes into, and it has to be listed —
       * `Color` is a set of commands over someone else's mark rather than a mark
       * of its own, so on its own it has nowhere to put anything.
       */
      TextStyle,
      Color,
    ],
    editorProps: {
      attributes: { 'aria-label': props.label },
      /*
       * Escape leaves the note, keeping what you typed and taking the caret back
       * to wherever it came from.
       *
       * **Not a cancel**, which is what Escape does in the rename fields, and the
       * difference is what the two gestures undo. A rename replaces a name that
       * already existed, so abandoning has something to fall back to. A note has
       * no previous value — the text in the box *is* the note.
       *
       * **The editor's handler and not a second one on the element.** There was
       * a React `onKeyDown` here doing the blur half of this, and leaving it in
       * place broke the restore rather than duplicating it: both fired on one
       * press, so `editor.commands.blur()` ran twice, and TipTap's blur defers a
       * `removeAllRanges()` by a frame. The second one landed after the caret had
       * been handed back and emptied the field's selection again — the exact
       * failure `leave` is written to avoid, arriving from the other direction.
       *
       * Here rather than on the document, because this is the one handler that
       * cannot fire for a note you are not in — four panes are four mounted
       * notes, and a document listener would have every one of them answer a key
       * pressed anywhere. ProseMirror does nothing with Escape, so taking it
       * costs the document no behaviour it had.
       */
      handleKeyDown: (_view, event) => {
        if (event.key !== 'Escape') return false
        leave()
        return true
      },
      /*
       * A pasted or dropped image goes the way a chosen one does. Handled here
       * rather than left to ProseMirror, whose default turns an image file into
       * nothing at all because the schema has no way to hold bytes.
       */
      handlePaste: (_view, event) => takeImageFiles(event.clipboardData),
      handleDrop: (_view, event) => {
        const dropped = event instanceof DragEvent ? event.dataTransfer : null
        return takeImageFiles(dropped)
      },
    },
    onUpdate: ({ editor: changed }) => {
      setSelection(null)
      const value = JSON.stringify(changed.getJSON())
      pending.current = value
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        timer.current = null
        const queued = pending.current
        if (queued === null) return
        pending.current = null
        save.current(queued)
      }, SAVE_DEBOUNCE_MS)
    },
    onFocus: () => {
      setFocused(true)
      report.current(true)
    },
    onBlur: () => {
      flush()
      setSelection(null)
      // Saved either way; only the collapsing is held back. See `holdsOpen`.
      if (holdsOpen.current || grabbing.current) return
      setFocused(false)
      report.current(false)
    },
  })

  editorRef.current = editor
  holdsOpen.current = zoomed !== null || imageDialog !== null
  props.handle.current = {
    toggle: () => {
      if (editor.isFocused) {
        leave()
        return
      }
      const active = document.activeElement
      /*
       * `body` is what `document.activeElement` answers when nothing has focus,
       * and restoring to it is not a restoration — it would take focus *off*
       * whatever the click afterwards put it on.
       */
      returnTo.current = active instanceof HTMLElement && active !== document.body ? active : null
      editor.commands.focus('end', STAY)
    },
  }

  /**
   * Puts the caret back after one of this note's surfaces closes.
   *
   * Without it the box stays open with nothing in it: the caller still believes
   * it is focused, because blur was held back, but the caret is wherever the
   * sheet left it.
   */
  const returnFocus = (): void => {
    editorRef.current?.commands.focus(null, STAY)
  }

  /*
   * Holding a grip is staying in the note, and letting go puts the caret back.
   *
   * Capture phase, so this is known before the editor's own blur runs — by the
   * bubble phase the collapse has already been decided. `dragend` as well as
   * `pointerup`: a drop outside the note ends the drag without a pointer event
   * the editor would see.
   */
  useEffect(() => {
    const down = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Element && target.closest(`.${mine}`) !== null) {
        grabbing.current = true
      }
    }
    const release = (): void => {
      if (!grabbing.current) return
      /*
       * Focus back first, clear the flag last, and the order is the whole fix.
       *
       * A drop ends with `dragend`, but the blur the drag caused arrives *after*
       * it — so clearing the flag on `dragend` meant that blur found it already
       * false and collapsed the note the drop had just finished in. Held for one
       * more tick, the trailing blur is still suppressed and the caret is back by
       * the time anything else can ask.
       */
      editorRef.current?.commands.focus(null, STAY)
      setTimeout(() => {
        grabbing.current = false
      }, 0)
    }
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('pointerup', release, true)
    document.addEventListener('dragend', release, true)
    return () => {
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('pointerup', release, true)
      document.removeEventListener('dragend', release, true)
    }
  }, [mine])

  useEffect(() => {
    const publish = (event: DragEvent): void => {
      const view = editorRef.current?.view
      const data = event.dataTransfer
      const target = event.target
      if (view === undefined || data === null || !(target instanceof window.Node)) return
      const fromGrip = target instanceof Element && target.closest(`.${mine}`) !== null
      if (!fromGrip && !view.dom.contains(target)) return
      const slice = view.dragging?.slice
      if (slice === undefined) return
      const urls: string[] = []
      slice.content.descendants((node) => {
        const src: unknown = node.attrs['src']
        if (typeof src === 'string' && src.startsWith(NOTE_IMAGE_URL_PREFIX)) urls.push(src)
      })
      if (urls.length > 0) data.setData(NOTE_IMAGE_DRAG_TYPE, JSON.stringify(urls))
    }
    document.addEventListener('dragstart', publish)
    return () => {
      document.removeEventListener('dragstart', publish)
    }
  }, [mine])

  /*
   * Escape closes the opened image, and only that. Ahead of the editor's own
   * Escape, which blurs: while a picture is over the window, the way out is
   * putting it back rather than leaving the note.
   */
  useEffect(() => {
    if (zoomed === null) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setZoomed(null)
      returnFocus()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [zoomed])

  /*
   * What the bar draws from, and it has to be a subscription rather than a read.
   * `useEditor` does not re-render on every transaction in v3, so calling
   * `isActive` during render would paint the state as it was when something else
   * last caused a render.
   */
  const marks = useEditorState({
    editor,
    selector: ({ editor: live }) => ({
      bold: live.isActive('bold'),
      italic: live.isActive('italic'),
      underline: live.isActive('underline'),
      strike: live.isActive('strike'),
      link: live.isActive('link'),
      orderedList: live.isActive('orderedList'),
      bulletList: live.isActive('bulletList'),
      blockquote: live.isActive('blockquote'),
      code: live.isActive('code'),
      codeBlock: live.isActive('codeBlock'),
      box: live.isActive('noteBox'),
      /*
       * Read off the mark rather than asked as a question, because the bar has
       * to show *which* colour is under the caret and not merely that one is.
       * Narrowed rather than cast: `getAttributes` answers with an index
       * signature, and trusting it would put an untyped value in the swatch.
       */
      colour: readColour(live.getAttributes('textStyle')),
      text: live.getText(),
    }),
  })

  /*
   * Collapsed, the one row on screen is the note's *first* line.
   *
   * The scroller keeps its offset when the box shrinks back to one line, so a
   * note read to the middle collapsed showing the middle — which reads as a
   * different note, and is what the rest of the window then labels that project
   * with. The textarea this replaced reset `scrollTop` on blur for exactly this
   * reason; the scroller is the editor's wrapper now, so the reset moved with it.
   *
   * Found by class rather than held as a ref because `EditorContent` owns that
   * element, and taking a ref to someone else's wrapper is a claim on their
   * markup for the sake of one assignment.
   */
  useEffect(() => {
    if (focused) return
    const scroller = host.current?.querySelector('.note-editor')
    if (scroller instanceof HTMLElement) scroller.scrollTop = 0
  }, [focused])

  const empty = marks.text.trim() === ''
  const reportEmpty = props.onEmptyChange
  useEffect(() => {
    reportEmpty(empty)
  }, [empty, reportEmpty])

  // A debounce still running at unmount is the sentence just typed.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
      const value = pending.current
      if (value !== null) save.current(value)
    },
    []
  )

  const readSelection = (point?: { readonly clientX: number; readonly clientY: number }): void => {
    const hostEl = host.current
    if (hostEl === null || props.conversationId === null) {
      setSelection(null)
      return
    }
    const { from, to } = editor.state.selection
    const text = editor.state.doc.textBetween(from, to, '\n', ' ')
    if (text.trim() === '') {
      setSelection(null)
      return
    }
    const hostRect = hostEl.getBoundingClientRect()
    const inset = Math.min(56, hostRect.width / 2)
    const rawLeft = (point?.clientX ?? hostRect.right - 12) - hostRect.left
    /*
     * Under the caret's line, never above it. A note is at the top of whatever
     * holds it, so an offer opening upward from a selection in the first line
     * leaves the box — off the screen for the global note, and behind the tab
     * strip for a project's.
     */
    const caret = editor.view.coordsAtPos(to)
    setSelection({
      text,
      left: Math.max(inset, Math.min(rawLeft, hostRect.width - inset)),
      top: Math.min(caret.bottom, hostRect.bottom - 12) - hostRect.top,
    })
  }

  /**
   * Picks a file, or brings an address across, and inserts what main answers.
   *
   * A cancelled picker answers null and leaves the sheet open — nothing
   * happened, and closing on nothing is how a misclick loses a dialog somebody
   * meant to use.
   */
  const bringImage = (source: { readonly address: string } | null): void => {
    setImageDialog({ busy: true, error: null })
    void (async () => {
      try {
        const stored =
          source === null
            ? await window.chorus.pickNoteImage({})
            : await window.chorus.fetchNoteImage({ address: source.address })
        if (stored.url === null) {
          setImageDialog({ busy: false, error: null })
          return
        }
        setImageDialog(null)
        insertImage(stored.url)
      } catch (error) {
        setImageDialog({
          busy: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })()
  }

  /*
   * The bar, in its order. Letters for the four marks that have a letterform and
   * icons for the rest — the reference does the same, and the reason is
   * legibility: a bold `B` is read faster than any glyph anyone could draw.
   */
  const actions: NoteTool[] = [
    { id: 'bold', on: marks.bold, run: () => editor.chain().focus(null, STAY).toggleBold().run() },
    {
      id: 'italic',
      on: marks.italic,
      run: () => editor.chain().focus(null, STAY).toggleItalic().run(),
    },
    {
      id: 'underline',
      on: marks.underline,
      run: () => editor.chain().focus(null, STAY).toggleUnderline().run(),
    },
    {
      id: 'strike',
      on: marks.strike,
      run: () => editor.chain().focus(null, STAY).toggleStrike().run(),
    },
    {
      id: 'link',
      on: marks.link,
      divided: true,
      /*
       * Toggles rather than prompts. A dialog here would be an overlay over an
       * overlay, and the note is not the place to type a URL into a second box —
       * linking the selected text is what the `link` extension already does.
       */
      run: () => {
        if (marks.link) {
          editor.chain().focus(null, STAY).unsetLink().run()
          return
        }
        const href = editor.state.doc.textBetween(
          editor.state.selection.from,
          editor.state.selection.to,
          ' '
        )
        if (href.trim() === '') return
        editor.chain().focus(null, STAY).setLink({ href: href.trim() }).run()
      },
    },
    {
      id: 'orderedList',
      on: marks.orderedList,
      run: () => editor.chain().focus(null, STAY).toggleOrderedList().run(),
    },
    {
      id: 'bulletList',
      on: marks.bulletList,
      run: () => editor.chain().focus(null, STAY).toggleBulletList().run(),
    },
    {
      id: 'blockquote',
      on: marks.blockquote,
      divided: true,
      run: () => editor.chain().focus(null, STAY).toggleBlockquote().run(),
    },
    { id: 'code', on: marks.code, run: () => editor.chain().focus(null, STAY).toggleCode().run() },
    {
      id: 'codeBlock',
      on: marks.codeBlock,
      run: () => editor.chain().focus(null, STAY).toggleCodeBlock().run(),
    },
    {
      id: 'box',
      /* Pressed when the caret is inside a box, and pressing it then is the way
         back out — every other control on this bar answers for its own state,
         and one that could only ever add would leave ⌘Z as its only undo. */
      on: marks.box,
      run: () => {
        /*
         * With a selection this wraps it and inside a box it lifts back out, and
         * `toggleWrap` is both halves the way it is for the quote. With nothing
         * selected there is nothing to wrap, and that is the other gesture
         * entirely — see `addBox`.
         */
        if (marks.box || !editor.state.selection.empty) {
          editor.chain().focus(null, STAY).toggleWrap('noteBox').run()
          return
        }
        addBox()
      },
    },
    {
      id: 'colour',
      /* Pressed when the caret sits in coloured text, whichever colour it is —
         the swatch under the letter says which. */
      on: marks.colour !== null,
      divided: true,
      run: () => {
        setPalette((open) => !open)
      },
    },
    {
      id: 'image',
      /* Never pressed, because it is not a mark. Lighting it up would say the
         caret is inside an image. */
      on: false,
      divided: true,
      run: () => {
        setImageDialog({ busy: false, error: null })
      },
    },
  ]

  return (
    <div className="note-body" ref={host}>
      {/*
        Jira's grip: hover a paragraph and drag it somewhere else in the note.

        A portal the extension positions against whichever block the pointer is
        over, so there is nothing here to place — what the note has to provide is
        somewhere for it to sit, which is why both notes pad their left edge by
        `--note-grip` on top of their own padding. Without that the handle would
        land on the first few characters of every line.

        Top-level blocks, and blocks directly inside a box. Nothing else: a list
        item and a line inside a quote still have no grip, because dragging one
        bullet out of its list is a different gesture from moving a paragraph and
        is worth adding deliberately rather than by leaving a default on. That
        refusal is older than the box and survives it.

        **`allowedContainers` is the option that looks like it says this, and it
        does not.** It drops every candidate below the document unless an ancestor
        is named — and a top-level paragraph is below the document, so naming
        `noteBox` there takes the grip off every block that is *not* in a box.
        Once `nested` is on there is no path back to the top-level behaviour
        either; the handle simply hides. Read out of the extension's own dist,
        after this had already been planned the wrong way round.

        So the rule is written out instead, with the built-in set off: those make
        list *items* the target inside a list, which is the thing being refused.
        A deduction of 1000 is exclusion — the base score is 1000 and a score of
        zero or less is dropped.

        **Edge detection is off, and no setting of it could have worked.** Both
        were tried against the running app. With `left`, moving off the text
        towards the grip put the inner block permanently near an edge while the
        box, a gutter further out, took no penalty — so the handle jumped to the
        box out from under the pointer chasing it. With `top` instead, the upper
        12px of every 21px line counted as near that block's top while the box was
        nowhere near its own, so the target flipped between the block and the box
        within a single line. One flaw, twice: `isNearEdge` is a half-plane and
        not a band, and a strip is the only thing that would have helped.

        Off, nothing is penalised, every candidate keeps the base 1000, and the
        tie is broken by depth — the deepest block under the pointer, every time
        and everywhere. That is the stability, and it is also why the box needs a
        region of its own.

        **The box's own top padding is that region, and it is measured rather than
        scored.** `inBoxGrabStrip` asks whether the pointer is below a box's top
        and above its first child's top — bounded, and overlapping no text, since
        a first child's own top margin is zeroed in the stylesheet.

        **Outside its strip a box is not a candidate at all**, which is what keeps
        a grip reachable. The gutter a handle sits in is the box's padding rather
        than any block's, so a point there can resolve to the box itself — and a
        box that could win from the gutter would move the handle out from under a
        pointer on its way to it, below it, or anywhere in the margin beside it.
        With no candidate the extension returns without hiding anything, so the
        handle holds its place; that is the same answer as padding `.note-drag`'s
        hit area out to meet the text, one axis over.
      */}
      <DragHandle
        editor={editor}
        className={`note-drag ${mine}`}
        nested={{
          defaultRules: false,
          rules: [
            {
              id: 'topLevelOrInsideBox',
              evaluate: ({ node, parent, depth, $pos, view }) => {
                if (node.isInline || parent === null) return 1000
                const within = parent.type.name
                if (within !== 'doc' && within !== 'noteBox') return 1000
                if (node.type.name !== 'noteBox') return 0
                const before = $pos.before(depth)
                return inBoxGrabStrip(
                  view.nodeDOM(before),
                  view.nodeDOM(before + 1),
                  pointer.current.y
                )
                  ? 0
                  : 1000
              },
            },
          ],
          edgeDetection: 'none',
        }}
      >
        <svg viewBox="0 0 10 16" aria-hidden="true">
          <circle cx="3" cy="3" r="1.2" />
          <circle cx="7" cy="3" r="1.2" />
          <circle cx="3" cy="8" r="1.2" />
          <circle cx="7" cy="8" r="1.2" />
          <circle cx="3" cy="13" r="1.2" />
          <circle cx="7" cy="13" r="1.2" />
        </svg>
      </DragHandle>
      <EditorContent
        editor={editor}
        className="note-editor"
        /*
         * Clicking an image opens it over the window, and clicking it again puts
         * it back. Caught here rather than on the image, because ProseMirror
         * draws that node and a handler attached to it would go with the next
         * transaction.
         */
        onClick={(event) => {
          const target = event.target
          if (!(target instanceof HTMLImageElement)) return
          event.preventDefault()
          setZoomed(target.dataset['noteImageSource'] ?? target.src)
        }}
        onPointerUp={(event) => {
          readSelection(event)
        }}
        onKeyUp={() => {
          readSelection()
        }}
      />
      {/*
        Under the text, not over it, and only while the caret is in the note.

        Both notes grow downward from the top of whatever holds them, so a bar
        above would arrive exactly where the eye goes to read what is already
        written. Mount-gated rather than hidden, so a note at rest is one line
        and nothing else — a window of four projects would otherwise draw four
        toolbars nobody is using.
      */}
      {focused && (
        <div
          className="note-bar"
          /*
           * Cancelled so pressing a button never takes the caret out of the
           * editor. Without this every button would blur, which collapses the
           * box — the bar would close the note on its first click, and the mark
           * would apply to nothing.
           */
          onMouseDown={(event) => {
            event.preventDefault()
          }}
        >
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className="note-tool"
              data-tool={action.id}
              data-divided={action.divided ?? false}
              aria-pressed={action.on}
              aria-label={t(`app.noteTool.${action.id}`)}
              title={t(`app.noteTool.${action.id}`)}
              onClick={action.run}
            >
              {action.id === 'colour' ? (
                /*
                 * The one glyph that cannot be a constant: the bar under the
                 * letter is whichever colour the caret is in, so it is drawn
                 * from state rather than looked up.
                 */
                <span className="note-letter note-swatch">
                  A
                  <span
                    className="note-swatch-bar"
                    style={marks.colour === null ? undefined : { background: marks.colour }}
                  />
                </span>
              ) : (
                NOTE_TOOL_GLYPHS[action.id]
              )}
            </button>
          ))}
          {palette && (
            /*
             * Opens upward, because the bar is at the bottom of the note and a
             * menu dropping from it would go off whatever holds the note.
             */
            <div className="note-palette">
              {NOTE_COLOURS.map((colour) => (
                <button
                  key={colour.id}
                  type="button"
                  className="note-palette-swatch"
                  data-colour={colour.id}
                  aria-label={t(`app.noteColour.${colour.id}`)}
                  title={t(`app.noteColour.${colour.id}`)}
                  aria-pressed={marks.colour === colour.value}
                  style={colour.value === null ? undefined : { background: colour.value }}
                  onClick={() => {
                    setPalette(false)
                    const chain = editor.chain().focus(null, STAY)
                    if (colour.value === null) chain.unsetColor().run()
                    else chain.setColor(colour.value).run()
                  }}
                >
                  {/* The one swatch with nothing to show is the one that takes
                      the colour off, so it says so with a stroke. */}
                  {colour.value === null && <span aria-hidden="true">/</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {/*
        A copy of the text on one line, measured and never seen — it is what
        "fit to content" is measured against, and the editor cannot answer that
        itself because its content wraps.
      */}
      {/*
        Clipped to nothing, and the wrapper is the whole point.

        The span inside lays the entire note out on one line, so for a note
        holding a page of text it is thousands of pixels wide. Absolute
        positioning keeps it out of the flow but **not** out of the scrollable
        overflow: it still widened the column it sits in, and the transcript
        underneath was drawn at that width and ran off the pane. A zero-sized
        `overflow: hidden` box contributes nothing at all, and clipping does not
        change what `getBoundingClientRect` reports about the span, so it is
        still measurable.
      */}
      <span className="note-measure-clip" aria-hidden="true">
        <span className="note-measure">{marks.text}</span>
      </span>
      {/*
        The resize handles, placed by the caller and drawn on this box's edges.

        A slot rather than something this component owns, because what a handle
        moves is the caller's: the global note sizes its own fixed root and a
        project's sizes the panel over its column. What they have in common is
        this element, which is why the handles come *in* here instead of the two
        shells each hanging their own on a box they position differently.
      */}
      {props.grips}
      {selection !== null && props.conversationId !== null && (
        <div
          className="quote-offer note-selection"
          style={{
            left: `${String(selection.left)}px`,
            top: `${String(selection.top)}px`,
          }}
          onMouseDown={(event) => {
            event.preventDefault()
          }}
        >
          <button
            type="button"
            className="quote-offer-action"
            onClick={() => {
              const conversationId = props.conversationId
              if (conversationId === null) return
              const text = selection.text
              setSelection(null)
              props.onSendSelection(conversationId, text)
            }}
          >
            {t('conversation.sendSelection')}
          </button>
        </div>
      )}
      {/*
        The image, over the whole window, closed by clicking it again.

        Fixed to the viewport rather than grown in place: a note is capped and
        clips what overflows it, so an image asked to be 80% of the screen cannot
        be drawn inside one. The backdrop is the button, so a click anywhere puts
        it back — which is the gesture asked for and leaves no control to find.
      */}
      {zoomed !== null && (
        <button
          type="button"
          className="note-zoom"
          aria-label={t('app.noteImageClose')}
          /*
           * Cancelled so closing the image does not close the note with it.
           * Pressing a button moves focus to it, the editor blurs, and blur is
           * what collapses the box — so the picture went back and the note went
           * with it, in one click.
           */
          onMouseDown={(event) => {
            event.preventDefault()
          }}
          onClick={() => {
            setZoomed(null)
            returnFocus()
          }}
        >
          <img src={resolveNoteImageUrl(zoomed)} alt="" />
        </button>
      )}
      {imageDialog !== null && (
        <NoteImageDialog
          busy={imageDialog.busy}
          error={imageDialog.error}
          onPick={() => {
            bringImage(null)
          }}
          onAddress={(address) => {
            bringImage({ address })
          }}
          onCancel={() => {
            setImageDialog(null)
            returnFocus()
          }}
        />
      )}
    </div>
  )
}

/**
 * What each tool draws, by id.
 *
 * Outside the component because none of it depends on a render, and in one place
 * because the bar's order lives in `actions` — a glyph beside its handler would
 * put the reading order in two lists that have to agree.
 */
const NOTE_TOOL_GLYPHS: Readonly<Record<string, React.JSX.Element>> = {
  bold: <span className="note-letter note-letter--bold">B</span>,
  italic: <span className="note-letter note-letter--italic">I</span>,
  underline: <span className="note-letter note-letter--underline">U</span>,
  strike: <span className="note-letter note-letter--strike">S</span>,
  link: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
    </svg>
  ),
  orderedList: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10 6h11M10 12h11M10 18h11M4 4h1v4M3.5 8h2M3.5 14h2l-2 3h2" />
    </svg>
  ),
  bulletList: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01" />
    </svg>
  ),
  blockquote: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 5v14M9 7h11M9 12h11M9 17h7" />
    </svg>
  ),
  code: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m9 17-5-5 5-5M15 7l5 5-5 5" />
    </svg>
  ),
  codeBlock: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 5h16v14H4zM9.5 10 7.5 12l2 2M14.5 10l2 2-2 2" />
    </svg>
  ),
  /* Brackets around nothing, because what it draws is the holding rather than
     the held. A square would be a third square on a bar that already has one for
     the code block and one for the image, and at 14px those three would be one
     glyph shown three times. */
  box: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
    </svg>
  ),
  image: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 5h16v14H4zM4 16l4.5-4.5 3 3L15 11l5 5M9 9h.01" />
    </svg>
  ),
}
