# Changelog

What changed, for someone deciding whether to update. Internal refactors are in
the git log; this is the part you can see.

Downloaded builds are not notarized yet, so macOS objects on first launch.
[Installing Chorus on macOS](docs/install-macos.md) covers every dialog,
including the one that means something is actually wrong.

## 0.11.0

### Chorus has an icon

Every build so far shipped the generic Electron icon, in the Dock, in the DMG
window and in ⌘-Tab. The mark is the O from the wordmark, walked through OKLCH so
both agents' colours survive at 16px rather than going olive across the middle.

### Asking about a passage works on the passages you actually select

The selection you highlighted had to match the reply **byte for byte**, and the
transcript shows markdown rendered — so a selection containing inline code, a
link, a bold word, or one crossing a line break inside a paragraph was refused
with "That passage is not part of that reply". Agents write inline code
constantly, so that was most of them.

It is now matched as the transcript reads, whitespace and all. Dragging across
two paragraphs works, which is what selecting an answer normally is. The check
that stops a passage being put in an agent's mouth is unchanged.

### The caret stays where you are typing

An approval or a question arriving used to take the caret out of a half-written
sentence and put it on **Allow** — so the rest of what you typed went nowhere,
and the next Enter approved a command you had not read. A card still takes focus
when the box is empty, which is what makes it answerable with one key; it no
longer takes it out of a message in progress.

The handoff sheet had a sharper version of the same thing: it threw the caret
back to the "Ask them to" dropdown on every re-render, which while an agent was
streaming was several times a second.

### Nothing that blocks you ends up off-screen

A long command in an approval grew the card until Allow, Always and Deny were
below the bottom of the pane, with no way to scroll to them — measured at 684px
past the edge. The card is now bounded against the pane, the request scrolls
inside it, and the buttons and the header stay put.

The side chat also fits its content before an answer starts, then steps to full
height once one does, instead of reserving a blank region for something that has
not arrived.

### The `/` and `@` menus keep asking

Both could stop asking while you were still looking at them. Typing `/` before an
agent had finished starting gave an empty menu that stayed empty however long you
waited, and one more keystroke filled it instantly; a single failed file lookup
did the same to `@`. They now keep asking while the menu is open and unanswered,
and say which they are — looking, nothing found, or no file search in this folder
because it is not a git repository.

**One known gap.** A menu closed by the window losing focus still stays closed
until you type another character. The cause is understood and the obvious fix
made it worse under test, so it is recorded rather than guessed at.

## 0.10.0

### You can see what an agent changed

An `Edit` used to say only which file it touched. To find out what actually
changed you left Chorus — for the editor, for `git diff`, for the Review panel,
which can tell you a file changed but not which of the four edits in a turn did
it, or which agent made it.

Now the diff is drawn under the row, open, with line numbers on both sides and
the changed lines marked — the same view the Review panel has always used, in the
place where the work happened. It is the passage of the file that changed plus a
few lines of context, so a turn with a dozen small edits still reads as a turn
rather than a wall.

**Only edits made from now on.** The record of a conversation is append-only, so
edits from before this update have no diff to show and never will. A conversation
you had yesterday will keep looking the way it did.

A newly created file shows its first dozen lines and says how many it is not
showing. That number was forty in testing and it buried everything else in the
turn; what you usually want from a new file is that it appeared and roughly what
it is.

Codex's edits are not shown this way yet.

### Translate a passage

Select part of a reply and there is a fourth action beside _Quote in message_,
_Ask about this_ and _Explain simply_: **Translate**. It renders the passage in
your own language — the passage itself, not an account of it — and leaves
identifiers, paths and code exactly as written so the result still means the same
thing.

It uses the same language setting as _Explain simply_, in **Settings → Your
language**, and the two read it differently on purpose. An explanation follows
what you wrote, so "simple Arabic" gets you a simpler explanation. A translation
uses the standard written form of the language, because a professional
translation takes its register from the passage rather than from a preference.
Right-to-left languages are laid out properly, with code left-to-right inside
them.

Like _Explain simply_, the action is absent until a language is set: an action
that cannot say which language it would answer in is worse than one that is not
there.

### The actions came back on a narrow pane

On a narrow pane — a small window with the sidebar open is enough — selecting a
passage offered nothing at all. Not quoting, not asking, not explaining. Nothing
said why, because nothing was wrong: the offer appeared and was destroyed a few
milliseconds later, every time.

The offer was positioned against the pane while the passage it points at moves
with the transcript, so anything that scrolled left the two disagreeing, and the
offer was thrown away rather than shown in the wrong place. A narrow pane scrolls
itself while it settles, so it was thrown away faster than it could be made.

It now travels with the passage. As well as fixing the narrow pane, this means
scrolling a few lines while you decide whether to ask about something no longer
loses the offer.

## 0.9.1

### Asking about a passage works again

**If you installed 0.9.0 or 0.8.x, this is the one to take.** Selecting part of a
reply and choosing "Ask about this" or "Explain simply" usually failed with _That
passage is not part of that reply_.

Chorus checks that a selection really came from the reply it names — that check
is what stops anything putting words in an agent's mouth and having them quoted
back. But it compared the **markdown source** in the log against what the browser
gave it, which is the **rendered** text. Those differ whenever markdown changes
something on the way to the screen: a selection over `` `some/path.md` `` arrives
without its backticks, and one crossing a line break inside a paragraph arrives
with a space where the log has a newline. Both were refused.

Since agents write inline code constantly, most selections were affected. The
check now also reads the source the way the transcript renders it, using the same
parser that draws it. Selections from code blocks, which matched before, still
do.

Present since 0.8.0, when asking about a passage shipped.

## 0.9.0

### An answer you gave never reached Claude

The biggest of these, and the least visible. When an agent asked you a question
and you answered it, Chorus sent the answer in a shape the current Claude CLI
rejects — so the agent was told the question came back unanswered, asked again,
and gave up. The transcript said `answered` the whole time, because that record
was written when Chorus _sent_ the answer, without checking the provider took it.

Answers now use the shape the CLI's own schema describes, verified end to end for
single choice and multi-select. An answer that cannot be matched to its question
is refused outright rather than half-sent, since a partial answer reads to the
agent as "the user chose nothing" — which is how this hid for so long.

### "Read only" allowed writes

The profile whose summary reads _"Agents may look. Anything that changes the
machine needs a decision"_ decided `allow` on commands that change the machine.
Its rule matched the **first word** of a command line, so `find . -delete`,
`git branch -D`, `cat source > target` and `cat secrets | curl …` all passed
without a card and without any record of a person choosing.

An allow rule now has to cover every command on the line: substitution and file
redirection are refused, and each part of a pipeline must satisfy the same rule.
So `cat file | head` is still a read and `git add . && curl … | sh` is not.
Denies are unaffected — hiding `rm -rf` behind `&&` was never going to work, and
still does not. **Trusted is untouched**: it allows any command by design, and
none of this reaches it.

### A question card no longer expires while you are answering it

Measured over a real log: **10 of 25 question sets died at exactly five minutes**,
every one of them a timeout rather than a dismissal. The clock started when the
agent asked, nothing restarted it, and typing an answer was not an input to it —
so a card could be on screen, focused and half-filled when it went. It was worst
on multi-part questions, which are the ones most worth asking.

Now a card in its last minute says so, and working in one holds the deadline off.
Choosing an option, typing, or moving between questions buys more time; simply
having the card open does not, because the card takes focus by itself and that is
not evidence anyone is there. A verified run kept a card answerable for 390
seconds.

### Turn an aside into a conversation

An aside could only look things up. If it turned out the answer needed doing
rather than explaining, there was nothing to do but copy it into the composer by
hand. **Open as conversation** turns the aside into a room of its own — its
transcript continues, and it can edit files and run tools under a permission
profile you pick at that moment. Nothing is inherited silently.

### Each agent has its own model and reasoning effort

Settings held one model for both agents, and the only list it ever showed was
Claude's — so choosing one sent a name from Claude's catalogue to Codex's API.
Each agent now has its own row, and Codex reports its own models and per-model
reasoning efforts. An agent that reports none says which kind of none it is:
never asked, asked and offered nothing, or asked and failed.

## 0.8.1

### Explain simply works again after a restart

0.8.0 refused to explain or ask about any reply written before the app was last
restarted — "claude has started a new session since it said that". Reopening a
conversation resumes the same agent session, but the check that stops you asking
about a reply from a session that never saw it could not tell a resume from a
fresh start. Since most conversations outlive a restart, most replies were
affected.

## 0.8.0

### Ask about one part of a reply, without derailing the conversation

Select a passage an agent wrote and there are now three things you can do with
it.

- **Ask about this** opens a small card anchored to the passage. The question and
  its answer never enter the conversation — not its transcript, not the agent's
  context window, and not the other agent's catch-up. It is answered by a _fork_
  of the agent that wrote the passage, so it still knows everything: why it chose
  that approach, what the file it named does, what was decided three turns ago.
  Measured, the token cost of asking is two uncached input tokens.
- **Explain simply** answers in your own language, plainly, for when you did not
  follow something. Set the language in Settings — write it however you like,
  "Arabic" or "Lebanese Arabic". It explains rather than translating: identifiers
  and technical terms stay as they are and get explained where they appear, and
  Arabic and Hebrew read right-to-left with code left-to-right inside them.
- **Quote in message** is the old "Ask about this", renamed to what it actually
  did — put the passage in your composer.

Either card can be dismissed while the answer is still arriving, and what you get
can be quoted into your message or handed forward as an instruction. Nothing
leaves the aside unless you send it.

Asked about a reply from an agent that has since been removed and re-added, or a
reply still being written, the option is not offered — a fork can only see turns
that have finished.

### Your database gets its first schema change

Chorus takes a snapshot before migrating and keeps it beside the database as
`chorus.pre-v1.db`. A migration that cannot run now fails loudly with your data
untouched, rather than being mistaken for a corrupt database.

## 0.7.0

### The composer answers `/` and `@`

- **A slash menu** built from what the project actually offers — its own
  commands, its skills, its plugins. Not a hardcoded list: what the installed
  CLI reports for the directory the session opened in.
- **`@` finds files as well as agents.** Agents first, since there are two of
  them and thousands of files. Files come from git, so a file you created a
  minute ago is offered and `node_modules` never is.
- **Drafts survive quitting**, and the up arrow brings back what you said.

### You can see what the agents are actually doing

- **Hooks, tool calls and subagents** appear in the transcript. A run of
  talkative hooks folds to one row you can open, instead of putting six lines
  between a command and its output.
- **Background tasks.** A command an agent left running says so on the card, and
  can be stopped from there.
- **A todo row that names the work** — "Fixing the parser · 1/3" — rather than
  the bare word `TodoWrite`.
- **Context window fill** per agent, so a compaction is not a surprise.

### Permissions

- **Plan mode**, per conversation: agents read and reason and change nothing
  until a plan is approved. Approving the plan is what ends the mode.
- Approval cards now use **the sentence the CLI already wrote**, and name the
  path that actually blocked a command — which appears nowhere in the command
  itself.
- Saying "always" to an edit hands editing to the CLI and stops asking.
- Credential files **ask** instead of refusing. A deny had no door: only you can
  tell a secret from a fixture.

### Settings knows about this machine

- **MCP servers** and whether each one actually works. A server that needs
  authenticating gives its agent no tools and says nothing about it.
- **Which account each agent is signed in as**, per agent, because the two CLIs
  are separate logins.
- **Installed plugins** and whether they are switched on.
- **A default model and reasoning effort** for new sessions.

### Sessions

- **History**: find and reopen a conversation that was ended.
- **Unread counts** for what happened while you were away, and a notification
  when Chorus is not on screen.
- Renaming a conversation also **retitles the provider's own record** of it, so
  a session resumed later in the terminal carries the name you chose.

### Fixes worth naming

- **Agent replies could render blank.** The visible text advanced only inside
  `requestAnimationFrame`, so a window the compositor had stopped painting
  showed an empty bubble — while the reply sat complete in the log.
- **The slash menu could be permanently empty** if you opened a pane and typed
  `/` within a second. Three variations of the same mistake — an empty first
  answer treated as the final one — also affected the MCP panel and the model
  picker, and all are fixed.
- **A `PreToolUse` hook that blocked a tool reported nothing.** The events were
  mapped and never arrived, because the option that emits them was never set.
- Resuming a conversation appended a second copy of everything already in it.
- `"16 tool"` and other counts that never pluralised.
