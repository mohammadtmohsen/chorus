type AgentId = 'codex' | 'claude'

/**
 * The `@` picker's logic, with no DOM in it.
 *
 * Typing a name from memory is fine until you have two agents and a message that
 * has to reach one of them — then the cost of guessing wrong is a turn spent by
 * the wrong agent. A picker makes the cast visible at the moment you are
 * choosing, which is the only moment it matters.
 *
 * Kept separate from the component because the caret arithmetic is where this
 * kind of feature goes wrong, and it is worth testing on its own.
 */

export interface MentionQuery {
  /** Which menu is open. Carried so the replacement writes the right character. */
  readonly trigger: '@' | '/'
  /** Index of the trigger, so the replacement knows what to overwrite. */
  readonly start: number
  /** What has been typed after it, lowercased. Empty right after the trigger. */
  readonly query: string
}

/**
 * A mention together with everything needed to know it still describes the box.
 *
 * **One snapshot, three parts, and each part answers a different way of being
 * wrong.** A `MentionQuery` is a pair of offsets into one particular string at
 * one particular caret; on its own it cannot say whether that string is still
 * what is in the box.
 */
export interface StampedMention {
  readonly query: MentionQuery
  /**
   * The exact text it was read out of.
   *
   * Catches the draft being rewritten from outside the textarea — `quote`,
   * `insert` and `send` all do that and fire no change event — and catches the
   * narrower case of `refreshMention` reading a DOM value React has not rendered
   * yet, where the offsets would describe newer text than the draft holds.
   */
  readonly from: string
  /**
   * Which revision of the draft that was.
   *
   * Text equality alone is forgeable: two different edits produce the same
   * string. `send` then recall, `quote` then undo, or simply retyping the same
   * word brings back text a stale mention matches, and it would come back to
   * life carrying offsets from an earlier edit. A counter cannot be forged that
   * way.
   */
  readonly rev: number
  /**
   * The caret it was read at.
   *
   * `findMentionQuery` derives the query from `text.slice(0, caret)`, so the
   * caret *is* the end of the region the query describes. Splicing at a
   * different one writes the option into the wrong place — which is why `choose`
   * uses this rather than reading the caret again at click time.
   */
  readonly caret: number
}

/**
 * The mention, but only if it still describes the box.
 *
 * A `MentionQuery` is a pair of offsets into one particular string. `onChange`
 * keeps them honest for anything a person types, but `quote`, `insert` and
 * `send` write the draft from outside the textarea and fire no change event —
 * and two of those refocus afterwards, which is precisely when a menu would
 * reopen against text its offsets no longer fit. Choosing a row then splices at
 * a stale offset and deletes whatever now sits there.
 *
 * Comparing the stamp makes that unrepresentable rather than merely unlikely,
 * and costs one string compare. The alternative — re-deriving after every
 * programmatic write — needs the caret, and the caret is exactly what cannot be
 * trusted around a focus event (C-003).
 */
export function liveMention(
  mention: StampedMention | null,
  draft: string,
  rev: number
): StampedMention | null {
  if (mention === null) return null
  /*
   * Both tokens, because each catches what the other cannot.
   *
   * Text alone lets a stale mention reactivate the moment the same string comes
   * back — send then recall is enough. The revision alone would pass in the one
   * race this was built for: a DOM value written but not yet rendered, stamped
   * against the revision the *old* draft still holds, so offsets from the new
   * text would be blessed against the old.
   */
  return mention.from === draft && mention.rev === rev ? mention : null
}

/**
 * Whether the menu is on screen.
 *
 * Visibility depends on focus; what is being typed does not. Keeping them in one
 * value is what made C-003: `onBlur` cleared the mention to close the menu, and
 * nothing re-derived it when focus came back, so the box kept its `/` and the
 * menu stayed shut until another key was pressed.
 *
 * The `lookup` arm is why this takes a status at all — a menu that says "still
 * looking" has no rows, and without it an unanswered lookup was indistinguishable
 * from having nothing to offer.
 */
export function menuVisible(
  focused: boolean,
  rows: number,
  mention: MentionQuery | null,
  lookup: string | null
): boolean {
  if (!focused) return false
  return rows > 0 || (mention !== null && lookup !== null)
}

/**
 * Whether the menu may take a keystroke before the composer sees it.
 *
 * **Both halves, and each one was learned separately.**
 *
 * `rows > 0` alone was the original rule, and its reason still stands: the menu
 * also opens with no rows to say a lookup is running, and letting that menu take
 * keys makes `% rows` a division by zero and — worse — swallows Enter, so a
 * message beginning with `/` could not be sent while the list was arriving.
 *
 * `visible` is the half added with C-003's fix, because that fix made the two
 * able to disagree. Visibility is now gated on the box not having been left,
 * while `rows` is derived from the mention alone — so a menu can be off screen
 * with fifty rows behind it. Keying off `rows` there means an **invisible menu
 * swallowing an arrow key**: the caret does not move, history recall does not
 * run, and nothing on screen explains why.
 *
 * A listbox nobody can see is not a listbox. It should not hold the keyboard.
 */
export function menuTakesKeys(visible: boolean, rows: number): boolean {
  return visible && rows > 0
}

export interface MentionOption {
  /** What is inserted, without the leading trigger. */
  readonly insert: string
  /**
   * Inserted without the trigger character.
   *
   * A file is not a mention. It goes in as a plain path, the same way a dropped
   * file does, because that is what an agent reads — and because the router
   * would have to learn to ignore `@src/foo.ts` otherwise.
   */
  readonly bare?: boolean
  readonly label: string
  readonly detail: string
  /**
   * Agents this option addresses, for the coloured dots.
   *
   * Empty for a command, which addresses nobody in particular — the dots are
   * about which voice a message reaches, and a command is not a message.
   */
  readonly agents: readonly AgentId[]
}

/**
 * Finds the mention being typed at the caret, or `null`.
 *
 * A mention only counts at the start of a word: `email@codex.dev` is an address,
 * not an attempt to talk to Codex, and offering a menu inside one is noise. The
 * same rule the router uses (`mentions.ts`), so the menu cannot suggest
 * something the router would then ignore.
 */
export function findMentionQuery(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at === -1) return null

  const preceding = at === 0 ? '' : before.charAt(at - 1)
  if (preceding !== '' && !/\s/.test(preceding)) return null

  const query = before.slice(at + 1)
  /*
   * Wide enough for a path, because `@` now offers files as well as agents.
   *
   * Whitespace is still the terminator, which is what keeps "closes once the
   * word ends" true — and the word-start rule above is what keeps an email
   * address from opening a menu.
   */
  if (!/^[a-z0-9./_-]*$/i.test(query)) return null

  return { trigger: '@', start: at, query: query.toLowerCase() }
}

/**
 * Finds the slash command being typed, or `null`.
 *
 * Deliberately not the same rule as `@`, which fires at any word start. A slash
 * is a path separator far more often than it is a command, so at word-start
 * every `src/foo` and every `and/or` would open a menu. A command has to lead
 * the message — nothing but whitespace before it — which is also where the CLI
 * expects one.
 *
 * The name charset is wider than a mention's because command names really are:
 * a plugin's command arrives as `frontend-design:frontend-design`.
 */
export function findCommandQuery(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret)
  const at = before.indexOf('/')
  if (at === -1) return null
  // Only whitespace may precede it: a stray leading space is still someone
  // starting a command, and `src/foo` is not.
  if (before.slice(0, at).trim() !== '') return null

  const query = before.slice(at + 1)
  if (!/^[a-z0-9:_-]*$/i.test(query)) return null

  return { trigger: '/', start: at, query: query.toLowerCase() }
}

/** One command the provider says this session accepts. */
export interface CommandInfo {
  readonly name: string
  readonly description: string
  readonly argumentHint: string
}

/**
 * The commands a query offers.
 *
 * Matched on a substring rather than a prefix, unlike agents: there are fifty of
 * these where there are two of those, and half their names are compound —
 * finding `code-review` by typing `review` is the difference between a menu and
 * a list you scroll.
 */
export function commandOptions(commands: readonly CommandInfo[], query: string): MentionOption[] {
  return commands
    .filter((command) => command.name.toLowerCase().includes(query))
    .map((command) => ({
      insert: command.name,
      label: command.name,
      detail: command.argumentHint === '' ? command.description : command.argumentHint,
      agents: [],
    }))
}

/**
 * The options a query offers, in the order they should be shown.
 *
 * "Both" comes last rather than first: addressing everyone is occasionally what
 * you want and never the default, and a list whose first entry costs two agents
 * a turn is a list that will be picked by accident.
 */
export function mentionOptions(participants: readonly AgentId[], query: string): MentionOption[] {
  const options: MentionOption[] = participants.map((id) => ({
    insert: id,
    label: id,
    detail: 'agent',
    agents: [id],
  }))

  if (participants.length > 1) {
    options.push({
      insert: participants.join(' @'),
      label: 'both',
      detail: `ask ${participants.join(' and ')}`,
      agents: participants,
    })
  }

  return options.filter((option) => option.label.startsWith(query))
}

/**
 * Files as menu options.
 *
 * Quoted on the way in rather than on the way out: a path with a space in it is
 * ordinary on a Mac, and the agent receives the draft as text. Left unquoted it
 * would arrive as two arguments and read as two files.
 */
export function fileOptions(paths: readonly string[]): MentionOption[] {
  return paths.map((path) => ({
    insert: /[\s"'\\]/.test(path) ? JSON.stringify(path) : path,
    label: path,
    detail: 'file',
    agents: [],
    bare: true,
  }))
}

/** The draft and caret after picking an option. */
export function applyMention(
  text: string,
  mention: MentionQuery,
  caret: number,
  option: MentionOption
): { text: string; caret: number } {
  // A trailing space, because the next thing typed is always the message and
  // nobody wants to press space after choosing from a menu.
  const inserted = `${option.bare === true ? '' : mention.trigger}${option.insert} `
  return {
    text: text.slice(0, mention.start) + inserted + text.slice(caret),
    caret: mention.start + inserted.length,
  }
}
