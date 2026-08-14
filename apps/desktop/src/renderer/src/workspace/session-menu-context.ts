import { createContext, useContext } from 'react'
import type { MenuTarget } from './SessionMenu.js'

/**
 * The one session menu, openable from anywhere that can see a session.
 *
 * It used to be hosted by `SessionList` and reachable only from a drawer row.
 * The composer's agent chips and its settings control open the *same* menu —
 * that was the decision, against building a second one that does the same job —
 * and the composer sits inside a pane, several components away, with `App`
 * between them as the only common ancestor.
 *
 * A context rather than a prop threaded through `renderSession`, because this is
 * a capability ("open the shell's menu") and not state anyone renders from. A
 * store action was the alternative and was rejected: the target carries a
 * `DOMRect` and the element focus returns to, and live DOM references do not
 * belong in a store that persists a snapshot of itself.
 */
export const SessionMenuContext = createContext<((target: MenuTarget) => void) | null>(null)

/**
 * Opens the session menu, or does nothing outside the workspace.
 *
 * Null-safe on purpose: `Session` and its composer are rendered by tests and by
 * `QuickQuestion` outside any provider, and a control that throws there would
 * make an unrelated harness fail for a menu it never opens.
 */
export function useSessionMenu(): (target: MenuTarget) => void {
  const open = useContext(SessionMenuContext)
  return open ?? (() => undefined)
}
