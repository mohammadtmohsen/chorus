import {
  BROWSER_CONTRACT,
  BROWSER_FRAME_CHANNEL,
  BrowserFrame,
  BROWSER_PUSH_CHANNEL,
  BrowserPush,
  type BrowserChannel,
  type BrowserResponse,
} from './browser-ipc.js'
import {
  CONSOLE_CONTRACT,
  CONSOLE_PUSH_CHANNEL,
  ConsolePush,
  type ConsoleChannel,
  type ConsoleResponse,
} from './console-ipc.js'
import {
  CONVERSATIONS_PUSH_CHANNEL,
  DETACHED_WINDOW_CONTRACT,
  FLUSH_REQUEST_PUSH_CHANNEL,
  FlushRequestPush,
  HIT_TEST_REQUEST_PUSH_CHANNEL,
  HitTestRequestPush,
  PROJECT_CLOSE_REQUEST_PUSH_CHANNEL,
  PROJECT_CLOSED_PUSH_CHANNEL,
  PROJECT_RETURNED_PUSH_CHANNEL,
  PROJECT_SLICE_PUSH_CHANNEL,
  PROJECT_VISIBILITY_PUSH_CHANNEL,
  ProjectClosedPush,
  ProjectReturnedPush,
  ProjectSlicePush,
  ProjectVisibilityPush,
  type DetachedWindowChannel,
  type DetachedWindowResponse,
} from './detached-window-ipc.js'
import {
  ACTIVITY_PUSH_CHANNEL,
  ActivityPush,
  ATTENTION_PUSH_CHANNEL,
  AttentionPush,
  CONTEXT_PUSH_CHANNEL,
  ContextUsagePush,
  CONVERSATION_NOTE_PUSH_CHANNEL,
  CONVERSATION_NOTE_JOURNAL_PUSH_CHANNEL,
  ConversationNoteJournalPush,
  ConversationNoteJournalRequest,
  ConversationNoteJournalResponse,
  ConversationNotePush,
  DIAGNOSTIC_PUSH_CHANNEL,
  DiagnosticPush,
  EVENTS_PUSH_CHANNEL,
  EventsPush,
  IDE_PUSH_CHANNEL,
  IdeContextPush,
  IPC_CONTRACT,
  LIMITS_PUSH_CHANNEL,
  LimitsPush,
  REVEAL_PUSH_CHANNEL,
  RevealPush,
  SCALE_PUSH_CHANNEL,
  SETTINGS_PUSH_CHANNEL,
  TASKS_PUSH_CHANNEL,
  TasksPush,
  TERMINAL_PUSH_CHANNEL,
  TerminalPush,
  type ChorusApi,
  type IpcChannel,
  type IpcResponse,
} from './ipc.js'
import {
  RUN_CONTRACT,
  RUN_PUSH_CHANNEL,
  RunPush,
  type RunChannel,
  type RunResponse,
} from './run-ipc.js'
import {
  GIT_CONTRACT,
  GIT_REVIEW_PUSH_CHANNEL,
  GitReviewEnvelope,
  type GitChannel,
  type GitResponse,
} from './git-ipc.js'
import {
  TRAFFIC_CONTRACT,
  TRAFFIC_LIVE_PUSH_CHANNEL,
  TRAFFIC_PUSH_CHANNEL,
  TrafficLive,
  TrafficPush,
  type TrafficChannel,
  type TrafficResponse,
} from './traffic-ipc.js'
import {
  WORKBENCH_ACTIVITY_BAR_PUSH_CHANNEL,
  WORKBENCH_ROW_REVEAL_PUSH_CHANNEL,
  WORKBENCH_ROW_SCROLL_PUSH_CHANNEL,
  WORKBENCH_SHELL_CONTRACT,
  WorkbenchActivityBarPush,
  WorkbenchRowRevealPush,
  WorkbenchRowScrollPush,
  type WorkbenchShellChannel,
  type WorkbenchShellResponse,
} from './workbench-ipc.js'

/**
 * One method per IPC message, generated from the contract. `ipcRenderer` itself
 * is never exposed — handing the renderer a generic `invoke(channel, ...)` would
 * make the allowlist meaningless (plan §4.4).
 */
export interface ShellTransport {
  invoke: (channel: string, request: unknown) => Promise<unknown>
  on(channel: string, listener: (payload: unknown) => void): () => void
  pathForFile(file: File): string
  noteJournal: (request: ConversationNoteJournalRequest) => unknown
  prepareConversationNoteJournal?: (request: { readonly conversationId: string }) => Promise<void>
}

export function createChorusApi(transport: ShellTransport): ChorusApi {
  function invoke<C extends IpcChannel>(channel: C) {
    return async (request?: unknown): Promise<IpcResponse<C>> => {
      const raw: unknown = await transport.invoke(channel, request)
      // Validate on this side too: a mismatch here is our bug, and it should
      // surface at the boundary rather than as a render-time crash.
      const parsed = IPC_CONTRACT[channel].response.safeParse(raw)
      if (!parsed.success) {
        throw new Error(`Malformed response on "${channel}": ${parsed.error.message}`)
      }
      return parsed.data as IpcResponse<C>
    }
  }

  function noteJournal(request: unknown): ConversationNoteJournalResponse {
    const outgoing = ConversationNoteJournalRequest.safeParse(request)
    if (!outgoing.success) return { ok: false, error: 'Invalid note journal request' }
    try {
      const raw: unknown = transport.noteJournal(outgoing.data)
      const parsed = ConversationNoteJournalResponse.safeParse(raw)
      return parsed.success ? parsed.data : { ok: false, error: 'Malformed note journal response' }
    } catch {
      return { ok: false, error: 'The note journal could not be reached' }
    }
  }

  /**
   * The same generator over the traffic contract, for the same reason.
   *
   * Traffic is answered by a registrar that resolves the calling document and the
   * project it may see from `event.sender` — this map's registrar deliberately does
   * not, so these channels are not in it. The schemas are shared and the validation
   * is identical; only the map differs.
   */
  function invokeTraffic<C extends TrafficChannel>(channel: C) {
    return async (request: unknown): Promise<TrafficResponse<C>> => {
      const raw: unknown = await transport.invoke(channel, request)
      const parsed = TRAFFIC_CONTRACT[channel].response.safeParse(raw)
      if (!parsed.success) {
        throw new Error(`Malformed response on "${channel}": ${parsed.error.message}`)
      }
      return parsed.data as TrafficResponse<C>
    }
  }

  function invokeBrowser<C extends BrowserChannel>(channel: C) {
    return async (request: unknown): Promise<BrowserResponse<C>> => {
      const raw: unknown = await transport.invoke(channel, request)
      const parsed = BROWSER_CONTRACT[channel].response.safeParse(raw)
      if (!parsed.success) {
        throw new Error(`Malformed response on "${channel}": ${parsed.error.message}`)
      }
      return parsed.data as BrowserResponse<C>
    }
  }

  function invokeConsole<C extends ConsoleChannel>(channel: C) {
    return async (request: unknown): Promise<ConsoleResponse<C>> => {
      const raw: unknown = await transport.invoke(channel, request)
      const parsed = CONSOLE_CONTRACT[channel].response.safeParse(raw)
      if (!parsed.success) {
        throw new Error(`Malformed response on "${channel}": ${parsed.error.message}`)
      }
      return parsed.data as ConsoleResponse<C>
    }
  }

  function invokeRun<C extends RunChannel>(channel: C) {
    return async (request: unknown): Promise<RunResponse<C>> => {
      const raw: unknown = await transport.invoke(channel, request)
      const parsed = RUN_CONTRACT[channel].response.safeParse(raw)
      if (!parsed.success) {
        throw new Error(`Malformed response on "${channel}": ${parsed.error.message}`)
      }
      return parsed.data as RunResponse<C>
    }
  }

  function invokeGit<C extends GitChannel>(channel: C) {
    return async (request: unknown): Promise<GitResponse<C>> => {
      const raw: unknown = await transport.invoke(channel, request)
      const parsed = GIT_CONTRACT[channel].response.safeParse(raw)
      if (!parsed.success) {
        throw new Error(`Malformed response on "${channel}": ${parsed.error.message}`)
      }
      return parsed.data as GitResponse<C>
    }
  }

  /**
   * The same generator over the workbench's shell-facing contract.
   *
   * A separate map rather than three more entries in `IPC_CONTRACT`, because the
   * channels are answered by a registrar that reads `event.sender` and that map's
   * registrar deliberately does not. What matters here is that these three carry no
   * secret: an opaque view id and a rectangle. The channel that does carry one is
   * `workbench:connection`, and it is generated into `preload/workbench.ts` only —
   * this file has no method for it and no way to reach it.
   */
  function invokeWorkbench<C extends WorkbenchShellChannel>(channel: C) {
    return async (request: unknown): Promise<WorkbenchShellResponse<C>> => {
      const raw: unknown = await transport.invoke(channel, request)
      const parsed = WORKBENCH_SHELL_CONTRACT[channel].response.safeParse(raw)
      if (!parsed.success) {
        throw new Error(`Malformed response on "${channel}": ${parsed.error.message}`)
      }
      return parsed.data as WorkbenchShellResponse<C>
    }
  }

  function invokeDetached<C extends DetachedWindowChannel>(channel: C) {
    return async (request: unknown): Promise<DetachedWindowResponse<C>> => {
      const raw: unknown = await transport.invoke(channel, request)
      const parsed = DETACHED_WINDOW_CONTRACT[channel].response.safeParse(raw)
      if (!parsed.success) {
        throw new Error(`Malformed response on "${channel}": ${parsed.error.message}`)
      }
      return parsed.data as DetachedWindowResponse<C>
    }
  }

  const api: ChorusApi = {
    getAppInfo: invoke('app:getInfo'),
    chooseWorkbenchProject: () => invokeWorkbench('workbench:chooseProject')({}),
    openWorkbench: invokeWorkbench('workbench:open'),
    setWorkbenchBounds: invokeWorkbench('workbench:setBounds'),
    closeWorkbench: invokeWorkbench('workbench:close'),
    setWorkbenchVisible: invokeWorkbench('workbench:setVisible'),
    readWorkbenchActivityBar: invokeWorkbench('workbench:activityBar'),
    onWorkbenchActivityBar: (listener) => {
      const wrapped = (payload: unknown): void => {
        const parsed = WorkbenchActivityBarPush.safeParse(payload)
        if (parsed.success) listener(parsed.data)
      }
      return transport.on(WORKBENCH_ACTIVITY_BAR_PUSH_CHANNEL, wrapped)
    },
    onWorkbenchRowReveal: (listener) => {
      const wrapped = (payload: unknown): void => {
        const parsed = WorkbenchRowRevealPush.safeParse(payload)
        if (parsed.success) listener(parsed.data)
      }
      return transport.on(WORKBENCH_ROW_REVEAL_PUSH_CHANNEL, wrapped)
    },
    onWorkbenchRowScroll: (listener) => {
      const wrapped = (payload: unknown): void => {
        const parsed = WorkbenchRowScrollPush.safeParse(payload)
        if (parsed.success) listener(parsed.data)
      }
      return transport.on(WORKBENCH_ROW_SCROLL_PUSH_CHANNEL, wrapped)
    },
    probeAgents: invoke('agents:probe'),
    startConversation: invoke('conversation:start'),
    beginConversation: invoke('conversation:begin'),
    awaitStart: invoke('conversation:awaitStart'),
    sendMessage: invoke('conversation:send'),
    interrupt: invoke('conversation:interrupt'),
    closeProject: invoke('project:close'),
    closeConversation: invoke('conversation:close'),
    restoreConversations: () => invoke('conversation:restore')({}),
    readActiveSessions: () => invoke('conversation:active')({}),
    markSeen: invoke('conversation:markSeen'),
    rememberDraft: invoke('conversation:draft'),
    setPlanMode: invoke('conversation:planMode'),
    setAnswerStyle: invoke('conversation:answerStyle'),
    completeFiles: invoke('files:complete'),
    listCommands: invoke('conversation:commands'),
    transcript: invoke('conversation:transcript'),
    taskState: invoke('task:state'),
    closeTask: invoke('task:close'),
    bindAssignment: invoke('task:bindAssignment'),
    listConversations: () => invoke('conversation:list')({}),
    knownModels: () => invoke('agents:models')({}),
    mcpServers: () => invoke('agents:mcp')({}),
    accounts: () => invoke('agents:account')({}),
    plugins: () => invoke('agents:plugins')({}),
    installSkill: invoke('agents:installSkill'),
    checkServiceKey: invoke('agents:checkServiceKey'),
    stopTask: invoke('tasks:stop'),
    reopenConversation: invoke('conversation:reopen'),
    previewFile: invoke('files:preview'),
    stashFile: invoke('files:stash'),
    stashNoteImage: invoke('files:stashNoteImage'),
    // Renderers cannot read a File's path any more; only the bridge can.
    pathForFile: (file: File) => transport.pathForFile(file),
    writeConversationLayout: invoke('conversation:layout'),
    refreshLimits: invoke('limits:refresh'),
    attachTerminal: invoke('terminal:attach'),
    detachTerminal: invoke('terminal:detach'),
    disposeTerminal: invoke('terminal:dispose'),
    killTerminal: invoke('terminal:kill'),
    writeTerminal: invoke('terminal:write'),
    resizeTerminal: invoke('terminal:resize'),
    ackTerminal: invoke('terminal:ack'),
    clearTerminal: invoke('terminal:clear'),
    describeTerminal: invoke('terminal:describe'),
    attachTraffic: invokeTraffic('traffic:attach'),
    detachTraffic: invokeTraffic('traffic:detach'),
    ackTraffic: invokeTraffic('traffic:ack'),
    snapshotTraffic: invokeTraffic('traffic:snapshot'),
    startTraffic: invokeTraffic('traffic:start'),
    stopTraffic: invokeTraffic('traffic:stop'),
    clearTraffic: invokeTraffic('traffic:clear'),
    configureTraffic: invokeTraffic('traffic:configure'),
    selectTrafficSource: invokeTraffic('traffic:selectSource'),
    readTrafficDetail: invokeTraffic('traffic:detail'),
    readTrafficBody: invokeTraffic('traffic:readBody'),
    readTrafficLegacy: invokeTraffic('traffic:legacy'),
    decideTrafficLegacy: invokeTraffic('traffic:legacyDecide'),
    readTrafficLive: invokeTraffic('traffic:live'),
    streamBrowser: invokeBrowser('browser:stream'),
    browserInput: invokeBrowser('browser:input'),
    ackBrowserFrame: invokeBrowser('browser:frameAck'),
    chooseBrowserSelect: invokeBrowser('browser:selectChoose'),
    answerBrowserDialog: invokeBrowser('browser:dialogAnswer'),
    browserSelection: invokeBrowser('browser:selection'),
    onBrowserFrame: (listener) => {
      const wrapped = (payload: unknown): void => {
        const parsed = BrowserFrame.safeParse(payload)
        if (parsed.success) listener(parsed.data)
      }
      return transport.on(BROWSER_FRAME_CHANNEL, wrapped)
    },
    announceWebReady: () => invokeBrowser('browser:webReady')({}),
    attachBrowser: invokeBrowser('browser:attach'),
    detachBrowser: invokeBrowser('browser:detach'),
    restoreBrowser: invokeBrowser('browser:restore'),
    navigateBrowser: invokeBrowser('browser:navigate'),
    actOnBrowser: invokeBrowser('browser:action'),
    findInBrowser: invokeBrowser('browser:find'),
    closeBrowser: invokeBrowser('browser:close'),
    reopenBrowser: () => invokeBrowser('browser:reopen')({}),
    readBrowserDownloads: () => invokeBrowser('browser:downloads')({}),
    actOnBrowserDownload: invokeBrowser('browser:download'),
    setBrowserGeometry: invokeBrowser('browser:geometry'),
    setBrowserDevtoolsGeometry: invokeBrowser('browser:devtoolsGeometry'),
    addBrowserFavorite: invokeBrowser('browser:favoriteAdd'),
    removeBrowserFavorite: invokeBrowser('browser:favoriteRemove'),
    openBrowserFavorite: invokeBrowser('browser:favoriteOpen'),
    readBrowserPasswords: invokeBrowser('browser:passwords'),
    decideBrowserPassword: invokeBrowser('browser:passwordDecide'),
    fillBrowserPassword: invokeBrowser('browser:passwordFill'),
    removeBrowserPassword: invokeBrowser('browser:passwordRemove'),
    allowBrowserPasswordSaving: invokeBrowser('browser:passwordAllow'),
    subscribeConsole: invokeConsole('console:subscribe'),
    unsubscribeConsole: invokeConsole('console:unsubscribe'),
    ackConsole: invokeConsole('console:ack'),
    snapshotConsole: invokeConsole('console:snapshot'),
    evaluateConsole: invokeConsole('console:evaluate'),
    expandConsole: invokeConsole('console:expand'),
    clearConsole: invokeConsole('console:clear'),
    readRunState: invokeRun('run:state'),
    readGitState: invokeGit('git:state'),
    readGitRequests: invokeGit('git:requests'),
    readGitReview: invokeGit('git:review'),
    readGitReviewFile: invokeGit('git:reviewFile'),
    commentOnGit: invokeGit('git:comment'),
    replyToGitThread: invokeGit('git:reply'),
    resolveGitThread: invokeGit('git:resolve'),
    approveGitReview: invokeGit('git:approve'),
    readActiveGitReview: invokeGit('git:activeReview'),
    closeGitReview: invokeGit('git:closeReview'),
    openGitDiff: invokeGit('git:openDiff'),
    openGitAllDiffs: invokeGit('git:openAllDiffs'),
    fetchGit: invokeGit('git:fetch'),
    syncGit: invokeGit('git:sync'),
    checkoutGit: invokeGit('git:checkout'),
    detectRunScripts: invokeRun('run:detect'),
    configureRun: invokeRun('run:configure'),
    startRun: invokeRun('run:start'),
    restartRun: invokeRun('run:restart'),
    stopRun: invokeRun('run:stop'),
    stopRunRecording: invokeRun('run:stopRecording'),
    setBadge: invoke('app:setBadge'),
    notify: invoke('app:notify'),
    revealConversation: invoke('conversation:reveal'),
    focusProjectWindow: invokeDetached('project:focusWindow'),
    prepareDetach: invokeDetached('project:prepareDetach'),
    commitDetach: invokeDetached('project:commitDetach'),
    prepareRedock: invokeDetached('project:prepareRedock'),
    commitRedock: invokeDetached('project:commitRedock'),
    closeEmptyProject: invokeDetached('project:closeEmpty'),
    sendProjectSlice: invokeDetached('project:sliceChanged'),
    sendProjectVisibility: invokeDetached('project:visibility'),
    readDetachedState: () => invokeDetached('window:detachedState')({}),
    readDetachedBootstrap: () => invokeDetached('window:detachedBootstrap')({}),
    sendFlushResult: invokeDetached('window:flushResult'),
    sendHitTestResult: invokeDetached('window:hitTestResult'),
    copyText: invoke('app:copyText'),
    renameConversation: invoke('conversation:rename'),
    adoptProject: invoke('project:adopt'),
    adoptRemoteProject: invoke('project:adoptRemote'),
    checkRemoteHost: invoke('project:checkRemoteHost'),
    listProjects: invoke('project:list'),
    renameProject: invoke('project:rename'),
    reorderProjects: invoke('project:reorder'),
    forgetProject: invoke('project:forget'),
    relocateProject: invoke('project:relocate'),
    setProjectProfile: invoke('project:setProfile'),
    setProjectNotes: invoke('project:setNotes'),
    getConversationNote: invoke('conversation:getNote'),
    setConversationNoteText: invoke('conversation:setNoteText'),
    setConversationNoteView: invoke('conversation:setNoteView'),
    prepareConversationNoteJournal: async (request) => {
      const parsed = ConversationNoteJournalRequest.parse({ ...request, op: 'read' })
      await transport.prepareConversationNoteJournal?.({ conversationId: parsed.conversationId })
    },
    readConversationNoteJournal: (request) => noteJournal({ ...request, op: 'read' }),
    compareConversationNoteJournal: (request) => noteJournal({ ...request, op: 'compare' }),
    getAppNote: invoke('app:getNote'),
    setAppNote: invoke('app:setNote'),
    listKeptNotes: invoke('app:listKeptNotes'),
    createKeptNote: invoke('app:createKeptNote'),
    setKeptNote: invoke('app:setKeptNote'),
    removeKeptNote: invoke('app:removeKeptNote'),
    reorderKeptNotes: invoke('app:reorderKeptNotes'),
    setAppNoteSize: invoke('app:setNoteSize'),
    setProjectNoteSize: invoke('project:setNoteSize'),
    addNoteImage: invoke('app:addNoteImage'),
    pickNoteImage: invoke('app:pickNoteImage'),
    fetchNoteImage: invoke('app:fetchNoteImage'),
    chooseDirectory: invoke('files:chooseDirectory'),
    readSettings: () => invoke('settings:read')({}),
    writeSettings: invoke('settings:write'),
    importGitlabToken: invoke('settings:importGitlabToken'),
    history: invoke('conversation:history'),
    decideApproval: invoke('approval:decide'),
    answerQuestion: invoke('userinput:answer'),
    profiles: invoke('policy:profiles'),
    setProfile: invoke('policy:set'),
    readDiagnostics: invoke('diagnostics:read'),
    exportDiagnostics: invoke('diagnostics:export'),
    ideSnapshot: invoke('ide:snapshot'),
    ideOpenFile: invoke('ide:openFile'),
    openAside: invoke('aside:open'),
    askAside: invoke('aside:ask'),
    restateAside: invoke('aside:restate'),
    promoteAside: invoke('aside:promote'),
    forwardAside: invoke('aside:forward'),
    closeAside: invoke('aside:close'),
    listAsides: invoke('aside:list'),

    onEvents: (listener) => {
      // The payload is validated before it reaches renderer code: main is
      // trusted, but a shape mismatch should fail here, not three components deep.
      const wrapped = (payload: unknown): void => {
        const parsed = EventsPush.safeParse(payload)
        if (parsed.success) listener(parsed.data)
      }
      return transport.on(EVENTS_PUSH_CHANNEL, wrapped)
    },
    onIdeContext: (listener) => {
      const wrapped = (payload: unknown): void => {
        // Validated here as well as in main: a shape mismatch should fail at the
        // boundary rather than as a blank pill with no explanation.
        const parsed = IdeContextPush.safeParse(payload)
        if (parsed.success) listener(parsed.data)
      }
      return transport.on(IDE_PUSH_CHANNEL, wrapped)
    },
    onLimits: (listener) => {
      const wrapped = (payload: unknown): void => {
        const parsed = LimitsPush.safeParse(payload)
        if (parsed.success) listener(parsed.data)
      }
      return transport.on(LIMITS_PUSH_CHANNEL, wrapped)
    },
    onContextUsage: (listener) => {
      const wrapped = (payload: unknown): void => {
        const parsed = ContextUsagePush.safeParse(payload)
        if (parsed.success) listener(parsed.data)
      }
      return transport.on(CONTEXT_PUSH_CHANNEL, wrapped)
    },
    onTasks: (listener) => {
      const wrapped = (payload: unknown): void => {
        const parsed = TasksPush.safeParse(payload)
        if (parsed.success) listener(parsed.data)
      }
      return transport.on(TASKS_PUSH_CHANNEL, wrapped)
    },
    onConversationNoteJournal: (listener) =>
      transport.on(CONVERSATION_NOTE_JOURNAL_PUSH_CHANNEL, (raw) => {
        const parsed = ConversationNoteJournalPush.safeParse(raw)
        if (parsed.success) listener(parsed.data)
      }),
    onConversationNote: (listener) => {
      const wrapped = (payload: unknown): void => {
        const parsed = ConversationNotePush.safeParse(payload)
        if (parsed.success) listener(parsed.data)
      }
      return transport.on(CONVERSATION_NOTE_PUSH_CHANNEL, wrapped)
    },
    onActivity: (listener) => {
      const wrapped = (payload: unknown): void => {
        const parsed = ActivityPush.safeParse(payload)
        if (parsed.success) listener(parsed.data)
      }
      return transport.on(ACTIVITY_PUSH_CHANNEL, wrapped)
    },
    onAttention: (listener) => {
      const wrapped = (payload: unknown): void => {
        const parsed = AttentionPush.safeParse(payload)
        if (parsed.success) listener(parsed.data)
      }
      return transport.on(ATTENTION_PUSH_CHANNEL, wrapped)
    },
    onRevealConversation: (listener) => {
      const wrapped = (payload: unknown): void => {
        const parsed = RevealPush.safeParse(payload)
        if (parsed.success) listener(parsed.data)
      }
      return transport.on(REVEAL_PUSH_CHANNEL, wrapped)
    },
    onTerminalOutput: (listener) => {
      const wrapped = (payload: unknown): void => {
        const parsed = TerminalPush.safeParse(payload)
        if (parsed.success) listener(parsed.data)
      }
      return transport.on(TERMINAL_PUSH_CHANNEL, wrapped)
    },
    onTraffic: (listener) => {
      const wrapped = (payload: unknown): void => {
        const parsed = TrafficPush.safeParse(payload)
        if (parsed.success) listener(parsed.data)
      }
      return transport.on(TRAFFIC_PUSH_CHANNEL, wrapped)
    },
    onRun: (listener) => {
      const wrapped = (payload: unknown): void => {
        const parsed = RunPush.safeParse(payload)
        if (parsed.success) listener(parsed.data)
      }
      return transport.on(RUN_PUSH_CHANNEL, wrapped)
    },
    onGitReviewChanged: (listener) => {
      const wrapped = (payload: unknown): void => {
        const parsed = GitReviewEnvelope.safeParse(payload)
        if (parsed.success) listener(parsed.data)
      }
      return transport.on(GIT_REVIEW_PUSH_CHANNEL, wrapped)
    },
    onTrafficLive: (listener) => {
      const wrapped = (payload: unknown): void => {
        const parsed = TrafficLive.safeParse(payload)
        if (parsed.success) listener(parsed.data)
      }
      return transport.on(TRAFFIC_LIVE_PUSH_CHANNEL, wrapped)
    },
    onBrowser: (listener) => {
      const wrapped = (payload: unknown): void => {
        const parsed = BrowserPush.safeParse(payload)
        if (parsed.success) listener(parsed.data)
      }
      return transport.on(BROWSER_PUSH_CHANNEL, wrapped)
    },
    onConsole: (listener) => {
      const wrapped = (payload: unknown): void => {
        const parsed = ConsolePush.safeParse(payload)
        if (parsed.success) listener(parsed.data)
      }
      return transport.on(CONSOLE_PUSH_CHANNEL, wrapped)
    },
    onDiagnostic: (listener) => {
      const wrapped = (payload: unknown): void => {
        const parsed = DiagnosticPush.safeParse(payload)
        if (parsed.success) listener(parsed.data)
      }
      return transport.on(DIAGNOSTIC_PUSH_CHANNEL, wrapped)
    },
    onSettings: (listener) => {
      const wrapped = (payload: unknown): void => {
        const parsed = IPC_CONTRACT['settings:read'].response.safeParse(payload)
        if (parsed.success) listener(parsed.data)
      }
      return transport.on(SETTINGS_PUSH_CHANNEL, wrapped)
    },
    onScale: (listener) => {
      const wrapped = (payload: unknown): void => {
        // Validated like every other push: main is trusted, but a shape mismatch
        // should fail here rather than as a NaN in the badge.
        if (typeof payload === 'number' && Number.isFinite(payload)) listener(payload)
      }
      return transport.on(SCALE_PUSH_CHANNEL, wrapped)
    },
    onProjectClosed: (listener) => {
      const wrapped = (payload: unknown): void => {
        const parsed = ProjectClosedPush.safeParse(payload)
        if (parsed.success) listener(parsed.data)
      }
      return transport.on(PROJECT_CLOSED_PUSH_CHANNEL, wrapped)
    },
    onProjectCloseRequested: (listener) => {
      const wrapped = (payload: unknown): void => {
        const parsed = ProjectClosedPush.safeParse(payload)
        if (parsed.success) listener(parsed.data)
      }
      return transport.on(PROJECT_CLOSE_REQUEST_PUSH_CHANNEL, wrapped)
    },
    onProjectReturned: (listener) => {
      const wrapped = (payload: unknown): void => {
        const parsed = ProjectReturnedPush.safeParse(payload)
        if (parsed.success) listener(parsed.data)
      }
      return transport.on(PROJECT_RETURNED_PUSH_CHANNEL, wrapped)
    },
    onProjectSlice: (listener) => {
      const wrapped = (payload: unknown): void => {
        const parsed = ProjectSlicePush.safeParse(payload)
        if (parsed.success) listener(parsed.data)
      }
      return transport.on(PROJECT_SLICE_PUSH_CHANNEL, wrapped)
    },
    onProjectVisibility: (listener) => {
      const wrapped = (payload: unknown): void => {
        const parsed = ProjectVisibilityPush.safeParse(payload)
        if (parsed.success) listener(parsed.data)
      }
      return transport.on(PROJECT_VISIBILITY_PUSH_CHANNEL, wrapped)
    },
    onConversationsChanged: (listener) => {
      const wrapped = (): void => {
        listener()
      }
      return transport.on(CONVERSATIONS_PUSH_CHANNEL, wrapped)
    },
    onFlushRequest: (listener) => {
      const wrapped = (payload: unknown): void => {
        const parsed = FlushRequestPush.safeParse(payload)
        if (parsed.success) listener(parsed.data)
      }
      return transport.on(FLUSH_REQUEST_PUSH_CHANNEL, wrapped)
    },
    onHitTestRequest: (listener) => {
      const wrapped = (payload: unknown): void => {
        const parsed = HitTestRequestPush.safeParse(payload)
        if (parsed.success) listener(parsed.data)
      }
      return transport.on(HIT_TEST_REQUEST_PUSH_CHANNEL, wrapped)
    },
  }

  return api
}
