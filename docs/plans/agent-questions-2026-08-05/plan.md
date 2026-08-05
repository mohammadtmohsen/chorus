# Multi-step agent questions

Structured questions from both agents, answered one at a time in the same
queue as approvals.

Status: **not started.** This document is the plan; no code has been written.

---

## 1. What was verified first

Everything below was read out of the installed code, not from documentation.
The two providers turned out to disagree in ways that decide the contract, so
this section is the load-bearing part of the plan.

### Claude — real, and currently mis-routed

- `AskUserQuestion` is present in the installed CLI, `2.1.220` — 40 occurrences,
  including an `AskUserQuestionTimeout` policy setting.
- `CanUseTool` takes `toolName: string`, so the tool name arrives as data. The
  absence of `AskUserQuestion` from `sdk.d.ts` means nothing; tool names are not
  enumerated as types.
- `PermissionResult`'s allow branch carries `updatedInput?: Record<string, unknown>`
  (`sdk.d.ts:2114`), which is the channel an answer travels back on.

**The bug this exposes.** `claude-adapter.ts:375` routes _every_ tool through
`handlePermission`, which emits `approval.requested` unconditionally. So today a
Claude question does not fall through — it renders as an ordinary approval card
reading "claude needs approval", with Allow/Deny buttons and no way to answer it.
Allowing it returns no `updatedInput`, so the agent receives no answer.

That makes this a fix as much as a feature, and it is the seam to cut at.

### Codex — real, and silently dropped

`codex-adapter.ts:161` `handleServerRequest` maps every server request through
`mapApprovalRequest`, and line 168 returns `Promise.resolve({})` when the mapper
returns `null`. `item/tool/requestUserInput` is not recognised, so it takes that
path: Codex is handed an empty object and the question vanishes without a trace.

(An earlier note in the transcript doubted this fallback existed. It does —
line 168. The doubt was wrong and is retracted here.)

The generated wire types are already in the repo and are exact:

| Type                           | Shape                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `ToolRequestUserInputParams`   | `{ threadId, turnId, itemId, questions[], autoResolutionMs: number \| null }` |
| `ToolRequestUserInputQuestion` | `{ id, header, question, isOther, isSecret, options: Option[] \| null }`      |
| `ToolRequestUserInputOption`   | `{ label, description }`                                                      |
| `ToolRequestUserInputAnswer`   | `{ answers: string[] }`                                                       |
| `ToolRequestUserInputResponse` | `{ answers: { [questionId]: { answers: string[] } } }`                        |

`UserInput.ts` is unrelated — it is the input-message type, not an answer type.

### The divergence that shapes everything

The two providers do not model a question the same way:

| Concern      | Codex                                   | Claude                                |
| ------------ | --------------------------------------- | ------------------------------------- |
| Multi-select | implicit — `answers` is an array        | explicit `multiSelect` boolean        |
| Free text    | `options: null`                         | not expressible; options are required |
| "Other"      | explicit `isOther` per question         | harness-provided, always available    |
| Secret       | explicit `isSecret` per question        | no concept                            |
| Answer unit  | whole set at once, keyed by question id | whole set at once via `updatedInput`  |
| Timeout      | `autoResolutionMs`                      | `AskUserQuestionTimeout` policy       |

Both answer the **entire set in one response**, which is the single most
important fact for the UI: the wizard collects all answers locally and sends
once at the end. There is no per-question round trip to the agent.

The normalized type must therefore be a superset, with per-provider capability
flags, and the renderer must degrade rather than assume. Fields Claude cannot
express (`isSecret`, free text) must be representable-but-absent, not invented.

---

## 2. Phases

### Phase 0 — Restore verification tooling _(blocked on user approval)_

Commit `c134cc4` overwrote the root `package.json` with the desktop one. The
root lost 15 scripts and 9 devDeps, so `pnpm lint`, `pnpm test` and
`pnpm typecheck` do not exist and eslint/vitest/@types/node are not installed.

    git checkout 26ce310 -- package.json && pnpm install

Kept out of this feature's commits. **Do not start Phase 2 without this** — the
adapter mappings are pure functions whose whole point is being unit-tested, and
writing them with no runner is how this ships broken.

### Phase 1 — Normalized contract

`packages/agent-protocol`: add `UserInputRequest`, `UserInputQuestion`,
`UserInputOption`, `UserInputAnswer`, and events `userinput.requested` /
`userinput.answered`. Add to the event union and to the coalescable list check
(`events.ts:181`). Superset shape per the divergence table; every field a given
provider cannot express is optional.

### Phase 2 — Adapter mappings _(pure functions, unit-tested)_

- **Codex:** recognise `item/tool/requestUserInput` in `handleServerRequest`
  before the `mapApprovalRequest` null-fallback. Hold the promise open in an
  `openUserInputs` map, mirroring `openApprovals`. Resolve with
  `{ answers: { [id]: { answers: string[] } } }`. Honour `autoResolutionMs`.
- **Claude:** branch on `toolName === 'AskUserQuestion'` in `handlePermission`
  _before_ the approval path. Resolve with
  `{ behavior: 'allow', updatedInput: { ...input, answers } }`.

Tests: both mappings round-trip, multi-select, free text, Other, secret,
malformed input, and the Claude case that currently regresses into an approval.

### Phase 3 — Orchestration and persistence

Queue user-input requests alongside approvals in event-log order. Persist to the
event store so replay reconstructs pending questions. Clear on turn interrupt
and session close. **Redact secret answers** before any event is persisted or
logged — the answer text must never reach disk.

Keep approval _policy_ and question handling separate in the backend; they share
only presentation order.

### Phase 4 — IPC

Add a validated `userinput:answer` channel to `IPC_CONTRACT` in
`apps/desktop/src/shared/ipc.ts`, with a zod schema mirroring the normalized
answer type. Route in `runtime.ts`.

### Phase 5 — Presentation queue

Generalize the renderer queue from `PendingApproval[]` to
`(Approval | UserInput)[]`, oldest first. Reuse the queue mechanics shipped for
approvals — one item at a time, "N more waiting", focus returns to the composer
when empty. A multi-question request stays **one queue item**.

### Phase 6 — The wizard

One question at a time inside the item: "Question 1 of 3". Choices,
multi-select, free text, Other, secret (masked), Back preserving prior answers.
Submit all answers only on the final step.

Keyboard rules inherited from the approval card, and they are not optional:

- Focus the first useful control, but **do not preselect an answer** — a
  preselected default plus a focused button is an accidental answer.
- Enter advances/confirms; Space must not activate a focused primary control
  (see `Session.tsx` — Space is blocked on Allow for exactly this reason).
- Drop key-repeat so a held Enter cannot walk the whole wizard.
- Do not steal focus from a composer being typed into mid-draft, or if you do,
  guarantee the draft survives (it does today — verified).

### Phase 7 — Verification

Mocked: both round trips, multiple questions, follow-ups, mixed
approval/question ordering, both agents at once, multi-select/Other/free
text/secret, auto-resolution, interrupt, replay, focus restoration, held-Enter,
secret redaction.

Live: a real question answered end to end through **each** provider. The feature
is not done on mocked IPC alone.

---

## 3. Risks

- **Experimental Codex API.** Every generated type is marked `EXPERIMENTAL`. The
  wire shape can change; keep the mapping in one place so a break is one edit.
- **Claude regression risk.** Branching inside `handlePermission` sits on the
  path every tool takes. A mistake there breaks _all_ approvals, not just
  questions. This is the highest-risk edit in the plan.
- **Secret answers.** Redaction has to be right the first time; a leaked secret
  in the event store is not recoverable by fixing the code later.
- **Live Codex testing** needs a Codex session that actually emits
  `requestUserInput`, which may be hard to trigger on demand.

---

## 4. Open decisions

1. **Phase 0** — restore the root `package.json`? Everything testable depends on
   it. Asked twice, unanswered.
2. **Free text and secrets on Claude** — Claude cannot express either. Options:
   (a) render them anyway and send the typed text back through `updatedInput`,
   (b) mark them Codex-only. (a) is likely fine but is a guess about CLI
   tolerance and should be tested before being relied on.
