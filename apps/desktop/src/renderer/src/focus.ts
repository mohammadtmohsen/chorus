/**
 * Whether something that just appeared may take the caret.
 *
 * Three things grab focus without being asked to: an approval card, a question
 * card, and the composer when a burst of approvals clears. All three are worth
 * doing — an approval stops the agent dead, so answering it with Enter rather
 * than with the mouse is the point — and all three were doing it while the user
 * was part-way through a sentence.
 *
 * That is not only rude, it is unsafe. The caret lands on **Allow**, so the next
 * Enter approves a command nobody read, and the words typed before it are
 * scattered across a button as keystrokes that do nothing.
 *
 * **The rule is emptiness, not focus.** Refusing whenever the caret sits in a
 * text box would kill the feature outright: the composer takes focus on mount
 * and holds it, so a card would never be answerable by keyboard again. A box
 * with nothing in it costs nothing to leave — Escape and Tab come straight back.
 * A box with words in it is someone mid-thought, and that is the case to protect.
 *
 * **Empty means empty, not `trim()`-empty.** This read `value.trim() !== ''`
 * first, which hands the caret away from a box holding only spaces or newlines.
 * That is not an idle box: someone who has pressed Enter twice inside a message
 * is mid-thought by every measure except the one being taken, and the cost of
 * being wrong is the whole reason this file exists — the next keystrokes land on
 * **Allow**, and Enter approves a command nobody read. The case the composer
 * needs is the box that is *literally* empty on mount, which this still allows,
 * so the feature survives without the hole.
 *
 * **A modal is the exception to that exception, and it is not about typing.** A
 * sheet covers the pane, so the dock is behind it and out of sight. An approval
 * arriving then would move the caret to an Allow button the user cannot see, and
 * the next Enter — pressed at a dialog, meaning "confirm this" — would approve a
 * command they were never shown. Emptiness has nothing to do with it: the caret
 * may be on a `<select>` or a button, and it must still stay where it is.
 *
 * **A terminal is the second such exception, and it inverts the first.** The
 * emptiness rule assumes an empty box means an idle one. xterm types into a
 * hidden `<textarea>` it clears after every keystroke, so a terminal's box is
 * empty *permanently* — and every test here read it as idle and handed the caret
 * to the composer while someone was mid-command. Reported as "I'm trying to
 * write in the terminal but it focuses the main input", with the characters
 * landing under the transcript.
 */

/**
 * The focused element, reduced to what the decision reads.
 *
 * Plain data rather than an `Element`, so the judgement is a pure function the
 * suite can exercise — `environment: 'node'`, and there is no DOM in it.
 */
export interface Focused {
  /** Upper-case, as `Element.tagName` gives it. */
  readonly tag: string
  /** An `<input>`'s type. Anything else has none. */
  readonly type: string | null
  /** What is in the box: `value`, or the text of a `contenteditable`. */
  readonly value: string
  /** A `contenteditable` host — a text box wearing some other tag. */
  readonly editable: boolean
  /**
   * Inside an open modal, which covers the dock the cards live in.
   *
   * Read off `.sheet-backdrop` rather than `role="dialog"`: the approval card is
   * an `alertdialog` itself, and matching on the role would stop a queue handing
   * focus from one request to the next — which is the one time a card taking it
   * from another card is exactly right. Every modal overlay in the app wraps
   * itself in that backdrop, including the attachment viewer, which is the only
   * one whose inner element is not `.sheet`.
   */
  readonly inModal: boolean
  /**
   * Inside a terminal, where the emptiness rule above is simply wrong.
   *
   * xterm types into a hidden `<textarea>` it clears after every keystroke, so
   * the box is empty **by design, permanently**. Every test this file makes
   * therefore reads a terminal as idle — "a box with nothing in it costs nothing
   * to leave" — and the caret gets pulled into the composer out from under
   * someone who is very obviously mid-command. Emptiness cannot mean idle here,
   * so the question is not asked: a terminal keeps its caret.
   */
  readonly inTerminal: boolean
  /**
   * Inside a code editor, where the emptiness rule is wrong for the same reason.
   *
   * Monaco keeps the document in its own model and types into a hidden
   * `<textarea class="inputarea">` that it clears after every keystroke — the
   * identical trick xterm plays, and it defeats the identical test. Every check
   * here read the editor as an empty box, therefore idle, therefore free to
   * take the caret from; so the composer pulled focus away mid-word and the
   * file could not be edited at all.
   *
   * The terminal case above was found and fixed first. This is the same bug in
   * the component that arrived later, which is worth saying plainly: the rule
   * is not "terminals are special", it is **"a box that empties itself cannot
   * be judged by whether it is empty"**. Anything else that hides its real
   * buffer belongs here too.
   */
  readonly inEditor: boolean
}

/**
 * The `<input>` types that hold a sentence.
 *
 * A checkbox, a radio and a range are focusable and carry a `value`, but that
 * value is a setting rather than something being written — taking the caret off
 * one loses nothing.
 */
const TYPED = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number'])

export function mayTakeCaret(focused: Focused | null): boolean {
  if (focused === null) return true
  return !focused.inModal && !focused.inTerminal && !focused.inEditor && !isWriting(focused)
}

function isWriting(focused: Focused): boolean {
  const box =
    focused.editable ||
    focused.tag === 'TEXTAREA' ||
    (focused.tag === 'INPUT' && TYPED.has(focused.type ?? ''))
  return box && focused.value !== ''
}

/**
 * What holds the caret right now, read from the document.
 *
 * `document.activeElement` is `<body>` when nothing is focused, which reduces to
 * "not a text box" and therefore to "go ahead" — the right answer, reached
 * without a special case.
 */
export function focusedNow(): Focused | null {
  const el = document.activeElement
  if (!(el instanceof HTMLElement)) return null
  return {
    tag: el.tagName,
    type: el instanceof HTMLInputElement ? el.type : null,
    value: writtenIn(el),
    editable: el.isContentEditable,
    inModal: el.closest('.sheet-backdrop') !== null,
    inTerminal: el.closest('.terminal-panel') !== null,
    /*
     * `.monaco-editor` rather than our own `.monaco-diff-host` wrapper: the
     * class Monaco puts on its own root travels with it wherever it is mounted,
     * so this keeps holding if the editor is ever used outside the Changes
     * panel. A wrapper we own would silently stop matching.
     */
    inEditor: el.closest('.monaco-editor') !== null,
  }
}

/**
 * The text of the box itself, and nothing else.
 *
 * Measured rather than assumed: with focus on `<body>` — which is where it sits
 * whenever nothing is focused — `textContent` is the whole document. Reading it
 * would allocate the entire transcript on every card that appears, to answer a
 * question the tag had already answered.
 */
function writtenIn(el: HTMLElement): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value
  return el.isContentEditable ? el.textContent : ''
}
