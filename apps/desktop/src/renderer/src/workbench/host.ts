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
 * **No instance field either, and the reason is an ordering the patch hit first.**
 * `BrowserHostService`'s constructor calls `registerListeners()`, which subscribes
 * to `this.onDidChangeFocus`, so the getter below runs while `super()` is still
 * executing. A field would not merely be unset at that moment: with
 * `target: ES2023`, class fields are *defined* after `super()` returns, so the
 * declaration would overwrite whatever the getter had cached and hand the base's
 * subscription one event while every later reader got another. `Event.map` and
 * `Event.latch` build a new event per call, so identity is the thing being kept.
 * The patch survived this with a readiness flag; a module-level `WeakMap` keyed on
 * the instance has no such window, because nothing declares it on the class.
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
