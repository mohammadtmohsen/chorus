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
