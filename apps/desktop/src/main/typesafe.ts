import { readAgentKey } from './agent-secrets.js'
import { checkTypesafeValue } from './typesafe-core.js'
export type { KeyCheck } from './typesafe-core.js'
export function checkTypesafeKey(userData: string): ReturnType<typeof checkTypesafeValue> {
  return checkTypesafeValue(readAgentKey(userData, 'typesafe'))
}
