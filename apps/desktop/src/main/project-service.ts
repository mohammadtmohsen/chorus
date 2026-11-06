import { statSync } from 'node:fs'
import { basename, posix } from 'node:path'
import {
  DuplicateProjectRootError,
  LOCAL_HOST,
  UnknownProjectError,
  purgeProject,
  type Database,
  type Project,
  type ProjectStore,
  type RunCommands,
  type TrafficAccess,
  type TrafficLegacyImport,
  UnresolvedLegacyTrafficError,
} from '@chorus/event-store'
import { remoteProjectRoot } from '@chorus/workspace'
import { DEFAULT_TRAFFIC_PORT } from '../shared/ipc.js'
import { readSavedTrafficConnection, type SavedTrafficConnection } from './settings.js'
import { approveProjectRoot, type WorkbenchPlace } from './project-root.js'

/**
 * The durable set of projects the person has adopted — Phase 2's domain service,
 * and the answer to Phase 1's remaining E2 item.
 *
 * Phase 1 bounded the openable set with the native chooser: one dialog per root,
 * one capability per answer, dead when the document that asked is. That is a
 * sound authorisation and a poor product. It means every launch begins by
 * pointing at the same folders again, and it means a project **id** cannot be
 * turned into a root at all — which is why the second arm of `WorkbenchTarget`
 * has been failing closed since it was written.
 *
 * This is the table that resolves it. A grant remains the answer for a directory
 * being adopted for the first time; an id is the answer for one already adopted,
 * and `resolveRoot` is the only thing entitled to make that conversion.
 *
 * **The filesystem is asked here and nowhere below.** `ProjectStore` is a
 * database and stays one; every canonical path in it was resolved by this layer,
 * because main is the only layer allowed to look.
 */

/** Adopting a folder that is already a project is a redirect, not a failure. */
export interface AdoptResult {
  readonly project: Project
  /**
   * False when the folder was already adopted. The caller almost always wants to
   * open the existing project rather than report an error, but it should be able
   * to say "you already had this" rather than silently implying it made one.
   */
  readonly created: boolean
}

/**
 * A project whose directory is no longer there — an unmounted volume, a folder
 * renamed outside Chorus, a checkout deleted.
 *
 * Distinct from `UnknownProjectError`, and the distinction is the whole point:
 * one means the id is not ours, the other means the id is ours and the world
 * moved. The first is a bug or a forged request; the second is Tuesday, and the
 * product's answer to it is Relocate rather than an error dialog.
 */
export class ProjectRootMissingError extends Error {
  constructor(
    readonly projectId: string,
    readonly canonicalRoot: string
  ) {
    super(`The folder for this project is no longer there: ${canonicalRoot}`)
    this.name = 'ProjectRootMissingError'
  }
}

export class LegacyTrafficOriginMissingError extends Error {
  constructor() {
    super('The shared connection has no origin to forward to yet')
    this.name = 'LegacyTrafficOriginMissingError'
  }
}

export class LegacyTrafficPortMissingError extends Error {
  constructor() {
    super('The shared connection has no port of its own; choose one before keeping it')
    this.name = 'LegacyTrafficPortMissingError'
  }
}

const LEGACY_TRAFFIC_ACCESS: TrafficAccess = 'lan'

export class AgentFolderMissingError extends Error {
  constructor(
    readonly projectId: string,
    readonly agentCwd: string | null
  ) {
    super(
      agentCwd === null
        ? `This remote project has no local folder for its agents: ${projectId}`
        : `The local folder for this project's agents is no longer there: ${agentCwd}`
    )
    this.name = 'AgentFolderMissingError'
  }
}

/**
 * Is that path a directory, right now.
 *
 * One implementation, used by both the refusal (`resolveRoot`) and the question
 * (`rootPresent`), because two of these drift and the symptom would be a rail
 * that shows a project as fine and a launch that says it is gone.
 *
 * Gone, unreadable, and on a volume that is not mounted are all the same answer
 * to every caller, so they are not distinguished. `statSync` rather than
 * `existsSync`: a *file* at the project's path is not a project root, and
 * `existsSync` would call it present and fail later inside the extension host.
 */
function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export class ProjectService {
  constructor(
    private readonly projects: ProjectStore,
    /*
     * The same handle `ProjectStore` holds, and it is here for exactly one
     * method. `forget` has to delete a project's history and its registry row
     * together or not at all, and those live on opposite sides of a separation
     * this class did not invent and should not collapse — so it takes the handle
     * and spends one transaction, rather than the registry growing a method
     * about the log.
     */
    private readonly db: Database,
    private readonly clock: () => number = Date.now
  ) {}

  /**
   * Takes a directory somebody chose and makes it a project, or hands back the
   * project that already holds it.
   *
   * `approveProjectRoot` is reused rather than reimplemented: absolute, canonical,
   * exists, and a directory rather than a file. Those four are already the rules
   * the workbench applies to a root, and a second implementation here would be a
   * second set of rules the moment either was edited.
   *
   * The lookup is by **canonical** root, so a folder reached through a symlink is
   * recognised as the project it already is. That is the case a lexical check
   * misses, and it is not hypothetical — `/var/folders/…` and
   * `/private/var/folders/…` are one directory on this machine.
   */
  adopt(proposed: string, name?: string): AdoptResult {
    const canonicalRoot = approveProjectRoot(proposed)

    const existing = this.projects.findByRoot({ host: LOCAL_HOST, canonicalRoot })
    if (existing !== null) {
      return { project: this.projects.touch(existing.id, this.clock()), created: false }
    }

    /*
     * The name defaults to the folder's own, taken from the canonical root rather
     * than from what was typed: a trailing slash would otherwise make `basename`
     * return the empty string, and the store would refuse a blank name with an
     * error about validation rather than about the path.
     */
    const trimmed = name?.trim() ?? ''
    const chosen = trimmed === '' ? basename(canonicalRoot) || canonicalRoot : trimmed

    try {
      return {
        project: this.projects.create({
          name: chosen,
          host: LOCAL_HOST,
          root: proposed,
          canonicalRoot,
          workspaceFile: null,
          now: this.clock(),
        }),
        created: true,
      }
    } catch (error) {
      /*
       * Lost a race with another adopt of the same folder. The store checks and
       * inserts in one transaction, so this is the losing side of two callers
       * arriving together — and the right answer is the one the winner created,
       * which is exactly what the error carries.
       */
      if (error instanceof DuplicateProjectRootError) {
        const winner = this.projects.get(error.existingProjectId)
        if (winner !== null) return { project: winner, created: false }
      }
      throw error
    }
  }

  adoptRemote(input: {
    readonly host: string
    readonly root: string
    readonly agentCwd: string
    readonly name?: string
  }): AdoptResult {
    const canonicalRoot = remoteProjectRoot(input.root)
    const agentCwd = approveProjectRoot(input.agentCwd)

    const existing = this.projects.findByRoot({ host: input.host, canonicalRoot })
    if (existing !== null) {
      return { project: this.projects.touch(existing.id, this.clock()), created: false }
    }

    const folder = posix.basename(canonicalRoot)
    const trimmed = input.name?.trim() ?? ''
    const fallback = folder === '' ? canonicalRoot : folder
    const chosen = trimmed === '' ? fallback : trimmed

    try {
      return {
        project: this.projects.create({
          name: chosen,
          host: input.host,
          root: input.root,
          canonicalRoot,
          workspaceFile: null,
          agentCwd,
          now: this.clock(),
        }),
        created: true,
      }
    } catch (error) {
      if (error instanceof DuplicateProjectRootError) {
        const winner = this.projects.get(error.existingProjectId)
        if (winner !== null) return { project: winner, created: false }
      }
      throw error
    }
  }

  /**
   * The project at a canonical root, or null.
   *
   * Takes a root that is **already canonical** — a workbench surface's
   * `projectRoot` came from `approveProjectRoot` when it was opened — so this
   * does not touch the filesystem and cannot fail on a directory that has since
   * moved. `adopt` is the wrong call for this: it would create a project for a
   * root nobody chose, which is exactly the silent adoption the registry exists
   * to prevent.
   */
  findByPlace(place: WorkbenchPlace): Project | null {
    return this.projects.findByRoot({ host: place.host, canonicalRoot: place.root })
  }

  list(): readonly Project[] {
    return this.projects.list()
  }

  get(projectId: string): Project | null {
    return this.projects.get(projectId)
  }

  /**
   * An id to a root, and the only path by which that conversion happens.
   *
   * This is what `redeem`'s `projectId` arm calls, and what `resolveAgentCwd`
   * calls for a local project. Two refusals rather than one, because they mean
   * different things to whoever is asking: an id nobody adopted is refused
   * outright, and a local project whose folder has gone is refused as a folder
   * problem so the caller can offer to relocate it.
   *
   * The existence check is deliberate and is not redundant with `adopt`. A root
   * verified at adopt time says nothing about the same root a week later, and
   * handing a vanished directory to the remote extension host fails much further
   * in, with an error about a server rather than about a folder.
   */
  resolveRoot(projectId: string): string {
    const project = this.projects.get(projectId)
    if (project === null) throw new UnknownProjectError(projectId)
    if (project.host !== LOCAL_HOST) return project.canonicalRoot
    if (!directoryExists(project.canonicalRoot)) {
      throw new ProjectRootMissingError(projectId, project.canonicalRoot)
    }
    return project.canonicalRoot
  }

  workbenchTarget(projectId: string): WorkbenchPlace {
    const root = this.resolveRoot(projectId)
    return { host: this.projects.get(projectId)?.host ?? LOCAL_HOST, root }
  }

  resolveAgentCwd(projectId: string): string {
    const project = this.projects.get(projectId)
    if (project === null) throw new UnknownProjectError(projectId)
    if (project.host === LOCAL_HOST) return this.resolveRoot(projectId)
    if (project.agentCwd === null || !directoryExists(project.agentCwd)) {
      throw new AgentFolderMissingError(projectId, project.agentCwd)
    }
    return project.agentCwd
  }

  /**
   * The same question as `resolveRoot`'s check, asked instead of enforced.
   *
   * `resolveRoot` throws because every one of its callers is about to *use* the
   * directory, and handing back a path that is not there would fail later and
   * further away. Listing is the opposite case: the rail has to be able to draw
   * a project whose folder has gone — that is the only way a person finds out,
   * and it is the screen the fix is offered from — and an exception is not a UI
   * state.
   *
   * Both go through `directoryExists` so there is one answer to "is it there",
   * rather than a listing that disagrees with a launch.
   */
  rootPresent(projectId: string): boolean {
    const project = this.projects.get(projectId)
    if (project === null) return false
    return project.host !== LOCAL_HOST || directoryExists(project.canonicalRoot)
  }

  rename(projectId: string, name: string): Project {
    return this.projects.rename(projectId, name)
  }

  /**
   * Points a project at a different directory — the one explicit operation that
   * moves a root, because no conversation may move its own.
   *
   * **Stopping and restarting whatever is running against the old root is the
   * caller's job**, and it is not a detail: a workbench surface and an agent
   * session both hold the previous path, and neither notices a database write.
   * This function is the record of the decision, not the execution of it.
   */
  relocate(projectId: string, proposed: string): Project {
    return this.projects.relocate(projectId, {
      root: proposed,
      canonicalRoot: approveProjectRoot(proposed),
      workspaceFile: null,
    })
  }

  /**
   * Records what agents in this project may do.
   *
   * **The record, not the execution.** Conversations already running keep the
   * profile they were started under until something tells them otherwise, and
   * that something is `ChorusRuntime.setProjectProfile` — this service cannot
   * see a live conversation and must not pretend to have changed one. Same
   * division as `relocate`.
   */
  setProfile(projectId: string, profileId: string | null): Project {
    return this.projects.setProfile(projectId, profileId)
  }

  /*
   * `setAgents` stood here, recording the project's cast on the same terms as
   * `setProfile`. A cast is not a project answer any more — every conversation
   * holds every agent — so nothing calls it. The registry below still has its
   * own `setAgents` and the column it writes; this was the way in from main, and
   * it is the part that had to go.
   */

  /**
   * Records the project's scratchpad.
   *
   * Nothing running has to be told, which is what makes this the simplest of the
   * three: a note changes no agent's permissions, no root and no cast. It is a
   * write and a redraw.
   */
  setNotes(projectId: string, notes: string | null): Project {
    return this.projects.setNotes(projectId, notes)
  }

  /** How big that scratchpad was left, on the same terms as its text. */
  setNoteSize(projectId: string, width: number | null, height: number | null): Project {
    return this.projects.setNoteSize(projectId, width, height)
  }

  setTrafficConfig(
    projectId: string,
    input: {
      readonly trafficOrigin?: string | null
      readonly trafficPort?: number | null
      readonly trafficAccess?: TrafficAccess
      readonly trafficEnvVar?: string | null
    }
  ): Project {
    return this.projects.setTrafficConfig(projectId, input)
  }

  setRunCommands(projectId: string, commands: RunCommands | null): Project {
    return this.projects.setRunCommands(projectId, commands)
  }

  nextTrafficPort(projectId: string): number {
    return this.projects.nextTrafficPort(projectId, DEFAULT_TRAFFIC_PORT)
  }

  trafficImport(): TrafficLegacyImport {
    return this.projects.legacyTrafficImport()
  }

  syncLegacyTraffic(userDataPath: string): SavedTrafficConnection {
    const connection = readSavedTrafficConnection(userDataPath)
    const state = this.projects.legacyTrafficImport()
    if (state.completed) return connection
    if (connection.kind === 'absent') {
      this.projects.completeLegacyTrafficImport()
      return connection
    }
    if (connection.kind === 'unreadable') {
      const kept = connection.port === null ? (state.candidate ?? null) : null
      this.projects.recordLegacyTrafficCandidate(
        kept ?? { origin: null, port: connection.port, access: LEGACY_TRAFFIC_ACCESS },
        connection.reason
      )
      return connection
    }
    this.projects.recordLegacyTrafficCandidate(
      { origin: connection.origin, port: connection.port, access: LEGACY_TRAFFIC_ACCESS },
      null
    )
    return connection
  }

  adoptLegacyTraffic(projectId: string): Project {
    const state = this.projects.legacyTrafficImport()
    const candidate = state.candidate
    if (candidate !== null && state.error !== null) {
      throw new UnresolvedLegacyTrafficError()
    }
    if (candidate !== null && candidate.origin === null) {
      throw new LegacyTrafficOriginMissingError()
    }
    if (candidate !== null && (candidate.port === null || candidate.port <= 0)) {
      throw new LegacyTrafficPortMissingError()
    }
    return this.projects.adoptLegacyTraffic(projectId)
  }

  dismissLegacyTraffic(): void {
    this.projects.completeLegacyTrafficImport()
  }

  /**
   * Records an open.
   *
   * No longer what the rail orders on — that is `sortOrder` now, so that an
   * arrangement survives being used. This still records the fact.
   */
  opened(projectId: string): Project {
    return this.projects.touch(projectId, this.clock())
  }

  /**
   * Moves a project before another — or to the end — and answers with the list.
   *
   * The list rather than the moved row, because the caller is a rail that draws
   * every tile: handing back one project would make the renderer patch its own
   * copy and hold an opinion about ordering that only the store is entitled to.
   * An insertion moves every tile between the two, so that matters more here
   * than it did when this was a swap of two.
   */
  moveOrder(projectId: string, beforeId: string | null): readonly Project[] {
    this.projects.moveOrder(projectId, beforeId)
    return this.projects.list()
  }

  /**
   * Deletes a project, its conversations, and every event they ever recorded.
   *
   * **This used to keep the history**, on the reasoning that forgetting a project
   * is not a claim the work never happened — and that was the right default while
   * the only way to reach it was a folder that had vanished from disk. Removing a
   * project you still have is a different act with a different intent: it is not
   * "this checkout is gone", it is "I am finished with this". Keeping transcripts
   * for a project the person deliberately deleted is the surprising behaviour,
   * not the safe one.
   *
   * **There is no undo, and no confirmation upstream either.** Re-adding the same
   * folder afterwards makes a new, empty project. Both halves of that were asked
   * for explicitly; neither is a default worth inferring, which is why this
   * comment states them rather than the code implying them.
   *
   * One transaction over both stores. Nested inside `purgeProject`'s own — which
   * SQLite handles as a savepoint — so history and registry commit together or
   * neither does.
   */
  forget(projectId: string): boolean {
    const run = this.db.transaction((): boolean => {
      purgeProject(this.db, projectId)
      return this.projects.remove(projectId)
    })
    return run()
  }
}
