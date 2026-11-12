import { z } from 'zod'

export const LM_INPUT_CHAR_LIMIT = 65_536
export const LM_OUTPUT_TOKEN_LIMIT = 2_048
export const LM_OUTPUT_CHAR_LIMIT = 16_384

export const LanguageModelRequest = z
  .object({
    requestId: z.uuid(),
    family: z.literal('claude-haiku'),
    messages: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant']),
            text: z.string().max(LM_INPUT_CHAR_LIMIT),
          })
          .strict()
      )
      .min(1)
      .max(64),
    outputLimit: z.number().int().min(1).max(LM_OUTPUT_TOKEN_LIMIT),
  })
  .strict()
  .refine(
    ({ messages }) =>
      messages.reduce((size, message) => size + message.text.length + message.role.length + 4, 0) <=
      LM_INPUT_CHAR_LIMIT
  )
export type LanguageModelRequest = z.infer<typeof LanguageModelRequest>

export const LanguageModelCancel = z.object({ requestId: z.uuid() }).strict()
export type LanguageModelCancel = z.infer<typeof LanguageModelCancel>

export const LanguageModelFailure = z.enum([
  'unavailable',
  'busy',
  'cancelled',
  'timeout',
  'rate-limited',
  'auth',
  'failed',
])
export type LanguageModelFailure = z.infer<typeof LanguageModelFailure>

export const LanguageModelResponse = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), text: z.string().max(LM_OUTPUT_CHAR_LIMIT) }).strict(),
  z
    .object({ ok: z.literal(false), failure: LanguageModelFailure, message: z.string().max(1_024) })
    .strict(),
])
export type LanguageModelResponse = z.infer<typeof LanguageModelResponse>

export const LANGUAGE_MODEL_CONTRACT = {
  'lm:generate': { request: LanguageModelRequest, response: LanguageModelResponse },
  'lm:cancel': {
    request: LanguageModelCancel,
    response: z.object({ ok: z.literal(true) }).strict(),
  },
} as const
