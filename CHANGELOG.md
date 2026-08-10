# Changelog

What changed, for someone deciding whether to update. Internal refactors are in
the git log; this is the part you can see.

Downloaded builds are not notarized yet, so macOS objects on first launch.
[Installing Chorus on macOS](docs/install-macos.md) covers every dialog,
including the one that means something is actually wrong.

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
