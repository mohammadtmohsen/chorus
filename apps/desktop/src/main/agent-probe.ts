import { agentKeyIsSet } from './agent-secrets.js'
import { probeAgentsWithSecrets } from './agent-probe-core.js'
export { deepseekFrom, extractVersion } from './agent-probe-core.js'
export function probeAgents(userDataPath: string): ReturnType<typeof probeAgentsWithSecrets> {
  return probeAgentsWithSecrets((id) => agentKeyIsSet(userDataPath, id))
}
