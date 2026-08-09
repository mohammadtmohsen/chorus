# Changelog

What changed, for someone deciding whether to update. Internal refactors are in
the git log; this is the part you can see.

Downloaded builds are not notarized yet, so macOS objects on first launch.
[Installing Chorus on macOS](docs/install-macos.md) covers every dialog,
including the one that means something is actually wrong.

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
