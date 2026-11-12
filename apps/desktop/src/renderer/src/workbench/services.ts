import {
  type IEditorOverrideServices,
  type IWorkbenchConstructionOptions,
  LogLevel,
} from '@codingame/monaco-vscode-api'
import type { EnvironmentOverride } from '@codingame/monaco-vscode-api/workbench'
import { registerServiceInitializePreParticipant } from '@codingame/monaco-vscode-api/lifecycle'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import { IContextKeyService } from '@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey.service'
/*
 * The export-map subpath, not the path inside the tarball. The published map is
 * `"./vscode/*" → "./vscode/src/*.js"`, so the pattern supplies both `src/` and
 * the extension; writing either here doubles it and Node raises
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` rather than anything that names the mistake.
 * Review round 3 of the preflight caught exactly this, in a test.
 */
import product from '@codingame/monaco-vscode-api/vscode/vs/platform/product/common/product'
import type { WorkbenchConnection } from '../../../shared/workbench-ipc.js'

/*
 * The service-override list, one import per service, and every line is here
 * because a Phase 1 proof needs it. The set is roughly preflight §8.2's tier
 * B/C — the library's own demo installs 180 packages and 286 MB of them, most of
 * which exists for serverless operation the product will not use once a remote
 * extension host is supplying the built-ins.
 *
 * `WorkbenchServiceOverride` and `ViewsServiceOverride` are mutually exclusive
 * ("never both at the same time", issue #817). This is the workbench one,
 * because the shape being tested is a whole IDE surface, not an editor.
 */

// The full workbench layout: activity bar, sidebar, editor area, panel, status bar.
import getWorkbenchServiceOverride from '@codingame/monaco-vscode-workbench-service-override'
// ⌘P / ⌘⇧P. The cheapest interaction that proves a surface is still alive after
// its sibling was destroyed, because it opens a widget the DOM can be asked about.
import getQuickAccessServiceOverride from '@codingame/monaco-vscode-quickaccess-service-override'
// The explorer tree, which is what makes "each surface lists its own root" visible.
import getExplorerServiceOverride from '@codingame/monaco-vscode-explorer-service-override'
/*
 * `initUserConfiguration` is deliberately **not** imported. It writes the user's
 * settings file wholesale, so calling it on startup discards whatever the person
 * had changed; Chorus's own preferences go in `configurationDefaults` instead.
 */
import getConfigurationServiceOverride from '@codingame/monaco-vscode-configuration-service-override'
import getKeybindingsServiceOverride from '@codingame/monaco-vscode-keybindings-service-override'
import getLogServiceOverride from '@codingame/monaco-vscode-log-service-override'
import getExtensionServiceOverride from '@codingame/monaco-vscode-extensions-service-override'
import getModelServiceOverride from '@codingame/monaco-vscode-model-service-override'
import getNotificationServiceOverride from '@codingame/monaco-vscode-notifications-service-override'
import getDialogsServiceOverride from '@codingame/monaco-vscode-dialogs-service-override'
import getTextmateServiceOverride from '@codingame/monaco-vscode-textmate-service-override'
import getThemeServiceOverride from '@codingame/monaco-vscode-theme-service-override'
import getLanguagesServiceOverride from '@codingame/monaco-vscode-languages-service-override'
import getStorageServiceOverride, {
  StorageScope,
} from '@codingame/monaco-vscode-storage-service-override'
import { SyncDescriptor } from '@codingame/monaco-vscode-api/vscode/vs/platform/instantiation/common/descriptors'
import { LanguageModelsService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/chat/common/languageModels'
import { ILanguageModelsService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/chat/common/languageModels.service'
import { IStorageService } from '@codingame/monaco-vscode-api/vscode/vs/platform/storage/common/storage.service'
import { ChorusStorageDatabase, ChorusStorageService } from './storage.js'
import { IClipboardService } from '@codingame/monaco-vscode-api/vscode/vs/platform/clipboard/common/clipboardService.service'
import { ChorusClipboardService } from './clipboard.js'
import { workspaceIdFor } from './remote-authority.js'
import { onDidChangeWindowFocus, windowHasFocus } from './window-focus.js'
import getHostServiceOverride from '@codingame/monaco-vscode-host-service-override'
import getLifecycleServiceOverride from '@codingame/monaco-vscode-lifecycle-service-override'
import getEnvironmentServiceOverride from '@codingame/monaco-vscode-environment-service-override'
import getWorkspaceTrustOverride from '@codingame/monaco-vscode-workspace-trust-service-override'
import getOutputServiceOverride from '@codingame/monaco-vscode-output-service-override'
import getMarkersServiceOverride from '@codingame/monaco-vscode-markers-service-override'
import getSearchServiceOverride from '@codingame/monaco-vscode-search-service-override'
import getPreferencesServiceOverride from '@codingame/monaco-vscode-preferences-service-override'
import getStatusBarServiceOverride from '@codingame/monaco-vscode-view-status-bar-service-override'
import getTitleBarServiceOverride from '@codingame/monaco-vscode-view-title-bar-service-override'
import getWorkingCopyServiceOverride from '@codingame/monaco-vscode-working-copy-service-override'
import getSecretStorageServiceOverride from '@codingame/monaco-vscode-secret-storage-service-override'
/*
 * Git — `BOARD.md` C-062, and it was unregistered rather than unbuilt.
 *
 * Without this the built-in Git extension loads from the REH, tries to register
 * its provider and is refused by the library with `Unsupported:
 * SCMService.registerSCMProvider is not supported`. So the product had no source
 * control at all, and the message said why in a channel nobody reads.
 *
 * Git is named in the plan's acceptance criterion and is a Phase 4 surface, so
 * this only opens the door: the source-control view has to be reached, and a
 * real repository has to appear in it, before C-062 is closed.
 */
import getScmServiceOverride from '@codingame/monaco-vscode-scm-service-override'
import getMultiDiffEditorServiceOverride from '@codingame/monaco-vscode-multi-diff-editor-service-override'
/*
 * Terminals in the workbench — Phase 4 slice 4d.
 *
 * **Called with no backend, deliberately.** `getServiceOverride(backend?)`
 * registers a local backend only when one is passed; omitted, the terminal
 * service resolves a backend by *remote authority* instead, which is the REH.
 * So a terminal opened here is a process on the server that already owns the
 * project's filesystem, rather than a second shell running somewhere else with
 * its own idea of where the project is.
 *
 * **This does not retire Chorus's own terminals.** The global terminal stays a
 * real PTY in main — `CLAUDE.md` states that as a rule, and it belongs to no
 * project, so a per-project workbench has nowhere to put it. What this replaces
 * is the per-session panel.
 */
import getTerminalServiceOverride from '@codingame/monaco-vscode-terminal-service-override'
/*
 * Debugging — Phase 4 slice 4f, and the workbench told us it was missing.
 *
 * A running surface logged `[ms-vscode.js-debug]: View container 'debug' does
 * not exist and all views registered to it will be added to 'Explorer'`. So the
 * JavaScript debugger was already there, shipped by the REH and activating
 * normally; what it had nowhere to go. Registering the debug service is what
 * creates the container its views are written against.
 *
 * No argument, because there is no adapter to supply: `js-debug` is the adapter
 * and it lives on the server, which is also where the processes it attaches to
 * run. The plan puts JS/TS first for that reason — it is the one debugger that
 * needs nothing installed.
 */
import getDebugServiceOverride from '@codingame/monaco-vscode-debug-service-override'
/*
 * Extensions you can actually install — Phase 5 slice 5a.
 *
 * `extensions-service-override` registers the **host** side only: the extension
 * service, the scanners, manifest properties. So the workbench ran exactly the
 * extensions the REH shipped with and offered no way to add one. This is the
 * management half — gallery, workbench extensions service, enablement,
 * recommendations, and `IExtensionManagementServerService`, which is what knows
 * to install a workspace extension on the **server** rather than in the browser.
 *
 * `webOnly` is left false: there is a server, and forcing web-only would refuse
 * exactly the Node workspace extensions §4 lists as the largest class — ESLint,
 * Docker, Tailwind and the rest.
 */
import getExtensionGalleryServiceOverride from '@codingame/monaco-vscode-extension-gallery-service-override'
import getAccessibilityServiceOverride from '@codingame/monaco-vscode-accessibility-service-override'
/*
 * The two the workbench was demonstrably missing, added 2026-09-02.
 *
 * **Both were found by reading the app's own logs rather than by survey.**
 * monaco-vscode-api answers an unregistered service by throwing
 * `Unsupported: <Service>.<method> is not supported. You are using a feature
 * without registering the corresponding service override.` — and across ten REH
 * sessions exactly two names appeared, 24 and 12 times respectively. Nothing
 * else in the list was missing, which is why this is two lines and not a sweep.
 *
 * `AuthenticationService.getProvider` is the one that matters: it is the service
 * `vscode.github`, GitLab's workflow extension and any sign-in flow route
 * through, and its absence surfaced as
 * `[GitHubBranchProtectionProvider] Failed to update repository branch protection`.
 *
 * `CommentService.setWorkspaceComments` / `.updateCommentingRanges` is what
 * merge-request and pull-request comment threads are drawn with.
 *
 * Pinned at 33.0.9 like the other overrides. The family shares a vendored VS
 * Code tree per package, and a version skew inside it is not a version conflict
 * the resolver can see — it is two copies of the same classes that fail to
 * recognise each other at runtime.
 */
import getAuthenticationServiceOverride from '@codingame/monaco-vscode-authentication-service-override'
import getCommentsServiceOverride from '@codingame/monaco-vscode-comments-service-override'
/*
 * The one that makes the files real.
 *
 * `scanRemoteExtensions` is on because a remote extension host that nobody scans
 * contributes nothing: the REH ships the built-ins — Git, the language basics,
 * the JS debugger — and without the scan the workbench connects to a server and
 * then behaves as though it had not.
 */
import getRemoteAgentServiceOverride from '@codingame/monaco-vscode-remote-agent-service-override'
// Side-effect imports. The theme extension contributes Dark/Light Modern, without
// which the workbench renders in unstyled defaults and "it looks broken" and "it
// is broken" become indistinguishable at the review gate.
import '@codingame/monaco-vscode-theme-defaults-default-extension'
/*
 * The language basics, and their absence is why every file opened as Plain Text.
 *
 * The comment above says the REH "ships the built-ins — Git, the language
 * basics, the JS debugger". Git and the debugger are there; **the language
 * basics are not**, and that sentence is why nobody looked. What the server
 * ships is `typescript-language-features` and `json-language-features` — the
 * language *servers*. The extensions that declare a language at all (`.tsx` is
 * `typescriptreact`) and carry its TextMate grammar are client-side in VS Code,
 * and here that means these packages.
 *
 * Without them the editor identifies nothing, so nothing tokenizes, the status
 * bar reads Plain Text for every file, and `getLanguageId()` answers
 * `plaintext` — which then rides out on the fence of every selection an agent is
 * sent, uncoloured in the transcript for the same reason it was uncoloured in
 * the editor.
 *
 * Side-effect imports, like the theme: each registers a contribution at load.
 * The list is the languages actually worked in here rather than everything VS
 * Code bundles, because each one is bundle weight against R2 and an unused
 * grammar is weight for nothing.
 */
import '@codingame/monaco-vscode-typescript-basics-default-extension'
import '@codingame/monaco-vscode-javascript-default-extension'
import '@codingame/monaco-vscode-json-default-extension'
import '@codingame/monaco-vscode-css-default-extension'
import '@codingame/monaco-vscode-html-default-extension'
import '@codingame/monaco-vscode-markdown-basics-default-extension'
import '@codingame/monaco-vscode-yaml-default-extension'
import '@codingame/monaco-vscode-shellscript-default-extension'
import '@codingame/monaco-vscode-python-default-extension'

/*
 * The rest of what VS Code bundles, so an unfamiliar file is still a file.
 *
 * The nine above were the languages worked in here, chosen to keep the bundle
 * honest. That is the wrong trade for an editor: the file you cannot read is
 * always the one you did not expect to open — a `Dockerfile` in someone else's
 * repository, a `.travis.yml`, a `soa.cd.cjs`. Measured before and after, the
 * whole set costs 0.7 MB on the workbench chunk, because the grammars are lazy
 * and only the language *declarations* load at startup. At that price there is
 * no argument for choosing.
 */
import '@codingame/monaco-vscode-bat-default-extension'
import '@codingame/monaco-vscode-clojure-default-extension'
import '@codingame/monaco-vscode-coffeescript-default-extension'
import '@codingame/monaco-vscode-cpp-default-extension'
import '@codingame/monaco-vscode-csharp-default-extension'
import '@codingame/monaco-vscode-dart-default-extension'
import '@codingame/monaco-vscode-diff-default-extension'
import '@codingame/monaco-vscode-docker-default-extension'
import '@codingame/monaco-vscode-fsharp-default-extension'
import '@codingame/monaco-vscode-go-default-extension'
import '@codingame/monaco-vscode-groovy-default-extension'
import '@codingame/monaco-vscode-handlebars-default-extension'
import '@codingame/monaco-vscode-hlsl-default-extension'
import '@codingame/monaco-vscode-ini-default-extension'
import '@codingame/monaco-vscode-java-default-extension'
import '@codingame/monaco-vscode-julia-default-extension'
import '@codingame/monaco-vscode-latex-default-extension'
import '@codingame/monaco-vscode-less-default-extension'
import '@codingame/monaco-vscode-log-default-extension'
import '@codingame/monaco-vscode-lua-default-extension'
import '@codingame/monaco-vscode-make-default-extension'
import '@codingame/monaco-vscode-objective-c-default-extension'
import '@codingame/monaco-vscode-perl-default-extension'
import '@codingame/monaco-vscode-php-default-extension'
import '@codingame/monaco-vscode-powershell-default-extension'
import '@codingame/monaco-vscode-pug-default-extension'
import '@codingame/monaco-vscode-r-default-extension'
import '@codingame/monaco-vscode-razor-default-extension'
import '@codingame/monaco-vscode-restructuredtext-default-extension'
import '@codingame/monaco-vscode-ruby-default-extension'
import '@codingame/monaco-vscode-rust-default-extension'
import '@codingame/monaco-vscode-scss-default-extension'
import '@codingame/monaco-vscode-shaderlab-default-extension'
import '@codingame/monaco-vscode-sql-default-extension'
import '@codingame/monaco-vscode-swift-default-extension'
import '@codingame/monaco-vscode-vb-default-extension'
import '@codingame/monaco-vscode-xml-default-extension'

/*
 * File icons, which is a different kind of not-knowing.
 *
 * Without it every row in the explorer is the same grey page, so a folder of
 * mixed sources reads as a list of names and nothing else. Seti is the theme VS
 * Code ships as its default, so this restores the expected appearance rather
 * than inventing one.
 */
import '@codingame/monaco-vscode-theme-seti-default-extension'
// Registers the local extension host. Nothing in this slice activates an
// extension, but the extension service resolves a host at startup either way.
import '@codingame/monaco-vscode-extension-api/localExtensionHost'

/**
 * There is no alias, and that is a finding rather than an omission.
 *
 * Preflight §4.3 flagged this as the expensive trap: monaco-vscode-api's own
 * documentation says `monaco-editor` must resolve to
 * `@codingame/monaco-vscode-editor-api`, this repository already depends on real
 * `monaco-editor@^0.56.0` for the accepted-and-measured `MonacoDiff` Editor view,
 * and a `resolve.alias` is global to a Vite build rather than per-entry — so the
 * naive alias would swap the Monaco under the existing diff editor for
 * CodinGame's fork, in the same build, with no error.
 *
 * Read out of the installed package rather than out of the documentation, and
 * **re-read at `33.0.9` rather than carried over from `36.1.1`** — a downgrade of
 * three minor releases is exactly the change that could have reintroduced it.
 * Across every installed `@codingame/*` package there is not one bare
 * `monaco-editor` or bare `vscode` import, in a runtime `.js` file **or in a
 * `.d.ts`**. So there is no alias here and no `paths` entry either: the question
 * does not arise at build time or at typecheck time, and the shell's real
 * `monaco-editor` under `MonacoDiff` is untouched by construction rather than by
 * scoping. The demo needs the alias because it declares `"monaco-editor":
 * "file:../dist/packages/monaco-vscode-editor-api"` in its own dependencies and
 * writes `import * as monaco from 'monaco-editor'` in its own source; this file
 * imports the `@codingame/*` names directly and never writes that line.
 */

/**
 * The client's own identity, and the check that replaces forging one.
 *
 * §1.5a's correction, applied: the compiled product module hardcodes `commit`
 * above the `globalThis._VSCODE_PRODUCT_JSON` spread, and an object spread cannot
 * remove a key — so an unconfigured client presents its **true build commit**,
 * which is exactly the value the manifest wants it to present. **Omission is the
 * safe default; setting `productConfiguration.commit` is the dangerous case**,
 * because that is what lets the client assert something other than what it is.
 *
 * So Chorus sets neither, and asserts instead. Main tells this document what the
 * server's `product.json` was patched to; if the client's own compiled identity
 * disagrees, the pair is not matched and connecting would either be refused at
 * the handshake (`Client refused: version mismatch`) or — for `quality` — succeed
 * and then 404-storm with nothing naming the cause. Failing here, in a document
 * element the gate and a person can both read, is strictly better than either.
 */
function assertClientMatchesServer(connection: WorkbenchConnection): void {
  /*
   * The deprecation is read and declined, which is why this is a disable with a
   * sentence rather than a switch to `IProductService`.
   *
   * The library's own note says to prefer the service. A service resolves the
   * *effective* product configuration — the compiled module merged with whatever
   * `productConfiguration` this workbench was constructed with — and the effective
   * value is precisely what must not be trusted here: the whole point of the check
   * is that the client's **compiled build identity** matches the server, and a
   * client that had been told to claim a commit would then agree with itself. The
   * service would make this assertion pass in exactly the case it exists to catch.
   */
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- see above: the compiled identity is the subject, not the effective one
  const identity = product as { commit?: string; quality?: string }
  if (identity.commit !== connection.commit || identity.quality !== connection.quality) {
    throw new Error(
      `This workbench client is ${String(identity.quality)}-${String(identity.commit)}, and the server was prepared for ${connection.quality}-${connection.commit}. Refusing to connect.`
    )
  }
}

export interface WorkbenchSetup {
  readonly services: IEditorOverrideServices
  readonly options: IWorkbenchConstructionOptions
  readonly env: EnvironmentOverride
}

/*
 * Synchronous, and it became so when the user-configuration write went away.
 * `initUserConfiguration` was the only asynchronous step in here; keeping the
 * `async` afterwards would advertise a wait that no longer exists.
 */
export function prepareWorkbench(connection: WorkbenchConnection): WorkbenchSetup {
  const root = connection.projectRoot.replace(/\/+$/, '')
  assertClientMatchesServer(connection)
  registerServiceInitializePreParticipant((accessor) => {
    accessor.get(IContextKeyService).createKey('chatSetupHidden', true).set(true)
    return Promise.resolve()
  })

  /*
   * The workspace folder, on the `vscode-remote` scheme — and this one URI is the
   * whole difference between the last slice and this one.
   *
   * Before, an in-memory `RegisteredFileSystemProvider` was seeded with two
   * synthesised files whose names were built from the project-root *string*, so
   * the explorer was evidence about isolation between surfaces and evidence about
   * nothing else: not one byte had been read from disk. On this scheme every file
   * operation is answered by the remote extension host, which is a process with a
   * real filesystem under it. If the tree that appears is the tree that is
   * actually on disk, that could only have come from the server.
   */
  const folderUri = URI.from({
    scheme: 'vscode-remote',
    authority: connection.remoteAuthority,
    path: root,
  })

  /*
   * Chorus's opinions live in the **defaults layer**, and this used to write the
   * user's own settings file instead — which meant overwriting it on every start.
   *
   * `initUserConfiguration(JSON.stringify({…}))` does not merge: it replaces the
   * user configuration with a fixed object, so any preference a person changed in
   * the workbench was discarded the next time a surface opened. That is invisible
   * until someone changes something and it does not stick, and it would have made
   * `files.autoSave` un-turn-off-able for a user while looking, from this file,
   * like a setting we had left alone.
   *
   * `configurationDefaults` is the honest place for a house style. It sets the
   * default layer, which the user's own settings then override in the normal way,
   * so nothing here can outrank a decision the person made — and there is no
   * `files.autoSave` line here or anywhere else, deliberately. The web workbench
   * defaults it to `afterDelay` at 1,000 ms; Chorus keeps that native behaviour
   * rather than second-guessing it, and a person who wants `off` sets it in
   * Settings and keeps it.
   *
   * **And it now survives a quit** — E5, closed by `user-settings.ts` rather than
   * by anything here. The partition is still in-memory (no `persist:`), so the
   * browser forgets everything; what persists is the user's own `settings.json`,
   * held by main under the Chorus profile and seeded back before `initialize`.
   * Nothing in this file writes that layer, which is exactly why seeding cannot
   * destroy a preference the way `initUserConfiguration` did.
   */
  /*
   * One set of factories, named once and handed to both registrations.
   *
   * The helper and the override below must agree about where each scope is
   * stored; two literals would be two things free to drift, and the drift would
   * show up as a scope silently served by IndexedDB again.
   */
  const STORAGE_DATABASES = {
    [StorageScope.APPLICATION]: () => new ChorusStorageDatabase('application'),
    [StorageScope.PROFILE]: (_accessor: unknown, profile: { id: string }) =>
      new ChorusStorageDatabase(`profile:${profile.id}`),
    [StorageScope.WORKSPACE]: (_accessor: unknown, workspace: { id: string }) =>
      new ChorusStorageDatabase(`workspace:${workspace.id}`),
  }

  const services: IEditorOverrideServices = {
    ...getLogServiceOverride(),
    /*
     * **Left unset deliberately, and it costs us browser-only extensions.**
     * `{ enableWorkerExtensionHost: true }` was tried on 2026-09-02 and reverted
     * the same day; both halves of that are worth keeping.
     *
     * *Why it is tempting.* An extension with `browser` and no `main` deduces to
     * kind `["web"]`, and `pickRunningLocation` answers `LocalWebWorker`. With
     * this flag unset, `LocalWebWorker` leaves the picker's allowed list — and
     * the picker does not refuse the extension, it **remaps** it to
     * `allowedExtHostKinds[0]`, which is `LocalProcess`. `abstractExtensionService`
     * then builds the startup set from local-as-LocalProcess, local-as-LocalWebWorker,
     * remote-as-Remote, plus remote-as-LocalWebWorker. An extension installed on
     * the REH and remapped to `LocalProcess` matches none of them: it never
     * reaches `allExtensions`, never enters the registry, and its contributions
     * are never read. That is why `pomdtr.excalidraw-editor` contributes no
     * custom editor and `.excalidraw` files open as JSON.
     *
     * *Why it is off anyway.* Turning it on does fix the registry drop — the
     * custom editor appeared — but the web-worker host never became ready, and
     * `_activateByEvent` awaits **every** host with no readiness filter on the
     * normal path. So one host that never starts wedges activation for all
     * extensions in all hosts: git and GitLab commands showed "Activating
     * extension…" and hung forever. Widening `isWebviewDocument` to cover the
     * host's iframe (see `main/security.ts`) did not release it, and the actual
     * cause was never observed — only guessed at twice.
     *
     * **Do not re-enable this without capturing the renderer console first.** The
     * failure is invisible from main and from the REH logs; both attempts above
     * were reasoning from source, and both were wrong.
     */
    ...getExtensionServiceOverride({ enableWorkerExtensionHost: true }),
    ...getModelServiceOverride(),
    ...getNotificationServiceOverride(),
    ...getDialogsServiceOverride(),
    ...getConfigurationServiceOverride(),
    ...getKeybindingsServiceOverride(),
    ...getTextmateServiceOverride(),
    ...getThemeServiceOverride(),
    ...getLanguagesServiceOverride(),
    ...getPreferencesServiceOverride(),
    ...getStatusBarServiceOverride(),
    ...getTitleBarServiceOverride(),
    ...getOutputServiceOverride(),
    ...getSearchServiceOverride(),
    ...getMarkersServiceOverride(),
    ...getAccessibilityServiceOverride(),
    ...getAuthenticationServiceOverride(),
    ...getCommentsServiceOverride(),
    [ILanguageModelsService.toString()]: new SyncDescriptor(LanguageModelsService, [], true),
    /*
     * Backed by Chorus, not by the browser — see `workbench/storage.ts`.
     *
     * Without these factories the service falls back to IndexedDB, which on this
     * surface's in-memory partition is gone at quit: every launch re-asked the
     * folder's workspace-trust question and re-showed every extension's one-time
     * greeting.
     *
     * All three scopes, because the two symptoms live in different ones — trust
     * is per workspace, an extension's "don't show again" is usually profile or
     * application — and a partial fix here is indistinguishable from none for
     * whichever one was left out.
     *
     * The keys are namespaced by scope so a workspace whose id collides with a
     * profile's cannot share a slot in the file.
     */
    /*
     * **The helper first, then `IStorageService` replaced — and the order is the
     * fix rather than a style.**
     *
     * A previous version bypassed `getStorageServiceOverride()` entirely, on a
     * comment claiming it "does exactly one thing — register
     * `InjectedBrowserStorageService` for `IStorageService`". That was wrong. It
     * registers **two** services, and the second one is
     * `IExtensionStorageService`. Dropping the helper therefore left that service
     * to the fallback in `missing-services.js`, whose `getExtensionState` is
     * `() => undefined`.
     *
     * The consequence was invisible in the file and obvious in the product:
     * every extension's global state was written to `storage.json` correctly and
     * read back as nothing. `storage.json` held
     * `{"hasShownWelcome":true}` for the DOCX reader while it showed its welcome
     * on every launch, and a full `glAccounts` record for GitLab while the
     * extension reported no account. Remote extensions do not read these mementos
     * from the REH's own user-data dir — `MainThreadStorage.$initializeExtensionStorage`
     * reads the *client's* `IExtensionStorageService` and sends it over RPC — so
     * the stub answered for all of them.
     *
     * Spreading the helper and then overriding one key is deterministic: plain
     * object-spread order, resolved before initialisation, with no registration
     * race. `ChorusStorageService` is the helper's own class plus the
     * `APPLICATION_SHARED` scope, which `DatabaseFactories` has no slot for.
     */
    ...getStorageServiceOverride({ databaseFactories: STORAGE_DATABASES }),
    [IStorageService.toString()]: new SyncDescriptor(
      ChorusStorageService,
      [undefined, STORAGE_DATABASES],
      true
    ),
    ...getSecretStorageServiceOverride(),
    ...getLifecycleServiceOverride(),
    /*
     * **Overriding the library's own registration rather than adding one.**
     *
     * `@codingame/monaco-vscode-api` depends on this override and spreads it in
     * itself, with no parameters, so `IHostService` is already registered by the
     * time this map is read. `initialize` merges `{...defaults, ...overrides}` —
     * the caller's map last — so this entry is what replaces it, and the one that
     * has to be right is this one.
     *
     * Nothing here competes for the key, so the placement is not load-bearing the
     * way `IClipboardService`'s at the bottom of this map is. It sits with the
     * other ambient services because that is what it is.
     *
     * `hasFocus` is a getter over module state rather than a closure over
     * anything in this function: `seedWindowFocus` has already run by the time
     * this is called, and main keeps it current afterwards. `onDidChangeFocus` is
     * `Event<void>` and carries nothing — the host service recomputes the value
     * from `hasFocus`, and a payload would be a second source for one fact.
     */
    ...getHostServiceOverride({
      hasFocus: windowHasFocus,
      onDidChangeFocus: onDidChangeWindowFocus,
    }),
    ...getEnvironmentServiceOverride(),
    ...getWorkspaceTrustOverride(),
    ...getWorkingCopyServiceOverride(),
    ...getExplorerServiceOverride(),
    ...getScmServiceOverride(),
    ...getMultiDiffEditorServiceOverride(),
    ...getTerminalServiceOverride(),
    ...getDebugServiceOverride(),
    ...getExtensionGalleryServiceOverride(),
    ...getRemoteAgentServiceOverride({ scanRemoteExtensions: true }),
    ...getWorkbenchServiceOverride(),
    ...getQuickAccessServiceOverride(),
    /*
     * **Last, and that placement is the whole registration.**
     *
     * `IClipboardService` is an eager `registerSingleton` in the library's
     * `standaloneServices`, not something an override package contributes — so
     * nothing above competes for the key and this map simply wins. It still goes
     * at the end, because the rule that bit twice already in this file is that a
     * later spread replaces an earlier entry: `IRemoteAuthorityResolverService`
     * registered before `getRemoteAgentServiceOverride()` never ran, and neither
     * did the first `IStorageService`.
     */
    [IClipboardService.toString()]: new SyncDescriptor(ChorusClipboardService, [], true),
  }

  const options: IWorkbenchConstructionOptions = {
    /*
     * Authority and token, and nothing else about the server.
     *
     * `remoteAuthority` is host and port only — no scheme and no path — because
     * the client builds `vscode-remote://<authority>/...` itself and would
     * otherwise build it out of a string that already contained one. The token
     * arrived over `connection()` and is read from nowhere else: never a query
     * string, which lands in session history and in every devtools recording
     * permanently, and never the shell.
     */
    remoteAuthority: connection.remoteAuthority,
    connectionToken: connection.connectionToken,
    /*
     * On unless main said otherwise, and the default is the safe one because the
     * field is absent in every descriptor but the gate's.
     *
     * This flag and not a configuration entry, because it is the one the client
     * actually reads: `BrowserWorkbenchEnvironmentService.disableWorkspaceTrust`
     * is defined as `!options.enableWorkspaceTrust`, and `isWorkspaceTrustEnabled()`
     * returns false the moment that is true without consulting
     * `security.workspace.trust.enabled` at all. A settings entry would be one of
     * two conditions and could be overridden by the workspace's own settings file
     * — i.e. by the very tree whose authors are in question.
     */
    /*
     * **Off, as a stated product policy rather than a workaround.**
     *
     * This was `connection.workspaceTrust !== 'waived'` — on unless main said
     * otherwise, with the waiver reachable only under the E2E profile. Keeping
     * the trust service on turned out to be undeliverable here rather than
     * merely awkward, and the reason is structural: trust is keyed by folder URI
     * and matched on authority, and this app's authority carries the REH's
     * ephemeral port. A decision saved under one launch can never match the next.
     *
     * Two attempts to bridge that failed, and both are recorded rather than
     * hidden. Canonicalising the authority (`remote-authority.ts`) made trust
     * persist and **emptied the file explorer**, because canonical URIs are
     * resolved elsewhere. Seeding `content.trust.model.key` through
     * `fallbackOverride` could never fire, because a stored value always beats a
     * fallback and the profile already held sixteen stale-port records — one per
     * time the person had been asked.
     *
     * So the choice was a prompt on every launch forever, or saying plainly that
     * this product does not use Workspace Trust. A security prompt shown on a
     * loop is one people are trained to dismiss without reading, which protects
     * nobody and costs something real.
     *
     * **What this gives up, precisely.** VS Code's Restricted Mode no longer
     * guards any folder Chorus opens. What makes that defensible here and not in
     * a general editor: Chorus only ever opens a folder somebody deliberately
     * added as a Project through a directory chooser, and it does not follow
     * links into arbitrary checkouts. Chorus's **own** permission engine is
     * untouched and still governs what agents may do — a different question about
     * a different executor.
     *
     * Deliberately not routed through the `waived` descriptor field. That exists
     * so a *gate* can waive trust while a shipping build cannot; using it here
     * would disguise a product decision as a test affordance.
     */
    enableWorkspaceTrust: false,
    developmentOptions: { logLevel: LogLevel.Info },
    /*
     * Where a credential goes, and why one is needed at all.
     *
     * `BrowserSecretStorageService` is constructed `super(true, …)` —
     * `_useInMemoryStorage` hardcoded — so `BaseSecretStorageService` always
     * takes its `new InMemoryStorageService()` branch and secrets never reach
     * `IStorageService`. Making storage durable did not and could not help: a
     * GitLab token was gone on every quit, and signing in was a thing you did
     * once per launch. This is the escape hatch the same constructor checks for,
     * and `get`/`set`/`delete` prefer it whenever it is present.
     *
     * `type: 'persisted'` is a claim to the workbench that these outlive the
     * session, which is only true because main encrypts them through the OS
     * keychain — see `workbench-secrets.ts`. Claiming it while storing plaintext
     * would be the same sentence with a much worse meaning.
     */
    secretStorageProvider: {
      type: 'persisted' as const,
      /*
       * `null` becomes `undefined` here and nowhere else. The provider's
       * contract wants `undefined` for "no secret", while `null` is what
       * survives an IPC round trip — JSON has no `undefined`, so a preload that
       * tried to return one would hand back `null` regardless. Converting at
       * this boundary keeps the wire honest and the service happy.
       */
      get: async (key: string) => (await window.chorusWorkbench.readSecret(key)) ?? undefined,
      set: (key: string, value: string) => window.chorusWorkbench.writeSecret(key, value),
      delete: (key: string) => window.chorusWorkbench.deleteSecret(key),
    },
    workspaceProvider: {
      /*
       * **Inert, and kept only because removing it is a separate decision.**
       * Nothing in the shipped workbench reads `trusted`: it is an
       * embedder-to-embedder field that upstream VS Code Web round-trips through
       * `open`'s payload. Trust is decided by `IWorkspaceTrustManagementService`
       * from the stored URI list, which is why this line sat here looking
       * load-bearing while every window opened in Restricted Mode.
       */
      trusted: true,
      /*
       * **An explicit id, so a project's workspace storage survives a relaunch.**
       *
       * Without one, `getSingleFolderWorkspaceIdentifier` falls back to
       * `hash(folderUri.toString())` — and that URI carries the REH's ephemeral
       * port, so every launch minted a brand-new workspace identity. Measured:
       * all 35 `workspace:*` scopes in the storage file resolved to seven
       * launches of five projects, each launch abandoning the previous set.
       * Everything scoped to a workspace was affected — view state, "don't show
       * again", the trust startup prompt.
       *
       * The canonical root is the stable fact about a project: it is what the
       * registry keys on, it survives a relaunch, and unlike the project id it
       * is the same thing the folder URI already names.
       */
      workspace: { folderUri, id: workspaceIdFor(root) },
      // A surface may not open windows. `lockDownNavigation` on this view's own
      // `webContents` denies it anyway; refusing here means the workbench never
      // renders an affordance that cannot work.
      open: () => Promise.resolve(false),
    },
    configurationDefaults: {
      /*
       * One agent product, not two competing sidebars — Phase 4 slice 4g.
       *
       * The pinned client ships `contrib/chat`, `contrib/inlineChat` and
       * `contrib/inlineCompletions`, so the workbench has a whole conversational
       * AI surface of its own. Chorus **is** the agent product; a second chat
       * panel inside the editor would be a different assistant, with different
       * permissions, no share of the transcript and no idea the other exists.
       *
       * `chat.disableAIFeatures` is the master switch rather than a list of
       * views to hide: `ChatEntitlementContext` watches it and updates the
       * context keys the chat UI's `when` clauses are written against, so the
       * entrypoints never register instead of registering and being hidden.
       * Read out of `chat/common/constants.js` and its consumer, not guessed.
       *
       * A **default**, not a forced value. It sits in the defaults layer like
       * everything else here, so a person who deliberately wants VS Code's chat
       * can still turn it on in Settings and keep it — the same rule
       * `files.autoSave` follows.
       */
      'chat.disableAIFeatures': true,
      /*
       * Extensions do not update themselves — Phase 5 slice 5e.
       *
       * VS Code defaults `extensions.autoUpdate` to every extension, which is
       * right for one window on one machine and wrong here for three reasons
       * that compound:
       *
       *  - **The extensions directory is shared** (`BOARD.md` C-063). One REH
       *    serves every project, so an update fired while you are in one project
       *    silently changes every other one — including projects that are open,
       *    mid-session, with agents running against them.
       *  - **It defeats pinning.** Slice 5f pins the built-in language, Git and
       *    debug extensions to the server's own version; an auto-update walks
       *    one of them past the REH and produces exactly the client/server drift
       *    the pin exists to prevent.
       *  - **It invalidates the ledger.** `extension-ledger.md` records a result
       *    against a version — `bradlc.vscode-tailwindcss` at 0.16.0. An
       *    overnight update makes every proved row a statement about something
       *    that is no longer installed, with nothing to say it happened.
       *
       * Slice 5g wants updates to be **atomic** — client packages, REH,
       * built-ins and compatibility metadata moving together or not at all — and
       * per-extension background updates are the opposite of that.
       *
       * A default, not a forced value: `Extensions: Enable Auto Update` is still
       * there for anyone who wants it, and `Check for Extension Updates` still
       * works on demand.
       */
      'extensions.autoUpdate': false,
      /*
       * The server's own extensions may not be replaced from a registry —
       * Phase 5 slice 5f.
       *
       * The REH ships 33 built-ins and **three of them carry marketplace ids
       * that Open VSX also serves**: `ms-vscode.js-debug`, its companion, and
       * the JS profile table. The other thirty are `vscode.*` — Git, the
       * language basics — and that namespace is not on Open VSX, so nothing can
       * shadow them. These three can be, and one of them is the debugger.
       *
       * Installing `ms-vscode.js-debug` from Open VSX would put a registry copy
       * beside the server's, at a version chosen by neither: the built-in is
       * versioned with the REH (`1.121.03429`) and Open VSX carries `1.117.0`.
       * A debugger from one build talking to an extension host from another is
       * the client/server drift §2.3 refuses everywhere else, arriving through
       * the one door left open.
       *
       * `"*": true` keeps everything else installable — this is a pin on three
       * ids, not an allowlist regime. Checked against the evaluator rather than
       * assumed: `allowedExtensionsService.js:82` treats a boolean value as
       * allow/deny directly, and the key is lowercased before lookup.
       */
      'extensions.allowed': {
        '*': true,
        'ms-vscode.js-debug': false,
        'ms-vscode.js-debug-companion': false,
        'ms-vscode.vscode-js-profile-table': false,
      },
      'extensions.autoCheckUpdates': true,
      'typescript.tsserver.watchOptions': {},
      'js/ts.tsserver.watchOptions': {},
      'window.title': '${rootName}',
      'workbench.colorTheme': 'Default Dark Modern',
      /*
       * Selected, not merely registered — and the distinction is the bug.
       *
       * Importing `theme-seti` contributes the theme; nothing chooses it. VS
       * Code's own default settings pick `vs-seti`, and without that line here
       * the explorer draws no icons at all: every row is a name and a chevron,
       * which is what "the icons are missing" turned out to mean.
       *
       * A person can change it — this is a *default*, seeded into the settings
       * file they own — and installing another icon theme from the marketplace
       * overrides it in the ordinary way.
       */
      'workbench.iconTheme': 'vs-seti',
      'editor.minimap.enabled': false,
      'workbench.startupEditor': 'none',
      'telemetry.telemetryLevel': 'off',
    },
    defaultLayout: {
      /*
       * No editor is opened for you, and that is deliberate now rather than an
       * omission. The last slice could name a file because it had invented one;
       * this one must not guess at a path inside somebody's real repository, and
       * a `defaultLayout` naming a file that does not exist is a startup error
       * rather than an empty pane. What opens a file here is a person, or the
       * gate driving quick open — which is itself the sharper proof, because a
       * quick-open list is the project's real filenames.
       */
      force: true,
    },
    productConfiguration: {
      nameShort: 'Chorus',
      nameLong: 'Chorus Workbench',
      extensionEnabledApiProposals: {
        'chorus.language-models': ['contribSourceControlInputBoxMenu'],
      },
      /*
       * What `vscode.env.uriScheme` becomes, and therefore the scheme an
       * extension builds its OAuth callback out of.
       *
       * Without it the GitLab extension sent a person to a browser, authenticated
       * fine, and had the return trip land on a scheme nothing had declared — the
       * flow simply never came back and the extension waited forever. Declaring
       * it here is only one of three halves: `electron-builder.yml` registers the
       * scheme with the OS and `index.ts` handles `open-url`. All three or none.
       */
      urlProtocol: 'chorus',
      /*
       * Open VSX, and it is a licence decision before it is a product one.
       *
       * The Microsoft Marketplace's terms permit its use only from Microsoft's
       * own products, which Chorus is not — the same reason §3.1 refuses to ship
       * Microsoft's REH. Open VSX is the registry VSCodium uses.
       *
       * **Copied from the server's own `product.json`, not composed here.** The
       * unpacked REH already carries a gallery configuration, because VSCodium
       * ships one, and client and server must agree about where an extension came
       * from — a workspace extension is downloaded and installed by the *server*,
       * so a client pointing somewhere else would list one registry and install
       * from another.
       *
       * Browser extensions are installed from individual gallery resources, not
       * from the VSIX path the remote extension-management server uses. Leaving
       * `resourceUrlTemplate` empty therefore makes "Install in Browser" fail
       * with "No extension gallery service configured" even though search and
       * remote installation work. This is Open VSX's documented unpkg route.
       */
      extensionsGallery: {
        serviceUrl: 'https://open-vsx.org/vscode/gallery',
        controlUrl:
          'https://raw.githubusercontent.com/EclipseFdn/publish-extensions/refs/heads/master/extension-control/extensions.json',
        extensionUrlTemplate: 'https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest',
        resourceUrlTemplate:
          'https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}',
        nlsBaseUrl: '',
      },
      /*
       * `commit` and `quality` are deliberately absent — see
       * `assertClientMatchesServer`. Setting them is the only way this client can
       * claim to be something it is not, and the compiled module already carries
       * the true values.
       */
    },
  }

  // Otherwise VS Code infers the home directory from the first workspace folder,
  // which makes the search view describe a tree that is not the one on screen.
  const env: EnvironmentOverride = { userHome: URI.file('/') }

  return { services, options, env }
}
