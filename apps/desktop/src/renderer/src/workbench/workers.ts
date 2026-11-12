/// <reference types="vite/client" />
import EditorWorker from '@codingame/monaco-vscode-api/vscode/vs/editor/common/services/editorWebWorkerMain?worker'
import extensionHostWorkerUrl from '@codingame/monaco-vscode-api/workers/extensionHost.worker?worker&url'
import OutputLinkWorker from '@codingame/monaco-vscode-output-service-override/worker?worker'
import SearchWorker from '@codingame/monaco-vscode-search-service-override/worker?worker'
import TextMateWorker from '@codingame/monaco-vscode-textmate-service-override/worker?worker'

/**
 * The workbench's web workers — `BOARD.md` C-061.
 *
 * Nothing registered these, so every service that asked for a worker threw
 * `You must define a function MonacoEnvironment.getWorkerUrl or
 * MonacoEnvironment.getWorker for the worker label: …`. What a person noticed
 * was that Output-panel links were dead, which is trivial; the gap was global,
 * because **any** worker-backed service met the same wall — diff computation,
 * word-based suggestions, background tokenization and file search among them.
 *
 * **Read out of the installed packages, not out of documentation.** Each
 * override that needs a worker ships its own `./worker` entry, and the labels
 * below are the string literals those packages construct their descriptors with.
 * Guessing either half is the "inferred payload" failure `CLAUDE.md` records
 * against the adapters, one layer out.
 */

/**
 * `getWorker` rather than `getWorkerUrl`, and the choice is Vite's.
 *
 * `StandaloneWebWorkerService._createWorker` tries `getWorker` first and only
 * falls back to a URL. `?worker` hands back a constructor with the bundling
 * already arranged, whereas a URL would mean resolving a bare package specifier
 * at runtime — which `new URL(…, import.meta.url)` cannot do.
 */
const WORKERS: Readonly<Record<string, new () => Worker>> = {
  // `editorWorkerService` is the one that matters most and the only one with no
  // `./worker` entry of its own: it comes from the client's own VS Code source,
  // through the `./vscode/*` export map. The subpath omits both `src/` and the
  // extension, because the pattern supplies them — writing either doubles it and
  // Node raises ERR_PACKAGE_PATH_NOT_EXPORTED, which is the trap `services.ts`
  // already carries a comment about.
  editorWorkerService: EditorWorker,
  OutputLinkDetectionWorker: OutputLinkWorker,
  LocalFileSearchWorker: SearchWorker,
  TextMateWorker: TextMateWorker,
}

/**
 * Installed on `globalThis` before the workbench initialises.
 *
 * An unknown label returns `undefined` rather than throwing, which hands the
 * caller back to its own fallback and its own error — a label this file has not
 * been taught about should fail the way it did before this file existed, not in
 * a way that names this file.
 */
export function registerWorkbenchWorkers(): void {
  const environment = globalThis as unknown as {
    MonacoEnvironment?: {
      getWorker?: (moduleId: string, label: string) => Worker | undefined
      getWorkerUrl?: (moduleId: string, label: string) => string | undefined
      getWorkerOptions?: (moduleId: string, label: string) => WorkerOptions | undefined
    }
  }
  environment.MonacoEnvironment = {
    ...environment.MonacoEnvironment,
    getWorkerUrl: (_moduleId, label) =>
      label === 'extensionHostWorkerMain' ? extensionHostWorkerUrl : undefined,
    getWorkerOptions: (_moduleId, label) =>
      label === 'extensionHostWorkerMain' ? { type: 'module' } : undefined,
    getWorker: (_moduleId, label) => {
      const Ctor = WORKERS[label]
      return Ctor === undefined ? undefined : new Ctor()
    },
  }
}
