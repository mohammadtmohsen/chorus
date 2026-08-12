import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import { useEffect, useRef } from 'react'
import type { TerminalPush, TerminalRefShape } from '../../shared/ipc.js'
import { pendingUntilAttached, shouldApply, type Attachment } from './terminal-stream.js'

/**
 * One terminal on screen.
 *
 * xterm owns the DOM inside `host` — it builds it with `document.createElement`,
 * never from a string, so the app's no-`dangerouslySetInnerHTML` rule holds by
 * construction rather than by care. Nothing here interpolates output into
 * markup; it is handed to the emulator as data.
 *
 * The shell is not in this component. It lives in main and outlives every mount,
 * which is why this only ever `detach`es on unmount — see `terminal.ts`.
 */

/**
 * The sixteen ANSI colours, plus the surface, read from CSS.
 *
 * Read rather than hardcoded because `styles.css` re-declares every token under
 * `prefers-color-scheme: light`, and a fixed palette would make the terminal the
 * one surface in the app that ignored it.
 */
function readTheme(): ITheme {
  const style = getComputedStyle(document.documentElement)
  const token = (name: string): string => style.getPropertyValue(name).trim()
  return {
    background: token('--sunken'),
    foreground: token('--bone'),
    cursor: token('--bone'),
    cursorAccent: token('--sunken'),
    selectionBackground: token('--line'),
    black: token('--ansi-black'),
    red: token('--ansi-red'),
    green: token('--ansi-green'),
    yellow: token('--ansi-yellow'),
    blue: token('--ansi-blue'),
    magenta: token('--ansi-magenta'),
    cyan: token('--ansi-cyan'),
    white: token('--ansi-white'),
    brightBlack: token('--ansi-bright-black'),
    brightRed: token('--ansi-bright-red'),
    brightGreen: token('--ansi-bright-green'),
    brightYellow: token('--ansi-bright-yellow'),
    brightBlue: token('--ansi-bright-blue'),
    brightMagenta: token('--ansi-bright-magenta'),
    brightCyan: token('--ansi-bright-cyan'),
    brightWhite: token('--ansi-bright-white'),
  }
}

export interface TerminalViewProps {
  readonly terminal: TerminalRefShape
  /** Told when the shell exits, so the panel can say so rather than go blank. */
  readonly onExit?: (code: number) => void
  /** Given a focus function on mount, so `⌘J` can put the caret in the shell. */
  readonly onReady?: (focus: () => void) => void
  readonly label: string
}

export function TerminalView(props: TerminalViewProps): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const { onExit, onReady, terminal } = props

  /*
   * Keyed on the terminal's identity, not on the object.
   *
   * `terminal` is a fresh object every render, so depending on it directly would
   * tear the shell's view down and build it again sixty times a second while
   * anything above it re-rendered.
   */
  const scope = terminal.scope
  const conversationId = terminal.scope === 'session' ? terminal.conversationId : null

  useEffect(() => {
    const element = host.current
    if (element === null) return

    const ref: TerminalRefShape =
      conversationId === null ? { scope: 'global' } : { scope: 'session', conversationId }

    const style = getComputedStyle(document.documentElement)
    const term = new Terminal({
      allowProposedApi: true,
      fontFamily: style.getPropertyValue('--mono').trim(),
      fontSize: 12,
      theme: readTheme(),
      // Ligatures are off everywhere else in this app for the same reason.
      cursorBlink: true,
      scrollback: 5_000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(element)
    fit.fit()

    /*
     * Subscribe *before* attaching.
     *
     * `attach` returns a snapshot taken at a sequence number. Anything the shell
     * writes between that snapshot and a listener going live has nowhere to go,
     * so the listener comes first and what arrives early is queued until there
     * is an attachment to judge it against.
     */
    let attachment: Attachment | null = null
    let queued: TerminalPush[] = []
    let cancelled = false

    const apply = (push: TerminalPush, current: Attachment): void => {
      if (push.kind === 'exit') {
        term.write(`\r\n[2m[process exited with code ${String(push.code)}][0m\r\n`)
        onExit?.(push.code)
        return
      }
      // The ack is the renderer half of flow control: without it main can only
      // see its own mirror, and a view that cannot keep up is invisible to the
      // watermark.
      term.write(push.data, () => {
        void window.chorus.ackTerminal({ ref, epoch: current.epoch, seq: push.seq })
      })
    }

    const stop = window.chorus.onTerminalOutput((push) => {
      if (attachment === null) {
        queued.push(push)
        return
      }
      if (shouldApply(push, attachment)) apply(push, attachment)
    })

    void window.chorus
      .attachTerminal({ ref, cols: term.cols, rows: term.rows })
      .then((opened) => {
        /*
         * StrictMode runs this effect twice, and the cleanup can land before the
         * attach resolves — so an attachment nobody is going to use still has to
         * be released, or the shell keeps pushing to a view that is gone.
         */
        if (cancelled) {
          void window.chorus.detachTerminal({ ref, epoch: opened.epoch })
          return
        }
        term.write(opened.snapshot)
        attachment = { ref, epoch: opened.epoch, seq: opened.seq }
        for (const push of pendingUntilAttached(queued, attachment)) apply(push, attachment)
        queued = []
        onReady?.(() => {
          term.focus()
        })
        term.focus()
      })
      .catch(() => {
        term.write('[2m[the terminal could not be opened][0m\r\n')
      })

    /*
     * `⌘K` clears, the way it does in Terminal.app and every terminal since.
     *
     * Handled here rather than in the workspace's global listener because it is
     * only a clear *while a terminal has the caret*; everywhere else `⌘K` is the
     * split chord. Returning false stops xterm passing the keystroke to the
     * shell, which would otherwise send a literal `^K` and kill the line.
     *
     * Both copies go: the view's, and the headless mirror in main that a remount
     * restores from. Clearing one without the other means every cleared line
     * comes back the next time the panel is opened.
     */
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      if (!event.metaKey || event.altKey || event.shiftKey || event.ctrlKey) return true
      if (event.key.toLowerCase() !== 'k') return true
      term.clear()
      if (attachment !== null) {
        void window.chorus.clearTerminal({ ref, epoch: attachment.epoch })
      }
      return false
    })

    const typed = term.onData((data) => {
      if (attachment === null) return
      void window.chorus.writeTerminal({ ref, epoch: attachment.epoch, data })
    })

    /*
     * Geometry has to travel, or `vim` and line wrapping stay at whatever the
     * shell started with and `SIGWINCH` never fires. `onResize` is what the fit
     * addon triggers, so this covers a drag, a window resize and a pane split
     * without three separate paths.
     */
    const resized = term.onResize(({ cols, rows }) => {
      if (attachment === null) return
      void window.chorus.resizeTerminal({ ref, epoch: attachment.epoch, cols, rows })
    })

    const observer = new ResizeObserver(() => {
      // A hidden panel measures zero, and fitting to zero throws.
      if (element.clientWidth === 0 || element.clientHeight === 0) return
      fit.fit()
    })
    observer.observe(element)

    const scheme = window.matchMedia('(prefers-color-scheme: light)')
    const repaint = (): void => {
      term.options.theme = readTheme()
    }
    scheme.addEventListener('change', repaint)

    return () => {
      cancelled = true
      scheme.removeEventListener('change', repaint)
      observer.disconnect()
      typed.dispose()
      resized.dispose()
      stop()
      // Detach, never dispose. Unmounting a view must not kill a running build.
      if (attachment !== null) {
        void window.chorus.detachTerminal({ ref, epoch: attachment.epoch })
      }
      term.dispose()
    }
  }, [scope, conversationId, onExit, onReady])

  return <div className="terminal-surface" ref={host} role="group" aria-label={props.label} />
}
