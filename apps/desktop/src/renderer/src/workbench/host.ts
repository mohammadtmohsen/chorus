import { BrowserHostService } from '@codingame/monaco-vscode-host-service-override/vscode/vs/workbench/services/host/browser/browserHostService'
import { Emitter, Event } from '@codingame/monaco-vscode-api/vscode/vs/base/common/event'
import { onDidChangeWindowFocus, windowHasFocus } from './window-focus.js'

/**
 * Phase 3's answer, moved out of a patched dependency and into this repository.
 *
 * Until `36.2.7` this was `patches/@codingame__monaco-vscode-host-service-override`:
 * two extra parameters on the override, `hasFocus` and `onDidChangeFocus`, which
 * `services.ts` filled from `window-focus.ts`. The published package never had
 * them. A patch is pinned to one exact version, so the upgrade either reproduced
 * it against `36.2.7` or retired it — and a subclass on the `IHostService` key
 * does the same work in our own source, where it is typechecked and read, which
 * the patch's replacement text never was.
 *
 * **No constructor**, for the reason `clipboard.ts` gives: `BrowserHostService`
 * declares eleven injected dependencies and the instantiation service reads them
 * from static metadata a subclass inherits. Declaring one here would shadow that
 * and the injection would arrive empty.
 *
 * **No instance field either, and that is the patch's own hard-won note.**
 * `BrowserHostService`'s constructor calls `registerListeners()`, which subscribes
 * to `this.onDidChangeFocus` — so the getter below runs while `super()` is still
 * executing and before any field of this class has been assigned. The patch needed
 * a readiness flag to survive that; a module-level `WeakMap` keyed on the instance
 * has no such window, because it is populated by the getter itself rather than by
 * field initialisation.
 *
 * **Both sources, each firing the recomputed value.** The window event carries the
 * trigger points a document cannot observe — Chorus's composer taking focus while
 * this document was already blurred — and the base's own event carries the ones it
 * can. Neither payload is forwarded: `hasFocus` is the single source, so both arms
 * fire what it answers at that moment, and `latch` drops the repeats that produces.
 */
const composedFocus = new WeakMap<ChorusHostService, Event<boolean>>()

export class ChorusHostService extends BrowserHostService {
  override get hasFocus(): boolean {
    return windowHasFocus()
  }

  override get onDidChangeFocus(): Event<boolean> {
    const held = composedFocus.get(this)
    if (held !== undefined) return held

    const emitter = this._register(new Emitter<boolean>())
    this._register(onDidChangeWindowFocus(() => emitter.fire(this.hasFocus)))
    this._register(super.onDidChangeFocus(() => emitter.fire(this.hasFocus)))

    const event = Event.latch(emitter.event, undefined, this._store)
    composedFocus.set(this, event)
    return event
  }
}
