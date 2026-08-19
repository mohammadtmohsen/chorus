# Changelog

What changed, for someone deciding whether to update. Internal refactors are in
the git log; this is the part you can see.

Downloaded builds are not notarized yet, so macOS objects on first launch.
[Installing Chorus on macOS](docs/install-macos.md) covers every dialog,
including the one that means something is actually wrong.

## 0.19.4

### A long message you paste stops taking over its pane

Pasting a chunk of code or a long selection into a conversation left it filling
most of the pane it was in. The cap was there, but it measured the _window_ — so
it was the same number whether one conversation fills the screen or four are
tiled in it, which meant a "quarter of the view" was most of a quarter-height
pane.

It is now a fifth of the pane the message is in, and it re-measures when you
split the workspace or drag a divider. _Show the rest_ still opens it in full.

## 0.19.3

### A file an agent names can be opened by clicking it

Agents link to files constantly — a plan they just wrote, the module they just
changed — and every one of those links rendered as its own source code, brackets
and parentheses included. The link checker only recognised web addresses, and a
path inside your project is not one, so it refused them all. A path you could
read and could not open.

They are links now, and clicking one opens the file in VS Code. Where it opens
is decided the same way it is for the file names on a tool row: Chorus resolves
the path against that conversation's own directory and refuses anything outside
it. A path is never handed to a browser, and a link with a genuine web address
still opens in your browser exactly as before.

### A message that never reaches an agent says so

After ninety seconds with nothing coming back, the line under your message used
to disappear, leaving your question alone above an empty pane with nothing to
say anything had ever been expected. It now stays and tells you what happened —
that the message may not have reached the agent, and to try sending it again.

Chorus also writes a line to its own log when a message is accepted and again
when it is handed to an agent. If this happens to you, those two lines are what
tell us where it stopped; before, there was nothing in the log at all.

## 0.19.2

### No more screen of blank under a short reply

Asking a question padded the transcript out to a full window, so your question
could jump straight to the top and stay there as the heading of its own answer.
The cost was the empty screen underneath every reply shorter than the window —
a two-line answer with a page of nothing below it.

The padding is gone. Your question now rises as the answer is written, and once
a turn grows taller than the screen it sticks to the top exactly as before, so a
long reply still says what it is answering. A short one simply sits where it
landed, with nothing beneath it that is not really there.

The trade is deliberate and you may notice it: a question asked at the bottom of
a long history no longer leaps to the top the moment you press send. It gets
there as the reply arrives.

## 0.19.1

### You can tell whether a reply is the last one

An agent's turn is rarely one message. It says a sentence, runs some commands,
reads a file, then says more — and the dot beside its name only moved while
_words_ were arriving. So for most of a turn you were looking at a still dot
above a reply that looked finished, with no way to know whether that was the
answer or the first third of it. The dot now follows the turn: moving means more
is coming, still means done.

### The button says it is working, by moving

While an agent runs, the button in the corner of the composer was already
outlined, or red with a square when there was nothing to send. Colour is a state
you have to have learned; something turning is not. It now wears a turning ring
in both those states — and it is the right place for the signal, because it is
the button you would press to stop what is running. It stays still if you have
asked your system for less motion.

Neither of these invents information: they report what Chorus already believes
about the turn. If it is wrong about that, it will now be wrong twice as
visibly, which is the intended trade.

## 0.19.0

### Enter on an approval now grants it for the session

When an agent asks permission, the card arms a button so you can answer without
reaching for the mouse — an approval stops the agent dead, so the fastest answer
is the point. That button was **Allow once**, on the reasoning that the wider
grant should cost a deliberate press.

It is **Allow for this session** now. A session grant ends when you close the
window, so the reach of a mistaken Enter is this sitting — and a mistaken Enter
on _Allow once_ costs you a command you had not read either. The narrower button
was not safer by enough to be worth answering the same question four times,
which is the commonest way an approval queue turns into something you stop
reading. The hint under the card says which grant Enter gives.

**One kind is deliberately left alone.** For an MCP tool call, the wider button
is not a session grant at all — it says _Always allow this tool_, and it means
it: that answer is remembered across restarts. A key that was already armed when
the card appeared should not be able to make a permanent change to what agents
may do, so MCP approvals still arm _Allow once_. The wider button is where it
always was, one press away.

Two protections are unchanged and now follow whichever button is armed. Space
does not approve, because a card can arrive while you are mid-sentence and the
next space of ordinary typing would answer it. And a held Enter approves once
rather than walking the whole queue.

## 0.18.1

### A file reference in your own message is readable again

Send a question with VS Code context attached and the reference was longer than
the question. Chorus writes those references for the agent — the whole relative
path so it can open the file, the whole commit sha so `git show` reproduces the
version you were looking at — and a single context line carried an
eighty-character path three times and a forty-character commit twice. A six-word
question drew as four wrapped lines of monospace with the question lost inside
them.

The transcript now shortens them: a path keeps its file name and the folder above
it, a commit shows as the seven characters git itself prints. Hovering gives you
the whole value. The reported message went from four lines to two.

Only the drawing changes. What was sent is exactly what was always sent, which is
what lets an agent open the right file at the right version — and only your own
messages are shortened, because cutting a path down inside an agent's reply would
be editing the reply.

## 0.18.0

### Both agents are in the room from the start

A new session used to open with Claude alone, and the second agent was something
you added from its chip when you decided you wanted it. That is the wrong way
round: the shared room is the whole point, a conversation with one agent in it is
the thing Chorus exists to replace, and an agent brought in late has _read_ the
transcript rather than been present for it. New sessions now start with both.

Two smaller changes come with it, and one of them may be the one you notice.
**Toggling the cast no longer changes what future sessions start with.** It used
to: bringing Codex into one conversation quietly rewrote the default for every
conversation after it, which is drift you cannot see from where you caused it —
the setting says "new sessions start with", nobody edited it, and it reads
differently because of a chip pressed days ago. The sheet is the only thing that
decides the default now, and a cast you change belongs to that conversation.

**Restarting a session gives it the default cast** rather than the one it had.
Restart means "start this session over, with nothing said in it", and carrying
the old cast forward made it the one action that could not rescue a conversation
whose agents were wrong — an agent that had failed to start was still listed, so
restarting reproduced the state you were restarting to escape. Where it runs and
how much it is trusted still carry, because those are facts about the work.

### Replies are written, not delivered in blocks

An agent's answer arrived a paragraph at a time, a quarter-second apart. The
pacing that was meant to smooth that had the wrong rule — it cleared whatever had
arrived inside 80 milliseconds, so a 300-character paragraph was "paced" at 3,750
characters a second, which is a block appearing. It now writes at a readable 200
a second and only speeds up when it would otherwise fall more than a moment
behind, so a message that arrives in one lump still cannot leave the screen
stuck in the past.

The end of a reply was the worst of it: the last paragraph appeared all at once,
because finishing dumped the remaining text in one go. That is the most visible
jump of the lot, since it happens exactly where you are already reading. The tail
is written out now too, just briskly.

If you have asked your system for less motion, everything still appears at once.

### An attachment you have sent looks like what it is

0.17.2 made an attachment a picture _before_ you send it. Afterwards it was still
forty characters of `/Users/…/1787054491497-3-image.png` in your own message —
the least useful description of a screenshot available, over two lines. Your sent
message now shows the same tile the composer showed, and clicking it opens the
picture full size.

Nothing about the message itself changed: agents are handed paths, not uploads,
and the path is still exactly what was sent — that is how an agent can open your
screenshot at all. This is only how the message is drawn. A path that turns out
not to be a picture — a folder, a log, a file since deleted — stays as text.

### The waiting line stops lying

The line under your message that says an agent is starting had two faults. Its
dot sat a line above its own word whenever two agents were in the room, because
the row has no name to show there and the empty space still took a line.

And it could stay forever: a finished reply with _getting started_ sitting
underneath it, permanently. Everything that used to dismiss that line was
something that _arrives_ — an agent starting, an error, a refusal — so a message
that neither landed nor failed dismissed nothing. It now gives up after ninety
seconds, which is far longer than any real start. That bounds the symptom rather
than curing it: if you see it give up, the message did not reach the agent, and
sending it again is the right move.

## 0.17.2

Two things under a reply and above the message box, both of which said the
wrong thing by being the wrong shape.

### Hand off is on its own line

Under a reply the row read `Hand off → Explain simply`. Two separate controls,
but the arrow at the end of the first invites the next word to complete it, so
it scanned as one instruction — hand off _in order to_ explain, which is not
what either does. Hand off now sits on its own line underneath.

It is also the only thing on that row that sends your reply out of the
conversation to the other agent. Explain simply and Where are we? ask this one;
a line to itself is the honest grouping and not only a way of breaking up a
phrase.

### An attachment shows what it is a picture of

Paste or drop an image and you got a 22px circle, then its whole filename. At
that size the circle is a few dozen pixels out of the middle of the image — for
a dark screenshot, an empty grey dot — so the picture told you nothing and you
were back to reading a filename, which is what the thumbnail was added to
replace.

It is a tile now: a 56px square showing the image, with a short name captioned
underneath and the ✕ on the corner. Square because pictures are, and because a
circle crops away exactly the corners where a screenshot keeps the window
chrome that says which app you grabbed.

The name is cut to fit, and it keeps the end rather than the beginning. Pasted
images are named for the millisecond they arrived — `1787033349300-3-image.png`
— so cutting from the front leaves the half nobody can read and throws away the
extension, and two screenshots pasted a second apart caption identically. It now
reads `17870….png`. Hovering still gives the full name and the path underneath,
and the path is still what the agent receives.

## 0.17.1

Corrections to what 0.17.0 shipped, all found by using it.

### Explain and Translate keep answering in your language

A card answered in your language once and then switched to English the moment
you asked a second question. Only the first request named a language, and an
agent answers in the language it was asked in — so typing a follow-up in English
got you an English answer, which is no use if your language is why you opened
the card. It now stays in your language for the whole exchange, however the
question is typed.

Technical terms stay in English inside it — `event`, `status`, `props`, a file
name, a library. A term translated is one you have to translate back before you
can search for it or match it against the code in front of you.

### The card survives, and follows its own answer

Looking at another session closed the card and ended the side conversation
inside it. It stays now: go to another tab, come back, and the answer is where
you left it. Clicking away inside the same pane still dismisses it, which is the
gesture that means "I am done with this".

A long answer used to arrive below the fold, because the card never scrolled to
follow it. It does now, and stops following the moment you scroll up to read
something — the same rule the main transcript uses. It is also a little taller,
since two exchanges were enough to start scrolling.

### Right-to-left replies read properly, everywhere

An agent answering in Arabic was laid out left-to-right in the main transcript:
the sentence read, but its full stop sat on the wrong end and a list's bullets
stayed on the left. Every paragraph, heading, list item, quote and table cell now
takes its direction from its own first word, so an English identifier at the top
of an Arabic answer no longer turns the whole thing around.

Code blocks stay left-to-right whatever surrounds them. A fenced block that
followed the prose moved its own punctuation — `);` to the far side of the line —
which is code that no longer says what it says.

### Smaller

The rule above the message box is gone; the box already separates itself.

## 0.17.0

### An agent that is working says so, for the whole turn

A long turn went quiet. Commands scrolled past, an approval was allowed
automatically, a new reply began — and nothing anywhere said anyone was busy.
The Send button sat there looking ready while a reply was still arriving.

Two faults, and the second is the one that mattered. Claude sends no per-turn
start signal, so Chorus derived one from the frame the CLI sends when a _session_
opens — which arrives once, while the end-of-turn signal arrives every turn. From
your second message onward, Chorus believed nothing was running: no working line,
no Stop button, and a sidebar that said the session was idle while it worked. The
other fault was narrower and just as total — the first time an agent showed its
thinking, the working line was suppressed for the rest of the session.

The line has also moved to the foot of the turn, under the newest output, which
is where you are reading. It now says what the agent itself reports it is doing —
_asking the model_, _compacting its context_ — and falls back to its own wording
through the long silences in between. The Send button is outlined while a turn
runs, so a filled one means idle and nothing else. Sending mid-turn still steers.

### Explain simply is a button under the reply

It used to work on a selection, and refused most of them: _"That passage is not
part of that reply"_. Selecting an answer means starting above the first line and
dragging to the end, which picks up the timestamp and the summary card — neither
of which is anything the agent said, so the check that guards against putting
words in an agent's mouth threw the whole thing out.

It is a button under every finished reply now, and it explains the whole answer
in your language rather than the part you managed to select. Nothing to drag, and
nothing that can be refused. Translate still works on a selection, where a
passage really is the subject.

### Clicking a path opens the file

A path in a tool row or in the list of files a turn changed opens in VS Code, at
the project that conversation belongs to. Rows that name a search pattern or a
subagent's brief stay as text, because they name nothing to open.

### Send a problem from VS Code into a conversation

Right-click a diagnostic — a type error, a lint rule, a compiler complaint — and
choose **Send this problem to Chorus**. The file, the line, the message and the
code it is about arrive in the composer of the conversation whose project the
file belongs to, as a draft. Nothing is sent until you send it, so you add what
you actually want done first.

**This needs the new extension.** Chorus and the extension refuse to talk across
a protocol change rather than guessing, so the status bar in VS Code will say to
update it: Settings → VS Code extension → Update, then reload VS Code.

### Links that are not https now open

A link to an `http` address, or a `mailto:`, was drawn as a link and did
nothing at all when clicked. Chorus was willing to draw more kinds of link than
it was willing to open. Both ends now agree.

## 0.16.0

### The transcript follows the reply again, all the way down

A reply that ended in commands, output or a diff could stop halfway and stay
there. It looked random because it was: two separate things had to line up.

The browser was moving the view back. Chromium keeps what you are reading still
when something _above_ it changes size, and the cards at the end of a turn land
above the foot — so it quietly held your place and left the tail below the fold.
Worse, Chorus read that same movement as _you_ scrolling up and stopped
following for good, which is why it never recovered on its own. Shrinking the
spare room under a short turn did it too.

Following now stops when you actually scroll — a wheel, a trackpad swipe, a
touch drag, Page Up — and nothing else. Coming back to the bottom resumes it.
Measured on the replies that used to fail: six of six now settle at the bottom
instead of one in six, and a reader who scrolls up mid-reply is left there.

Dragging a pane into a split, or reordering tabs, used to jump the moved pane to
the top. Only that pane remounts, which is why it was the only one that moved.
It comes back where you left it, and at the bottom if that is where it was.

### A tab says what its session is doing

Tabs carried two coloured dots naming which agents were in the room. That never
changes, so it was never the reason to look at a tab. They now show the state
the sidebar card already shows: working, waiting on an approval, waiting on a
question, stopped. A tab needing an approval tints, and its mark stays at full
strength even when the tab is not the one you are looking at — which is exactly
when you need to notice it.

### Chorus says what to install when it cannot find a CLI

Starting with no `codex` and no `claude` gave you a wordmark and `spawn claude
ENOENT`. The first screen now names both CLIs, gives the command to install
either, and says that one is enough — Chorus runs with a single agent. If a CLI
was found but would not run, it says where it found it instead, because being
told to install something you already have is its own dead end.

### Windows can find a CLI that is not where the defaults say

Chorus reported `claude` as missing on machines where it ran fine from a
terminal. It only knew two places to look. It now also looks where the native
installer writes, where scoop, Chocolatey and winget put their shims, and — by
asking npm rather than guessing — wherever npm's global prefix has been moved
to.

Confirmed on a real Windows machine for the first time, along with the rest of
the packaged bundle. Everything the 0.15.0 notes said about Windows still
stands: nobody has completed an install, no agent has started there, and no
terminal has opened. The installer is still unsigned.

### An aside is a two-way conversation, and its answer can come back

The card kept only half of it. Follow-up questions had nowhere to appear and
their answers ran on from the first, which read as the second question having
overwritten the first. Both sides are shown now, in order. And a decision you
reach in an aside can be sent back into the main conversation instead of being
retyped.

### Groundwork for opening the source

A licence, a security policy, and a README that describes what Chorus does
rather than what it was going to do.

## 0.15.0

### There is a Windows installer, and nobody has installed it yet

`Chorus-0.15.0-windows-x64-setup.exe` is attached to this release beside the
DMG, with a checksum. CI builds it, and a verifier confirms the app launches and
draws its interface out of that exact bundle.

That is the honest extent of it. **Nothing has run past the first window.** No
agent has started on Windows, no terminal has opened, and no one has completed
an install, an upgrade or an uninstall. The installer is also unsigned, so
SmartScreen will block it — choose "More info" then "Run anyway".

If you are on Windows, treat this as something to try and report back on rather
than something to depend on. [Installing Chorus on
Windows](docs/install-windows.md) lists what is already known to be degraded
there, so you can tell a known gap from a new one.

Everything below is macOS as much as Windows.

### An approval waits for you, however long that takes

A permission request used to expire. After five minutes — later, a responsive
window that a gesture could extend — Chorus answered on your behalf with
"timed out", the provider was told nothing had been chosen, and the turn carried
on. Walking away from your desk was a decision nobody made.

Neither provider ever asked for that window; it was Chorus's own. Requests now
stay open until you answer them. The two things the timer was really there for
are unchanged: ending a session or closing the app resolves everything
outstanding, and a turn you no longer want is ended by interrupting it.

### Three ways a file path could come back wrong

The same off-by-one lived in three places: a path was cut one character short
whenever the project sat at a filesystem root. A file mentioned to an agent
could arrive as `ile.ts` instead of `file.ts`, and a recap could silently list
nothing at all under "files changed" — which reads as a fact rather than as a
failure, and is why it went unnoticed.

Rare on macOS, where few people keep a project at `/`. Found by making the code
run somewhere that has more roots than one.

### Trusted mode recognises more of what it should refuse

The universal denials — recursive delete, force push, history rewrite — matched
only the exact lowercase spelling of a Unix command. `RM -RF` walked past them,
and so did `git.exe push --force`, because a four-character suffix was enough to
miss the pattern. Denials are now matched case-insensitively and cover the cmd
and PowerShell forms of the same irreversible actions.

Nothing that was allowed before is denied now except those. Allowances are
deliberately still matched exactly, because widening one has the opposite risk.

### Keyboard shortcuts are described by what they do

Every shortcut is now defined in one place rather than spelled out at each
handler, and the label you see is generated from it. On macOS the visible change
is small: `⇧⌘J` where it used to read `⌘⇧J`, which is the order macOS itself
uses.

### Smaller corrections

- The VS Code extension could refuse a `git:` or merge-request pane depending on
  how the path was written, and the check that was supposed to stop a path
  climbing out of the repository could be bypassed by writing it differently.
- A terminal whose `$SHELL` pointed at something uninstalled fell back to the
  shell least likely to exist rather than the one guaranteed to.
- Releases are built by CI now, from a clean checkout, for both platforms at
  once. The packaging step had a long-standing dependence on files left behind
  by a previous build — invisible on a machine that had built before, and fatal
  on one that had not.

### Known gaps in this release

- **Windows is unproven past first launch**, as above.
- Neither installer is signed the way its platform wants. The DMG is ad-hoc
  signed and meets Gatekeeper; the Windows installer has no certificate and
  meets SmartScreen.
- On Windows a terminal never reports itself as busy, so the confirmation before
  closing one cannot warn that a build is running; and an agent left behind by a
  crash is not cleaned up.

## 0.14.1

### The answer at the end of a turn now stands out from the working

A finished turn is supposed to mark its conclusion by brightness — the reply lit,
the working around it quieter. Only half of that was ever built. The rule meant to
brighten the answer set it to the colour every message already had, so it changed
nothing, and a turn's final reply looked exactly like the rest of the transcript.
It shipped that way in 0.13.0 and 0.14.0.

Everything that is not the answer is now a step quieter, including your own
message. It stays comfortably readable — the colour is one the palette guarantees
for prose — it simply stops competing with the reply you were waiting for.

This was the one genuine defect among the failing end-to-end specs recorded in
0.13.0's known gaps. The rest are assertions describing the old sidebar, and are
a cleanup rather than a bug.

## 0.14.0

### The rail says what kind of attention a session wants

A session shortcut used to have one way of saying it needed you, whether an agent
was blocked on a permission or had simply asked you something. Those are not the
same interruption — one is stalled work, the other is a conversation — and
Chorus has always known the difference internally without showing it.

Now it shows: a **red triangle** when an agent is blocked waiting for you to
approve a tool call, and a **blue square** when one has finished thinking and
asked you a question. The tile itself takes the colour too, so you are scanning
for a tile rather than for a dot on it. A session with both reports the approval
first, because answering that unblocks an agent and the question will still be
there afterwards.

The count now says what it counts. "2 to approve" rather than "2 waiting".

### A working session is visible from across the room

The dot marking a working agent was 7px and dimmed slightly on a cycle, which is
about as much signal as a dust speck. It is bigger, it pulses a ring in the
working agent's own colour, and the tile's border carries a light that travels
around it while the turn runs.

### Nothing destructive happens on one click

Restart and End used to ask unevenly. End would ask twice — but only while an
agent was working, and only from some of the places it appears. Restart never
asked at all, from anywhere. Both now open the same confirmation wherever you
press them, and it tells you what you actually lose: whether a turn is in
flight, and whether the conversation survives. It does, in both cases; ending
keeps it in history.

### The wait before an agent speaks is no longer a blank

There is a gap between sending a message and the first words coming back — the
provider connecting, context loading, a hook running. That gap showed one fixed
word and three dots for however long it lasted, which made a slow start look
indistinguishable from a stuck session. The row now works through a series of
phrases while it waits, so a long pause reads as a long pause.

### Smaller corrections

- The rail's shortcuts and its account readings sit centred now. They were 16px
  from the window's edge and 22px from the pane beside them, which read as a
  column leaning left.
- The account percentages line up on their right edges, so `6%` and `13%` can be
  compared down the column instead of ending wherever their digits ran out.
- Dragging a pane divider used to light a full-height white line, brighter than
  anything else on screen. It is now the width of the gap it moves, inset from
  the corners, and much quieter.
- Restart and End in the hover card carry icons.

### Known gaps in this release

Unchanged from 0.13.0 and still open: the control rail's pixel-parity pass is
unfinished, eight end-to-end specs are failing at those surfaces, and **the final
answer in a turn is still not brighter than the working around it** — the rule
meant to do it assigns a colour every message already has.

The confirmation dialog, the rotating wait phrases and the travelling border were
verified by their tests and by reading the rendered styles, not by driving them in
the app.

## 0.13.0

### The left side is a rail, not a stack of control panels

A session used to be a card holding its title, state, agent toggles, profile,
folder, plan mode, tasks, Summary, Review, cost, context, Restart and End — and
the whole card was also a drag handle. One object doing navigation, configuration,
monitoring and destruction at once.

It is now a **collapsed quick rail** by default: one shortcut per session, four
account readings, a terminal and settings. Open the drawer when you want to
manage rather than navigate. A row is a row; hovering or focusing it opens a
read-only preview, and every action lives in one menu behind `More` — with
Restart and End below a divider, and End arming itself while an agent is working.

Reordering is deliberate now rather than a consequence of touching a card. Drag a
session to a tab strip, a pane, or any of the four edges to split; `Arrange` mode
reorders the list and cannot reach the workspace. `Move Up` and `Move Down` do the
same without a drag, and the result is announced for screen readers.

### The transcript is rows, not boxes

A turn is an unboxed row with a face beside it. The bubble is gone — a bubble
around your own words claimed a two-sided conversation, which is the one thing
this app is not. A turn's working folds to one line each, openable, and the final
answer is marked so the conclusion does not read like more working.

Below 720px the face used to be drawn **on top of the speaker's name**. The
narrow layout was still positioning things by names the redesign had removed, so
below that width the avatar and the name resolved to the same rectangle.

### A drop target the size of the pane it will make

Dragging a session to a pane edge drew a thin strip and left you to infer the
result. It now fills the space the new pane will actually occupy — a half, or a
quarter when you split an already-split pane — with the dashed edge marking the
seam it opens along.

### The mention menu is no longer clipped

`@` and `/` opened a menu that the composer's dock cut off, so the list you were
choosing from was cropped by the box you were typing in.

### VS Code: a selection now says which version it is

Sending a selection from a merge-request diff, or the left pane of a git diff,
used to go out bare — `src/app.ts:120-134`, as though those were the lines on
disk. They are not, and an agent told otherwise can only open the file and be
wrong.

The pill now reads `remembered · MR a1b2c3d`, and the message names the commit
and how to see it: `git show a1b2c3d4e5f6:src/app.ts` is this version. Selections
also survive looking at something that is not a file, and each Chorus window
keeps its own root list rather than sharing one.

**This needs extension 0.8.0**, and that extension cannot talk to an older
Chorus. It says so plainly instead of failing quietly — a mismatch puts
"Chorus: update Chorus" in the status bar.

### Known gaps in this release

**The rail's visual approval is still open.** The behaviour shipped and was
reviewed; the pixel-parity pass against the supplied reference is not finished,
and eight end-to-end specs are failing at these surfaces. Seven are assertions
still describing the old sidebar. One is real and worth knowing: **the final
answer in a turn is not actually brighter than the working around it.** The rule
meant to do it assigns a colour every message already has, so the distinction is
absent rather than subtle.

**No real GitLab merge request has been opened against the new selection code.**
Every claim about MR diffs rests on unit tests over captured URIs and an
end-to-end fake that sends what a real window would send.

## 0.12.0

### There is a terminal in every session

`⌘J` opens a shell beside the conversation, and `⌘⇧J` opens a global one from
the activity bar. It is a real PTY, not a pipe — so `vim` and `htop` draw
properly, shell history works, and `⌃C` signals the process group instead of
closing a pipe on a process that never notices.

The shell belongs to the app, not to the panel you are looking at. Switch tabs
mid-build and the build keeps running; come back and the output is still there,
replayed from where it was. `⌘K` clears, and stays cleared.

Scrollback lives in memory and goes when the app does. It is deliberately not
written to the conversation log — a shell is a second stream that happens to
share a pane, and `cat .env` in a terminal is exactly the kind of thing the log
should not be keeping.

### The mention menu comes back when you do

Type `@` or `/`, switch to another app, come back — and the menu was gone. Not
closed and reopenable: **gone until you typed another character**, with your
`@ali` still sitting in the box and nothing on screen explaining why nothing was
being offered.

The menu closing when you click elsewhere in Chorus is deliberate; it floats over
the transcript and should get out of the way. But leaving the app is not leaving
the box — your caret is still in it when you come back — and those two were being
treated as the same thing.

### Picking a name can no longer land in the wrong place

A rarer one, found while fixing the above. If the draft changed between the menu
opening and you choosing from it — quoting a passage does that, so does sending —
the replacement could be written at an offset from the older text, overwriting a
few characters that had nothing to do with the mention. Choosing now works from a
single snapshot or does nothing at all.

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
