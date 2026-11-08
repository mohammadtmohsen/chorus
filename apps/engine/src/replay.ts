import type { StoredEvent } from '@chorus/event-store'
import type { ChorusRuntime } from '../../desktop/src/main/runtime.js'
import type { TranscriptEvent } from '../../desktop/src/shared/ipc.js'
import type { EnginePeer } from './peers.js'

const CHUNK_BYTES = 512 * 1024

function* batches(
  runtime: ChorusRuntime,
  conversationIds: ReadonlySet<string>,
  afterSeq: number,
  throughSeq: number
): Generator<TranscriptEvent[]> {
  const cursors = [...conversationIds].map((conversationId) => ({
    conversationId,
    events: [] as StoredEvent[],
    afterSeq,
    done: false,
  }))
  let chunk: TranscriptEvent[] = []
  let bytes = 0
  for (;;) {
    for (const cursor of cursors) {
      if (cursor.events.length > 0 || cursor.done) continue
      cursor.events = runtime.store
        .read(cursor.conversationId, { afterSeq: cursor.afterSeq, limit: 16 })
        .filter((event) => event.seq <= throughSeq)
      if (cursor.events.length === 0) cursor.done = true
    }
    const next = cursors
      .flatMap((cursor) => {
        const event = cursor.events[0]
        return event === undefined ? [] : [{ cursor, event }]
      })
      .sort((a, b) => a.event.seq - b.event.seq)[0]
    if (next === undefined) break
    const stored = next.event
    next.cursor.events.shift()
    next.cursor.afterSeq = stored.seq
    const event: TranscriptEvent = {
      seq: stored.seq,
      id: stored.id,
      conversationId: stored.conversationId,
      actor: stored.actor,
      type: stored.type,
      payload: stored.payload,
      createdAt: stored.createdAt,
    }
    const size = Buffer.byteLength(JSON.stringify(event))
    if (chunk.length > 0 && bytes + size > CHUNK_BYTES) {
      yield chunk
      chunk = []
      bytes = 0
    }
    chunk.push(event)
    bytes += size
  }
  if (chunk.length > 0) yield chunk
}

export function replayEvents(
  runtime: ChorusRuntime,
  peer: EnginePeer,
  afterSeq: number
): Promise<void> {
  const role = peer.role
  const ids = new Set(
    role.kind === 'main'
      ? peer.state.conversationIds
      : runtime
          .activeSessions()
          .filter(
            (session) =>
              session.projectId === role.projectId &&
              peer.state.conversationIds.has(session.conversationId)
          )
          .map((session) => session.conversationId)
  )
  for (const id of [...ids]) for (const aside of runtime.listAsides(id)) ids.add(aside.id)
  const throughSeq = runtime.logPosition()
  return peer.replay(throughSeq, ids, () => batches(runtime, ids, afterSeq, throughSeq))
}
