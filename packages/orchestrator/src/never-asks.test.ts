import { EventStore, openSqlite, type SqliteHandle } from '@chorus/event-store'
import { newApprovalId } from '@chorus/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { ConversationService } from './conversation-service.js'
import { SessionGrants } from './policy/engine.js'
import { profileById } from './policy/rules.js'
import { FakeAdapter, type FakeAgentSession } from './testing/fake-adapter.js'

/**
 * An aside answers its own approvals, and the shape of that answer is the whole
 * reconciliation between two things the user asked for.
 *
 * "When I give you a permission I want to keep it on the side chat" means grants
 * must carry. "It should close like a tooltip" means it can never stop and wait
 * for a person — there is no room in the card for an approval, and an aside
 * nobody is watching would hold one open until its deadline, wedging the fork.
 *
 * So: `evaluate` runs first and unchanged, and only the `ask` outcome is
 * replaced. Already-granted things go through; new consent is refused because
 * nobody is there to give it.
 */

const CONV = 'conv-aside'
const OPTS = {
  cwd: '/tmp/project',
  sandbox: { mode: 'readOnly' as const, writableRoots: [], networkAccess: false },
}

let db: SqliteHandle
let store: EventStore
let adapter: FakeAdapter
let session: FakeAgentSession

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Just the verdict and who reached it — the payload carries more than matters here. */
const decisions = (): { outcome: unknown; decidedBy: unknown }[] =>
  store
    .read(CONV)
    .filter((e) => e.payload.type === 'approval.decided')
    .map((e) => {
      const p = e.payload as unknown as Record<string, unknown>
      return { outcome: p['outcome'], decidedBy: p['decidedBy'] }
    })

async function open(over: { neverAsks?: boolean; grants?: SessionGrants } = {}): Promise<void> {
  const service = new ConversationService({
    store,
    conversationId: CONV,
    adapter,
    profile: profileById('read-only'),
    neverAsks: over.neverAsks ?? true,
    ...(over.grants === undefined ? {} : { grants: over.grants }),
  })
  session = (await service.start(OPTS)) as unknown as FakeAgentSession
}

/** A command the read-only profile has no rule for, so policy says ask. */
const askableCommand = (): void => {
  session.emit({
    type: 'approval.requested',
    request: {
      id: newApprovalId(),
      kind: 'command',
      command: ['npm', 'publish'],
      cwd: '/tmp/project',
      withNetwork: false,
      expiresAt: 5 * 60_000,
    },
  } as never)
}

beforeEach(() => {
  db = openSqlite({ path: ':memory:' })
  store = EventStore.open(db).store
  store.append({
    conversationId: CONV,
    actor: 'user',
    payload: { type: 'conversation.created', projectId: 'p1', title: 'Aside', kind: 'aside' },
  })
  adapter = new FakeAdapter({ id: 'claude' })
})

describe('an aside never waits for a person', () => {
  it('denies what it would otherwise have asked about', async () => {
    await open()
    askableCommand()
    await tick()
    expect(decisions()).toEqual([{ outcome: 'deny', decidedBy: 'policy' }])
  })

  it('answers immediately rather than running out a deadline', async () => {
    // The wedge this exists to prevent: an unattended fork holding an approval
    // open is a turn nobody can finish. No scheduler is passed, so if the
    // decision depended on a timer firing there would be none here to fire it.
    await open()
    askableCommand()
    await tick()
    expect(decisions()).toHaveLength(1)
  })

  it('tells the agent why, so it can say so instead of just stopping', async () => {
    await open()
    askableCommand()
    await tick()
    // To the *provider*, not to the log: `approval.decided` records the verdict,
    // the scope and the rule, but carries no message. So the reason reaches the
    // agent — which can then explain itself in its answer — and a card wanting
    // to explain a refusal must supply its own words rather than read them back.
    expect(JSON.stringify(session.decisions)).toContain('explain, not act')
  })

  it('still queues for a person when this is an ordinary conversation', async () => {
    await open({ neverAsks: false })
    askableCommand()
    await tick()
    // Nothing decided: an ordinary session holds the approval for the user.
    expect(decisions()).toEqual([])
  })
})

describe('an aside keeps the permissions already given', () => {
  it('allows what the profile allows, without asking', async () => {
    await open()
    session.emit({
      type: 'approval.requested',
      request: {
        id: newApprovalId(),
        kind: 'command',
        command: ['git', 'status'],
        cwd: '/tmp/project',
        withNetwork: false,
        expiresAt: 5 * 60_000,
      },
    } as never)
    await tick()
    // `SAFE_READS` allows this outright, and an aside must not become stricter
    // than the session it copies.
    expect(decisions()).toEqual([{ outcome: 'allow', decidedBy: 'policy' }])
  })

  it('honours a grant the user gave in the parent conversation', async () => {
    const grants = new SessionGrants()
    grants.addAlways({
      id: newApprovalId(),
      kind: 'command',
      command: ['npm', 'publish'],
      cwd: '/tmp/project',
      withNetwork: false,
      expiresAt: 0,
    } as never)

    await open({ grants })
    askableCommand()
    await tick()
    // The point of carrying grants: having said "always" once, the user is not
    // silently refused in the aside.
    expect(decisions()).toEqual([{ outcome: 'allow', decidedBy: 'policy' }])
  })
})
