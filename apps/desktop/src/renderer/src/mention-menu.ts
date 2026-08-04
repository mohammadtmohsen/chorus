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
  /** Index of the `@`, so the replacement knows what to overwrite. */
  readonly start: number
  /** What has been typed after it, lowercased. Empty right after `@`. */
  readonly query: string
}

export interface MentionOption {
  /** What is inserted, without the leading `@`. */
  readonly insert: string
  readonly label: string
  readonly detail: string
  /** Agents this option addresses, for the coloured dots. */
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
  // Anything else means the word ended and this is no longer a mention.
  if (!/^[a-z0-9-]*$/i.test(query)) return null

  return { start: at, query: query.toLowerCase() }
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

/** The draft and caret after picking an option. */
export function applyMention(
  text: string,
  mention: MentionQuery,
  caret: number,
  option: MentionOption
): { text: string; caret: number } {
  // A trailing space, because the next thing typed is always the message and
  // nobody wants to press space after choosing from a menu.
  const inserted = `@${option.insert} `
  return {
    text: text.slice(0, mention.start) + inserted + text.slice(caret),
    caret: mention.start + inserted.length,
  }
}
