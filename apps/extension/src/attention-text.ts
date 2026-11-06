import { requiresExplicitUserDecision } from '@chorus/agent-protocol'
import type { AttentionPush } from '../../desktop/src/shared/ipc.js'
import { summarize } from '../../desktop/src/renderer/src/transcript.js'
import messages from '../../desktop/src/renderer/src/i18n/en.json'
import type { AttentionRoom } from '../../engine/src/protocol.js'

const TEXT = messages.extension.attention

const fill = (template: string, values: Readonly<Record<string, string>>): string =>
  Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{{${key}}}`, value),
    template
  )

export function roomDescription(room: AttentionRoom): string {
  const parts: string[] = []
  if (room.approvals === 1) parts.push(TEXT.approvalOne)
  if (room.approvals > 1) parts.push(fill(TEXT.approvalMany, { count: String(room.approvals) }))
  if (room.questions === 1) parts.push(TEXT.questionOne)
  if (room.questions > 1) parts.push(fill(TEXT.questionMany, { count: String(room.questions) }))
  return [room.projectName, ...parts].filter((part) => part !== '').join(' · ')
}

export function attentionChoices(push: AttentionPush): readonly string[] {
  if (push.reason !== 'approval') return [messages.notify.open]
  return [
    messages.approval.allowOnce,
    ...(push.kind !== 'fileChange' && !requiresExplicitUserDecision(push.kind)
      ? [messages.approval.allowAlways]
      : []),
    messages.approval.deny,
    messages.notify.open,
  ]
}

export function attentionHeadline(push: AttentionPush): string {
  const agent = { agent: push.agentId }
  if (push.reason === 'approval') {
    const subject = summarize({ kind: push.kind, request: push.request })
    return `${push.title}: ${fill(messages.notify.waiting, agent)}. ${subject}`
  }
  if (push.reason === 'question') return `${push.title}: ${fill(messages.notify.question, agent)}`
  return `${push.title}: ${fill(messages.notify.idle, agent)}`
}
