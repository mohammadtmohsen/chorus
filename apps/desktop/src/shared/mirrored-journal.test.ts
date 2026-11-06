import { describe, expect, it, vi } from 'vitest'
import { EMPTY_CONVERSATION_NOTE } from '@chorus/shared'
import {
  NoteJournalSlot,
  NoteSync,
  noteText,
  parseJournal,
  type NoteApi,
  type NoteJournal,
} from '../renderer/src/useConversationNote.js'
import { createChorusApi, type ShellTransport } from './create-chorus-api.js'
import {
  CONVERSATION_NOTE_JOURNAL_PUSH_CHANNEL,
  type ConversationNoteJournalResponse,
} from './ipc.js'
import {
  MirroredJournalBackend,
  type MirroredJournalRemote,
  type MirroredJournalSnapshot,
} from './mirrored-journal.js'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: Error) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined
  let reject: (reason: Error) => void = () => undefined
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const answer = (current: string | null): ConversationNoteJournalResponse => ({
  ok: true,
  matched: true,
  current,
})

const draft = (text: string): NoteJournal => ({ text: { text, base: 1 }, view: null })
const raw = (owner: string, text: string): string => JSON.stringify({ owner, ...draft(text) })

function remote(initial: string | null = null): {
  readonly api: MirroredJournalRemote
  readonly reads: Deferred<ConversationNoteJournalResponse>[]
  readonly writes: {
    readonly expected: string | null
    readonly next: string | null
    readonly reply: Deferred<ConversationNoteJournalResponse>
  }[]
} {
  const reads: Deferred<ConversationNoteJournalResponse>[] = []
  const writes: {
    readonly expected: string | null
    readonly next: string | null
    readonly reply: Deferred<ConversationNoteJournalResponse>
  }[] = []
  return {
    reads,
    writes,
    api: {
      read: () => {
        const reply = deferred<ConversationNoteJournalResponse>()
        reads.push(reply)
        if (reads.length === 1) reply.resolve(answer(initial))
        return reply.promise
      },
      compare: (expected, next) => {
        const reply = deferred<ConversationNoteJournalResponse>()
        writes.push({ expected, next, reply })
        return reply.promise
      },
    },
  }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function opened(backend: MirroredJournalBackend, owner = 'ours'): NoteJournalSlot {
  const slot = new NoteJournalSlot(backend, owner)
  const read = slot.read()
  if (!read.ok) throw new Error()
  slot.adopt(read.raw)
  return slot
}

describe('a journal mirror prepared from the engine', () => {
  it('does not expose a webview backup until the engine has answered', async () => {
    const read = deferred<ConversationNoteJournalResponse>()
    const compare = vi.fn(() => Promise.resolve(answer(null)))
    const backend = new MirroredJournalBackend(
      { read: () => read.promise, compare },
      { backup: { acknowledged: 'old', current: 'old', pending: false } }
    )
    const preparation = backend.prepare()
    expect(backend.read()).toEqual({ ok: false })
    expect(backend.compare(null, 'early')).toEqual({ ok: false })
    read.resolve(answer('engine'))
    await preparation
    expect(backend.read()).toEqual(answer('engine'))
    expect(compare).not.toHaveBeenCalled()
  })

  it('leaves the journal unreadable when preparation is refused', async () => {
    const backend = new MirroredJournalBackend({
      read: () => Promise.resolve({ ok: false, error: 'offline' }),
      compare: () => Promise.resolve(answer(null)),
    })
    await expect(backend.prepare()).rejects.toThrow('offline')
    expect(backend.read()).toEqual({ ok: false })
  })

  it('validates an engine response before exposing the mirror', async () => {
    const backend = new MirroredJournalBackend({
      read: () => Promise.resolve({ ok: true, matched: true } as ConversationNoteJournalResponse),
      compare: () => Promise.resolve(answer(null)),
    })
    await expect(backend.prepare()).rejects.toThrow()
    expect(backend.read()).toEqual({ ok: false })
  })

  it('waits for preparation before constructing a note journal slot', async () => {
    const prepared = deferred<undefined>()
    const journal = vi.fn(() => ({
      read: () => answer(raw('old', 'recovered')),
      compare: (_expected: string | null, next: string | null) => answer(next),
    }))
    const api: NoteApi = {
      prepare: () => prepared.promise,
      journal,
      load: () => Promise.resolve(EMPTY_CONVERSATION_NOTE),
      saveText: () => Promise.resolve({ status: 'saved', note: EMPTY_CONVERSATION_NOTE }),
      saveView: () => Promise.resolve(EMPTY_CONVERSATION_NOTE),
    }
    const opening = NoteSync.open('conversation', api, 'ours')
    expect(journal).not.toHaveBeenCalled()
    prepared.resolve(undefined)
    const sync = await opening
    expect(journal).toHaveBeenCalledExactlyOnceWith('conversation')
    expect(noteText(sync.snapshot())).toBe('recovered')
    sync.dispose()
  })
})

describe('ordered acknowledged journal writes', () => {
  it('sends each CAS only after the previous write is acknowledged', async () => {
    const engine = remote()
    const backend = new MirroredJournalBackend(engine.api)
    await backend.prepare()
    expect(backend.compare(null, 'first')).toEqual(answer('first'))
    expect(backend.compare('first', 'second')).toEqual(answer('second'))
    expect(backend.read()).toEqual(answer('second'))
    expect(engine.writes).toHaveLength(1)
    expect(backend.snapshot()).toEqual({
      acknowledged: null,
      current: 'second',
      pending: true,
      conflicted: false,
    })

    engine.writes[0]?.reply.resolve(answer('first'))
    await settle()
    expect(engine.writes).toHaveLength(2)
    expect(engine.writes[1]).toMatchObject({ expected: 'first', next: 'second' })
    engine.writes[1]?.reply.resolve(answer('second'))
    await backend.flush()
    expect(backend.snapshot()).toEqual({
      acknowledged: 'second',
      current: 'second',
      pending: false,
      conflicted: false,
    })
  })

  it('keeps an unacknowledged clear behind the draft it clears', async () => {
    const engine = remote()
    const backend = new MirroredJournalBackend(engine.api)
    await backend.prepare()
    backend.compare(null, 'draft')
    backend.compare('draft', null)
    expect(engine.writes).toHaveLength(1)
    engine.writes[0]?.reply.resolve(answer('draft'))
    await settle()
    expect(engine.writes[1]).toMatchObject({ expected: 'draft', next: null })
    engine.writes[1]?.reply.resolve(answer(null))
    await backend.flush()
    expect(backend.snapshot().pending).toBe(false)
  })

  it('stops later writes after a failed acknowledgement and retains newer edits', async () => {
    const engine = remote()
    const copies: MirroredJournalSnapshot[] = []
    const backend = new MirroredJournalBackend(engine.api, { save: (copy) => copies.push(copy) })
    await backend.prepare()
    backend.compare(null, 'first')
    backend.compare('first', 'second')
    engine.writes[0]?.reply.reject(new Error('offline'))
    await expect(backend.flush()).rejects.toThrow('offline')
    expect(engine.writes).toHaveLength(1)
    expect(backend.compare('second', 'third')).toEqual({ ok: false })
    expect(backend.read()).toEqual(answer('third'))
    expect(copies.at(-1)).toEqual({
      acknowledged: null,
      current: 'third',
      pending: true,
      conflicted: false,
    })

    const retry = backend.prepare()
    await settle()
    engine.reads[1]?.resolve(answer(null))
    await retry
    expect(engine.writes[1]).toMatchObject({ expected: null, next: 'third' })
    engine.writes[1]?.reply.resolve(answer('third'))
    await backend.flush()
  })

  it('recovers a lost acknowledgement by reading the engine before retrying', async () => {
    const engine = remote()
    const backend = new MirroredJournalBackend(engine.api)
    await backend.prepare()
    backend.compare(null, 'draft')
    engine.writes[0]?.reply.reject(new Error('lost'))
    await expect(backend.flush()).rejects.toThrow('lost')
    const retry = backend.prepare()
    await settle()
    engine.reads[1]?.resolve(answer('draft'))
    await retry
    await backend.flush()
    expect(engine.writes).toHaveLength(1)
    expect(backend.snapshot().pending).toBe(false)
  })

  it('does not treat a failed second-copy write as an engine failure', async () => {
    const engine = remote()
    const backend = new MirroredJournalBackend(engine.api, {
      save: () => {
        throw new Error('state unavailable')
      },
    })
    await backend.prepare()
    backend.compare(null, 'draft')
    engine.writes[0]?.reply.resolve(answer('draft'))
    await backend.flush()
    expect(backend.read()).toEqual(answer('draft'))
  })
})

describe('a journal CAS conflict', () => {
  it('preserves both the other owner’s record and the newest local draft', async () => {
    const engine = remote()
    const backend = new MirroredJournalBackend(engine.api)
    await backend.prepare()
    const slot = opened(backend)
    expect(slot.sync(draft('first'))).toBe('ok')
    const theirs = raw('other', 'theirs')
    engine.writes[0]?.reply.resolve({ ok: true, matched: false, current: theirs })
    await expect(backend.flush()).rejects.toThrow()
    expect(slot.sync(draft('newest'))).toBe('writeFailed')
    expect(parseJournal(backend.snapshot().current)?.text?.text).toBe('newest')
    expect(backend.snapshot().acknowledged).toBe(theirs)
    expect(engine.writes).toHaveLength(1)
  })

  it('rebases the same owner’s local draft onto an acknowledged record', async () => {
    const engine = remote()
    const backend = new MirroredJournalBackend(engine.api)
    await backend.prepare()
    const slot = opened(backend)
    slot.sync(draft('mine'))
    const sameOwner = raw('ours', 'older')
    engine.writes[0]?.reply.resolve({ ok: true, matched: false, current: sameOwner })
    await settle()
    expect(slot.sync(draft('mine'))).toBe('ok')
    expect(engine.writes[1]).toMatchObject({ expected: sameOwner, next: raw('ours', 'mine') })
    engine.writes[1]?.reply.resolve(answer(raw('ours', 'mine')))
    await backend.flush()
  })

  it('reports a late write failure through the existing note journal health', async () => {
    const engine = remote()
    const backend = new MirroredJournalBackend(engine.api)
    const saved = { ...EMPTY_CONVERSATION_NOTE, body: 'saved', revision: 1, version: 1 }
    const api: NoteApi = {
      prepare: () => backend.prepare(),
      journal: () => backend,
      load: () => Promise.resolve(saved),
      saveText: () => Promise.resolve({ status: 'saved', note: saved }),
      saveView: () => Promise.resolve(saved),
    }
    const sync = await NoteSync.open('conversation', api, 'ours')
    sync.load()
    await settle()
    sync.edit('kept after failure')
    engine.writes[0]?.reply.resolve({ ok: false, error: 'offline' })
    await expect(backend.flush()).rejects.toThrow('offline')
    expect(sync.snapshot().journal).toBe('writeFailed')
    expect(noteText(sync.snapshot())).toBe('kept after failure')
    sync.dispose()
  })
})

describe('a restored webview journal backup', () => {
  it('replays pending changes only after the engine confirms their base', async () => {
    const engine = remote('base')
    const backend = new MirroredJournalBackend(engine.api, {
      backup: { acknowledged: 'base', current: 'unsent', pending: true },
    })
    await backend.prepare()
    expect(backend.read()).toEqual(answer('unsent'))
    expect(engine.writes[0]).toMatchObject({ expected: 'base', next: 'unsent' })
    engine.writes[0]?.reply.resolve(answer('unsent'))
    await backend.flush()
  })

  it('retains an unsent backup without overwriting a changed engine record', async () => {
    const engine = remote('other')
    const backend = new MirroredJournalBackend(engine.api, {
      backup: { acknowledged: 'base', current: 'unsent', pending: true },
    })
    await backend.prepare()
    expect(backend.read()).toEqual(answer('unsent'))
    expect(backend.compare('unsent', 'newer')).toEqual({
      ok: true,
      matched: false,
      current: 'other',
    })
    expect(backend.snapshot()).toEqual({
      acknowledged: 'other',
      current: 'newer',
      pending: true,
      conflicted: true,
    })
    expect(engine.writes).toHaveLength(0)
  })

  it('never replays a conflicted clear over another owner after a reload', async () => {
    const theirs = raw('other', 'theirs')
    const engine = remote()
    const backend = new MirroredJournalBackend(engine.api)
    await backend.prepare()
    backend.compare(null, raw('ours', 'draft'))
    backend.compare(raw('ours', 'draft'), null)
    engine.writes[0]?.reply.resolve({ ok: true, matched: false, current: theirs })
    await expect(backend.flush()).rejects.toThrow()

    const restoredEngine = remote(theirs)
    const restored = new MirroredJournalBackend(restoredEngine.api, { backup: backend.snapshot() })
    await restored.prepare()
    expect(restoredEngine.writes).toHaveLength(0)
    expect(opened(restored).sync(null)).toBe('ok')
    expect(restored.snapshot().acknowledged).toBe(theirs)
    expect(restoredEngine.writes).toHaveLength(0)
  })
})

describe('the shared journal transport seam', () => {
  function transport(): ShellTransport {
    return {
      invoke: () => Promise.resolve(undefined),
      on: () => () => undefined,
      pathForFile: () => '',
      noteJournal: () => answer(null),
    }
  }

  it('keeps desktop preparation a no-op and delegates webview preparation', async () => {
    await expect(
      createChorusApi(transport()).prepareConversationNoteJournal({
        conversationId: 'conversation',
      })
    ).resolves.toBeUndefined()
    const host = transport()
    const prepared = deferred<undefined>()
    const prepare = vi.fn(() => prepared.promise)
    host.prepareConversationNoteJournal = prepare
    const preparation = createChorusApi(host).prepareConversationNoteJournal({
      conversationId: 'conversation',
    })
    expect(prepare).toHaveBeenCalledExactlyOnceWith({ conversationId: 'conversation' })
    prepared.resolve(undefined)
    await preparation
  })

  it('validates preparation requests and local journal change pushes', async () => {
    const host = transport()
    const prepare = vi.fn(() => Promise.resolve())
    let push: ((payload: unknown) => void) | undefined
    const stop = vi.fn()
    host.prepareConversationNoteJournal = prepare
    host.on = (channel, listener) => {
      expect(channel).toBe(CONVERSATION_NOTE_JOURNAL_PUSH_CHANNEL)
      push = listener
      return stop
    }
    const api = createChorusApi(host)
    await expect(api.prepareConversationNoteJournal({ conversationId: '' })).rejects.toThrow()
    expect(prepare).not.toHaveBeenCalled()
    const changed = vi.fn()
    const unsubscribe = api.onConversationNoteJournal(changed)
    push?.({ conversationId: '' })
    push?.({ conversationId: 'conversation', extra: true })
    expect(changed).not.toHaveBeenCalled()
    push?.({ conversationId: 'conversation' })
    expect(changed).toHaveBeenCalledExactlyOnceWith({ conversationId: 'conversation' })
    unsubscribe()
    expect(stop).toHaveBeenCalledOnce()
  })
})
