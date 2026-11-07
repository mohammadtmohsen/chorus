import { removeEveryPatch, stateFolder } from './patch.js'

void removeEveryPatch(stateFolder()).then((failures) => {
  if (failures > 0) process.exitCode = 1
})
