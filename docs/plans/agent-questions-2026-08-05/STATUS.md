# Status

Gates after every phase below: `pnpm lint` clean, `pnpm typecheck` 15/15,
`pnpm test` 468 passed / 3 skipped.

## Phase 0 done: verification tooling restored

Root `package.json` restored from `26ce310`; `pnpm install`. Brought back 15
scripts and 9 devDeps (eslint, vitest, turbo, typescript, prettier,
`@types/node`). `pnpm-lock.yaml` damage collapsed from 961 deletions to 63.

This paid for itself immediately: lint — not typecheck — caught three
exhaustiveness gaps that would otherwise have shipped silently
(`conversation-service`, `projections`, `catchup` all failed to handle the new
events).

## Phase 1 done: normalized contract

`packages/agent-protocol/src/user-input.ts` — `UserInputRequest`,
`UserInputQuestion`, `UserInputOption`, `UserInputAnswer`, `UserInputResponse`,
plus `isFreeText`, `isComplete`, `redactAnswers`. `UserInputId` added to
`@chorus/shared`. `userinput.requested` added to the `AgentEvent` union and to
the undroppable list.

Shaped as a superset with per-provider capability flags, because Codex and
Claude disagree about what a question is (see plan §1).

## Phase 2 done: adapter mappings, both providers

- **Codex** — `mapUserInputRequest`, `toCodexUserInputResponse`, and
  `USER_INPUT_METHOD`. Wired into `handleServerRequest` *before* the
  `mapApprovalRequest` null-fallback, which is where questions were previously
  answered with `{}` and silently dropped.
- **Claude** — `mapUserInputRequest`, `toClaudeUserInputResult`, and
  `USER_INPUT_TOOL`. Branches at the top of `handlePermission`, so the path every
  other tool takes is untouched. This also fixes the pre-existing bug where a
  Claude question rendered as an ordinary "claude needs approval" card that could
  not be answered.

19 unit tests across both mappers: choices, multi-select, free text, Other,
secret, malformed input, id-less questions, auto-resolution, cancel/timeout, and
a regression guard that ordinary tools still produce approvals.

## Phase 3 done: orchestration and persistence

- `userinput.requested` / `userinput.answered` payloads in the event store.
- `respondToUserInput` on `AgentSession` — implemented by both real adapters,
  the supervisor, and the fake.
- `ConversationService.answerUserInput()` and `pendingQuestions()`. Questions are
  logged and held; **policy never evaluates them** — a rule may decide whether an
  action is allowed, not what the user wants.
- Secret redaction enforced in `redactAnswers` at the store boundary, failing
  closed on unknown questions.
- Both adapters drain pending questions on close, so a closed session cannot
  leave `canUseTool` hanging forever.

5 orchestrator tests, including one asserting the secret string appears nowhere
in the serialized event log.

---

## Not started

- **Phase 4** — IPC (`userinput:answer` channel + runtime routing).
- **Phase 5** — renderer queue generalized to `Approval | UserInput`.
- **Phase 6** — the wizard (Question 1 of 3, Back, multi-select, Other, free
  text, secret masking, focus and held-Enter rules inherited from the approval
  card).
- **Phase 7** — live round trips. **Nothing has been tested against a real
  agent.** Everything above is unit-tested against fakes; no real Codex or Claude
  question has been answered end to end. The feature is not done until both have.

## Open

Free text and secrets on Claude — the CLI cannot express either. Currently
mapped as "always has options, never secret". Whether it will accept a typed
answer through `updatedInput` is untested and should be checked before Phase 6
relies on it.
