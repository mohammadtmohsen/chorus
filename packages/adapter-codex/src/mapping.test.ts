import { describe, expect, it } from 'vitest'
import { toSandboxMode } from './codex-adapter.js'
import {
  mapApprovalRequest,
  mapNotification,
  mapUserInputRequest,
  toCodexDecision,
  toCodexUserInputResponse,
  USER_INPUT_METHOD,
} from './mapping.js'

const CTX = { seq: 1, now: 1_000, approvalTtlMs: 60_000 }
const map = (method: string, params: unknown) => mapNotification({ method, params }, CTX)

describe('sandbox translation', () => {
  it('emits the kebab-case string enum thread/start actually accepts', () => {
    // The published docs describe an object with a camelCase `type`. That shape
    // is rejected outright — verified against the server in S3a.
    expect(toSandboxMode({ mode: 'readOnly', writableRoots: [], networkAccess: false })).toBe(
      'read-only'
    )
    expect(
      toSandboxMode({ mode: 'workspaceWrite', writableRoots: ['/x'], networkAccess: false })
    ).toBe('workspace-write')
    expect(toSandboxMode({ mode: 'fullAccess', writableRoots: [], networkAccess: true })).toBe(
      'danger-full-access'
    )
  })
})

describe('streaming', () => {
  it('maps an agent message delta', () => {
    expect(map('item/agentMessage/delta', { itemId: 'm1', delta: 'Hello' })).toMatchObject({
      type: 'message.delta',
      itemRef: 'm1',
      text: 'Hello',
      agentId: 'codex',
    })
  })

  it('maps both reasoning delta streams onto one event', () => {
    for (const method of ['item/reasoning/summaryTextDelta', 'item/reasoning/textDelta']) {
      expect(map(method, { itemId: 'r1', delta: 'thinking' })).toMatchObject({
        type: 'reasoning.delta',
        itemRef: 'r1',
      })
    }
  })

  it('maps the aggregate turn diff Codex provides natively', () => {
    expect(map('turn/diff/updated', { unifiedDiff: '--- a\n+++ b\n' })).toMatchObject({
      type: 'diff.updated',
      unifiedDiff: '--- a\n+++ b\n',
    })
  })
})

describe('turn lifecycle', () => {
  it('reads the turn id out of the nested turn object', () => {
    expect(map('turn/started', { turn: { id: 't1' } })).toMatchObject({
      type: 'turn.started',
      turnRef: 't1',
    })
  })

  it('preserves an interrupted status', () => {
    // Codex reports this explicitly; Claude does not, which is why the
    // orchestrator tracks user-initiated stops separately (S3).
    expect(map('turn/completed', { turn: { id: 't1', status: 'interrupted' } })).toMatchObject({
      type: 'turn.completed',
      status: 'interrupted',
    })
  })

  it('treats an unknown terminal status as failed rather than completed', () => {
    expect(map('turn/completed', { turn: { id: 't1', status: 'exploded' } })).toMatchObject({
      status: 'failed',
    })
  })
})

describe('items', () => {
  it('emits command.started with the command and cwd', () => {
    const e = map('item/started', {
      item: { type: 'commandExecution', id: 'c1', command: ['git', 'status'], cwd: '/repo' },
    })
    expect(e).toMatchObject({
      type: 'command.started',
      itemRef: 'c1',
      command: ['git', 'status'],
      cwd: '/repo',
    })
  })

  it('normalizes a string command into argv form', () => {
    const e = map('item/started', {
      item: { type: 'commandExecution', id: 'c1', command: 'ls -la', cwd: '/' },
    })
    expect(e).toMatchObject({ command: ['ls -la'] })
  })

  it('emits message.completed only on completion, never on start', () => {
    const item = { type: 'agentMessage', id: 'm1', text: 'done' }
    expect(map('item/started', { item })).toBeNull()
    expect(map('item/completed', { item })).toMatchObject({
      type: 'message.completed',
      text: 'done',
    })
  })

  it('maps a proposed file change with its patch', () => {
    const e = map('item/started', {
      item: { type: 'fileChange', id: 'f1', changes: [{ path: 'a.ts', diff: '@@' }] },
    })
    expect(e).toMatchObject({
      type: 'file.change.proposed',
      files: [{ path: 'a.ts', patch: '@@' }],
    })
  })
})

/**
 * What the file change actually did.
 *
 * The started phase is a *proposal* — it fires when the operation begins, so a
 * declined or failed patch looks exactly like one that landed. The completed
 * phase carries `kind` and `status`, and this file used to drop both.
 *
 * Every count here is asserted as a number rather than as "present". A card of
 * `+0 −0` is what this mapping produces if the body is parsed as a diff when it
 * is really file content, and nothing but a count assertion catches it.
 */
describe('applied file changes', () => {
  const completed = (changes: unknown[], status = 'completed') =>
    map('item/completed', { item: { type: 'fileChange', id: 'f1', changes, status } })

  const UPDATE = ['@@ -1,2 +1,3 @@', ' keep', '-gone', '+new', '+also'].join('\n')

  /** The first file of a completed change, for the assertions about patches. */
  const fileOf = (
    event: ReturnType<typeof map>
  ): { patch: string; added: number; omittedLines?: number } => {
    if (event?.type !== 'file.change.completed') throw new Error('not a change')
    const file = event.files[0]
    if (file === undefined) throw new Error('no files')
    return file
  }

  it('counts an update from its hunks', () => {
    expect(
      completed([{ path: 'a.ts', kind: { type: 'update', move_path: null }, diff: UPDATE }])
    ).toMatchObject({
      type: 'file.change.completed',
      outcome: 'applied',
      files: [{ path: 'a.ts', change: 'modified', added: 2, removed: 1 }],
    })
  })

  it('counts an add from the file it carries, not from hunks it has none of', () => {
    // Codex sends raw content for an add. Parsed as a diff this is zero lines,
    // which is the bug: the largest number in the card reads as nothing.
    expect(
      completed([{ path: 'new.ts', kind: { type: 'add' }, diff: 'one\ntwo\nthree\n' }])
    ).toMatchObject({ files: [{ change: 'added', added: 3, removed: 0 }] })
  })

  it('counts a delete on the removed side', () => {
    expect(completed([{ path: 'old.ts', kind: { type: 'delete' }, diff: 'a\nb\n' }])).toMatchObject(
      { files: [{ change: 'removed', added: 0, removed: 2 }] }
    )
  })

  it('crosses a rename: path is where it went, oldPath where it was', () => {
    // Both are strings, so getting this backwards fails nothing at the type
    // level and everything on screen.
    expect(
      completed([
        { path: 'src/was.ts', kind: { type: 'update', move_path: 'src/is.ts' }, diff: UPDATE },
      ])
    ).toMatchObject({
      files: [{ path: 'src/is.ts', oldPath: 'src/was.ts', change: 'renamed', added: 2 }],
    })
  })

  it('keeps failed and declined apart', () => {
    const one = [{ path: 'a.ts', kind: { type: 'update', move_path: null }, diff: UPDATE }]
    expect(completed(one, 'declined')).toMatchObject({ outcome: 'declined' })
    expect(completed(one, 'failed')).toMatchObject({ outcome: 'failed' })
    expect(completed(one, 'completed')).toMatchObject({ outcome: 'applied' })
  })

  it('refuses to call a patch applied when the CLI did not say it was', () => {
    // A completed item still reading `inProgress` is a missing field, and a card
    // must not claim a file changed on the strength of one.
    const one = [{ path: 'a.ts', kind: { type: 'update', move_path: null }, diff: UPDATE }]
    expect(completed(one, 'inProgress')).toMatchObject({ outcome: 'failed' })
    expect(
      map('item/completed', { item: { type: 'fileChange', id: 'f1', changes: one } })
    ).toMatchObject({ outcome: 'failed' })
  })

  it('reads a change with no kind as an edit, which is what an older CLI sends', () => {
    expect(completed([{ path: 'a.ts', diff: UPDATE }])).toMatchObject({
      files: [{ change: 'modified', added: 2 }],
    })
  })

  it('gives an update the header parseDiff needs', () => {
    /*
     * Codex sends a bare unified body for an update. `parseDiff` skips every
     * line until it sees `diff --git`, so without this the diff is not wrong,
     * it is *absent* — no files, no counts, an empty card.
     */
    const file = fileOf(
      completed([{ path: 'a.ts', kind: { type: 'update', move_path: null }, diff: UPDATE }])
    )
    expect(file.patch.startsWith('diff --git a/a.ts b/a.ts\n')).toBe(true)
    expect(file.patch).toContain(UPDATE)
  })

  it('builds a diff for an added file out of the content it sends', () => {
    // There is no diff to relay: an add carries the file. The mode line is what
    // lets the status letter be read back off the patch downstream.
    const patch = fileOf(
      completed([{ path: 'new.ts', kind: { type: 'add' }, diff: 'one\ntwo\n' }])
    ).patch
    expect(patch).toContain('new file mode 100644')
    expect(patch).toContain('--- /dev/null')
    expect(patch).toContain('@@ -0,0 +1,2 @@')
    expect(patch).toContain('+one')
  })

  it('builds one for a deleted file the other way round', () => {
    const patch = fileOf(
      completed([{ path: 'old.ts', kind: { type: 'delete' }, diff: 'a\n' }])
    ).patch
    expect(patch).toContain('deleted file mode 100644')
    expect(patch).toContain('+++ /dev/null')
    expect(patch).toContain('-a')
  })

  it('caps a whole file and says how much it left out', () => {
    // A long block fills the pane and scrolls off the row naming the file, so
    // the diff loses the one thing identifying it. Silently truncating would be
    // worse than either.
    const body = Array.from({ length: 40 }, (_, i) => `line ${String(i + 1)}`).join('\n')
    const file = fileOf(completed([{ path: 'big.ts', kind: { type: 'add' }, diff: body }]))
    expect(file.added).toBe(40)
    expect(file.omittedLines).toBe(28)
    expect(file.patch).toContain('+line 12')
    expect(file.patch).not.toContain('+line 13')
  })

  it('names both paths in the patch for a rename', () => {
    const file = fileOf(
      completed([
        { path: 'src/was.ts', kind: { type: 'update', move_path: 'src/is.ts' }, diff: UPDATE },
      ])
    )
    expect(file.patch).toContain('diff --git a/src/was.ts b/src/is.ts')
    expect(file.patch).toContain('rename from src/was.ts')
  })

  it('leaves a body that already has a header alone', () => {
    // A future CLI sending a complete diff must not get a second header stapled
    // to the front of it.
    const whole = 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b\n'
    expect(
      fileOf(completed([{ path: 'a.ts', kind: { type: 'update', move_path: null }, diff: whole }]))
        .patch
    ).toBe(whole)
  })

  it('does not count a diff header as a changed line', () => {
    const withHeaders = ['--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-old', '+new'].join('\n')
    expect(
      completed([{ path: 'a.ts', kind: { type: 'update', move_path: null }, diff: withHeaders }])
    ).toMatchObject({ files: [{ added: 1, removed: 1 }] })
  })
})

describe('deliberate silence', () => {
  it.each([
    'mcpServer/startupStatus/updated',
    'remoteControl/status/changed',
    'thread/status/changed',
    'account/updated',
  ])('drops %s rather than surfacing noise', (method) => {
    expect(map(method, {})).toBeNull()
  })

  it('drops an item type we do not render', () => {
    expect(map('item/started', { item: { type: 'userMessage', id: 'u1' } })).toBeNull()
  })

  it('drops an item notification with no item', () => {
    expect(map('item/completed', {})).toBeNull()
  })
})

describe('approval requests', () => {
  it('maps a command approval onto the unified card', () => {
    const r = mapApprovalRequest(
      'item/commandExecution/requestApproval',
      { itemId: 'i1', command: ['rm', '-rf', '/'], cwd: '/repo', reason: 'destructive' },
      CTX
    )
    expect(r).toMatchObject({
      kind: 'command',
      id: 'i1',
      command: ['rm', '-rf', '/'],
      cwd: '/repo',
      reason: 'destructive',
      agentId: 'codex',
    })
  })

  it('joins a file-change approval to the item that carried the paths', () => {
    // FileChangeRequestApprovalParams carries NO changes -- only an itemId. The
    // live app rendered "Edit " with no path until this lookup existed.
    const item = {
      type: 'fileChange',
      id: 'i9',
      changes: [{ path: '/repo/a.ts', diff: '@@ -1 +1 @@' }],
    }
    const r = mapApprovalRequest('item/fileChange/requestApproval', { itemId: 'i9' }, CTX, (id) =>
      id === 'i9' ? item : undefined
    )
    expect(r).toMatchObject({
      kind: 'fileChange',
      files: [{ path: '/repo/a.ts', patch: '@@ -1 +1 @@' }],
    })
  })

  it('degrades to an empty file list when the item was never seen', () => {
    const r = mapApprovalRequest('item/fileChange/requestApproval', { itemId: 'gone' }, CTX)
    expect(r).toMatchObject({ kind: 'fileChange', files: [] })
  })

  it('prefers approvalId over itemId when the server supplies one', () => {
    // Several approvals can share an itemId (the zsh-exec-bridge case), so
    // keying on itemId alone would make them collide.
    const r = mapApprovalRequest(
      'item/commandExecution/requestApproval',
      { itemId: 'shared', approvalId: 'cb-1', command: 'ls' },
      CTX
    )
    expect(r?.id).toBe('cb-1')
  })

  it('accepts the command as a string, which is how it arrives', () => {
    const r = mapApprovalRequest(
      'item/commandExecution/requestApproval',
      { itemId: 'i1', command: 'git status' },
      CTX
    )
    expect(r).toMatchObject({ kind: 'command', command: ['git status'] })
  })

  it('sets a deadline, because Codex imposes none', () => {
    // An unanswered requestApproval hangs the turn forever (plan §4.4).
    const r = mapApprovalRequest(
      'item/fileChange/requestApproval',
      { itemId: 'i2', changes: [] },
      CTX
    )
    expect(r?.expiresAt).toBe(CTX.now + CTX.approvalTtlMs)
  })

  it('maps a permission grant request', () => {
    const r = mapApprovalRequest(
      'item/permissions/requestApproval',
      { itemId: 'i3', cwd: '/repo', permissions: { filesystem: ['/tmp'], network: true } },
      CTX
    )
    expect(r).toMatchObject({
      kind: 'permissionGrant',
      requested: { filesystem: ['/tmp'], network: true },
    })
  })

  it('returns null for a request that is not an approval', () => {
    expect(mapApprovalRequest('tool/requestUserInput', {}, CTX)).toBeNull()
  })
})

describe('decision translation', () => {
  it('distinguishes once from session', () => {
    expect(toCodexDecision('allow', 'once')).toBe('accept')
    expect(toCodexDecision('allow', 'session')).toBe('acceptForSession')
  })

  it('fails closed on a timeout', () => {
    // An expired approval must never become an accept.
    expect(toCodexDecision('timeout', 'session')).toBe('decline')
    expect(toCodexDecision('deny', 'once')).toBe('decline')
  })

  it('passes cancel through distinctly from decline', () => {
    expect(toCodexDecision('cancel', 'once')).toBe('cancel')
  })
})

describe('account rate limits', () => {
  const CTX = { seq: 1, now: 1_000, approvalTtlMs: 60_000 }

  /* Captured from a live `account/rateLimits/read` on a Plus plan. */
  const LIVE = {
    method: 'account/rateLimits/updated',
    params: {
      rateLimits: {
        primary: { usedPercent: 55, windowDurationMins: 10_080, resetsAt: 1_786_176_677 },
        secondary: null,
      },
    },
  }

  it('names a window by its own duration and fixes the units', () => {
    const event = mapNotification(LIVE, CTX)
    expect(event?.type).toBe('limits')
    expect(event?.type === 'limits' && event.windows).toEqual([
      // Seconds on the wire; milliseconds everywhere else.
      { id: '10080m', usedPercent: 55, windowMinutes: 10_080, resetsAt: 1_786_176_677_000 },
    ])
  })

  /*
   * Codex has always sent this and the adapter dropped it for as long as it
   * existed. It is the one notification that says the agent and the transcript
   * have stopped agreeing, so losing it means a reader cannot tell which
   * messages the agent still holds.
   */
  /*
   * There was no case for this at all, so a turn refused for hitting an account
   * limit fell through to null: no reply, no notice, an idle composer.
   */
  it('reports a failed turn rather than dropping it', () => {
    expect(
      map('error', {
        error: { message: 'Usage limit reached', additionalDetails: 'resets in 3h' },
        willRetry: false,
      })
    ).toMatchObject({
      type: 'error',
      message: 'Usage limit reached — resets in 3h',
      recoverable: false,
    })
  })

  it('marks a retryable failure as recoverable', () => {
    expect(
      map('error', { error: { message: 'Overloaded', additionalDetails: null }, willRetry: true })
    ).toMatchObject({ type: 'error', recoverable: true })
  })

  it('keeps the moment an agent summarised its own history', () => {
    expect(map('thread/compacted', {})).toMatchObject({ type: 'context.compacted' })
  })

  it('reports both windows when both are there', () => {
    const event = mapNotification(
      {
        method: 'account/rateLimits/updated',
        params: {
          rateLimits: {
            primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_786_000_000 },
            secondary: { usedPercent: 60, windowDurationMins: 10_080, resetsAt: 1_786_100_000 },
          },
        },
      },
      CTX
    )
    expect(event?.type === 'limits' && event.windows.map((w) => w.id)).toEqual(['300m', '10080m'])
  })

  it('says nothing when the account has no windows', () => {
    expect(
      mapNotification({ method: 'account/rateLimits/updated', params: { rateLimits: {} } }, CTX)
    ).toBeNull()
  })
})

describe('user input requests', () => {
  const ask = (params: unknown) => mapUserInputRequest(USER_INPUT_METHOD, params, CTX)

  it('maps a choice question', () => {
    const r = ask({
      itemId: 'q-set-1',
      questions: [
        {
          id: 'db',
          header: 'Database',
          question: 'Which database?',
          isOther: false,
          isSecret: false,
          options: [
            { label: 'Postgres', description: 'Relational' },
            { label: 'SQLite', description: 'Embedded' },
          ],
        },
      ],
      autoResolutionMs: null,
    })

    expect(r).toMatchObject({
      id: 'q-set-1',
      agentId: 'codex',
      expiresAt: CTX.now + CTX.approvalTtlMs,
      questions: [
        {
          id: 'db',
          header: 'Database',
          question: 'Which database?',
          multiSelect: false,
          allowOther: false,
          isSecret: false,
          options: [
            { label: 'Postgres', description: 'Relational' },
            { label: 'SQLite', description: 'Embedded' },
          ],
        },
      ],
    })
    // No auto-resolution was offered, so none is claimed.
    expect(r?.autoResolvesAt).toBeUndefined()
  })

  it('treats null options as free text rather than as no options yet', () => {
    const r = ask({
      itemId: 's',
      questions: [{ id: 'name', header: 'Name', question: 'Project name?', options: null }],
    })
    expect(r?.questions[0]?.options).toEqual([])
  })

  it('carries isOther and isSecret through', () => {
    const r = ask({
      itemId: 's',
      questions: [
        {
          id: 'token',
          header: 'Token',
          question: 'API token?',
          isOther: true,
          isSecret: true,
          options: null,
        },
      ],
    })
    expect(r?.questions[0]).toMatchObject({ allowOther: true, isSecret: true })
  })

  it('turns autoResolutionMs into an absolute deadline', () => {
    const r = ask({
      itemId: 's',
      questions: [{ id: 'a', header: 'H', question: 'Q?', options: null }],
      autoResolutionMs: 5_000,
    })
    expect(r?.autoResolvesAt).toBe(CTX.now + 5_000)
  })

  it('drops questions with no id, which could never be answered', () => {
    // The response is keyed by question id, so an id-less question would be
    // silently lost on the way back with nothing to tell the user why.
    const r = ask({
      itemId: 's',
      questions: [
        { id: '', header: 'H', question: 'Ghost?', options: null },
        { id: 'real', header: 'H', question: 'Real?', options: null },
      ],
    })
    expect(r?.questions).toHaveLength(1)
    expect(r?.questions[0]?.id).toBe('real')
  })

  it('returns null when nothing answerable survives, so the caller can fall through', () => {
    expect(ask({ itemId: 's', questions: [] })).toBeNull()
    expect(ask({ itemId: 's', questions: [{ id: '', header: '', question: '' }] })).toBeNull()
  })

  it('ignores every other server request', () => {
    expect(
      mapUserInputRequest('item/commandExecution/requestApproval', { itemId: 'x' }, CTX)
    ).toBeNull()
  })

  it('is not confused with an approval, and vice versa', () => {
    // The two mappers must not both claim the same method, or one request would
    // produce two cards.
    const params = { itemId: 's', questions: [{ id: 'a', header: 'H', question: 'Q?' }] }
    expect(mapApprovalRequest(USER_INPUT_METHOD, params, CTX)).toBeNull()
    expect(mapUserInputRequest(USER_INPUT_METHOD, params, CTX)).not.toBeNull()
  })
})

describe('user input responses', () => {
  it('keys answers by question id', () => {
    expect(
      toCodexUserInputResponse({
        outcome: 'answered',
        answers: [
          { questionId: 'db', values: ['Postgres'] },
          { questionId: 'features', values: ['auth', 'billing'] },
        ],
      })
    ).toEqual({
      answers: { db: { answers: ['Postgres'] }, features: { answers: ['auth', 'billing'] } },
    })
  })

  it('sends nothing rather than inventing answers on cancel or timeout', () => {
    expect(toCodexUserInputResponse({ outcome: 'cancel' })).toEqual({ answers: {} })
    expect(toCodexUserInputResponse({ outcome: 'timeout' })).toEqual({ answers: {} })
  })
})
